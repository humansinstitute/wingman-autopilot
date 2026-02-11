# NIP-34 (ngit) and Gitea integration (as built)

Native git collaboration on Nostr, with optional Gitea repo auto-provisioning. No external binaries required — everything is built into Wingman.

## How it works

Agents use MCP tools to publish git metadata (repos, branches, patches, PRs, issues) as Nostr events. Signing happens client-side via the user's browser (Tier 2 delegation over SSE). An optional Gitea integration auto-creates git server repos so there's a real clone URL for the pack data.

The flow for a new project:

1. Agent calls `request_api_access(domain='nostr.git')` to get a signing grant
2. Agent calls `ngit_init` with repo metadata and branch refs
3. Wingman creates a Gitea repo (if configured), then publishes kind 30617 + 30618 to Nostr
4. Agent runs `git remote add origin <clone_url> && git push -u origin main`
5. Repository is now live on [gitworkshop.dev](https://gitworkshop.dev) and cloneable via Gitea

## Architecture

Three layers, cleanly separated:

```
MCP Tools (agent-facing)          HTTP API (/api/ngit/*)         Core libraries
─────────────────────────         ────────────────────────       ──────────────────
ngit-init.ts                      ngit-api.ts                   event-builder.ts
ngit-publish-repo.ts                 ├─ validateSessionAndGrant  relay-publisher.ts
ngit-push-state.ts                   ├─ requestBrowserSign       gitea-client.ts
ngit-send-patch.ts                   ├─ signAndPublish
ngit-create-pr.ts                    └─ route handlers
ngit-create-issue.ts
ngit-set-status.ts
ngit-list-repos.ts (read-only)
ngit-list-proposals.ts (read-only)
```

**Signing path:** `ngit-api.ts` → `pendingSignRequests` + `browserSubscribers` (SSE) → `signing-listener.js` (browser) → NIP-07 or device keystore → signed event posted back → `relay-publisher.ts` publishes to relays.

## NIP-34 event kinds

| Kind  | Constant               | Description                        | Builder function          |
|-------|------------------------|------------------------------------|---------------------------|
| 30617 | `REPO_ANNOUNCEMENT_KIND` | Repository announcement (addressable) | `buildRepoAnnouncement` |
| 30618 | `REPO_STATE_KIND`      | Branch/tag state (refs + HEAD)     | `buildRepoState`          |
| 1617  | `PATCH_KIND`           | Git patch (format-patch content)   | `buildPatch`              |
| 1618  | `PULL_REQUEST_KIND`    | Pull request / merge request       | `buildPullRequest`        |
| 1621  | `ISSUE_KIND`           | Issue (bug report, feature request)| `buildIssue`              |
| 1630  | `STATUS_OPEN`          | Status: open                       | `buildStatus`             |
| 1631  | `STATUS_APPLIED`       | Status: applied/merged             | `buildStatus`             |
| 1632  | `STATUS_CLOSED`        | Status: closed                     | `buildStatus`             |
| 1633  | `STATUS_DRAFT`         | Status: draft                      | `buildStatus`             |

All builders live in `src/ngit/event-builder.ts` and return `UnsignedEventTemplate` objects (kind, tags, content, created_at). The server never touches private keys — templates are signed by the browser.

## API routes

All routes are handled by `createNgitApiHandler(deps)` in `src/ngit/ngit-api.ts`, mounted at `/api/ngit` in `server.ts`.

| Method | Path                    | Description                                              |
|--------|-------------------------|----------------------------------------------------------|
| POST   | `/api/ngit/init`        | Full init: Gitea repo (opt) + announcement + state       |
| POST   | `/api/ngit/publish-repo`| Publish kind 30617 only                                  |
| POST   | `/api/ngit/push-state`  | Publish kind 30618 only                                  |
| POST   | `/api/ngit/send-patch`  | Send a patch (kind 1617)                                 |
| POST   | `/api/ngit/create-pr`   | Create a pull request (kind 1618)                        |
| POST   | `/api/ngit/create-issue`| Create an issue (kind 1621)                              |
| POST   | `/api/ngit/set-status`  | Set status on patch/PR/issue (kind 1630-1633)            |
| GET    | `/api/ngit/repos`       | Query relays for repo announcements (read-only, no grant)|
| GET    | `/api/ngit/proposals`   | Query relays for patches/PRs/issues (read-only, no grant)|

All POST routes require a valid session with an active `nostr.git` grant (validated via `validateSessionAndGrant`). GET routes only need a valid session ID.

## MCP tools (9 total)

Registered in `src/mcp/stdio-server.ts`. Each tool file exports a schema (zod), description string, and handler function.

| Tool name            | File                         | Write/Read | Grant required |
|----------------------|------------------------------|------------|----------------|
| `ngit_init`          | `ngit-init.ts`               | Write      | Yes            |
| `ngit_publish_repo`  | `ngit-publish-repo.ts`       | Write      | Yes            |
| `ngit_push_state`    | `ngit-push-state.ts`         | Write      | Yes            |
| `ngit_send_patch`    | `ngit-send-patch.ts`         | Write      | Yes            |
| `ngit_create_pr`     | `ngit-create-pr.ts`          | Write      | Yes            |
| `ngit_create_issue`  | `ngit-create-issue.ts`       | Write      | Yes            |
| `ngit_set_status`    | `ngit-set-status.ts`         | Write      | Yes            |
| `ngit_list_repos`    | `ngit-list-repos.ts`         | Read       | No             |
| `ngit_list_proposals`| `ngit-list-proposals.ts`     | Read       | No             |

## Grant model

Reuses the existing `request_api_access` grant system with a synthetic domain `nostr.git` (constant `NGIT_GRANT_DOMAIN`). Not a real HTTP domain — just a namespace for the grants store.

- Agent calls `request_api_access(domain='nostr.git', reason='...')`
- User approves in browser
- Grant is stored in `Nip98GrantStore`
- All write operations validate the grant via `validateSessionAndGrant`

## Browser signing

The signing listener (`src/ui/nip98/signing-listener.js`) handles two SSE message types:

- `nip98:sign_request` — HTTP auth tokens (existing)
- `nostr:sign_request` — arbitrary Nostr events (added for NIP-34)

Both use the same `handleSignRequest` flow: attempt NIP-07 (`window.nostr.signEvent`), fall back to device keystore, POST signed event to `/api/mcp/nip98/sign-response`. The `NostrSignRequestMessage` interface is defined in `src/mcp/types.ts`.

## Gitea integration

Optional. When configured, `ngit_init` auto-creates a repository on the Gitea instance before publishing to Nostr. The Gitea clone URL becomes the `clone` tag in the kind 30617 announcement, making the repo cloneable via standard git.

### Configuration

Three environment variables (all required for Gitea to activate):

| Env Variable       | Config Field     | Purpose                                    |
|--------------------|------------------|--------------------------------------------|
| `GITEA_URL`        | `giteaUrl`       | Base URL, e.g. `https://gitea.example.com` |
| `GITEA_API_TOKEN`  | `giteaApiToken`  | API token (generate in Gitea Settings → Applications) |
| `GITEA_OWNER`      | `giteaOwner`     | Username/org that owns repos               |

Loaded in `src/config.ts`. Partially-configured state logs a warning. Fully-configured state logs the URL and owner at startup.

### Client

`src/gitea/gitea-client.ts` — lightweight, no dependencies beyond `fetch`:

- `isGiteaConfigured(config)` — type guard, checks all three fields present
- `createRepo(config, input)` — POST `/api/v1/user/repos`
- `repoExists(config, repoName)` — GET `/api/v1/repos/{owner}/{name}`, returns `null` on 404
- `getOrCreateRepo(config, input)` — idempotent wrapper, returns `{ repo, created }`

### Wiring

`server.ts` passes gitea config into `createNgitApiHandler`:

```typescript
const ngitApiHandler = createNgitApiHandler({
  grantsStore: nip98GrantsStore,
  getSession: (sid) => manager.getSession(sid) ?? null,
  defaultRelays: config.connectRelays,
  gitea: {
    url: config.giteaUrl ?? undefined,
    apiToken: config.giteaApiToken ?? undefined,
    owner: config.giteaOwner ?? undefined,
  },
});
```

### Behavior in ngit_init

- If Gitea is configured AND no `clone_urls` provided AND `create_remote !== false`: calls `getOrCreateRepo` (Step 0)
- Uses returned clone URL + web URL in the Nostr announcement tags
- Response includes Gitea section with clone/SSH/web URLs and "next steps" for the agent
- If Gitea is not configured or `clone_urls` are provided: skips Step 0 entirely

## Relay publishing

`src/ngit/relay-publisher.ts` — first relay write capability in the codebase:

- `publishToRelays(event, relays)` — publishes via `SimplePool` with 10s timeout per relay, returns per-relay success/failure
- `queryRelays(relays, filter)` — reads events matching a filter (supports `kinds`, `authors`, `#d`, `#a`, `limit`)
- Default relays come from `config.connectRelays`; agents can override per-call

## File inventory

```
src/ngit/
  event-builder.ts        # NIP-34 event template builders + kind constants
  relay-publisher.ts      # SimplePool publish + query
  ngit-api.ts             # /api/ngit/* HTTP handler (factory pattern)

src/gitea/
  gitea-client.ts         # Gitea REST API client

src/mcp/tools/
  ngit-init.ts            # Combined init tool (Gitea + announce + state)
  ngit-publish-repo.ts    # Kind 30617 tool
  ngit-push-state.ts      # Kind 30618 tool
  ngit-send-patch.ts      # Kind 1617 tool
  ngit-create-pr.ts       # Kind 1618 tool
  ngit-create-issue.ts    # Kind 1621 tool
  ngit-set-status.ts      # Kind 1630-1633 tool
  ngit-list-repos.ts      # Relay query (read-only)
  ngit-list-proposals.ts  # Relay query (read-only)

src/mcp/types.ts          # NostrSignRequestMessage interface
src/mcp/stdio-server.ts   # Tool registration (9 ngit tools)
src/ui/nip98/signing-listener.js  # Browser signing (nostr:sign_request handler)
src/config.ts             # GITEA_* env vars
src/server.ts             # Handler wiring + gitea config passthrough
```

## Troubleshooting

- **"No active grant for nostr.git"** — agent must call `request_api_access(domain='nostr.git')` first, and user must approve in browser.
- **"Gitea repo creation failed"** — check `GITEA_URL`, `GITEA_API_TOKEN`, `GITEA_OWNER` are all set and the token has repo creation permissions.
- **Signing times out** — user must have an active browser session. The signing listener starts on login and subscribes to SSE at `/api/mcp/nip98/subscribe`.
- **Events not appearing on gitworkshop.dev** — check relay publish results. If 0 successes, the relays may be unreachable or rejecting events. Verify `connectRelays` in config.
- **"Gitea partially configured"** warning at startup — one or two of the three GITEA_* vars are missing. All three are required.
