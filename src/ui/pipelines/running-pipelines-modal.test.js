import { describe, expect, test } from "bun:test";

import {
  getActivePipelineRuns,
  getPipelineRunDisplayName,
  isActivePipelineRun,
} from "./running-pipelines-modal.js";

describe("running pipelines modal helpers", () => {
  test("identifies active pipeline run statuses", () => {
    expect(isActivePipelineRun({ status: "queued" })).toBe(true);
    expect(isActivePipelineRun({ status: "running" })).toBe(true);
    expect(isActivePipelineRun({ status: "needs_input" })).toBe(false);
    expect(isActivePipelineRun({ status: "ok" })).toBe(false);
    expect(isActivePipelineRun({ status: "error" })).toBe(false);
  });

  test("lists only active pipeline runs", () => {
    const runs = [
      { id: "run-1", status: "running" },
      { id: "run-2", status: "ok" },
      { id: "run-3", status: "needs_input" },
      { id: "run-4", status: "error" },
    ];

    expect(getActivePipelineRuns(runs).map((run) => run.id)).toEqual(["run-1"]);
  });

  test("formats a stable display name", () => {
    expect(getPipelineRunDisplayName({ id: "run-1", name: "Review Loop" })).toBe("Review Loop");
    expect(getPipelineRunDisplayName({ id: "run-2", name: "   " })).toBe("run-2");
  });
});
