# App Alias Routing Design Options

## Overview

Wingman apps need stable URLs regardless of which port they're running on. This document explores options for implementing subdomain-based alias routing.

## Problem Statement

- Apps start/stop on dynamically allocated ports
- Users need a fixed, memorable URL for each app
- The mapping alias → port must be resolved at request time

## Alias Generation

**Approach:** Deterministic three-word alias from `npub + directoryPath`

```typescript
generateAppAlias(npub: string, directoryPath: string): string
// Example: "bold-emerald-bridge"
```

- Same inputs always produce same alias
- Human-readable and easy to type
- Extends existing `identity-alias.ts` pattern

## Alias Registry

New storage mapping aliases to apps:

```typescript
interface AliasRecord {
  alias: string;           // "bold-emerald-bridge"
  appId: string;           // UUID of registered app
  ownerNpub: string;       // Owner's npub
  directoryPath: string;   // Full path to app root
  createdAt: number;
}
```

Port is NOT stored - looked up dynamically from app state at request time.

---

## Routing Options

### Option A: nginx + Wingman API Lookup

**Flow:**
```
Request: myapp.domain.com
    ↓
nginx extracts subdomain → calls Wingman API
    ↓
GET /api/alias-resolve/myapp → returns { port: 8080 }
    ↓
nginx proxies to localhost:8080
```

**nginx config (conceptual):**
```nginx
location / {
    set $alias $subdomain;

    # Subrequest to resolve alias
    auth_request /internal/resolve-alias;
    auth_request_set $upstream_port $upstream_http_x_port;

    proxy_pass http://127.0.0.1:$upstream_port;
}

location = /internal/resolve-alias {
    internal;
    proxy_pass http://127.0.0.1:3600/api/alias-resolve/$alias;
    proxy_pass_request_body off;
}
```

**Pros:**
- nginx handles all proxying (efficient, battle-tested)
- Wingman only does lookup, not traffic forwarding
- WebSocket proxying handled natively by nginx

**Cons:**
- Complex nginx configuration
- Two services to coordinate
- Caching stale ports if app restarts quickly
- nginx reload needed for config changes (not alias changes)

---

### Option B: nginx + lua/njs Script

**Flow:**
```
Request: myapp.domain.com
    ↓
nginx lua script calls Wingman or reads shared state
    ↓
Script returns port → nginx proxies directly
```

**nginx config (lua example):**
```nginx
location / {
    set_by_lua_block $upstream_port {
        local http = require "resty.http"
        local httpc = http.new()
        local res = httpc:request_uri("http://127.0.0.1:3600/api/alias-resolve/" .. ngx.var.subdomain)
        if res and res.status == 200 then
            local json = require "cjson"
            local data = json.decode(res.body)
            return data.port
        end
        return "3600" -- fallback
    }

    proxy_pass http://127.0.0.1:$upstream_port;
}
```

**Pros:**
- More flexible than Option A
- Can add caching, fallback logic
- nginx still handles proxying

**Cons:**
- Requires nginx lua module (OpenResty) or njs
- More complex deployment
- Debugging lua in nginx is painful
- Still two services to coordinate

---

### Option C: Wingman as Reverse Proxy (Selected)

**Flow:**
```
Request: myapp.domain.com
    ↓
nginx/cloudflared wildcards *.apps.domain.com → Wingman:3600
    ↓
Wingman parses Host header → looks up alias → proxies to app port
    ↓
App running on dynamic port
```

**Wingman implementation:**
```typescript
// In request handler
const host = req.headers.get('host');
const alias = extractSubdomain(host); // "myapp" from "myapp.apps.domain.com"

if (alias) {
  const record = aliasRegistry.getByAlias(alias);
  if (record) {
    const app = appRegistry.get(record.appId);
    if (app?.webAppPort) {
      return proxyRequest(req, `http://localhost:${app.webAppPort}`);
    }
  }
}
```

**Pros:**
- All routing logic centralized in Wingman
- No nginx lua/njs complexity
- Easy to debug and modify
- Can leverage existing auth/session management
- Hot-reload alias mappings without nginx reload
- Can add request logging, rate limiting in one place
- Simple cloudflared/nginx config (just wildcard to single origin)

**Cons:**
- Extra hop through Wingman for every request
- Wingman becomes a bottleneck for high-traffic apps
- If Wingman restarts, all app traffic briefly drops
- WebSocket proxying needs careful Bun implementation
- Higher memory/CPU on Wingman process

**Mitigations:**
- Bun is fast; moderate traffic should be fine
- WebSocket support exists in Bun's fetch API
- Can add streaming/chunked transfer for large responses
- Future: could add Option A as "high-performance mode" if needed

---

## Cloudflared Integration

### With Option C (recommended for simplicity)

**cloudflared config:**
```yaml
tunnel: your-tunnel-id
credentials-file: /path/to/credentials.json

ingress:
  # App subdomains route to Wingman
  - hostname: "*.apps.yourdomain.com"
    service: http://localhost:3600

  # Main Wingman UI
  - hostname: "wingman.yourdomain.com"
    service: http://localhost:3600

  # Catch-all
  - service: http_status:404
```

**DNS (Cloudflare):**
- `*.apps.yourdomain.com` → CNAME to tunnel
- `wingman.yourdomain.com` → CNAME to tunnel

### With Option A/B

Would require either:
1. Multiple tunnels (one per app) - complex
2. Single tunnel to nginx, nginx does routing - adds nginx layer

---

## Implementation Plan (Option C)

### Phase 1: Alias Generation & Registry
- [ ] Create `src/apps/alias-generator.ts` - deterministic three-word alias
- [ ] Create `src/apps/alias-registry.ts` - persistent alias storage
- [ ] Auto-generate alias when app is registered
- [ ] API endpoint to lookup alias → app

### Phase 2: Reverse Proxy in Wingman
- [ ] Add subdomain parsing from Host header
- [ ] Implement HTTP proxy forwarding
- [ ] Implement WebSocket proxy forwarding
- [ ] Handle streaming responses

### Phase 3: Integration
- [ ] Update app registration UI to show alias
- [ ] Add alias to app info API responses
- [ ] Document cloudflared/nginx configuration
- [ ] Test with real subdomain routing

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-01-16 | Selected Option C | Simplicity, centralized logic, easy cloudflared integration |
| 2025-01-16 | Three-word aliases | Human-readable, memorable, matches existing identity-alias pattern |
| 2025-01-16 | Apps only (not sessions) | Sessions are temporary; apps need stable URLs |

---

## Future Considerations

- **Custom aliases:** Allow users to set custom subdomain (with collision detection)
- **SSL termination:** Currently handled by cloudflared; document alternatives
- **High-traffic mode:** Option A as opt-in for performance-critical apps
- **Health checks:** Wingman could check app health before proxying
