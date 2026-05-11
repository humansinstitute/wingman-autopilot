import { generateIdentityAlias } from '../../identity/identity-alias';
import type { FunctionRegistry } from '../../pipelines/declarative';
import { loadPipelineFunctionRegistry } from '../../pipelines/function-loader';
import { builtinPipelineFunctions } from '../../pipelines/functions';
import { getPipelineDefinition } from '../../pipelines/pipeline-loader';
import { runDeclarativePipeline, startDeclarativePipeline } from '../../pipelines/pipeline-runner';
import { type JsonObject, PipelineStore, type PipelineRunRecord } from '../../pipelines/pipeline-store';
import type { SessionApiContext } from '../../server/session-api-routes';
import { agentDefinitionStore, type AgentDefinitionStore } from '../agent-definition-store';
import type {
  AgentCapability,
  AgentChatDispatchHistoryEntry,
  AgentDefinitionRecord,
  DispatchRouteRecord,
  DispatchTriggerKind,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from '../types';
import { bootstrapAgentDefinitionWorkspace } from '../agent-workspace-bootstrap';
import {
  createDispatchFlightDeckPublisher,
  pipelineNeedsFlightDeckPublisher,
  prepareDispatchPipelineFlightDeckRuntime,
  type DispatchPipelineFlightDeckRuntime,
} from './flightdeck-publisher';
import { dispatchRouteStore, type DispatchRouteStore } from './route-store';

export interface DispatchPipelineEventInput {
  subscription: WorkspaceSubscriptionRecord;
  triggerKind: DispatchTriggerKind;
  capability: AgentCapability;
  recordId: string;
  record: Record<string, unknown>;
  payload: Record<string, unknown>;
  recordFamily: string;
  recordState: string | null;
  recordVersion: number | null;
  updaterNpub: string | null;
  bindingType: AgentChatDispatchHistoryEntry['bindingType'];
  bindingId: string | null;
  channelId?: string | null;
  threadId?: string | null;
  changedFields?: string[];
  groupNpubs?: string[];
  botIdentity?: RuntimeBotIdentity | null;
}

export interface DispatchPipelineRuntimeResult {
  handled: boolean;
  historyEntries: AgentChatDispatchHistoryEntry[];
  lastPipelineRunId: string | null;
}

export interface DispatchPipelineRuntimeDependencies {
  routeStore?: DispatchRouteStore;
  agentStore?: AgentDefinitionStore;
  pipelineStore: PipelineStore;
  getSessionApiContext: () => SessionApiContext | null;
  callbackOrigin: string;
  runPipeline?: typeof runDeclarativePipeline;
  loadDefinition?: typeof getPipelineDefinition;
  loadFunctions?: typeof loadPipelineFunctionRegistry;
  requirePipelineRoutes?: boolean;
  defaultAgent?: string;
}

export class DispatchPipelineRuntime {
  private readonly routeStore: DispatchRouteStore;
  private readonly agentStore: AgentDefinitionStore;
  private readonly pipelineStore: PipelineStore;
  private readonly getSessionApiContext: () => SessionApiContext | null;
  private readonly callbackOrigin: string;
  private readonly runPipeline: typeof runDeclarativePipeline;
  private readonly loadDefinition: typeof getPipelineDefinition;
  private readonly loadFunctions: typeof loadPipelineFunctionRegistry;
  private readonly requirePipelineRoutes: boolean;
  private readonly defaultAgent: string;

  constructor(deps: DispatchPipelineRuntimeDependencies) {
    this.routeStore = deps.routeStore ?? dispatchRouteStore;
    this.agentStore = deps.agentStore ?? agentDefinitionStore;
    this.pipelineStore = deps.pipelineStore;
    this.getSessionApiContext = deps.getSessionApiContext;
    this.callbackOrigin = deps.callbackOrigin;
    this.runPipeline = deps.runPipeline ?? runDeclarativePipeline;
    this.loadDefinition = deps.loadDefinition ?? getPipelineDefinition;
    this.loadFunctions = deps.loadFunctions ?? loadPipelineFunctionRegistry;
    this.requirePipelineRoutes = deps.requirePipelineRoutes ?? false;
    this.defaultAgent = normaliseDefaultAgent(deps.defaultAgent);
  }

  listRoutesForManager(managedByNpub: string): DispatchRouteRecord[] {
    return this.routeStore.listForManager(managedByNpub);
  }

  listRoutesForSubscription(subscriptionId: string): DispatchRouteRecord[] {
    return this.routeStore.listForSubscription(subscriptionId);
  }

  saveRoute(input: Parameters<DispatchRouteStore['save']>[0]): DispatchRouteRecord {
    return this.routeStore.save(input);
  }

  deleteRouteForManager(routeId: string, managedByNpub: string): boolean {
    return this.routeStore.deleteForManager(routeId, managedByNpub);
  }

  async dispatch(input: DispatchPipelineEventInput): Promise<DispatchPipelineRuntimeResult> {
    const configuredRoutes = this.routeStore.listForSubscriptionTrigger({
      subscriptionId: input.subscription.subscriptionId,
      triggerKind: input.triggerKind,
      capability: input.capability,
    });
    if (configuredRoutes.length === 0) {
      if (this.requirePipelineRoutes) {
        return {
          handled: true,
          historyEntries: [this.buildMissingRouteHistoryEntry(input)],
          lastPipelineRunId: null,
        };
      }
      return { handled: false, historyEntries: [], lastPipelineRunId: null };
    }

    const disabledRoutes = configuredRoutes.filter((route) => !route.enabled);
    const enabledMatches = configuredRoutes
      .filter((route) => route.enabled)
      .filter((route) => routeMatchesEvent(route, input));

    if (enabledMatches.length === 0) {
      const route = disabledRoutes[0] ?? configuredRoutes[0]!;
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_suppressed`,
            status: 'suppressed',
            pipelineRunId: null,
            suppressionReason: disabledRoutes.length > 0 ? 'route_disabled' : 'route_match_failed',
            diagnosticSummary: disabledRoutes.length > 0
              ? 'Dispatch route is disabled.'
              : 'No enabled dispatch route matched the advisory.',
          }),
        ],
        lastPipelineRunId: null,
      };
    }

    const route = enabledMatches[0]!;
    const dedupeKey = buildDedupeKey(input, route);
    const concurrencyKey = renderTemplate(route.concurrencyKeyTemplate, {
      route,
      workspace: input.subscription,
      record: input,
      routing: input,
    }) || dedupeKey;
    const suppressedRun = this.findSuppressedDispatchRun(route, dedupeKey, concurrencyKey);
    if (suppressedRun) {
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_suppressed`,
            status: 'suppressed',
            pipelineRunId: suppressedRun.run.id,
            concurrencyKey,
            dedupeKey,
            dedupeReason: suppressedRun.dedupeReason,
            suppressionReason: suppressedRun.suppressionReason,
            diagnosticSummary: suppressedRun.diagnosticSummary,
          }),
        ],
        lastPipelineRunId: suppressedRun.run.id,
      };
    }
    const agent = this.selectAgent(input);
    const ownerNpub = input.subscription.managedByNpub ?? route.managedByNpub;
    const ownerAlias = generateIdentityAlias(ownerNpub);
    const definition = await this.loadDefinition(route.pipelineDefinitionId, ownerAlias);
    const sessionApiContext = this.getSessionApiContext();
    if (!definition || !sessionApiContext) {
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_failed`,
            status: 'failed',
            pipelineRunId: null,
            diagnosticSummary: !definition
              ? `Pipeline definition not found: ${route.pipelineDefinitionId}`
              : 'Pipeline session API context is not ready.',
          }),
        ],
        lastPipelineRunId: null,
      };
    }
    try {
      await ensureAgentWorkingDirectory(agent);
    } catch (error) {
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_failed`,
            status: 'failed',
            pipelineRunId: null,
            diagnosticSummary: `Agent working directory is not usable: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ],
        lastPipelineRunId: null,
      };
    }

    const flightDeckRuntime = pipelineNeedsFlightDeckPublisher(definition.spec)
      ? await prepareDispatchPipelineFlightDeckRuntime({ eventInput: input, agent })
      : emptyFlightDeckRuntime();
    const envelope = buildDispatchEnvelope({
      route,
      input,
      agent,
      dedupeKey,
      concurrencyKey,
      flightDeckRuntime,
      defaultAgent: this.defaultAgent,
    });
    const functions = await this.loadRuntimeFunctions({
      ownerAlias,
      ownerNpub,
      sessionApiContext,
      eventInput: input,
      agent,
      flightDeckRuntime,
      definitionNeedsPublisher: pipelineNeedsFlightDeckPublisher(definition.spec),
    });
    const run = await this.runPipeline({
      store: this.pipelineStore,
      sessionApiContext,
      definition,
      registry: functions,
      input: envelope,
      ownerNpub,
      ownerAlias,
      callbackOrigin: this.callbackOrigin,
    });

    return {
      handled: true,
      historyEntries: [
        this.buildHistoryEntry(input, route, {
          action: `${input.triggerKind}_pipeline_dispatch`,
          status: run.status,
          pipelineRunId: run.id,
          concurrencyKey,
          dedupeKey,
          diagnosticSummary: `Started dispatch pipeline ${route.pipelineDefinitionId}.`,
        }),
      ],
      lastPipelineRunId: run.id,
    };
  }

  private async loadRuntimeFunctions(input: {
    ownerAlias: string;
    ownerNpub: string;
    sessionApiContext: SessionApiContext;
    eventInput: DispatchPipelineEventInput;
    agent: AgentDefinitionRecord | null;
    flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
    definitionNeedsPublisher: boolean;
  }): Promise<FunctionRegistry> {
    const functions = await this.loadFunctions(input.ownerAlias, builtinPipelineFunctions);
    const registry: FunctionRegistry = { ...functions.registry };
    if (input.definitionNeedsPublisher) {
      registry['dispatch.publishFlightDeckResponse'] = createDispatchFlightDeckPublisher({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
    }
    registry['dispatch.startChildPipeline'] = this.createChildPipelineStarter(input);
    return registry;
  }

  private createChildPipelineStarter(input: {
    ownerAlias: string;
    ownerNpub: string;
    sessionApiContext: SessionApiContext;
    eventInput: DispatchPipelineEventInput;
    agent: AgentDefinitionRecord | null;
    flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
  }) {
    return async (payload: JsonObject): Promise<JsonObject> => {
      const workPlan = objectValue(payload.workPlan ?? payload.agentResponse ?? payload);
      const pipelineDefinitionId = getText(payload.pipelineDefinitionId)
        ?? getText(payload.definitionId)
        ?? getText(workPlan.childPipelineDefinitionId)
        ?? getText(workPlan.recommendedPipeline);
      if (!pipelineDefinitionId) {
        return {
          started: false,
          status: 'failed',
          reason: 'No child pipeline definition id was provided.',
        };
      }
      const childDefinition = await this.loadDefinition(pipelineDefinitionId, input.ownerAlias);
      if (!childDefinition) {
        return {
          started: false,
          status: 'failed',
          pipelineDefinitionId,
          reason: `Pipeline definition not found: ${pipelineDefinitionId}`,
        };
      }
      const childFunctions = await this.loadRuntimeFunctions({
        ...input,
        definitionNeedsPublisher: pipelineNeedsFlightDeckPublisher(childDefinition.spec),
      });
      const childInput = objectValue(payload.childInput ?? payload.input);
      const run = startDeclarativePipeline({
        store: this.pipelineStore,
        sessionApiContext: input.sessionApiContext,
        definition: childDefinition,
        registry: childFunctions,
        input: {
          ...childInput,
          workPlan,
          parentDispatch: {
            routeId: getText(payload.routeId) ?? getText(input.eventInput.recordId),
            triggerKind: input.eventInput.triggerKind,
            recordId: input.eventInput.recordId,
          },
        },
        ownerNpub: input.ownerNpub,
        ownerAlias: input.ownerAlias,
        callbackOrigin: this.callbackOrigin,
      });
      return {
        started: true,
        status: run.status,
        pipelineRunId: run.id,
        pipelineDefinitionId: childDefinition.id,
        pipelineName: childDefinition.name,
      };
    };
  }

  private findSuppressedDispatchRun(
    route: DispatchRouteRecord,
    dedupeKey: string,
    concurrencyKey: string,
  ): {
    run: PipelineRunRecord;
    suppressionReason: string;
    dedupeReason: string;
    diagnosticSummary: string;
  } | null {
    if (route.activePolicy === 'skip') {
      const activeRun = this.pipelineStore
        .listRunningRuns()
        .filter((run) => dispatchRunMatchesRoute(run, route))
        .find((run) => getDispatchRunConcurrencyKey(run) === concurrencyKey);
      if (activeRun) {
        return {
          run: activeRun,
          suppressionReason: 'active_run',
          dedupeReason: 'active_policy_skip',
          diagnosticSummary: `Dispatch route already has an active pipeline run: ${activeRun.id}.`,
        };
      }
    }

    if (route.dedupeWindowSeconds > 0) {
      const cutoffMs = Date.now() - (route.dedupeWindowSeconds * 1000);
      const recentRun = this.pipelineStore
        .listRuns({ limit: 500 })
        .filter((run) => dispatchRunMatchesRoute(run, route))
        .find((run) => (
          getDispatchRunDedupeKey(run) === dedupeKey
          && getRunLastActivityMs(run) >= cutoffMs
        ));
      if (recentRun) {
        return {
          run: recentRun,
          suppressionReason: 'dedupe_window',
          dedupeReason: 'recent_duplicate',
          diagnosticSummary: `Dispatch route already handled this advisory within ${route.dedupeWindowSeconds}s: ${recentRun.id}.`,
        };
      }
    }

    return null;
  }

  private selectAgent(input: DispatchPipelineEventInput): AgentDefinitionRecord | null {
    const agents = this.agentStore
      .listByWorkspaceAndBot(input.subscription.workspaceOwnerNpub, input.subscription.botNpub)
      .filter((agent) => agent.managedByNpub === input.subscription.managedByNpub)
      .filter((agent) => agent.enabled)
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    return agents.find((agent) => agent.capabilities.includes(input.capability)) ?? agents[0] ?? null;
  }

  private buildMissingRouteHistoryEntry(input: DispatchPipelineEventInput): AgentChatDispatchHistoryEntry {
    return {
      at: new Date().toISOString(),
      kind: input.triggerKind === 'task_review' ? 'review' : input.triggerKind,
      action: `${input.triggerKind}_pipeline_route_missing`,
      agentId: 'pipeline',
      sessionId: null,
      recordId: input.recordId,
      routeId: null,
      pipelineRunId: null,
      status: 'suppressed',
      suppressionReason: 'pipeline_route_required',
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      details: {
        capability: input.capability,
        trigger_kind: input.triggerKind,
        diagnostic_summary: 'No pipeline route is configured for this dispatch capability.',
      },
    };
  }

  private buildHistoryEntry(
    input: DispatchPipelineEventInput,
    route: DispatchRouteRecord,
    outcome: {
      action: string;
      status: string;
      pipelineRunId: string | null;
      concurrencyKey?: string | null;
      dedupeKey?: string | null;
      dedupeReason?: string | null;
      suppressionReason?: string | null;
      diagnosticSummary: string;
    },
  ): AgentChatDispatchHistoryEntry {
    return {
      at: new Date().toISOString(),
      kind: input.triggerKind === 'task_review' ? 'review' : input.triggerKind,
      action: outcome.action,
      agentId: 'pipeline',
      sessionId: null,
      recordId: input.recordId,
      routeId: route.routeId,
      pipelineRunId: outcome.pipelineRunId,
      status: outcome.status,
      concurrencyKey: outcome.concurrencyKey ?? null,
      dedupeKey: outcome.dedupeKey ?? null,
      dedupeReason: outcome.dedupeReason ?? null,
      suppressionReason: outcome.suppressionReason ?? null,
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      details: {
        capability: input.capability,
        trigger_kind: input.triggerKind,
        pipeline_definition_id: route.pipelineDefinitionId,
        diagnostic_summary: outcome.diagnosticSummary,
      },
    };
  }
}

function buildDispatchEnvelope(input: {
  route: DispatchRouteRecord;
  input: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
  dedupeKey: string;
  concurrencyKey: string;
  flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
  defaultAgent: string;
}): JsonObject {
  const { route, input: eventInput, agent, flightDeckRuntime } = input;
  return {
    ...route.inputTemplateJson,
    dispatch: {
      routeId: route.routeId,
      triggerKind: eventInput.triggerKind,
      receivedAt: new Date().toISOString(),
      dedupeKey: input.dedupeKey,
      concurrencyKey: input.concurrencyKey,
    },
    workspace: {
      workspaceOwnerNpub: eventInput.subscription.workspaceOwnerNpub,
      sourceAppNpub: eventInput.subscription.sourceAppNpub,
      backendBaseUrl: eventInput.subscription.backendBaseUrl,
      subscriptionId: eventInput.subscription.subscriptionId,
    },
    agent: {
      agentId: agent?.agentId ?? null,
      label: agent?.label ?? null,
      botNpub: eventInput.subscription.botNpub,
      workingDirectory: agent?.workingDirectory ?? null,
      defaultAgent: input.defaultAgent,
    },
    record: {
      recordId: eventInput.recordId,
      recordFamily: eventInput.recordFamily,
      recordState: eventInput.recordState,
      version: eventInput.recordVersion,
      updaterNpub: eventInput.updaterNpub,
      payload: eventInput.payload,
    },
    ...(eventInput.triggerKind === 'chat'
      ? {
          chat: {
            messageText: getText(eventInput.payload.body) ?? '',
            senderNpub: getText(eventInput.payload.sender_npub) ?? null,
            channelId: eventInput.channelId ?? getText(eventInput.payload.channel_id),
            threadId: eventInput.threadId ?? getText(eventInput.payload.thread_id),
            parentMessageId: getText(eventInput.payload.parent_message_id),
            attachments: Array.isArray(eventInput.payload.attachments) ? eventInput.payload.attachments : [],
          },
        }
      : {}),
    routing: {
      bindingId: eventInput.bindingId,
      bindingType: eventInput.bindingType,
      channelId: eventInput.channelId ?? null,
      threadId: eventInput.threadId ?? null,
      changedFields: eventInput.changedFields ?? [],
    },
    runtime: {
      yokeStateDir: flightDeckRuntime.yokeStateDir,
      commandPrefix: flightDeckRuntime.commandPrefix,
      commands: flightDeckRuntime.commands,
      error: flightDeckRuntime.error,
    },
  };
}

async function ensureAgentWorkingDirectory(agent: AgentDefinitionRecord | null): Promise<void> {
  await bootstrapAgentDefinitionWorkspace(agent);
}

function normaliseDefaultAgent(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : 'codex';
}

function emptyFlightDeckRuntime(): DispatchPipelineFlightDeckRuntime {
  return {
    yokeStateDir: null,
    commandPrefix: null,
    commands: {},
    error: null,
  };
}

function routeMatchesEvent(route: DispatchRouteRecord, input: DispatchPipelineEventInput): boolean {
  const match = route.matchJson ?? {};
  const groups = getStringArray(match.groupNpubs);
  if (groups.length > 0 && !groups.includes('*')) {
    const eventGroups = new Set(input.groupNpubs ?? []);
    if (!groups.some((group) => eventGroups.has(group))) {
      return false;
    }
  }

  const states = getStringArray(match.taskStates ?? match.recordStates);
  if (states.length > 0 && !states.includes(String(input.payload.state ?? input.recordState ?? ''))) {
    return false;
  }

  const assignedTo = typeof match.assignedTo === 'string' ? match.assignedTo : null;
  if (assignedTo === 'bot' && String(input.payload.assigned_to ?? input.payload.assigned_to_npub ?? '') !== input.subscription.botNpub) {
    return false;
  }
  if (assignedTo && assignedTo !== 'any' && assignedTo !== 'bot' && String(input.payload.assigned_to ?? input.payload.assigned_to_npub ?? '') !== assignedTo) {
    return false;
  }

  const changedFields = getStringArray(match.changedFields);
  if (changedFields.length > 0) {
    const eventChanged = new Set(input.changedFields ?? []);
    if (!changedFields.some((field) => eventChanged.has(field))) {
      return false;
    }
  }

  return true;
}

function getText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getDispatchRunDedupeKey(run: PipelineRunRecord): string | null {
  return getText(objectValue(run.input.dispatch).dedupeKey);
}

function getDispatchRunConcurrencyKey(run: PipelineRunRecord): string | null {
  return getText(objectValue(run.input.dispatch).concurrencyKey);
}

function getDispatchRunRouteId(run: PipelineRunRecord): string | null {
  return getText(objectValue(run.input.dispatch).routeId);
}

function dispatchRunMatchesRoute(run: PipelineRunRecord, route: DispatchRouteRecord): boolean {
  return run.definitionId === route.pipelineDefinitionId
    && getDispatchRunRouteId(run) === route.routeId;
}

function getRunLastActivityMs(run: PipelineRunRecord): number {
  const timestamp = Date.parse(run.completedAt ?? run.startedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
    : [];
}

function buildDedupeKey(input: DispatchPipelineEventInput, route: DispatchRouteRecord): string {
  return [
    input.subscription.workspaceOwnerNpub,
    input.subscription.sourceAppNpub,
    input.recordId,
    input.recordVersion ?? 'unknown',
    input.bindingId ?? 'none',
    route.routeId,
  ].join(':');
}

function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
    const parts = String(path).split('.');
    let current: unknown = values;
    for (const part of parts) {
      if (!current || typeof current !== 'object') {
        return '';
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current == null ? '' : String(current);
  });
}
