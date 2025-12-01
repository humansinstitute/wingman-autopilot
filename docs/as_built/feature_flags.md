# Feature flags (as built)

Overview of the current feature flag implementation in Wingman.

## States and resolution
- Allowed states: `off`, `on_admin`, `on` (`src/storage/feature-flag-store.ts`).
- Effective state is calculated per viewer: `on` > `on_admin` (admins see it as `on`, non-admins as `off`) > `off` (`resolveFeatureFlagEffectiveState`).
- The UI exposes both the stored state and the effective visibility text (“Visible to you” / “Hidden from you”).

## Data model and storage
- Stored in SQLite table `feature_flags` with columns: `key` (PK), `label`, `description`, `state`, `created_at`, `updated_at`, `updated_by`.
- Keys are slugified lowercase strings; labels are required on create and on update.
- Store implementation: `src/storage/feature-flag-store.ts`.

## Defaults
- On server boot, defaults are ensured via `featureFlagStore.ensureDefaults` in `src/server.ts`.
- Seeded flags:
  - `orchestrator_visibility` (label “Orchestrator visibility”, description “Controls whether orchestrator presets are visible in the UI.”) with default state `on_admin`.
  - `projects_visibility` (label “Projects visibility”, description “Controls whether the Projects view is visible in the UI.”) with default state `on_admin`.

## API surface
- `GET /api/feature-flags` — returns `{ flags }` serialized for the requesting viewer (includes `effectiveState`). Auth: requires authenticated session; admin/non-admin both allowed to read.
- `POST /api/feature-flags` — create new flag. Body: `{ key, label, description?, state? }`. Requires `feature-flags:manage` (admin). Validations: key slug, non-empty label, state in allowed set. Returns `{ flag, flags }`.
- `PATCH /api/feature-flags/:key` — update existing flag. Body can include `label`, `description`, `state`. Label must be non-empty **if provided**. Returns `{ flag, flags }`. Requires `feature-flags:manage` (admin).
- Responses include both the mutated flag and the refreshed list to keep UI in sync. Errors return `{ error: <message> }` with status 400/403.

## Orchestrator gating
- Server computes `orchestratorEnabled` from `orchestrator_visibility` and the viewer’s role; many orchestrator routes (`/api/orchestrators`, preset operations, etc.) return 403 when the flag’s effective state is `off`.
- UI uses the same resolver (`resolveFeatureFlagForViewer`) to hide the Orchestrator section when disabled.

## Projects gating
- Server computes `projectsEnabled` from `projects_visibility` (default `on_admin`); `/api/projects` returns 403 when the effective state is `off`.
- UI hides the Projects navigation item and redirects to Home if the effective state is `off`, preventing the Projects page or dialogs from showing when disabled.

## UI behavior (Settings → Feature Flags)
- Admin-only panel under Settings renders a responsive table (cards on mobile) with columns: Flag, Key, Description, State (editable select), Visibility (effective state), Updated.
- State changes issue `PATCH` with the current label/description to satisfy the backend’s label requirement.
- “Add feature flag” opens a modal with fields for key, label, optional description, and default state; submits via `POST`.
- Errors (e.g., validation) show inline but the table remains visible so flags don’t “disappear” during failures.

## Troubleshooting
- If a `PATCH` responds with `Feature flag label is required`, ensure the request includes a non-empty `label` (the UI now sends it automatically).
- If a flag seems hidden, confirm the viewer’s admin status and the flag’s effective state; non-admins see `on_admin` as off.
- Default seed is only applied when the server starts; removing it directly from the DB will not be re-created until the next boot.***
