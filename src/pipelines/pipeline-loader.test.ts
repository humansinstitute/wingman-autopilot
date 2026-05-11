import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPipelineDefinition,
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
    const definition = await getPipelineDefinition("demo-agent-dispatch-chat-response", "tester");

    expect(definition?.id.startsWith("shared:")).toBe(true);
    expect(definition?.slug).toBe("demo-agent-dispatch-chat-response");
    expect(definition?.name).toBe("demo-agent-dispatch-chat-response");
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
