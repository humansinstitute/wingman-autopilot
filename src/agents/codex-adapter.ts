/**
 * CodexAdapter — communicates with Codex directly via @openai/codex-sdk.
 *
 * Bypasses agentapi by using the SDK's thread management to start, stream,
 * and resume Codex sessions natively.  The ProcessManager still handles
 * lifecycle (port allocation, MCP injection, billing env), but no agentapi
 * process is spawned — the SDK manages the Codex CLI process itself.
 */

import {
  Codex,
  type ThreadOptions,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type AgentMessageItem,
  type Usage,
} from "@openai/codex-sdk";

import type { AgentAdapter, AdapterSessionContext } from "./agent-adapter";
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
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter implements AgentAdapter {
  private readonly codex: Codex;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private state: AdapterState = "initializing";
  private readonly messages: CollectedMessage[] = [];
  private readonly workingDirectory: string;
  private currentAbort: AbortController | null = null;

  /** Listeners registered via onEvent() for internal SSE bridging */
  private eventListeners: Array<(event: ThreadEvent) => void> = [];

  constructor(private readonly context: AdapterSessionContext) {
    this.workingDirectory = context.workingDirectory ?? process.cwd();

    // Build SDK options from session env
    const env = context.env ?? {};
    const apiKey =
      env.CODEX_API_KEY ||
      env.OPENAI_API_KEY ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "";
    const baseUrl =
      env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || undefined;

    this.codex = new Codex({
      apiKey: apiKey || undefined,
      baseUrl,
      env: {
        ...process.env as Record<string, string>,
        ...env,
      },
    });

    this.initialise();
  }

  // -----------------------------------------------------------------------
  // AgentAdapter interface
  // -----------------------------------------------------------------------

  async fetchStatus(_timeoutMs?: number): Promise<AgentRuntimeStatus | null> {
    switch (this.state) {
      case "initializing":
        return "running";
      case "ready":
        return "stable";
      case "busy":
        return "running";
      case "disposed":
        return null;
      default:
        return null;
    }
  }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("CodexAdapter has been disposed");
    }

    // Record the user message
    this.messages.push({
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    });

    // Ensure thread is ready
    if (!this.thread) {
      await this.waitForReady();
    }
    if (!this.thread) {
      throw new Error("Codex thread not initialised");
    }

    this.state = "busy";
    this.currentAbort = new AbortController();

    try {
      const { events } = await this.thread.runStreamed(content, {
        signal: this.currentAbort.signal,
      });

      // Capture the thread ID after the first turn if not yet stored
      if (!this.threadId && this.thread.id) {
        this.threadId = this.thread.id;
      }

      let finalText = "";
      let usage: Usage | null = null;

      for await (const event of events) {
        // Broadcast to any registered listeners (for future SSE bridging)
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch {
            // Non-fatal: listener errors don't interrupt the stream
          }
        }

        // Capture thread ID from thread.started event
        if (event.type === "thread.started") {
          this.threadId = event.thread_id;
        }

        // Collect final agent message text
        if (event.type === "item.completed") {
          const item = event.item as ThreadItem;
          if (item.type === "agent_message") {
            finalText += (item as AgentMessageItem).text;
          }
        }

        // Capture usage from turn completion
        if (event.type === "turn.completed") {
          usage = event.usage;
        }
      }

      // Report usage to billing ledger
      if (usage && this.context.recordUsage) {
        this.context.recordUsage({
          sessionId: this.context.id,
          endpoint: '/v1/responses',
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        }).catch(err =>
          console.error(`[codex-adapter] billing error: ${(err as Error).message}`),
        );
      }

      // Record the assistant response
      if (finalText) {
        this.messages.push({
          role: "assistant",
          content: finalText,
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      this.currentAbort = null;
      this.state = "ready";
    }
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    return this.messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
  }

  getEventsUrl(): URL | null {
    // The SDK handles streaming internally — no HTTP SSE endpoint to proxy
    return null;
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "ready" || this.state === "busy") return;
    if (this.state === "disposed") {
      throw new Error("CodexAdapter has been disposed");
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const pollMs = options?.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;

    while (this.state === "initializing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (this.state === "initializing") {
      throw new Error(`CodexAdapter not ready after ${timeoutMs}ms`);
    }
  }

  async dispose(): Promise<void> {
    this.state = "disposed";

    // Abort any in-flight turn
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }

    this.eventListeners = [];
    this.thread = null;
  }

  // -----------------------------------------------------------------------
  // Public accessors (for process-manager / session persistence)
  // -----------------------------------------------------------------------

  /** The Codex thread ID — persist this for session resume across restarts */
  getThreadId(): string | null {
    return this.threadId;
  }

  /** Register a listener for SDK thread events (for future SSE bridging) */
  onEvent(listener: (event: ThreadEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private initialise(): void {
    try {
      const threadOptions: ThreadOptions = {
        workingDirectory: this.workingDirectory,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      };

      // Resume existing thread if we have a stored ID, otherwise start fresh
      if (this.context.codexThreadId) {
        this.thread = this.codex.resumeThread(
          this.context.codexThreadId,
          threadOptions,
        );
        this.threadId = this.context.codexThreadId;
      } else {
        this.thread = this.codex.startThread(threadOptions);
      }

      this.state = "ready";
    } catch (error) {
      console.error(
        `[codex-adapter] Failed to initialise thread for session ${this.context.id}:`,
        (error as Error).message,
      );
      // Stay in initializing state — waitForReady will timeout
    }
  }
}
