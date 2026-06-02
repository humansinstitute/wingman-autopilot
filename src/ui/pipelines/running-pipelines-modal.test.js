import { describe, expect, test } from "bun:test";

import {
  getActivePipelineRuns,
  getPipelineRunDisplayName,
  getPipelineStepSessionId,
  isActivePipelineRun,
  renderRunningPipelineAgentSessionLink,
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

  test("renders an agent session link for pipeline steps with sessions", () => {
    const step = { wingmanSessionId: "session with/slash" };

    expect(getPipelineStepSessionId(step)).toBe("session with/slash");

    const html = renderRunningPipelineAgentSessionLink(step);
    expect(html).toContain('href="/live/session%20with%2Fslash"');
    expect(html).toContain('aria-label="Open agent session session with/slash"');
    expect(html).toContain('data-testid="running-pipeline-agent-session-link"');
  });

  test("omits the agent session link when a step has no session id", () => {
    expect(getPipelineStepSessionId({ wingmanSessionId: "   " })).toBe(null);
    expect(renderRunningPipelineAgentSessionLink({ kind: "code" })).toBe("");
  });
});
