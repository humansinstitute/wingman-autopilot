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

In implementation, `rick.runwingman.com` can be the human/operator name for the remote box, but Cloudflare should avoid origin ambiguity. If `rick.runwingman.com` itself is proxied, the master may choose to create branded records directly to the server IP instead, or maintain a DNS-only origin hostname such as `origin-rick.runwingman.com` and point proxied branded CNAMEs there:

```txt
A      origin-rick  203.0.113.10                DNS only
CNAME  @            origin-rick.runwingman.com  Proxied
```

The product can still display the target as `rick.runwingman.com`; internally the DNS writer can resolve that target to the safest Cloudflare record shape for the deployment.

A DNS-only origin helper is not an origin-hiding security boundary because anyone who knows the helper hostname can resolve it. If origin hiding matters, prefer direct proxied A/AAAA records for branded domains plus an origin firewall that only allows Cloudflare source ranges, or use Cloudflare Tunnel.

Cloudflare supports CNAME flattening at the zone apex, so `brandname.com` can be represented as a CNAME to a public Wingman hostname even though ordinary DNS does not allow a raw apex CNAME. For a subdomain app, use a normal CNAME:

```txt
CNAME  portal  rick.runwingman.com  Proxied
```

Assumption: managed domains and Wingman public hostnames are in the same Cloudflare account. That avoids Cloudflare's cross-account CNAME restriction for this first implementation. If customers later keep their own separate Cloudflare accounts and CNAME to Wingman, we may need Cloudflare for SaaS/custom-hostname support or a different target pattern such as explicit A/AAAA records.

The proxied/orange-cloud setting should be the default for HTTP apps. It gives Cloudflare edge TLS, DDoS protection, WebSocket proxying, and hides the origin address. DNS-only/grey-cloud should be reserved for debugging or non-HTTP use cases; in DNS-only mode, browsers connect directly to the returned origin and Cloudflare is no longer the HTTP reverse proxy.

Cloudflare's proxied HTTP service only accepts traffic on supported HTTP/HTTPS ports. For branded domains, users should not have to type a port, so the remote host needs a public edge on `80` and `443`, another Cloudflare-supported HTTPS origin port such as `8443`, or a Cloudflare Tunnel public hostname. Autopilot itself can still run on `3600` or another internal port.

## Remote Edge Patterns

### Pattern A: Public Origin Edge Router

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

This is useful for CapRover or servers that already operate a public HTTPS edge. It is not the default path for Docker/Bun installs that already use Cloudflare Tunnel.

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

There are three possible TLS models:

1. Cloudflare Tunnel terminates public TLS at Cloudflare.
   - `cloudflared` opens an outbound tunnel from the machine to Cloudflare.
   - Cloudflare maps public hostnames to local services such as `http://localhost:3600`.
   - The remote machine does not need inbound `80`/`443`.
   - The local Autopilot service can stay HTTP.
   - This is the preferred path for Docker-on-host and Bun-on-3600 installs.

2. External edge router terminates TLS.
   - Caddy, Traefik, Nginx, CapRover, or another host-level router owns ports 80/443.
   - It forwards requests to the local Autopilot port.
   - It preserves `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`.
   - This is still useful for public servers and CapRover-style deployments.

3. Autopilot terminates TLS directly.
   - Autopilot would need ACME certificate issuance, renewal, storage, and validation handling.
   - This is more integrated but heavier and more failure-prone.

Near-term preference: use a simple integrated Autopilot host router, but let the machine-level edge component handle public TLS and port 80/443 concerns when needed.

Cloudflare SSL/TLS mode should normally be `Full (strict)` for proxied production traffic that uses a public origin edge. That means the connection from Cloudflare to the origin edge is also HTTPS and the origin presents a certificate Cloudflare can validate for the requested hostname. Practical ways to satisfy that:

- Caddy/Traefik obtains public certificates for each branded hostname.
- The edge uses Cloudflare Origin CA certificates for hostnames that will only be reached through Cloudflare.
- Cloudflare Tunnel terminates the public hostname at Cloudflare and carries traffic through the tunnel to the local service.

Avoid `Flexible` SSL for app hosting. It leaves the Cloudflare-to-origin leg as plain HTTP and tends to create redirect/cookie/security edge cases.

## TLS Termination Model

TLS has two common shapes.

Tunnel shape:

```txt
Browser
  -> HTTPS to Cloudflare edge
  -> Cloudflare Tunnel transport
  -> HTTP to Autopilot on localhost/container host port
  -> HTTP inside the host to the app runtime port
```

Public origin edge shape:

```txt
Browser
  -> HTTPS to Cloudflare edge
  -> HTTPS to the remote origin edge
  -> HTTP inside the host/container to Autopilot
  -> HTTP inside the host to the app runtime port
```

Cloudflare terminates visitor-facing TLS for `brandname.com`. Because the customer domain is managed in Cloudflare, Cloudflare can issue and serve the public edge certificate.

For a normal proxied public origin in `Full (strict)`, Cloudflare also expects the origin edge to present a certificate valid for the requested hostname, for example `brandname.com`. This is true even if the DNS record is a CNAME to `rick.runwingman.com`: the visitor asked for `brandname.com`, so the origin edge must be ready for that host unless a Cloudflare feature explicitly overrides origin/SNI behavior.

For Cloudflare Tunnel, the public hostname terminates at Cloudflare and the origin connection is the tunnel to `cloudflared`. The local Autopilot service can stay HTTP on `localhost:3600` or a Docker-published host port. There is no Caddy/Nginx origin certificate requirement in that path.

The stable public-origin production model is:

- Cloudflare edge certificate: automatic/public Cloudflare certificate for the branded hostname.
- Origin edge certificate: Caddy/Traefik/CapRover/Cloudflare Origin CA certificate for the same branded hostname.
- Internal Autopilot traffic: plain HTTP to `127.0.0.1:3600` or the container's internal `3600`.

Cloudflare Tunnel is the default for local Docker/Bun installs: public TLS terminates at Cloudflare, and `cloudflared` carries traffic to local Autopilot. The local service can stay HTTP because it is not directly exposed as the public TLS origin, and the public-origin certificate requirement above does not apply to the local `http://127.0.0.1:3600` service.

## Tunnel TLS and Host Routing Feasibility

Yes, the tunnel-first setup is workable for real domains as long as Autopilot treats Cloudflare Tunnel as the public edge and requires host-preserving routes.

For each hostname, Cloudflare Tunnel needs a published application route:

```txt
brandname.com             -> http://127.0.0.1:3600
www.brandname.com         -> http://127.0.0.1:3600
*.rick.runwingman.com     -> http://127.0.0.1:3600
```

For Docker, replace `127.0.0.1:3600` with the Docker-published base-machine port, for example `localhost:3601`.

TLS behavior:

- Browser TLS terminates at Cloudflare for `brandname.com`.
- Cloudflare presents the public certificate for the branded hostname.
- `cloudflared` carries the request to the local HTTP service.
- Autopilot does not need a local TLS certificate for `brandname.com` in the tunnel path.

Routing behavior:

- Cloudflare must route every branded hostname and relevant wildcard hostname to the same Autopilot service URL.
- The request that reaches Autopilot must preserve the visitor-facing `Host`, for example `brandname.com`.
- Do not set a fixed Cloudflare Tunnel `httpHostHeader` such as `rick.runwingman.com` for these routes, because that would hide the branded hostname from Autopilot.
- Autopilot then resolves `Host` through its custom-domain registry first, generated app aliases second, and its own UI/API last.

This means the master Autopilot can safely automate:

1. Add/verify the domain in the managed Cloudflare account.
2. Add a Tunnel public hostname route for `brandname.com` to the remote Autopilot local service URL.
3. Add a Tunnel public hostname route for `www.brandname.com` if requested.
4. Register `brandname.com` and `www.brandname.com` against the target app in the remote Autopilot custom-domain registry.

The remote production Autopilot still does not need Cloudflare API keys. It only needs the app-domain route registration.

Primary setup risks:

- Host header rewrite: a fixed `httpHostHeader` breaks Autopilot domain routing.
- Missing public hostname route: DNS alone is not enough for Tunnel-backed apps; the Tunnel route must exist.
- Wildcard depth: `*.rick.runwingman.com` covers one label only; deeper generated names need matching wildcard coverage.
- WebSockets: Cloudflare Tunnel can carry WebSockets, but Autopilot's app proxy still needs upgrade forwarding for app WebSockets.
- Multiple Autopilots on one machine: each public hostname must map to the correct local port.

## Records and Routing by Deployment

### 1. Autopilot Running in CapRover

CapRover is the origin edge. It owns public `80`/`443`, terminates origin TLS, and forwards to the Autopilot container's HTTP port `3600`.

Cloudflare records:

```txt
# Remote host / CapRover box
A      rick              203.0.113.10          Proxied
A      origin-rick       203.0.113.10          DNS only

# Branded app domain
CNAME  @                 origin-rick.runwingman.com Proxied
CNAME  www               brandname.com         Proxied

# Optional generated app aliases
CNAME  *.rick            rick.runwingman.com   Proxied
```

CapRover setup:

- Autopilot is a CapRover web app with container HTTP port `3600`.
- WebSocket support is enabled for the CapRover app.
- `brandname.com` and `www.brandname.com` are added as custom domains on the Autopilot CapRover app.
- HTTPS is enabled for those custom domains, or the CapRover edge has an origin certificate covering them.
- CapRover forwards the original `Host` header to the Autopilot container.

Request path:

```txt
Browser https://brandname.com
  -> Cloudflare edge TLS for brandname.com
  -> HTTPS to CapRover for Host: brandname.com
  -> CapRover TLS terminates and routes Host: brandname.com to Autopilot app
  -> HTTP to Autopilot container on :3600
  -> Autopilot custom-domain registry maps brandname.com to appId
  -> Autopilot proxies to that app's runtime port
```

CapRover edge concerns:

- CapRover generally needs every branded hostname registered on the Autopilot app, unless there is a deliberate catch-all/wildcard configuration.
- Let's Encrypt issuance can be sensitive to DNS/proxy state; Cloudflare Origin CA certificates may be simpler when traffic always stays behind Cloudflare.
- CapRover must not redirect or canonicalize `brandname.com` to `rick.runwingman.com`; Autopilot needs to receive the branded `Host`.
- App WebSockets require both CapRover WebSocket support and Autopilot's app proxy to support upgrade forwarding.

### 2. Autopilot Running in Docker on a Host

The preferred Docker setup uses `cloudflared` on the base machine, outside the Wingman container. The container publishes its internal `3600` to a host port such as `3600`, `3601`, or a provisioned `WINGMAN_HOST_PORT`; the tunnel maps public hostnames to that host port.

Cloudflare public hostname / tunnel mappings:

```txt
# Existing Autopilot host
rick.runwingman.com       -> http://localhost:3600

# Optional generated app aliases
*.rick.runwingman.com     -> http://localhost:3600

# Branded app domain
brandname.com             -> http://localhost:3600
www.brandname.com         -> http://localhost:3600
```

In Cloudflare DNS this is represented by tunnel-backed proxied hostnames, commonly CNAMEs to the tunnel target such as `<tunnel-id>.cfargotunnel.com`. The master Autopilot should treat this as a Cloudflare Tunnel public hostname registration, not as an A record to the server IP.

Host setup:

- Docker runs Autopilot with internal `PORT=3600`.
- Docker publishes the container port to a base-machine port, for example `localhost:3600`.
- `cloudflared` runs on the base machine and points each public hostname at that local port.
- Multiple Docker Autopilot instances can share one machine by using different host ports and tunnel hostname mappings.
- Bundling `cloudflared` into the Wingman image is not the default plan.

Request path:

```txt
Browser https://brandname.com
  -> Cloudflare edge TLS for brandname.com
  -> Cloudflare Tunnel public hostname route
  -> cloudflared on base machine
  -> HTTP to Docker-published Autopilot port, e.g. localhost:3600
  -> Autopilot maps brandname.com to appId
  -> Autopilot proxies to that app's runtime port
```

Docker edge concerns:

- Do not expose app runtime ports publicly. They should be reachable only from Autopilot or the host network.
- Bind the Docker-published Autopilot port to loopback where possible.
- Public tunnel hostnames and wildcard app hostnames must be configured in Cloudflare Tunnel, not only in DNS.
- Cloudflare edge certificates must cover each public hostname. A wildcard only covers one label, so `*.runwingman.com` does not cover `rare-zap-horn.rick.runwingman.com`; that needs `*.rick.runwingman.com`.
- The tunnel must preserve the original `Host`; Autopilot uses that host to route custom domains.
- A host-level reverse proxy remains an alternate deployment option, but it is not the Docker-first default.

### 3. Autopilot Running as a Bun Install on Port 3600

Autopilot runs directly on the host as a Bun process. The preferred public exposure is a Cloudflare Tunnel public hostname that targets `http://127.0.0.1:3600`.

Cloudflare public hostname / tunnel mappings:

```txt
# Existing Autopilot host
rick.runwingman.com       -> http://127.0.0.1:3600

# Optional generated app aliases
*.rick.runwingman.com     -> http://127.0.0.1:3600

# Branded app domain
brandname.com             -> http://127.0.0.1:3600
www.brandname.com         -> http://127.0.0.1:3600
```

Host setup:

- Bun Autopilot listens on `127.0.0.1:3600`.
- `cloudflared` runs on the host and maps public hostnames to `http://127.0.0.1:3600`.
- No local Nginx/Caddy reverse proxy is required for the primary tunnel path.
- The master Autopilot can add tunnel public hostnames through Cloudflare; the production Bun Autopilot does not need Cloudflare API keys.

Request path:

```txt
Browser https://brandname.com
  -> Cloudflare edge TLS for brandname.com
  -> Cloudflare Tunnel public hostname route
  -> cloudflared on the Bun host
  -> HTTP to Bun Autopilot on 127.0.0.1:3600
  -> Autopilot maps brandname.com to appId
  -> Autopilot proxies to that app's runtime port
```

Bun install edge concerns:

- Port `3600` is not a public web port for Cloudflare proxied traffic; visitors should never need `:3600` in the URL.
- The host firewall should restrict direct access to `3600` and app runtime ports.
- Running Autopilot directly on public `80`/`443` would require Autopilot to own TLS/cert automation, which is not the preferred near-term design.
- Tunnel public hostnames must include both the Autopilot base host and any wildcard/custom app hostnames that should route to this Autopilot.
- Process restarts should not be driven by agents inside Autopilot sessions; the operator should restart the service externally.

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

For tunnel targets, the DNS record is usually managed as a Cloudflare Tunnel public hostname rather than a raw DNS record to an IP address. The business record should store the tunnel ID/name and service URL, for example `http://localhost:3600`, so the master can update the correct Cloudflare Tunnel route.

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
- Should CapRover custom domains be updated by master Autopilot directly, or should CapRover continue to be configured separately from DNS?
- Do we need first-class Cloudflare Tunnel API support for adding/removing public hostnames on Docker/Bun instances?
- Should root domains and `www` be registered as separate explicit hostnames or grouped as one domain bundle in the UI?
