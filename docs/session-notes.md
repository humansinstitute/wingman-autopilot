# Session Investigation Notes

## 2025-11-09
- Confirmed the agent `GET /events` SSE endpoint is implemented inside the agent binary (`~/code/agentapi/lib/httpapi/server.go:368-520`). It emits `message_update`, `status_change`, and `screen_update` events via `EventEmitter` (`lib/httpapi/events.go`).
- Wingmen’s backend tracker (`src/server.ts:2960-3132`) currently consumes that stream with Bun `fetch`, only using the `status_change` payloads to populate `ProcessManager.setAgentRuntimeStatus`.
- The regular chat transcript inside Wingmen still polls `/messages` via `fetchAgentMessages` (`src/agents/agent-client.ts:83-138`); the SSE stream exists purely for real-time runtime-status, so message polling and SSE serve different data-access patterns (snapshot vs push).
- The observed `[agent-status] SSE stream error … The operation timed out` logs originate from Bun timing out idle SSE connections. The agent stream stays silent when no status/message delta occurs (see `EventEmitter.UpdateStatusAndEmitChanges`), so Bun drops the connection after its default timeout and the tracker immediately retries.
- Multi-session symptom: each running session now has a watcher loop that reconnects every time Bun times out. When multiple sessions are active, their synchronized reconnects spam the log and compete for agent bandwidth, which may look like earlier sessions “stopping” even though their subprocesses keep running.
- Next steps: either add heartbeat traffic/longer timeouts to the tracker fetch, or switch to an actual `EventSource`-style client that tolerates idle periods (matching how the browser client under `~/code/agentapi/chat/src/components/chat-provider.tsx` handles it). In parallel, verify whether the reconnection churn is starving agents or if another layer (message-store/polling) causes the perceived stoppage.
- Follow-up Q&A:
  - The bundled `ChatProvider` only reconnects SSE when the component remounts or the `EventSource.onerror` handler fires; there’s no visibility/focus listener, so background tabs keep the same connection until the browser suspends it.
  - AgentAPI already exposes polling-friendly endpoints for both transcripts and status (`GET /messages`, `GET /status`). We could abandon SSE for runtime status by polling `/status` on an interval; trade-off is higher latency plus extra requests per active session, but it avoids the Bun `fetch` timeout churn entirely.
  - Refreshing the control UI obviously tears down the EventSource and starts a new one; simply focusing the tab does not currently trigger any reconnect hook.
  - Reliability options from AgentAPI: `/status` responds with `{ status, agent_type }` (same payload as `status_change` events) and `/messages` mirrors `message_update`. Polling those on a cadence would be semantically equivalent to the SSE feed, just less efficient.

### Plan: migrate runtime status tracking to polling
1. **Add polling helper**: create a small utility (e.g., `pollAgentStatus(sessionId, port)`) that hits `GET /status` via `buildAgentUrl` and returns `{ status, agent_type }`. Place it near other agent-client helpers so both server and future UI code can reuse it.
2. **Replace tracker loop**: remove the SSE-driven `AgentRuntimeStatusTracker` in `src/server.ts` and instead schedule a Bun `setInterval` for each running session (e.g., every 2–5 s) that calls the helper and invokes `manager.setAgentRuntimeStatus`. Stop the interval when the session stops.
3. **Backoff & error handling**: if polling fails (agent offline), log once per session and exponentially back off to avoid flooding. When the poll recovers, immediately update runtime status so the UI reflects the change.
4. **Config hooks**: expose polling cadence/timeout in `config` so operators can tune for their hardware (e.g., slower cadence on constrained boxes).
5. **Cleanup & docs**: delete the SSE-specific code path and update `docs/architecture.md` / `claude.md` to note that status now comes from `/status` polling; message hydration still relies on `/messages` snapshots.
