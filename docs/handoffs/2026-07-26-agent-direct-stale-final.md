# Prevent stale Agent Direct final publication

Fix the cross-turn final-selection bug in Autopilot Agent Direct chat.

## Exact incident

Pete sent `@[Message](mention:message:b7f1d853-8741-4718-9199-a5c9e4ee743d)` asking Rick to restart Autopilot. Autopilot then published `@[Wrong reply](mention:message:df759d5d-f33c-47ec-88d1-8509705879ae)` three seconds later.

The wrong reply metadata identifies it as `prompt_type: direct_chat` and includes Pete's restart message in `source_message_ids`, but its body is byte-for-byte the previous queued callback response. Routing accepted the new message; final-output selection reused a stale pre-turn final.

Pete's diagnosis request is `@[Message](mention:message:5ea288f7-7c5b-486f-8cb7-bd46057b96fc)`.

## Required behavior

- Publish only a final that was produced after the current direct-chat prompt was accepted/started.
- Bind final selection to a turn boundary or native response identity, not just “latest agent final.”
- Never let queued callback output, manager prompts, or a prior turn's final satisfy a newer human turn.
- Preserve legitimate crash/restart recovery for a final belonging to an already accepted in-flight turn.
- Add a regression reproducing: callback final exists → new human direct prompt starts → stale final remains visible → new output has not arrived. The stale final must not publish.
- Assert the published body and `source_message_ids`, `prompt_type`, turn/client request IDs all correlate to the same turn.

## Work and reporting

- Task: `@[Prevent stale Agent Direct final from answering a newer message](mention:task:f84d4d19-0787-40d8-afea-2b154e23182b)`.
- Work in `/Users/mini/code/wingmanbefree/autopilot` on `main`.
- Preserve concurrent work; commit all nonignored tested state.
- Report findings and evidence on the linked Flight Deck task. Do not reply to chat; Rick owns thread updates.
- Run focused Agent Direct tests and relevant broader validation.
- Do not deploy or restart PM2.
