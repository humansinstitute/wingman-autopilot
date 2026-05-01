import { describe, expect, test } from "bun:test";

import { renderRunsWorkspace } from "./runs-view.js";

function makeState() {
  return {
    runs: [],
    runSearch: "",
    runFilter: "all",
    selectedRunTab: "overview",
    selectedRun: {
      run: {
        id: "run-1",
        name: "Pipeline run",
        status: "ok",
        input: {},
        result: {},
        startedAt: "2026-05-01T01:00:00.000Z",
        completedAt: "2026-05-01T01:01:00.000Z",
      },
      steps: [
        {
          id: "step-1",
          stepIndex: 1,
          name: "Extract summary",
          kind: "agent",
          status: "ok",
          wingmanSessionId: "session-1",
        },
      ],
    },
    selectedStep: {
      step: {
        id: "step-1",
        name: "Extract summary",
        status: "ok",
        input: { prompt: "same" },
        result: { prompt: "same", summary: "new output" },
        wingmanSessionId: "session-1",
      },
      events: [],
      callbacks: [],
      previousSteps: [],
    },
  };
}

describe("pipeline run detail rendering", () => {
  test("renders selected step details in a full screen modal", () => {
    const html = renderRunsWorkspace(makeState());

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="pipeline-step-modal"');
    expect(html).toContain('data-action="close-step-detail"');
  });

  test("keeps source input and output collapsed below the transform", () => {
    const html = renderRunsWorkspace(makeState());

    expect(html).toContain('data-testid="pipeline-transform-block"');
    expect(html).toContain('class="wm-pipeline-step-data-panel"');
    expect(html).toContain("<summary>Input</summary>");
    expect(html).toContain("<summary>Output</summary>");
    expect(html).not.toContain('<details class="wm-pipeline-step-data-panel" open');
  });
});
