# Per-User GitHub Credential Management

**Status:** Review-ready
**Scope:** Multi-user GitHub operations from Wingman UI
**Date:** 2026-03-30

---

## Problem Statement

Wingman runs on a shared multi-user server where each user (identified by Nostr npub) needs to clone, pull, push, commit, add, and branch against their own GitHub repositories using their own GitHub credentials. Currently:

- **GitHub credentials are stored** via `userSettingsStore` as `github_username` + `github_api_key` (plaintext in SQLite)
- **A credential helper exists** (`src/git/github-credential-helper.ts`) that injects per-user creds into git subprocesses via env vars
- **Only push/pull/pushUpstream** in `git-operations.ts` use the credential helper — clone, fetch, and remote operations do not
- **The Gitea subsystem** has a more mature per-user model (auto-provisioning, fallback to admin, domain-scoped helpers) that GitHub should mirror

### Gaps

1. **Incomplete coverage** — `clone` and `fetch` don't pass GitHub credential env vars
2. **No validation** — credentials are stored without verifying they work
3. **No revocation flow** — if a token is compromised, there's no server-side invalidation
4. **Plaintext storage** — tokens sit in SQLite unencrypted (unlike bot keys which use NIP-44)
5. **No scope control** — any PAT scope is accepted; no guidance or enforcement
6. **MCP agents can't use GitHub creds** — the MCP subprocess env doesn't include GitHub credential injection

---

## Existing Infrastructure (What We Have)

### Credential Helper (`src/git/github-credential-helper.ts`)

Shell script written to `data/github-credential-helper.sh`, reads from env vars:
```
WINGMAN_GITHUB_USERNAME → username
WINGMAN_GITHUB_TOKEN    → password
```
Injected via `GIT_CONFIG_COUNT/KEY/VALUE` env vars scoped to `credential.https://github.com.helper`.

### Git Operations (`src/server/git-operations.ts`)

`executeGitCommand()` accepts `viewerNpub` and calls `getGitHubGitEnvForUser()` for `push`, `pushUpstream`, `pull`. Other actions (`init`, `addAll`, `commit`) don't need remote auth. **Clone is not handled here** — it's a separate flow.

### User Settings Store (`src/storage/user-settings-store.ts`)

SQLite KV store keyed by `(npub, key)`. GitHub creds stored as:
- `github_username` / `github_user` (read with fallback)
- `github_api_key` / `github_token` (read with fallback)

### Settings UI (`src/ui/views/settings/workspace-sections.js`)

GitHub section (lines 133-264): two inputs for username + token, save/clear buttons, hits `PUT /api/user/settings/{key}`.

### Gitea Reference Pattern (`src/gitea/gitea-user-manager.ts`)

Auto-provisions per-user accounts, stores credentials in `userSettingsStore`, resolves with admin fallback. This is the pattern to follow.

---

## Proposed Solution

### Design Principle

Mirror the Gitea credential model: credentials stored per-user in `userSettingsStore`, resolved at operation time via session → npub lookup, injected into git subprocesses through env-based credential helper. No encryption change needed for MVP (tokens are already short-lived PATs; encrypted storage is a follow-up aligned with the bot-key model).

### Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│  Browser UI  │────▶│  HTTP API    │────▶│  Git Operation     │
│  (settings)  │     │  /api/git/*  │     │  Executor          │
└─────────────┘     └──────┬───────┘     └────────┬───────────┘
                           │                       │
                    session → npub          resolveGitHubCreds()
                           │                       │
                    ┌──────▼───────┐     ┌────────▼───────────┐
                    │ userSettings │     │ credential-helper   │
                    │ Store        │◀────│ env var injection   │
                    └──────────────┘     └─────────────────────┘
```

### Component Changes

#### 1. Extend `executeGitCommand` for Clone & Fetch

Add `clone` and `fetch` actions to `git-operations.ts` that inject GitHub credential env:

```typescript
// New actions in GitCommandAction type
export type GitCommandAction = "init" | "addAll" | "commit" | "push" |
  "pushUpstream" | "pull" | "clone" | "fetch";

// In executeGitCommand switch:
case "clone": {
  const repoUrl = options.repoUrl?.trim();
  if (!repoUrl) throw new Error("Repository URL is required");
  const targetDir = options.targetDirectory?.trim();
  const args = ["clone", repoUrl];
  if (targetDir) args.push(targetDir);
  if (options.branch) args.push("--branch", options.branch);
  // viewerNpub is always resolved from session.npub by the API route
  // handler — never passed directly from the request body.
  const gitEnv = getGitHubGitEnvForUser(options.viewerNpub, wingmanDataDir);
  return runCommand("git", args, { cwd: directory, env: gitEnv ?? undefined });
}

case "fetch": {
  const remote = options.remote?.trim() || "origin";
  const gitEnv = getGitHubGitEnvForUser(options.viewerNpub, wingmanDataDir);
  return runCommand("git", ["fetch", remote], { cwd: directory, env: gitEnv ?? undefined });
}
```

#### 2. GitHub Credential Resolution Functions

New exports in `github-credential-helper.ts` (mirrors `resolveGiteaCredentials`):

```typescript
/**
 * Resolve raw credentials for a given npub.
 * Used by callers that need the token value directly (e.g. validation,
 * API calls, MCP tools that don't spawn git).
 */
export function resolveGitHubCredentials(
  npub: string | null | undefined,
): { username: string; token: string } | null {
  // Delegates to existing getUserGitHubCredentials
  // Returns null if no creds configured → caller decides behavior
}

/**
 * Build the full git subprocess env (credential helper path + env vars).
 * Used by any code that spawns `git` and needs GitHub auth.
 * Requires dataDir because the credential helper script lives on disk.
 *
 * Signature intentionally takes (npub, dataDir) — dataDir is needed to
 * locate/create the shell helper script. resolveGitHubCredentials() above
 * takes only npub because it returns raw values without disk I/O.
 */
export function getGitHubGitEnvForUser(
  npub: string | null | undefined,
  dataDir: string,
): Record<string, string> | null { /* existing implementation */ }
```

Two-tier API: `resolveGitHubCredentials(npub)` for raw credential lookup (no disk I/O), `getGitHubGitEnvForUser(npub, dataDir)` for git subprocess env injection (needs disk path for the helper script). The asymmetry is intentional — callers pick the tier they need.

#### 3. API Routes for Git Operations

New handler `src/server/github-git-api.ts` following the `gitea-api.ts` factory pattern:

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/git/clone` | `{ sessionId, repoUrl, targetDirectory?, branch? }` | Clone a GitHub repo |
| POST | `/api/git/push` | `{ sessionId, remote?, branch? }` | Push to remote |
| POST | `/api/git/pull` | `{ sessionId, remote?, branch? }` | Pull from remote |
| POST | `/api/git/fetch` | `{ sessionId, remote? }` | Fetch from remote |
| POST | `/api/git/commit` | `{ sessionId, message }` | Stage all + commit |
| POST | `/api/git/branch` | `{ sessionId, branch, startPoint? }` | Create branch |
| GET | `/api/git/status?sessionId=` | — | Git status summary |
| GET | `/api/git/credential-status?sessionId=` | — | Whether creds are configured |

**Request binding**: Every request requires `sessionId`. Handler resolves `session.npub` and injects credentials. No npub in request body — always derived from session context to prevent credential cross-contamination.

#### 4. MCP Tool Integration

Add GitHub credential env vars to the MCP child process environment in `src/agents/mcp-injector.ts`:

```typescript
// In buildMcpEnv() or equivalent:
const githubEnv = getGitHubGitEnvForUser(session.npub, dataDir);
if (githubEnv) {
  Object.assign(env, githubEnv);
}
```

This lets MCP-spawned agents (Claude, Codex) use `git push/pull` with the user's GitHub credentials automatically.

#### 5. Credential Validation Endpoint

```
POST /api/user/settings/github/validate
Body: { username, token }
```

Calls `GET https://api.github.com/user` with the provided token. Returns:
- `{ valid: true, login: "...", scopes: [...] }` on success
- `{ valid: false, error: "..." }` on failure

UI calls this before saving to give immediate feedback. **Not a gate** — users can still save unvalidated creds for private instances.

---

## Data Model

### No Schema Changes Required

All GitHub credentials already fit the existing `user_settings` table:

| npub | key | value |
|------|-----|-------|
| npub1... | `github_username` | `octocat` |
| npub1... | `github_api_key` | `ghp_xxxx...` |

The dual-key fallback (`github_api_key` / `github_token`, `github_username` / `github_user`) should be consolidated to canonical keys: `github_username` and `github_token`. Migration: on read, check both; on write, always use canonical key and delete legacy key.

### Future: Encrypted Token Storage

When we add encrypted credential storage (aligned with bot-key model):

| npub | key | value |
|------|-----|-------|
| npub1... | `github_token_encrypted` | `<NIP-44 ciphertext>` |
| npub1... | `github_token_nonce` | `<encryption nonce>` |

Decrypted in-memory on session start, cleared on last session stop (same lifecycle as bot keys). This is a follow-up — not MVP.

---

## Security Boundaries

### Credential Isolation

- **Session → npub binding** is set at session creation and immutable
- **Credentials never cross npub boundaries** — resolution always goes session → npub → userSettingsStore
- **No admin fallback for GitHub** (unlike Gitea) — if user has no GitHub creds, operations fail cleanly
- **Credential helper is host-scoped** — only activates for `https://github.com` (env var `GIT_CONFIG_KEY_0`)

### Token Scope Recommendations

UI should guide users to create Fine-grained PATs with minimal scope:
- `contents: read/write` (for push/pull/clone)
- `metadata: read` (for validation endpoint)

Display a warning if the validation endpoint returns a classic token with broad scopes.

### Process Isolation

- Git subprocesses get credentials via env vars (not written to `.gitconfig`)
- Env vars are per-process — no cross-session leakage
- Credential helper script is shared but parameterized by env vars per invocation

**Concurrent sessions for the same npub**: Multiple sessions owned by the same npub may run git operations simultaneously. This is safe because each `Bun.spawn` / `runCommand` call gets its own process with its own env vars. There is no shared mutable state — `userSettingsStore.get()` is a read-only SQLite query, and the credential helper script is stateless (reads env vars set by its parent process). Two sessions for the same npub will resolve the same credentials, which is correct behavior.

### Revocation

1. **User-initiated**: Clear button in Settings UI → `DELETE /api/user/settings/github_token` + `DELETE /api/user/settings/github_username`
2. **Admin-initiated**: Admin can clear any user's GitHub settings via `userSettingsStore.delete(npub, key)`
3. **GitHub-side**: User revokes PAT on GitHub → next git operation fails with 401 → UI shows error, prompts re-auth

### Rotation

No automatic rotation. Users manage their own PAT lifecycle on GitHub. The validation endpoint helps them verify new tokens work before saving.

---

## Logging & Audit

On a shared multi-user server, credential usage must be observable for security review and incident response.

### What to Log

Every git operation that resolves GitHub credentials should emit a structured log line:

```
[github-git] <operation> npub=<npub_prefix>... session=<sessionId> remote=<remote> dir=<workingDir> result=<ok|error> exit=<code>
```

| Field | Source | Example |
|-------|--------|---------|
| operation | The `GitCommandAction` value | `push`, `clone`, `pull` |
| npub | Truncated `session.npub` (first 16 chars) | `npub1abc123...` |
| sessionId | From request body | `sess_7f3a...` |
| remote | Resolved remote name | `origin` |
| dir | `session.workingDirectory` | `/home/user/project` |
| result | `ok` if exitCode 0, `error` otherwise | `ok` |
| exit | Process exit code | `0`, `128` |

### Where to Log

- **Credential resolution**: Log when `getGitHubGitEnvForUser` is called and whether creds were found (not the token value — never log secrets)
- **Operation result**: Log after each git subprocess completes, matching the existing `[gitea-api]` log pattern
- **Credential lifecycle**: Log when credentials are saved, cleared, or validated (which npub, when, success/failure)
- **Auth failures**: Log at `warn` level when git exits with auth-related errors (exit 128, "Authentication failed" in stderr)

### What NOT to Log

- Token values, even partially — no `ghp_ab...` prefixes
- Passwords or credential helper output
- Full npub values — truncate to 16 chars for correlation without full identity exposure

### Implementation

Use the existing `console.log` / `console.warn` pattern (consistent with `[gitea-api]` logging). The `/api/git/*` route handler should log at entry (operation + npub) and exit (result + exit code). No new logging infrastructure needed — this rides on the existing `src/logging/` system.

---

## Failure Handling

| Scenario | Behavior |
|----------|----------|
| No GitHub creds configured | `getGitHubGitEnvForUser` returns null → git uses default auth (likely fails for private repos) → return clear error: "GitHub credentials not configured" |
| Expired/revoked token | Git returns exit code 128 with "Authentication failed" → return error with hint to check Settings |
| Rate limited | GitHub returns 403 → pass through git stderr to user |
| Network failure | Git timeout → stderr includes connection error → return as-is |
| Wrong username | Git auth fails → same as expired token path |
| Clone to existing directory | Git fails naturally → pass through error |
| Concurrent operations same repo | Git's own locking handles this → pass through lock errors |

---

## UI Integration Points

### Settings Page (Existing)

Already has GitHub username + token inputs. Enhancements:
1. Add "Validate" button that calls `/api/user/settings/github/validate`
2. Show token scope info after validation
3. Show last-used timestamp (can be added to userSettingsStore on each credential resolution)

### Session Dashboard

- Show GitHub credential status indicator per session (green dot = configured, grey = not)
- Clone dialog: text input for repo URL + clone button, calls `/api/git/clone`

### Live View

- Git operation buttons (push, pull, fetch) in the session toolbar
- Status toast for operation results
- Error toast with "Check GitHub settings" link on auth failures

---

## Implementation Order

1. **Consolidate key names** — normalize `github_api_key` → `github_token`, `github_user` → `github_username` with backward-compat reads
2. **Add clone/fetch to `executeGitCommand`** — extend the existing function
3. **Create `/api/git/*` route handler** — factory pattern per `gitea-api.ts`
4. **Wire into server.ts** — import handler, add to route dispatch
5. **Add MCP env injection** — extend `mcp-injector.ts`
6. **Add validation endpoint** — `/api/user/settings/github/validate`
7. **UI enhancements** — validate button, clone dialog, status indicators

Steps 1-5 are backend-only and can land in one PR. Steps 6-7 are UI work.

---

## Open Questions

1. **GitHub Enterprise**: Should credential helper support configurable GitHub host (not just `github.com`)? The current helper is hardcoded to `credential.https://github.com.helper`. Enterprise users would need `credential.https://github.corp.example.com.helper`.

2. **SSH keys**: Some users prefer SSH auth over HTTPS PATs. Should we support SSH key management, or is HTTPS-only acceptable for MVP?

3. **Multi-remote**: A session's repo might have multiple remotes (origin = GitHub, gitea = Gitea). The current credential helper scopes by domain, which handles this correctly. But should the UI let users configure credentials per-remote rather than per-host?

4. **Token encryption timeline**: The bot-key system already has NIP-44 encryption infrastructure. Should we prioritize encrypting GitHub tokens using the same model, or ship plaintext-in-SQLite first?

5. **Clone target directory**: Should clone always go into the session's `workingDirectory`, or should users be able to specify a subdirectory? Need to respect `FOLDERACCESS` boundaries.

6. **GitHub App auth**: As an alternative to PATs, should we consider GitHub App installation tokens? These are org-scoped and auto-rotating but require a GitHub App registration. Likely a future enhancement, not MVP.
