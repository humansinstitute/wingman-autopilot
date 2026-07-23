import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { resolveNativeResumeLaunch } from '../sessions/native-resume-launch';
import type { AgentDefinitionStore } from './agent-definition-store';
import type { ChatInterceptStateStore } from './chat-intercept-state-store';
import {
  buildDirectChatBootstrapPrompt,
  buildDirectChatClientRequestId,
  buildDirectChatFollowUpPrompt,
  buildDirectChatRoutingKey,
  buildDirectChatTurnId,
  channelDirectChatConfig,
  channelLegacyBasePrompt,
  isAgentDirectMessageEligible,
  isImplicitTwoPartyDirectMessage,
  orderDirectChatMessages,
  selectUndeliveredHumanMessages,
} from './direct-chat-contract';
import { directChatTurnStore, type DirectChatTurnStore } from './direct-chat-turn-store';
import { awaitAcceptedFinalResponse, sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';
import { createFlightDeckPgChannelMessage, type FlightDeckPgChannel, type FlightDeckPgEvent, type FlightDeckPgMessage } from './tower-client';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

export interface DirectChatRuntimeInput {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  event: FlightDeckPgEvent;
  channel: FlightDeckPgChannel;
  messages: FlightDeckPgMessage[];
}

interface DirectChatRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  agentStore: AgentDefinitionStore;
  interceptStore: ChatInterceptStateStore;
  turnStore?: DirectChatTurnStore;
  publish?: typeof createFlightDeckPgChannelMessage;
}

function withMvpDirectChatDefault(agent: AgentDefinitionRecord): AgentDefinitionRecord {
  if (agent.directChat) return agent;
  return {
    ...agent,
    directChat: {
      enabled: true,
      sessionAgent: null,
      directory: agent.workingDirectory,
      model: null,
      idleRetentionMinutes: 60,
    },
  };
}

export class AgentDirectChatRuntime {
  private readonly running = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, DirectChatRuntimeInput>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnStore: DirectChatTurnStore;
  private readonly publish: typeof createFlightDeckPgChannelMessage;

  constructor(private readonly deps: DirectChatRuntimeDependencies) {
    this.turnStore = deps.turnStore ?? directChatTurnStore;
    this.publish = deps.publish ?? createFlightDeckPgChannelMessage;
  }

  async handle(input: DirectChatRuntimeInput): Promise<{ handled: boolean; reason: string }> {
    const config = channelDirectChatConfig(input.channel);
    const ordered = orderDirectChatMessages(input.messages);
    const eventMessage = ordered.find((message) => message.messageId === input.event.entity_id) ?? ordered.at(-1);
    const implicitDm = Boolean(eventMessage && isImplicitTwoPartyDirectMessage(
      input.channel,
      input.subscription.botNpub,
      eventMessage.userNpub,
    ));
    if (!config.enabled && !implicitDm) return { handled: false, reason: 'channel_disabled' };
    const contextPrompt = config.contextPrompt || (implicitDm ? channelLegacyBasePrompt(input.channel) : '');
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const agents = this.deps.agentStore.listByWorkspaceAndBot(workspaceIdentity, input.subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes('chat_intercept'))
      .map(withMvpDirectChatDefault)
      .filter((agent) => agent.directChat?.enabled);
    if (agents.length === 0) return { handled: false, reason: 'no_direct_chat_agent' };
    let handled = false;
    for (const agent of agents) {
      if (!eventMessage || eventMessage.userNpub === agent.botNpub || eventMessage.userNpub === input.subscription.wsKeyNpub) continue;
      if (!isAgentDirectMessageEligible(input.channel, eventMessage, agent.botNpub)) continue;
      const threadId = input.messages.find((message) => message.id === eventMessage.messageId)?.thread_id
        ?? input.messages.find((message) => message.id === eventMessage.messageId)?.thread_source_message_id
        ?? eventMessage.messageId;
      const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: input.subscription.towerServiceNpub || input.subscription.backendBaseUrl,
        workspaceId: input.subscription.workspaceId || workspaceIdentity, channelId: input.channel.id, threadId, agentNpub: agent.botNpub });
      const cursor = input.event.cursor ?? (input.event.row_version != null ? String(input.event.row_version) : null);
      const upsert = this.deps.interceptStore.upsertMessage({
        routingKey, subscriptionId: input.subscription.subscriptionId, agentId: agent.agentId,
        workspaceOwnerNpub: workspaceIdentity, sourceAppNpub: input.subscription.sourceAppNpub,
        towerServiceNpub: input.subscription.towerServiceNpub ?? '', workspaceId: input.subscription.workspaceId ?? '',
        channelId: input.channel.id, threadId, botNpub: agent.botNpub, messageId: eventMessage.messageId, eventCursor: cursor,
      });
      if (upsert.wasDuplicate && !this.turnStore.getPending(routingKey)) continue;
      handled = true;
      this.enqueue(routingKey, agent, contextPrompt, input);
    }
    return { handled, reason: handled ? 'direct_chat_queued' : 'not_activated' };
  }

  recover(input: DirectChatRuntimeInput, routingKey: string): { handled: boolean; reason: string } {
    const pending = this.turnStore.getPending(routingKey);
    const intercept = this.deps.interceptStore.getByRoutingKey(routingKey);
    if (!pending || !intercept || (pending.state !== 'accepted' && pending.state !== 'reply_ready')) {
      return { handled: false, reason: 'no_recoverable_turn' };
    }
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const agent = this.deps.agentStore.getByAgentId(intercept.agentId);
    if (!agent || !agent.enabled || agent.botNpub !== intercept.botNpub || agent.workspaceOwnerNpub !== workspaceIdentity) {
      return { handled: false, reason: 'recovery_agent_missing' };
    }
    const resolvedAgent = withMvpDirectChatDefault(agent);
    if (!resolvedAgent.directChat?.enabled) return { handled: false, reason: 'recovery_agent_disabled' };
    const contextPrompt = channelDirectChatConfig(input.channel).contextPrompt || channelLegacyBasePrompt(input.channel);
    this.enqueue(routingKey, resolvedAgent, contextPrompt, input);
    return { handled: true, reason: 'direct_chat_recovery_queued' };
  }

  hasRecoverableTurn(routingKey: string): boolean {
    const pending = this.turnStore.getPending(routingKey);
    return pending?.state === 'accepted' || pending?.state === 'reply_ready';
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private enqueue(routingKey: string, agent: AgentDefinitionRecord, contextPrompt: string, input: DirectChatRuntimeInput): void {
    const idleTimer = this.idleTimers.get(routingKey);
    if (idleTimer) { clearTimeout(idleTimer); this.idleTimers.delete(routingKey); }
    this.queued.set(routingKey, input);
    if (this.running.has(routingKey)) return;
    const work = this.run(routingKey, agent, contextPrompt).finally(() => this.running.delete(routingKey));
    this.running.set(routingKey, work);
    void work.catch(() => undefined);
  }

  private async run(routingKey: string, agent: AgentDefinitionRecord, contextPrompt: string): Promise<void> {
    while (this.queued.has(routingKey)) {
      const input = this.queued.get(routingKey)!;
      this.queued.delete(routingKey);
      let intercept = this.deps.interceptStore.getByRoutingKey(routingKey)!;
      try {
        const pending = this.turnStore.getPending(routingKey);
        if (pending?.replyBody) {
          await this.publishTurn(input, intercept, agent, pending.turnId, pending.sourceMessageIds, pending.clientRequestId, pending.replyBody);
          continue;
        }
        const history = orderDirectChatMessages(input.messages);
        const undelivered = pending?.state === 'accepted'
          ? history.filter((message) => pending.sourceMessageIds.includes(message.messageId))
          : selectUndeliveredHumanMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? '']);
        const delta = pending?.state === 'accepted'
          ? undelivered
          : undelivered.filter((message) => isAgentDirectMessageEligible(input.channel, message, agent.botNpub));
        if (delta.length === 0) continue;
        if (pending?.state === 'accepted') {
          if (!intercept.sessionId) throw new Error('Accepted Agent Direct Chat turn has no bound session.');
          const recoveryPrompt = intercept.lastCompletedTurnId
            ? buildDirectChatFollowUpPrompt(routingKey, intercept.threadId, delta)
            : buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                scopeId: input.channel.scope_id ?? null, history, nextMessages: delta });
          const recovered = await awaitAcceptedFinalResponse(
            this.deps.processManager,
            intercept.sessionId,
            recoveryPrompt,
            pending.sourceMessageIds,
            { acceptedAt: pending.createdAt },
          );
          this.turnStore.save({ ...pending, replyBody: recovered.content, state: 'reply_ready', updatedAt: new Date().toISOString() });
          await this.publishTurn(input, intercept, agent, pending.turnId, pending.sourceMessageIds,
            pending.clientRequestId, recovered.content);
          continue;
        }
        const sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null);
        const session = sessionResolution.session;
        intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
          sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
          state: 'active', pendingMessageCount: delta.length, lastDecision: 'pending', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const prompt = sessionResolution.bootstrap
          ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
              scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery })
          : buildDirectChatFollowUpPrompt(routingKey, intercept.threadId, delta);
        const sourceMessageIds = delta.map((message) => message.messageId);
        const turnId = pending?.turnId ?? buildDirectChatTurnId(routingKey, sourceMessageIds);
        const clientRequestId = pending?.clientRequestId ?? buildDirectChatClientRequestId(routingKey, turnId);
        const now = pending?.createdAt ?? new Date().toISOString();
        const reply = await sendPromptAndAwaitFinalResponse(this.deps.processManager, session.id, prompt, {
          onAccepted: () => {
            this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: null,
              publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: new Date().toISOString() });
            intercept = this.deps.interceptStore.save({ ...intercept,
              lastHumanMessageIdDelivered: sourceMessageIds.at(-1) ?? null, pendingMessageCount: 0,
              updatedAt: new Date().toISOString() });
          },
        });
        const body = reply.content;
        this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: body,
          publishedMessageId: null, state: 'reply_ready', createdAt: now, updatedAt: new Date().toISOString() });
        await this.publishTurn(input, intercept, agent, turnId, sourceMessageIds, clientRequestId, body);
      } catch (error) {
        const status = Number((error as { status?: unknown })?.status ?? 0);
        this.deps.interceptStore.save({ ...intercept, state: status === 401 || status === 403 ? 'blocked_auth' : 'pending',
          lastDecision: 'failed', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
    }
  }

  private async publishTurn(input: DirectChatRuntimeInput, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, agent: AgentDefinitionRecord, turnId: string, sourceMessageIds: string[], clientRequestId: string, body: string): Promise<void> {
    const result = await this.publish({ backendBaseUrl: input.subscription.backendBaseUrl,
      workspaceId: input.subscription.workspaceId!, channelId: intercept.channelId, appNpub: input.subscription.sourceAppNpub,
      botIdentity: input.botIdentity, body, threadId: intercept.threadId, clientRequestId,
      metadata: { source: 'autopilot_session', session_id: intercept.sessionId, turn_id: turnId,
        source_message_ids: sourceMessageIds, agent_npub: intercept.botNpub } });
    const messageId = result.message?.id ?? null;
    const now = new Date().toISOString();
    this.turnStore.save({ turnId, routingKey: intercept.routingKey, sourceMessageIds, clientRequestId, replyBody: body,
      publishedMessageId: messageId, state: 'completed', createdAt: now, updatedAt: now });
    this.deps.interceptStore.save({ ...intercept, lastAgentMessageIdPublished: messageId,
      lastCompletedTurnId: turnId, state: 'idle', lastDecision: 'respond', pendingMessageCount: 0,
      lastActivityAt: now, updatedAt: now });
    this.scheduleIdleStop(intercept.routingKey, agent.directChat?.idleRetentionMinutes ?? 60);
  }

  private scheduleIdleStop(routingKey: string, minutes: number): void {
    const timer = setTimeout(async () => {
      this.idleTimers.delete(routingKey);
      const intercept = this.deps.interceptStore.getByRoutingKey(routingKey);
      if (!intercept?.sessionId || intercept.state !== 'idle') return;
      await this.deps.processManager.stopSession(intercept.sessionId).catch(() => null);
      this.deps.interceptStore.save({ ...intercept, state: 'archived', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }, Math.max(1, minutes) * 60_000);
    timer.unref?.();
    this.idleTimers.set(routingKey, timer);
  }

  private async resolveSession(agent: AgentDefinitionRecord, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, subscription: WorkspaceSubscriptionRecord, scopeId: string | null): Promise<{
    session: SessionSnapshot; bootstrap: boolean; generation: number; previousSessionIds: string[]; recovery: { previousSessionId: string; reason: string } | null;
  }> {
    const current = intercept.sessionId ? this.deps.processManager.getSession(intercept.sessionId) : null;
    if (current?.status === 'running' || current?.status === 'starting') return { session: current, bootstrap: false, generation: intercept.sessionGeneration ?? 1, previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
    if (current) {
      try {
        const launch = resolveNativeResumeLaunch(current, isAgentType, subscription.managedByNpub);
        const resumed = await this.deps.processManager.createSession(launch.agent, launch.workingDirectory, launch.name, launch.origin, undefined, launch.ownerNpub, launch.metadata, current.model);
        return { session: resumed, bootstrap: false, generation: intercept.sessionGeneration ?? 1, previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
      } catch {}
    }
    const previous = intercept.sessionId;
    const generation = previous ? (intercept.sessionGeneration ?? 1) + 1 : 1;
    const previousSessionIds = previous ? [...new Set([...(intercept.previousSessionIds ?? []), previous])] : intercept.previousSessionIds ?? [];
    const profile = agent.directChat!;
    const sessionAgent = profile.sessionAgent && isAgentType(profile.sessionAgent) ? profile.sessionAgent : this.deps.defaultAgent;
    const session = await this.deps.processManager.createSession(sessionAgent, profile.directory, `${agent.label} Direct Chat`,
      { type: 'agent-chat', id: intercept.routingKey, label: `${agent.label} Flight Deck chat` }, undefined,
      subscription.managedByNpub ?? undefined, { AGENT: true, sessionClass: 'flightdeck_chat',
        flightdeckTowerServiceNpub: intercept.towerServiceNpub, flightdeckWorkspaceId: intercept.workspaceId,
        flightdeckScopeId: scopeId ?? undefined, flightdeckChannelId: intercept.channelId, flightdeckThreadId: intercept.threadId,
        flightdeckAgentNpub: intercept.botNpub, flightdeckRoutingKey: intercept.routingKey, sessionGeneration: generation }, profile.model ?? undefined);
    return { session, bootstrap: true, generation, previousSessionIds,
      recovery: previous ? { previousSessionId: previous, reason: current ? 'native resume unavailable' : 'session missing' } : null };
  }
}
