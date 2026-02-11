# Wingman Isolation & Multi-Tenant Deployment Design

## 1. Overview

This document describes the architecture for deploying isolated Wingman instances for multiple client companies. Each company gets their own Wingman deployment with:

- Isolated filesystem and execution environment
- Their own API keys and configuration
- Persistent storage that survives upgrades
- Auto-generated Wingman Nostr identity (nsec/npub)
- Dedicated DNS with subdomain routing
- Resource limits to prevent runaway usage

The same Docker image works for both managed hosting (we provision) and self-hosting (client runs their own).

---

## 2. Deployment Models

### 2.1 Primary: Large VM + Docker Isolation

A single powerful Proxmox VM hosts multiple client containers. A shared reverse proxy routes traffic by subdomain.

```
Proxmox Host (DC operator)
└── VM: wingman-fleet-01 (e.g. 32 cores, 128GB RAM, 2TB SSD)
    ├── Traefik reverse proxy (ports 80/443)
    ├── Docker: wm01 (Company A) ─── wm01.otherstuff.ai
    ├── Docker: wm02 (Company B) ─── wm02.otherstuff.ai
    ├── Docker: wm03 (Company C) ─── wm03.otherstuff.ai
    └── Shared Docker network (internal only)
```

**Advantages:**
- Efficient resource utilisation (shared kernel, base image layers cached)
- Fast provisioning (~seconds to spin up a new client)
- Single OS to maintain and patch
- Central monitoring and log aggregation
- Port allocation is a non-issue (every container uses 3600/3700-3710 internally)

**Trade-offs:**
- Shared kernel (container escape is a known attack class, mitigated by rootless Docker)
- Single point of failure (host VM down = all clients down)
- Noisy neighbour risk (mitigated by Docker resource limits)

### 2.2 Alternative: Dedicated VM per Company

For clients requiring stronger isolation (compliance, SLA, SSH access), provision a dedicated Proxmox VM per company.

```
Proxmox Host
├── VM: wm-acme-corp (4 cores, 16GB, 200GB)
│   └── Docker: Wingman ─── wm01.otherstuff.ai
├── VM: wm-globex (4 cores, 16GB, 200GB)
│   └── Docker: Wingman ─── wm02.otherstuff.ai
```

**When to use this model:**
- Client requires SSH access to their environment
- Regulatory/compliance requirement for kernel-level isolation
- Client needs custom agent binaries or OS-level packages
- Higher SLA with independent failure domains

### 2.3 Self-Hosted (Same Image)

Client pulls the same Docker image and runs on their own infrastructure. We provide:
- Docker image via registry
- `docker-compose.yml` template
- DNS instructions (point domain + wildcard at their host)
- Setup script that handles first-boot configuration

---

## 3. Container Architecture

### 3.1 What's Inside Each Container

```
/app/                     # Wingman application (read-only at runtime)
├── src/
├── node_modules/
├── public/
├── out/agentapi
└── package.json

/app/data/                # Persistent state (mounted volume)
├── wingman.db            # SQLite database
├── .identity_session_secret
├── wingman-identity.json # Auto-generated nsec/npub
└── logs/

/workspace/               # Client workspace (mounted volume)
├── projects/
└── ...

/app/config/              # Runtime configuration (mounted volume)
└── .env                  # API keys, feature flags, admin npub
```

### 3.2 Volume Strategy

| Volume | Purpose | Backup Priority | Size Limit |
|--------|---------|-----------------|------------|
| `data` | SQLite DB, identity, session secrets | Critical | 5GB default |
| `workspace` | Client project files, agent working directory | High | Configurable per client (e.g. 20-100GB) |
| `config` | Environment file, overrides | Critical | 10MB |

Volumes are **named Docker volumes** on managed deployments and **bind mounts** for self-hosted.

### 3.3 Disk Quota Enforcement

Docker volumes have **no native size quota**. Since agents can install large dependency trees (a single Next.js project can pull 500MB+ of `node_modules`), disk limits must be enforced at the host level.

#### Primary: XFS Project Quotas (Recommended for Fleet)

The host VM's volume partition must be formatted as XFS with project quotas enabled:

```bash
# Host setup (one-time, in Proxmox VM template)
mkfs.xfs /dev/sdb
mount -o pquota /dev/sdb /var/lib/docker/volumes

# Per-client quota (run during provisioning)
xfs_quota -x -c "project -s -p /var/lib/docker/volumes/wm01-workspace 101" /dev/sdb
xfs_quota -x -c "limit -p bhard=50g 101" /dev/sdb

xfs_quota -x -c "project -s -p /var/lib/docker/volumes/wm01-data 102" /dev/sdb
xfs_quota -x -c "limit -p bhard=5g 102" /dev/sdb
```

This gives hard kernel-level enforcement with zero runtime overhead. When the limit is hit, writes fail with `ENOSPC` — `npm install` and similar tools handle this gracefully.

#### Fallback: Loopback Device (Simpler, Portable)

If XFS isn't available, create a fixed-size file per volume:

```bash
truncate -s 50G /volumes/wm01-workspace.img
mkfs.ext4 /volumes/wm01-workspace.img
mount -o loop /volumes/wm01-workspace.img /mnt/wm01-workspace
# Then bind-mount /mnt/wm01-workspace into the container
```

Hard limit enforced. Downside: can't resize without downtime (must create larger image, copy data, swap).

#### Always: Monitoring Sidecar

Regardless of quota method, run a periodic disk usage check:

| Threshold | Action |
|-----------|--------|
| 80% of plan limit | Warning in Wingman admin UI |
| 90% | Block new agent sessions, notify operator |
| 95% | Alert operator, suggest cleanup or plan upgrade |

```bash
# Cron job or monitoring sidecar
du -sb /var/lib/docker/volumes/wm01-workspace/_data | awk '{
  used=$1; limit=50*1024*1024*1024;
  pct=used/limit*100;
  if (pct > 80) print "WARN: wm01 workspace at " pct "%"
}'
```

#### Quota by Plan

| Plan | Workspace Quota | Data Quota | Total Disk |
|------|----------------|------------|------------|
| Starter | 20GB | 2GB | ~22GB |
| Standard | 50GB | 5GB | ~55GB |
| Pro | 100GB | 10GB | ~110GB |

### 3.4 Resource Limits (CPU/Memory)

Each container runs with enforced limits to prevent runaway agents:

```yaml
deploy:
  resources:
    limits:
      cpus: '4'          # Per-client CPU cap
      memory: 8G         # Per-client memory cap
    reservations:
      cpus: '1'          # Guaranteed minimum
      memory: 2G
```

Disk quota enforced at the volume level:
- **Workspace:** Configurable per client plan (default 50GB)
- **Data:** 5GB cap (SQLite + logs + identity)
- Enforcement via Docker storage driver quotas or external monitoring with alerts

### 3.4 Agent Binary Provisioning

Agent CLIs (claude, codex, goose, opencode, gemini) must be available inside the container. Strategy:

1. **Base image includes agentapi** (already done in current Dockerfile)
2. **Agent CLIs installed during setup phase** via a setup script that runs on first boot
3. **Client provides their own API keys** for each agent via the `.env` config file
4. Agent authentication flows that require browser interaction (e.g. `claude` CLI login) are handled via the Wingman UI's existing Key Teleport flow

```
# Client's .env file
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API=sk-or-...
```

---

## 4. Networking & DNS

### 4.1 Domain Model

Each Wingman instance gets a numbered subdomain:

```
wm01.otherstuff.ai           # Wingman UI/API (coordinator)
*.wm01.otherstuff.ai         # Subdomain routing for agent proxies, deployed apps
```

DNS records required per instance:
```
A     wm01.otherstuff.ai       → <host-ip>
A     *.wm01.otherstuff.ai     → <host-ip>
```

For the fleet model, all records point to the same VM IP. Traefik routes by hostname.

### 4.2 Reverse Proxy (Traefik)

A single Traefik instance runs alongside the fleet, handling:
- TLS termination (Let's Encrypt wildcard certs via DNS challenge)
- Hostname-based routing to the correct container
- WebSocket proxying (required for agent live streaming)
- Health check routing

```yaml
# Traefik dynamic config (auto-generated per client)
http:
  routers:
    wm01:
      rule: "HostRegexp(`wm01.otherstuff.ai`) || HostRegexp(`{subdomain:.+}.wm01.otherstuff.ai`)"
      service: wm01
      tls:
        certResolver: letsencrypt
  services:
    wm01:
      loadBalancer:
        servers:
          - url: "http://wm01:3600"
```

### 4.3 Internal Networking

Each container joins a shared Docker bridge network but only exposes port 3600 to Traefik. Agent ports (3700-3710) stay internal — Wingman's existing subdomain proxy handles routing to agents without exposing their ports directly.

```
┌─────────────────────────────────────────┐
│ Docker network: wingman-fleet           │
│                                         │
│  Traefik:80/443 ──→ wm01:3600         │
│                  ──→ wm02:3600         │
│                  ──→ wm03:3600         │
│                                         │
│  wm01:3700-3710 (internal only)        │
│  wm02:3700-3710 (internal only)        │
└─────────────────────────────────────────┘
```

### 4.4 Port Allocation Simplification

Docker network namespaces eliminate port collision entirely. Every container runs the same ports internally:
- `3600` — Wingman API/UI
- `3700-3710` — Agent sessions

No changes needed to Wingman's port allocation logic. The `AGENT_PORTS` and `AGENT_MAX` env vars work as-is.

---

## 5. Identity & Security

### 5.1 Wingman Server Identity (Auto-Generated)

On first boot, if no identity exists, the container generates a fresh Nostr keypair:

1. Generate random 32-byte secret key using `@noble/hashes`
2. Derive npub from the secret key
3. Store as `data/wingman-identity.json`:
   ```json
   {
     "nsec": "nsec1...",
     "npub": "npub1...",
     "created_at": "2026-02-10T...",
     "instance_id": "wm01"
   }
   ```
4. Set `KEYTELEPORT_PRIVKEY` from this generated key
5. Log the npub to stdout on first boot so the operator can record it

This identity is used for Tier 1 MCP signing (Wingman acts on its own behalf).

### 5.2 Admin Assignment

The admin npub is provided as a provisioning input:

```bash
# During setup
ADMIN_NPUB=npub1abc...xyz ./setup.sh
```

This gets written to the instance's `.env` and gates access to:
- User management
- Feature flag configuration
- System settings
- Retrieving the Wingman server npub/identity

### 5.3 User Onboarding Flow

1. Admin logs in with their Nostr identity (NIP-07 or Key Teleport)
2. Admin adds team members by npub, assigning roles
3. Team members log in with their own Nostr identities
4. Each user's sessions and data are scoped by their npub within the shared instance

### 5.4 Security Hardening

- **Rootless Docker:** Run containers as non-root user to limit container escape risk
- **Read-only root filesystem:** Mount `/app` as read-only, only `/app/data` and `/workspace` are writable
- **No privileged mode:** Containers run with minimal capabilities
- **Secret isolation:** Each container's `.env` is only readable by that container
- **Network isolation:** Containers cannot communicate with each other, only with Traefik

```yaml
security_opt:
  - no-new-privileges:true
read_only: true
tmpfs:
  - /tmp
cap_drop:
  - ALL
cap_add:
  - NET_BIND_SERVICE
```

---

## 6. Provisioning & Lifecycle

### 6.1 Provisioning Flow

```
Operator runs: ./provision.sh --id wm04 --admin-npub npub1... --plan standard

1. Create named volumes: wm04-data, wm04-workspace, wm04-config
2. Generate .env with instance ID, admin npub, resource limits
3. Add DNS records (Cloudflare API): wm04.otherstuff.ai + *.wm04
4. Add Traefik dynamic config for wm04
5. docker compose up -d wm04
6. Wait for health check
7. First boot: auto-generates Wingman identity
8. Output: instance URL, Wingman npub, admin login instructions
```

### 6.2 Client Plans / Tiers

Resource allocation varies by plan:

| Plan | CPU | RAM | Workspace Disk | Agent Slots | Price Basis |
|------|-----|-----|----------------|-------------|-------------|
| Starter | 2 cores | 4GB | 20GB | 3 | Entry |
| Standard | 4 cores | 8GB | 50GB | 5 | Mid |
| Pro | 8 cores | 16GB | 100GB | 10 | High |

Plans are enforced via Docker resource limits and `AGENT_MAX` env var.

### 6.3 Upgrades

Rolling upgrades without data loss:

```bash
# Pull new image
docker pull registry.otherstuff.ai/wingman:latest

# Restart specific instance (volumes persist)
docker compose up -d --no-deps wm04

# Or rolling upgrade all instances
for id in wm01 wm02 wm03 wm04; do
  docker compose up -d --no-deps $id
  sleep 10  # health check interval
done
```

Data volumes are never touched during upgrades. The container is stateless — all state lives in mounted volumes.

### 6.4 Backup & Recovery

**Automated backups:**
- SQLite database: daily snapshot of `data/wingman.db` via `sqlite3 .backup`
- Workspace: incremental rsync to backup storage
- Config: version-controlled alongside provisioning scripts

**Recovery:**
```bash
# Restore from backup
docker compose down wm04
# Restore volumes from backup
docker compose up -d wm04
```

### 6.5 Deprovisioning

```bash
# Graceful shutdown
docker compose down wm04
# Archive data (retain for N days per policy)
tar -czf /backups/wm04-$(date +%Y%m%d).tar.gz /volumes/wm04-*
# Remove DNS records
# Remove Traefik config
# Remove volumes after retention period
```

---

## 7. Monitoring & Operations

### 7.1 Health Checks

Each container exposes a health endpoint:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3600/health"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 15s
```

### 7.2 Centralized Logging

All containers log to stdout/stderr. Docker log driver forwards to a central aggregator:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "50m"
    max-file: "3"
    tag: "{{.Name}}"
```

For production fleet: use `fluentd` or `loki` driver to aggregate logs across instances.

### 7.3 Disk Usage Monitoring

Periodic check of volume sizes per instance:

```bash
# Alert if workspace exceeds 80% of plan limit
du -sh /var/lib/docker/volumes/wm04-workspace/_data
```

### 7.4 Instance Dashboard

The existing Wingman admin UI (accessible via admin npub) shows:
- Active sessions and resource usage
- Agent status and health
- Disk usage warnings
- Identity information (Wingman npub)

Future: a fleet-level dashboard for the operator to see all instances at a glance.

---

## 8. Docker Compose Template

```yaml
# docker-compose.fleet.yml
version: '3.9'

services:
  traefik:
    image: traefik:v3.0
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-certs:/certs
    environment:
      CF_DNS_API_TOKEN: ${CF_DNS_API_TOKEN}
    networks:
      - wingman-fleet

  # Template for each client instance
  # Duplicated per client with unique labels and volumes
  wm01:
    image: registry.otherstuff.ai/wingman:latest
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wm01.rule=HostRegexp(`wm01.otherstuff.ai`) || HostRegexp(`{sub:.+}.wm01.otherstuff.ai`)"
      - "traefik.http.routers.wm01.tls=true"
      - "traefik.http.routers.wm01.tls.certresolver=letsencrypt"
      - "traefik.http.routers.wm01.tls.domains[0].main=wm01.otherstuff.ai"
      - "traefik.http.routers.wm01.tls.domains[0].sans=*.wm01.otherstuff.ai"
      - "traefik.http.services.wm01.loadbalancer.server.port=3600"
    env_file:
      - ./instances/wm01/.env
    volumes:
      - wm01-data:/app/data
      - wm01-workspace:/workspace
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G
        reservations:
          cpus: '1'
          memory: 2G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3600/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks:
      - wingman-fleet
    restart: unless-stopped

volumes:
  traefik-certs:
  wm01-data:
  wm01-workspace:

networks:
  wingman-fleet:
    driver: bridge
```

---

## 9. Provisioning Script (Outline)

```bash
#!/bin/bash
# provision.sh — Add a new Wingman instance to the fleet

set -euo pipefail

INSTANCE_ID=""
ADMIN_NPUB=""
PLAN="standard"
DOMAIN_BASE="otherstuff.ai"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --id) INSTANCE_ID="$2"; shift 2;;
    --admin-npub) ADMIN_NPUB="$2"; shift 2;;
    --plan) PLAN="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

# Validate
[[ -z "$INSTANCE_ID" ]] && echo "ERROR: --id required" && exit 1
[[ -z "$ADMIN_NPUB" ]] && echo "ERROR: --admin-npub required" && exit 1

# 1. Create instance config directory
mkdir -p "instances/${INSTANCE_ID}"

# 2. Generate .env from plan template
cat > "instances/${INSTANCE_ID}/.env" <<EOF
NODE_ENV=production
PORT=3600
AGENT_PORTS=3700
AGENT_MAX=$(plan_agent_max $PLAN)
DIRECTORY_DEF=/workspace
FOLDERACCESS=/workspace
ADMIN_NPUB=${ADMIN_NPUB}
WINGMAN_BASE_URL=https://${INSTANCE_ID}.${DOMAIN_BASE}
SUBDOMAIN_BASE_DOMAIN=${INSTANCE_ID}.${DOMAIN_BASE}
SUBDOMAIN_PROXY_ENABLED=true
INSTANCE_ID=${INSTANCE_ID}
# Client adds their own API keys below:
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API=
EOF

# 3. Add DNS records via Cloudflare API
add_dns_record "${INSTANCE_ID}.${DOMAIN_BASE}" "$HOST_IP"
add_dns_record "*.${INSTANCE_ID}.${DOMAIN_BASE}" "$HOST_IP"

# 4. Generate docker-compose override for this instance
generate_compose_service "$INSTANCE_ID" "$PLAN"

# 5. Start the instance
docker compose -f docker-compose.fleet.yml up -d "$INSTANCE_ID"

# 6. Wait for health and retrieve generated identity
sleep 10
WINGMAN_NPUB=$(docker exec "$INSTANCE_ID" cat /app/data/wingman-identity.json | jq -r .npub)

echo "=== Instance Provisioned ==="
echo "URL:           https://${INSTANCE_ID}.${DOMAIN_BASE}"
echo "Admin npub:    ${ADMIN_NPUB}"
echo "Wingman npub:  ${WINGMAN_NPUB}"
echo "Plan:          ${PLAN}"
```

---

## 10. First-Boot Sequence

When a container starts for the first time (empty `data` volume):

```
1. Check /app/data/wingman-identity.json exists
   └─ NO → Generate new Nostr keypair
           Write to /app/data/wingman-identity.json
           Set KEYTELEPORT_PRIVKEY in memory
           Log: "Generated Wingman identity: npub1..."

2. Check /app/data/.identity_session_secret exists
   └─ NO → Generate random session secret
           Write to /app/data/.identity_session_secret

3. Check /app/data/wingman.db exists
   └─ NO → Initialize SQLite with schema migrations

4. Read ADMIN_NPUB from environment
   └─ Register admin user with full permissions

5. Start HTTP server on port 3600
6. Report healthy on /health endpoint
```

---

## 11. Open Questions & Future Work

### Decided
- [x] Isolation boundary: Docker containers on shared VM (with VM option for premium)
- [x] Domain model: `wm<nn>.otherstuff.ai` + `*.wm<nn>.otherstuff.ai`
- [x] Identity: Auto-generated per instance, admin npub as provisioning input
- [x] Same image for hosted and self-hosted

### To Decide
- [ ] Docker registry: self-hosted (Harbor) vs managed (GitHub Container Registry)?
- [ ] Backup storage: local disk, S3-compatible, or both?
- [ ] Fleet dashboard: build into Wingman or separate tool?
- [ ] Billing integration: how to meter usage per instance?
- [ ] Agent CLI installation: bake all into image or install on demand per client?
- [ ] Inter-instance communication: do company instances ever need to talk to each other?
- [ ] Log retention policy: how long, where stored, client-accessible?

### Future Enhancements
- **Proxmox API integration**: Automate VM provisioning for dedicated-VM clients directly from the fleet dashboard
- **Auto-scaling**: Monitor resource usage and suggest plan upgrades
- **Snapshot & clone**: Duplicate a configured instance as a template
- **Client self-service portal**: Let clients manage their own API keys, users, and settings without operator intervention
- **Cloudflared tunnels**: Alternative to Traefik for instances that need to punch through NAT without public IPs
