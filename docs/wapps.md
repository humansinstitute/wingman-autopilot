# WApp Versioning Design

## Purpose

This document records the agreed versioning model for Wingman Apps
(WApps). It builds on the existing WApp product design by making WApp
versions explicit release artifacts: Git remains the source of truth for
source history, while the launcher selects from immutable published
artifacts through a manifest.

The model supports normal single-line iteration, parallel draft options,
client review, production promotion, and rollback without rewriting
history.

## Core Terms

- `source_version`: the Git commit, branch, or tag used to build a WApp.
  Git is the source of truth for code history, review, diffs, and restore.
- `build`: the act of turning a source version into static WApp output.
  Builds should be reproducible where practical, but a build is not by
  itself the user-facing version.
- `release_artifact`: immutable built output published to a versioned path,
  for example `/apps/<app>/<version_id>/` or
  `wapps/<app>/releases/<version_id>/`.
- `version_id` or `release_id`: stable internal machine ID for one immutable
  release artifact. Manifests, URLs, graph records, rollback references, and
  audit trails use this ID.
- `human_version_id`: visible human label such as `v0.1`, `v0.2`, or `v1.0`.
  This is for discussion, review, and UI timelines, not for identity.
- `track_id`: flow scope for a draft direction. It lets several parallel
  options each have their own `v0.1`, `v0.2`, and so on without collisions.
- `release_candidate`: a single-track candidate produced when parallel draft
  tracks converge.
- `channel`: movable pointer such as `preview`, `client-review`, `stable`, or
  `production` that points at one immutable release artifact.
- `promotion`: moving a channel pointer forward to a selected release
  artifact.
- `rollback`: creating a new forward-moving version from an older artifact or
  Git commit, then moving the relevant channel to that new version.
- `retention`: the policy for how many old artifacts remain published,
  selectable, and directly inspectable.
- `launcher selector`: the Flight Deck or WApp launcher behavior that decides
  which releases and channels a user can choose.

## Version Identity

WApps use two separate IDs because the machine identity and the human
timeline solve different problems.

`version_id` or `release_id` is immutable. It should be generated or derived
so it is unique across all tracks and releases for an app. This ID can be a
UUID, timestamped ID, content-addressed ID, or release record ID. Once an
artifact is published, the release ID must not be renamed, reused, or
repurposed.

`human_version_id` is the visible label. Draft and review versions start at
`v0.1`, then increment to `v0.2`, `v0.3`, and so on as edits are made.
`v1.0` is reserved for the first real `dist/` push to CapRover production.
Before that milestone, `v0.x` means draft, review, preview, or
pre-production.

The launcher should show the human label prominently, but internal links,
manifests, graph memory, audit trails, and rollback references should carry
the stable release ID.

## Draft Tracks

Parallel draft directions require a `track_id`.

Example:

```txt
track_id=option-a human_version_id=v0.1
track_id=option-a human_version_id=v0.2
track_id=option-b human_version_id=v0.1
track_id=option-b human_version_id=v0.2
track_id=option-c human_version_id=v0.1
```

Each row still has a unique `release_id`, so the system never confuses two
different artifacts that share the same human label. The UI can present this
as "Option A v0.2", "Option B v0.2", and "Option C v0.2".

This matches the Off Piste-style flow discussed in prior tests: generate
several directions first, keep each direction versioned inside its own track,
then converge the chosen or mixed direction into one release-candidate track.

## Release-Candidate Convergence

When multiple tracks converge, the system creates a new release candidate
rather than mutating one of the draft tracks in place.

The release candidate should record provenance from the source tracks:

- selected source release IDs
- source Git commits or tags
- whether the candidate was selected unchanged or assembled from multiple
  draft artifacts
- review notes or decision context

After convergence, the human sequence can become a single candidate or release
sequence. For example, draft tracks may each have `v0.1` and `v0.2`, then the
candidate track can publish `rc v0.1` or another agreed candidate label. The
important rule is that `track_id + human_version_id` is unique for human
discussion, while `release_id` remains globally unique for machine behavior.

## Release Artifacts

Published release artifacts are immutable.

A publish command should build from a Git commit or tag, write the output to a
versioned path, and record enough metadata to reproduce and audit the result.
Once published, the artifact path must not be edited in place. A fix creates a
new artifact.

Recommended artifact metadata:

```json
{
  "release_id": "rel_20260518_001",
  "human_version_id": "v0.2",
  "track_id": "option-a",
  "source_version": {
    "git_commit": "abc123",
    "git_tag": null,
    "branch": "feature/wapp-launcher"
  },
  "artifact_path": "/apps/my-wapp/rel_20260518_001/",
  "build": {
    "built_at": "2026-05-18T00:00:00.000Z",
    "built_by": "npub1...",
    "tool": "wapp-publish"
  },
  "provenance": {
    "source_release_ids": []
  },
  "notes": "Client review draft."
}
```

## Manifest

Each WApp has a manifest that the launcher reads. The manifest is the bridge
between immutable artifacts and user-facing selection.

The manifest should include:

- app ID and app slug
- release records keyed by `release_id`
- `human_version_id`, `track_id`, source Git data, build metadata, artifact
  path, author or agent, notes, and provenance
- channels and the release ID each channel currently points to
- default launcher behavior
- retention and visibility metadata

Example shape:

```json
{
  "app_id": "app_123",
  "schema_version": 1,
  "releases": {
    "rel_20260518_001": {
      "release_id": "rel_20260518_001",
      "human_version_id": "v0.2",
      "track_id": "option-a",
      "artifact_path": "/apps/my-wapp/rel_20260518_001/",
      "git_commit": "abc123",
      "created_at": "2026-05-18T00:00:00.000Z",
      "state": "published"
    }
  },
  "channels": {
    "preview": "rel_20260518_001",
    "client-review": "rel_20260518_001",
    "stable": null,
    "production": null
  },
  "launcher": {
    "default_channel": "preview",
    "selection_mode": "channels-and-visible-releases"
  }
}
```

The manifest can live beside the release directory, for example
`wapps/<app>/manifest.json`, or in the WApp metadata store if the launcher
needs server-mediated access. Either way, the launcher should treat it as the
selection index and should not infer versions by listing random copied
folders.

## Channels And Promotion

Channels are movable pointers to immutable artifacts.

Initial channel set:

- `preview`: active internal preview.
- `client-review`: version currently being shown to a client or stakeholder.
- `stable`: accepted non-production version.
- `production`: the version currently deployed through CapRover production.

Promotion means moving a channel pointer forward to another release ID. The
release artifact does not move, and the old artifact keeps its identity.

CapRover production has special semantics:

- the first real `dist/` push to CapRover is `v1.0`
- the `production` channel points at the release artifact represented by that
  CapRover deployment
- pre-Caprover drafts and review builds remain `v0.x`
- after `v1.0`, the team can decide whether to continue simple increments
  such as `v1.1`, `v1.2`, or adopt stricter semantic versioning

## Rollback

Rollback must preserve a forward-moving timeline.

If `v0.4` should return to the behavior of `v0.2`, the system does not rename
or mutate `v0.2`. Instead it creates a new release artifact, labelled `v0.4`,
whose source is the old `v0.2` release artifact or the Git commit that
produced it. The channel then moves to the new `v0.4` release.

This keeps audit history clear:

- `v0.2` remains the old artifact
- `v0.3` remains the later artifact that was rejected or superseded
- `v0.4` is a new rollback-derived artifact
- channel history shows that the channel moved forward to `v0.4`

## Retention

Retention should separate storage from visibility.

Recommended defaults:

- keep all production artifacts indefinitely
- keep all stable and release-candidate artifacts unless manually archived
- keep a bounded number of draft artifacts per `track_id`
- never delete an artifact that is referenced by a channel, release candidate,
  rollback provenance, graph record, or audit entry
- allow archived artifacts to be hidden from normal launcher selection while
  remaining directly inspectable by release ID when retained

Physical cleanup should only remove artifacts that are outside retention and
not referenced by any manifest, channel, provenance record, or audit trail.

## Launcher Selection

The launcher should read the manifest and select versions through release IDs
and channels.

Expected behavior:

- default to a configured channel, normally `preview` before production and
  `production` after CapRover launch
- show human labels grouped by `track_id` while drafts are parallel
- show release-candidate lineage when tracks converge
- allow operators to inspect immutable artifacts by release ID
- expose only curated channels or visible releases to non-operator users
- make production status explicit when the `production` channel exists

The launcher should not require each WApp to implement custom version UI. Each
WApp can remain a static or Bun-backed app while the shared launcher handles
selection.

## First Implementation Slice

A practical first slice is:

1. Build WApp output from a Git commit.
2. Publish it to `wapps/<app>/releases/<release_id>/`.
3. Write or update `wapps/<app>/manifest.json`.
4. Record `release_id`, `human_version_id`, `track_id`, Git commit, build
   timestamp, author or agent, notes, and artifact path.
5. Let the launcher select by channel or visible release.
6. Add commands for promote and rollback that only create new artifacts or move
   channel pointers.

Later iterations can add screenshots, richer retention policies,
release-candidate comparison UI, one-click promote/rollback, and stricter
CapRover production integration.
