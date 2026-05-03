import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import { generateIdentityAlias } from "../identity/identity-alias";
import type { SessionApiContext } from "../server/session-api-routes";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { startPipelineFunctionWizardSession } from "./function-wizard";
import { builtinPipelineFunctions } from "./functions";
import { writeManualDefinitionVersion } from "./definition-editor";
import {
  ensurePipelineDirectories,
  getPipelineDefinition,
  getPipelineRoot,
  getSharedPipelineFunctionsDirectory,
  getUserPipelineDefinitionsDirectory,
  getUserPipelineFunctionsDirectory,
  listLatestPipelineDefinitions,
  listPipelineDefinitions,
  makePipelineSlug,
  nextVersionedDefinitionPath,
  nextVersionedDefinitionPathForSource,
  nextVersionedFunctionPath,
  type PipelineDefinitionRecord,
} from "./pipeline-loader";
import { acceptAgentCallback, resumeDeclarativePipeline, runDeclarativePipeline, startDeclarativePipeline } from "./pipeline-runner";
import { type JsonObject, PipelineStore } from "./pipeline-store";
import { startPipelineWizardSession } from "./pipeline-wizard";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface PipelineApiContext {
  store: PipelineStore;
  sessionApiContext: SessionApiContext;
  callbackOrigin?: string;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { SessionsManage: AccessAction };
}

export async function handlePipelineApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: PipelineApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  const callbackMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps\/([^/]+)\/callback$/);
  if (callbackMatch && method === "POST") {
    const payload = await request.json().catch(() => null);
    const result = await acceptAgentCallback({
      store: ctx.store,
      runId: decodeURIComponent(callbackMatch[1]!),
      stepId: decodeURIComponent(callbackMatch[2]!),
      token: request.headers.get("x-wingmen-pipeline-token") ?? url.searchParams.get("token"),
      payload,
    });
    if (result.ok) {
      const runId = decodeURIComponent(callbackMatch[1]!);
      void resumeStoredPipelineRun(ctx, runId, ctx.callbackOrigin ?? url.origin).catch((error) => {
        ctx.store.addEvent({
          runId,
          level: "error",
          type: "run_resume_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return Response.json(result.body, { status: result.status });
  }

  if (!pathname.startsWith("/api/pipelines")) return null;

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
  if (denied) return denied;

  const ownerNpub = getEffectiveOwnerNpub(authContext);
  if (!ownerNpub) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  const ownerAlias = generateIdentityAlias(ownerNpub);

  if (pathname === "/api/pipelines/root" && method === "GET") {
    return Response.json({
      root: getPipelineRoot(),
      sharedDefinitions: `${getPipelineRoot()}/shared/definitions`,
      sharedFunctions: getSharedPipelineFunctionsDirectory(),
      userDefinitions: `${getPipelineRoot()}/users/${ownerAlias}/definitions`,
      userFunctions: getUserPipelineFunctionsDirectory(ownerAlias),
    });
  }

  if (pathname === "/api/pipelines/functions" && method === "GET") {
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    return Response.json({ functions: functions.records });
  }

  const functionMatch = pathname.match(/^\/api\/pipelines\/functions\/([^/]+)$/);
  if (functionMatch && method === "GET") {
    const name = decodeURIComponent(functionMatch[1]!);
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const record = functions.records.find((entry) => entry.name === name);
    if (!record) return Response.json({ error: "Pipeline function not found" }, { status: 404 });
    const sourcePath = record.path ?? (record.scope === "builtin" ? join(process.cwd(), "src/pipelines/functions.ts") : null);
    const code = sourcePath ? await readAllowedPipelineFunctionSource(sourcePath, ownerAlias, record.scope === "builtin") : null;
    return Response.json({
      function: record,
      sourcePath,
      language: sourcePath?.endsWith(".ts") ? "typescript" : "javascript",
      code,
    });
  }

  if (pathname === "/api/pipelines/functions/wizard" && method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    await ensurePipelineDirectories(ownerAlias);
    const functionsDirectory = getUserPipelineFunctionsDirectory(ownerAlias);
    const targetPath = await nextVersionedFunctionPath(functionsDirectory, makePipelineSlug(prompt));
    const result = await startPipelineFunctionWizardSession({
      sessionApiContext: ctx.sessionApiContext,
      ownerNpub,
      ownerAlias,
      prompt,
      targetPath,
    });
    return Response.json({ ...result, functionsDirectory });
  }

  if (pathname === "/api/pipelines/definitions" && method === "GET") {
    const definitions = await listLatestPipelineDefinitions(ownerAlias);
    return Response.json({
      definitions: definitions.map(serializeDefinitionSummary),
    });
  }

  if (pathname === "/api/pipelines/wizard" && method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    await ensurePipelineDirectories(ownerAlias);
    const definitionsDirectory = getUserPipelineDefinitionsDirectory(ownerAlias);
    const targetPath = await nextVersionedDefinitionPath(definitionsDirectory, makePipelineSlug(prompt));
    const result = await startPipelineWizardSession({
      sessionApiContext: ctx.sessionApiContext,
      ownerNpub,
      ownerAlias,
      prompt,
      targetPath,
      mode: "create",
    });
    return Response.json({ ...result, definitionsDirectory });
  }

  const definitionRunMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/runs$/);
  if (definitionRunMatch && method === "POST") {
    const id = decodeURIComponent(definitionRunMatch[1]!);
    const definition = await getPipelineDefinition(id, ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const submittedInput = body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? body.input as JsonObject
      : {};
    const input = { ...(definition.spec.input ?? {}), ...submittedInput };
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const runnerInput = {
      store: ctx.store,
      sessionApiContext: ctx.sessionApiContext,
      definition,
      registry: functions.registry,
      input,
      ownerNpub,
      ownerAlias,
      callbackOrigin: ctx.callbackOrigin ?? url.origin,
    };
    if (url.searchParams.get("async") === "1") {
      const run = startDeclarativePipeline(runnerInput);
      return Response.json({ run, steps: [] }, { status: 202 });
    }
    const run = await runDeclarativePipeline(runnerInput);
    return Response.json({ run, steps: ctx.store.listSteps(run.id) });
  }

  const definitionWizardEditMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/wizard-edit$/);
  if (definitionWizardEditMatch && method === "POST") {
    const definition = await getPipelineDefinition(decodeURIComponent(definitionWizardEditMatch[1]!), ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    if (definition.scope !== "user" || definition.ownerAlias !== ownerAlias) {
      return Response.json({ error: "Only user pipeline definitions can be edited by the wizard" }, { status: 403 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    const targetPath = await nextVersionedDefinitionPathForSource(definition.path);
    const result = await startPipelineWizardSession({
      sessionApiContext: ctx.sessionApiContext,
      ownerNpub,
      ownerAlias,
      prompt,
      targetPath,
      sourcePath: definition.path,
      mode: "edit",
    });
    return Response.json(result);
  }

  const definitionManualEditMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/manual-edit$/);
  if (definitionManualEditMatch && method === "POST") {
    const definition = await getPipelineDefinition(decodeURIComponent(definitionManualEditMatch[1]!), ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    if (definition.scope !== "user" || definition.ownerAlias !== ownerAlias) {
      return Response.json({ error: "Only user pipeline definitions can be manually edited" }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Manual edit body must be a JSON object" }, { status: 400 });
    }
    try {
      const result = await writeManualDefinitionVersion(definition, body as Record<string, unknown>);
      const definitions = await listPipelineDefinitions(ownerAlias);
      const nextDefinition = definitions.find((entry) => entry.path === result.targetPath);
      return Response.json({
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        definition: nextDefinition ? serializeDefinitionSummary(nextDefinition) : null,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 400 });
    }
  }

  const definitionMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)$/);
  if (definitionMatch && method === "GET") {
    const definition = await getPipelineDefinition(decodeURIComponent(definitionMatch[1]!), ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    return Response.json({ definition });
  }

  if (pathname === "/api/pipelines/runs" && method === "GET") {
    return Response.json({ runs: ctx.store.listRuns({ ownerNpub }) });
  }

  const runStepsMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps$/);
  if (runStepsMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(runStepsMatch[1]!));
    if (!run || run.ownerNpub !== ownerNpub) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    const includePayload = url.searchParams.get("includePayload") === "1";
    return Response.json({ steps: includePayload ? ctx.store.listSteps(run.id) : ctx.store.listStepSummaries(run.id) });
  }

  const stepMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps\/([^/]+)$/);
  if (stepMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(stepMatch[1]!));
    const step = ctx.store.getStep(decodeURIComponent(stepMatch[2]!));
    if (!run || !step || step.runId !== run.id || run.ownerNpub !== ownerNpub) {
      return Response.json({ error: "Pipeline step not found" }, { status: 404 });
    }
    return Response.json({
      step,
      events: ctx.store.listEventsForStep(step.id),
      callbacks: ctx.store.listCallbacksForStep(step.id),
      previousSteps: ctx.store.listStepSummaries(run.id).filter((entry) => entry.stepIndex < step.stepIndex),
    });
  }

  const runMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(runMatch[1]!));
    if (!run || run.ownerNpub !== ownerNpub) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    const includePayload = url.searchParams.get("includePayload") === "1";
    return Response.json({ run, steps: includePayload ? ctx.store.listSteps(run.id) : ctx.store.listStepSummaries(run.id) });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function resumeStoredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<void> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "running") return;
  const ownerAlias = run.ownerAlias;
  const definition = await getPipelineDefinition(run.definitionId, ownerAlias);
  if (!definition) {
    ctx.store.completeRun(run.id, "error", run.current, `Pipeline definition not found: ${run.definitionId}`);
    return;
  }
  const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
  await resumeDeclarativePipeline({
    store: ctx.store,
    sessionApiContext: ctx.sessionApiContext,
    definition,
    registry: functions.registry,
    input: run.input,
    ownerNpub: run.ownerNpub,
    ownerAlias,
    callbackOrigin,
  }, run.id);
}

export async function resumeRunningPipelineRuns(
  ctx: PipelineApiContext,
  callbackOrigin: string,
): Promise<void> {
  for (const run of ctx.store.listRunningRuns()) {
    await resumeStoredPipelineRun(ctx, run.id, callbackOrigin);
  }
}

function serializeDefinitionSummary(definition: PipelineDefinitionRecord): JsonObject {
  return {
    id: definition.id,
    slug: definition.slug,
    name: definition.name,
    description: typeof definition.spec.description === "string" ? definition.spec.description : "",
    version: definition.spec.version ?? null,
    supersedes: typeof definition.spec.supersedes === "string" ? definition.spec.supersedes : null,
    scope: definition.scope,
    ownerAlias: definition.ownerAlias,
    path: definition.path,
    input: definition.spec.input ?? {},
    steps: definition.spec.steps,
  };
}

async function readAllowedPipelineFunctionSource(path: string, ownerAlias: string, allowBuiltin: boolean): Promise<string> {
  const allowedRoots = [
    getSharedPipelineFunctionsDirectory(),
    getUserPipelineFunctionsDirectory(ownerAlias),
  ];
  if (allowBuiltin) {
    allowedRoots.push(join(process.cwd(), "src/pipelines"));
  }
  const realPath = await realpath(path);
  const realRoots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => null)));
  const allowed = realRoots.some((root) => root && (realPath === root || realPath.startsWith(`${root}${sep}`)));
  if (!allowed) {
    throw new Error("Pipeline function source path is outside allowed roots");
  }
  return readFile(realPath, "utf8");
}
