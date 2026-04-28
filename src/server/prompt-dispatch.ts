/**
 * Prompt queue dispatch engine.
 * Extracted from server.ts to reduce file size.
 */

import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { InsufficientBalanceError } from "../storage/identity-user-store";
import { isCreditsBillingSession, resolveSessionChargeNpub } from "../sessions/session-metadata";
import { deliverSessionAgentMessage } from "./session-agent-message";

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
  identityUserStore: {
    debit: (npub: string, amount: number) => number;
    credit: (npub: string, amount: number) => number;
  };
  promptQueueStore: {
    getNextQueuedPrompt: (sessionId: string) => { content: string } | null;
    removeNextPrompt: (sessionId: string) => void;
    getQueueCount: (sessionId: string) => number;
  };
  MESSAGE_COST_SATS: number;
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
    balance: number | null;
    sentPrompt: { content: string };
  }>;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => Promise<void>;
  sweepQueuedSessionsForDispatch: () => void;
  markPromptStartupReady: (sessionId: string) => void;
  clearPromptStartupReady: (sessionId: string) => void;
  markQueueDispatchCooldown: (sessionId: string) => void;
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
  billingMs: number;
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
    + ` billing=${params.billingMs}ms delivery=${params.deliveryMs}ms`
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

  function markQueueDispatchCooldown(sessionId: string): void {
    queueDispatchCooldowns.set(sessionId, Date.now() + QUEUE_DISPATCH_RETRY_MS);
  }

  function shouldAutoDispatchSession(session: SessionSnapshot | null): boolean {
    if (!session) return false;
    if (session.status !== "running") return false;
    return session.agentRuntimeStatus === "stable";
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
    if (promptStartupReadiness.has(session.id)) {
      return;
    }

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
    let billingMs = 0;
    let deliveryMs = 0;
    let messageSyncMs = 0;

    if (!userNpub) {
      throw new QueueDispatchError("Sign in to send messages", 403, { balance: 0 });
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

    const creditsBilling = isCreditsBillingSession(session.metadata);
    let currentBalance: number | null = null;
    let debitApplied = false;
    const refundDebit = () => {
      if (!debitApplied) return;
      try {
        currentBalance = ctx.identityUserStore.credit(userNpub, ctx.MESSAGE_COST_SATS);
      } catch (creditError) {
        console.error("[billing] failed to refund queued prompt debit:", creditError);
      } finally {
        debitApplied = false;
      }
    };

    if (!creditsBilling) {
      try {
        const billingStartedAt = Date.now();
        currentBalance = ctx.identityUserStore.debit(userNpub, ctx.MESSAGE_COST_SATS);
        billingMs = elapsedSince(billingStartedAt);
        debitApplied = true;
      } catch (error) {
        if (error instanceof InsufficientBalanceError) {
          throw new QueueDispatchError("Insufficient balance", 402, {
            balance: error.balance,
            required: ctx.MESSAGE_COST_SATS,
          });
        }
        console.error("[billing] failed to debit message cost:", error);
        throw new QueueDispatchError("Failed to debit balance", 500);
      }
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
        refundDebit();
        throw new QueueDispatchError(result.message, result.status, {
          balance: currentBalance,
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
        billingMs,
        deliveryMs,
        messageSyncMs,
      });
      return { id: session.id, messages, balance: currentBalance, sentPrompt: nextPrompt };
    } catch (error) {
      if (error instanceof QueueDispatchError) {
        logQueueDispatchTiming({
          sessionId: session.id,
          agent: session.agent,
          status: "failed",
          totalMs: elapsedSince(dispatchStartedAt),
          readinessMs,
          billingMs,
          deliveryMs,
          messageSyncMs,
          errorStatus: error.status,
        });
        throw error;
      }
      refundDebit();
      logQueueDispatchTiming({
        sessionId: session.id,
        agent: session.agent,
        status: "failed",
        totalMs: elapsedSince(dispatchStartedAt),
        readinessMs,
        billingMs,
        deliveryMs,
        messageSyncMs,
        errorStatus: 502,
      });
      throw new QueueDispatchError(`Failed to contact agent: ${(error as Error).message}`, 502, {
        balance: currentBalance,
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
