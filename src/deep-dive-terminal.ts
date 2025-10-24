import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { spawn as spawnPty, IPty } from "node-pty";

export const DEEP_DIVE_PAGE_PATH = "/deep-dive";
export const DEEP_DIVE_SOCKET_PATH = "/deep-dive/socket";

const DEFAULT_PIN = "1234";
const DEFAULT_PIN_TIMEOUT_SECONDS = 45;
const DEFAULT_BOOTSTRAP_COMMAND = "node wingman-cli.js";

const terminalPin = (Bun.env.DEEP_DIVE_PIN ?? Bun.env.PIN ?? DEFAULT_PIN).trim();
const rawTimeout = Bun.env.DEEP_DIVE_PIN_TIMEOUT ?? Bun.env.PIN_TIMEOUT ?? "";
const parsedTimeout = Number.parseInt(rawTimeout, 10);
const terminalPinTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout * 1000
  : DEFAULT_PIN_TIMEOUT_SECONDS * 1000;
const terminalBootstrapCommand = (Bun.env.TERMINALCMD ?? DEFAULT_BOOTSTRAP_COMMAND).trim();

const chooseShell = () => {
  if (Bun.env.SHELL && Bun.env.SHELL.trim().length > 0) {
    return Bun.env.SHELL.trim();
  }
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return "/bin/bash";
};

const terminalShell = chooseShell();

type TerminalRequest =
  | { event: "authenticate"; pin?: unknown }
  | { event: "start-terminal"; cols?: unknown; rows?: unknown }
  | { event: "terminal-input"; data?: unknown }
  | { event: "terminal-resize"; cols?: unknown; rows?: unknown }
  | { event: string; [key: string]: unknown };

export type DeepDiveSocketData = {
  id: string;
  authenticated: boolean;
  authenticatedAt: number | null;
  pty?: IPty;
};

const sendEvent = (ws: ServerWebSocket<DeepDiveSocketData>, event: string, payload?: unknown) => {
  try {
    ws.send(JSON.stringify({ event, data: payload ?? null }));
  } catch (error) {
    console.error("Failed to send deep dive event", { event, error });
  }
};

const ensureAuthenticated = (ws: ServerWebSocket<DeepDiveSocketData>, requireFresh = false): boolean => {
  const data = ws.data;
  if (!data.authenticated) {
    sendEvent(ws, "auth-required");
    return false;
  }

  if (!requireFresh || !data.authenticatedAt) {
    return true;
  }

  if (Date.now() - data.authenticatedAt < terminalPinTimeoutMs) {
    return true;
  }

  data.authenticated = false;
  data.authenticatedAt = null;
  sendEvent(ws, "auth-required");
  return false;
};

const destroyPty = (pty?: IPty) => {
  if (!pty) return;
  try {
    pty.kill();
  } catch (error) {
    console.error("Failed to kill PTY", error);
  }
};

const startTerminalSession = (
  ws: ServerWebSocket<DeepDiveSocketData>,
  cols: number,
  rows: number,
): { ok: true } | { ok: false; message: string } => {
  const data = ws.data;
  destroyPty(data.pty);

  const shell = terminalShell;
  const env = { ...process.env };

  try {
    const pty = spawnPty(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env,
    });

    data.pty = pty;

    pty.onData((chunk) => {
      sendEvent(ws, "terminal-output", chunk);
    });

    pty.onExit((exit) => {
      const message =
        exit.exitCode === 0 ? "Terminal closed." : `Terminal exited with code ${exit.exitCode} (signal: ${exit.signal})`;
      sendEvent(ws, "terminal-error", message);
      destroyPty(pty);
      data.pty = undefined;
    });

    if (terminalBootstrapCommand.length > 0) {
      pty.write(`${terminalBootstrapCommand}\r`);
      sendEvent(ws, "session-fresh");
    }

    return { ok: true };
  } catch (error) {
    console.error("Failed to spawn PTY", error);
    destroyPty(data.pty);
    data.pty = undefined;
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const parseDimensions = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
};

const parseMessage = (raw: string): TerminalRequest | null => {
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || typeof (payload as Record<string, unknown>).event !== "string") {
      return null;
    }
    return payload as TerminalRequest;
  } catch {
    return null;
  }
};

const handleAuthenticate = (ws: ServerWebSocket<DeepDiveSocketData>, pin: unknown) => {
  if (typeof pin !== "string") {
    sendEvent(ws, "auth-failed", "Invalid PIN");
    return;
  }

  if (pin.trim() !== terminalPin) {
    sendEvent(ws, "auth-failed", "Incorrect PIN");
    return;
  }

  ws.data.authenticated = true;
  ws.data.authenticatedAt = Date.now();
  sendEvent(ws, "auth-success");
};

const handleStartTerminal = (
  ws: ServerWebSocket<DeepDiveSocketData>,
  cols: unknown,
  rows: unknown,
) => {
  if (!ensureAuthenticated(ws, true)) {
    return;
  }

  const terminalCols = parseDimensions(cols, 120);
  const terminalRows = parseDimensions(rows, 32);

  const result = startTerminalSession(ws, terminalCols, terminalRows);
  if (!result.ok) {
    sendEvent(ws, "terminal-error", result.message);
  }
};

const handleTerminalInput = (ws: ServerWebSocket<DeepDiveSocketData>, data: unknown) => {
  if (!ensureAuthenticated(ws)) {
    return;
  }
  if (typeof data !== "string" || data.length === 0) {
    return;
  }
  try {
    ws.data.pty?.write(data);
  } catch (error) {
    console.error("Failed to write to PTY", error);
    sendEvent(ws, "terminal-error", "Unable to write to terminal");
  }
};

const handleTerminalResize = (ws: ServerWebSocket<DeepDiveSocketData>, cols: unknown, rows: unknown) => {
  if (!ensureAuthenticated(ws)) {
    return;
  }
  const terminalCols = parseDimensions(cols, 120);
  const terminalRows = parseDimensions(rows, 32);
  try {
    ws.data.pty?.resize(terminalCols, terminalRows);
  } catch (error) {
    console.error("Failed to resize PTY", error);
    sendEvent(ws, "terminal-error", "Unable to resize terminal");
  }
};

export const createDeepDiveSocketData = (): DeepDiveSocketData => {
  const data: DeepDiveSocketData = {
    id: randomUUID(),
    authenticated: false,
    authenticatedAt: null,
    pty: undefined,
  };
  return data;
};

export const deepDiveWebSocketHandlers = {
  open(ws: ServerWebSocket<DeepDiveSocketData>) {
    sendEvent(ws, "auth-required");
  },
  message(ws: ServerWebSocket<DeepDiveSocketData>, event: string | ArrayBuffer | Uint8Array) {
    const raw =
      typeof event === "string"
        ? event
        : event instanceof ArrayBuffer
          ? Buffer.from(event).toString("utf8")
          : Buffer.from(event).toString("utf8");

    const payload = parseMessage(raw);
    if (!payload) {
      sendEvent(ws, "terminal-error", "Unrecognised message format");
      return;
    }

    switch (payload.event) {
      case "authenticate":
        handleAuthenticate(ws, payload.pin);
        break;
      case "start-terminal":
        handleStartTerminal(ws, payload.cols, payload.rows);
        break;
      case "terminal-input":
        handleTerminalInput(ws, payload.data);
        break;
      case "terminal-resize":
        handleTerminalResize(ws, payload.cols, payload.rows);
        break;
      default:
        sendEvent(ws, "terminal-error", `Unknown event: ${payload.event}`);
        break;
    }
  },
  close(ws: ServerWebSocket<DeepDiveSocketData>) {
    destroyPty(ws.data.pty);
  },
  error(ws: ServerWebSocket<DeepDiveSocketData>, error: Error) {
    console.error("Deep dive websocket error", error);
    sendEvent(ws, "terminal-error", error.message);
  },
};

export const isDeepDiveSocketPath = (pathname: string) =>
  pathname === DEEP_DIVE_SOCKET_PATH || pathname.startsWith(`${DEEP_DIVE_SOCKET_PATH}/`);

export const isDeepDivePagePath = (pathname: string) =>
  pathname === DEEP_DIVE_PAGE_PATH || pathname.startsWith(`${DEEP_DIVE_PAGE_PATH}/`);

export type DeepDiveSocketContext = DeepDiveSocketData;

export const deepDiveUpgrade = (request: Request, server: Server) => {
  return server.upgrade(request, {
    data: createDeepDiveSocketData(),
  });
};
