import type { AgentType } from '../config';
import type { ProcessManager, SessionOrigin, SessionSnapshot } from '../agents/process-manager';
import { scheduleSessionArchive } from '../storage/session-archiver';
import { chatInterceptStateStore, type ChatInterceptStateStore } from './chat-intercept-state-store';
import type { ChatInterceptStateRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';
import {
  buildAgentChatYokeCommands,
  handoffAgentChatReply,
  prepareAgentChatYokeRuntime,
  type AgentChatYokeContext,
} from './yoke-runtime';

const DEFAULT_IDLE_RETENTION_MINUTES = 60;
const SESSION_READY_TIMEOUT_MS = 120_000;
const ASSISTANT_REPLY_TIMEOUT_MS = 300_000;
const ASSISTANT_REPLY_POLL_INTERVAL_MS = 1_000;
const ASSISTANT_REPLY_STABLE_POLLS = 2;

interface AgentChatSessionRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  interceptStore?: ChatInterceptStateStore;
  idleRetentionMinutes?: number;
}

export interface AgentChatSessionRuntimeInput {
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  botIdentity: RuntimeBotIdentity;
  chatMessage: Record<string, unknown>;
}

interface AssistantReplyResult {
  content: string;
  createdAt: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getMessageBody(chatMessage: Record<string, unknown>): string {
  const body = typeof chatMessage.body === 'string' ? chatMessage.body.trim() : '';
  return body;
}

function getSenderNpub(chatMessage: Record<string, unknown>): string | null {
  const sender = typeof chatMessage.sender_npub === 'string' ? chatMessage.sender_npub.trim() : '';
  return sender || null;
}

function truncateText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatRecentTurns(context: AgentChatYokeContext | null, fallbackBody: string, fallbackSender: string | null): string {
  const recentMessages = context?.recent_messages ?? [];
  if (recentMessages.length > 0) {
    return recentMessages
      .map((message, index) => {
        const sender = message.sender_npub ?? 'unknown';
        return `${index + 1}. ${sender}: ${truncateText(message.body, 240) || '[empty]'}`;
      })
      .join('\n');
  }

  const sender = fallbackSender ?? 'unknown';
  const body = truncateText(fallbackBody, 240) || '[empty]';
  return `1. ${sender}: ${body}`;
}

function formatParticipants(context: AgentChatYokeContext | null, fallbackParticipants: string[]): string {
  const participants = context?.participants?.length ? context.participants : fallbackParticipants;
  return participants.filter((value) => value.length > 0).join(', ') || 'unknown';
}

function buildBootstrapPrompt(params: {
  isNewSession: boolean;
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  session: SessionSnapshot;
  yokeStateDir: string;
  context: AgentChatYokeContext | null;
  contextError: string | null;
  chatMessage: Record<string, unknown>;
}): string {
  const latestBody = getMessageBody(params.chatMessage);
  const latestSender = getSenderNpub(params.chatMessage);
  const fallbackParticipants = [params.subscription.botNpub, latestSender ?? ''].filter((value) => value.length > 0);
  const commands = buildAgentChatYokeCommands(
    params.yokeStateDir,
    params.intercept.channelId,
    params.intercept.threadId,
  );
  const recentTurns = formatRecentTurns(params.context, latestBody, latestSender);
  const participants = formatParticipants(params.context, fallbackParticipants);
  const bootstrapMode = params.isNewSession ? 'new_session' : 'reused_session';

  return [
    `Agent Chat runtime event: ${bootstrapMode}.`,
    '',
    'Thread package:',
    `- workspace_owner_npub: ${params.subscription.workspaceOwnerNpub}`,
    `- channel_id: ${params.intercept.channelId}`,
    `- thread_id: ${params.intercept.threadId}`,
    `- target_bot_npub: ${params.subscription.botNpub}`,
    `- managed_by_npub: ${params.subscription.managedByNpub ?? 'unknown'}`,
    `- session_id: ${params.session.id}`,
    `- recent_turn_count: ${params.context?.recent_messages?.length ?? 1}`,
    `- participants: ${participants}`,
    '',
    'Recent turns:',
    recentTurns,
    '',
    'Yoke runtime commands:',
    `- Prime current context: ${commands.context}`,
    `- More thread history: ${commands.history}`,
    `- Search active channel: ${commands.search}`,
    `- Related threads: ${commands.related}`,
    `- Reply handoff used by Wingmen after your answer: ${commands.replyCurrent}`,
    '',
    params.contextError
      ? `Yoke context warning: ${params.contextError}`
      : 'Yoke context is ready in the session state dir shown above.',
    '',
    'Instructions:',
    '- You are replying as the target bot for the current thread only.',
    '- Use the Yoke commands above if you need more context before answering.',
    '- Produce one assistant reply for the current thread.',
    '- Do not tell the human to run commands.',
    '- Do not include tool transcripts in your final answer.',
    '- Wingmen will relay your final assistant reply back into the thread.',
  ].join('\n');
}

export class AgentChatSessionRuntime {
  private readonly defaultAgent: AgentType;
  private readonly manager: ProcessManager;
  private readonly interceptStore: ChatInterceptStateStore;
  private readonly idleRetentionMs: number;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly routingQueues = new Map<string, Promise<void>>();

  constructor(deps: AgentChatSessionRuntimeDependencies) {
    this.defaultAgent = deps.defaultAgent;
    this.manager = deps.processManager;
    this.interceptStore = deps.interceptStore ?? chatInterceptStateStore;
    this.idleRetentionMs = Math.max(
      1,
      deps.idleRetentionMinutes ?? DEFAULT_IDLE_RETENTION_MINUTES,
    ) * 60_000;
    this.restoreIdleTimers();
  }

  async handleRoutedChat(input: AgentChatSessionRuntimeInput): Promise<void> {
    const routingKey = input.intercept.routingKey;
    const existing = this.routingQueues.get(routingKey) ?? Promise.resolve();
    const next = existing
      .catch(() => undefined)
      .then(async () => {
        await this.processRoutedChat(input);
      });
    this.routingQueues.set(routingKey, next);
    try {
      await next;
    } finally {
      if (this.routingQueues.get(routingKey) === next) {
        this.routingQueues.delete(routingKey);
      }
    }
  }

  private async processRoutedChat(input: AgentChatSessionRuntimeInput): Promise<void> {
    let intercept = this.interceptStore.getByRoutingKey(input.intercept.routingKey) ?? input.intercept;
    intercept = await this.archiveExpiredSessionIfNeeded(intercept);
    if (intercept.pendingMessageCount < 1 && intercept.state !== 'pending') {
      return;
    }

    let session: SessionSnapshot | null = null;
    let isNewSession = false;
    try {
      const reusable = this.resolveReusableSession(intercept);
      if (reusable) {
        session = reusable;
      } else {
        session = await this.createAgentChatSession(intercept, input.subscription);
        isNewSession = true;
      }
    } catch (error) {
      this.saveIntercept(intercept, {
        state: 'pending',
        sessionId: null,
        lastActivityAt: new Date().toISOString(),
      });
      throw error;
    }

    intercept = this.saveIntercept(intercept, {
      sessionId: session.id,
      state: 'active',
      pendingMessageCount: 0,
      lastActivityAt: new Date().toISOString(),
    });
    this.clearIdleTimer(intercept.routingKey);

    const yokeRuntime = await prepareAgentChatYokeRuntime({
      sessionId: session.id,
      workingDirectory: session.workingDirectory,
      subscription: input.subscription,
      botIdentity: input.botIdentity,
      channelId: intercept.channelId,
      threadId: intercept.threadId,
    });

    await this.logSession(
      session.id,
      `[agent-chat] ${isNewSession ? 'created' : 'reused'} routing_key=${intercept.routingKey} channel=${intercept.channelId} thread=${intercept.threadId}`,
    );
    if (yokeRuntime.contextError) {
      await this.logSession(session.id, `[agent-chat] yoke context warning: ${yokeRuntime.contextError}`);
    }

    try {
      const prompt = buildBootstrapPrompt({
        isNewSession,
        subscription: input.subscription,
        intercept,
        session,
        yokeStateDir: yokeRuntime.stateDir,
        context: yokeRuntime.context,
        contextError: yokeRuntime.contextError,
        chatMessage: input.chatMessage,
      });
      const reply = await this.sendPromptAndAwaitAssistantReply(session.id, prompt);
      const handoff = await handoffAgentChatReply({
        workingDirectory: session.workingDirectory,
        stateDir: yokeRuntime.stateDir,
        botIdentity: input.botIdentity,
        channelId: intercept.channelId,
        threadId: intercept.threadId,
        body: reply.content,
      });
      await this.logSession(
        session.id,
        `[agent-chat] reply-current status=${handoff.status} message_id=${handoff.message_id}`,
      );
    } catch (error) {
      await this.logSession(
        session.id,
        `[agent-chat] turn failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
      );
    }

    intercept = this.saveIntercept(intercept, {
      sessionId: session.id,
      state: 'idle',
      lastActivityAt: new Date().toISOString(),
    });
    this.scheduleIdleTimer(intercept);
  }

  private resolveReusableSession(intercept: ChatInterceptStateRecord): SessionSnapshot | null {
    if (!intercept.sessionId) {
      return null;
    }
    const session = this.manager.getSession(intercept.sessionId);
    if (!session) {
      return null;
    }
    if (session.status !== 'running' && session.status !== 'starting') {
      return null;
    }
    if (this.hasExpiredRetention(intercept)) {
      return null;
    }
    return session;
  }

  private async createAgentChatSession(
    intercept: ChatInterceptStateRecord,
    subscription: WorkspaceSubscriptionRecord,
  ): Promise<SessionSnapshot> {
    const sessionName = `Agent Chat ${truncateText(intercept.threadId, 24)}`;
    const origin: SessionOrigin = {
      type: 'agent-chat',
      id: intercept.routingKey,
      label: `Agent Chat ${truncateText(intercept.channelId, 12)}:${truncateText(intercept.threadId, 12)}`,
    };
    return await this.manager.createSession(
      this.defaultAgent,
      undefined,
      sessionName,
      origin,
      undefined,
      subscription.managedByNpub ?? undefined,
      {
        AGENT: true,
        role: 'agent-chat',
        routedBy: 'agent-chat',
        createdByNpub: subscription.managedByNpub ?? undefined,
        lastManagedByNpub: subscription.managedByNpub ?? undefined,
        chargeToNpub: subscription.managedByNpub ?? undefined,
      },
    );
  }

  private async sendPromptAndAwaitAssistantReply(sessionId: string, prompt: string): Promise<AssistantReplyResult> {
    const adapter = this.manager.getAdapter(sessionId);
    if (!adapter) {
      throw new Error(`No adapter available for session ${sessionId}.`);
    }
    await adapter.waitForReady({
      timeoutMs: SESSION_READY_TIMEOUT_MS,
      pollIntervalMs: 500,
    });
    const initialMessages = await adapter.fetchMessages().catch(() => []);
    await adapter.sendMessage(prompt, 'user');
    return await this.awaitAssistantReply(sessionId, initialMessages.length);
  }

  private async awaitAssistantReply(sessionId: string, initialMessageCount: number): Promise<AssistantReplyResult> {
    const deadline = Date.now() + ASSISTANT_REPLY_TIMEOUT_MS;
    let lastSeenContent = '';
    let stablePolls = 0;

    while (Date.now() < deadline) {
      await sleep(ASSISTANT_REPLY_POLL_INTERVAL_MS);

      const session = this.manager.getSession(sessionId);
      if (!session || (session.status !== 'running' && session.status !== 'starting')) {
        throw new Error(`Session ${sessionId} stopped before producing a reply.`);
      }

      const adapter = this.manager.getAdapter(sessionId);
      if (!adapter) {
        throw new Error(`Session ${sessionId} no longer has an adapter.`);
      }

      let messages: Array<{ role: string; content: string; createdAt: string }>;
      try {
        messages = await adapter.fetchMessages();
      } catch {
        continue;
      }

      const newAssistantMessage = messages
        .slice(initialMessageCount)
        .filter((message) => message.role === 'assistant' && message.content.trim().length > 0)
        .at(-1);

      if (!newAssistantMessage) {
        continue;
      }

      const readyForHandoff = session.agentRuntimeStatus === 'stable' || session.agentRuntimeStatus == null;
      if (newAssistantMessage.content === lastSeenContent && readyForHandoff) {
        stablePolls += 1;
      } else {
        lastSeenContent = newAssistantMessage.content;
        stablePolls = readyForHandoff ? 1 : 0;
      }

      if (stablePolls >= ASSISTANT_REPLY_STABLE_POLLS) {
        return {
          content: newAssistantMessage.content.trim(),
          createdAt: newAssistantMessage.createdAt,
        };
      }
    }

    throw new Error(`Timed out waiting for an assistant reply from session ${sessionId}.`);
  }

  private restoreIdleTimers(): void {
    for (const intercept of this.interceptStore.listAll()) {
      if (intercept.state !== 'idle' || !intercept.sessionId) {
        continue;
      }
      if (this.hasExpiredRetention(intercept)) {
        void this.archiveChatSession(intercept, 'retention-expired-startup');
        continue;
      }
      this.scheduleIdleTimer(intercept);
    }
  }

  private async archiveExpiredSessionIfNeeded(intercept: ChatInterceptStateRecord): Promise<ChatInterceptStateRecord> {
    if (intercept.state !== 'idle' || !intercept.sessionId) {
      return intercept;
    }
    if (!this.hasExpiredRetention(intercept)) {
      return intercept;
    }
    return await this.archiveChatSession(intercept, 'retention-expired');
  }

  private hasExpiredRetention(intercept: ChatInterceptStateRecord): boolean {
    const lastActivityAt = Date.parse(intercept.lastActivityAt);
    if (!Number.isFinite(lastActivityAt)) {
      return false;
    }
    return Date.now() - lastActivityAt >= this.idleRetentionMs;
  }

  private scheduleIdleTimer(intercept: ChatInterceptStateRecord): void {
    if (!intercept.sessionId) {
      return;
    }
    this.clearIdleTimer(intercept.routingKey);
    const lastActivityAt = Date.parse(intercept.lastActivityAt);
    const elapsed = Number.isFinite(lastActivityAt) ? Date.now() - lastActivityAt : 0;
    const delayMs = Math.max(1_000, this.idleRetentionMs - elapsed);
    const timer = setTimeout(() => {
      this.idleTimers.delete(intercept.routingKey);
      const latest = this.interceptStore.getByRoutingKey(intercept.routingKey);
      if (!latest || latest.state !== 'idle' || !latest.sessionId) {
        return;
      }
      void this.archiveChatSession(latest, 'retention-expired');
    }, delayMs);
    timer.unref?.();
    this.idleTimers.set(intercept.routingKey, timer);
  }

  private clearIdleTimer(routingKey: string): void {
    const timer = this.idleTimers.get(routingKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.idleTimers.delete(routingKey);
  }

  private async archiveChatSession(
    intercept: ChatInterceptStateRecord,
    reason: string,
  ): Promise<ChatInterceptStateRecord> {
    this.clearIdleTimer(intercept.routingKey);
    if (intercept.sessionId) {
      try {
        const stopped = await this.manager.stopSession(intercept.sessionId);
        if (stopped) {
          scheduleSessionArchive(intercept.sessionId, this.manager);
          await this.logSession(stopped.id, `[agent-chat] session archived (${reason})`);
        } else if (!this.manager.getSession(intercept.sessionId)) {
          scheduleSessionArchive(intercept.sessionId, this.manager);
        }
      } catch (error) {
        await this.logSession(
          intercept.sessionId,
          `[agent-chat] archive stop failed (${reason}): ${error instanceof Error ? error.message : 'Unknown error.'}`,
        );
      }
    }
    return this.saveIntercept(intercept, {
      sessionId: null,
      state: 'archived',
      pendingMessageCount: 0,
      lastActivityAt: new Date().toISOString(),
    });
  }

  private saveIntercept(
    intercept: ChatInterceptStateRecord,
    patch: Partial<ChatInterceptStateRecord>,
  ): ChatInterceptStateRecord {
    const latest = this.interceptStore.getByRoutingKey(intercept.routingKey) ?? intercept;
    return this.interceptStore.save({
      ...latest,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  private async logSession(sessionId: string, entry: string): Promise<void> {
    this.manager.appendSessionLog(sessionId, entry);
  }
}
