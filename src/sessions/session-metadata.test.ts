import { describe, expect, test } from "bun:test";

import { normaliseSessionMetadata } from "./session-metadata";

describe("normaliseSessionMetadata", () => {
  test("normalises autonomous hook metadata fields", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: true,
        billingMode: "credits",
        goal: "  Finish the release checklist  ",
        nextAction: "REFLECT" as never,
        nextActionPayload: "  Focus on tests first  ",
        nextActionTemplate: "  Current goal: {{goal}}  ",
        bindingType: "FLOW_RUN" as never,
        bindingId: "  thread-123  ",
        flowId: "  flow-1  ",
        flowRunId: "  run-9  ",
      }),
    ).toMatchObject({
      AGENT: true,
      billingMode: "credits",
      goal: "Finish the release checklist",
      nextAction: "reflect",
      nextActionPayload: "Focus on tests first",
      nextActionTemplate: "Current goal: {{goal}}",
      bindingType: "flow_run",
      bindingId: "thread-123",
      flowId: "flow-1",
      flowRunId: "run-9",
    });
  });

  test("drops invalid autonomous hook values while preserving backward compatibility", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: false,
        billingMode: "subscription",
        goal: "   ",
        nextAction: "launch" as never,
        nextActionPayload: "   ",
        nextActionTemplate: "   ",
        bindingType: "job" as never,
        bindingId: "   ",
        flowId: "   ",
        flowRunId: "   ",
      }),
    ).toMatchObject({
      AGENT: false,
      billingMode: "subscription",
    });
  });

  test("accepts flow orchestration binding metadata", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: true,
        billingMode: "subscription",
        bindingType: "FLOW_ORCHESTRATION" as never,
        bindingId: "  run-42  ",
      }),
    ).toMatchObject({
      AGENT: true,
      billingMode: "subscription",
      bindingType: "flow_orchestration",
      bindingId: "run-42",
    });
  });
});
