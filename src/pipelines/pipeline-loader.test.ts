import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPipelineDefinition,
  getSharedPipelineDefinitionsDirectory,
  listLatestPipelineDefinitions,
  makePipelineSlug,
  nextVersionedDefinitionPath,
  nextVersionedDefinitionPathForSource,
  selectLatestPipelineDefinitions,
  type PipelineDefinitionRecord,
} from "./pipeline-loader";

let tempDir: string;
let previousPipelineRoot: string | undefined;

beforeEach(async () => {
  previousPipelineRoot = process.env.WINGMEN_PIPELINES_ROOT;
  tempDir = await mkdtemp(join(tmpdir(), "wingmen-pipeline-loader-test-"));
  process.env.WINGMEN_PIPELINES_ROOT = tempDir;
});

afterEach(() => {
  if (previousPipelineRoot === undefined) {
    delete process.env.WINGMEN_PIPELINES_ROOT;
  } else {
    process.env.WINGMEN_PIPELINES_ROOT = previousPipelineRoot;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pipeline definition version paths", () => {
  test("creates stable slugs from prompts", () => {
    expect(makePipelineSlug("Split paragraphs, analyse #2, then finalise!")).toBe("split-paragraphs-analyse-2-then-finalise");
  });

  test("allocates the next version without overwriting prior declarations", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "paragraph-analysis.v1.json"), "{}\n");
    writeFileSync(join(tempDir, "paragraph-analysis.v2.json"), "{}\n");

    await expect(nextVersionedDefinitionPath(tempDir, "paragraph-analysis")).resolves.toBe(
      join(tempDir, "paragraph-analysis.v3.json"),
    );
    await expect(nextVersionedDefinitionPathForSource(join(tempDir, "paragraph-analysis.v2.json"))).resolves.toBe(
      join(tempDir, "paragraph-analysis.v3.json"),
    );
  });

  test("selects only the latest declaration per versioned slug", () => {
    const records = [
      makeRecord("article-review.v1", 1),
      makeRecord("article-review.v3", 3),
      makeRecord("article-review.v2", 2),
      makeRecord("other-workflow", undefined),
    ];

    expect(selectLatestPipelineDefinitions(records).map((record) => record.slug)).toEqual([
      "article-review.v3",
      "other-workflow",
    ]);
  });

  test("resolves seeded dispatch definitions by stable slug", async () => {
    const definition = await getPipelineDefinition("agent-dispatch-chat", "tester");

    expect(definition?.id.startsWith("shared:")).toBe(true);
    expect(definition?.slug).toBe("agent-dispatch-chat");
    expect(definition?.name).toBe("agent-dispatch-chat");
    expect(definition?.spec.steps.map((step) => step.name)).toEqual([
      "hydrate-chat-context",
      "prepare-intent-input",
      "analyse-intent",
      "normalise-decision",
      "detect-review-approval",
      "complete-review-task-from-chat",
      "route-discussion-chat",
      "start-discussion-pipeline",
      "create-in-progress-task",
      "start-selected-pipeline",
      "block-task-on-launch-failure",
      "reload-chat-thread-before-reply",
      "prepare-chat-response",
      "publish-chat-response",
    ]);
    expect(definition?.spec.steps.find((step) => step.name === "analyse-intent")).toMatchObject({
      when: { path: "$.chatContext.shouldProceed", equals: true },
    });
    expect(JSON.stringify(definition?.spec.steps.find((step) => step.name === "analyse-intent"))).toContain(
      "One valid intent is ignore",
    );
    expect(JSON.stringify(definition?.spec.steps.find((step) => step.name === "analyse-intent"))).toContain(
      "choose do-and-review",
    );
    expect(JSON.stringify(definition?.spec.steps.find((step) => step.name === "analyse-intent"))).toContain(
      "set scopeId null and continue",
    );
    expect(definition?.spec.steps.find((step) => step.name === "publish-chat-response")).toMatchObject({
      when: { path: "$.chatContext.shouldProceed", equals: true },
    });
  });

  test("skips invalid definition files instead of failing the whole definitions list", async () => {
    await getPipelineDefinition("agent-dispatch-chat", "tester");
    writeFileSync(join(getSharedPipelineDefinitionsDirectory(), "broken.json"), "{ not valid json\n");

    const definitions = await listLatestPipelineDefinitions("tester");

    expect(definitions.some((definition) => definition.slug === "agent-dispatch-chat")).toBe(true);
    expect(definitions.some((definition) => definition.slug === "broken")).toBe(false);
  });

  test("seeds task pipeline handoff steps explicitly", async () => {
    const intake = await getPipelineDefinition("agent-dispatch-task-response", "tester");
    const software = await getPipelineDefinition("software-implementation-manager-review", "tester");
    const generic = await getPipelineDefinition("do-and-review", "tester");
    const research = await getPipelineDefinition("research-and-report", "tester");
    const implementationLoop = await getPipelineDefinition("software-implementation-review-loop", "tester");
    const implementationLoopAlias = await getPipelineDefinition("implementation-review-loop.v2", "tester");

    expect(intake?.spec.steps.map((step) => step.name)).toEqual([
      "investigate-and-route-task",
      "normalise-work-plan",
      "move-task-to-in-progress",
      "start-follow-up-pipeline",
      "publish-task-update",
    ]);
    expect(software).toBeNull();
    expect(generic?.spec.steps.at(-1)).toMatchObject({
      name: "move-task-to-review",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
    });
    expect(research?.spec.steps.at(-1)).toMatchObject({
      name: "move-task-to-review",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
    });
    expect(implementationLoop?.spec.steps[0]).toMatchObject({
      name: "ensure-review-loop-task",
      type: "code",
      function: "dispatch.ensureImplementationReviewTask",
    });
    expect(implementationLoopAlias?.slug).toBe("software-implementation-review-loop");
    expect(implementationLoop?.spec.default).toBe(true);
    expect(implementationLoop?.spec.tags).toContain("software");
    expect(implementationLoop?.spec.steps.find((step) => step.name === "comment-manager-progress")).toMatchObject({
      type: "code",
      function: "dispatch.commentImplementationReviewProgress",
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "ensure-review-loop-task")?.input).toMatchObject({
      pick: {
        designDocumentUrl: "$.designDocumentUrl",
        designDocumentUnavailableReason: "$.designDocumentUnavailableReason",
      },
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "implementation-worker")?.input).toMatchObject({
      pick: {
        designDocumentUrl: "$.createdTask.workPlan.designDocumentUrl",
        designDocumentUnavailableReason: "$.createdTask.workPlan.designDocumentUnavailableReason",
      },
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "managerial-review")?.input).toMatchObject({
      pick: {
        designDocumentUrl: "$.createdTask.workPlan.designDocumentUrl",
        designDocumentUnavailableReason: "$.createdTask.workPlan.designDocumentUnavailableReason",
      },
    });
    expect(implementationLoop?.spec.steps.at(-1)).toMatchObject({
      name: "close-review-task",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
    });
    expect(generic?.spec.steps.find((step) => step.name === "do-work")?.input).toEqual({
      pick: {
        createdTask: "$.createdTask",
        workPlan: "$.workPlan",
      },
    });
    expect(generic?.spec.steps.find((step) => step.name === "do-work")?.prompt).toContain(
      "do not return callback status needs_input; return callback status ok with completed false",
    );
    expect(generic?.spec.steps.find((step) => step.name === "manager-review")?.prompt).toContain(
      "handoffable partial outcome",
    );
    expect(research?.spec.steps.find((step) => step.name === "report-writer")?.input).toEqual({
      pick: {
        commandPrefix: "$.runtime.commandPrefix",
        createdTask: "$.createdTask",
        workPlan: "$.workPlan",
        researchResult: "$.researchResult",
      },
    });
  });
});

function makeRecord(slug: string, version: number | undefined): PipelineDefinitionRecord {
  return {
    id: `id-${slug}`,
    slug,
    name: slug.startsWith("article-review") ? "Article Review" : "Other Workflow",
    scope: "user",
    ownerAlias: "tester",
    path: join(tempDir, `${slug}.json`),
    spec: {
      name: slug,
      version,
      steps: [{ name: "step", type: "code", function: "text.normalise" }],
    },
  };
}
