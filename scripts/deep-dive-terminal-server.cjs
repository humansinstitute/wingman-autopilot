#!/usr/bin/env node
/**
 * Lightweight WebSocket server that powers the Wingman Deep Dive terminal.
 * This mirrors the behaviour of the legacy Wingman implementation while
 * remaining process-isolated from the Bun orchestrator.
 */
const http = require("http");
const os = require("os");
const { randomUUID } = require("crypto");
const pty = require("node-pty");
const WebSocket = require("ws");

const DEFAULT_PIN = "1234";
const DEFAULT_PIN_TIMEOUT_SECONDS = 45;
const DEFAULT_BOOTSTRAP_COMMAND = "node wingman-cli.js";

const terminalPin = (process.env.DEEP_DIVE_PIN ?? process.env.PIN ?? DEFAULT_PIN).trim();
const rawTimeout = process.env.DEEP_DIVE_PIN_TIMEOUT ?? process.env.PIN_TIMEOUT ?? "";
const parsedTimeout = Number.parseInt(rawTimeout, 10);
const terminalPinTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout * 1000
  : DEFAULT_PIN_TIMEOUT_SECONDS * 1000;
const terminalBootstrapCommand = (process.env.TERMINALCMD ?? DEFAULT_BOOTSTRAP_COMMAND).trim();

const sanitizePort = (value, fallback) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 65535) {
    return fallback;
  }
  return parsed;
};

const defaultPort = sanitizePort(process.env.PORT, 0) || sanitizePort(process.env.DEEP_DIVE_PORT, 0) || 0;
const listenPort = defaultPort > 0 ? defaultPort : 0;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ noServer: true });

const clients = new Map();

const sendEvent = (socket, event, data = null) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify({ event, data }));
  } catch (error) {
    console.error("[deep-dive] failed to send event", event, error);
  }
};

const destroyPty = (ptyProcess) => {
  if (!ptyProcess) return;
  try {
    ptyProcess.kill();
  } catch (error) {
    console.warn("[deep-dive] failed to kill PTY", error);
  }
};

const startTerminal = (client, dimensions) => {
  destroyPty(client.pty);

  const shell = os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
  const cols = Number.isFinite(dimensions?.cols) && dimensions.cols > 0 ? Math.floor(dimensions.cols) : 120;
  const rows = Number.isFinite(dimensions?.rows) && dimensions.rows > 0 ? Math.floor(dimensions.rows) : 32;

  try {
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env,
    });

    client.pty = ptyProcess;

    ptyProcess.onData((chunk) => {
      sendEvent(client.socket, "terminal-output", chunk);
    });

    ptyProcess.onExit(({ exitCode, signal } = {}) => {
      const message =
        exitCode === 0
          ? "Terminal closed."
          : `Terminal exited with code ${exitCode ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}`;
      sendEvent(client.socket, "terminal-error", message);
      destroyPty(ptyProcess);
      client.pty = null;
    });

    if (terminalBootstrapCommand.length > 0) {
      ptyProcess.write(`${terminalBootstrapCommand}\r`);
      sendEvent(client.socket, "session-fresh");
    }
  } catch (error) {
    console.error("[deep-dive] failed to spawn PTY", error);
    sendEvent(client.socket, "terminal-error", error instanceof Error ? error.message : String(error));
  }
};

const ensureAuthenticated = (client, requireFresh = false) => {
  if (!client.authenticated) {
    sendEvent(client.socket, "auth-required");
    return false;
  }

  if (!requireFresh || !client.authenticatedAt) {
    return true;
  }

  if (Date.now() - client.authenticatedAt < terminalPinTimeoutMs) {
    return true;
  }

  client.authenticated = false;
  client.authenticatedAt = null;
  sendEvent(client.socket, "auth-required");
  return false;
};

const handleMessage = (client, raw) => {
  let payload = null;
  try {
    payload = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    sendEvent(client.socket, "terminal-error", "Unrecognised message format");
    return;
  }

  if (!payload || typeof payload !== "object" || typeof payload.event !== "string") {
    sendEvent(client.socket, "terminal-error", "Unrecognised message format");
    return;
  }

  switch (payload.event) {
    case "authenticate": {
      const pinCandidate = typeof payload.pin === "string" ? payload.pin.trim() : "";
      if (pinCandidate !== terminalPin) {
        sendEvent(client.socket, "auth-failed", "Incorrect PIN");
        return;
      }
      client.authenticated = true;
      client.authenticatedAt = Date.now();
      sendEvent(client.socket, "auth-success");
      break;
    }
    case "start-terminal": {
      if (!ensureAuthenticated(client, true)) {
        return;
      }
      startTerminal(client, payload);
      break;
    }
    case "terminal-input": {
      if (!ensureAuthenticated(client)) {
        return;
      }
      const data = typeof payload.data === "string" ? payload.data : "";
      if (data.length === 0 || !client.pty) {
        return;
      }
      try {
        client.pty.write(data);
      } catch (error) {
        console.error("[deep-dive] failed to write to PTY", error);
        sendEvent(client.socket, "terminal-error", "Unable to write to terminal");
      }
      break;
    }
    case "terminal-resize": {
      if (!ensureAuthenticated(client)) {
        return;
      }
      const cols = Number.isFinite(payload.cols) && payload.cols > 0 ? Math.floor(payload.cols) : 120;
      const rows = Number.isFinite(payload.rows) && payload.rows > 0 ? Math.floor(payload.rows) : 32;
      if (!client.pty) {
        return;
      }
      try {
        client.pty.resize(cols, rows);
      } catch (error) {
        console.warn("[deep-dive] failed to resize PTY", error);
      }
      break;
    }
    default: {
      sendEvent(client.socket, "terminal-error", `Unknown event: ${payload.event}`);
    }
  }
};

wss.on("connection", (socket) => {
  const id = randomUUID();
  const client = {
    id,
    socket,
    pty: null,
    authenticated: false,
    authenticatedAt: null,
  };

  clients.set(id, client);
  sendEvent(socket, "auth-required");

  socket.on("message", (data) => handleMessage(client, data));

  socket.on("close", () => {
    destroyPty(client.pty);
    clients.delete(id);
  });

  socket.on("error", (error) => {
    console.error("[deep-dive] websocket error", error);
    destroyPty(client.pty);
    clients.delete(id);
  });
});

server.on("upgrade", (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== "/deep-dive/socket") {
      socket.destroy();
      return;
    }
  } catch {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

server.listen(listenPort, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : listenPort;
  console.log(`[deep-dive] terminal server listening on port ${boundPort}`);
});
