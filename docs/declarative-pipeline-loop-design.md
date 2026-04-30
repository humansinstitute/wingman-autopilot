# Declarative Pipeline Loop Design

This note captures the explicit loop-control model for Wingmen declarative pipelines.

## Goal

Pipelines should support repeated agent exchanges without hiding the real work inside one summarized step. A design review loop should read clearly as:

1. Critic agent reviews the current design document.
2. Response agent reviews the document and Critic feedback.
3. Loop control appends that exchange and jumps back to Critic until the counter reaches the configured limit.
4. Tidy Up agent reviews the full conversation and tagged document.
5. Finalise step returns the structured run result.

For five passes, the loop counter uses indexes `0`, `1`, `2`, `3`, and `4`. After the fifth pass the loop step stops jumping and execution continues to Tidy Up.

## Model

Use a top-level `loop` step as the branch point, not as a visual container around the agent steps.

```json
{
  "steps": [
    {
      "id": "critic-pass",
      "name": "critic-pass",
      "type": "agent",
      "assign": "$.iteration.critic"
    },
    {
      "id": "response-pass",
      "name": "response-pass",
      "type": "agent",
      "assign": "$.iteration.response"
    },
    {
      "id": "loop-to-critic",
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
    },
    {
      "id": "tidy-up",
      "name": "tidy-up",
      "type": "agent",
      "assign": "$.tidyUp"
    },
    {
      "id": "finalise-design-review",
      "name": "finalise-design-review",
      "type": "code",
      "function": "review.finaliseDesignReview"
    }
  ]
}
```

The run history records each executed step in order:

```text
critic-pass
response-pass
loop-to-critic
critic-pass
response-pass
loop-to-critic
...
tidy-up
finalise-design-review
```

## Counter State

The pipeline input should seed the counter when the first agent needs to know it is pass zero.

```json
{
  "reviewIterations": 5,
  "reviewLoop": {
    "iteration": 1,
    "index": 0,
    "completed": 0,
    "total": 5,
    "done": false
  }
}
```

After each loop-control step, the runner writes updated state to `counter`. The `index` field is zero-based, while `iteration` is human-readable.

## History

The loop-control step appends captured values into the configured history path:

```json
{
  "reviewHistory": {
    "items": [
      {
        "iteration": 1,
        "critic": {},
        "response": {}
      }
    ]
  }
}
```

The Tidy Up step receives this full history plus the latest annotated document from the Response step.

## Agent Selection

Agent type and working directory can be overridden by run input. The default demo input uses:

```json
{
  "criticAgent": "codex",
  "responseAgent": "codex",
  "tidyAgent": "codex",
  "workingDirectory": "/Users/mini/wingmen/wingman21"
}
```

Each agent step references those paths with `agent: "$.criticAgent"` or equivalent and `directory: "$.workingDirectory"`.

## Safety

`iterations` can be a number or a JSON path. The runner caps loops at 25 iterations to avoid accidental runaway agent sessions.
