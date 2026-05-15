import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { SessionApiContext } from "../server/session-api-routes";
import { handlePipelineApi, type PipelineApiContext } from "./pipeline-api-routes";
import { PipelineStore } from "./pipeline-store";

let tempDir: string;
let previousPipelineRoot: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-api-test-"));
  previousPipelineRoot = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = join(tempDir, "pipelines-root");
});

afterEach(() => {
  if (previousPipelineRoot === undefined) {
    delete process.env.WINGMEN_PIPELINES_ROOT;
  } else {
    process.env.WINGMEN_PIPELINES_ROOT = previousPipelineRoot;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

const makeStore = () => new PipelineStore(join(tempDir, "pipelines.sqlite"));

function makeAuth(npub: string): RequestAuthContext {
  return {
    npub,
    actorNpub: npub,
    signerNpub: npub,
    subjectNpub: npub,
    targetOwnerNpub: npub,
    delegatedOwnerNpub: null,
    delegateRelationshipId: null,
    delegateScopes: null,
    session: null,
  };
}

function makeContext(store: PipelineStore, sharedInstanceAccess: boolean): PipelineApiContext {
  return {
    store,
    sessionApiContext: {} as SessionApiContext,
    sharedInstanceAccess,
    ensureApiAccess: async () => null,
    AccessActions: {
      SessionsManage: AccessActions.SessionsManage,
    },
  };
}

async function handleGet(path: string, ctx: PipelineApiContext, viewerNpub = "npub1viewer"): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  return await handlePipelineApi(
    new Request(url),
    url,
    "GET",
    makeAuth(viewerNpub),
    ctx,
  ) ?? new Response(null, { status: 404 });
}

describe("pipeline run API visibility", () => {
  test("includes shared pipeline runs for other owners on shared instances", async () => {
    const store = makeStore();
    const ownRun = store.createRun({
      definitionId: "own-definition",
      name: "own private run",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "user",
      input: {},
    });
    const sharedRun = store.createRun({
      definitionId: "shared-definition",
      name: "shared dispatch run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "shared",
      input: {},
    });
    store.createRun({
      definitionId: "other-definition",
      name: "other private run",
      ownerNpub: "npub1other",
      ownerAlias: "other-alias",
      scope: "user",
      input: {},
    });

    const response = await handleGet("/api/pipelines/runs", makeContext(store, true));
    const body = await response.json() as { runs: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.runs.map((run) => run.id).sort()).toEqual([ownRun.id, sharedRun.id].sort());
  });

  test("keeps other-owner shared pipeline runs hidden when shared access is disabled", async () => {
    const store = makeStore();
    store.createRun({
      definitionId: "shared-definition",
      name: "shared dispatch run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "shared",
      input: {},
    });

    const response = await handleGet("/api/pipelines/runs", makeContext(store, false));
    const body = await response.json() as { runs: unknown[] };

    expect(response.status).toBe(200);
    expect(body.runs).toHaveLength(0);
  });

  test("allows shared instance viewers to open shared run and step details", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "shared-definition",
      name: "shared dispatch run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "shared",
      input: { prompt: "dispatch" },
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "analyse-intent",
      kind: "agent",
      input: { value: 1 },
    });

    const runResponse = await handleGet(`/api/pipelines/runs/${encodeURIComponent(run.id)}`, makeContext(store, true));
    const stepsResponse = await handleGet(`/api/pipelines/runs/${encodeURIComponent(run.id)}/steps`, makeContext(store, true));
    const stepResponse = await handleGet(
      `/api/pipelines/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}`,
      makeContext(store, true),
    );

    expect(runResponse.status).toBe(200);
    expect(stepsResponse.status).toBe(200);
    expect(stepResponse.status).toBe(200);
  });

  test("does not expose another owner's private run details on shared instances", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "private-definition",
      name: "other private run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "user",
      input: {},
    });

    const response = await handleGet(`/api/pipelines/runs/${encodeURIComponent(run.id)}`, makeContext(store, true));

    expect(response.status).toBe(404);
  });
});
