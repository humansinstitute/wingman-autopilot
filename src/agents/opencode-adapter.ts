/**
 * OpenCodeAdapter — communicates with OpenCode via @opencode-ai/sdk.
 *
 * Unlike CodexAdapter (where the SDK manages the process), OpenCode runs its
 * own HTTP server and the SDK is a REST client that connects to it.  The
 * ProcessManager still spawns the OpenCode process; this adapter creates an
 * SDK client that talks to it on the allocated port.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";

import type {
  AdapterStreamEvent,
  AgentAdapter,
  AgentPermission,
  AdapterSessionContext,
  PromptReadiness,
} from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import type { Message, Part } from "@opencode-ai/sdk";

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

// ---------------------------------------------------------------------------
// OpenCodeAdapter
// ---------------------------------------------------------------------------

export class OpenCodeAdapter implements AgentAdapter {
  private readonly client: ReturnType<typeof createOpencodeClient>;
  private readonly baseUrl: string;
  private sessionId: string | null = null;
  private state: AdapterState = "initializing";
  private readonly workingDirectory: string;
  private readonly streamListeners = new Set<(event: AdapterStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, AgentPermission>();
  private eventAbortController: AbortController | null = null;
  private eventTask: Promise<void> | null = null;

  constructor(private readonly context: AdapterSessionContext) {
    this.workingDirectory = context.workingDirectory ?? process.cwd();
    this.baseUrl = `http://${context.host}:${context.port}`;

    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      directory: this.workingDirectory,
    });

    // Resume existing session or mark ready for lazy creation
    if (context.opencodeSdkSessionId) {
      this.sessionId = context.opencodeSdkSessionId;
      this.state = "ready";
      this.context.onNativeSessionId?.(this.sessionId);
    }
  }

  // -----------------------------------------------------------------------
  // AgentAdapter interface
  // -----------------------------------------------------------------------

  async fetchStatus(_timeoutMs?: number): Promise<AgentRuntimeStatus | null> {
    if (this.state === "disposed") return null;

    // If we haven't created a session yet, probe the server health
    if (!this.sessionId) {
      try {
        const result = await this.client.session.list();
        if (result.data) {
          this.state = "ready";
          return "running";
        }
        return "running";
      } catch {
        return "running"; // Server not yet up
      }
    }

    try {
      const result = await this.client.session.get({
        path: { id: this.sessionId },
      });
      if (result.error) return null;
      this.state = "ready";
      return "stable";
    } catch {
      return null;
    }
  }

  async getPromptReadiness(_timeoutMs?: number): Promise<PromptReadiness> {
    const observedAt = Date.now();
    if (this.state === "disposed") {
      return { state: "unreachable", reason: "opencode-disposed", retryAfterMs: 5000, observedAt };
    }
    if (this.state === "busy") {
      return { state: "busy", reason: "opencode-active-turn", retryAfterMs: 1000, observedAt };
    }
    if (!this.sessionId) {
      try {
        const result = await this.client.session.list();
        if (result.data) {
          this.state = "ready";
          return { state: "ready", reason: "opencode-server-ready", retryAfterMs: 250, observedAt };
        }
      } catch {
        return { state: "starting", reason: "opencode-server-starting", retryAfterMs: 1000, observedAt };
      }
      return { state: "starting", reason: "opencode-session-not-created", retryAfterMs: 1000, observedAt };
    }

    try {
      const result = await this.client.session.get({
        path: { id: this.sessionId },
      });
      if (result.error) {
        return { state: "unreachable", reason: "opencode-session-error", retryAfterMs: 5000, observedAt };
      }
      this.state = "ready";
      return { state: "ready", reason: "opencode-session-ready", retryAfterMs: 250, observedAt };
    } catch {
      return { state: "unreachable", reason: "opencode-session-unreachable", retryAfterMs: 5000, observedAt };
    }
  }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("OpenCodeAdapter has been disposed");
    }

    // Ensure we have a session
    await this.ensureSession();
    if (!this.sessionId) {
      throw new Error("OpenCode session not initialised");
    }

    this.state = "busy";

    try {
      const result = await this.client.session.prompt({
        path: { id: this.sessionId },
        query: { directory: this.workingDirectory },
        body: {
          ...(this.context.model ? { model: parseModelReference(this.context.model) } : {}),
          parts: [{ type: "text", text: content }],
        },
      });

      if (result.error) {
        throw new Error(`OpenCode prompt failed: ${JSON.stringify(result.error)}`);
      }
      const usage = result.data?.info?.tokens;
      if (usage && this.context.recordUsage) {
        this.context.recordUsage({
          sessionId: this.context.id,
          endpoint: "/opencode/session/prompt",
          inputTokens: usage.input,
          outputTokens: usage.output,
        }).catch((error) => {
          console.error(`[opencode-adapter] billing error: ${(error as Error).message}`);
        });
      }
    } finally {
      if ((this.state as AdapterState) !== "disposed") {
        this.state = "ready";
      }
    }
  }

  deliversPromptsDirectly(): boolean {
    return true;
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    if (!this.sessionId) return [];
    const result = await this.client.session.messages({
      path: { id: this.sessionId },
      query: { directory: this.workingDirectory },
    });
    if (result.error || !Array.isArray(result.data)) return [];
    return result.data.flatMap((entry) => toAgentMessages(entry.info, entry.parts));
  }

  getPendingPermissions(): AgentPermission[] {
    return [...this.pendingPermissions.values()];
  }

  async respondToPermission(
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<boolean> {
    if (!this.sessionId || !this.pendingPermissions.has(permissionId)) return false;
    const result = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: this.sessionId, permissionID: permissionId },
      query: { directory: this.workingDirectory },
      body: { response },
    });
    if (result.error) return false;
    this.pendingPermissions.delete(permissionId);
    return true;
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (!this.sessionId || this.state !== "busy") return false;
    const result = await this.client.session.abort({
      path: { id: this.sessionId },
      query: { directory: this.workingDirectory },
    });
    return !result.error && result.data === true;
  }

  getEventsUrl(): URL | null {
    return null;
  }

  subscribeToEvents(listener: (event: AdapterStreamEvent) => void): () => void {
    this.streamListeners.add(listener);
    this.startEventStream();
    return () => {
      this.streamListeners.delete(listener);
      if (this.streamListeners.size === 0) {
        this.stopEventStream();
      }
    };
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "ready" || this.state === "busy") return;
    if (this.state === "disposed") {
      throw new Error("OpenCodeAdapter has been disposed");
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const pollMs = options?.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const result = await this.client.session.list();
        if (result.data) {
          this.state = "ready";
          return;
        }
      } catch {
        // Server not ready yet — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(`OpenCodeAdapter not ready after ${timeoutMs}ms`);
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
    this.stopEventStream();
    // Keep the OpenCode session on disk so archived sessions can be resumed.
    // Deleting it is an explicit user action in OpenCode, not lifecycle cleanup.
  }

  // -----------------------------------------------------------------------
  // Public accessors (for process-manager / session persistence)
  // -----------------------------------------------------------------------

  /** The OpenCode session ID — persist this for session resume */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;

    // Wait for the server to be reachable first
    if (this.state === "initializing") {
      await this.waitForReady();
    }

    const result = await this.client.session.create({
      body: { title: `wingman-${this.context.id}` },
    });

    if (result.data && typeof result.data === "object" && "id" in result.data) {
      this.sessionId = (result.data as { id: string }).id;
      this.context.onNativeSessionId?.(this.sessionId);
    } else {
      throw new Error("Failed to create OpenCode session");
    }
  }

  private startEventStream(): void {
    if (this.eventTask || this.state === "disposed") return;
    this.eventAbortController = new AbortController();
    this.eventTask = this.consumeEventStream(this.eventAbortController.signal).finally(() => {
      this.eventTask = null;
      this.eventAbortController = null;
    });
  }

  private stopEventStream(): void {
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.eventTask = null;
  }

  private async consumeEventStream(signal: AbortSignal): Promise<void> {
    try {
      const result = await this.client.event.subscribe({
        query: { directory: this.workingDirectory },
        signal,
      });
      for await (const event of result.stream) {
        if (signal.aborted) return;
        await this.handleEvent(event);
      }
    } catch (error) {
      if (!signal.aborted) {
        console.warn(`[opencode-adapter] event stream stopped: ${(error as Error).message}`);
      }
    }
  }

  private async handleEvent(event: { type?: string; properties?: Record<string, unknown> }): Promise<void> {
    const properties = event.properties ?? {};
    const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : null;
    if (sessionId && sessionId !== this.sessionId) return;

    if (event.type === "session.status") {
      const status = properties.status as { type?: string } | undefined;
      this.state = status?.type === "busy" ? "busy" : "ready";
      this.emitStream({ type: "status", status: this.state === "busy" ? "running" : "stable" });
      if (status?.type !== "busy") await this.emitLatestMessages();
      return;
    }
    if (event.type === "session.idle") {
      this.state = "ready";
      this.emitStream({ type: "status", status: "stable" });
      await this.emitLatestMessages();
      return;
    }
    if (event.type === "message.updated" || event.type === "message.part.updated") {
      await this.emitLatestMessages();
      return;
    }
    if (event.type === "permission.updated") {
      const permission = toAgentPermission(properties);
      if (permission) {
        this.pendingPermissions.set(permission.id, permission);
        this.emitStream({ type: "permission", permission });
      }
      return;
    }
    if (event.type === "permission.replied") {
      const permissionId = typeof properties.permissionID === "string" ? properties.permissionID : "";
      if (permissionId) this.pendingPermissions.delete(permissionId);
    }
  }

  private async emitLatestMessages(): Promise<void> {
    const messages = await this.fetchMessages().catch(() => []);
    const latest = messages.at(-1);
    if (latest) this.emitStream({ type: "message", message: latest });
  }

  private emitStream(event: AdapterStreamEvent): void {
    for (const listener of this.streamListeners) {
      try {
        listener(event);
      } catch {
        // A disconnected browser subscriber must not stop OpenCode events.
      }
    }
  }
}

function parseModelReference(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`OpenCode model must use provider/model format: ${model}`);
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function toAgentMessages(info: Message, parts: Part[]): AgentMessage[] {
  const role = info.role === "user" ? "user" : "assistant";
  const text = parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored)
    .map((part) => part.text)
    .join("");
  if (!text) return [];
  return [{
    role,
    content: text,
    createdAt: new Date(info.time.created).toISOString(),
  }];
}

function toAgentPermission(properties: Record<string, unknown>): AgentPermission | null {
  const id = typeof properties.id === "string" ? properties.id : "";
  const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : "";
  const type = typeof properties.type === "string" ? properties.type : "permission";
  const title = typeof properties.title === "string" ? properties.title : type;
  if (!id || !sessionId) return null;
  const time = properties.time as Record<string, unknown> | undefined;
  const created = typeof time?.created === "number" ? time.created : Date.now();
  return {
    id,
    sessionId,
    type,
    title,
    ...(typeof properties.pattern === "string" || Array.isArray(properties.pattern)
      ? { pattern: properties.pattern as string | string[] }
      : {}),
    metadata: properties.metadata && typeof properties.metadata === "object"
      ? properties.metadata as Record<string, unknown>
      : {},
    createdAt: new Date(created).toISOString(),
  };
}
