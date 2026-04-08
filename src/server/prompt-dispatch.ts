/**
 * Prompt queue dispatch engine.
 * Extracted from server.ts to reduce file size.
 */

import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { InsufficientBalanceError } from "../storage/identity-user-store";
import { isCreditsBillingSession, resolveSessionChargeNpub } from "../sessions/session-metadata";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      await sleep(750);
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
      pollIntervalMs: 500,
      requiredStablePolls: session.agent === "codex" ? 3 : 2,
      requestTimeoutMs: 2500,
    });
    markPromptStartupReady(session.id);
  }

  async function dispatchNextQueuedPromptForSession(session: SessionSnapshot, userNpub: string | null) {
    if (!userNpub) {
      throw new QueueDispatchError("Sign in to send messages", 403, { balance: 0 });
    }

    try {
      await ensureSessionReadyForPromptDispatch(session);
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
        currentBalance = ctx.identityUserStore.debit(userNpub, ctx.MESSAGE_COST_SATS);
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
      const agentUrl = ctx.buildAgentUrl(ctx.agentHost, session.port, "/message");
      const agentResponse = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content: nextPrompt.content }),
      });

      if (!agentResponse.ok) {
        const errorPayload = await agentResponse.json().catch(() => ({})) as Record<string, unknown>;
        const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
        refundDebit();
        throw new QueueDispatchError(message, agentResponse.status, {
          balance: currentBalance,
          failedPrompt: nextPrompt,
        });
      }

      ctx.promptQueueStore.removeNextPrompt(session.id);
      const messages = await waitForMessageUpdate(session.id, initialCount);
      clearQueueDispatchCooldown(session.id);
      return { id: session.id, messages, balance: currentBalance, sentPrompt: nextPrompt };
    } catch (error) {
      if (error instanceof QueueDispatchError) {
        throw error;
      }
      refundDebit();
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
