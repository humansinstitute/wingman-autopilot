import { Terminal } from "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm";
import { FitAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.9.0/+esm";

const TMUX_PREFIX = "\u0002";
const tmuxCommands = {
  detach: `${TMUX_PREFIX}d`,
  zoom: `${TMUX_PREFIX}z`,
  "split-vertical": `${TMUX_PREFIX}%`,
  "split-horizontal": `${TMUX_PREFIX}"`,
  "kill-pane": `${TMUX_PREFIX}x`,
  "list-sessions": `${TMUX_PREFIX}s`,
};

const quickKeyMap = {
  escape: "\u001b",
  tab: "\t",
  "arrow-up": "\u001b[A",
  "arrow-down": "\u001b[B",
  "arrow-left": "\u001b[D",
  "arrow-right": "\u001b[C",
  enter: "\r",
  "ctrl-c": "\u0003",
};

class DeepDiveTerminal {
  constructor(options = {}) {
    this.terminalContainer = document.getElementById("terminal-container");
    this.connectionStatus = document.getElementById("connection-status");
    this.overlay = document.getElementById("pin-overlay");
    this.pinForm = document.getElementById("pin-form");
    this.pinInput = document.getElementById("pin-input");
    this.pinError = document.getElementById("pin-error");
    this.tmuxToggle = document.getElementById("tmux-toggle");
    this.tmuxDropdown = this.tmuxToggle.closest(".terminal-dropdown");
    this.dropdownButtons = Array.from(this.tmuxDropdown.querySelectorAll(".terminal-dropdown__menu button"));
    this.quickKeyButtons = Array.from(document.querySelectorAll(".terminal-quickkeys button"));
    this.toastTemplate = document.getElementById("toast-template");
    this.toastContainer = document.createElement("div");
    this.toastContainer.className = "toast-container";
    document.body.append(this.toastContainer);

    this.socketUrl =
      typeof options.socketUrl === "string" && options.socketUrl.trim().length > 0
        ? options.socketUrl.trim()
        : null;
    this.socketAvailable = Boolean(this.socketUrl);

    this.socket = null;
    this.isAuthenticated = false;
    this.terminalReady = false;
    this.reconnectTimer = null;
    this.resizeTimer = null;

    this.fitAddon = new FitAddon();
    this.terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
      fontSize: 14,
      allowTransparency: true,
      theme: {
        background: "#050505",
        foreground: "#f5f5f5",
        cursor: "#38bdf8",
        selection: "rgba(94, 234, 212, 0.35)",
      },
    });

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.terminalContainer);
    this.terminalReady = true;
    this.fitAddon.fit();

    this.terminal.onData((data) => this.handleTerminalInput(data));

    const resizeObserver = new ResizeObserver(() => this.queueResize());
    resizeObserver.observe(this.terminalContainer);
    window.addEventListener("resize", () => this.queueResize());

    this.bindEvents();
    if (this.socketAvailable) {
      this.connect();
    } else {
      this.setStatus("disconnected");
      this.showOverlay();
      this.showToast("Deep Dive terminal is unavailable.", "error");
    }
  }

  bindEvents() {
    this.pinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.authenticate();
    });

    this.pinInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.pinError.textContent = "";
      }
    });

    this.tmuxToggle.addEventListener("click", () => this.toggleDropdown());
    document.addEventListener("click", (event) => {
      if (!this.tmuxDropdown.contains(event.target)) {
        this.setDropdownOpen(false);
      }
    });

    this.dropdownButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const command = button.dataset.command;
        this.handleDropdownCommand(command);
        this.setDropdownOpen(false);
      });
    });

    this.quickKeyButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.key;
        this.handleQuickKey(key);
      });
    });

    this.terminal.element?.addEventListener("paste", (event) => {
      if (!(event instanceof ClipboardEvent)) return;
      const text = event.clipboardData?.getData("text");
      if (text) {
        event.preventDefault();
        this.send("terminal-input", { data: text.replace(/\r?\n/g, "\r") });
      }
    });
  }

  setStatus(mode) {
    const statusLabel =
      mode === "connected" ? "Connected" : mode === "disconnected" ? "Disconnected" : "Connecting…";
    this.connectionStatus.textContent = statusLabel;
    this.connectionStatus.dataset.state = mode;
  }

  toggleDropdown() {
    const isOpen = this.tmuxDropdown.dataset.state === "open";
    this.setDropdownOpen(!isOpen);
  }

  setDropdownOpen(state) {
    this.tmuxDropdown.dataset.state = state ? "open" : "closed";
    this.tmuxToggle.setAttribute("aria-expanded", state ? "true" : "false");
    this.tmuxDropdown
      .querySelector(".terminal-dropdown__menu")
      .setAttribute("aria-hidden", state ? "false" : "true");
  }

  showOverlay() {
    this.overlay.hidden = false;
    this.pinInput.focus();
  }

  hideOverlay() {
    this.overlay.hidden = true;
    this.pinError.textContent = "";
  }

  connect() {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    clearTimeout(this.reconnectTimer);

    const targetUrl = this.socketUrl || (() => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      return `${protocol}://${location.host}/deep-dive/socket`;
    })();

    if (!targetUrl) {
      this.setStatus("disconnected");
      this.showOverlay();
      return;
    }

    this.setStatus("connecting");
    let socket;
    try {
      socket = new WebSocket(targetUrl);
    } catch {
      this.setStatus("disconnected");
      this.showOverlay();
      this.showToast("Unable to reach Deep Dive terminal", "error");
      this.scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      this.socket = socket;
      this.setStatus("connected");
      if (this.isAuthenticated) {
        this.requestStart();
      }
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.isAuthenticated = false;
      this.setStatus("disconnected");
      this.showOverlay();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.showToast("Unable to reach Deep Dive terminal", "error");
    });

    this.socket = socket;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.socketUrl) {
      return;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), 2500);
  }

  handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const { event, data } = payload || {};
    switch (event) {
      case "auth-required":
        this.isAuthenticated = false;
        this.showOverlay();
        break;
      case "auth-success":
        this.isAuthenticated = true;
        this.hideOverlay();
        this.showToast("PIN accepted. Launching terminal…", "success");
        this.requestStart();
        break;
      case "auth-failed":
        this.isAuthenticated = false;
        this.pinError.textContent = typeof data === "string" ? data : "Authentication failed.";
        this.pinInput.focus();
        this.pinInput.select();
        break;
      case "terminal-output":
        if (typeof data === "string") {
          this.terminal.write(data);
        }
        break;
      case "terminal-error":
        if (typeof data === "string") {
          this.showToast(data, "error");
        }
        break;
      case "session-fresh":
        this.showToast("Wingman CLI bootstrapped.", "info");
        break;
      default:
        break;
    }
  }

  authenticate() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pinError.textContent = "Waiting for connection…";
      return;
    }
    const pin = this.pinInput.value.trim();
    if (!pin) {
      this.pinError.textContent = "PIN is required.";
      return;
    }
    this.pinError.textContent = "";
    this.send("authenticate", { pin });
  }

  requestStart() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.isAuthenticated || !this.terminalReady) {
      return;
    }
    this.queueResize(true);
    this.send("start-terminal", { cols: this.terminal.cols, rows: this.terminal.rows });
  }

  queueResize(immediate = false) {
    clearTimeout(this.resizeTimer);
    const handler = () => {
      if (!this.terminalReady) return;
      this.fitAddon.fit();
      if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
        this.send("terminal-resize", { cols: this.terminal.cols, rows: this.terminal.rows });
      }
    };
    if (immediate) {
      handler();
      return;
    }
    this.resizeTimer = setTimeout(handler, 120);
  }

  handleTerminalInput(data) {
    this.send("terminal-input", { data });
  }

  handleTmuxCommand(command) {
    if (!command || !tmuxCommands[command]) return;
    this.send("terminal-input", { data: tmuxCommands[command] });
  }

  handleDropdownCommand(command) {
    if (!command) return;
    if (command === "copy-visible") {
      this.copyTerminalText();
      return;
    }
    this.handleTmuxCommand(command);
  }

  handleQuickKey(key) {
    if (!key || !quickKeyMap[key]) return;
    this.send("terminal-input", { data: quickKeyMap[key] });
  }

  copyTerminalText() {
    if (!navigator.clipboard) {
      this.showToast("Clipboard API not available", "error");
      return;
    }
    const selection = this.terminal.getSelection();
    const text =
      selection && selection.length > 0
        ? selection
        : this.terminal.buffer.active
            .getLine(0)
            ?.translateToString()
            .split("\n")
            .join("\n");

    if (!text) {
      this.showToast("Nothing to copy yet.", "info");
      return;
    }

    navigator.clipboard
      .writeText(text)
      .then(() => this.showToast("Terminal text copied.", "success"))
      .catch(() => this.showToast("Unable to copy text.", "error"));
  }

  send(event, payload = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ event, ...payload }));
  }

  showToast(message, variant = "info") {
    if (!this.toastTemplate) return;
    const clone = this.toastTemplate.content.firstElementChild.cloneNode(true);
    clone.textContent = message;
    clone.dataset.variant = variant;
    this.toastContainer.append(clone);
    setTimeout(() => {
      clone.remove();
    }, 4000);
  }
}

const loadDeepDiveConfig = async () => {
  try {
    const response = await fetch("/deep-dive/config.json", { cache: "no-store" });
    if (!response.ok) {
      return { socketUrl: null };
    }
    const data = await response.json();
    if (data && typeof data.socketUrl === "string" && data.socketUrl.trim().length > 0) {
      return { socketUrl: data.socketUrl.trim() };
    }
    return { socketUrl: null };
  } catch (error) {
    console.warn("Failed to load Deep Dive config", error);
    return { socketUrl: null };
  }
};

window.addEventListener("DOMContentLoaded", async () => {
  const config = await loadDeepDiveConfig();
  new DeepDiveTerminal(config);
});
