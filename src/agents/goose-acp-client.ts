import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export interface GooseAcpClientOptions {
  cliPath: string;
  workingDirectory: string;
  env: Record<string, string>;
}

export interface GooseAcpEvent {
  method: string;
  params?: Record<string, unknown>;
}

export interface GooseAcpRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface GooseAcpResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (response: GooseAcpResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 30_000;
const STARTUP_DELAY_MS = 100;

export class GooseAcpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineReader: ReadLineInterface | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: GooseAcpEvent) => void>();
  private readonly requestListeners = new Set<(request: GooseAcpRequest) => void>();
  private stderr = "";
  private nextRequestId = 1;

  constructor(private readonly options: GooseAcpClientOptions) {}

  async start(): Promise<void> {
    if (this.process) return;

    const child = spawn(this.options.cliPath, ["acp"], {
      cwd: this.options.workingDirectory,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    this.lineReader = createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));
    this.process = child;

    await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));
    if (child.exitCode !== null) {
      throw new Error(this.processError(child.exitCode, null));
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.lineReader?.close();
    this.lineReader = null;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
  }

  onEvent(listener: (event: GooseAcpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onRequest(listener: (request: GooseAcpRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async request(method: string, params?: Record<string, unknown>): Promise<GooseAcpResponse> {
    if (!this.process?.stdin.writable) throw new Error("Goose ACP process is not running");
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for Goose ACP ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      try {
        this.process!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.process?.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.process?.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }

  getStderr(): string { return this.stderr; }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
    const id = typeof payload.id === "number" || typeof payload.id === "string" ? payload.id : undefined;
    if (id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
      const pending = this.pendingRequests.get(Number(id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(Number(id));
      pending.resolve(payload as GooseAcpResponse);
      return;
    }
    if (id !== undefined && typeof payload.method === "string") {
      for (const listener of this.requestListeners) listener({
        id,
        method: payload.method,
        params: isRecord(payload.params) ? payload.params : undefined,
      });
      return;
    }
    if (typeof payload.method === "string") {
      for (const listener of this.eventListeners) listener({
        method: payload.method,
        params: isRecord(payload.params) ? payload.params : undefined,
      });
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(this.processError(code, signal));
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.process = null;
    this.lineReader?.close();
    this.lineReader = null;
    for (const listener of this.eventListeners) {
      listener({ method: "process_exit", params: { code, signal, stderr: this.stderr } });
    }
  }

  private processError(code: number | null, signal: NodeJS.Signals | null): string {
    return `Goose ACP process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}${this.stderr ? `: ${this.stderr.trim()}` : ""}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
