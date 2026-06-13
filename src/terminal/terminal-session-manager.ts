import type { IPty } from "node-pty";
import type { TerminalConfig } from "./terminal-config";

type NodePtyModule = typeof import("node-pty");

export interface TerminalSocket {
  sendText(data: string): void;
}

interface TerminalSession {
  pty: IPty;
}

export interface TerminalStartOptions {
  cols?: number;
  rows?: number;
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly config: TerminalConfig;
  private ptyModulePromise: Promise<NodePtyModule> | null = null;
  private availability: { available: boolean; error: string | null } | null = null;

  constructor(config: TerminalConfig) {
    this.config = config;
  }

  async checkAvailability(): Promise<{ available: boolean; error: string | null }> {
    if (this.availability) return this.availability;
    try {
      await this.loadPtyModule();
      this.availability = { available: true, error: null };
    } catch (error) {
      this.availability = {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.availability;
  }

  async start(connectionId: string, socket: TerminalSocket, options: TerminalStartOptions = {}): Promise<void> {
    this.close(connectionId);
    const ptyModule = await this.loadPtyModule();
    const cols = normalizeDimension(options.cols, 80, 20, 300);
    const rows = normalizeDimension(options.rows, 24, 8, 120);
    const pty = ptyModule.spawn(this.config.shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.config.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });

    this.sessions.set(connectionId, { pty });
    pty.onData((data) => {
      socket.sendText(JSON.stringify({ type: "output", data }));
    });
    pty.onExit(({ exitCode, signal }) => {
      socket.sendText(JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null }));
      this.sessions.delete(connectionId);
    });
  }

  write(connectionId: string, data: unknown): void {
    if (typeof data !== "string") return;
    this.sessions.get(connectionId)?.pty.write(data);
  }

  resize(connectionId: string, cols: unknown, rows: unknown): void {
    const session = this.sessions.get(connectionId);
    if (!session || typeof cols !== "number" || typeof rows !== "number") return;
    try {
      session.pty.resize(
        normalizeDimension(cols, 80, 20, 300),
        normalizeDimension(rows, 24, 8, 120),
      );
    } catch {
      // Resize can race with process exit; the close handler will clean up.
    }
  }

  close(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    this.sessions.delete(connectionId);
    try {
      session.pty.kill();
    } catch {
      // The PTY may already be gone.
    }
  }

  private async loadPtyModule(): Promise<NodePtyModule> {
    if (!this.ptyModulePromise) {
      this.ptyModulePromise = import("node-pty");
    }
    return await this.ptyModulePromise;
  }
}

function normalizeDimension(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
