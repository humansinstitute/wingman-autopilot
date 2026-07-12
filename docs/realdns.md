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

## Cloudflare DNS Setup

For domains managed by the master Autopilot, prefer a normal Cloudflare full-zone setup where Cloudflare is authoritative for the customer domain. The master Autopilot can hold a scoped Cloudflare API token that can edit DNS records for approved zones. The production/remote Autopilot should not hold that token.

Recommended records for a branded app domain:

```txt
# Direct-to-edge IP
A      @      203.0.113.10          Proxied
AAAA   @      2001:db8::10          Proxied
CNAME  www    brandname.com         Proxied

# Or via the remote Wingman public host
CNAME  @      rick.runwingman.com   Proxied
CNAME  www    brandname.com         Proxied
```

Cloudflare supports CNAME flattening at the zone apex, so `brandname.com` can be represented as a CNAME to a public Wingman hostname even though ordinary DNS does not allow a raw apex CNAME. For a subdomain app, use a normal CNAME:

```txt
CNAME  portal  rick.runwingman.com  Proxied
```

Important Cloudflare account boundary: CNAMEs to another hostname that is also on Cloudflare can trigger Cloudflare's `1014 CNAME Cross-User Banned` error when the source and target zones are in different Cloudflare accounts. The simple `brandname.com -> rick.runwingman.com` CNAME model is best when the master Autopilot manages both zones in the same Cloudflare account. If customers keep their own separate Cloudflare accounts and CNAME to Wingman, we may need Cloudflare for SaaS/custom-hostname support or a different target pattern such as explicit A/AAAA records.

The proxied/orange-cloud setting should be the default for HTTP apps. It gives Cloudflare edge TLS, DDoS protection, WebSocket proxying, and hides the origin address. DNS-only/grey-cloud should be reserved for debugging or non-HTTP use cases; in DNS-only mode, browsers connect directly to the returned origin and Cloudflare is no longer the HTTP reverse proxy.

Cloudflare's proxied HTTP service only accepts traffic on supported HTTP/HTTPS ports. For branded domains, users should not have to type a port, so the remote host needs a public edge on `80` and `443` or a Cloudflare Tunnel public hostname. Autopilot itself can still run on `3600` or another internal port.

## Remote Edge Patterns

### Pattern A: Shared Host With Edge Router

Use this when the machine has inbound `80`/`443`, or when another machine/router forwards those ports to it.

```txt
Visitor
  -> Cloudflare edge for brandname.com
  -> rick.runwingman.com public edge on 443
  -> Caddy/Traefik/Nginx/CapRover
  -> http://127.0.0.1:3600
  -> Autopilot host router
  -> app runtime port
```

Requirements:

- The edge router must preserve the original `Host` header.
- The edge router should set `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`.
- The edge router must support WebSocket upgrades.
- The edge router should not rewrite all branded hosts to `rick.runwingman.com`; Autopilot needs to see `brandname.com`.

This is the best default when a remote box has a stable public name like `rick.runwingman.com` but Autopilot itself is not bound to public ports.

### Pattern B: Cloudflare Tunnel

Use this when the machine cannot receive inbound `80`/`443`, such as a home server, NATed machine, or locked-down shared host.

```txt
Visitor
  -> Cloudflare edge for brandname.com
  -> Cloudflare Tunnel
  -> cloudflared on remote machine
  -> http://127.0.0.1:3600
  -> Autopilot host router
  -> app runtime port
```

In this model, the master Autopilot can create DNS records that point hostnames to the tunnel target. The remote machine runs `cloudflared`, but does not need Cloudflare DNS edit credentials.

### Pattern C: DNS-Only Direct Origin

Use this only for internal testing or unusual deployments.

```txt
Visitor
  -> brandname.com DNS answer
  -> origin IP directly
```

This does not give Cloudflare HTTP proxy behavior, edge TLS, or origin hiding. It also does not solve public port mapping by itself.

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

Cloudflare SSL/TLS mode should normally be `Full (strict)` for proxied production traffic. That means the connection from Cloudflare to the origin edge is also HTTPS and the origin presents a certificate Cloudflare can validate for the requested hostname. Practical ways to satisfy that:

- Caddy/Traefik obtains public certificates for each branded hostname.
- The edge uses Cloudflare Origin CA certificates for hostnames that will only be reached through Cloudflare.
- Cloudflare Tunnel terminates the public hostname at Cloudflare and carries traffic through the tunnel to the local service.

Avoid `Flexible` SSL for app hosting. It leaves the Cloudflare-to-origin leg as plain HTTP and tends to create redirect/cookie/security edge cases.

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

For Cloudflare-managed domains, the master should store enough target metadata to choose the right DNS record:

```json
{
  "hostname": "brandname.com",
  "targetKind": "public-host",
  "target": "rick.runwingman.com",
  "proxied": true
}
```

Possible target kinds:

- `ipv4`
- `ipv6`
- `public-host`
- `cloudflare-tunnel`

The remote Autopilot should receive only the app routing registration:

```json
{
  "hostname": "brandname.com",
  "appId": "abc123",
  "status": "pending_dns"
}
```

DNS verification should check the expected public outcome, not merely that any DNS record exists. For proxied Cloudflare records, public DNS queries return Cloudflare anycast addresses, so verification may need to use Cloudflare's API from the master side or compare CNAME/API state rather than expecting to see the origin IP in public DNS.

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

Routing implementation must support WebSocket upgrades before real-domain app hosting can be considered complete. Cloudflare supports proxied WebSockets, and Caddy/Traefik/Nginx can pass them through, but the current Autopilot app proxy path also needs to carry upgrade requests to the selected app runtime.

## Cloudflare References

- CNAME flattening: https://developers.cloudflare.com/dns/cname-flattening/
- Zone apex records: https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-zone-apex/
- Proxy status: https://developers.cloudflare.com/dns/proxy-status/
- Supported proxied ports: https://developers.cloudflare.com/fundamentals/reference/network-ports/
- WebSockets: https://developers.cloudflare.com/network/websockets/
- SSL/TLS modes: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/
- Full strict SSL/TLS: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/
- Cloudflare Tunnel public hostnames: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/
- Error 1014 / cross-account CNAMEs: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014/

## Open Questions

- Should the custom-domain registry live only in local Autopilot storage, or should Tower also know public app domains for Flight Deck launchers?
- Should master Autopilot push domain registrations directly to remotes, or should remotes pull desired domain state from Tower/master?
- Which edge router should be the default documented production path for shared boxes?
- Do we need first-class Cloudflare Tunnel support for machines without direct inbound 80/443?
- Should root domains and `www` be registered as separate explicit hostnames or grouped as one domain bundle in the UI?
