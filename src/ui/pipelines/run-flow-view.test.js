import { describe, expect, test } from "bun:test";

import { buildStateLedgerRows, renderStateLedger, renderStepCardTimeline } from "./run-flow-view.js";

const run = {
  id: "run-1",
  input: {
    prompt: "same",
    task: { title: "Draft" },
  },
};

const steps = [
  {
    id: "step-1",
    stepIndex: 1,
    name: "Plan",
    kind: "code",
    status: "ok",
    input: { prompt: "same" },
    metadata: {
      input: { pick: { prompt: "$.prompt" } },
      assign: "$.plan",
      executor: { kind: "function", function: "plan.build" },
    },
    output: { plan: { summary: "Do the work" } },
    result: {
      prompt: "same",
      task: { title: "Draft" },
      plan: { summary: "Do the work" },
    },
  },
  {
    id: "step-2",
    stepIndex: 2,
    name: "Review",
    kind: "agent",
    status: "ok",
    input: { plan: { summary: "Do the work" } },
    metadata: {
      input: "$.plan",
      assign: "$.task",
      executor: { kind: "agent", agent: "codex" },
    },
    output: { task: { title: "Ready" }, confidence: 0.8 },
    result: {
      prompt: "same",
      task: { title: "Ready" },
      plan: { summary: "Do the work" },
      confidence: 0.8,
    },
  },
];

describe("pipeline run flow visualization", () => {
  test("attributes ledger paths to the last step that changed them", () => {
    const rows = buildStateLedgerRows(run, steps);
    const taskTitle = rows.find((row) => row.path === "$.task.title");
    const planSummary = rows.find((row) => row.path === "$.plan.summary");
    const prompt = rows.find((row) => row.path === "$.prompt");

    expect(taskTitle?.writer.stepName).toBe("Review");
    expect(planSummary?.writer.stepName).toBe("Plan");
    expect(prompt?.writer.stepName).toBe("Initial input");
  });

  test("can build a ledger as of a specific step", () => {
    const rows = buildStateLedgerRows(run, steps, 1);

    expect(rows.find((row) => row.path === "$.plan.summary")?.writer.stepName).toBe("Plan");
    expect(rows.some((row) => row.path === "$.confidence")).toBe(false);
  });

  test("renders timeline cards with read output and write paths", () => {
    const html = renderStepCardTimeline({ selectedRun: { steps }, selectedStep: null }, run, steps);

    expect(html).toContain('data-testid="pipeline-step-card-timeline"');
    expect(html).toContain("prompt &lt;- $.prompt");
    expect(html).toContain("$.plan");
    expect(html).toContain("$.task");
    expect(html).toContain("plan.build");
  });

  test("renders the state ledger table", () => {
    const html = renderStateLedger(run, steps);

    expect(html).toContain('data-testid="pipeline-state-ledger"');
    expect(html).toContain('role="table"');
    expect(html).toContain("$.confidence");
    expect(html).toContain("Review");
  });
});
