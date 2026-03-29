# Decision Log: Daily News Runtime Static Site

**Date:** 2026-03-29
**Task:** 30a4e68f-4224-4dfa-b46e-2f150c79973b
**Design Doc:** 8d5cf4e1-df9c-4711-a37a-b691dac7d8a2

## Decisions

### 1. Site location: `public/sites/daily-news/`

**Choice:** Place the static site under `public/sites/daily-news/` rather than `src/ui/` or a new top-level directory.

**Rationale:** The existing `servePublicAsset` in `static-assets.ts` already serves files from the `public/` directory with correct MIME types and caching headers. This means the site is immediately accessible at `/sites/daily-news/index.html` with zero server changes. The `src/ui/` directory is reserved for the Wingman SPA modules that share state and routing — a standalone static site doesn't belong there.

### 2. No framework — vanilla JS

**Choice:** Pure vanilla JavaScript with no build step.

**Rationale:** Per the design doc, the entire site should be under 50KB and deployed once. Alpine/Preact would add dependency management overhead for what is essentially a config-driven fetch-and-render loop. The only external dependency is `marked.js` (loaded via CDN) for markdown rendering, with a built-in fallback.

### 3. marked.js via CDN

**Choice:** Load marked.js from jsDelivr CDN rather than vendoring.

**Rationale:** This is a standalone public site, not part of the Wingman SPA bundle. CDN loading keeps the repo footprint minimal and allows independent cache invalidation. The app includes a fallback markdown renderer if CDN is unavailable.

### 4. Decryption stub pattern

**Choice:** `decryptPayload()` handles multiple record shapes (decrypted_payload, data, payload, encrypted_payload) with a client-side NIP-44 decrypt stub.

**Rationale:** The public group key concept is proposed but not yet implemented in Tower/Superbased. The code handles three current scenarios (server-decrypted, plaintext, pre-parsed) and has a clear integration point for client-side NIP-44 decryption when the public group pattern ships. This avoids blocking on Tower changes.

### 5. No server.ts routing changes needed

**Choice:** No modifications to `src/server.ts`.

**Rationale:** The existing `servePublicAsset` function serves anything under `public/` at the corresponding URL path. The site is reachable at `/sites/daily-news/index.html` without adding SPA route entries or new middleware.

## Open Items

- Public group creation in Tower (design doc open question #1)
- CORS configuration for browser-origin Superbased requests (open question #2)
- `config.json` values (superbased_url, group key, owner_pubkey) need to be populated once the public group is created
