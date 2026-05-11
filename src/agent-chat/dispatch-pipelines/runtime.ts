import { generateIdentityAlias } from '../../identity/identity-alias';
import { loadPipelineFunctionRegistry } from '../../pipelines/function-loader';
import { builtinPipelineFunctions } from '../../pipelines/functions';
import { getPipelineDefinition } from '../../pipelines/pipeline-loader';
import { runDeclarativePipeline } from '../../pipelines/pipeline-runner';
import { type JsonObject, PipelineStore } from '../../pipelines/pipeline-store';
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

    const dedupeKey = buildDedupeKey(input, route);
    const flightDeckRuntime = pipelineNeedsFlightDeckPublisher(definition.spec)
      ? await prepareDispatchPipelineFlightDeckRuntime({ eventInput: input, agent })
      : emptyFlightDeckRuntime();
    const concurrencyKey = renderTemplate(route.concurrencyKeyTemplate, {
      route,
      workspace: input.subscription,
      record: input,
      routing: input,
    }) || dedupeKey;
    const envelope = buildDispatchEnvelope({
      route,
      input,
      agent,
      dedupeKey,
      flightDeckRuntime,
    });
    const functions = await this.loadFunctions(ownerAlias, builtinPipelineFunctions);
    if (pipelineNeedsFlightDeckPublisher(definition.spec)) {
      functions.registry['dispatch.publishFlightDeckResponse'] = createDispatchFlightDeckPublisher({
        eventInput: input,
        agent,
        botIdentity: input.botIdentity ?? null,
        runtime: flightDeckRuntime,
      });
    }
    const run = await this.runPipeline({
      store: this.pipelineStore,
      sessionApiContext,
      definition,
      registry: functions.registry,
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
  flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
}): JsonObject {
  const { route, input: eventInput, agent, flightDeckRuntime } = input;
  return {
    ...route.inputTemplateJson,
    dispatch: {
      routeId: route.routeId,
      triggerKind: eventInput.triggerKind,
      receivedAt: new Date().toISOString(),
      dedupeKey: input.dedupeKey,
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
      defaultAgent: null,
    },
    record: {
      recordId: eventInput.recordId,
      recordFamily: eventInput.recordFamily,
      recordState: eventInput.recordState,
      version: eventInput.recordVersion,
      updaterNpub: eventInput.updaterNpub,
      payload: eventInput.payload,
    },
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
