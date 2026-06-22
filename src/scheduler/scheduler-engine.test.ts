import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { NightWatchStore } from "../nightwatch/nightwatch-store";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import { SchedulerStore, type ScheduledJob } from "./scheduler-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-scheduler-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const identity: WingmanInstanceIdentity = {
  nsec: "nsec-test",
  nsecHex: "0".repeat(64),
  secretKey: new Uint8Array(32),
  pubkeyHex: "pubkey-test",
  npub: "npub-test",
  displayName: "test",
  source: "env",
};

function createPipelineJob(store: SchedulerStore): ScheduledJob {
  return store.createJob({
    name: "pipeline job",
    userNpub: "npub-user",
    botNpub: "npub-bot",
    wrappedKeyCiphertext: "ciphertext",
    wrappedKeyNonce: "nonce",
    agent: "codex",
    workingDirectory: tempDir,
    initialPrompt: "run it",
    nightwatchmanEnabled: false,
    triggerType: "cron",
    cronExpression: "* * * * *",
    actionType: "pipeline",
    pipelineDefinitionId: "test-pipeline",
    pipelineInputJson: JSON.stringify({ value: 1 }),
  });
}

function createCleanupJob(store: SchedulerStore): ScheduledJob {
  return store.createJob({
    name: "cleanup job",
    userNpub: "npub-user",
    botNpub: "",
    wrappedKeyCiphertext: "",
    wrappedKeyNonce: "",
    agent: "codex",
    workingDirectory: "",
    initialPrompt: "",
    nightwatchmanEnabled: false,
    triggerType: "cron",
    cronExpression: "* * * * *",
    actionType: "cleanup",
  });
}

function createEngine(
  store: SchedulerStore,
  runPipeline: NonNullable<SchedulerEngineDeps["runPipeline"]>,
): SchedulerEngine {
  return new SchedulerEngine({
    store,
    nightWatchStore: {} as NightWatchStore,
    createSession: async () => {
      throw new Error("pipeline jobs should not create sessions");
    },
    addPrompt: () => {},
    dispatchPrompt: () => {},
    getInstanceIdentity: () => identity,
    runPipeline,
  });
}

function createCleanupEngine(
  store: SchedulerStore,
  cleanupStopNextActionSessions: NonNullable<SchedulerEngineDeps["cleanupStopNextActionSessions"]>,
): SchedulerEngine {
  return new SchedulerEngine({
    store,
    nightWatchStore: {} as NightWatchStore,
    createSession: async () => {
      throw new Error("cleanup jobs should not create sessions");
    },
    addPrompt: () => {},
    dispatchPrompt: () => {},
    cleanupStopNextActionSessions,
    getInstanceIdentity: () => null,
  });
}

describe("SchedulerEngine pipeline job bookkeeping", () => {
  test("links the scheduled run to the pipeline run before completion and finalizes success", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = createPipelineJob(store);
    const engine = createEngine(store, async (_job, _input, onRunCreated) => {
      onRunCreated?.("pipeline-ok");
      const linkedRun = store.getJobRuns(job.id, 1)[0];
      expect(linkedRun).toMatchObject({
        status: "started",
        pipelineRunId: "pipeline-ok",
      });
      return "pipeline-ok";
    });

    await expect(engine.executeJob(job.id)).resolves.toEqual({ pipelineRunId: "pipeline-ok" });

    const completedRun = store.getJobRuns(job.id, 1)[0];
    expect(completedRun).toMatchObject({
      status: "success",
      pipelineRunId: "pipeline-ok",
      sessionId: null,
      errorMessage: null,
    });
  });

  test("preserves the linked pipeline run when pipeline execution fails", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = createPipelineJob(store);
    const engine = createEngine(store, async (_job, _input, onRunCreated) => {
      onRunCreated?.("pipeline-error");
      throw new Error("pipeline failed");
    });

    await expect(engine.executeJob(job.id)).rejects.toThrow("pipeline failed");

    const failedRun = store.getJobRuns(job.id, 1)[0];
    expect(failedRun).toMatchObject({
      status: "error",
      pipelineRunId: "pipeline-error",
      sessionId: null,
      errorMessage: "pipeline failed",
    });
  });
});

describe("SchedulerEngine cleanup jobs", () => {
  test("runs next-action cleanup without requiring an instance identity", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = createCleanupJob(store);
    const engine = createCleanupEngine(store, async (cleanupJob) => {
      expect(cleanupJob.id).toBe(job.id);
      return {
        checked: 3,
        matched: 2,
        stopped: 2,
        archiveScheduled: 2,
        failed: 0,
      };
    });

    await expect(engine.executeJob(job.id)).resolves.toEqual({
      cleanup: {
        checked: 3,
        matched: 2,
        stopped: 2,
        archiveScheduled: 2,
        failed: 0,
      },
    });

    const completedRun = store.getJobRuns(job.id, 1)[0];
    expect(completedRun).toMatchObject({
      status: "success",
      pipelineRunId: null,
      sessionId: null,
      errorMessage: null,
    });
  });
});
