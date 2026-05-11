import { describe, expect, test } from "bun:test";
import { builtinPipelineFunctions } from "./functions";

describe("memory pipeline functions", () => {
  test("dispatch.publishFlightDeckResponse is a dry-run outside dispatch routes", async () => {
    const result = await builtinPipelineFunctions["dispatch.publishFlightDeckResponse"]!({
      agentResponse: { responseDraft: "hello" },
    });

    expect(result.published).toBe(false);
    expect(result.status).toBe("not_configured");
    expect(result.agentResponse).toEqual({ responseDraft: "hello" });
  });

  test("memory.searchEntities returns an empty graphContext source set when graph memory is not configured", async () => {
    const previous = {
      PIPELINE_MEMORY_NEO4J_HTTP_URL: process.env.PIPELINE_MEMORY_NEO4J_HTTP_URL,
      NEO4J_HTTP_URL: process.env.NEO4J_HTTP_URL,
      NEO4J_URI: process.env.NEO4J_URI,
      PIPELINE_MEMORY_EMBEDDING_API_KEY: process.env.PIPELINE_MEMORY_EMBEDDING_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.PIPELINE_MEMORY_NEO4J_HTTP_URL;
    delete process.env.NEO4J_HTTP_URL;
    delete process.env.NEO4J_URI;
    delete process.env.PIPELINE_MEMORY_EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let result: Record<string, unknown>;
    try {
      result = await builtinPipelineFunctions["memory.searchEntities"]!({
        entities: [
          { name: "Redshift", type: "system", reason: "secret management", query: "Redshift secret management" },
        ],
      });
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }

    expect(result.matches).toEqual([]);
    expect(result.graphMemoryAvailable).toBe(false);
    expect((result.warnings as string[])[0]).toContain("Neo4j graph memory is not configured");
  });

  test("memory.consolidateGraphContext returns graphContext and source metadata", async () => {
    const result = await builtinPipelineFunctions["memory.consolidateGraphContext"]!({
      entities: [{ name: "Redshift", type: "system", query: "Redshift", reason: "secret manager" }],
      matches: [
        {
          id: "node-1",
          entity: "Redshift",
          entityType: "system",
          title: "Redshift Secret Plan",
          source: "docs/redshift-secrets-plan.md",
          score: 0.91,
          excerpt: "Redshift stores encrypted secrets as Nostr events.",
          labels: ["DocumentChunk"],
        },
      ],
      maxChars: 2000,
    });

    expect(result.graphContext).toContain("potential context from long-term memory");
    expect(result.graphContext).toContain("Redshift Secret Plan");
    expect(result.graphContextAvailable).toBe(true);
    expect(result.graphContextSources).toEqual([
      {
        id: "node-1",
        entity: "Redshift",
        entityType: "system",
        title: "Redshift Secret Plan",
        source: "docs/redshift-secrets-plan.md",
        score: 0.91,
        excerpt: "Redshift stores encrypted secrets as Nostr events.",
        labels: ["DocumentChunk"],
      },
    ]);
  });
});
