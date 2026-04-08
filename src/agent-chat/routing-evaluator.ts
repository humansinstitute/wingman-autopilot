import { chatInterceptStateStore, type ChatInterceptStateStore } from './chat-intercept-state-store';
import {
  buildFailureDiagnostic,
  buildSuccessDiagnostic,
  fetchGroupsForViewer,
  fetchRecordHistory,
} from './tower-client';
import type {
  AgentChatDiagnostic,
  ChatInterceptStateRecord,
  WorkspaceSubscriptionRecord,
  YokeWorkspaceSession,
} from './types';
import { loadYokeBotHelpers } from './yoke-bot-helpers';
import { decryptRecordPayloadWithYoke } from './yoke-record-payload';

interface TriggerRule {
  type: 'agent_chat_trigger_v1';
  enabled: boolean;
  targetGroupId: string | null;
  targetGroupNpub: string | null;
}

export interface RoutingEvaluationDependencies {
  interceptStore?: ChatInterceptStateStore;
}

export interface RoutingEvaluationInput {
  subscription: WorkspaceSubscriptionRecord;
  wsSession: YokeWorkspaceSession;
  groupKeys: unknown;
  chatRecordId: string;
  chatMessage: Record<string, unknown>;
}

export interface RoutingEvaluationResult {
  diagnostic: AgentChatDiagnostic;
  intercept: ChatInterceptStateRecord | null;
}

export class AgentChatRoutingEvaluator {
  private readonly interceptStore: ChatInterceptStateStore;

  constructor(deps: RoutingEvaluationDependencies = {}) {
    this.interceptStore = deps.interceptStore ?? chatInterceptStateStore;
  }

  listInterceptsForSubscription(subscriptionId: string): ChatInterceptStateRecord[] {
    return this.interceptStore.listBySubscriptionId(subscriptionId);
  }

  async evaluate(input: RoutingEvaluationInput): Promise<RoutingEvaluationResult> {
    let triggerRule: TriggerRule | null;
    try {
      triggerRule = await this.loadTriggerRule(input.subscription, input.wsSession, input.groupKeys);
    } catch (error) {
      return {
        diagnostic: buildFailureDiagnostic(
          'no_trigger_configured',
          error instanceof Error ? error.message : 'The Agent Chat trigger could not be loaded.',
          this.getDetailCode(error, 'trigger_unreadable'),
          {
            subscription_id: input.subscription.subscriptionId,
            trigger_config_record_id: input.subscription.triggerConfigRecordId,
            record_id: input.chatRecordId,
          },
        ),
        intercept: null,
      };
    }
    if (!triggerRule) {
      return {
        diagnostic: buildFailureDiagnostic(
          'no_trigger_configured',
          'No Agent Chat trigger is configured for this subscription.',
          'trigger_missing',
          {
            subscription_id: input.subscription.subscriptionId,
            trigger_config_record_id: input.subscription.triggerConfigRecordId,
            record_id: input.chatRecordId,
          },
        ),
        intercept: null,
      };
    }

    if (!triggerRule.enabled) {
      return {
        diagnostic: buildFailureDiagnostic(
          'trigger_disabled',
          'The Agent Chat trigger is disabled.',
          'trigger_disabled',
          {
            subscription_id: input.subscription.subscriptionId,
            trigger_config_record_id: input.subscription.triggerConfigRecordId,
            record_id: input.chatRecordId,
          },
        ),
        intercept: null,
      };
    }

    if (!triggerRule.targetGroupId && !triggerRule.targetGroupNpub) {
      return {
        diagnostic: buildFailureDiagnostic(
          'no_trigger_configured',
          'The Agent Chat trigger does not point at a target group.',
          'trigger_invalid',
          {
            subscription_id: input.subscription.subscriptionId,
            trigger_config_record_id: input.subscription.triggerConfigRecordId,
            record_id: input.chatRecordId,
          },
        ),
        intercept: null,
      };
    }

    const helpers = await loadYokeBotHelpers();

    let routingContext: ReturnType<typeof helpers.normalizeChatRoutingContext>;
    try {
      const channelRecord = await this.fetchLatestRecordVersion(
        input.subscription.backendBaseUrl,
        input.subscription.workspaceOwnerNpub,
        this.getRequiredString(input.chatMessage.channel_id, 'channel_id'),
        input.wsSession,
      );
      const channelPayload = await decryptRecordPayloadWithYoke({
        record: channelRecord,
        wsSession: input.wsSession,
        groupKeys: input.groupKeys,
      });
      const lookupMap = await this.loadThreadLookup(input, helpers);
      routingContext = helpers.normalizeChatRoutingContext(
        {
          chatMessage: input.chatMessage,
          channel: {
            record: channelRecord,
            payload: channelPayload,
          },
        },
        {
          lookupMessage: (messageId: string) => lookupMap.get(messageId) ?? null,
        },
      );
    } catch (error) {
      const detailCode = this.getDetailCode(error, 'thread_unresolved');
      const isThreadResolutionFailure = detailCode === 'thread_unresolved';
      return {
        diagnostic: buildFailureDiagnostic(
          isThreadResolutionFailure ? 'thread_unresolved' : 'target_bot_not_decrypt_capable',
          error instanceof Error
            ? error.message
            : isThreadResolutionFailure
              ? 'The chat message thread could not be resolved.'
              : 'The target bot could not load readable routing context.',
          detailCode,
          {
            subscription_id: input.subscription.subscriptionId,
            record_id: input.chatRecordId,
            channel_id: input.chatMessage.channel_id ?? null,
            target_bot_npub: input.subscription.botNpub,
          },
        ),
        intercept: null,
      };
    }

    const groups = await this.loadViewerGroups(input.subscription, input.wsSession);
    const targetGroup = this.resolveTargetGroup(groups, triggerRule);
    if (!targetGroup) {
      return {
        diagnostic: buildFailureDiagnostic(
          'no_matching_target_bots',
          'The configured trigger target group is not available to the subscribed bot.',
          'target_group_unavailable',
          {
            subscription_id: input.subscription.subscriptionId,
            record_id: input.chatRecordId,
            target_group_id: triggerRule.targetGroupId,
            target_group_npub: triggerRule.targetGroupNpub,
            participant_npubs: routingContext.participant_npubs,
          },
        ),
        intercept: null,
      };
    }

    const matchingTargetBots = intersectSorted(
      normaliseNpubList(targetGroup.members),
      routingContext.participant_npubs,
    );

    if (!matchingTargetBots.includes(input.subscription.botNpub)) {
      return {
        diagnostic: buildFailureDiagnostic(
          'no_matching_target_bots',
          'The message was readable, but this subscription bot was not a matching trigger target.',
          'no_matching_target_bots',
          {
            subscription_id: input.subscription.subscriptionId,
            record_id: input.chatRecordId,
            target_group_id: targetGroup.id,
            target_group_npub: targetGroup.groupNpub,
            participant_npubs: routingContext.participant_npubs,
            matching_target_bot_npubs: matchingTargetBots,
            target_bot_npub: input.subscription.botNpub,
          },
        ),
        intercept: null,
      };
    }

    const routingKey = buildCanonicalRoutingKey({
      workspaceOwnerNpub: input.subscription.workspaceOwnerNpub,
      sourceAppNpub: input.subscription.sourceAppNpub,
      channelId: routingContext.channel_id,
      threadId: routingContext.thread_id,
      targetBotNpub: input.subscription.botNpub,
    });
    const intercept = this.interceptStore.upsertMessage({
      routingKey,
      subscriptionId: input.subscription.subscriptionId,
      workspaceOwnerNpub: input.subscription.workspaceOwnerNpub,
      sourceAppNpub: input.subscription.sourceAppNpub,
      channelId: routingContext.channel_id,
      threadId: routingContext.thread_id,
      targetBotNpub: input.subscription.botNpub,
      messageId: routingContext.record_id,
    });

    return {
      diagnostic: buildSuccessDiagnostic('Chat intercept state created or updated.', {
        subscription_id: input.subscription.subscriptionId,
        record_id: input.chatRecordId,
        routing_key: routingKey,
        target_bot_npub: input.subscription.botNpub,
        target_group_id: targetGroup.id,
        target_group_npub: targetGroup.groupNpub,
        channel_id: routingContext.channel_id,
        thread_id: routingContext.thread_id,
        participant_npubs: routingContext.participant_npubs,
        pending_message_count: intercept.pendingMessageCount,
      }),
      intercept,
    };
  }

  private async loadTriggerRule(
    subscription: WorkspaceSubscriptionRecord,
    wsSession: YokeWorkspaceSession,
    groupKeys: unknown,
  ): Promise<TriggerRule | null> {
    const triggerRecordId = typeof subscription.triggerConfigRecordId === 'string'
      ? subscription.triggerConfigRecordId.trim()
      : '';
    if (!triggerRecordId) {
      return null;
    }

    try {
      const triggerRecord = await this.fetchLatestRecordVersion(
        subscription.backendBaseUrl,
        subscription.workspaceOwnerNpub,
        triggerRecordId,
        wsSession,
      );
      const payload = await decryptRecordPayloadWithYoke({
        record: triggerRecord,
        wsSession,
        groupKeys,
      });
      return parseTriggerRule(payload);
    } catch (error) {
      const detailCode = this.getDetailCode(error, 'trigger_unreadable');
      if (detailCode === 'record_pull_not_found') {
        return null;
      }
      throw Object.assign(
        error instanceof Error ? error : new Error('Failed to load trigger record.'),
        { detailCode },
      );
    }
  }

  private async loadViewerGroups(
    subscription: WorkspaceSubscriptionRecord,
    wsSession: YokeWorkspaceSession,
  ): Promise<Array<{ id: string; groupNpub: string | null; members: string[] }>> {
    try {
      const groups = await fetchGroupsForViewer(
        subscription.backendBaseUrl,
        wsSession.npub,
        wsSession,
      );
      return groups
        .map((group) => ({
          id: this.getOptionalString(group.id)
            ?? this.getOptionalString(group.group_id)
            ?? this.getOptionalString(group.group_npub)
            ?? '',
          groupNpub: this.getOptionalString(group.current_group_npub)
            ?? this.getOptionalString(group.group_npub)
            ?? null,
          members: normaliseNpubList(group.members),
        }))
        .filter((group) => group.id.length > 0);
    } catch (error) {
      return [];
    }
  }

  private resolveTargetGroup(
    groups: Array<{ id: string; groupNpub: string | null; members: string[] }>,
    triggerRule: TriggerRule,
  ): { id: string; groupNpub: string | null; members: string[] } | null {
    return groups.find((group) => (
      (triggerRule.targetGroupId && group.id === triggerRule.targetGroupId)
      || (triggerRule.targetGroupNpub && group.groupNpub === triggerRule.targetGroupNpub)
    )) ?? null;
  }

  private async loadThreadLookup(
    input: RoutingEvaluationInput,
    helpers: Awaited<ReturnType<typeof loadYokeBotHelpers>>,
  ): Promise<Map<string, Record<string, unknown>>> {
    const lookup = new Map<string, Record<string, unknown>>();
    const rootHint = this.getOptionalString(input.chatMessage.thread_id);
    if (rootHint) {
      return lookup;
    }

    const selfId = this.getRequiredString(input.chatMessage.record_id, 'record_id');
    let nextParentId = this.getOptionalString(input.chatMessage.parent_message_id);
    const seen = new Set([selfId]);

    while (nextParentId && !lookup.has(nextParentId)) {
      if (seen.has(nextParentId)) {
        break;
      }
      seen.add(nextParentId);

      try {
        const parentRecord = await this.fetchLatestRecordVersion(
          input.subscription.backendBaseUrl,
          input.subscription.workspaceOwnerNpub,
          nextParentId,
          input.wsSession,
        );
        const parentMessage = helpers.decryptChatRecord({
          record: parentRecord,
          wsSession: input.wsSession,
          groupKeys: input.groupKeys,
        });
        const parentRecordId = this.getRequiredString(parentMessage.record_id, 'parent record_id');
        lookup.set(parentRecordId, parentMessage);
        nextParentId = this.getOptionalString(parentMessage.parent_message_id);
      } catch {
        break;
      }
    }

    return lookup;
  }

  private async fetchLatestRecordVersion(
    backendBaseUrl: string,
    workspaceOwnerNpub: string,
    recordId: string,
    wsSession: YokeWorkspaceSession,
  ): Promise<Record<string, unknown>> {
    const versions = await fetchRecordHistory(
      backendBaseUrl,
      workspaceOwnerNpub,
      recordId,
      wsSession,
    );
    const latest = versions
      .slice()
      .sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
    if (!latest) {
      throw Object.assign(new Error(`Record ${recordId} not found.`), { detailCode: 'record_pull_not_found' });
    }
    return latest;
  }

  private getRequiredString(value: unknown, name: string): string {
    const stringValue = this.getOptionalString(value);
    if (!stringValue) {
      throw Object.assign(new Error(`Missing ${name}.`), { detailCode: 'thread_unresolved' });
    }
    return stringValue;
  }

  private getOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private getDetailCode(error: unknown, fallback: string): string {
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : null;
    if (code) {
      return code;
    }
    const detailCode = typeof (error as { detailCode?: unknown })?.detailCode === 'string'
      ? (error as { detailCode: string }).detailCode
      : null;
    return detailCode || fallback;
  }
}

function parseTriggerRule(payload: Record<string, unknown>): TriggerRule | null {
  const data = payload && typeof payload.data === 'object' && payload.data
    ? payload.data as Record<string, unknown>
    : payload;
  const direct = toTriggerCandidate(data);
  if (direct) {
    return direct;
  }

  const triggers = Array.isArray(data.triggers) ? data.triggers : [];
  for (const candidate of triggers) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const parsed = toTriggerCandidate(candidate as Record<string, unknown>);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function toTriggerCandidate(value: Record<string, unknown>): TriggerRule | null {
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  if (type !== 'agent_chat_trigger_v1') {
    return null;
  }
  return {
    type: 'agent_chat_trigger_v1',
    enabled: value.enabled !== false,
    targetGroupId: typeof value.target_group_id === 'string' && value.target_group_id.trim().length > 0
      ? value.target_group_id.trim()
      : null,
    targetGroupNpub: typeof value.target_group_npub === 'string' && value.target_group_npub.trim().length > 0
      ? value.target_group_npub.trim()
      : null,
  };
}

function normaliseNpubList(values: unknown): string[] {
  const set = new Set<string>();
  if (!Array.isArray(values)) {
    return [];
  }
  for (const value of values) {
    const npub = typeof value === 'string'
      ? value.trim()
      : value && typeof value === 'object' && typeof (value as { member_npub?: unknown }).member_npub === 'string'
        ? (value as { member_npub: string }).member_npub.trim()
        : '';
    if (npub.startsWith('npub1')) {
      set.add(npub);
    }
  }
  return [...set].sort();
}

function intersectSorted(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).sort();
}

export function buildCanonicalRoutingKey(input: {
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  channelId: string;
  threadId: string;
  targetBotNpub: string;
}): string {
  return [
    input.workspaceOwnerNpub,
    input.sourceAppNpub,
    input.channelId,
    input.threadId,
    input.targetBotNpub,
  ].join('+');
}
