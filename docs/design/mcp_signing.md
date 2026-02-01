# MCP-Based NIP-98 Signing for Agents

## Overview

This design enables Wingman-managed agents (Goose, Claude, Codex, OpenCode) to make authenticated HTTP requests to external APIs using NIP-98 signed headers. The system provides a two-tier authorization model where agents can act as Wingman itself, or request delegated access to act on behalf of the logged-in user.

## Problem Statement

Agents running within Wingman need to access external APIs (e.g., `optikon.otherstuff.ai`) that require NIP-98 authentication. Currently:

1. Agents have no identity credentials
2. No mechanism exists for users to delegate signing authority to agents
3. No way for agents to discover if an API supports NIP-98

## Goals

- Enable agents to make NIP-98 authenticated requests to external services
- Support both Wingman-identity and user-delegated signing
- Provide user consent flow with time-limited grants
- Expose functionality via MCP tools for agent consumption
- Support per-user MCP server configuration

## Non-Goals

- Storing user private keys server-side long-term
- Automatic NIP-98 for all agent HTTP requests (explicit opt-in only)
- Supporting non-Nostr authentication methods

---

## Authorization Model

### Two-Tier Authorization

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent Request                                │
│              "Setup board on optikon.otherstuff.ai"                  │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 1: Wingman's Own Identity                                      │
│                                                                      │
│  Sign NIP-98 with KEYTELEPORT_PRIVKEY (Wingman's server key)         │
│  → If service trusts Wingman's npub → Access granted ✓               │
│  → If 401/403 → Fall through to Tier 2                               │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 2: User Delegation                                             │
│                                                                      │
│  Browser modal: "Wingman wants to access optikon for 24hrs"          │
│  User clicks Allow → Browser signs NIP-98 (ephemeral key or NIP-07)  │
│  Grant stored → Future requests auto-signed for grant duration       │
│  → Access granted as user ✓                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Signing Flow Detail

```
Agent                    Wingman Server              Browser                 External API
  │                           │                         │                         │
  ├── MCP: sign_nip98 ───────→│                         │                         │
  │   {session_id, url,       │                         │                         │
  │    method, tier: 1}       │                         │                         │
  │                           │                         │                         │
  │                           ├── Sign with Wingman key │                         │
  │←── {token} ───────────────┤                         │                         │
  │                           │                         │                         │
  ├────────────────────────────────────────────────────────── GET /api ─────────→│
  │                           │                         │   Authorization: Nostr  │
  │                           │                         │                         │
  │←─────────────────────────────────────────────────────────── 403 ─────────────┤
  │                           │                         │                         │
  ├── MCP: request_api_access─→│                         │                         │
  │   {domain, duration: 24h} │                         │                         │
  │                           │                         │                         │
  │                           ├── WS: consent_request ─→│                         │
  │                           │                         ├── Show modal            │
  │                           │                         │   User clicks Allow     │
  │                           │                         │                         │
  │                           │←── WS: grant_approved ──┤                         │
  │                           │    {grant_id}           │                         │
  │                           │                         │                         │
  │←── {granted: true} ───────┤                         │                         │
  │                           │                         │                         │
  ├── MCP: sign_nip98 ───────→│                         │                         │
  │   {session_id, url,       │                         │                         │
  │    method, use_grant: X}  │                         │                         │
  │                           │                         │                         │
  │                           ├── WS: sign_request ────→│                         │
  │                           │                         ├── Auto-sign (grant OK)  │
  │                           │←── WS: signed_token ────┤                         │
  │                           │                         │                         │
  │←── {token} ───────────────┤                         │                         │
  │                           │                         │                         │
  ├────────────────────────────────────────────────────────── GET /api ─────────→│
  │                           │                         │   Authorization: Nostr  │
  │←─────────────────────────────────────────────────────────── 200 ─────────────┤
```

---

## NIP-98 Token Timing

NIP-98 tokens include a `created_at` timestamp validated within ±60 seconds. Tokens cannot be pre-signed for long durations.

**Solution**: Grants represent *permission to request signatures*, not pre-signed tokens.

- User grants access to a domain for N hours
- During grant period, agent requests fresh signatures as needed
- Browser auto-signs without modal (grant already approved)
- Each token is fresh, satisfying NIP-98 timestamp validation

---

## Component Architecture

### Backend Structure

```
src/mcp/
├── server.ts              # MCP server (SSE transport)
├── transport.ts           # SSE connection handling
├── tools/
│   ├── nip98.ts           # NIP-98 auth tools
│   ├── discovery.ts       # API NIP-98 support detection
│   └── index.ts           # Tool registry
├── session-router.ts      # Route requests to correct browser
└── types.ts

src/auth/nip98/
├── service.ts             # Core NIP-98 signing logic
├── grants.ts              # Grant storage & validation
├── wingman-signer.ts      # Sign with Wingman's key
├── routes.ts              # HTTP API endpoints
└── types.ts

src/storage/
└── user-mcp-config.ts     # Per-user MCP server preferences

src/agents/
└── mcp-injector.ts        # Inject MCP config per agent type
```

### Frontend Structure

```
src/ui/nip98/
├── consent-modal.js       # "Allow access for X hours?" UI
├── grants-panel.js        # Settings UI showing active grants
├── signer.js              # Signing logic (ephemeral + NIP-07)
└── store.js               # IndexedDB grant storage
```

---

## Data Models

### Grant

```typescript
interface Nip98Grant {
  id: string;                        // Unique grant ID
  domain: string;                    // "optikon.otherstuff.ai"
  userNpub: string;                  // User who granted
  sessionId?: string;                // Specific session, or null for all
  signerType: 'ephemeral' | 'nip07'; // How browser will sign
  grantedAt: number;                 // Unix timestamp ms
  expiresAt: number;                 // Unix timestamp ms
  reason?: string;                   // Why agent requested access
  endpoints?: EndpointPattern[];     // Optional: limit to specific endpoints
}

interface EndpointPattern {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*';
  pathPattern: string;               // "/api/boards/*" or "*"
}
```

### User MCP Configuration

```typescript
interface UserMcpConfig {
  npub: string;
  servers: Record<string, McpServerConfig>;
}

interface McpServerConfig {
  // SSE/HTTP transport
  url?: string;
  headers?: Record<string, string>;

  // Stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // Filtering
  enabledAgents?: AgentType[];       // Which agents get this server
}
```

### MCP Tool Definitions

```typescript
const mcpTools = [
  {
    name: 'request_api_access',
    description: 'Request user permission to access an API with NIP-98 auth',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Your agent session ID (from SESSION_ID env var)'
        },
        domain: {
          type: 'string',
          description: 'API domain, e.g. "optikon.otherstuff.ai"'
        },
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              path: { type: 'string' }
            }
          },
          description: 'Endpoints you plan to access'
        },
        duration_hours: {
          type: 'number',
          description: 'How long to request access (default: 24)'
        },
        reason: {
          type: 'string',
          description: 'Explain why you need access'
        }
      },
      required: ['session_id', 'domain', 'reason']
    }
  },
  {
    name: 'sign_nip98',
    description: 'Get a signed NIP-98 token for an HTTP request',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: { type: 'string', description: 'Full URL to sign for' },
        method: { type: 'string', description: 'HTTP method' },
        body_hash: {
          type: 'string',
          description: 'SHA256 hash of request body (for POST/PUT)'
        },
        tier: {
          type: 'number',
          enum: [1, 2],
          description: '1 = Wingman identity, 2 = User delegation'
        }
      },
      required: ['session_id', 'url', 'method']
    }
  },
  {
    name: 'check_nip98_support',
    description: 'Check if an API supports NIP-98 authentication',
    inputSchema: {
      type: 'object',
      properties: {
        base_url: { type: 'string' },
        swagger_path: {
          type: 'string',
          description: 'Path to Swagger docs (default: /api/docs)'
        }
      },
      required: ['base_url']
    }
  },
  {
    name: 'list_active_grants',
    description: 'List your active NIP-98 access grants',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' }
      },
      required: ['session_id']
    }
  }
];
```

---

## NIP-98 Detection

### Swagger Detection

Check OpenAPI/Swagger docs for NIP-98 security scheme:

```typescript
async function checkSwaggerNip98(baseUrl: string, swaggerPath = '/api/docs'): Promise<{
  supported: boolean;
  securityScheme?: object;
}> {
  const urls = [
    `${baseUrl}${swaggerPath}/swagger.json`,
    `${baseUrl}${swaggerPath}/openapi.json`,
    `${baseUrl}/swagger.json`,
    `${baseUrl}/openapi.json`
  ];

  for (const url of urls) {
    try {
      const spec = await fetch(url).then(r => r.json());

      // OpenAPI 3.x
      const schemes = spec.components?.securitySchemes || {};
      for (const [name, scheme] of Object.entries(schemes)) {
        if (scheme.type === 'http' && scheme.scheme === 'nostr') {
          return { supported: true, securityScheme: scheme };
        }
        if (name.toLowerCase().includes('nip98') || name.toLowerCase() === 'nostr') {
          return { supported: true, securityScheme: scheme };
        }
      }

      // Swagger 2.x
      const defs = spec.securityDefinitions || {};
      for (const [name, def] of Object.entries(defs)) {
        if (name.toLowerCase().includes('nip98') || name.toLowerCase() === 'nostr') {
          return { supported: true, securityScheme: def };
        }
      }
    } catch {
      continue;
    }
  }

  return { supported: false };
}
```

### WWW-Authenticate Detection

Check response headers on 401:

```typescript
async function checkWwwAuthenticate(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'OPTIONS' });
    const auth = res.headers.get('WWW-Authenticate');
    return auth?.toLowerCase().includes('nostr') ?? false;
  } catch {
    return false;
  }
}
```

---

## MCP Server Implementation

### SSE Transport

```typescript
// src/mcp/server.ts
import { McpServer } from '@anthropic/sdk/mcp';

export function createMcpServer() {
  const server = new McpServer({
    name: 'wingman',
    version: '1.0.0'
  });

  // Register tools
  server.tool('request_api_access', requestApiAccessSchema, handleRequestApiAccess);
  server.tool('sign_nip98', signNip98Schema, handleSignNip98);
  server.tool('check_nip98_support', checkNip98SupportSchema, handleCheckNip98Support);
  server.tool('list_active_grants', listActiveGrantsSchema, handleListActiveGrants);

  return server;
}

// SSE endpoint handler
export async function handleMcpSse(req: Request): Promise<Response> {
  const sessionId = req.headers.get('X-Session-ID') ||
                    new URL(req.url).searchParams.get('session');

  if (!sessionId) {
    return new Response('Missing session ID', { status: 400 });
  }

  const server = createMcpServer();
  return server.handleSse(req, { sessionId });
}
```

### Session-Aware Routing

```typescript
// src/mcp/session-router.ts
import { getSessionById } from '../agents/process-manager';
import { getBrowserConnection } from '../websocket/connections';

export async function routeToUserBrowser(
  sessionId: string,
  message: WebSocketMessage
): Promise<void> {
  const session = await getSessionById(sessionId);
  if (!session?.npub) {
    throw new Error('Session has no associated user');
  }

  const browserWs = getBrowserConnection(session.npub);
  if (!browserWs) {
    throw new Error('User has no active browser session');
  }

  browserWs.send(JSON.stringify(message));
}

export async function waitForBrowserResponse(
  requestId: string,
  timeoutMs = 60000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Browser response timeout'));
    }, timeoutMs);

    pendingRequests.set(requestId, (response) => {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      resolve(response);
    });
  });
}
```

---

## Agent MCP Config Injection

### Per-Agent Configuration

```typescript
// src/agents/mcp-injector.ts

type AgentType = 'claude' | 'goose' | 'codex' | 'opencode';

interface McpInjectionResult {
  configFile?: string;      // Path to generated config file
  envVars?: Record<string, string>;
  args?: string[];
}

export async function injectMcpConfig(
  session: SessionSnapshot,
  userConfig: UserMcpConfig
): Promise<McpInjectionResult> {
  const wingmanServer = {
    url: `http://localhost:${config.port}/mcp/sse`,
    headers: { 'X-Session-ID': session.id }
  };

  // Merge user's servers (filtered by agent type)
  const servers: Record<string, McpServerConfig> = { wingman: wingmanServer };

  for (const [name, server] of Object.entries(userConfig.servers)) {
    if (!server.enabledAgents || server.enabledAgents.includes(session.agent)) {
      servers[name] = server;
    }
  }

  switch (session.agent) {
    case 'claude':
      return injectClaudeMcp(session, servers);
    case 'goose':
      return injectGooseMcp(session, servers);
    case 'codex':
      return injectCodexMcp(session, servers);
    case 'opencode':
      return injectOpenCodeMcp(session, servers);
    default:
      return {};
  }
}
```

### Claude Config Injection

```typescript
async function injectClaudeMcp(
  session: SessionSnapshot,
  servers: Record<string, McpServerConfig>
): Promise<McpInjectionResult> {
  const configPath = path.join(session.workingDirectory, '.mcp.json');

  const config = {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [
        name,
        server.url
          ? { url: server.url, headers: server.headers }
          : { command: server.command, args: server.args, env: server.env }
      ])
    )
  };

  await Bun.write(configPath, JSON.stringify(config, null, 2));

  return { configFile: configPath };
}
```

### Goose Config Injection

```typescript
async function injectGooseMcp(
  session: SessionSnapshot,
  servers: Record<string, McpServerConfig>
): Promise<McpInjectionResult> {
  // Goose uses environment variables for MCP config
  const envVars: Record<string, string> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.url) {
      envVars[`GOOSE_MCP_${name.toUpperCase()}_URL`] = server.url;
    } else if (server.command) {
      envVars[`GOOSE_MCP_${name.toUpperCase()}_COMMAND`] = server.command;
      if (server.args) {
        envVars[`GOOSE_MCP_${name.toUpperCase()}_ARGS`] = server.args.join(' ');
      }
    }
  }

  return { envVars };
}
```

---

## Frontend Implementation

### Consent Modal

```javascript
// src/ui/nip98/consent-modal.js

export function showConsentModal({ domain, endpoints, duration, reason, onApprove, onDeny }) {
  const modal = document.createElement('div');
  modal.className = 'nip98-consent-modal';
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h3>Authorization Request</h3>
      <p>An agent wants to access an API on your behalf:</p>

      <div class="request-details">
        <div class="detail-row">
          <span class="label">Domain:</span>
          <span class="value">${escapeHtml(domain)}</span>
        </div>
        <div class="detail-row">
          <span class="label">Duration:</span>
          <span class="value">${duration} hours</span>
        </div>
        <div class="detail-row">
          <span class="label">Reason:</span>
          <span class="value">${escapeHtml(reason)}</span>
        </div>
        ${endpoints ? `
        <div class="detail-row">
          <span class="label">Endpoints:</span>
          <ul class="endpoints-list">
            ${endpoints.map(e => `<li>${e.method} ${e.path}</li>`).join('')}
          </ul>
        </div>
        ` : ''}
      </div>

      <div class="modal-actions">
        <button class="btn-deny">Deny</button>
        <button class="btn-approve">Allow for ${duration}h</button>
      </div>
    </div>
  `;

  modal.querySelector('.btn-approve').onclick = () => {
    modal.remove();
    onApprove();
  };

  modal.querySelector('.btn-deny').onclick = () => {
    modal.remove();
    onDeny();
  };

  document.body.appendChild(modal);
}
```

### Browser Signer

```javascript
// src/ui/nip98/signer.js

import { getEphemeralKey } from '../auth/ephemeral-key.js';

export async function signNip98Event(eventTemplate) {
  // Try ephemeral key first
  const ephemeralKey = await getEphemeralKey();
  if (ephemeralKey) {
    return signWithEphemeralKey(ephemeralKey, eventTemplate);
  }

  // Fall back to NIP-07 extension
  if (window.nostr) {
    return signWithNip07(eventTemplate);
  }

  throw new Error('No signing method available');
}

async function signWithEphemeralKey(privateKey, eventTemplate) {
  const { finalizeEvent } = await import('nostr-tools');
  return finalizeEvent(eventTemplate, privateKey);
}

async function signWithNip07(eventTemplate) {
  if (!window.nostr?.signEvent) {
    throw new Error('NIP-07 extension not available');
  }
  return window.nostr.signEvent(eventTemplate);
}
```

### Grant Store (IndexedDB)

```javascript
// src/ui/nip98/store.js

const DB_NAME = 'wingman_nip98';
const STORE_NAME = 'grants';

export async function openGrantDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('domain', 'domain', { unique: false });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveGrant(grant) {
  const db = await openGrantDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(grant);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getGrantForDomain(domain) {
  const db = await openGrantDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const index = tx.objectStore(STORE_NAME).index('domain');

  return new Promise((resolve, reject) => {
    const request = index.getAll(domain);
    request.onsuccess = () => {
      const now = Date.now();
      const validGrant = request.result.find(g => g.expiresAt > now);
      resolve(validGrant || null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteGrant(grantId) {
  const db = await openGrantDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(grantId);
}

export async function cleanExpiredGrants() {
  const db = await openGrantDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const index = store.index('expiresAt');
  const now = Date.now();

  const request = index.openCursor(IDBKeyRange.upperBound(now));
  request.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
}
```

---

## WebSocket Protocol

### Message Types

```typescript
// Server → Browser
interface ConsentRequest {
  type: 'nip98:consent_request';
  requestId: string;
  domain: string;
  endpoints?: EndpointPattern[];
  durationHours: number;
  reason: string;
  sessionId: string;
  agentType: string;
}

interface SignRequest {
  type: 'nip98:sign_request';
  requestId: string;
  grantId: string;
  eventTemplate: {
    kind: 27235;
    created_at: number;
    tags: string[][];
    content: string;
  };
}

// Browser → Server
interface ConsentResponse {
  type: 'nip98:consent_response';
  requestId: string;
  approved: boolean;
  grantId?: string;
  signerType?: 'ephemeral' | 'nip07';
}

interface SignResponse {
  type: 'nip98:sign_response';
  requestId: string;
  signedEvent?: SignedEvent;
  error?: string;
}
```

---

## API Endpoints

### HTTP Routes (Non-MCP Access)

```
POST /api/auth/nip98/sign
  Sign with Wingman's key (Tier 1)
  Body: { url, method, body_hash? }
  Returns: { token: "Nostr base64..." }

POST /api/auth/nip98/request-grant
  Initiate user consent flow
  Body: { session_id, domain, endpoints?, duration_hours, reason }
  Returns: { request_id } (async - result via WebSocket)

GET /api/auth/nip98/grants
  List active grants for authenticated user
  Returns: { grants: Grant[] }

DELETE /api/auth/nip98/grants/:id
  Revoke a grant early
  Returns: { success: true }

GET /api/auth/nip98/check-support
  Check if URL supports NIP-98
  Query: ?url=https://...
  Returns: { supported: boolean, swagger?: object }
```

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Create `src/auth/nip98/` module structure
- [ ] Implement Wingman key signing (`wingman-signer.ts`)
- [ ] Add NIP-98 detection utilities
- [ ] Create grant data model and storage

### Phase 2: MCP Server
- [ ] Set up MCP server with SSE transport
- [ ] Implement `sign_nip98` tool (Tier 1 only)
- [ ] Implement `check_nip98_support` tool
- [ ] Add `/mcp/sse` endpoint to server

### Phase 3: User Delegation Flow
- [ ] Implement browser consent modal
- [ ] Add ephemeral key signer
- [ ] Add NIP-07 extension support
- [ ] Implement grant storage (IndexedDB)
- [ ] Add WebSocket consent/sign protocol

### Phase 4: Agent Integration
- [ ] Create MCP config injector
- [ ] Implement Claude config injection
- [ ] Implement Goose config injection
- [ ] Investigate Codex/OpenCode MCP support

### Phase 5: User Settings
- [ ] Add grants management panel to settings
- [ ] Implement per-user MCP server configuration
- [ ] Add grant revocation UI
- [ ] Clean up expired grants on load

---

## Security Considerations

1. **Session Validation**: All MCP tool calls must validate session ownership
2. **Grant Scoping**: Grants are per-domain; cannot be used for other domains
3. **Token Freshness**: NIP-98 tokens signed with current timestamp (±60s validity)
4. **Browser Presence**: User delegation requires active browser session
5. **Key Isolation**: User private keys never leave browser; only signed events sent to server
6. **Consent Required**: User must explicitly approve delegation grants
7. **Time Limits**: Grants have maximum duration; users can revoke early

---

## Open Questions

1. **Codex/OpenCode MCP Support**: Need to investigate if these agents support MCP protocol
2. **Grant Persistence**: Should server also persist grants, or trust browser IndexedDB?
3. **Multi-Browser Sessions**: How to handle user with multiple browser tabs?
4. **Offline Grants**: Should grants work if browser disconnects mid-duration?

---

## References

- [NIP-98: HTTP Auth](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [NIP-07: Browser Extension](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [nostr-tools nip98 module](https://github.com/nbd-wtf/nostr-tools)
