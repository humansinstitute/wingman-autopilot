# Declarative Pipelines

Wingmen pipelines are JSON definitions where every step receives a JSON object and finishes with a JSON object. The pipeline runner keeps run history in SQLite and shows definitions, runs, step inputs, step outputs, callbacks, and events in the `/pipelines` UI.

## Storage

Definitions live under the local Wingmen pipeline root:

```text
~/.wingmen/pipelines/
  shared/definitions/
  shared/functions/
  users/<three-word-alias>/definitions/
  users/<three-word-alias>/functions/
```

Shared definitions are visible to authenticated users. User definitions are loaded from the effective owner alias for the signed-in user. Runtime history is stored in `data/pipelines.sqlite` inside the Wingmen repo by default, or `WINGMEN_PIPELINES_DB` when that env var is set.

The pipeline root is initialized as a Git repository so generated definitions and functions can be diffed, reviewed, committed, and rolled back. Runtime state should stay in SQLite, not in this Git repo.

## Shape

A pipeline definition is a JSON object:

```json
{
  "name": "demo-declarative-pipeline",
  "description": "Short human-readable description.",
  "version": 1,
  "input": {
    "text": "Classify this text"
  },
  "steps": [
    {
      "name": "normalise",
      "description": "Prepare the text for later steps.",
      "type": "code",
      "function": "text.normalise",
      "input": { "pick": { "text": "$.text" } },
      "assign": "$.normalised"
    },
    {
      "name": "classify",
      "type": "agent",
      "agent": "codex",
      "directory": "/Users/mini/wingmen/wingman21",
      "timeoutMs": "$.agentTimeoutMs",
      "input": { "pick": { "text": "$.normalised.text" } },
      "prompt": "Classify the input and return kind, reason, and confidence.",
      "assign": "$.agentRaw"
    }
  ]
}
```

## Step Types

`code` steps call a registered TypeScript function by name. Built-ins currently include:

- `text.normalise`
- `text.paragraphs`
- `text.features`
- `agent.parseClassification`
- `agent.parseParagraphAnalysis`
- `route.byKind`
- `object.finalise`

Agent steps can set `timeoutMs` as milliseconds or as a JSON path. If omitted, the runner waits 10 minutes for the callback. When a timeout fires, the run is marked as an error and the pipeline session is stopped; the runner does not send a reminder prompt.
- `object.finaliseParagraphAnalysis`
- `review.appendIteration`
- `review.finaliseDesignReview`
- `memory.searchEntities`
- `memory.consolidateGraphContext`

User-defined functions are loaded from disk at run time. They can live in shared or user scope:

```text
~/.wingmen/pipelines/shared/functions/
~/.wingmen/pipelines/users/<three-word-alias>/functions/
```

Function files may be `.ts`, `.js`, or `.mjs`. A function file should default-export an async or sync function that accepts one JSON object and returns one JSON object:

```ts
export const name = "user.extractOptions";
export const description = "Extract options from a prompt.";
export const version = 1;

export default async function run(input: Record<string, unknown>) {
  return {
    options: [],
    prompt: String(input.prompt ?? "")
  };
}
```

If `name` is omitted, the loader derives a scoped function name from the filename, such as `user.extractOptions`. Built-in function names cannot be overridden; duplicate names are listed as `shadowed` and are not registered.

Function registry metadata is available at:

```text
GET /api/pipelines/functions
```

`block` steps expand into reusable step groups. Blocks are for common multi-step patterns that should be declared once and reused across pipelines.

The first built-in block is `memory.graphContext`. It runs a three-step memory recall flow:

1. agent step extracts searchable entities from the prompt
2. code step runs parallel vector searches against graph memory for each entity
3. code step consolidates matches into `graphContext`

```json
{
  "name": "recall-graph-memory",
  "type": "block",
  "block": "memory.graphContext",
  "input": {
    "pick": {
      "prompt": "$.prompt",
      "topKPerEntity": "$.topKPerEntity",
      "maxChars": "$.graphContextMaxChars",
      "agent": "$.memoryAgent",
      "directory": "$.workingDirectory"
    }
  },
  "assign": "$.memory.graph"
}
```

Agent steps can then consume:

```json
{
  "pick": {
    "prompt": "$.prompt",
    "graphContext": "$.memory.graph.graphContext",
    "graphContextSources": "$.memory.graph.graphContextSources"
  }
}
```

Standard prompt wording:

```text
graphContext is potential context from long-term memory. Treat it as a guide, not authoritative truth. Consider it where relevant, and verify against current files, records, or user input before relying on it.
```

Graph memory configuration is optional. Without it, `memory.searchEntities` returns no matches plus warnings. To enable Neo4j vector search, configure:

- `NEO4J_HTTP_URL` or `PIPELINE_MEMORY_NEO4J_HTTP_URL`
- `NEO4J_USERNAME` / `NEO4J_PASSWORD`
- `NEO4J_VECTOR_INDEX` or `PIPELINE_MEMORY_NEO4J_VECTOR_INDEX`
- `OPENAI_API_KEY` or `PIPELINE_MEMORY_EMBEDDING_API_KEY`
- optional `PIPELINE_MEMORY_EMBEDDING_MODEL`, default `text-embedding-3-small`

`loop` steps can act as explicit loop-control steps. In that shape, the preceding steps stay visible as normal top-level steps, and the loop step appends captured output to history before jumping back to a named target until `iterations` is reached.

```json
{
  "name": "loop-to-critic",
  "type": "loop",
  "target": "critic-pass",
  "iterations": "$.reviewIterations",
  "counter": "$.reviewLoop",
  "history": "$.reviewHistory",
  "capture": {
    "critic": "$.iteration.critic",
    "response": "$.iteration.response"
  }
}
```

The runner also supports a compact container-loop form with nested `steps`, but the design-review demo uses the explicit control step because it is easier to inspect and visualize.

See `docs/declarative-pipeline-loop-design.md` for the loop design notes.

`agent` steps create a Wingmen session and send a strict completion contract to the agent. The agent must POST a JSON object back to the callback URL with the provided `x-wingmen-pipeline-token` header. The accepted body is:

```json
{
  "runId": "pipeline-run-id",
  "stepId": "pipeline-step-id",
  "status": "ok",
  "result": {}
}
```

`status` can be `ok`, `needs_input`, or `error`. `result` must always be a JSON object. The runner waits for this callback and records the accepted callback payload against the step.

## Selectors

Each step can omit `input` to receive the current pipeline object, or use:

```json
{ "pick": { "fieldName": "$.path.to.value" } }
```

Use `assign` to merge the step result into the current object at a JSON path. If `assign` is omitted, the step result replaces the current object.

## Conditional Steps

A step can include a simple equality guard:

```json
{
  "when": { "path": "$.classification.kind", "equals": "decision" }
}
```

Skipped steps are recorded with `status: "skipped"` and leave the current object unchanged.

## Demo Pipelines

The loader creates two shared demo definitions if they do not already exist:

- `demo-declarative-pipeline.json`: normalises text, extracts features, asks an agent to classify it, parses the classification, and routes the result.
- `demo-paragraph-two-agent-analysis.json`: splits a three-paragraph text, asks a Wingman agent to analyse paragraph 2, parses the agent's callback result, and returns the selected paragraph plus structured analysis.
- `demo-looped-design-review.json`: accepts a document URL, runs Critic and Response agent steps five times by default, then runs Tidy Up and finalise steps.

## Wizard Creation

The Pipelines UI has a create wizard. Wizard creation starts a Codex session and gives it:

- the user's natural-language description
- the exact target file path under `~/.wingmen/pipelines/users/<three-word-alias>/definitions`
- this documentation file
- the declaration helper and built-in function source files

The agent is expected to write one valid JSON declaration file and validate that it parses. Manual creation is intentionally a UI stub for now.

## Versioning

Wizard-created user definitions use versioned file names:

```text
<slug>.v1.json
<slug>.v2.json
<slug>.v3.json
```

Editing a user definition through the wizard never overwrites the current file. It starts a new Codex session with the source declaration path and a target path for the next version. Shared demo definitions are read-only from the wizard edit UI; copy or recreate them as user definitions before versioning them.
