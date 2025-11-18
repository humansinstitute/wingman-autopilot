# NostrConnect (NIP-46) client-initiated flow

## Goal
Expose the client-initiated NIP-46 `nostrconnect://` workflow in the Login via bunker panel so a user can hand their bunker the connection request. The UI must show the generated URL, a copy button, and a QR-code reveal action while keeping the current bunker URI (remote-initiated) path intact.

## Default inputs
- Relays: `wss://relay.nsec.app`, `wss://nos.lol`, `wss://relay.getalby.com/v1`, `wss://nostr.mineracks.com` (configurable/overridable later).
- Secret: short random string included in the URL and validated on `connect` response (spoofing guard required by NIP-46).
- Optional metadata: client name/url/image can be included if available from app config.

## Current state (UI/logic)
- Login via bunker panel only consumes a `bunker://…` URI. It parses it, connects via `NostrConnectSigner.fromBunkerURI`, persists session, and restores on reload (with secret requirement enforcement).
- No client-initiated `nostrconnect://` generation, no UI affordance for copy/QR, and no way to hand the client key/secret to a bunker operator.

## Proposed UX additions
- Add a “Client-initiated (NostrConnect)” subsection in the Login via bunker panel.
- Generate and display a readonly `nostrconnect://…` URL aligned with the session seed (client pubkey + secret + default relays).
- Provide:
  - `Copy` control (confirms when copied).
  - `Show QR` toggle/modal rendering the URL as a QR code for scanning (ensure data URI uses `application/javascript` MIME when served under `src/ui` if a helper is added).
- Present brief helper text explaining when to use this versus pasting a `bunker://` URI.

## Flow design (client-initiated)
1. On panel init (or when user clicks “Generate”), ensure we have/derive a client keypair (new ephemeral keypair; reuse during the page session unless the user regenerates).
2. Build URL:
   - scheme: `nostrconnect://`
   - host: `<client-pubkey-hex>`
   - query: multiple `relay=` params (default list), `secret=<random>`, optional `perms=<comma separated>`, `name`, `url`, `image`.
3. Render URL in readonly field + copy + QR; mask/shorten in UI but copy/QR should use full value.
4. Store the generated secret with the active keypair so we can validate the returned `connect` response.
5. When the bunker connects back (remote-signer initiated response), reuse existing `NostrConnectSigner` flow but source the client keypair/secret from this generated state (not textarea).
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

## Open questions
- Should the default relay list be configurable via server config or UI? Any relays to exclude by policy?
- Do we want an explicit “Regenerate URL” button or regenerate on every page load?
- Should permissions (`perms`) be pre-set (e.g., `nip44_encrypt`, `sign_event:*`) or user-selectable in the panel?
- Do we need to enforce a TTL on the generated secret / URL for security UX?
