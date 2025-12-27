# Orchestrator & File Watchers Design

This document describes the orchestration layer in Wingman V2, covering file watchers, orchestrator presets, and session autostarting mechanisms.

## Overview

The orchestration system provides multiple ways to automatically start and manage AI agent sessions:

1. **File Watchers** - Monitor directories for trigger files
2. **Orchestrator Presets** - Pre-configured session templates
3. **API Endpoints** - Direct HTTP triggers for external integrations

All mechanisms converge on the same `ProcessManager.createSession()` flow, ensuring consistent session lifecycle management.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      TRIGGER SOURCES                        │
├────────────────────┬────────────────────┬──────────────────┤
│  UI Preset Button  │  JSON Trigger File │   API Request    │
│                    │  in orchestrator/  │   /api/sessions  │
│                    │  triggers/         │                  │
└────────┬───────────┴────────┬───────────┴──────────┬───────┘
         │                    │                      │
         ▼                    ▼                      ▼
    ┌─────────────────────────────────────────────────────┐
    │              Session Creation Layer                  │
    │         (launchOrchestratorPreset / direct)         │
    └──────────────────────┬──────────────────────────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │   ProcessManager     │
                │   .createSession()   │
                └──────────┬───────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌──────────┐    ┌──────────────┐   ┌────────────────┐
   │ Allocate │    │ Spawn Agent  │   │ MessageStore   │
   │ Port     │    │ Subprocess   │   │ .recordSession │
   └──────────┘    └──────────────┘   └────────────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ initialisePreset     │
                │ Session (optional)   │
                │ - Wait for ready     │
                │ - Send intro message │
                └──────────────────────┘
```

---

## File Watchers

### Purpose

File watchers monitor a designated directory for JSON trigger files and automatically start or stop sessions based on file content.

### Storage

File watcher configurations are stored in SQLite via `FileWatcherStore` (`src/storage/file-watcher-store.ts`).

```typescript
interface FileWatcherRecord {
  id: string;              // Unique identifier
  name: string;            // Human-readable name
  relativeDir: string;     // Directory to watch (relative to ~/.wingmen)
  pattern: string;         // Glob pattern (e.g., "*.json")
  payloadPointer: string;  // JSON Pointer to extract trigger value
  expectedPayload: any;    // Value that triggers the action
  actionKey: string;       // "start-session" or "stop-session"
  options: object;         // Action-specific configuration
  enabled: boolean;        // Active flag
  lastTriggeredAt: string; // Last trigger timestamp
  lastError: string;       // Last error message
}
```

### Built-in Watchers

Two watchers are created by default on server startup:

#### Start Session Watcher

```json
{
  "id": "start-session-json-trigger",
  "relativeDir": "orchestrator/triggers",
  "pattern": "*.json",
  "payloadPointer": "/action",
  "expectedPayload": "start",
  "actionKey": "start-session",
  "options": {
    "agentPointer": "/agent",
    "directoryPointer": "/directory",
    "namePointer": "/name",
    "messagePointer": "/message"
  }
}
```

#### Stop Session Watcher

```json
{
  "id": "stop-session-json-trigger",
  "relativeDir": "orchestrator/triggers",
  "pattern": "*.json",
  "payloadPointer": "/action",
  "expectedPayload": "stop",
  "actionKey": "stop-session",
  "options": {
    "sessionPointer": "/session"
  }
}
```

### Trigger File Format

To start a session, create a JSON file in `~/.wingmen/orchestrator/triggers/`:

```json
{
  "action": "start",
  "agent": "claude",
  "directory": "/path/to/project",
  "name": "My Session",
  "message": "Please review the code in this directory"
}
```

To stop a session:

```json
{
  "action": "stop",
  "session": "session-uuid-here"
}
```

### Runtime

The `FileWatcherRunner` (`src/watchers/file-watcher-runner.ts`) handles:

1. File system monitoring using `fs.watch()`
2. Periodic polling for changes
3. JSON parsing and validation
4. Payload matching against expected values
5. Triggering session start/stop actions
6. Optional cleanup of processed trigger files

### Trigger Flow

```
1. File detected in orchestrator/triggers/
   ↓
2. Filename matches pattern (*.json)
   ↓
3. JSON content parsed
   ↓
4. JSON Pointer extracts trigger value (/action)
   ↓
5. Value matches expected ("start" or "stop")
   ↓
6. Extract action parameters via pointers
   ↓
7. Execute start-session or stop-session
   ↓
8. Update lastTriggeredAt, optionally delete file
```

---

## Orchestrator Presets

### Purpose

Presets are reusable session configurations that can be launched with a single click or API call. They support template directories for automated project setup.

### Storage

Preset configurations are stored in SQLite via `OrchestratorPresetStore` (`src/storage/orchestrator-presets.ts`).

```typescript
interface OrchestratorPresetRecord {
  id: string;                    // Unique preset ID
  label: string;                 // Display label (shown on button)
  agent: string;                 // Agent type: codex, claude, goose, opencode
  templateDir: string | null;    // Source template to copy
  activeRoot: string | null;     // Root for generated directories
  directoryPrefix: string | null; // Prefix for auto-generated names
  workingDirectory: string | null; // Direct directory (if no template)
  introMessage: string | null;    // Message to send on init
  pollTimeoutMs: number;          // Max wait for agent ready (default: 30000)
  pollIntervalMs: number;         // Ready check interval (default: 250)
  retryAttempts: number;          // Message send retries (default: 10)
  retryDelayMs: number;           // Delay between retries (default: 1000)
}
```

### Template vs Direct Directory

**Template Mode** (`templateDir` + `activeRoot`):
- Copies template directory to a unique active directory
- Generated name format: `YYMMDD_<prefix>_<random8>`
- Example: `241227_Security_Review_45829371`
- Template files are preserved, each launch gets a fresh copy

**Direct Mode** (`workingDirectory`):
- Uses the specified directory directly
- No copying, sessions share the same directory
- Useful for long-running project sessions

### Default Presets

Created on server startup:

| ID | Label | Agent | Template |
|----|-------|-------|----------|
| `security-review` | Security Review | codex | `orchestrator/templates/0001_Review_Code` |
| `highlight-report` | Highlight Report | codex | `orchestrator/templates/0002_Highlight_Report` |

### Intro Message Variables

The intro message supports variable substitution:

| Variable | Replacement |
|----------|-------------|
| `<working_dir>` | Session working directory path |
| `{{working_dir}}` | (alternative syntax) |
| `<session_id>` | Session UUID |
| `{{session_id}}` | (alternative syntax) |

### Launch Flow

```
1. POST /api/orchestrators/{presetId}/launch
   ↓
2. Load preset from store
   ↓
3. Template mode?
   ├─ Yes: Copy template → unique directory in activeRoot
   └─ No: Validate workingDirectory exists
   ↓
4. ProcessManager.createSession(agent, directory, name)
   ↓
5. Return session immediately
   ↓
6. (async) initialisePresetSession()
   ├─ Wait for agent readiness (poll until healthy)
   ├─ Render intro message with variables
   ├─ Send message to agent
   └─ Sync messages from agent
```

---

## API Endpoints

### Orchestrator Endpoints

All endpoints require authentication and check the `orchestrator_visibility` feature flag.

#### List Presets
```
GET /api/orchestrators

Response:
{
  "presets": [
    { "id": "security-review", "label": "Security Review", "agent": "codex", ... }
  ]
}
```

#### Create Preset
```
POST /api/orchestrators
Content-Type: application/json

{
  "label": "My Preset",
  "agent": "claude",
  "templateDir": "orchestrator/templates/my-template",
  "activeRoot": "~/.wingmen/orchestrator/active",
  "directoryPrefix": "MyPrefix",
  "introMessage": "Review the code in <working_dir>",
  "pollTimeoutMs": 30000
}

Response: 201 Created
{ "preset": { ... } }
```

#### Launch Preset
```
POST /api/orchestrators/{presetId}/launch

Response: 201 Created
{
  "directory": "/path/to/active/session",
  "session": {
    "id": "uuid",
    "agent": "codex",
    "port": 3701,
    "status": "starting",
    "workingDirectory": "/path/to/active/session"
  }
}
```

#### Get Preset Details
```
GET /api/orchestrators/{presetId}

Response:
{ "preset": { ... } }
```

#### Update Preset
```
PATCH /api/orchestrators/{presetId}
Content-Type: application/json

{ "label": "New Label", "introMessage": "Updated message" }

Response:
{ "preset": { ... } }
```

#### Delete Preset
```
DELETE /api/orchestrators/{presetId}

Response: 204 No Content
```

#### Browse Directories
```
GET /api/orchestrators/directories?target=templates&path=/
GET /api/orchestrators/directories?target=active&path=/

Response:
{
  "entries": [
    { "name": "my-template", "type": "directory" },
    { "name": "config.json", "type": "file" }
  ]
}
```

### File Watcher Endpoints

#### List Watchers
```
GET /api/watchers

Response:
{
  "watchers": [
    { "id": "start-session-json-trigger", "enabled": true, ... }
  ]
}
```

#### Create Watcher
```
POST /api/watchers
Content-Type: application/json

{
  "name": "My Watcher",
  "relativeDir": "custom/triggers",
  "pattern": "*.json",
  "payloadPointer": "/type",
  "expectedPayload": "deploy",
  "actionKey": "start-session",
  "options": { ... }
}
```

#### Update Watcher
```
PATCH /api/watchers/{watcherId}
Content-Type: application/json

{ "enabled": false }
```

#### Delete Watcher
```
DELETE /api/watchers/{watcherId}
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DIRECTORY_DEF` | Default working directory | `~/code` |
| `AGENT_PORTS` | Starting port for agents | `3700` |
| `AGENT_MAX` | Max concurrent agent ports | `10` |
| `FOLDERACCESS` | Allowed directory paths | `DIRECTORY_DEF` |

### Default Paths

| Path | Purpose |
|------|---------|
| `~/.wingmen/` | Wingman data root |
| `~/.wingmen/orchestrator/triggers/` | File watcher trigger directory |
| `~/.wingmen/orchestrator/active/` | Generated session directories |
| `<project>/orchestrator/templates/` | Preset templates |
| `<project>/data/` | SQLite databases |

---

## Security

### Path Traversal Prevention

All directory paths are normalized and validated:
- Paths expanded and resolved to absolute
- Checked against allowed directory whitelist
- Parent directory references (`..`) resolved before validation

### Payload Validation

- JSON Pointer extraction with strict type checking
- Expected payload deep equality (not substring matching)
- Agent type restricted to known values

### Access Control

- Feature flag gates orchestrator endpoints
- Balance verification before session launch
- Authentication required for all endpoints

---

## Frontend Integration

The UI module (`src/ui/orchestrator/index.js`) provides:

- **Preset buttons** on home page for quick launch
- **Preset dialog** for creating/editing presets
- **Directory browser** for selecting templates and active roots
- **Real-time status** updates during session initialization

### Key Functions

```javascript
// Launch a preset and navigate to live view
launchOrchestratorPreset(presetId)

// Create a new preset
createOrchestratorPreset(payload)

// Load and render preset buttons
refreshOrchestratorPresets()
```

---

## Implementation Files

| File | Purpose |
|------|---------|
| `src/storage/file-watcher-store.ts` | Watcher configuration persistence |
| `src/storage/orchestrator-presets.ts` | Preset configuration persistence |
| `src/watchers/file-watcher-runner.ts` | File system monitoring and trigger execution |
| `src/agents/process-manager.ts` | Session lifecycle management |
| `src/server.ts` | API endpoint handlers (lines 2360-2600) |
| `src/ui/orchestrator/index.js` | Frontend UI module |

---

## Example: External Integration

To trigger a session from an external system (CI/CD, webhook, etc.):

### Option 1: File Trigger

```bash
# Create trigger file
cat > ~/.wingmen/orchestrator/triggers/deploy-review.json << 'EOF'
{
  "action": "start",
  "agent": "claude",
  "directory": "/path/to/deploy",
  "name": "Deployment Review",
  "message": "Review the deployment changes and identify any issues"
}
EOF
```

### Option 2: API Call

```bash
# Launch existing preset
curl -X POST http://localhost:3600/api/orchestrators/security-review/launch \
  -H "Cookie: session=..."

# Or create session directly
curl -X POST http://localhost:3600/api/sessions \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -d '{
    "agent": "claude",
    "workingDirectory": "/path/to/project",
    "name": "My Session"
  }'
```

### Option 3: Webhook Handler

Configure a webhook endpoint to receive events and create trigger files or call the API directly. The server has webhook support at `/api/webhooks/{hookId}`.
