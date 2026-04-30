import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { waitForAgentReady } from "../agents/agent-client";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import type { SessionApiContext } from "../server/session-api-routes";
import {
  assignOutput,
  assertObject,
  selectInput,
  shouldRunStep,
  resolvePath,
  type DeclarativeStep,
  type FunctionRegistry,
} from "./declarative";
import { expandPipelineBlock } from "./pipeline-blocks";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { type JsonObject, PipelineStore, type PipelineStatus } from "./pipeline-store";

const CALLBACK_POLL_MS = 1000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

interface PipelineRunnerInput {
  store: PipelineStore;
  sessionApiContext: SessionApiContext;
  definition: PipelineDefinitionRecord;
  registry: FunctionRegistry;
  input: JsonObject;
  ownerNpub: string | null;
  ownerAlias: string | null;
  callbackOrigin: string;
}

export class PipelineHalt extends Error {
  constructor(
    readonly status: PipelineStatus,
    readonly result: JsonObject,
    message: string,
  ) {
    super(message);
  }
}

export async function runDeclarativePipeline(input: PipelineRunnerInput) {
  const { store, definition, registry } = input;
  const run = store.createRun({
    definitionId: definition.id,
    definitionPath: definition.path,
    name: definition.spec.name,
    ownerNpub: input.ownerNpub,
    ownerAlias: input.ownerAlias,
    scope: definition.scope,
    input: input.input,
  });
  let current = input.input;
  let stepIndex = 0;
  let cursor = 0;
  let executedSteps = 0;
  const topLevelSteps = definition.spec.steps;
  const stepTargetIndex = buildStepTargetIndex(topLevelSteps);

  try {
    while (cursor < topLevelSteps.length) {
      executedSteps += 1;
      if (executedSteps > 500) {
        throw new Error("Pipeline exceeded the maximum step execution limit");
      }
      const step = topLevelSteps[cursor]!;
      const outcome = await executePipelineStep({
        ...input,
        runId: run.id,
        step,
        current,
        nextStepIndex: () => stepIndex++,
        targetIndex: stepTargetIndex,
      });
      current = outcome.current;
      cursor = typeof outcome.jumpTo === "number" ? outcome.jumpTo : cursor + 1;
    }

    return store.completeRun(run.id, "ok", current);
  } catch (error) {
    if (error instanceof PipelineHalt) {
      return store.completeRun(run.id, error.status, error.result, error.message);
    }
    return store.completeRun(run.id, "error", current, error instanceof Error ? error.message : String(error));
  }
}

async function executePipelineStep(input: PipelineRunnerInput & {
  runId: string;
  step: DeclarativeStep;
  current: JsonObject;
  nextStepIndex: () => number;
  targetIndex?: Map<string, number>;
  namePrefix?: string;
}): Promise<{ current: JsonObject; jumpTo?: number }> {
  const { store, registry, step } = input;
  const stepName = input.namePrefix ? `${input.namePrefix} / ${step.name}` : step.name;
  if (!shouldRunStep(input.current, step.when)) {
    const skipped = store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: step.type,
      input: input.current,
    });
    store.completeStep({ id: skipped.id, status: "skipped", result: input.current });
    return { current: input.current };
  }

  if (step.type === "code") {
    const selected = selectInput(input.current, step.input);
    const stepRecord = store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "code",
      input: selected,
    });
    const fn = registry[step.function];
    if (!fn) {
      throw new Error(`Unknown pipeline function: ${step.function}`);
    }
    const result = await fn(selected);
    assertObject(result, `step ${stepName} result`);
    const current = assignOutput(input.current, result, step.assign);
    store.completeStep({ id: stepRecord.id, status: "ok", result: current });
    return { current };
  }

  if (step.type === "block") {
    const selected = selectInput(input.current, step.input);
    const blockInput = {
      ...(step.config ?? {}),
      ...selected,
    };
    const expansion = expandPipelineBlock(step);
    const stepRecord = store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "block",
      input: blockInput,
    });
    let current = assignOutput(input.current, blockInput, expansion.inputPath);
    for (const child of expansion.steps) {
      const childOutcome = await executePipelineStep({
        ...input,
        step: child,
        current,
      });
      current = childOutcome.current;
    }
    store.completeStep({ id: stepRecord.id, status: "ok", result: current });
    return { current };
  }

  if (step.type === "loop") {
    const selected = selectInput(input.current, step.input);
    const stepRecord = store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "loop",
      input: selected,
    });
    if (Array.isArray(step.steps)) {
      const iterations = resolveIterationCount(input.current, step.iterations ?? 1);
      let current = input.current;
      const counterPath = step.counter ?? `$.loop.${step.name.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        current = assignOutput(current, { iteration, index: iteration - 1, total: iterations }, counterPath);
        for (const child of step.steps) {
          const childOutcome = await executePipelineStep({
            ...input,
            step: child,
            current,
            namePrefix: `${stepName} #${iteration}`,
          });
          current = childOutcome.current;
        }
      }
      const result = { iterations, current };
      const next = step.assign ? assignOutput(current, result, step.assign) : current;
      store.completeStep({ id: stepRecord.id, status: "ok", result: next });
      return { current: next };
    }

    const iterations = resolveIterationCount(input.current, step.iterations ?? 1);
    const counterPath = step.counter ?? `$.loop.${step.name.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
    const historyPath = step.history;
    const historyItems = historyPath ? getHistoryItems(input.current, historyPath) : [];
    const completed = historyItems.length + 1;
    const captured = captureLoopValues(input.current, step.capture);
    let next = input.current;
    if (historyPath) {
      next = assignOutput(next, { items: [...historyItems, { iteration: completed, ...captured }] }, historyPath);
    }
    next = assignOutput(next, {
      iteration: Math.min(completed + 1, iterations),
      index: Math.min(completed, iterations - 1),
      completed,
      total: iterations,
      done: completed >= iterations,
    }, counterPath);

    let jumpTo: number | undefined;
    if (completed < iterations) {
      if (!step.target) throw new Error(`Loop step ${stepName} requires target`);
      jumpTo = input.targetIndex?.get(step.target);
      if (typeof jumpTo !== "number") {
        throw new Error(`Loop step ${stepName} target not found: ${step.target}`);
      }
    }
    store.completeStep({ id: stepRecord.id, status: "ok", result: next });
    return { current: next, jumpTo };
  }

  const selected = selectInput(input.current, step.input);
  const token = crypto.randomUUID();
  const stepRecord = store.createStep({
    runId: input.runId,
    stepIndex: input.nextStepIndex(),
    name: stepName,
    kind: "agent",
    input: selected,
    callbackToken: token,
  });
  const result = await runAgentStep({
    ...input,
    stepName,
    stepId: stepRecord.id,
    selectedInput: selected,
    prompt: step.prompt,
    callbackToken: token,
    agent: resolveStringTemplate(input.current, step.agent),
    directory: resolveStringTemplate(input.current, step.directory),
  });
  const current = assignOutput(input.current, result, step.assign);
  store.completeStep({
    id: stepRecord.id,
    status: "ok",
    result: current,
    wingmanSessionId: store.getStep(stepRecord.id)?.wingmanSessionId ?? null,
  });
  return { current };
}

function buildStepTargetIndex(steps: DeclarativeStep[]): Map<string, number> {
  const out = new Map<string, number>();
  steps.forEach((step, index) => {
    if (step.id) out.set(step.id, index);
    out.set(step.name, index);
  });
  return out;
}

function resolveIterationCount(current: JsonObject, value: number | string): number {
  const raw = typeof value === "string" ? resolvePath(current, value) : value;
  const count = Math.floor(Number(raw));
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(count, 25);
}

function getHistoryItems(current: JsonObject, path: string): unknown[] {
  const value = resolvePath(current, path);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items)) {
    return (value as Record<string, unknown>).items as unknown[];
  }
  return [];
}

function captureLoopValues(current: JsonObject, capture?: Record<string, string>): JsonObject {
  const out: JsonObject = {};
  if (!capture) return out;
  for (const [key, path] of Object.entries(capture)) {
    out[key] = resolvePath(current, path);
  }
  return out;
}

function resolveStringTemplate(current: JsonObject, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const resolved = value.startsWith("$.") || value === "$" ? resolvePath(current, value) : value;
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

export async function acceptAgentCallback(input: {
  store: PipelineStore;
  runId: string;
  stepId: string;
  token: string | null;
  payload: unknown;
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const step = input.store.getStep(input.stepId);
  if (!step || step.runId !== input.runId) {
    return { ok: false, status: 404, body: { error: "Step not found" } };
  }
  if (!step.callbackToken || input.token !== step.callbackToken) {
    input.store.addCallback({
      stepId: input.stepId,
      accepted: false,
      payload: payloadObject(input.payload),
      error: "Invalid callback token",
    });
    return { ok: false, status: 401, body: { error: "Invalid callback token" } };
  }
  const parsed = parseAgentCallbackPayload(input.payload, input.runId, input.stepId);
  input.store.addCallback({
    stepId: input.stepId,
    accepted: parsed.ok,
    payload: payloadObject(input.payload),
    error: parsed.ok ? null : parsed.error,
  });
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: parsed.error } };
  }
  input.store.completeStep({
    id: input.stepId,
    status: parsed.value.status,
    result: parsed.value.result,
    error: parsed.value.error ?? null,
  });
  return { ok: true, status: 200, body: { ok: true, runId: input.runId, stepId: input.stepId } };
}

async function runAgentStep(input: PipelineRunnerInput & {
  runId: string;
  stepId: string;
  stepName: string;
  selectedInput: JsonObject;
  prompt: string;
  callbackToken: string;
  agent?: string;
  directory?: string;
}): Promise<JsonObject> {
  const sessionCtx = input.sessionApiContext;
  const agent = resolveAgent(sessionCtx, input.agent);
  const session = await sessionCtx.manager.createSession(
    agent,
    input.directory,
    `Pipeline ${input.stepName}`,
    null,
    undefined,
    input.ownerNpub ?? undefined,
    {
      AGENT: true,
      role: "pipeline-step",
      goal: `Pipeline ${input.definition.spec.name}: ${input.stepName}`,
      nextAction: "stop",
      bindingType: "flow_run",
      bindingId: input.runId,
      flowRunId: input.runId,
    },
  );
  input.store.setStepSession(input.stepId, session.id);
  await recordLiveSession(sessionCtx, session);
  await waitForAgentReady(sessionCtx.agentHost, session.port, session.agent, {
    timeoutMs: session.agent === "codex" ? 120_000 : 60_000,
    pollIntervalMs: 250,
  });

  const callbackUrl = buildCallbackUrl(input.callbackOrigin, input.runId, input.stepId, input.callbackToken);
  const prompt = buildAgentPrompt({
    prompt: input.prompt,
    selectedInput: input.selectedInput,
    callbackUrl,
    callbackToken: input.callbackToken,
    runId: input.runId,
    stepId: input.stepId,
  });
  let result: { status: PipelineStatus; result: JsonObject | null; error: string | null };
  try {
    const delivered = await deliverSessionAgentMessage({
      agentHost: sessionCtx.agentHost,
      buildAgentUrl: sessionCtx.buildAgentUrl,
      agent: session.agent,
      port: session.port,
      content: prompt,
      type: "user",
      pm2Name: session.pm2Name,
    });
    if (!delivered.ok) {
      throw new Error(delivered.message);
    }

    result = await waitForCallbackResult(input.store, input.stepId);
  } catch (error) {
    const latest = input.store.getStep(input.stepId);
    if (latest?.status === "running") {
      input.store.completeStep({
        id: input.stepId,
        status: "error",
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    await stopPipelineSession(sessionCtx, session.id).catch(() => undefined);
  }
  if (result.status === "error") {
    throw new Error(result.error ?? "Agent step failed");
  }
  if (result.status === "needs_input") {
    throw new PipelineHalt("needs_input", result.result ?? {}, "Agent step needs input");
  }
  return result.result ?? {};
}

async function recordLiveSession(ctx: SessionApiContext, session: SessionSnapshot): Promise<void> {
  ctx.messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
    targetFile: session.targetFile,
    metadata: session.metadata,
  });
  await ctx.syncSessionMessages(session.id, true);
}

async function stopPipelineSession(ctx: SessionApiContext, sessionId: string): Promise<void> {
  const stopped = await ctx.manager.stopSession(sessionId);
  if (stopped) {
    ctx.scheduleSessionArchive(sessionId, ctx.manager);
  }
}

function resolveAgent(ctx: SessionApiContext, value: string | undefined): AgentType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "codex";
  return ctx.isAgentType(normalized) ? normalized : "codex";
}

function buildCallbackUrl(origin: string, runId: string, stepId: string, token: string): string {
  const url = new URL(`/api/pipelines/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/callback`, origin);
  url.searchParams.set("token", token);
  return url.toString();
}

function buildAgentPrompt(input: {
  prompt: string;
  selectedInput: JsonObject;
  callbackUrl: string;
  callbackToken: string;
  runId: string;
  stepId: string;
}): string {
  return `You are running one step in a Wingmen pipeline.

Step instruction:
${input.prompt}

Selected input:
${JSON.stringify(input.selectedInput, null, 2)}

Completion contract:
- You are not complete until the webhook returns HTTP 200.
- POST exactly one JSON object to this local callback URL:
  ${input.callbackUrl}
- Include this header:
  x-wingmen-pipeline-token: ${input.callbackToken}
- Body shape:
  {
    "runId": "${input.runId}",
    "stepId": "${input.stepId}",
    "status": "ok",
    "result": {}
  }
- status must be "ok", "needs_input", or "error".
- result must always be a JSON object.
- Do not send a "status": "error" callback for transport failures, auth failures, probes, or retries. If the webhook fails, fix the URL/header/payload and retry the final step result until it returns HTTP 200.
- Only use "status": "error" when the actual pipeline step cannot be completed.
- If selected input includes documentUrl, use that reference to locate, read, and edit the document directly when the step asks you to modify it.
- Do not include the full document text in the callback JSON. Return structured summary fields, changed line/section references, comment IDs, and status metadata only.

Example:
curl -sS -X POST '${input.callbackUrl}' \\
	  -H 'content-type: application/json' \\
	  -H 'x-wingmen-pipeline-token: ${input.callbackToken}' \\
	  -d '{"runId":"${input.runId}","stepId":"${input.stepId}","status":"ok","result":{"answer":"..."}}'`;
}

async function waitForCallbackResult(store: PipelineStore, stepId: string): Promise<{ status: PipelineStatus; result: JsonObject | null; error: string | null }> {
  const deadline = Date.now() + CALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const step = store.getStep(stepId);
    if (step && step.status !== "running") {
      return { status: step.status, result: step.result, error: step.error };
    }
    await new Promise((resolve) => setTimeout(resolve, CALLBACK_POLL_MS));
  }
  throw new Error("Timed out waiting for pipeline agent callback");
}

function parseAgentCallbackPayload(
  payload: unknown,
  runId: string,
  stepId: string,
): { ok: true; value: { status: PipelineStatus; result: JsonObject; error?: string | null } } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Payload must be a JSON object" };
  }
  const record = payload as Record<string, unknown>;
  if (record.runId !== runId) return { ok: false, error: "runId mismatch" };
  if (record.stepId !== stepId) return { ok: false, error: "stepId mismatch" };
  if (record.status !== "ok" && record.status !== "needs_input" && record.status !== "error") {
    return { ok: false, error: "status must be ok, needs_input, or error" };
  }
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
    return { ok: false, error: "result must be an object" };
  }
  return {
    ok: true,
    value: {
      status: record.status,
      result: record.result as JsonObject,
      error: typeof record.error === "string" ? record.error : null,
    },
  };
}

function payloadObject(payload: unknown): JsonObject {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonObject : { value: payload };
}
