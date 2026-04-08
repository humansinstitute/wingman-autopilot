/**
 * AgentApiAdapter — communicates with agents via the agentapi HTTP proxy.
 *
 * Wraps the existing agent-client.ts helper functions behind the AgentAdapter
 * interface. This is the default adapter for all agents (Claude, Codex,
 * OpenCode, Goose, Gemini) and will remain the adapter for agents that don't
 * have a native SDK (Claude, Goose, Gemini).
 */

import type { AgentAdapter, AdapterSessionContext } from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import { isAgentRuntimeStatus } from "../types/agent-status";
import {
  buildAgentUrl,
  fetchAgentMessages,
  sendAgentMessage,
  waitForAgentReady,
  type AgentMessage,
  type AgentReadyOptions,
} from "./agent-client";

export class AgentApiAdapter implements AgentAdapter {
  private readonly host: string;
  private readonly port: number;
  private readonly agent: string;

  constructor(private readonly context: AdapterSessionContext) {
    this.host = context.host;
    this.port = context.port;
    this.agent = context.agent;
  }

  async fetchStatus(timeoutMs = 5000): Promise<AgentRuntimeStatus | null> {
    const url = buildAgentUrl(this.host, this.port, "/status");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`status request failed (${response.status})`);
      }
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const data = payload as Record<string, unknown>;
      return isAgentRuntimeStatus(data.status) ? data.status : null;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("status request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async sendMessage(content: string, type = "user"): Promise<void> {
    await sendAgentMessage(this.host, this.port, content, { type });
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    return fetchAgentMessages(this.host, this.port);
  }

  async interruptCurrentTurn(): Promise<boolean> {
    return false;
  }

  getEventsUrl(): URL | null {
    return buildAgentUrl(this.host, this.port, "/events");
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    await waitForAgentReady(
      this.host,
      this.port,
      this.agent as any,
      options,
    );
  }

  async dispose(): Promise<void> {
    // AgentApiAdapter has no resources to clean up — the agentapi process
    // is managed by ProcessManager directly.
  }
}
