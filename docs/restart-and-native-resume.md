# Restart and native-resume agent sessions

Autopilot supports a managed restart mode that stops every active agent session, records the source session IDs durably, restarts Autopilot, and creates replacement sessions using each coding agent's native session ID.

## Safety

The operation validates every active session before stopping anything. If a session has no captured native session ID, or its agent does not support native resume, the API returns `409` with a `blockers` list and leaves all sessions running.

If stopping one session fails, Autopilot attempts to native-resume any sessions it already stopped and cancels the restart. The restart marker is stored under `~/.wingmen/restart.json` so the startup recovery list survives the server process exiting.

## Admin UI

Open the Wingman Server card and choose **Restart & Resume Agents**. The existing **Restart Wingman** action remains the warm-restart option that preserves running agent processes.

## API and CLI

Call `POST /api/system/restart-and-resume` with NIP-98 authentication. The endpoint accepts system administrators and the configured Wingman instance identity. This narrow exception lets a Wingman agent schedule this restart without granting it general system-management access.

From an agent session or operator shell:

```bash
bun clis/status.ts restart-resume
```

Use `GET /api/system/restart/status` or `bun clis/status.ts restart-status` to inspect the most recent outcome after Autopilot returns.

## Declarative pipelines

The built-in code function `system.restartAndResume` signs and calls the API with the Wingman instance identity. Pass an explicit `autopilotUrl` in the step input. The function returns `status`, `scheduled`, `statusCode`, `sessions`, `blockers`, and `error` fields.

Because a successful call restarts the process, make this the final meaningful step in a pipeline. Add display metadata that exposes `scheduled`, `sessions`, and `error` rather than runtime routing fields.
