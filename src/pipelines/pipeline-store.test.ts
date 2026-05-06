import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "./pipeline-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-store-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const makeStore = () => new PipelineStore(join(tempDir, "pipelines.sqlite"));

describe("PipelineStore run summaries", () => {
  test("lists run metadata and payload sizes without decoded run payloads", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      definitionPath: join(tempDir, "definition.json"),
      name: "heavy run",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { prompt: "x".repeat(1024) },
    });
    store.completeRun(run.id, "ok", { report: "y".repeat(2048) });

    const summaries = store.listRunSummaries({ ownerNpub: "npub-owner" });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: run.id,
      name: "heavy run",
      status: "ok",
      ownerNpub: "npub-owner",
      hasInput: true,
      hasCurrent: true,
      hasResult: true,
    });
    expect(summaries[0] as Record<string, unknown>).not.toHaveProperty("input");
    expect(summaries[0] as Record<string, unknown>).not.toHaveProperty("current");
    expect(summaries[0] as Record<string, unknown>).not.toHaveProperty("result");
    expect(summaries[0].inputBytes).toBeGreaterThan(1000);
    expect(summaries[0].resultBytes).toBeGreaterThan(2000);
  });

  test("gets one run summary without decoded run payloads", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      name: "single run",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 1 },
    });

    const summary = store.getRunSummary(run.id);

    expect(summary).toMatchObject({
      id: run.id,
      name: "single run",
      status: "running",
      hasInput: true,
      hasCurrent: true,
      hasResult: false,
    });
    expect(summary as Record<string, unknown>).not.toHaveProperty("input");
  });
});
