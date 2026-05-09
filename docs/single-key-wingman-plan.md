# Single-Key Wingman Plan

## Decision

Wingman Autopilot should move to one bot identity per Wingman instance.

No matter which approved human logs in, they are operating the same Wingman. The
human identity controls access, attribution, and audit history. It does not
select a separate agent key.

The instance private key is configured as:

```bash
WINGMAN_PRIV=nsec1...
```

Use `WINGMAN_PRIV` in product copy, setup UI, Docker docs, and agent runtime
code added for this model. `WINGMAN_PRIV` is the Wingman instance private key.

## Product Model

One deployed Wingman means:

- one Wingman bot private key
- one Wingman bot public identity
- one shared workspace
- one shared memory namespace
- one shared pipeline/job namespace
- one shared set of CLI credentials inside the container
- multiple approved human operators

If stronger separation is needed, create another Wingman instance with its own
container, host workspace path, data volume, CLI home volume, `WINGMAN_PRIV`,
port, and hostname.

## Configuration Contract

`WINGMAN_PRIV` is the canonical setting.

Supported v1 sources:

- process environment:

  ```bash
  export WINGMAN_PRIV=nsec1...
  bun start
  ```

- Docker Compose `.env`:

  ```bash
  WINGMAN_PRIV=nsec1...
  ```

- first-run setup session:

  The setup UI may accept an `nsec1...` value from an authenticated operator and
  hand it to the server as the instance key. For v1, this should be treated as
  instance setup, not as a per-user secret. The implementation should either
  keep it in memory for the running process or persist it using a deliberate
  encrypted-at-rest instance secret design.

Do not bake `WINGMAN_PRIV` into the Docker image.

Do not commit it to the repo.

Do not write it into logs, browser-visible state, session metadata, pipeline
records, or unencrypted databases.

The canonical value should be an `nsec1...` string. If migration code accepts
hex temporarily, it should normalize internally and still expose setup and docs
as `WINGMAN_PRIV=nsec1...`.

## Runtime Behavior

At startup or setup completion, Wingman should load one configured instance key
and derive:

- Wingman bot npub
- Wingman bot hex pubkey
- signing secret material needed by internal Nostr/NIP-98 code
- agent subprocess identity environment

All agent sessions launched by the instance use this same Wingman identity,
regardless of which approved operator requested the session.

Use the configured key consistently for:

- NIP-98 signing
- MCP identity
- memory access
- pipeline/job execution
- Nostr task or trigger flows
- hosted app and agent subprocess identity
- any future graph database row-level-security identity

The requesting human npub should still be attached to records as audit metadata,
for example `requestedByNpub`, `approvedByNpub`, or `operatorNpub`.

## Agent Environment

Agent processes should receive the Wingman identity, not a per-user identity.

The implementation can keep compatibility with existing downstream tools by
injecting the derived secret into the current agent identity variables, but the
source of truth must be `WINGMAN_PRIV`.

Target runtime environment:

- `WINGMAN_NPUB`: derived public identity of the Wingman bot
- `BOT_NPUB`: compatibility alias for the same value where existing tools need it
- `BOT_PUBKEY_HEX`: derived public key hex
- `AGENT_NSEC`: compatibility value for existing agent tools that expect it

Legacy root-key environment variables should not be the source of agent identity
in this model. New code should not introduce new dependencies on them.

## User Model

Keep:

- user login
- operator whitelist
- roles or access levels
- audit logs showing who requested each action
- session metadata showing the requesting user
- UI language that makes it clear multiple people are operating one Wingman

Remove or de-emphasize:

- per-user bot-key generation
- per-user bot-key escrow
- per-user agent private keys
- browser decrypt requests for bot keys
- per-user "bot key locked/unlocked" state
- root-key fallback behavior
- UI copy that implies every user owns a separate assistant key

The Wingman identity belongs to the instance.

## Setup UI

The first-run setup UI should show the Wingman identity as an instance-level
requirement.

Useful states:

- `Missing`: `WINGMAN_PRIV` is not configured and no instance key has been saved.
- `Configured`: the server can derive the Wingman npub.
- `Env managed`: the key came from process or Docker env and cannot be edited in
  the UI.
- `Setup managed`: the key was provided through the setup flow and is available
  to this instance according to the chosen persistence design.

The UI should never display the full private key after submission. It can show
the derived npub and a short fingerprint.

Admin visibility:

- admins can see the public Wingman identity details and copy the `nsec`
- normal approved operators can see only public Wingman identity details such as
  npub, display name, and hex pubkey
- private-key export controls should be hidden or unavailable for non-admins

## Docker Relationship

Docker remains the first milestone.

The Docker deployment should make the single-key model straightforward:

- `.env` contains `WINGMAN_PRIV=nsec1...` when the operator chooses env-managed
  setup.
- `/home/wingman` keeps CLI authentication.
- `/workspace` is mounted from the base machine path such as `~/.wm-ap`.
- app data remains in `/app/data`.
- each new Wingman instance gets a separate `.env`, host workspace path, data
  volume, and `WINGMAN_PRIV`.

The readiness checklist should eventually report:

- whether `WINGMAN_PRIV` is configured
- the derived Wingman npub
- whether the key source is env-managed or setup-managed
- whether agent subprocess identity injection is enabled

## Migration Direction

This implementation should delete complexity, not preserve it under new names.

Likely simplifications:

- replace per-user active bot-key lookup with a single instance identity loader
- remove automatic per-user bot-key generation during session start
- remove bot-key escrow unlock as a requirement for scheduler and triggers
- remove browser-side bot-key decrypt flows
- simplify Nostr trigger listener startup to subscribe as the Wingman instance
- simplify scheduler identity resolution to use the Wingman instance key
- simplify agent subprocess identity injection to use the derived Wingman identity
- keep human npubs only for access control and audit metadata

Some existing modules may remain temporarily as compatibility wrappers during
migration, but the product model should not retain hidden per-user agent keys.

## Implementation Order

1. Add an instance identity module that loads and validates `WINGMAN_PRIV`.
2. Derive and expose the Wingman npub/pubkey from that module.
3. Change agent subprocess identity injection to use the instance identity.
4. Change scheduler, trigger listener, NIP-98 helpers, and MCP identity to use
   the instance identity.
5. Remove per-user bot-key generation and escrow requirements from session start.
6. Update setup/readiness UI around one instance key.
7. Remove or archive obsolete per-user bot-key UI and API surfaces.

## Implementation Decisions

- `WINGMAN_PRIV` is provided through the process or Docker environment.
- Do not otherwise persist `WINGMAN_PRIV` in `/app/data` for this phase.
- If `WINGMAN_PRIV` is present but invalid, startup/API paths should surface the
  error instead of silently falling back to another identity.
- During migration, keep only the minimum compatibility responses needed so older
  UI modules do not fail before they are removed.
