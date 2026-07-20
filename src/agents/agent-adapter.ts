/**
 * AgentAdapter — abstracts the communication protocol between Wingman and an agent.
 *
 * AgentApiAdapter (agentapi HTTP proxy) remains the fallback for agents without
 * a native transport. OpenCodeAdapter and CodexAdapter use their SDKs directly.
 */

import type { AgentType } from "../config";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import { featureFlagStore, resolveFeatureFlagEffectiveState } from "../storage/feature-flag-store";

export type PromptReadinessState = "ready" | "starting" | "busy" | "unreachable";

export interface PromptReadiness {
  state: PromptReadinessState;
  reason: string;
  retryAfterMs: number;
  observedAt: number;
}

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
  /** Optional model override selected for this session. */
  model?: string;
  /** Codex thread ID for session resume (used by CodexAdapter) */
  codexThreadId?: string;
  /**
   * Structured Codex `--config` overrides (MCP servers, billing auth, etc.)
   * passed to `@openai/codex-sdk` since the native adapter spawns no CLI to
   * receive `-c` flags.
   */
  codexConfig?: Record<string, unknown>;
  /** OpenCode session ID for session resume (used by OpenCodeAdapter) */
  opencodeSdkSessionId?: string;
  /** Goose ACP session ID for session resume (used by GooseAdapter) */
  gooseSessionId?: string;
  /** Configured Goose executable path or PATH-resolved command. */
  gooseCli?: string;
  /** Configured Goose provider used when no session-specific override exists. */
  gooseProvider?: string;
  /** Called when an adapter discovers or creates the native agent session ID. */
  onNativeSessionId?: (sessionId: string) => void;
  /** Optional billing callback for native SDK adapters that bypass the proxy */
  recordUsage?: (data: {
    sessionId: string;
    endpoint: string;
    costUsd?: number | null;
    inputTokens?: number;
    outputTokens?: number;
  }) => Promise<void>;
}

export interface AgentAdapter {
  /** Get the agent's current runtime status */
  fetchStatus(timeoutMs?: number): Promise<AgentRuntimeStatus | null>;

  /** Get whether the agent can accept a new user prompt right now. */
  getPromptReadiness?(timeoutMs?: number): Promise<PromptReadiness>;

  /** Send a message to the agent. Throws on failure after retries. */
  sendMessage(content: string, type?: string): Promise<void>;

  /** Whether prompts must bypass AgentAPI and use this adapter directly. */
  deliversPromptsDirectly?(): boolean;

  /** Fetch conversation message history */
  fetchMessages(): Promise<AgentMessage[]>;

  /** Return pending interactive permissions, when supported. */
  getPendingPermissions?(): AgentPermission[];

  /** Resolve a pending interactive permission, when supported. */
  respondToPermission?(permissionId: string, response: "once" | "always" | "reject"): Promise<boolean>;

  /** Interrupt the current turn when the adapter supports it */
  interruptCurrentTurn(): Promise<boolean>;

  /**
   * Get the URL for the agent's SSE event stream.
   * Returns null if the adapter handles streaming through a different mechanism.
   * Used by session-events.ts to proxy events to the browser.
   */
  getEventsUrl(): URL | null;

  /**
   * Subscribe to adapter-native message/status events when no upstream SSE URL exists.
   * Returns an unsubscribe function when supported.
   */
  subscribeToEvents?(
    listener: (event: AdapterStreamEvent) => void,
  ): (() => void) | null;

  /** Wait for agent to be ready to accept prompts */
  waitForReady(options?: AgentReadyOptions): Promise<void>;

  /** Clean up adapter-specific resources on session stop */
  dispose(): Promise<void>;
}

export type AdapterStreamEvent =
  | {
      type: "message";
      message: AgentMessage;
    }
  | {
      type: "status";
      status: AgentRuntimeStatus | null;
    }
  | {
      type: "permission";
      permission: AgentPermission;
    };

export interface AgentPermission {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  pattern?: string | string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type AgentAdapterFactory = (context: AdapterSessionContext) => AgentAdapter;

export const CODEX_NATIVE_SDK_FLAG = "codex-use-native-sdk";
export const OPENCODE_NATIVE_SDK_FLAG = "opencode-use-native-sdk";
export const GOOSE_NATIVE_ACP_FLAG = "goose-use-native-acp";

/** Whether the native `@openai/codex-sdk` adapter is the active Codex transport. */
export function isCodexNativeSdkEnabled(): boolean {
  const flag = featureFlagStore.getFlag(CODEX_NATIVE_SDK_FLAG);
  return Boolean(flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on");
}

export function isGooseNativeAcpEnabled(): boolean {
  const flag = featureFlagStore.getFlag(GOOSE_NATIVE_ACP_FLAG);
  return Boolean(flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on");
}

/**
 * Returns the appropriate adapter factory for the given agent type.
 * - codex + CODEX_USE_NATIVE_SDK flag → CodexAdapter (Phase 3)
 * - all other agents → AgentApiAdapter
 */
export function resolveAdapterFactory(agent: AgentType): AgentAdapterFactory {
  if (agent === "pi") {
    return (context: AdapterSessionContext) => {
      const { PiAdapter } = require("./pi-adapter") as typeof import("./pi-adapter");
      return new PiAdapter(context);
    };
  }

  if (agent === "codex" && isCodexNativeSdkEnabled()) {
    return (context: AdapterSessionContext) => {
      const { CodexAdapter } = require("./codex-adapter") as typeof import("./codex-adapter");
      return new CodexAdapter(context);
    };
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

  if (agent === "goose" && isGooseNativeAcpEnabled()) {
    return (context: AdapterSessionContext) => {
      const { GooseAdapter } = require("./goose-adapter") as typeof import("./goose-adapter");
      return new GooseAdapter(context);
    };
  }

  // Default: all agents use agentapi
  return (context: AdapterSessionContext) => {
    const { AgentApiAdapter } = require("./agentapi-adapter") as typeof import("./agentapi-adapter");
    return new AgentApiAdapter(context);
  };
}
