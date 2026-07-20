import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import type { AgentAdapter, AdapterSessionContext, AdapterStreamEvent, AgentPermission, PromptReadiness } from "./agent-adapter";
import { GooseAcpClient, type GooseAcpEvent, type GooseAcpRequest, type GooseAcpResponse } from "./goose-acp-client";

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

const ACP_PROTOCOL_VERSION = "2025-01-01";
const DEFAULT_GOOSE_CLI = "/usr/local/bin/goose";

export class GooseAdapter implements AgentAdapter {
  private state: AdapterState = "initializing";
  private client: GooseAcpClient | null = null;
  private startPromise: Promise<void> | null = null;
  private sessionId: string | null;
  private messages: AgentMessage[] = [];
  private readonly eventListeners = new Set<(event: AdapterStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, GooseAcpRequest>();

  constructor(private readonly context: AdapterSessionContext) {
    this.sessionId = context.gooseSessionId ?? null;
  }

  async fetchStatus(): Promise<AgentRuntimeStatus | null> {
    if (this.state === "disposed") return null;
    return this.state === "busy" ? "running" : "stable";
  }

  async getPromptReadiness(_timeoutMs?: number): Promise<PromptReadiness> {
    const observedAt = Date.now();
    if (this.state === "disposed") return { state: "unreachable", reason: "goose-disposed", retryAfterMs: 5000, observedAt };
    if (this.state === "initializing") return { state: "starting", reason: "goose-initializing", retryAfterMs: 1000, observedAt };
    if (this.state === "busy") return { state: "busy", reason: "goose-active-turn", retryAfterMs: 1000, observedAt };
    return { state: "ready", reason: "goose-ready", retryAfterMs: 250, observedAt };
  }

  deliversPromptsDirectly(): boolean { return true; }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    await this.waitForReady();
    const sessionId = this.requireSessionId();
    this.state = "busy";
    try {
      const response = await this.requireClient().request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: content }],
      });
      assertAcpSuccess(response, "session/prompt");
    } finally {
      if ((this.state as AdapterState) !== "disposed") this.state = "ready";
    }
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    await this.waitForReady();
    return this.messages.slice();
  }

  getPendingPermissions(): AgentPermission[] {
    return [...this.pendingPermissions.entries()].map(([id, request]) => ({
      id,
      sessionId: this.context.id,
      type: "goose-acp-permission",
      title: "Goose requests permission",
      metadata: request.params ?? {},
      createdAt: new Date().toISOString(),
    }));
  }

  async respondToPermission(permissionId: string, response: "once" | "always" | "reject"): Promise<boolean> {
    const request = this.pendingPermissions.get(permissionId);
    if (!request || !this.client) return false;
    const options = Array.isArray(request.params?.options) ? request.params.options : [];
    const selected = options.find((option) => {
      const id = typeof option === "object" && option ? (option as Record<string, unknown>).optionId : "";
      return typeof id === "string" && id.toLowerCase().includes(response);
    });
    const optionId = selected && typeof selected === "object"
      ? (selected as Record<string, unknown>).optionId
      : response;
    this.client.respond(request.id, { outcome: { outcome: "selected", optionId } });
    this.pendingPermissions.delete(permissionId);
    return true;
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (this.state !== "busy" || !this.client || !this.sessionId) return false;
    const response = await this.client.request("session/cancel", { sessionId: this.sessionId });
    assertAcpSuccess(response, "session/cancel");
    return true;
  }

  getEventsUrl(): URL | null { return null; }

  subscribeToEvents(listener: (event: AdapterStreamEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "disposed") throw new Error("GooseAdapter has been disposed");
    await this.ensureStarted();
    const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
    while (this.state === "busy" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options?.pollIntervalMs ?? 100));
    }
    if (this.state === "busy") throw new Error("GooseAdapter is still processing a prompt");
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
    this.pendingPermissions.clear();
    const client = this.client;
    this.client = null;
    this.startPromise = null;
    if (client) await client.stop();
  }

  getSessionId(): string | null { return this.sessionId; }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (!this.startPromise) {
      this.startPromise = this.startClient();
    }
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startClient(): Promise<void> {
    const env = {
      ...(process.env as Record<string, string>),
      ...(this.context.env ?? {}),
    };
    const model = this.context.model?.trim();
    if (model) {
      env.GOOSE_MODEL = model;
      const provider = model.split("/", 1)[0]?.trim();
      if (provider) env.GOOSE_PROVIDER = provider;
    }
    if (env.OPENROUTER_API_KEY && !env.GOOSE_PROVIDER__API_KEY) {
      env.GOOSE_PROVIDER__API_KEY = env.OPENROUTER_API_KEY;
    }
    if (env.OPENROUTER_HOST && !env.GOOSE_PROVIDER__HOST) {
      env.GOOSE_PROVIDER__HOST = env.OPENROUTER_HOST;
    }
    const client = new GooseAcpClient({
      cliPath: this.context.gooseCli || env.GOOSE_CLI || DEFAULT_GOOSE_CLI,
      workingDirectory: this.context.workingDirectory ?? process.cwd(),
      env,
    });
    client.onEvent((event) => this.handleEvent(event));
    client.onRequest((request) => this.handleRequest(request));
    await client.start();
    this.client = client;

    const init = await client.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "wingman-autopilot", version: "1.0.0" },
      clientCapabilities: {},
    });
    assertAcpSuccess(init, "initialize");
    if (this.sessionId && !supportsSessionLoad(init.result)) {
      throw new Error("Goose ACP does not advertise session/load support");
    }
    const sessionMethod = this.sessionId ? "session/load" : "session/new";
    const sessionParams = this.sessionId
      ? { sessionId: this.sessionId, cwd: this.context.workingDirectory ?? process.cwd(), mcpServers: [] }
      : { cwd: this.context.workingDirectory ?? process.cwd(), mcpServers: [] };
    const sessionResponse = await client.request(sessionMethod, sessionParams);
    assertAcpSuccess(sessionResponse, sessionMethod);
    const returnedSessionId = readSessionId(sessionResponse.result) ?? this.sessionId;
    if (!returnedSessionId) throw new Error("Goose ACP did not return a session ID");
    this.sessionId = returnedSessionId;
    this.context.onNativeSessionId?.(returnedSessionId);
    this.state = "ready";
  }

  private handleEvent(event: GooseAcpEvent): void {
    if (event.method === "process_exit") {
      if (this.state !== "disposed") this.state = "initializing";
      this.emit({ type: "status", status: null });
      return;
    }
    if (event.method !== "session/update" && event.method !== "session/notification") return;
    const update = event.params?.update;
    if (!update || typeof update !== "object") return;
    const data = update as Record<string, unknown>;
    const sessionUpdate = typeof data.sessionUpdate === "string" ? data.sessionUpdate : "";
    if (sessionUpdate !== "agent_message_chunk") return;
    const content = data.content;
    const text = content && typeof content === "object" && typeof (content as Record<string, unknown>).text === "string"
      ? (content as Record<string, unknown>).text as string
      : "";
    if (!text) return;
    const createdAt = new Date().toISOString();
    const previous = this.messages.at(-1);
    const message = previous?.role === "assistant" && this.state === "busy"
      ? { ...previous, content: previous.content + text }
      : { role: "assistant", content: text, createdAt };
    this.messages = previous?.role === "assistant" && this.state === "busy"
      ? [...this.messages.slice(0, -1), message]
      : [...this.messages, message];
    this.emit({ type: "message", message });
  }

  private handleRequest(request: GooseAcpRequest): void {
    if (request.method !== "session/request_permission" && request.method !== "requestPermission") {
      this.requireClient().respondError(request.id, -32601, `Unsupported Goose ACP request: ${request.method}`);
      return;
    }
    const id = String(request.id);
    this.pendingPermissions.set(id, request);
    const permission: AgentPermission = {
      id,
      sessionId: this.context.id,
      type: "goose-acp-permission",
      title: "Goose requests permission",
      metadata: request.params ?? {},
      createdAt: new Date().toISOString(),
    };
    this.emit({ type: "permission", permission });
  }

  private requireClient(): GooseAcpClient {
    if (!this.client) throw new Error("Goose ACP client is not ready");
    return this.client;
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error("Goose ACP session ID is missing");
    return this.sessionId;
  }

  private emit(event: AdapterStreamEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

function assertAcpSuccess(response: GooseAcpResponse, method: string): void {
  if (response.error) throw new Error(`Goose ACP ${method} failed: ${response.error.message ?? "unknown error"}`);
}

function readSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  return typeof data.sessionId === "string" && data.sessionId.trim() ? data.sessionId.trim() : null;
}

function supportsSessionLoad(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.loadSession === true) return true;
  const capabilities = result.agentCapabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  const data = capabilities as Record<string, unknown>;
  if (data.loadSession === true) return true;
  const sessions = data.sessionCapabilities;
  return Boolean(sessions && typeof sessions === "object" && (sessions as Record<string, unknown>).load === true);
}
