# NostrConnect (NIP-46) client-initiated flow

## Goal
Expose the client-initiated NIP-46 `nostrconnect://` workflow in the Login via bunker panel so a user can hand their bunker the connection request. The UI must show the generated URL, a copy button, and a QR-code reveal action while keeping the current bunker URI (remote-initiated) path intact.

## Default inputs
- Relays: `wss://relay.nsec.app`, `wss://nos.lol`, `wss://relay.getalby.com/v1`, `wss://nostr.mineracks.com`. Allow override via `CONNECT_RELAYS` env (comma-separated list) when bundling/serving the UI.
- Secret: short random string included in the URL and validated on `connect` response (spoofing guard required by NIP-46).
- Optional metadata: client name/url/image can be included if available from app config.

## Current state (UI/logic)
- Login via bunker panel only consumes a `bunker://…` URI. It parses it, connects via `NostrConnectSigner.fromBunkerURI`, persists session, and restores on reload (with secret requirement enforcement).
- No client-initiated `nostrconnect://` generation, no UI affordance for copy/QR, and no way to hand the client key/secret to a bunker operator.

## Proposed UX additions
- Add a “Client-initiated (NostrConnect)” subsection in the Login via bunker panel/modal (only shown when user is not authenticated).
- Generate and display a readonly `nostrconnect://…` URL aligned with the session seed (client pubkey + secret + default relays) each time the login modal is opened/used; do not surface when already logged in.
- Provide:
  - `Copy` control (confirms when copied).
  - `Show QR` toggle/modal rendering the URL as a QR code for scanning (ensure data URI uses `application/javascript` MIME when served under `src/ui` if a helper is added).
- Present brief helper text explaining when to use this versus pasting a `bunker://` URI.

## Flow design (client-initiated)
1. On login modal entry/init (or when user explicitly regenerates), ensure we have/derive a client keypair (new ephemeral keypair; reuse during that single login attempt; regenerate on fresh attempts).
2. Build URL:
   - scheme: `nostrconnect://`
   - host: `<client-pubkey-hex>`
   - query: multiple `relay=` params (default list or `CONNECT_RELAYS` override), `secret=<random>`, optional `perms=<comma separated>`, `name`, `url`, `image`.
3. Render URL in readonly field + copy + QR; mask/shorten in UI but copy/QR should use full value.
4. Store the generated secret with the active keypair so we can validate the returned `connect` response.
5. When the bunker connects back (remote-signer initiated response), reuse existing `NostrConnectSigner` flow but source the client keypair/secret from this generated state (not textarea) and validate `secret`.
6. Persist session as today (npub, expiry, method=bunker) and keep restore logic compatible (remote signer may also reinitiate with the same parameters).

## Error and edge cases
- If relays reject connections, surface a clear status and allow retry/regenerate.
- Regeneration should invalidate previous secrets and disconnect any active signer.
- Handle browsers without crypto API by blocking generation with an actionable error.
- Validate URL length before QR generation to avoid overly dense codes; if too long, suggest trimming optional metadata.

## Security considerations
- Secret must be unpredictable (crypto random) and stored only in-memory + session cache as needed for reconnect.
- Make sure we do not log full URLs; redact `secret` in console/debug output.
- Ensure helper functions are defined before use (avoid reference-before-definition runtime errors).

## Permissions stance
- Request permissive set by default; signer enforces actual policy. Include read-related decrypt/encrypt and broad sign permissions to reduce back-and-forth (exact set TBD against bundled `bunker-client` capabilities).

## TTL / freshness
- Generate a fresh URL/secret for each login attempt (modal open / explicit regenerate). Consider a short-lived validity (e.g., minutes) and clear after successful login or modal close; keep in-memory only unless needed for reconnect during the attempt.

## Remaining clarifications
- Exact default `perms` list to request given current signer expectations (e.g., `nip44_encrypt`, `nip44_decrypt`, broad `sign_event` ranges). Guidance from signer policy would finalize.
