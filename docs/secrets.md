# Autopilot Secrets and Runtime Settings

This document describes the target design for moving most Autopilot environment
variables into app-managed settings while keeping setup simple, secure, and
Docker-compatible.

## Goals

- Make a new Autopilot instance easier to set up by managing most runtime
  variables in the app settings UI.
- Store imported secrets and runtime settings in SQLite encrypted at rest.
- Keep a small bootstrap environment surface for values Autopilot needs before
  it can read its own settings.
- Preserve existing `.env` setups by importing them safely instead of requiring
  manual migration.
- Support Docker, CapRover, systemd, and local development without pretending
  the app can always rewrite the original environment source.
- Surface missing or conflicting state clearly. Do not hide configuration
  problems behind broad fallbacks.

## Non-Goals

- Do not remove every environment variable. Some bootstrap values must remain
  outside the database.
- Do not automatically delete or rewrite `.env` files without explicit admin
  action.
- Do not expose plaintext secrets through ordinary settings reads or logs.
- Do not rely on Docker containers being able to edit the host-side env source.

## Bootstrap Environment

Autopilot should keep a small set of environment values as bootstrap-only
configuration. These values are needed before the settings database can be read,
or they describe container/runtime wiring that the app cannot safely change from
inside itself.

Recommended bootstrap-only variables:

- `IDENTITY_SESSION_SECRET`: required encryption/session root for encrypted
  settings and browser sessions.
- `PORT`: process listen port.
- `WINGMAN_ENV_FILE`: optional path to a writable env file for local migration
  cleanup.
- Data path or volume path settings, if any are made configurable.
- Docker host/mount-only values such as `WINGMAN_HOST_PORT` and
  `WINGMAN_WORKSPACE_HOST_PATH`.

For phase one, `IDENTITY_SESSION_SECRET` should remain the required root secret.
The existing setting encryption path already derives an AES-GCM key from it.
Longer term, Autopilot may split this into:

- `WINGMAN_MASTER_KEY`: encrypts app-managed secrets and settings.
- `IDENTITY_SESSION_SECRET`: signs/verifies browser identity sessions.

That split is useful, but not required for the first migration.

## Storage Model

Add an instance-level settings store, separate from per-user settings. The store
should live in SQLite and encrypt values before writing them.

Suggested table shape:

```sql
CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_kind TEXT NOT NULL DEFAULT 'string',
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

All values can be encrypted for consistency, including non-secret values. At a
minimum, any setting marked as secret must be encrypted. Encryption should reuse
or generalize the existing `setting-value-crypto` implementation, which uses
AES-256-GCM with a key derived from `IDENTITY_SESSION_SECRET`.

If `IDENTITY_SESSION_SECRET` is missing, weak, or changed such that settings
cannot be decrypted, Autopilot should fail clearly. It should not silently
discard encrypted settings or fall back to defaults for required secrets.

## Settings Registry

Autopilot should define settings through a typed registry instead of scattering
direct `Bun.env` or `process.env` reads through the codebase.

Each setting definition should include:

- app setting key
- environment aliases
- type: `string`, `number`, `boolean`, `json`, `list`, or `secret`
- default value, if any
- category for UI grouping
- secret flag
- validation function
- whether the value requires restart
- whether it can be cleaned up from `.env`
- compatibility env name for child process injection, if needed

Example categories:

- Runtime: base URL, app routing, subdomain routing, relays.
- Agents: default agent, CLI paths, spawn mode, allowed directories, model
  defaults.
- Integrations: Tower, Gitea, SuperBased, CapRover, NTFY, OpenRouter, Maple.
- Pipelines: pipeline root, trigger tokens, classifier keys, concurrency limits.
- Identity and admin: admin npubs, registration toggle, shared instance flags.
- Internal generated: `WINGMAN_PRIV`, signing secrets, app/session keys.

## Resolution Precedence

Runtime config should resolve in this order:

1. App-managed setting, when present.
2. Environment value, when the app setting is missing.
3. Built-in default.

Once a setting is imported into the app, the app-managed value wins. If an
environment value still exists and differs from the app value, Settings should
show a conflict warning. The resolver should not silently let env override the
app setting after migration.

## Environment Import

Autopilot should detect existing environment values and offer an explicit
migration workflow in Settings.

The import panel should show:

- known env values found from `process.env`
- known values found in a writable `.env` file, when available
- whether each value is already imported
- whether the setting is secret
- whether the app value differs from the env value
- whether the setting requires restart

Admin actions:

- Import selected values into Autopilot settings.
- Import all missing known values.
- Replace app values from env, with confirmation.
- Delete selected app settings.
- Generate a migration report.
- Back up `.env` to `.env.backup` or `.env.backup.<timestamp>`.
- Remove selected imported keys from `.env`, when a writable env file exists.

Secrets must be masked in the UI, API responses, logs, and reports. Use presence
and short fingerprints rather than plaintext values when comparing conflicts.

## `.env` Backup and Cleanup

Local `.env` cleanup is allowed only after explicit admin confirmation.

Rules:

- Create `.env.backup` or `.env.backup.<timestamp>` before rewriting.
- Add `.env.backup`, `.env.backup.*`, and `.env.migrated.*` to `.gitignore`.
- Preserve comments and ordering where practical.
- Remove only selected, known keys that were imported successfully.
- Never remove bootstrap-only keys.
- Never print secret values in the migration report.

If the env file cannot be safely parsed or rewritten, Autopilot should refuse the
cleanup action and show the reason.

## Docker and Hosted Runtime Behavior

In Docker, the process environment is usually read-only from Autopilot's
perspective. The original source may be Docker Compose, CapRover, systemd, a
platform secret manager, or container runtime flags.

Docker rules:

- Import from `process.env` is supported.
- Cleanup is disabled by default.
- Cleanup is allowed only when `WINGMAN_ENV_FILE` points to a writable mounted
  env file.
- If cleanup is unavailable, Settings should provide a migration report that
  tells the operator which variables can be removed from Compose, CapRover, or
  other host config after restart.
- Host-only variables such as published ports and bind mounts remain outside
  app-managed settings.

## Runtime Env Injection

Some child processes, CLIs, WApps, MCP tools, and compatibility paths still
expect environment variables. Autopilot should generate those process env values
from app-managed settings at launch time.

Examples:

- agent sessions may receive `AGENT_NSEC`, `WINGMAN_URL`, or tool-specific keys
  when required by existing CLIs.
- WApps may receive `APP_NSEC`, `APP_NPUB`, `TOWER_URL`, `WAPP_ID`,
  `WAPP_ALLOWED_NPUBS_JSON`, and database paths.
- pipeline steps may receive provider keys or trigger tokens through the
  pipeline runtime environment.

This keeps compatibility with existing tools while making Autopilot settings
the source of truth.

## Admin API Surface

Add admin-only API routes for instance settings:

- list setting metadata and masked current values
- list importable env values and conflicts
- import selected env values
- update a setting
- delete a setting
- create `.env` backup
- remove selected keys from a writable `.env`
- generate migration report

APIs that return settings should avoid plaintext secrets by default. Plaintext
secret reads should be rare, admin-only, auditable, and used only for explicit
reveal or runtime injection paths.

## Settings UI

Add an admin settings section for environment and runtime settings.

The UI should include:

- grouped settings by category
- configured/missing/conflict status
- masked secret values
- replace/delete actions for secrets
- validation errors before save
- restart-required badges
- environment import workflow
- Docker/read-only cleanup guidance
- migration report download or copy surface

All interactive controls should have accessible labels and stable test IDs.

## Migration Phases

### Phase 1: Foundation

- Add the instance settings store.
- Add the settings registry.
- Add admin APIs for settings metadata and env import preview.
- Add tests for encryption, masking, validation, and precedence.

### Phase 2: Import Workflow

- Parse `.env` when available.
- Import selected env values into encrypted SQLite.
- Add migration report generation.
- Add `.env.backup*` and `.env.migrated*` to `.gitignore`.

### Phase 3: Settings UI

- Add the admin Settings UI section.
- Show importable env values, conflicts, and Docker cleanup guidance.
- Support explicit import, replace, delete, backup, and cleanup actions.

### Phase 4: Config Resolver Refactor

- Move low-risk config reads from direct env access to the settings service.
- Start with base URL, relays, default agent, Gitea, SuperBased, Maple, and
  similar values.
- Keep behavior stable by falling back to env only when app setting is missing.

### Phase 5: Secret and Runtime Consumers

- Move API tokens, provider keys, CapRover credentials, webhook tokens, and
  pipeline secrets.
- Add runtime env injection for child processes that still require env names.
- Surface missing required secrets clearly at use time.

### Phase 6: Documentation and Env Reduction

- Reduce `.env.example` to bootstrap-only plus documented optional imports.
- Update Docker, CapRover, and setup docs.
- Mark migrated env variables as compatibility aliases.

## Test Coverage

Minimum tests:

- encrypted settings are not stored as plaintext
- settings decrypt with the current `IDENTITY_SESSION_SECRET`
- missing or changed session secret fails clearly
- app setting wins over env after import
- env value is used only when setting is missing
- import masks secrets in API responses
- `.env` backup is created before rewrite
- cleanup removes only selected known keys
- cleanup refuses bootstrap-only keys
- Docker/read-only mode returns guidance instead of attempting rewrite
- runtime env injection uses app-managed values

## Open Decisions

- Whether to introduce `WINGMAN_MASTER_KEY` in phase one or defer it.
- Whether import should happen automatically for missing settings on startup, or
  only after explicit admin action. The safer default is explicit admin action.
- Which settings require restart versus can be hot-reloaded.
- Whether secret reveal should be supported at all, or only replace/delete.
- Whether each setting change should be audited in SQLite with admin npub,
  timestamp, and old/new fingerprints.
