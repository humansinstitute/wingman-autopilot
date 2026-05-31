import { describe, expect, test } from "bun:test";

import { getHomeRunningPipelineRows } from "./running-pipelines.js";

describe("home running pipelines", () => {
  test("keeps only active pipeline runs", () => {
    const rows = getHomeRunningPipelineRows([
      { id: "run-1", name: "Task Dispatch", status: "running", definitionSlug: "task-dispatch" },
      { id: "run-2", name: "Done", status: "ok", definitionSlug: "done" },
      { id: "run-3", name: "Needs Input", status: "needs_input", definitionId: "do-and-review" },
      { id: "run-4", name: "Failed", status: "error", definitionSlug: "failed" },
    ]);

    expect(rows.map((row) => row.id)).toEqual(["run-1", "run-3"]);
    expect(rows[0]).toMatchObject({
      name: "Task Dispatch",
      status: "running",
      statusLabel: "Running",
      definitionLabel: "task-dispatch",
    });
    expect(rows[1]).toMatchObject({
      statusLabel: "Needs Input",
      definitionLabel: "do-and-review",
    });
  });

  test("falls back to stable run labels", () => {
    const rows = getHomeRunningPipelineRows([
      { id: "run-empty-name", name: "   ", status: "queued" },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "run-empty-name",
      definitionLabel: "pipeline",
      statusLabel: "Queued",
    });
  });
});
