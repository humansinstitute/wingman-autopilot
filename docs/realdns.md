# Real DNS for Autopilot Apps

## Goal

Autopilot should support real customer-owned domain names for hosted apps, for example:

- `brandname.com`
- `www.brandname.com`
- `portal.brandname.com`

These should work as public app URLs alongside the generated Wingman app URL, such as:

- `brand-name.rick.runwingman.com`
- `brand-name.autopilotname.runningman.com`

The generated Wingman URL should remain available as a fallback/debug route. A custom domain is an additional public route to the same registered app.

## Operating Model

There are two different Autopilot roles:

1. Master Autopilot
   - May hold Cloudflare API credentials.
   - Can create/update DNS records.
   - Can coordinate remote deploys, similar to the existing CapRover deployment flow.
   - Can register custom-domain intent against remote Autopilot instances.

2. Production/remote Autopilot
   - Should not need Cloudflare API credentials.
   - Should not manage customer DNS directly.
   - Should only need to know that a hostname is allowed to route to a specific app.
   - Serves traffic for domains that already resolve to its public address or assigned public host.

This keeps DNS authority centralized in the trusted master instance while keeping production app hosts simpler and lower-risk.

## Routing Shape

Autopilot already has generated app aliases and subdomain routing. Real DNS should extend that routing layer rather than becoming a separate deploy path.

Desired host resolution order:

1. Exact custom-domain match.
2. Generated app subdomain match.
3. Autopilot UI/API fallback.

Example mapping:

```txt
brandname.com             -> appId abc123
www.brandname.com         -> appId abc123
brand-name.rick.runwingman.com -> appId abc123
```

The production Autopilot should store a local custom-domain registry containing exact hostnames mapped to app IDs. Incoming requests are routed based on the `Host` header.

## DNS Expectations

The remote box may not listen publicly on port 80 itself. It may be behind another host/router, on a shared server, or exposed through a named public endpoint such as:

```txt
rick.runwingman.com
```

Supported DNS patterns should include:

- `A brandname.com -> server IP`
- `AAAA brandname.com -> server IPv6`
- `CNAME www.brandname.com -> rick.runwingman.com`
- Cloudflare apex flattening for `brandname.com -> rick.runwingman.com`

The important production requirement is that requests arrive at the remote Autopilot edge with the original `Host` header preserved.

## TLS and Edge Routing

There are two possible TLS models:

1. External edge router terminates TLS.
   - Caddy, Traefik, Nginx, CapRover, Cloudflare Tunnel, or another host-level router owns ports 80/443.
   - It forwards requests to the local Autopilot port.
   - It preserves `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`.
   - This is the likely first production path, especially on shared boxes or hosts where Autopilot is not bound directly to 80/443.

2. Autopilot terminates TLS directly.
   - Autopilot would need ACME certificate issuance, renewal, storage, and validation handling.
   - This is more integrated but heavier and more failure-prone.

Near-term preference: use a simple integrated Autopilot host router, but let the machine-level edge component handle public TLS and port 80/443 concerns when needed.

## Master-Controlled DNS Flow

Proposed flow:

1. User selects an app and enters `brandname.com`.
2. Master Autopilot validates ownership/intent.
3. Master Autopilot creates or updates DNS in Cloudflare.
4. Master Autopilot calls the remote Autopilot to register:

```json
{
  "hostname": "brandname.com",
  "appId": "abc123",
  "status": "pending_dns"
}
```

5. Master or remote verifies DNS resolution points at the expected IP or public host.
6. Remote Autopilot marks the domain active and starts routing traffic.

The production instance does not need the Cloudflare API token for any of this.

## Implementation Notes

Likely code additions:

- `src/apps/app-domain-registry.ts`
  - exact hostname to app ID registry
  - hostname normalization and validation
  - duplicate/conflict detection

- focused app domain API routes
  - list domains for app
  - add domain
  - remove domain
  - verify domain
  - mark active/inactive

- generalized app host routing
  - custom domains first
  - generated aliases second
  - existing Autopilot routes last

- app response fields
  - `customDomains`
  - `primaryUrl`
  - generated fallback URL retained

## Open Questions

- Should the custom-domain registry live only in local Autopilot storage, or should Tower also know public app domains for Flight Deck launchers?
- Should master Autopilot push domain registrations directly to remotes, or should remotes pull desired domain state from Tower/master?
- Which edge router should be the default documented production path for shared boxes?
- Do we need first-class Cloudflare Tunnel support for machines without direct inbound 80/443?
- Should root domains and `www` be registered as separate explicit hostnames or grouped as one domain bundle in the UI?

