/**
 * AgentAdapter — abstracts the communication protocol between Wingman and an agent.
 *
 * AgentApiAdapter (agentapi HTTP proxy) is the default for all agents.
 * Future adapters: OpenCodeAdapter (@opencode-ai/sdk), CodexAdapter (@openai/codex-sdk).
 */

import type { AgentType } from "../config";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";

/** Minimal session context needed by adapters */
export interface AdapterSessionContext {
  id: string;
  port: number;
  agent: AgentType;
  host: string;
  pm2Name?: string;
}

export interface AgentAdapter {
  /** Get the agent's current runtime status */
  fetchStatus(timeoutMs?: number): Promise<AgentRuntimeStatus | null>;

  /** Send a message to the agent. Throws on failure after retries. */
  sendMessage(content: string, type?: string): Promise<void>;

  /** Fetch conversation message history */
  fetchMessages(): Promise<AgentMessage[]>;

  /**
   * Get the URL for the agent's SSE event stream.
   * Returns null if the adapter handles streaming through a different mechanism.
   * Used by session-events.ts to proxy events to the browser.
   */
  getEventsUrl(): URL | null;

  /** Wait for agent to be ready to accept prompts */
  waitForReady(options?: AgentReadyOptions): Promise<void>;

  /** Clean up adapter-specific resources on session stop */
  dispose(): Promise<void>;
}

export type AgentAdapterFactory = (context: AdapterSessionContext) => AgentAdapter;

/**
 * Returns the appropriate adapter factory for the given agent type.
 * Currently all agents use AgentApiAdapter. Future phases add:
 * - opencode → OpenCodeAdapter (Phase 2)
 * - codex → CodexAdapter (Phase 3)
 */
export function resolveAdapterFactory(_agent: AgentType): AgentAdapterFactory {
  // Phase 1: all agents use agentapi
  // Phase 2/3 will check feature flags + agent type here
  return (context: AdapterSessionContext) => {
    // Lazy import to avoid circular dependency issues
    const { AgentApiAdapter } = require("./agentapi-adapter") as typeof import("./agentapi-adapter");
    return new AgentApiAdapter(context);
  };
}
