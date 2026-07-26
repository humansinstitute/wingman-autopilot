# PG person mention must route Agent Direct Chat

## Goal

Fix Athena's first-class Agent Direct Chat routing when Flight Deck represents the connected bot identity as a `person` mention rather than an `agent` mention.

## Live failing example

- Other Stuff workspace: `6b39f051-3833-46e6-8a59-be9b4eb57639`
- Channel: `b59adb00-50a3-4f5e-92db-5831a4d31a95`
- Thread: `b6139d72-b6a0-4ca7-ae75-f114c48e11b6`
- Source message: `d3afc187-3ef1-4f1b-a7a5-25a35793d95e`
- Tower event row: `112`, `flightdeck_pg.message.created`
- Body mentions Athena bot npub `npub1v6p0js8rs76cfpde03lxmyxnsyrafs27xhxs5h82zlqvaxynzfuqydnvzt`
- Stored mention shape: `{ type: "person", npub: "<Athena bot npub>", label: "Athena Lumia" }`
- Athena subscription cursor advanced through row 116, but there is no intercept, dispatch, session, or response for the message.

Flight Deck task: `b2f3a964-f373-4cb6-9c22-94f2434793f1`.
Origin: message `a2c4989a-fc92-414b-a416-577ce2adb5d8` in workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`, channel `6c89191a-69d6-460a-97d3-f937bd40cfeb`, thread `4daad68a-0ad9-4cc1-b3e3-1152298176a8`.

## Diagnosis

The PG message is valid and the npub is exact. `src/agent-chat/direct-chat-runtime.ts` only extracts mentions whose type is `agent`. Flight Deck's people picker emits a valid workspace identity mention as `person`, so direct chat rejects it before creating an intercept/session.

## Required behavior

- For a verified Flight Deck PG chat message, route when a structured mention's npub equals the subscription/agent bot npub, whether the presentation type is `agent` or `person`.
- Do not route mentions of a different npub.
- Preserve self-authored suppression, signed-instruction validation, Tower access checks, dedupe, and workspace/channel isolation.
- Keep task/document invocation recipient rules unchanged unless evidence proves they share the same presentation contract.
- Add regression coverage using the exact live `person` mention shape in direct-chat runtime and subscription/routing tests as appropriate.
- Update docs if they currently state only `agent` mention records are supported.

## Git and validation

- Work on Autopilot `main` in `/Users/mini/code/wingmanbefree/autopilot`.
- Preserve concurrent work; commit all nonignored tested state, including this handoff.
- Run focused direct-chat, subscription runtime, routing, server and UI tests proportionate to the change.
- Run `git diff --check`.
- Do not deploy, restart Athena, or modify remote runtime state.
- Return commit hash, changed files, focused/full validation, and exact deployment/restart/smoke-test steps.

