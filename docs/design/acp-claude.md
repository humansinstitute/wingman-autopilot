# Claude ACP Adapter Design

## Problem

Wingman currently launches Claude sessions through `agentapi`, which wraps the
Claude CLI behind the HTTP/SSE contract used by the live session UI. ACP
provides a structured JSON-RPC transport for coding agents and would let
Wingman talk to Claude through `@agentclientprotocol/claude-agent-acp`.

The goal is to make this available as an opt-in Claude transport so the
operator can test ACP behavior and switch back to the existing `agentapi`
Claude path if needed.

## Goals

- Add an opt-in Claude ACP transport behind a feature flag.
- Preserve the existing `AgentAdapter` interface used by session routes,
  prompt dispatch, readiness checks, and browser event streaming.
- Keep `agentapi` as the default Claude transport.
- Fail visibly when ACP startup, auth, or protocol negotiation fails.
- Avoid broad fallback behavior that hides ACP/runtime errors.
- Keep Tower, NIP-98 identity, session ownership, billing metadata, and
  Flight Deck workspace state outside ACP.

## Non-Goals

- Do not replace the Wingman session model with ACP sessions.
- Do not make ACP the default for all agents in this change.
- Do not add a customer-facing Claude subscription login flow without an
  explicit policy decision.
- Do not auto-approve all Claude tool permission requests in the MVP.
- Do not restart the running Wingman process from inside an agent session.

## Feature Flag

Add a feature flag:

```text
claude-use-acp-adapter
```

Default state: `off`.

When the flag is off, Claude uses the current `agentapi` transport. When the
flag is on, newly created Claude sessions use the ACP adapter. Existing running
sessions should continue using the adapter they were created with.

## Proposed Runtime Shape

```text
ProcessManager
  claude + flag off
    -> spawn current agentapi command wrapping claude
    -> AgentApiAdapter

  claude + flag on
    -> skip agentapi spawn
    -> ClaudeAcpAdapter owns claude-agent-acp subprocess
    -> JSON-RPC over stdio
```

This matches the native Codex pattern more closely than trying to force ACP
through the current HTTP proxy. ACP is a stdio JSON-RPC protocol, so the
adapter should own the child process and translate protocol events into
Wingman's existing adapter event stream.

## Dependencies

Add:

```text
@agentclientprotocol/claude-agent-acp
```

Current research as of 2026-07-12:

- Package version inspected: `0.58.1`.
- Binary: `claude-agent-acp`.
- Runtime engine: Node `>=22`.
- Dependency: `@anthropic-ai/claude-agent-sdk@0.3.205`.

The package README states that it implements an ACP agent using the official
Claude Agent SDK and supports context mentions, images, tool calls with
permission requests, following, edit review, TODO lists, terminals, slash
commands, and client MCP servers.

## Code Structure

Add narrowly scoped files under `src/agents/`:

```text
src/agents/acp-json-rpc-client.ts
src/agents/claude-acp-adapter.ts
src/agents/claude-acp-events.ts
src/agents/claude-acp-adapter.test.ts
src/agents/acp-json-rpc-client.test.ts
```

Keep generic JSON-RPC framing in `acp-json-rpc-client.ts`; keep Claude-specific
event mapping and auth policy in the Claude adapter files.

## Adapter Contract

`ClaudeAcpAdapter` should implement `AgentAdapter`:

- `fetchStatus()`
- `getPromptReadiness()`
- `sendMessage()`
- `fetchMessages()`
- `interruptCurrentTurn()`
- `subscribeToEvents()`
- `dispose()`
- `deliversPromptsDirectly()`
- `getEventsUrl()`

`deliversPromptsDirectly()` should return `true`.

`getEventsUrl()` should return `null`; the adapter will expose browser-facing
events through `subscribeToEvents()`.

## ACP Session Flow

Startup:

1. Spawn `claude-agent-acp` with the session working directory and merged
   Wingman environment.
2. Send `initialize`.
3. Inspect `agentCapabilities` and `authMethods`.
4. Authenticate only through explicitly supported and configured auth paths.
5. Call `session/new` with `cwd`, optional `additionalDirectories`, and MCP
   server configuration when supported.
6. Mark the adapter ready after `session/new` succeeds.

Prompt turn:

1. Record and emit the user message.
2. Call `session/prompt`.
3. Convert `session/update` notifications into Wingman `AgentMessage` records
   and adapter stream events.
4. Mark state as busy until `session/prompt` resolves.
5. Preserve stop reason and protocol errors in logs/events.

Cancellation:

- Use `session/cancel` for the active ACP session.
- Return `true` only when a cancel notification was sent for an active turn.

Dispose:

- Send `session/close` when supported.
- Terminate the ACP subprocess.
- Clear in-memory listeners and pending turn state.

## Message And Event Mapping

Map ACP notifications into the existing Wingman event model:

- `agent_message_chunk` -> assistant message content.
- `user_message_chunk` -> user message content during replay/load.
- `tool_call` and `tool_call_update` -> session log/event metadata in MVP.
- `plan` -> session log/event metadata in MVP.
- `usage_update` -> usage/billing callback if the payload is reliable.
- `session_info_update` -> future metadata/title update; log only in MVP.

The MVP should prioritize readable chat output and visible tool activity over a
full ACP UI. Unsupported ACP update kinds should be logged with their
discriminator instead of being silently dropped.

## Permission Requests

ACP lets agents call `session/request_permission` on the client. The MVP should
not silently approve all permission requests.

Initial policy:

- Surface permission request details into the session log/event stream.
- Allow only clearly safe read-only operations if the ACP request identifies
  them unambiguously and local policy allows them.
- Reject unknown or destructive permission requests with a visible reason.
- Add a later browser approval UI before supporting broad edit/shell approval.

This keeps missing policy/UI state visible instead of hiding it behind a broad
fallback.

## ProcessManager Changes

Update `ProcessManager.createSession()`:

- Detect `agent === "claude"` plus `claude-use-acp-adapter`.
- Skip the `agentapi` spawn when Claude ACP is enabled.
- Still run existing session setup steps:
  - working directory resolution
  - MCP config injection
  - git credential env injection
  - billing env injection
  - session metadata setup
- Construct `ClaudeAcpAdapter` through `resolveAdapterFactory()`.

The adapter gets:

- `id`
- `agent`
- `workingDirectory`
- merged env
- model override, if present
- `recordUsage`, if usage mapping is implemented

## Feature Flag Wiring

Update `src/agents/agent-adapter.ts`:

```ts
export const CLAUDE_ACP_ADAPTER_FLAG = "claude-use-acp-adapter";
```

Add a helper equivalent to the existing Codex/OpenCode helpers:

```ts
export function isClaudeAcpAdapterEnabled(): boolean;
```

Update `resolveAdapterFactory()` so Claude selects `ClaudeAcpAdapter` only when
the flag is effectively `on`. Otherwise it returns `AgentApiAdapter`.

Update feature flag defaults in `src/server.ts`:

```ts
{
  key: CLAUDE_ACP_ADAPTER_FLAG,
  label: "Claude ACP Adapter",
  description: "Use @agentclientprotocol/claude-agent-acp instead of agentapi for Claude sessions.",
  state: "off",
}
```

## Authentication And Claude Subscription Research

### What Is Confirmed

Claude Code itself supports Claude Pro and Max subscription login. Anthropic's
Claude Code authentication docs say individual users can log in with a
Claude.ai account, including Claude Pro or Max subscriptions. The Pro/Max help
article says one subscription covers Claude on web/desktop/mobile and Claude
Code in the terminal, and that IDE usage counts toward the same shared usage
limits.

Claude Code credential precedence is important. Anthropic documents this order:
cloud provider credentials, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, then subscription OAuth credentials
from `/login`. If `ANTHROPIC_API_KEY` is set, it takes precedence over the
subscription credential.

The Claude Agent SDK is different from ordinary Claude Code CLI use. The SDK
quickstart tells developers to use an API key from Claude Console and states
that, unless previously approved, Anthropic does not allow third-party
developers to offer Claude.ai login or rate limits for products built with the
Agent SDK.

Anthropic's legal/compliance page says OAuth authentication is intended for
Free, Pro, Max, Team, and Enterprise subscription users for ordinary use of
Claude Code and other native Anthropic applications. The same page says
developers building products or services that interact with Claude, including
Agent SDK products, should use API key authentication through Claude Console or
a supported cloud provider, and should not route requests through Free, Pro, or
Max credentials on behalf of users.

The `claude-agent-acp@0.58.1` package does include Claude subscription terminal
auth metadata when the ACP client advertises terminal auth support. Its built
bundle also contains a guard that throws:

```text
This integration does not support using claude.ai subscriptions.
```

when Claude auth is hidden and the SDK initialization result reports a
subscription account. This means subscription behavior depends on the adapter's
auth mode and client capabilities, not just on whether the local `claude` CLI
is logged in.

### Practical Interpretation For Wingman

For a local operator experiment, Claude ACP may technically work with a local
Claude Code subscription credential when the environment is already logged in or
when a valid `CLAUDE_CODE_OAUTH_TOKEN` is provided. That should be treated as
experimental and local-only until tested against the exact package version and
until the policy position is approved for Wingman.

For a productized Wingman feature, the conservative supported path should be:

- Claude Console API key via `ANTHROPIC_API_KEY`;
- supported cloud provider credentials;
- a customer-owned gateway approved for this purpose.

Do not expose a customer-facing "Log in with Claude subscription" flow in
Flight Deck or Autopilot without Anthropic approval.

### Implementation Stance

The first implementation should:

- Prefer API key, cloud provider, or approved gateway auth.
- Pass through existing Claude Code environment credentials only for local
  operator testing.
- Log the effective auth method when ACP reports it.
- Surface auth failures clearly.
- Avoid storing Claude OAuth tokens in Wingman state.

If subscription testing is needed, use a local test checklist:

1. Confirm `claude /status` shows the intended subscription credential.
2. Ensure `ANTHROPIC_API_KEY` is unset unless intentionally testing API billing.
3. Create a Claude session with `claude-use-acp-adapter` enabled.
4. Send a simple prompt.
5. Confirm whether ACP accepts the credential or returns auth required.
6. Record the package version, Claude Code version, and active credential type.

## Configuration

Expected environment support:

- `CLAUDE_ACP_COMMAND`: optional override for the executable, default
  `claude-agent-acp`.
- `CLAUDE_CODE_EXECUTABLE`: passed through to the ACP package when a specific
  Claude Code executable should be used.
- `ANTHROPIC_API_KEY`: supported API key path.
- `ANTHROPIC_AUTH_TOKEN`: supported bearer-token/gateway path.
- `CLAUDE_CODE_OAUTH_TOKEN`: local subscription token path for testing only.
- `CLAUDE_CONFIG_DIR`: optional isolated credential/config directory.

Avoid writing these secrets into Wingman session metadata or logs.

## Testing

Unit tests:

- `resolveAdapterFactory()` returns `ClaudeAcpAdapter` only when the flag is on.
- `ProcessManager` skips `agentapi` spawn for Claude ACP.
- JSON-RPC client correlates responses with requests.
- JSON-RPC client dispatches notifications while requests are pending.
- ACP message chunks become Wingman user/assistant messages.
- Unsupported update kinds are logged visibly.
- Permission requests are denied or surfaced by policy.
- `dispose()` terminates the ACP child process.

Manual validation:

```bash
bun --check src/agents/agent-adapter.ts src/agents/process-manager.ts
bun test src/agents/claude-acp-adapter.test.ts src/agents/acp-json-rpc-client.test.ts
```

Then, after an external operator restart:

1. Turn on `claude-use-acp-adapter`.
2. Create a new Claude session.
3. Send a simple prompt.
4. Confirm streamed assistant output appears in `/live`.
5. Confirm session stop disposes the ACP process.
6. Turn the flag off.
7. Create a new Claude session and confirm it uses `agentapi`.

## Risks

- ACP optional capabilities may change across package versions.
- Claude subscription behavior is policy-sensitive and version-sensitive.
- Terminal and filesystem proxy features need stricter local policy before broad
  enablement.
- Some ACP events may not map cleanly to the current Wingman chat model.
- Node `>=22` is required by the ACP package.

## References

- Claude ACP adapter: https://github.com/agentclientprotocol/claude-agent-acp
- ACP overview: https://agentclientprotocol.com/protocol/v1/overview
- Claude Code authentication: https://code.claude.com/docs/en/iam
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Use Claude Code with Pro or Max: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Claude paid plans vs API/Console: https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console
