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
      description: "Build the working plan from the user prompt.",
      input: { pick: { prompt: "$.prompt" } },
      assign: "$.plan",
      executor: { kind: "function", function: "plan.build" },
    },
    output: {
      summary: "Do the work",
      owner: "Pete",
      status: "ready",
      priority: "normal",
      estimate: "short",
      extra: "hidden after five",
      notes: "also hidden",
    },
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
      description: "Review the plan and produce the next task state.",
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

  test("renders timeline cards with input fields output fields and descriptions", () => {
    const html = renderStepCardTimeline({ selectedRun: { steps }, selectedStep: null }, run, steps);

    expect(html).toContain('data-testid="pipeline-step-card-timeline"');
    expect(html).toContain('data-testid="pipeline-step-inspect"');
    expect(html).toContain("Build the working plan from the user prompt.");
    expect(html).toContain("Fields In");
    expect(html).toContain("Fields Out");
    expect(html).not.toContain(">Output</span>");
    expect(html).toContain("<code>prompt</code>");
    expect(html).toContain("&ldquo;same&rdquo;");
    expect(html).toContain("More (1)");
    expect(html).toContain("hidden after five");
    expect(html).toContain("plan.summary");
    expect(html).toContain("task.task");
    expect(html).toContain("plan.build");
  });

  test("uses declarative display fields for the default field summary", () => {
    const plumbingSteps = [{
      id: "step-routing",
      stepIndex: 1,
      name: "Prepare chat",
      kind: "code",
      status: "ok",
      input: {
        dispatch: { routeId: "route-1", triggerKind: "chat", source: "router" },
        runtime: { commandPrefix: "wm" },
        agent: { defaultAgent: "codex" },
        chat: { messageText: "Can you check the pipeline?", channelId: "chan-1" },
      },
      metadata: {
        input: { pick: { dispatch: "$.dispatch", chat: "$.chat", runtime: "$.runtime" } },
        assign: "$.chatDispatchInput",
        description: "Prepare the visible chat request for classification.",
        display: {
          in: [
            { label: "Message", path: "$.chat.messageText" },
          ],
          out: [
            { label: "Objective", path: "$.objective" },
            { label: "Thread", path: "$.latestThread", format: "messages" },
          ],
        },
        executor: { kind: "function", function: "dispatch.prepareChatIntentInput" },
      },
      output: {
        objective: "Classify the latest chat request.",
        latestThread: [{ body: "Can you check the pipeline?" }],
        source: { routeId: "route-1" },
      },
      result: {},
    }];
    const html = renderStepCardTimeline({
      selectedRun: { steps: plumbingSteps },
      selectedStep: null,
    }, run, plumbingSteps);

    expect(html).toContain("<code>Message</code>");
    expect(html).toContain("Can you check the pipeline?");
    expect(html).toContain("<code>Objective</code>");
    expect(html).toContain("<code>Thread</code>");
    expect(html).not.toContain("<code>dispatch</code>");
    expect(html).not.toContain("route-1");
    expect(html).not.toContain("commandPrefix");
  });

  test("does not display data rows for skipped steps", () => {
    const skippedSteps = [{
      id: "step-skipped",
      stepIndex: 1,
      name: "Skipped branch",
      kind: "code",
      status: "skipped",
      input: { prompt: "secret input" },
      output: { result: "secret output" },
      metadata: {
        description: "Only runs when the branch is active.",
        input: { pick: { prompt: "$.prompt" } },
        assign: "$.branch",
        executor: { kind: "function", function: "branch.run" },
        display: {
          in: [{ label: "Prompt", path: "$.prompt" }],
          out: [{ label: "Result", path: "$.result" }],
        },
      },
    }];
    const html = renderStepCardTimeline({
      selectedRun: { steps: skippedSteps },
      selectedStep: null,
    }, run, skippedSteps);

    expect(html).toContain("Skipped branch");
    expect(html).toContain("Skipped");
    expect(html).toContain("No user-facing fields");
    expect(html).not.toContain("secret input");
    expect(html).not.toContain("secret output");
  });

  test("supports explicit agentText display rows", () => {
    const agentSteps = [{
      id: "step-agent-text",
      stepIndex: 1,
      name: "Agent summary",
      kind: "agent",
      status: "ok",
      input: { prompt: "Summarise" },
      output: {
        summary: "Meaning: this npub adv\nertises the inbox.",
      },
      result: {},
      metadata: {
        display: {
          out: [{ label: "Summary", path: "$.summary", format: "agentText" }],
        },
        executor: { kind: "agent", agent: "codex" },
      },
    }];

    const html = renderStepCardTimeline({
      selectedRun: { steps: agentSteps },
      selectedStep: null,
    }, run, agentSteps);

    expect(html).toContain("Meaning: this npub advertises the inbox.");
  });

  test("renders the state ledger table", () => {
    const html = renderStateLedger(run, steps);

    expect(html).toContain('data-testid="pipeline-state-ledger"');
    expect(html).toContain('role="table"');
    expect(html).toContain("$.confidence");
    expect(html).toContain("Review");
  });
});
