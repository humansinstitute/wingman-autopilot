import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinPipelineFunctions } from "./functions";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { acceptAgentCallback, runDeclarativePipeline } from "./pipeline-runner";
import { PipelineStore } from "./pipeline-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const makeStore = () => new PipelineStore(join(tempDir, "pipelines.sqlite"));

describe("runDeclarativePipeline", () => {
  test("runs object-in object-out code steps and records each step", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "test",
      slug: "test",
      name: "test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "test.json"),
      spec: {
        name: "test",
        input: { text: "  Build declarative JSON pipelines  " },
        steps: [
          {
            name: "normalise",
            type: "code",
            function: "text.normalise",
            input: { pick: { text: "$.text" } },
            assign: "$.normalised",
          },
          {
            name: "features",
            type: "code",
            function: "text.features",
            input: { pick: { text: "$.normalised.text", words: "$.normalised.words" } },
            assign: "$.features",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.features).toMatchObject({ mentionsJson: true, mentionsPipeline: true });
    expect(store.listSteps(run.id).map((step) => step.status)).toEqual(["ok", "ok"]);
  });

  test("can split paragraphs, parse a paragraph analysis, and finalise the result", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "paragraph-test",
      slug: "paragraph-test",
      name: "paragraph-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "paragraph-test.json"),
      spec: {
        name: "paragraph-test",
        input: {
          targetParagraphNumber: 2,
          text: [
            "First paragraph introduces the subject.",
            "Second paragraph contains the decision point that needs agent analysis.",
            "Third paragraph gives the surrounding context.",
          ].join("\n\n"),
        },
        steps: [
          {
            name: "split",
            type: "code",
            function: "text.paragraphs",
            input: { pick: { text: "$.text", targetParagraphNumber: "$.targetParagraphNumber" } },
            assign: "$.document",
          },
          {
            name: "fake-agent-output",
            type: "code",
            function: "test.fakeParagraphAnalysis",
            assign: "$.agentRaw",
          },
          {
            name: "parse",
            type: "code",
            function: "agent.parseParagraphAnalysis",
            input: { pick: { raw: "$.agentRaw", paragraph: "$.document.selectedParagraph" } },
            assign: "$.analysis",
          },
          {
            name: "finalise",
            type: "code",
            function: "object.finaliseParagraphAnalysis",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        ...builtinPipelineFunctions,
        async "test.fakeParagraphAnalysis"() {
          return {
            summary: "The paragraph asks for a decision point to be analysed.",
            sentiment: "neutral",
            keyPoints: ["decision point", "agent analysis"],
            actionRequired: true,
            confidence: 0.9,
          };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.selectedParagraph).toMatchObject({ number: 2 });
    expect(run.result?.analysis).toMatchObject({
      paragraphNumber: 2,
      actionRequired: true,
      keyPoints: ["decision point", "agent analysis"],
    });
  });

  test("runs a flat loop-control step for a bounded number of iterations", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "loop-test",
      slug: "loop-test",
      name: "loop-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "loop-test.json"),
      spec: {
        name: "loop-test",
        input: {
          count: 3,
          reviewLoop: { iteration: 1, index: 0, completed: 0, total: 3, done: false },
        },
        steps: [
          {
            id: "fake-critic",
            name: "fake-critic",
            type: "code",
            function: "test.fakeCritic",
            input: { pick: { loop: "$.reviewLoop" } },
            assign: "$.iteration.critic",
          },
          {
            id: "fake-response",
            name: "fake-response",
            type: "code",
            function: "test.fakeResponse",
            input: { pick: { loop: "$.reviewLoop", critic: "$.iteration.critic" } },
            assign: "$.iteration.response",
          },
          {
            id: "loop-to-critic",
            name: "loop-to-critic",
            type: "loop",
            target: "fake-critic",
            iterations: "$.count",
            counter: "$.reviewLoop",
            history: "$.reviewHistory",
            capture: {
              critic: "$.iteration.critic",
              response: "$.iteration.response",
            },
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        ...builtinPipelineFunctions,
        async "test.fakeCritic"(input) {
          const loop = input.loop as { iteration?: number };
          return { summary: `critic iteration ${loop.iteration}` };
        },
        async "test.fakeResponse"(input) {
          const loop = input.loop as { iteration?: number };
          return { summary: `response iteration ${loop.iteration}` };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect((run.result?.reviewHistory as { items?: unknown[] })?.items).toHaveLength(3);
    expect(store.listSteps(run.id).map((step) => step.kind)).toEqual([
      "code",
      "code",
      "loop",
      "code",
      "code",
      "loop",
      "code",
      "code",
      "loop",
    ]);
    expect(run.result?.reviewLoop).toMatchObject({ completed: 3, done: true });
  });
});

describe("acceptAgentCallback", () => {
  test("requires the callback token and stores accepted callbacks", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition",
      name: "definition",
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      scope: "user",
      input: {},
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "agent",
      kind: "agent",
      input: {},
      callbackToken: "secret-token",
    });

    const rejected = await acceptAgentCallback({
      store,
      runId: run.id,
      stepId: step.id,
      token: "wrong-token",
      payload: { runId: run.id, stepId: step.id, status: "ok", result: {} },
    });

    expect(rejected.status).toBe(401);
    expect(store.getStep(step.id)?.status).toBe("running");

    const accepted = await acceptAgentCallback({
      store,
      runId: run.id,
      stepId: step.id,
      token: "secret-token",
      payload: { runId: run.id, stepId: step.id, status: "ok", result: { answer: "done" } },
    });

    expect(accepted.status).toBe(200);
    expect(store.getStep(step.id)?.result).toEqual({ answer: "done" });
    expect(store.listCallbacksForStep(step.id).map((callback) => callback.accepted)).toEqual([0, 1]);
  });
});
