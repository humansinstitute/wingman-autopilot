/**
 * AgentAdapter — abstracts the communication protocol between Wingman and an agent.
 *
 * AgentApiAdapter (agentapi HTTP proxy) is the default for all agents.
 * Future adapters: OpenCodeAdapter (@opencode-ai/sdk), CodexAdapter (@openai/codex-sdk).
 */

import type { AgentType } from "../config";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import { featureFlagStore, resolveFeatureFlagEffectiveState } from "../storage/feature-flag-store";

/** Minimal session context needed by adapters */
export interface AdapterSessionContext {
  id: string;
  port: number;
  agent: AgentType;
  host: string;
  pm2Name?: string;
  /** Working directory for the agent session (used by native SDK adapters) */
  workingDirectory?: string;
  /** Environment variables for the agent process (used by native SDK adapters) */
  env?: Record<string, string>;
  /** Codex thread ID for session resume (used by CodexAdapter) */
  codexThreadId?: string;
  /** OpenCode session ID for session resume (used by OpenCodeAdapter) */
  opencodeSdkSessionId?: string;
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

export const CODEX_NATIVE_SDK_FLAG = "codex-use-native-sdk";
export const OPENCODE_NATIVE_SDK_FLAG = "opencode-use-native-sdk";

/**
 * Returns the appropriate adapter factory for the given agent type.
 * - codex + CODEX_USE_NATIVE_SDK flag → CodexAdapter (Phase 3)
 * - all other agents → AgentApiAdapter
 */
export function resolveAdapterFactory(agent: AgentType): AgentAdapterFactory {
  if (agent === "codex") {
    const flag = featureFlagStore.getFlag(CODEX_NATIVE_SDK_FLAG);
    if (flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on") {
      return (context: AdapterSessionContext) => {
        const { CodexAdapter } = require("./codex-adapter") as typeof import("./codex-adapter");
        return new CodexAdapter(context);
      };
    }
  }

  if (agent === "opencode") {
    const flag = featureFlagStore.getFlag(OPENCODE_NATIVE_SDK_FLAG);
    if (flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on") {
      return (context: AdapterSessionContext) => {
        const { OpenCodeAdapter } = require("./opencode-adapter") as typeof import("./opencode-adapter");
        return new OpenCodeAdapter(context);
      };
    }
  }

  // Default: all agents use agentapi
  return (context: AdapterSessionContext) => {
    const { AgentApiAdapter } = require("./agentapi-adapter") as typeof import("./agentapi-adapter");
    return new AgentApiAdapter(context);
  };
}
