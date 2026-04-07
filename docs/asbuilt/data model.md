# Wingman data model (as built)

Last reviewed against the live repository on 2026-04-05.

## Scope and source of truth

This document describes the persisted and cached data model that exists in the current Wingman repo at `/Users/mini/code/wingmen`.

Source of truth for this review:

- live store implementations under `src/storage/`, `src/projects/`, `src/todos/`, `src/identity/`, `src/mcp/`, `src/scheduler/`, and `src/nightwatch/`
- the step-1 baseline in `docs/asbuilt/architecture.md`
- the currently materialized SQLite schemas under `data/*.db`
- the JSON registries currently used by the server under `data/*.json`

The model is intentionally split across multiple embedded SQLite databases plus a few JSON registries and browser-side IndexedDB caches. There is no central relational schema shared across every concern.

## Storage boundaries

### 1. `data/wingman.db`

This is the main operational database shared by the server runtime. It currently contains:

- `sessions`
- `messages`
- `projects`
- `project_apps`
- `artifacts`
- `feature_flags`
- `scheduled_jobs`
- `scheduled_job_runs`
- `nightwatch_sessions`
- `nightwatch_reports`
- `nightwatch_config`
- `task_sessions`
- `memories`
- `nip98_grants`
- `starter_projects`
- `user_settings`

This file is the center of gravity for session orchestration, project metadata, runtime artifacts, scheduler state, Night Watch, memory, grants, feature flags, and per-user settings.

### 2. Separate SQLite files by concern

Several domains are intentionally isolated into their own files:

- `data/todos.db`: encrypted todo records
- `data/identity-users.db`: per-user identity/profile/role/port/balance state
- `data/npub-projects.db`: per-user project tracking by directory
- `data/bot-keys.db`: per-user bot keypairs and escrow material
- `data/team-billing.db`: team billing config, provider keys, and usage ledger
- `data/jobs.db`: job definitions and manager/worker job runs
- `data/session-archive.db`: archived sessions and archived messages
- `data/setup.db`: setup wizard state
- `data/prompt-queue.db`: queued prompts per session

### 3. JSON-backed registries

Some mutable state is still file-backed rather than table-backed:

- `data/apps.json`: registered apps and runtime metadata
- `data/app-aliases.json`: alias and routing registry for apps
- `data/identity-roles.json`: role assignments and onboarding markers

These are authoritative for their domains even though related operational data may also exist in SQLite.

### 4. Browser-side IndexedDB caches

The frontend persists read models in Dexie/IndexedDB:

- `WingmanLive`: `messages`, `sessions`, `apiSessions`, `apps`
- `WingmanScheduler`: `jobs`
- `WingmanNightWatch`: `reports`, `config`

These are caches and local projections of server state, not the primary write authority.

## Core server entities

### Session and conversation model

Primary tables:

- `sessions`
- `messages`
- `artifacts`
- `nightwatch_sessions`
- `nightwatch_reports`
- `task_sessions`
- `prompt_queue` in `prompt-queue.db`
- `archived_sessions` and `archived_messages` in `session-archive.db`

Key fields and relationships:

- `sessions.id` is the root identifier for a live agent/chat session.
- `messages.session_id -> sessions.id` is one-to-many and stores ordered conversation history.
- `artifacts.session_id -> sessions.id` is one-to-many and tracks files, images, documents, and webviews produced by a session.
- `nightwatch_sessions.session_id -> sessions.id` is effectively one-to-one and stores autonomous monitoring state for a live session.
- `nightwatch_reports.session_id -> sessions.id` is one-to-many and records review/report cycles for Night Watch.
- `task_sessions.session_id -> sessions.id` links a Wingman session to an external task-management record.
- `prompt_queue.session_id -> sessions.id` stores deferred prompts waiting to be delivered to a running session.
- `archived_sessions.id` preserves a stopped session snapshot; `archived_messages.session_id -> archived_sessions.id` stores its final transcript copy.

Important attributes:

- `sessions` stores runtime details such as `agent`, `port`, `pid`, `working_directory`, `command`, `npub`, `runtime_status`, `origin`, `pm2_name`, `logs_dir`, `model`, `target_file`, `agent_flag`, and `billing_mode`.
- `messages` stores `role`, `content`, and `created_at`; it is the canonical persisted transcript for live sessions.
- `artifacts` adds typed outputs without embedding binary data in the DB itself; it stores metadata and file paths/URLs.

### Project and app model

Primary stores:

- `projects`
- `project_apps`
- `npub_projects` in `data/npub-projects.db`
- `apps.json`
- `app-aliases.json`
- `starter_projects`

Relationships:

- `projects.id` is the shared project root record inside `wingman.db`.
- `project_apps.project_id -> projects.id` is one-to-many and models app folders under a project.
- `project_apps.app_id` can point at a registered runtime app held in `apps.json`, but that link is soft rather than a DB-enforced foreign key.
- `npub_projects` is a separate per-user projection keyed by `(npub, directory_path)`; it tracks the same physical directories from the point of view of a specific user.
- `npub_projects.app_id` and `task_board_url` enrich the per-user view with app and board linkage.
- `apps.json` is the source of truth for registered runnable apps, including `id`, `label`, `root`, lifecycle scripts, `ownerNpub`, PM2 metadata, and optional `webAppPort`.
- `app-aliases.json` derives subdomain/path routing aliases from registered apps.
- `starter_projects` is a catalog of templates, not live runtime state.

Design consequence:

- Wingman keeps both a shared project graph (`projects`/`project_apps`) and a user-scoped directory usage graph (`npub_projects`), so "what exists" and "who has been using it" are related but distinct.

### Todo model

Primary store:

- `todos` in `data/todos.db`

Relationships and rules:

- `todos.owner_npub` is the tenancy boundary.
- `todos.app_id` optionally associates a todo with an app.
- `todos.project_id` optionally associates a todo with a project.
- `todos.parent_id` creates hierarchy between items.
- `category` encodes the rock/pebble/sand model.

Confidential fields:

- user-facing todo content is not stored in plaintext columns
- title, description, and due date are encrypted into `payload_ciphertext` with `payload_iv` and `payload_tag`

Behavioral rule:

- top-level `rock` items cannot retain a parent reference; parent linkage is only meaningful for child categories

### Identity and access model

Primary stores:

- `identity_users` in `data/identity-users.db`
- `identity-roles.json`
- `bot_keys` in `data/bot-keys.db`
- `nip98_grants`
- `user_settings`
- `team_members` and `team_provider_keys` in `data/team-billing.db`

Relationships and ownership:

- `identity_users.normalized_npub` is the primary identity key for a person in Wingman.
- `identity_users` tracks alias, optional nickname/picture, roles JSON, onboarding timestamps, last-seen timestamps, assigned port ranges, and sat balance.
- `identity-roles.json` is a parallel JSON role registry keyed by normalized npub; it overlaps with `identity_users.roles`, so code must treat the implementation layer, not one abstract "role table", as the truth.
- `bot_keys.user_npub` is effectively one active bot identity per user, enforced by a unique index on active rows.
- each bot key record stores the bot pubkey/npub plus two encrypted copies of the private material: one encrypted to the user and one encrypted to escrow
- `nip98_grants.user_npub` records time-bounded delegated signing grants by domain and optional session
- `user_settings` is a per-`(npub, key)` settings bag for API keys and other user-scoped values
- `team_members.normalized_npub` defines who is in the billed team context
- `team_provider_keys` stores encrypted provider credentials for shared billing mode

### Scheduler, jobs, and automation model

Primary stores:

- `scheduled_jobs`
- `scheduled_job_runs`
- `file_watchers`
- `job_definitions` in `data/jobs.db`
- `job_runs` in `data/jobs.db`

Relationships:

- `scheduled_job_runs.job_id -> scheduled_jobs.id`
- `job_runs.job_id -> job_definitions.id`
- `job_runs.worker_session_id` and `job_runs.manager_session_id` refer to live session IDs, but as soft references

Important fields:

- `scheduled_jobs` stores both the encrypted trigger authority (`wrapped_key_ciphertext`, `wrapped_key_nonce`) and the execution configuration (`agent`, `working_directory`, `initial_prompt`)
- trigger mode is polymorphic: cron metadata lives beside file-watcher metadata such as `trigger_type`, `watch_directory`, and `file_pattern`
- `file_watchers` stores reusable file-trigger definitions, expected payload matching, and action options
- `job_definitions` are reusable manager/worker templates
- `job_runs` materialize executions with prompts, working directories, refs, linked sessions, status, and summaries

Design consequence:

- scheduler state and manager/worker orchestration state are separate models; they can point at the same sessions, but they are not the same abstraction

### Billing and usage model

Primary store:

- `team-billing.db`

Entities:

- `team_billing_config`: singleton team-level pricing configuration
- `team_members`: membership set
- `team_provider_keys`: encrypted upstream provider credentials
- `usage_ledger`: append-only-ish cost records per request/session/provider

Relationships:

- `usage_ledger.session_id` can associate spend with a Wingman session
- `usage_ledger.npub` can associate spend with a user identity

### Memory and derived knowledge model

Primary stores:

- `memories`
- optional graph- or prompt-related files are present in the repo ecosystem, but in the live Wingman server state reviewed here the materialized long-lived note store is `memories`

Relationships:

- memories are scoped by both `wingman_npub` and `user_npub`
- optional `project` and `working_dir` fields bind a memory to a concrete repo context
- `project_metadata` is JSON carried inside the row, not normalized into child tables

## Ownership and tenancy rules

The main tenancy key across the system is the user Nostr public key (`npub`).

Current patterns:

- session ownership is soft and stored on `sessions.npub`
- project usage ownership is explicit in `npub_projects.npub`
- todo ownership is explicit in `todos.owner_npub`
- identity ownership is explicit in `identity_users.npub` and `identity_users.normalized_npub`
- bot identities are one-to-one with a user via `bot_keys.user_npub`
- NIP-98 delegation is scoped by `nip98_grants.user_npub`
- scheduler ownership is explicit in `scheduled_jobs.user_npub` and `scheduled_jobs.bot_npub`
- memories are dual-scoped by `wingman_npub` and `user_npub`

Practical effect:

- there is no single global tenant table with foreign keys everywhere
- tenancy is encoded per store, sometimes with normalized npubs and sometimes raw npubs
- some domains use JSON files rather than relational ownership constraints, so authorization depends on service-layer rules as much as table design

## Schema and migration sources

There is no standalone migration framework in this repo. Schema evolution is code-driven.

Current migration patterns:

- stores create tables on startup with `CREATE TABLE IF NOT EXISTS`
- additive migrations run inline with `ALTER TABLE` guards or `try/catch`
- indexes are created in store initialization code
- some stores also infer migration need with `PRAGMA table_info(...)`

Examples:

- `src/storage/message-store.ts` backfills new session columns into `sessions`
- `src/storage/identity-user-store.ts` adds `ports`, `balance`, `nickname`, and `picture_url`
- `src/projects/npub-project-store.ts` adds `app_id` and `task_board_url`
- `src/todos/todo-store.ts` adds `category`, `parent_id`, and `project_id`
- `src/scheduler/scheduler-store.ts` adds file-trigger columns to `scheduled_jobs`
- `src/nightwatch/nightwatch-store.ts` adds `working_directory`, `reasoning`, `input_mode`, and `input_raw`

The authoritative schema for a domain is therefore the initialization code in the owning store module, not a separate migrations directory.

## Derived caches and read models

### Browser caches

Dexie stores are the main derived read models in the browser:

- `WingmanLive.messages` mirrors conversation state for instant live-session rendering
- `WingmanLive.sessions` mirrors lightweight session runtime status
- `WingmanLive.apiSessions` mirrors full `/api/sessions` payloads
- `WingmanLive.apps` mirrors `/api/apps` payloads
- `WingmanScheduler.jobs` mirrors scheduler API responses
- `WingmanNightWatch.reports` and `WingmanNightWatch.config` mirror Night Watch server state

These caches are disposable projections. The normal flow is:

1. fetch from server API
2. write cache in Dexie
3. let `liveQuery` update Alpine state

### Server-side projections

A few stores also behave as read-optimized projections over runtime activity:

- `npub_projects` is a usage/read model over project directories by user
- `task_sessions` is a linking projection between Wingman sessions and external task records
- `archived_sessions` and `archived_messages` are historical projections of completed live sessions
- `nightwatch_reports` is an append-only review/report stream derived from monitoring cycles

## Important data flows

### 1. Session launch and live conversation

1. a session is created and written to `sessions`
2. live conversation turns are written to `messages`
3. optional outputs are written to `artifacts`
4. browser clients fetch `/api/sessions` and message data
5. browser caches persist the latest session/message projections in `WingmanLive`
6. on archive/cleanup, the transcript can be copied to `archived_sessions` and `archived_messages`

### 2. User login, identity, and delegated signing

1. a user identity is normalized and touched in `identity_users`
2. onboarding/roles are tracked in `identity_users` and `identity-roles.json`
3. if needed, a per-user bot identity is materialized in `bot_keys`
4. session-scoped or user-wide NIP-98 delegation grants are recorded in `nip98_grants`
5. per-user secrets and settings are stored in `user_settings`

### 3. Project and app lifecycle

1. project roots and app folders are recorded in `projects` and `project_apps`
2. user-specific usage of working directories is recorded in `npub_projects`
3. registered runnable apps are written to `apps.json`
4. routing aliases are derived into `app-aliases.json`
5. browser app lists are cached in `WingmanLive.apps`

### 4. Todo lifecycle

1. todo metadata row is created in `todos`
2. title/description/due date are encrypted into the payload columns
3. optional links to app/project and hierarchy are stored as foreign-key-like scalar values
4. todo lists are read back by owner npub and decrypted in the service layer

### 5. Scheduled automation and manager/worker jobs

1. a reusable job template is stored in `job_definitions`
2. an execution creates a `job_runs` row and links manager/worker session IDs as they are spawned
3. scheduled automation stores recurring triggers in `scheduled_jobs`
4. each scheduler execution appends a `scheduled_job_runs` row
5. file-trigger automation uses `file_watchers` plus file-pattern metadata on `scheduled_jobs`
6. Night Watch overlays session monitoring through `nightwatch_sessions` and `nightwatch_reports`

### 6. Memory and billing

1. agents persist notes into `memories` with both user and wingman identity context
2. team billing configuration and provider credentials live in `team-billing.db`
3. request/session usage events append cost records into `usage_ledger`

## Current structural characteristics

The live data model has a few important traits:

- it is embedded and single-node by default
- it is intentionally poly-store rather than normalized into one database
- user identity is the dominant partition key, but not every store enforces it the same way
- several soft references cross storage boundaries without foreign keys
- JSON files are still first-class authoritative stores for apps, aliases, and some role metadata
- browser IndexedDB is used heavily for responsiveness, but only as a cache layer
- schema drift is managed in application code, so store initialization modules are part of the data model contract

## File status for this step

`docs/asbuilt/data model.md` was created in this step. It did not exist in the repo at the start of review.
