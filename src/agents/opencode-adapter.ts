/**
 * OpenCodeAdapter — communicates with OpenCode via @opencode-ai/sdk.
 *
 * Unlike CodexAdapter (where the SDK manages the process), OpenCode runs its
 * own HTTP server and the SDK is a REST client that connects to it.  The
 * ProcessManager still spawns the OpenCode process; this adapter creates an
 * SDK client that talks to it on the allocated port.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";

import type { AgentAdapter, AdapterSessionContext, PromptReadiness } from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CollectedMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

// ---------------------------------------------------------------------------
// OpenCodeAdapter
// ---------------------------------------------------------------------------

export class OpenCodeAdapter implements AgentAdapter {
  private readonly client: ReturnType<typeof createOpencodeClient>;
  private readonly baseUrl: string;
  private sessionId: string | null = null;
  private state: AdapterState = "initializing";
  private readonly messages: CollectedMessage[] = [];
  private readonly workingDirectory: string;

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

    // Record user message
    this.messages.push({
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    });

    // Ensure we have a session
    await this.ensureSession();
    if (!this.sessionId) {
      throw new Error("OpenCode session not initialised");
    }

    this.state = "busy";

    try {
      const result = await this.client.session.prompt({
        path: { id: this.sessionId },
        body: {
          parts: [{ type: "text", text: content }],
        },
      });

      // Extract assistant text and usage from response
      if (result.data) {
        const data = result.data as Record<string, unknown>;
        const responseParts = (data.parts as any[]) ?? [];
        let responseText = "";
        for (const part of responseParts) {
          if (part.type === "text" && typeof part.text === "string") {
            responseText += part.text;
          }
        }
        if (responseText) {
          this.messages.push({
            role: "assistant",
            content: responseText,
            createdAt: new Date().toISOString(),
          });
        }

        // Report usage to billing ledger (mirrors CodexAdapter pattern)
        const usage = data.usage as Record<string, number> | undefined;
        if (this.context.recordUsage) {
          this.context.recordUsage({
            sessionId: this.context.id,
            endpoint: "/opencode/session/prompt",
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
          }).catch((err) =>
            console.error(`[opencode-adapter] billing error: ${(err as Error).message}`),
          );
        }
      }
    } finally {
      if ((this.state as AdapterState) !== "disposed") {
        this.state = "ready";
      }
    }
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    return this.messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
  }

  async interruptCurrentTurn(): Promise<boolean> {
    return false;
  }

  getEventsUrl(): URL | null {
    // OpenCode has its own SSE endpoint — return it so session-events.ts can proxy
    try {
      return new URL(`${this.baseUrl}/event`);
    } catch {
      return null;
    }
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

    // Try to clean up the session in OpenCode
    if (this.sessionId) {
      try {
        await this.client.session.delete({ path: { id: this.sessionId } });
      } catch {
        // Best effort — process may already be gone
      }
      this.sessionId = null;
    }
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
    } else {
      throw new Error("Failed to create OpenCode session");
    }
  }
}
