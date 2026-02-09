# API Authentication Verification

## Current State: Security Gap

The current authentication flow has a critical vulnerability where the server trusts the frontend without cryptographic proof of identity.

### Current Flow

```
1. Frontend: User authenticates via bunker/NIP-07/nsec (cryptographic)
2. Frontend: Calls POST /api/auth/session with { npub: "npub1..." }
3. Server: Trusts the npub and mints session cookie ← NO VERIFICATION
```

### The Problem

The server accepts any npub without verifying the caller controls the corresponding private key. An attacker could impersonate any user:

```bash
curl -X POST https://wingman.example.com/api/auth/session \
  -H "Content-Type: application/json" \
  -d '{"npub":"npub1victim..."}'
```

This would return a valid session cookie for the victim's account.

### Impact

- User A could start/stop User B's sessions
- Access to other users' working directories
- Access to other users' apps and logs
- Full account takeover

## Proposed Solution: NIP-98 HTTP Authentication

Implement [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) HTTP Auth to require cryptographic proof of identity.

### How NIP-98 Works

The client signs a Nostr event that proves they control the private key:

```typescript
// Client creates and signs this event
{
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["u", "https://wingman.example.com/api/auth/session"],
    ["method", "POST"],
    ["payload", "<sha256 hash of request body>"]
  ],
  content: "",
  pubkey: "<user's public key>",
  id: "<event id>",
  sig: "<schnorr signature>"  // Proves private key ownership
}
```

The event is sent in the `Authorization` header:

```
Authorization: Nostr <base64-encoded-signed-event>
```

### Server Verification Steps

1. Decode the base64 event from Authorization header
2. Verify the Schnorr signature is valid for the pubkey
3. Verify `created_at` is within acceptable window (e.g., 60 seconds)
4. Verify the `u` tag matches the request URL
5. Verify the `method` tag matches the HTTP method
6. Verify the `payload` tag matches SHA256 of request body (if present)
7. Extract npub from pubkey and mint session cookie

### Implementation Locations

**Frontend** (`src/ui/identity/index.js`):
- After bunker/NIP-07/nsec authentication, sign a NIP-98 event
- Include the signed event in the Authorization header when calling `/api/auth/session`

**Backend** (`src/server.ts` or new `src/auth/nip98.ts`):
- Parse Authorization header for NIP-98 events
- Verify signature using `@noble/curves/secp256k1` (already in deps)
- Reject requests with invalid/missing/expired signatures

### Code Sketch

```typescript
// src/auth/nip98.ts
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

interface Nip98Event {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
  id: string;
  sig: string;
}

const NIP98_KIND = 27235;
const MAX_AGE_SECONDS = 60;

export function verifyNip98Auth(
  authHeader: string | null,
  requestUrl: string,
  method: string,
  bodyHash?: string
): { valid: true; pubkey: string } | { valid: false; error: string } {
  if (!authHeader?.startsWith("Nostr ")) {
    return { valid: false, error: "Missing Nostr authorization" };
  }

  const base64Event = authHeader.slice(6);
  let event: Nip98Event;

  try {
    const json = Buffer.from(base64Event, "base64").toString("utf8");
    event = JSON.parse(json);
  } catch {
    return { valid: false, error: "Invalid authorization format" };
  }

  // Verify kind
  if (event.kind !== NIP98_KIND) {
    return { valid: false, error: "Invalid event kind" };
  }

  // Verify timestamp
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > MAX_AGE_SECONDS) {
    return { valid: false, error: "Authorization expired" };
  }

  // Verify URL tag
  const urlTag = event.tags.find(t => t[0] === "u");
  if (!urlTag || urlTag[1] !== requestUrl) {
    return { valid: false, error: "URL mismatch" };
  }

  // Verify method tag
  const methodTag = event.tags.find(t => t[0] === "method");
  if (!methodTag || methodTag[1].toUpperCase() !== method.toUpperCase()) {
    return { valid: false, error: "Method mismatch" };
  }

  // Verify payload hash if provided
  if (bodyHash) {
    const payloadTag = event.tags.find(t => t[0] === "payload");
    if (!payloadTag || payloadTag[1] !== bodyHash) {
      return { valid: false, error: "Payload hash mismatch" };
    }
  }

  // Verify signature
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const expectedId = bytesToHex(sha256(serialized));

  if (event.id !== expectedId) {
    return { valid: false, error: "Invalid event ID" };
  }

  try {
    const valid = schnorr.verify(event.sig, event.id, event.pubkey);
    if (!valid) {
      return { valid: false, error: "Invalid signature" };
    }
  } catch {
    return { valid: false, error: "Signature verification failed" };
  }

  return { valid: true, pubkey: event.pubkey };
}
```

### Migration Strategy

1. **Phase 1**: Add NIP-98 verification but make it optional (log warnings)
2. **Phase 2**: Require NIP-98 for new sessions, existing sessions continue to work
3. **Phase 3**: Require NIP-98 for all authenticated endpoints

### Dependencies

Already available in the project:
- `@noble/curves/secp256k1` - Schnorr signature verification
- `@noble/hashes` - SHA256 for event ID and payload hashing
- `nostr-tools` - NIP-19 encoding/decoding

### Related Files

- `src/auth/session-cookie.ts` - Session cookie minting (needs NIP-98 gate)
- `src/auth/request-context.ts` - Request authentication context
- `src/server.ts` - `/api/auth/session` endpoint (lines 3650-3700)
- `src/ui/identity/index.js` - Frontend identity management

### References

- [NIP-98: HTTP Auth](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [NIP-07: Browser Extension](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-46: Nostr Connect (Bunker)](https://github.com/nostr-protocol/nips/blob/master/46.md)
