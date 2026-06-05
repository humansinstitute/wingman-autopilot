import { describe, expect, test } from "bun:test";

import {
  buildAssignedOutputRows,
  buildExplicitDisplayRows,
  buildFallbackDisplayRows,
} from "./display-fields.js";

describe("pipeline display fields", () => {
  test("resolves explicit input and output display fields", () => {
    const step = {
      input: {
        chatDispatchInput: {
          latestThread: [
            { authorName: "Pete", body: "Can you check the pipeline?" },
            { authorName: "wm21", body: "I will inspect it." },
          ],
        },
      },
      output: {
        intent: "software_implementation",
        dispatchTask: true,
      },
      metadata: {
        display: {
          in: [
            { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages" },
          ],
          out: [
            { label: "Intent", path: "$.intent" },
            { label: "Task?", path: "$.dispatchTask" },
          ],
        },
      },
    };

    expect(buildExplicitDisplayRows(step, "in")).toEqual([
      {
        name: "Thread",
        value: "2 messages: Pete: Can you check the pipeline? | wm21: I will inspect it.",
      },
    ]);
    expect(buildExplicitDisplayRows(step, "out")).toEqual([
      { name: "Intent", value: "software_implementation" },
      { name: "Task?", value: true },
    ]);
  });

  test("uses empty text for missing explicit fields when configured", () => {
    const rows = buildExplicitDisplayRows({
      output: {},
      metadata: {
        display: {
          out: [
            { label: "Thread", path: "$.thread.messages", format: "messages", empty: "No thread loaded" },
          ],
        },
      },
    }, "out");

    expect(rows).toEqual([{ name: "Thread", value: "No thread loaded" }]);
  });

  test("skips empty explicit fields unless empty text is configured", () => {
    const rows = buildExplicitDisplayRows({
      output: { pipelineDefinitionId: null, dispatchTask: false },
      metadata: {
        display: {
          out: [
            { label: "Pipeline", path: "$.pipelineDefinitionId" },
            { label: "Dispatch Task", path: "$.dispatchTask" },
          ],
        },
      },
    }, "out");

    expect(rows).toEqual([{ name: "Dispatch Task", value: false }]);
  });

  test("fallback hides known plumbing without privileging chat fields", () => {
    const rows = buildFallbackDisplayRows({
      dispatch: { routeId: "route-1" },
      runtime: { commandPrefix: "wm" },
      chat: { messageText: "Can you check the pipeline?", channelId: "chan-1" },
      value: "visible",
    });

    expect(rows).toEqual([
      { name: "chat", value: { messageText: "Can you check the pipeline?", channelId: "chan-1" } },
      { name: "value", value: "visible" },
    ]);
  });

  test("assigned output rows use fallback filtering below the assign path", () => {
    const rows = buildAssignedOutputRows("$.chatDispatchInput", {
      objective: "Classify the latest chat request.",
      source: { routeId: "route-1" },
      validChildPipelines: [{ name: "do-and-review" }],
    });

    expect(rows).toEqual([
      { name: "chatDispatchInput.objective", value: "Classify the latest chat request." },
    ]);
  });
});
