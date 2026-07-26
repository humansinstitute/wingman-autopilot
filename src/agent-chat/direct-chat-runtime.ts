import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import type { ArchivedSession } from '../storage/session-archive-store';
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
import { AgentActivityPublisher, type AgentActivityContext } from './agent-activity-publisher';
import { awaitAcceptedFinalResponse, PromptBoundaryNotObservedError, sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';
import { createFlightDeckPgChannelMessage, type FlightDeckPgChannel, type FlightDeckPgEvent, type FlightDeckPgMessage } from './tower-client';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';
import type { FlightDeckSessionTurnBridge } from './flightdeck-session-turn-bridge';

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
  createActivityPublisher?: (context: AgentActivityContext) => AgentActivityPublisher;
  getArchivedSession?: (sessionId: string) => ArchivedSession | null;
  log?: Pick<Console, 'error' | 'warn'>;
  turnBridge?: FlightDeckSessionTurnBridge;
  sendFinalResponse?: typeof sendPromptAndAwaitFinalResponse;
}

interface MessageRevisionDispatch {
  revision: number;
  newlyAddedAgentNpubs: Set<string>;
}

function messageRevisionDispatch(event: FlightDeckPgEvent): MessageRevisionDispatch | null {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  if (event.event_type !== 'flightdeck_pg.message.revised' && payload.event_type !== 'message.revised') return null;
  const revision = Number(payload.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const messageId = typeof event.entity_id === 'string' ? event.entity_id : null;
  const revisionKey = typeof payload.revision_idempotency_key === 'string' ? payload.revision_idempotency_key : null;
  if (!messageId
    || payload.message_id !== messageId
    || (event.entity_row_version != null && event.entity_row_version !== revision)
    || revisionKey !== `message:${messageId}:revision:${revision}`) return null;
  const mentions = Array.isArray(payload.newly_added_mentions) ? payload.newly_added_mentions : [];
  return {
    revision,
    newlyAddedAgentNpubs: new Set(mentions.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const mention = entry as Record<string, unknown>;
      return mention.type === 'agent' && typeof mention.npub === 'string' ? [mention.npub] : [];
    })),
  };
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
  private readonly createActivityPublisher: (context: AgentActivityContext) => AgentActivityPublisher;
  private readonly log: Pick<Console, 'error' | 'warn'>;
  private readonly sendFinalResponse: typeof sendPromptAndAwaitFinalResponse;

  constructor(private readonly deps: DirectChatRuntimeDependencies) {
    this.turnStore = deps.turnStore ?? directChatTurnStore;
    this.publish = deps.publish ?? createFlightDeckPgChannelMessage;
    this.createActivityPublisher = deps.createActivityPublisher ?? ((context) => new AgentActivityPublisher(context));
    this.log = deps.log ?? console;
    this.sendFinalResponse = deps.sendFinalResponse ?? sendPromptAndAwaitFinalResponse;
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
    const revisionDispatch = messageRevisionDispatch(input.event);
    const isRevisionEvent = input.event.event_type === 'flightdeck_pg.message.revised'
      || input.event.payload?.event_type === 'message.revised';
    if (isRevisionEvent && !revisionDispatch) {
      return { handled: false, reason: 'invalid_message_revision_event' };
    }
    if (revisionDispatch?.newlyAddedAgentNpubs.size === 0) {
      return { handled: false, reason: 'no_new_agent_mentions' };
    }
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const agents = this.deps.agentStore.listByWorkspaceAndBot(workspaceIdentity, input.subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes('chat_intercept'))
      .map(withMvpDirectChatDefault)
      .filter((agent) => agent.directChat?.enabled);
    if (agents.length === 0) return { handled: false, reason: 'no_direct_chat_agent' };
    let handled = false;
    for (const agent of agents) {
      if (!eventMessage || eventMessage.userNpub === agent.botNpub || eventMessage.userNpub === input.subscription.wsKeyNpub) continue;
      if (revisionDispatch
        ? !revisionDispatch.newlyAddedAgentNpubs.has(agent.botNpub)
        : !isAgentDirectMessageEligible(input.channel, eventMessage, agent.botNpub)) continue;
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
        channelId: input.channel.id, threadId, botNpub: agent.botNpub, messageId: eventMessage.messageId,
        messageRevision: revisionDispatch?.revision ?? null, eventCursor: cursor,
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
    const hasRecoverableTurn = pending?.state === 'accepted' || pending?.state === 'reply_ready';
    const hasPendingMessages = Boolean(intercept?.lastMessageIdSeen
      && intercept.pendingMessageCount > 0
      && (intercept.state === 'pending' || intercept.state === 'active' || intercept.state === 'archived'));
    if (!intercept || (!hasRecoverableTurn && !hasPendingMessages)) {
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
    return { handled: true, reason: hasRecoverableTurn ? 'direct_chat_recovery_queued' : 'direct_chat_pending_replay_queued' };
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
    void work.catch((error) => {
      this.log.error('[agent-chat] direct chat queue failed', {
        routingKey,
        sessionId: this.deps.interceptStore.getByRoutingKey(routingKey)?.sessionId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async run(routingKey: string, agent: AgentDefinitionRecord, contextPrompt: string): Promise<void> {
    while (this.queued.has(routingKey)) {
      const input = this.queued.get(routingKey)!;
      this.queued.delete(routingKey);
      let intercept = this.deps.interceptStore.getByRoutingKey(routingKey)!;
      let activity: AgentActivityPublisher | null = null;
      try {
        const pending = this.turnStore.getPending(routingKey);
        if (pending?.replyBody) {
          await this.publishTurn(input, intercept, agent, pending.turnId, pending.sourceMessageIds, pending.clientRequestId, pending.replyBody);
          continue;
        }
        const history = orderDirectChatMessages(input.messages);
        const undelivered = pending?.state === 'accepted'
          ? history.filter((message) => pending.sourceMessageIds.includes(message.messageId)
              || selectUndeliveredHumanMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? ''])
                .some((undeliveredMessage) => undeliveredMessage.messageId === message.messageId))
          : selectUndeliveredHumanMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? '']);
        const revisionDispatch = messageRevisionDispatch(input.event);
        const delta = pending?.state === 'accepted'
          ? undelivered
          : revisionDispatch
            ? history.filter((message) => message.messageId === input.event.entity_id)
          : undelivered.filter((message) => isAgentDirectMessageEligible(input.channel, message, agent.botNpub));
        if (delta.length === 0) continue;
        if (pending?.state === 'accepted') {
          if (!intercept.sessionId) throw new Error('Accepted Agent Direct Chat turn has no bound session.');
          const recoverySourceMessageIds = delta.map((message) => message.messageId);
          const recoverableTurn = this.turnStore.save({ ...pending, sourceMessageIds: recoverySourceMessageIds,
            updatedAt: new Date().toISOString() });
          intercept = this.deps.interceptStore.save({ ...intercept,
            lastHumanMessageIdDelivered: recoverySourceMessageIds.at(-1) ?? intercept.lastHumanMessageIdDelivered,
            pendingMessageCount: 0, updatedAt: new Date().toISOString() });
          const sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null);
          const session = sessionResolution.session;
          intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
            sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
            state: 'active', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          activity = this.createActivityPublisher({
            backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
            appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
            channelId: intercept.channelId, threadId: intercept.threadId,
            triggerMessageId: recoverySourceMessageIds.at(-1)!, sessionId: session.id,
            agentNpub: intercept.botNpub, turnId: pending.turnId,
          });
          const recoveryPrompt = sessionResolution.bootstrap
            ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery })
            : intercept.lastCompletedTurnId
              ? buildDirectChatFollowUpPrompt({ routingKey, threadId: intercept.threadId, history, actionableMessages: delta })
              : buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                  scopeId: input.channel.scope_id ?? null, history, nextMessages: delta });
          const recovered = sessionResolution.bootstrap
            ? await this.sendFinalResponse(this.deps.processManager, session.id, recoveryPrompt, {
                onPoll: () => activity?.publishLatestCommentary(this.deps.processManager),
              })
            : await awaitAcceptedFinalResponse(
                this.deps.processManager,
                session.id,
                recoveryPrompt,
                recoverySourceMessageIds,
                { acceptedAt: pending.createdAt, onPoll: () => activity?.publishLatestCommentary(this.deps.processManager) },
              );
          this.turnStore.save({ ...recoverableTurn, replyBody: recovered.content, state: 'reply_ready', updatedAt: new Date().toISOString() });
          await this.publishTurn(input, intercept, agent, pending.turnId, recoverySourceMessageIds,
            pending.clientRequestId, recovered.content);
          await activity.publish('completed');
          continue;
        }
        let sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null);
        let session = sessionResolution.session;
        intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
          sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
          state: 'active', pendingMessageCount: delta.length, lastDecision: 'pending', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        let prompt = sessionResolution.bootstrap
          ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
              scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery })
          : buildDirectChatFollowUpPrompt({ routingKey, threadId: intercept.threadId, history, actionableMessages: delta });
        const sourceMessageIds = delta.map((message) => message.messageId);
        const revisionKeys = revisionDispatch
          ? sourceMessageIds.map((messageId) => `${messageId}:revision:${revisionDispatch.revision}`)
          : sourceMessageIds;
        const turnId = pending?.turnId ?? buildDirectChatTurnId(routingKey, revisionKeys);
        const clientRequestId = pending?.clientRequestId ?? buildDirectChatClientRequestId(routingKey, turnId);
        const now = pending?.createdAt ?? new Date().toISOString();
        activity = this.createActivityPublisher({
          backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
          appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
          channelId: intercept.channelId, threadId: intercept.threadId,
          triggerMessageId: sourceMessageIds.at(-1)!, sessionId: session.id,
          agentNpub: intercept.botNpub, turnId,
        });
        const onAccepted = () => {
            this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: null,
              publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: new Date().toISOString() });
            intercept = this.deps.interceptStore.save({ ...intercept,
              lastHumanMessageIdDelivered: sourceMessageIds.at(-1) ?? null, pendingMessageCount: 0,
              updatedAt: new Date().toISOString() });
            void activity?.publish('accepted');
          };
        let reply;
        try {
          reply = await this.sendFinalResponse(this.deps.processManager, session.id, prompt, {
            onAccepted, onPoll: () => activity?.publishLatestCommentary(this.deps.processManager),
          });
        } catch (error) {
          if (!(error instanceof PromptBoundaryNotObservedError) || sessionResolution.bootstrap) throw error;
          const rejectedSessionId = session.id;
          await this.deps.processManager.stopSession(rejectedSessionId).catch((stopError) => {
            this.log.warn('[agent-chat] failed to retire non-accepting direct chat session', {
              routingKey, sessionId: rejectedSessionId,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            });
          });
          sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null,
            { forceReplacementReason: 'previous session did not accept the submitted prompt' });
          session = sessionResolution.session;
          intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
            sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
            state: 'active', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          prompt = buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
            scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery });
          activity = this.createActivityPublisher({
            backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
            appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
            channelId: intercept.channelId, threadId: intercept.threadId,
            triggerMessageId: sourceMessageIds.at(-1)!, sessionId: session.id,
            agentNpub: intercept.botNpub, turnId,
          });
          reply = await this.sendFinalResponse(this.deps.processManager, session.id, prompt, {
            onAccepted, onPoll: () => activity?.publishLatestCommentary(this.deps.processManager),
          });
        }
        const body = reply.content;
        this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: body,
          publishedMessageId: null, state: 'reply_ready', createdAt: now, updatedAt: new Date().toISOString() });
        await this.publishTurn(input, intercept, agent, turnId, sourceMessageIds, clientRequestId, body);
        await activity.publish('completed');
      } catch (error) {
        await activity?.publish('failed');
        const status = Number((error as { status?: unknown })?.status ?? 0);
        this.deps.interceptStore.save({ ...intercept, state: status === 401 || status === 403 ? 'blocked_auth' : 'pending',
          lastDecision: 'failed', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        this.log.error('[agent-chat] direct chat turn failed', {
          routingKey,
          sessionId: intercept.sessionId,
          sessionGeneration: intercept.sessionGeneration,
          pendingMessageCount: intercept.pendingMessageCount,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async publishTurn(input: DirectChatRuntimeInput, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, agent: AgentDefinitionRecord, turnId: string, sourceMessageIds: string[], clientRequestId: string, body: string): Promise<void> {
    const session = intercept.sessionId ? this.deps.processManager.getSession(intercept.sessionId) : null;
    const bridgeRecord = session && this.deps.turnBridge?.accept({ session, prompt: '', promptType: 'direct_chat',
      boundaryIdentity: turnId, sourceMessageIds });
    const messageId = bridgeRecord && this.deps.turnBridge
      ? await this.deps.turnBridge.publishKnownFinal(bridgeRecord, body, new Date().toISOString())
      : (await this.publish({ backendBaseUrl: input.subscription.backendBaseUrl,
          workspaceId: input.subscription.workspaceId!, channelId: intercept.channelId, appNpub: input.subscription.sourceAppNpub,
          botIdentity: input.botIdentity, body, threadId: intercept.threadId, clientRequestId,
          metadata: { source: 'autopilot_session', session_id: intercept.sessionId, turn_id: turnId,
            source_message_ids: sourceMessageIds, agent_npub: intercept.botNpub } })).message?.id ?? null;
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

  private async resolveSession(agent: AgentDefinitionRecord, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, subscription: WorkspaceSubscriptionRecord, scopeId: string | null,
    options?: { forceReplacementReason?: string }): Promise<{
    session: SessionSnapshot; bootstrap: boolean; generation: number; previousSessionIds: string[]; recovery: { previousSessionId: string; reason: string } | null;
  }> {
    const live = intercept.sessionId ? this.deps.processManager.getSession(intercept.sessionId) : null;
    const archived = !live && intercept.sessionId ? this.deps.getArchivedSession?.(intercept.sessionId) ?? null : null;
    if (!options?.forceReplacementReason && (live?.status === 'running' || live?.status === 'starting')) return { session: live, bootstrap: false, generation: intercept.sessionGeneration ?? 1, previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
    const resumeSource = live ?? (archived && isAgentType(archived.agent) ? { ...archived, agent: archived.agent } : null);
    if (resumeSource && !options?.forceReplacementReason) {
      try {
        const launch = resolveNativeResumeLaunch(resumeSource, isAgentType, subscription.managedByNpub);
        const resumed = await this.deps.processManager.createSession(launch.agent, launch.workingDirectory, launch.name, launch.origin, undefined, launch.ownerNpub, launch.metadata, live?.model);
        return { session: resumed, bootstrap: false, generation: intercept.sessionGeneration ?? 1, previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
      } catch (error) {
        this.log.warn('[agent-chat] native direct chat resume failed; creating continuity replacement', {
          routingKey: intercept.routingKey,
          sessionId: resumeSource.id,
          sessionGeneration: intercept.sessionGeneration,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
      recovery: previous ? { previousSessionId: previous,
        reason: options?.forceReplacementReason ?? (resumeSource ? 'native resume unavailable' : 'session missing') } : null };
  }
}
