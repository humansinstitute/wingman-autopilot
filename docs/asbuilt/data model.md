# Wingman data model (as built)

Last reviewed against the live repository on 2026-04-07.

## Scope and source of truth

This document describes the persisted and cached data model that exists in the current Wingmen repo at `/Users/mini/code/wingmen`.

Review inputs for this refresh:

- live store implementations under `src/storage/`, `src/projects/`, `src/todos/`, `src/identity/`, `src/mcp/`, `src/nightwatch/`, `src/scheduler/`, `src/caprover/`, `src/agent-chat/`, and `src/ui/`
- the current SQLite schemas materialized under `data/*.db`
- the current JSON registries under `data/*.json`
- the architecture baseline in `docs/architecture.md`

Wingmen is not backed by one normalized relational schema. The live model is split across:

- one main SQLite database: `data/wingman.db`
- several sidecar SQLite databases by concern
- a few JSON-backed registries
- browser-side Dexie / IndexedDB caches

## Storage boundaries

### 1. Main operational database: `data/wingman.db`

This is the center of gravity for runtime state. Live tables observed on 2026-04-07:

- `sessions` (`495` rows)
- `messages` (`19807` rows)
- `projects` (`2` rows)
- `project_apps` (`2` rows)
- `artifacts` (`0` rows)
- `feature_flags` (`8` rows)
- `file_watchers` (`2` rows)
- `caprover_apps` (`9` rows)
- `caprover_deployments` (`110` rows)
- `nightwatch_sessions` (`305` rows)
- `nightwatch_reports` (`2889` rows)
- `nightwatch_config` (`3` rows)
- `task_sessions` (`0` rows)
- `memories` (`23` rows)
- `nip98_grants` (`25` rows)
- `scheduled_jobs` (`10` rows)
- `scheduled_job_runs` (`904` rows)
- `starter_projects` (`2` rows)
- `user_settings` (`9` rows)
- `workspace_subscriptions` (`0` rows)
- `orchestrator_presets` (`2` rows)

This file currently holds session runtime state, conversation transcripts, project metadata, feature flags, file watchers, CapRover deployment tracking, Night Watch state, grants, memory, scheduler state, starter-project templates, and some legacy/compatibility data.

### 2. Sidecar SQLite databases

These domains are intentionally isolated into separate files:

- `data/todos.db`
  - `todos` (`3` rows)
- `data/identity-users.db`
  - `identity_users` (`8` rows)
- `data/npub-projects.db`
  - `npub_projects` (`28` rows)
- `data/bot-keys.db`
  - `bot_keys` (`3` rows)
- `data/team-billing.db`
  - `team_billing_config` (`1` row)
  - `team_members` (`8` rows)
  - `team_provider_keys` (`2` rows)
  - `usage_ledger` (`208` rows)
- `data/jobs.db`
  - `job_definitions` (`7` rows)
  - `job_runs` (`139` rows)
- `data/session-archive.db`
  - `archived_sessions` (`1869` rows)
  - `archived_messages` (`12601` rows)
- `data/setup.db`
  - `setup_state` (`1` row)
- `data/prompt-queue.db`
  - `prompt_queue` (`40` rows)

### 3. JSON-backed registries

Current JSON-backed authorities:

- `data/apps.json`
  - source of truth for registered runnable apps
  - current top-level shape: `{ "apps": AppRecord[] }`
- `data/app-aliases.json`
  - source of truth for generated app routing aliases
  - current top-level shape: `{ "aliases": AliasRecord[] }`
- `data/identity-roles.json`
  - role/onboarding registry managed by `src/storage/identity-role-store.ts`
  - this file was missing on disk during review; the store will create it on first write

### 4. Browser-side IndexedDB caches

The frontend uses Dexie as a local projection layer:

- `WingmanLive`
  - `messages`
  - `sessions`
  - `apiSessions`
  - `apps`
- `WingmanScheduler`
  - `jobs`
- `WingmanNightWatch`
  - `reports`
  - `config`

These are caches for UI responsiveness, not the primary write authority.

### 5. Files present but not part of the active model

These SQLite files exist under `data/` but had no tables during review:

- `data/identity.db`
- `data/message-store.db`
- `data/messages.db`

No active owner store was found for them in the reviewed code, so they look like leftovers or abandoned paths rather than current storage boundaries.

## Core entities and relationships

### Session and conversation model

Primary stores:

- `wingman.db.sessions`
- `wingman.db.messages`
- `wingman.db.artifacts`
- `prompt-queue.db.prompt_queue`
- `session-archive.db.archived_sessions`
- `session-archive.db.archived_messages`

Key fields and relationships:

- `sessions.id` is the root identifier for a live session.
- `messages.session_id -> sessions.id` is the canonical live transcript relationship.
- `artifacts.session_id` is a soft one-to-many link from session to generated files/web assets.
- `prompt_queue.session_id` queues deferred prompts for a session.
- `archived_sessions.id` is the archived copy of a completed session.
- `archived_messages.session_id -> archived_sessions.id` stores archived transcript rows.

Important session attributes:

- `sessions` stores runtime metadata such as `agent`, `name`, `port`, `pid`, `pm2_name`, `logs_dir`, `working_directory`, `command`, `npub`, `runtime_status`, `origin`, `model`, `target_file`, `agent_flag`, and `billing_mode`
- `origin` is persisted as JSON text rather than normalized columns
- `command` is persisted as JSON text rather than a child table
- `agent_flag` and `billing_mode` together back the session metadata contract in code

### Project and app model

Primary stores:

- `wingman.db.projects`
- `wingman.db.project_apps`
- `npub-projects.db.npub_projects`
- `apps.json`
- `app-aliases.json`
- `wingman.db.starter_projects`

Relationships:

- `projects.id` is the shared project root record in the main DB.
- `project_apps.project_id -> projects.id` is the normalized shared project-to-app-folder relationship.
- `project_apps.app_id` is a soft link to an `apps.json` app record.
- `npub_projects` is a separate user-scoped projection keyed by `(npub, directory_path)`.
- `npub_projects.app_id` is another soft link to `apps.json`.
- `npub_projects.task_board_url` stores task-board linkage at the per-user project layer.
- `app-aliases.json` maps deterministic alias strings back to `appId`.
- `starter_projects` is a catalog of templates, not an instance/runtime table.

Design consequence:

- Wingmen keeps both a shared project graph (`projects`, `project_apps`) and a user-scoped directory-usage graph (`npub_projects`)
- runnable app registration is not normalized into SQLite; it still lives primarily in `apps.json`

### Todo model

Primary store:

- `todos.db.todos`

Key fields:

- `owner_npub` is the tenancy boundary.
- `app_id` and `project_id` are optional soft links.
- `category` is one of `rock`, `pebble`, or `sand`.
- `parent_id` models hierarchy between todos.
- `starred` is stored as an integer boolean.

Encrypted payload fields:

- `payload_iv`
- `payload_tag`
- `payload_ciphertext`

As built, plaintext title/description/due date are not separate columns. They are encrypted into the payload blob and decrypted in the store layer.

Behavioral rule enforced in code:

- `rock` items cannot keep a `parent_id`

### Identity, roles, and delegated auth

Primary stores:

- `identity-users.db.identity_users`
- `bot-keys.db.bot_keys`
- `wingman.db.nip98_grants`
- `wingman.db.user_settings`
- `identity-roles.json`
- `team-billing.db.team_members`
- `team-billing.db.team_provider_keys`

Relationships and boundaries:

- `identity_users.normalized_npub` is the primary identity key in the SQL store.
- `identity_users.roles` is JSON text, not a join table.
- `identity_users.ports` is also JSON text and stores assigned per-user port ranges.
- `bot_keys.user_npub` is effectively one active bot identity per user, enforced by a partial unique index on active rows.
- `nip98_grants.user_npub` stores delegated signing grants by domain, optional session, expiry, reason, and optional endpoint patterns.
- `user_settings` is keyed by `(npub, key)` and stores opaque string values.
- `team_members` defines the billing membership set.
- `team_provider_keys` stores encrypted upstream provider credentials.

Important overlap:

- role state exists in both `identity_users.roles` and `identity-roles.json`
- the codebase still supports both, so there is no single normalized role authority to point to without qualification

### Scheduler, file triggers, and jobs

Primary stores:

- `wingman.db.scheduled_jobs`
- `wingman.db.scheduled_job_runs`
- `wingman.db.file_watchers`
- `jobs.db.job_definitions`
- `jobs.db.job_runs`

Relationships:

- `scheduled_job_runs.job_id -> scheduled_jobs.id`
- `scheduled_job_runs.session_id` is a soft link to `sessions.id`
- `job_runs.job_id -> job_definitions.id`
- `job_runs.worker_session_id` and `job_runs.manager_session_id` are soft links to live sessions

Important scheduler attributes:

- `scheduled_jobs` stores `user_npub` and `bot_npub`
- delegated trigger authority is stored as `wrapped_key_ciphertext` and `wrapped_key_nonce`
- execution config lives in `agent`, `working_directory`, and `initial_prompt`
- `trigger_type` is polymorphic and currently supports `cron`, `file_watcher`, and `nostr`
- cron jobs use `cron_expression` and `timezone`
- file-trigger jobs use `watch_directory` and `file_pattern`
- jobs can also define `active_start_time` and `active_end_time`

Important file-watcher attributes:

- `file_watchers.expected_payload` and `file_watchers.options` are JSON text with `json_valid(...)` checks
- the built-in seeded watchers target `orchestrator/triggers` and support `start-session` / `stop-session`

Design consequence:

- recurring automation (`scheduled_jobs`) and manager/worker job execution (`job_definitions`, `job_runs`) are separate models
- both can point at the session subsystem, but they are not one unified job graph

### Night Watch and external task links

Primary stores:

- `wingman.db.nightwatch_sessions`
- `wingman.db.nightwatch_reports`
- `wingman.db.nightwatch_config`
- `wingman.db.task_sessions`

Relationships:

- `nightwatch_sessions.session_id` is a one-row-per-session monitoring state record.
- `nightwatch_reports.session_id` is an append-only-ish report stream per session.
- `task_sessions.session_id` links a session to an MG task record.

Important attributes:

- `nightwatch_sessions` stores enablement, cycle counters, model, and update time
- `nightwatch_reports` stores `status`, `summary`, `cycle_count`, and migrated fields `working_directory`, `reasoning`, `input_mode`, and `input_raw`
- `nightwatch_config` is a generic key/value store; current live keys include `default_model`, `default_max_cycles`, and `custom_prompt`
- `task_sessions` stores `task_id`, `team_slug`, `task_url`, `mg_base_url`, `status`, and `created_at`

### CapRover deployment tracking

Primary stores:

- `wingman.db.caprover_apps`
- `wingman.db.caprover_deployments`

Relationships:

- `caprover_deployments.caprover_app_id -> caprover_apps.id`
- `caprover_apps.app_id` is a soft link to `apps.json`
- `caprover_apps.project_id` is a soft link to `projects.id`

Important attributes:

- `caprover_apps` stores CapRover naming and live routing metadata such as `caprover_name`, `live_url`, `custom_domain`, `has_ssl`, `deployed_version`, and `notes`
- `env_vars_encrypted` exists on the table but the current store code initializes it to `null`
- `caprover_deployments` tracks method, Docker image, git hash, version, status, timestamps, error, and encrypted logs

### Memory and billing model

Primary stores:

- `wingman.db.memories`
- `team-billing.db.team_billing_config`
- `team-billing.db.usage_ledger`

Relationships:

- memories are scoped by both `wingman_npub` and `user_npub`
- optional `project` and `working_dir` bind a memory row to a repo context
- `project_metadata` is stored as JSON text inside the row
- `usage_ledger.session_id` is a soft link to a Wingman session
- `usage_ledger.npub` links usage back to a user when present

### Workspace subscription model

Primary store:

- `wingman.db.workspace_subscriptions`

This table tracks bot-owned workspace subscriptions for the agent-chat / workspace integration layer.

Important attributes:

- `subscription_id` is the primary key
- `(workspace_owner_npub, bot_npub)` is unique
- state is split across several status fields: `ws_key_status`, `group_key_status`, `sse_status`, and `health_status`
- several diagnostic/result payloads are stored as JSON text columns:
  - `last_auth_result_json`
  - `last_group_refresh_result_json`
  - `last_record_pull_result_json`
  - `last_decrypt_result_json`
  - `last_sse_event_json`

As reviewed, the table exists and has code-backed ownership in `src/agent-chat/workspace-subscription-store.ts`, but it currently had `0` rows.

## Ownership and tenancy rules

The dominant partition key is the user Nostr public key.

Current patterns:

- `sessions.npub` is a soft ownership field for live sessions
- `identity_users.normalized_npub` is the main normalized identity key
- `todos.owner_npub` is the todo tenancy boundary
- `npub_projects.npub` is the per-user project-usage boundary
- `bot_keys.user_npub` links one active bot identity to a user
- `scheduled_jobs.user_npub` and `scheduled_jobs.bot_npub` tie automation to both user and bot identity
- `nip98_grants.user_npub` scopes delegated auth
- `memories` are dual-scoped by `wingman_npub` and `user_npub`

Practical effect:

- there is no single tenant table with enforced foreign keys across the whole system
- tenancy is encoded separately in each store
- many cross-domain links are soft references across databases or JSON registries

## Browser caches and derived read models

### `WingmanLive`

`src/ui/live/db.js` defines:

- `messages: "++id, sessionId, [sessionId+createdAt], messageHash"`
- `sessions: "id, status, updatedAt"`
- `apiSessions: "id, status, agentType, npub, updatedAt, targetFile"`
- `apps: "id, label, updatedAt"`

This DB caches live chat content, lightweight session status, full `/api/sessions` payloads, and app lists.

### `WingmanScheduler`

`src/ui/scheduler/db.js` defines:

- `jobs: "id, userNpub, enabled, triggerType, createdAt"`

This is a cache of scheduler API results.

### `WingmanNightWatch`

`src/ui/nightwatch/db.js` defines:

- `reports: "id, sessionId, status, createdAt"`
- `config: "key"`

This is a cache of Night Watch reports and the current config blob.

### Derived server-side projections

A few server stores also behave like projections instead of hard business authority:

- `npub_projects` is a user/project activity view
- `task_sessions` is a link table between Wingman sessions and external MG tasks
- `archived_sessions` / `archived_messages` are historical projections of completed live sessions
- `nightwatch_reports` is a monitoring/report stream

## Schema evolution

There is no standalone migration framework in this repo. The schema is evolved by store initialization code.

Current migration patterns:

- `CREATE TABLE IF NOT EXISTS` on startup
- additive `ALTER TABLE` calls guarded by `PRAGMA table_info(...)` or `try/catch`
- index creation during store initialization

Examples from the reviewed code:

- `src/storage/message-store.ts` backfills `sessions` columns such as `npub`, `origin`, `model`, `target_file`, `agent_flag`, and `billing_mode`
- `src/storage/identity-user-store.ts` backfills `ports`, `balance`, `nickname`, and `picture_url`
- `src/projects/npub-project-store.ts` backfills `app_id` and `task_board_url`
- `src/todos/todo-store.ts` backfills `category`, `parent_id`, and `project_id`
- `src/scheduler/scheduler-store.ts` backfills `trigger_type`, `watch_directory`, `file_pattern`, `active_start_time`, and `active_end_time`
- `src/nightwatch/nightwatch-store.ts` backfills `working_directory`, `reasoning`, `input_mode`, and `input_raw`
- `src/agent-chat/workspace-subscription-store.ts` backfills `last_record_pull_result_json`

The owning store modules are therefore part of the data model contract.

## Ambiguities and stale edges

These points were visible in the live repo and should be treated as real ambiguity, not documentation gaps:

- `wingman.db.orchestrator_presets` exists and contains two rows, but no active owner store or source module was found under `src/` during this review. It looks like compatibility / legacy preset data that still survives in the DB.
- `identity-roles.json` is part of the implemented role store contract but was missing on disk at review time.
- `data/identity.db`, `data/message-store.db`, and `data/messages.db` exist but had no tables and no clear active code owner.
- role state is duplicated across `identity_users.roles` and `identity-roles.json`.
- app registration still uses JSON registries instead of a normalized SQL table, so references from SQL tables to apps are soft links only.

## Current structural characteristics

The live data model is:

- embedded and single-node by default
- poly-store by design
- dominated by user `npub` tenancy, but not enforced uniformly
- reliant on soft references across DBs and JSON files
- intentionally cache-heavy in the browser via Dexie
- migrated in application code rather than a dedicated migration system

## File status for this step

`docs/asbuilt/data model.md` existed before this review and was updated in place.
