# Command Dropdown Control Actions

This document describes the plan for extending the Wingmen live session composer to send terminal control keystrokes via the existing “Cmd” dropdown. The goal is to complement normal prompt messages without introducing a separate control/text mode.

## Current State

- The composer dropdown (`src/ui/app.js:4503-4546`) only surfaces ancillary UI actions such as scroll, copy chat, and attachment uploads.  
- `sendMessage(sessionId, content)` (`src/ui/app.js:2912-2970`) always POSTs `{ type: "user", content }` to `/api/sessions/:id/messages` and enforces non-empty text.  
- The server handler (`src/server.ts:2397-2435`) forwards `{ type: "user", content }` to the agent and trims whitespace.  
- Lower-level plumbing (`src/agents/agent-client.ts:77-122`) already supports alternate message types, including `"raw"`.

## Functional Requirements

1. Extend the composer’s command dropdown so operators can click entries that send specific control keystrokes—e.g. Up, Down, Return, Esc, Ctrl+C, Ctrl+R, Ctrl+L.  
2. Triggering one of these actions sends `{"type":"raw","content":"<escape sequence>"}` directly to the agent terminal. Resulting terminal state changes appear in the Raw Terminal Output panel; no conversation bubble should be created.  
3. Provide quick, self-clearing UI feedback (for example, a small badge or toast) that shows which control key was dispatched. This must not interfere with the existing message draft UI.  
4. Preserve the normal text workflow: pressing Enter in the composer continues to send `"user"` messages and refresh the conversation transcript as before.

## Frontend Changes

- Define a `CONTROL_ACTIONS` list near the top of `src/ui/app.js` that maps friendly labels to escape sequences (`ArrowUp → "\x1b[A"`, `Return → "\r"`, etc.).  
- Add a helper `postSessionMessage(sessionId, content, type = "user")` that wraps the fetch logic so both text and control actions use the same endpoint call.  
- Implement `sendControlCommand(sessionId, action)` alongside `sendMessage`:
  - Calls `postSessionMessage(sessionId, action.sequence, "raw")`.  
  - Handles errors with the existing alert pattern.  
  - Pushes the action display label into a short-lived feedback queue stored in `state.controlFeedback` (a map keyed by `sessionId`).  
- Update the command dropdown builder (`renderComposer`) to render a new “Terminal controls” section that lists each control action as a button invoking `sendControlCommand`.  
- Render the feedback UI (e.g. a row of fading chips) near the composer shell. Add matching CSS (`.wm-control-feedback`, `.wm-control-chip`) in `src/ui/styles.css`.

## Backend Changes

- Update the `/api/sessions/:id/messages` POST branch (`src/server.ts:2397-2435`) to accept an optional `"type"` field.  
  - Validate the value is `"user"` (default) or `"raw"`.  
  - Skip `trim()` when `type === "raw"` so control sequences like `"\x1b[A"` or `"\r"` remain intact; reject only if the content string is empty.  
  - Forward `{ type, content }` to the agent. For `"raw"` messages, return `{ ok: true }` immediately without forcing a conversation sync; keep existing behaviour for `"user"`.

## Shared Client Logic

- Ensure all other callers that rely on message posting (file watcher automation, presets) explicitly pass `"user"`; they can reuse `postSessionMessage`.  
- Maintain the existing message draft storage (`state.messageDrafts`) untouched so switching between text prompts and command clicks stays seamless.

## Documentation & Validation

- Mention the new control buttons in Wingmen user-facing docs or onboarding material.  
- Manual test script:
  1. Launch a session, send a standard prompt, verify conversation update.  
  2. Use “Cmd → Up” to recall the previous terminal command; observe Raw Terminal Output update.  
  3. Use “Cmd → Ctrl+C” to interrupt a running process.  
  4. Confirm no new chat bubbles appear for control actions and feedback UI clears promptly.  
- Optional automated test: POST to `/api/sessions/:id/messages` with `type:"raw"` in a headless integration and expect a `200 OK` response with no conversation change.

## Rollout Notes

- Verify the AgentAPI binary used by Wingmen is recent enough to support `type: "raw"` messages (already true for current builds).  
- Communicate the availability of control commands to operators; collect feedback for additional sequences that may be valuable later.

