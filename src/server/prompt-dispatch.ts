/**
 * Prompt queue dispatch engine.
 * Extracted from server.ts to reduce file size.
 */

import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { resolveSessionChargeNpub } from "../sessions/session-metadata";
import { deliverSessionAgentMessage } from "./session-agent-message";
import { getSessionPromptReadiness } from "./prompt-readiness";

// ---------- Context supplied by server.ts ----------

export interface PromptDispatchContext {
  manager: {
    getSession: (id: string) => SessionSnapshot | undefined;
    listSessions: () => SessionSnapshot[];
    getAdapter: (id: string) => import("../agents/agent-adapter").AgentAdapter | null;
  };
  agentHost: string;
  messageStore: {
    listSessionMessages: (id: string) => unknown[];
  };
  isUserApprovedForWork?: (npub: string) => boolean;
  promptQueueStore: {
    getNextQueuedPrompt: (sessionId: string) => { content: string } | null;
    removeNextPrompt: (sessionId: string) => void;
    getQueueCount: (sessionId: string) => number;
  };
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;
  waitForSessionPromptReadiness: (opts: {
    getSession: (id: string) => SessionSnapshot | null;
    getAdapter: (id: string) => import("../agents/agent-adapter").AgentAdapter | null;
    sessionId: string;
    host: string;
    timeoutMs: number;
    pollIntervalMs: number;
    requiredStablePolls: number;
    requestTimeoutMs: number;
  }) => Promise<void>;
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeTriggerNightWatch: (session: SessionSnapshot | null, deps: any) => void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nightWatchDeps: any;
}

// ---------- Custom error ----------

export class QueueDispatchError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "QueueDispatchError";
  }
}

// ---------- Engine return type ----------

export interface PromptDispatchEngine {
  dispatchNextQueuedPromptForSession: (session: SessionSnapshot, userNpub: string | null) => Promise<{
    id: string;
    messages: unknown[];
    sentPrompt: { content: string };
  }>;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => Promise<void>;
  sweepQueuedSessionsForDispatch: () => void;
  markPromptStartupReady: (sessionId: string) => void;
  clearPromptStartupReady: (sessionId: string) => void;
  markQueueDispatchCooldown: (sessionId: string, retryAfterMs?: number) => void;
  queueDispatchInFlight: Set<string>;
  waitForMessageUpdate: (sessionId: string, initialCount: number, timeoutMs?: number) => Promise<unknown[]>;
}

// ---------- Factory ----------

const QUEUE_DISPATCH_RETRY_MS = 5000;
const QUEUE_DISPATCH_TIMING_LOG_THRESHOLD_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function logQueueDispatchTiming(params: {
  sessionId: string;
  agent: AgentType;
  status: "sent" | "failed";
  totalMs: number;
  readinessMs: number;
  deliveryMs: number;
  messageSyncMs: number;
  errorStatus?: number;
}): void {
  if (params.totalMs < QUEUE_DISPATCH_TIMING_LOG_THRESHOLD_MS && params.status === "sent") {
    return;
  }
  const message =
    `[queue] dispatch ${params.status} session=${params.sessionId} agent=${params.agent}`
    + ` total=${params.totalMs}ms readiness=${params.readinessMs}ms`
    + ` delivery=${params.deliveryMs}ms`
    + ` messageSync=${params.messageSyncMs}ms`
    + (params.errorStatus ? ` status=${params.errorStatus}` : "");
  if (params.status === "sent") {
    console.info(message);
  } else {
    console.warn(message);
  }
}

export function createPromptDispatchEngine(ctx: PromptDispatchContext): PromptDispatchEngine {
  const queueDispatchInFlight = new Set<string>();
  const queueDispatchCooldowns = new Map<string, number>();
  const promptStartupReadiness = new Set<string>();

  function markPromptStartupReady(sessionId: string): void {
    promptStartupReadiness.add(sessionId);
  }

  function clearPromptStartupReady(sessionId: string): void {
    promptStartupReadiness.delete(sessionId);
  }

  function getQueueDispatchCooldown(sessionId: string): number {
    return queueDispatchCooldowns.get(sessionId) ?? 0;
  }

  function clearQueueDispatchCooldown(sessionId: string): void {
    queueDispatchCooldowns.delete(sessionId);
  }

  function markQueueDispatchCooldown(sessionId: string, retryAfterMs = QUEUE_DISPATCH_RETRY_MS): void {
    queueDispatchCooldowns.set(sessionId, Date.now() + Math.max(retryAfterMs, 250));
  }

  function shouldAutoDispatchSession(session: SessionSnapshot | null): boolean {
    if (!session) return false;
    return session.status === "running";
  }

  function getPromptStartupTimeoutMs(agent: AgentType): number {
    return agent === "codex" ? 120000 : 60000;
  }

  async function waitForMessageUpdate(sessionId: string, initialCount: number, timeoutMs = 20000): Promise<unknown[]> {
    let messages = await ctx.syncSessionMessages(sessionId, true);
    if (messages.length > initialCount) {
      return messages;
    }

    const deadline = Date.now() + Math.max(timeoutMs, 1000);
    while (Date.now() < deadline) {
      await sleep(250);
      messages = await ctx.syncSessionMessages(sessionId, true);
      if (messages.length > initialCount) {
        return messages;
      }
    }
    return messages;
  }

  async function ensureSessionReadyForPromptDispatch(session: SessionSnapshot): Promise<void> {
    const timeoutMs = getPromptStartupTimeoutMs(session.agent);
    await ctx.waitForSessionPromptReadiness({
      getSession: (sessionId) => ctx.manager.getSession(sessionId) ?? null,
      getAdapter: (sessionId) => ctx.manager.getAdapter(sessionId),
      sessionId: session.id,
      host: ctx.agentHost,
      timeoutMs,
      pollIntervalMs: 250,
      requiredStablePolls: session.agent === "codex" ? 3 : 2,
      requestTimeoutMs: 750,
    });
    markPromptStartupReady(session.id);
  }

  async function dispatchNextQueuedPromptForSession(session: SessionSnapshot, userNpub: string | null) {
    const dispatchStartedAt = Date.now();
    let readinessMs = 0;
    let deliveryMs = 0;
    let messageSyncMs = 0;

    if (!userNpub) {
      throw new QueueDispatchError("Sign in to send messages", 403);
    }
    if (ctx.isUserApprovedForWork && !ctx.isUserApprovedForWork(userNpub)) {
      throw new QueueDispatchError("User is not approved to use Wingman", 403, {
        approvalRequired: true,
      });
    }

    try {
      const readinessStartedAt = Date.now();
      await ensureSessionReadyForPromptDispatch(session);
      readinessMs = elapsedSince(readinessStartedAt);
    } catch (error) {
      throw new QueueDispatchError(
        `Session is not ready for prompt dispatch: ${(error as Error).message}`,
        503,
      );
    }

    const nextPrompt = ctx.promptQueueStore.getNextQueuedPrompt(session.id);
    if (!nextPrompt) {
      throw new QueueDispatchError("No prompts in queue", 404);
    }

    try {
      const initialCount = ctx.messageStore.listSessionMessages(session.id).length;
      const deliveryStartedAt = Date.now();
      const result = await deliverSessionAgentMessage({
        agentHost: ctx.agentHost,
        buildAgentUrl: ctx.buildAgentUrl,
        agent: session.agent,
        port: session.port,
        content: nextPrompt.content,
        type: "user",
        pm2Name: session.pm2Name,
        adapter: ctx.manager.getAdapter(session.id),
      });
      deliveryMs = elapsedSince(deliveryStartedAt);

      if (!result.ok) {
        throw new QueueDispatchError(result.message, result.status, {
          failedPrompt: nextPrompt,
        });
      }

      ctx.promptQueueStore.removeNextPrompt(session.id);
      const messageSyncStartedAt = Date.now();
      const messages = await waitForMessageUpdate(session.id, initialCount);
      messageSyncMs = elapsedSince(messageSyncStartedAt);
      clearQueueDispatchCooldown(session.id);
      logQueueDispatchTiming({
        sessionId: session.id,
        agent: session.agent,
        status: "sent",
        totalMs: elapsedSince(dispatchStartedAt),
        readinessMs,
        deliveryMs,
        messageSyncMs,
      });
      return { id: session.id, messages, sentPrompt: nextPrompt };
    } catch (error) {
      if (error instanceof QueueDispatchError) {
        logQueueDispatchTiming({
          sessionId: session.id,
          agent: session.agent,
          status: "failed",
          totalMs: elapsedSince(dispatchStartedAt),
          readinessMs,
          deliveryMs,
          messageSyncMs,
          errorStatus: error.status,
        });
        throw error;
      }
      logQueueDispatchTiming({
        sessionId: session.id,
        agent: session.agent,
        status: "failed",
        totalMs: elapsedSince(dispatchStartedAt),
        readinessMs,
        deliveryMs,
        messageSyncMs,
        errorStatus: 502,
      });
      throw new QueueDispatchError(`Failed to contact agent: ${(error as Error).message}`, 502, {
        failedPrompt: nextPrompt,
      });
    }
  }

  async function maybeAutoDispatchQueuedPrompt(session: SessionSnapshot | null) {
    if (!session) return;
    if (queueDispatchInFlight.has(session.id)) return;
    if (!shouldAutoDispatchSession(session)) return;
    if (ctx.promptQueueStore.getQueueCount(session.id) === 0) {
      void ctx.maybeTriggerNightWatch(session, ctx.nightWatchDeps);
      return;
    }
    const userNpub = resolveSessionChargeNpub(session.metadata, session.npub ?? null);
    if (!userNpub) {
      console.warn(`[queue] cannot auto-dispatch session ${session.id} without owner npub`);
      return;
    }
    const cooldownUntil = getQueueDispatchCooldown(session.id);
    if (cooldownUntil && cooldownUntil > Date.now()) {
      return;
    }

    const readiness = await getSessionPromptReadiness({
      session,
      adapter: ctx.manager.getAdapter(session.id),
      timeoutMs: 750,
    });
    if (readiness.state !== "ready") {
      markQueueDispatchCooldown(session.id, readiness.retryAfterMs);
      console.info(
        `[queue] deferred session=${session.id} readiness=${readiness.state}`
        + ` reason=${readiness.reason} retry=${readiness.retryAfterMs}ms`,
      );
      return;
    }

    queueDispatchInFlight.add(session.id);
    try {
      await dispatchNextQueuedPromptForSession(session, userNpub);
    } catch (error) {
      if (error instanceof QueueDispatchError) {
        if (error.status === 404) {
          clearQueueDispatchCooldown(session.id);
        } else {
          markQueueDispatchCooldown(session.id);
          console.warn(`[queue] auto-dispatch failed for session ${session.id}: ${error.message}`);
        }
      } else {
        markQueueDispatchCooldown(session.id);
        console.error(`[queue] auto-dispatch failed for session ${session.id}:`, error);
      }
    } finally {
      queueDispatchInFlight.delete(session.id);
    }
  }

  function sweepQueuedSessionsForDispatch() {
    for (const session of ctx.manager.listSessions()) {
      void maybeAutoDispatchQueuedPrompt(session);
    }
  }

  // Auto-start sweep on creation
  sweepQueuedSessionsForDispatch();
  setInterval(sweepQueuedSessionsForDispatch, 5000).unref?.();

  return {
    dispatchNextQueuedPromptForSession,
    maybeAutoDispatchQueuedPrompt,
    sweepQueuedSessionsForDispatch,
    markPromptStartupReady,
    clearPromptStartupReady,
    markQueueDispatchCooldown,
    queueDispatchInFlight,
    waitForMessageUpdate,
  };
}
