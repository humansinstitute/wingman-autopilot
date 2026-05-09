# Single-Key Wingman Plan

## Goal

After the Docker-first setup is usable, simplify Wingman Autopilot to a single bot identity per Wingman instance.

The model should be:

- one Wingman instance
- one bot private key
- one bot public identity
- one workspace
- one memory namespace
- one pipeline/job namespace
- multiple approved human operators

Users authenticate as themselves, but they are operators of the Wingman bot. Their identities are used for access control and audit metadata, not for selecting separate agent private keys.

## Key Configuration

Remove the current workaround-heavy dependency on `KEYTELEPORT_PRIVKEY` for runtime bot identity.

The single Wingman bot key should be passed explicitly through deployment configuration:

```bash
export WINGMAN_BOT_NSEC="nsec1..."
bun start
```

or through an instance `.env` file:

```bash
WINGMAN_BOT_NSEC=nsec1...
```

The key may also be accepted as hex if the code needs migration flexibility:

```bash
WINGMAN_BOT_SECRET_HEX=...
```

Only one canonical setting should be preferred in docs and setup. `WINGMAN_BOT_NSEC` is the likely default because it matches Nostr operator expectations.

## Behavior

All agent sessions launched by this Wingman use the same bot identity.

The runtime should no longer need to decide:

- which user bot key owns the session
- whether a per-user bot key is unlocked
- whether escrow unlock is available
- whether browser-side decrypt is needed
- whether the task listener should fall back to a root Wingman key

Instead, the app should load one configured bot key at startup and use it consistently for:

- NIP-98 signing
- MCP identity
- memory access
- pipeline/job execution
- Nostr task or trigger flows
- agent subprocess identity

## User Model

Users remain first-class operators.

Keep:

- user login
- operator whitelist
- roles or access levels
- audit logs showing who requested each action
- session metadata showing the requesting user

Remove or de-emphasize:

- per-user bot-key generation
- per-user bot-key escrow
- per-user `AGENT_NSEC`
- browser decrypt requests for bot keys
- "bot key locked/unlocked" UI for each user

The bot identity belongs to the Wingman instance, not to a human user.

## Secret Handling

For the first single-key implementation, the deployment operator is responsible for providing the bot key via environment.

Acceptable v1 sources:

- shell export before starting Wingman
- Docker Compose `.env`
- Docker secret mounted into the container and read by startup code

Do not bake the key into the Docker image.

Do not store the key in the repo.

Avoid writing the plaintext key into app databases unless there is a specific encrypted-at-rest design.

## Migration Direction

The migration should reduce code paths rather than adding another compatibility layer.

Likely removals or simplifications:

- `BotKeyStore` as a per-user key store
- `bot-key-manager` escrow flows
- `bot-key-export` as a per-user export path
- browser bot-key decrypt SSE flow
- per-user bot profile publishing as a required runtime dependency
- scheduler wrapped escrow UUID handling
- task-listener owner fallback behavior based on admin/root key distinctions

Some pieces may remain in a reduced form if they become generic identity utilities, but the product model should not preserve hidden per-user agent keys.

## Docker Relationship

This is intentionally the second milestone.

First milestone:

- make Wingman Autopilot easy to run in Docker
- confirm CLI setup works inside the persistent container home
- confirm hosted app routing works through the base-machine tunnel

Second milestone:

- simplify identity to a single configured Wingman bot key
- remove per-user bot-key runtime complexity
- make the first-run UI ask for or validate the one bot identity

## Open Implementation Questions

These should be answered during implementation, not stored as unresolved product direction:

- Should the app accept both `WINGMAN_BOT_NSEC` and `WINGMAN_BOT_SECRET_HEX`, or only `WINGMAN_BOT_NSEC`?
- Should the setup UI generate a new bot key, or only validate a provided key?
- Should the bot key be held only in memory, or encrypted into the instance data volume after first setup?
- What is the minimum compatibility bridge needed for existing code that expects `KEYTELEPORT_PRIVKEY`?
