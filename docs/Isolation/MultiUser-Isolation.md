# Wingman Multi-User Isolation: Implementation Plan

## Executive Summary

**Problem:** Current system uses path-based routing (`host.otherstuff.ai/PORT`) which breaks asset paths when AI edits code. All users run on the same host without isolation, allowing agents to access system files and other users' data.

**Solution:** Switch to subdomain-based routing (`user-alias.PORT.host.otherstuff.ai`) and isolate each user in their own systemd-nspawn container.

**Benefits:**
- Clean URLs without path prefix issues
- Filesystem isolation per user
- Resource management per user
- Agents can't access orchestrator or system files
- Apps "just work" without path-aware code

---

## Current vs Proposed Architecture

### Current State
```
┌─────────────────────────────────────┐
│         Host Machine                │
├─────────────────────────────────────┤
│ Wingman Orchestrator (port 3021)    │
│ Agents (ports 3700-3799)            │
│ User Apps (ports 41000+)            │
│ All in /root/code/wingmen           │
└─────────────────────────────────────┘
         │
         ↓
    nginx reverse proxy
         │
         ↓
  host.otherstuff.ai/41001  ← Path-based routing
```

### Proposed State
```
┌─────────────────────────────────────────────────┐
│              Host Machine                        │
├─────────────────────────────────────────────────┤
│ Wingman Orchestrator (port 3021)                │
│                                                  │
│ ┌────────────────────────────────────────────┐ │
│ │ Container: vivid-teal-lumen                │ │
│ │ ├─ /workspace (bind mount)                 │ │
│ │ ├─ Agents (port 3700)                      │ │
│ │ ├─ User Apps (ports 41001-41003)           │ │
│ │ └─ Isolated filesystem                     │ │
│ └────────────────────────────────────────────┘ │
│                                                  │
│ ┌────────────────────────────────────────────┐ │
│ │ Container: honest-ivory-thicket            │ │
│ │ ├─ /workspace (bind mount)                 │ │
│ │ ├─ Agents (port 3701)                      │ │
│ │ ├─ User Apps (ports 41004-41006)           │ │
│ │ └─ Isolated filesystem                     │ │
│ └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
         │
         ↓
    nginx reverse proxy (wildcard SSL)
         │
         ↓
  vivid-teal-lumen.41001.host.otherstuff.ai  ← Subdomain routing
```

---

## Implementation Plan

### Phase 1: Networking Infrastructure (No Code Changes)

#### 1.1 Wildcard DNS Setup

**Action:** Add wildcard DNS record in Cloudflare

**Steps:**
1. Log into Cloudflare DNS for `otherstuff.ai`
2. Add A record:
   - **Type:** A
   - **Name:** `*.host`
   - **Content:** `188.40.69.154` (server IP)
   - **Proxy status:** DNS only (gray cloud)
   - **TTL:** Auto

**Verification:**
```bash
dig vivid-teal-lumen.41001.host.otherstuff.ai
# Should return: 188.40.69.154
```

#### 1.2 Wildcard SSL Certificate

**Action:** Obtain wildcard SSL certificate via Let's Encrypt

**Steps:**
```bash
# Stop nginx temporarily
systemctl stop nginx

# Get wildcard cert (requires DNS validation)
certbot certonly --manual --preferred-challenges dns \
  -d "*.host.otherstuff.ai" \
  -d "host.otherstuff.ai"

# Certbot will prompt for DNS TXT record:
# Add: _acme-challenge.host.otherstuff.ai → <provided-value>

# Wait 1-2 minutes for DNS propagation
# Verify with: dig TXT _acme-challenge.host.otherstuff.ai

# Press Enter in certbot to continue

# Start nginx
systemctl start nginx
```

**Certificate location:** `/etc/letsencrypt/live/host.otherstuff.ai/`
- Covers: `*.host.otherstuff.ai` and `host.otherstuff.ai`
- Renewal: Manual DNS validation required every 90 days (document renewal process)

#### 1.3 Nginx Configuration

**Action:** Replace path-based routing with subdomain-based routing

**File:** `/etc/nginx/sites-available/host.otherstuff.ai-wildcard`

```nginx
server {
    server_name ~^(?<alias>[a-z-]+)\.(?<port>\d+)\.host\.otherstuff\.ai$;

    location / {
        proxy_pass http://127.0.0.1:$port;
        
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/host.otherstuff.ai/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/host.otherstuff.ai/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    server_name ~^[a-z-]+\.\d+\.host\.otherstuff\.ai$;
    listen 80;
    return 301 https://$host$request_uri;
}
```

**Regex explanation:**
- `(?<alias>[a-z-]+)` - Captures user alias (e.g., `vivid-teal-lumen`)
- `\.` - Literal dot separator
- `(?<port>\d+)` - Captures port number (e.g., `41001`)
- `\.host\.otherstuff\.ai$` - Domain suffix

**Enable and test:**
```bash
# Enable new config
ln -s /etc/nginx/sites-available/host.otherstuff.ai-wildcard /etc/nginx/sites-enabled/

# Test configuration
nginx -t

# Reload nginx
systemctl reload nginx
```

**Migration note:** Keep old path-based config active during testing. Remove after validation:
```bash
rm /etc/nginx/sites-enabled/host.otherstuff.ai
systemctl reload nginx
```

---

### Phase 2: Container Infrastructure Setup

#### 2.1 Install Dependencies

```bash
apt-get update
apt-get install -y systemd-container debootstrap
```

#### 2.2 Create Container Template

**Purpose:** Golden image with all common tools (Bun, Node, Git, etc.) that gets cloned for each user.

**Script:** `/root/scripts/create-template.sh`

```bash
#!/bin/bash
set -e

TEMPLATE="/var/lib/machines/_template"

if [ -d "$TEMPLATE" ]; then
    echo "Template already exists at $TEMPLATE"
    exit 0
fi

echo "Creating container template..."

# Bootstrap minimal Ubuntu
debootstrap --variant=minbase noble $TEMPLATE http://archive.ubuntu.com/ubuntu

# Install common tools
systemd-nspawn -D $TEMPLATE /bin/bash <<'EOF'
    # Update package list
    apt-get update
    
    # Install essential packages
    apt-get install -y \
        curl \
        git \
        tmux \
        ca-certificates \
        unzip \
        build-essential \
        sudo
    
    # Install Bun
    curl -fsSL https://bun.sh/install | bash
    ln -s /root/.bun/bin/bun /usr/local/bin/bun
    
    # Install Node.js
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    
    # Cleanup
    apt-get clean
    rm -rf /var/lib/apt/lists/*
    
    echo "Template setup complete"
EOF

echo "✓ Template created at $TEMPLATE"
echo "✓ Size: $(du -sh $TEMPLATE | cut -f1)"
```

**Run once:**
```bash
chmod +x /root/scripts/create-template.sh
/root/scripts/create-template.sh
```

**Expected result:**
- Template at `/var/lib/machines/_template` (~600MB)
- Contains: Ubuntu base + Bun + Node + Git + tmux

#### 2.3 Container Management Functions

**Script:** `/root/scripts/container-utils.sh`

```bash
#!/bin/bash

# Create new user container from template
create_user_container() {
    local USER_ALIAS=$1
    local CONTAINER_PATH="/var/lib/machines/$USER_ALIAS"
    local WORKSPACE="/home/$USER_ALIAS/workspace"
    local TEMPLATE="/var/lib/machines/_template"
    
    if [ -d "$CONTAINER_PATH" ]; then
        echo "Container $USER_ALIAS already exists"
        return 1
    fi
    
    echo "Creating container for $USER_ALIAS..."
    
    # Clone template (fast copy)
    cp -a $TEMPLATE $CONTAINER_PATH
    
    # Create workspace directories
    mkdir -p $WORKSPACE
    mkdir -p $CONTAINER_PATH/workspace
    
    # Set permissions
    chown -R root:root $WORKSPACE
    chmod -R 755 $WORKSPACE
    
    echo "✓ Container $USER_ALIAS created"
    echo "✓ Workspace: $WORKSPACE"
    
    return 0
}

# Delete user container
delete_user_container() {
    local USER_ALIAS=$1
    local CONTAINER_PATH="/var/lib/machines/$USER_ALIAS"
    local WORKSPACE="/home/$USER_ALIAS/workspace"
    
    if [ ! -d "$CONTAINER_PATH" ]; then
        echo "Container $USER_ALIAS does not exist"
        return 1
    fi
    
    # Stop any running processes in container
    machinectl terminate $USER_ALIAS 2>/dev/null || true
    
    # Remove container
    rm -rf $CONTAINER_PATH
    
    # Optionally preserve workspace
    echo "Workspace preserved at: $WORKSPACE"
    echo "(Delete manually if needed: rm -rf $WORKSPACE)"
    
    echo "✓ Container $USER_ALIAS deleted"
    
    return 0
}

# Execute command inside user container
container_exec() {
    local USER_ALIAS=$1
    shift
    local COMMAND="$@"
    local CONTAINER_PATH="/var/lib/machines/$USER_ALIAS"
    local WORKSPACE="/home/$USER_ALIAS/workspace"
    
    if [ ! -d "$CONTAINER_PATH" ]; then
        echo "Container $USER_ALIAS does not exist"
        return 1
    fi
    
    systemd-nspawn -D $CONTAINER_PATH \
        --bind=$WORKSPACE:/workspace \
        --setenv=HOME=/workspace \
        /bin/bash -c "$COMMAND"
}

# List all containers
list_containers() {
    echo "User Containers:"
    for container in /var/lib/machines/*/; do
        if [ "$(basename $container)" != "_template" ]; then
            local name=$(basename $container)
            local size=$(du -sh $container 2>/dev/null | cut -f1)
            echo "  - $name ($size)"
        fi
    done
}
```

**Usage examples:**
```bash
source /root/scripts/container-utils.sh

# Create container for new user
create_user_container "vivid-teal-lumen"

# Execute command in container
container_exec "vivid-teal-lumen" "bun --version"

# List all containers
list_containers

# Delete container
delete_user_container "vivid-teal-lumen"
```

---

### Phase 3: Wingman Orchestrator Integration

#### 3.1 User Registration Changes

**File:** `src/user-management.ts` (or equivalent)

**Current flow:**
```typescript
// Create user
const user = {
    alias: generateAlias(), // e.g., "vivid-teal-lumen"
    ports: [41001, 41002, 41003]
};
```

**New flow:**
```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

// Create user
const user = {
    alias: generateAlias(), // e.g., "vivid-teal-lumen"
    ports: [41001, 41002, 41003],
    containerPath: `/var/lib/machines/${alias}`,
    workspacePath: `/home/${alias}/workspace`
};

// Create container for user
await execAsync(`/root/scripts/container-utils.sh create_user_container ${user.alias}`);

// Store user in database
await db.users.insert(user);
```

#### 3.2 App Start/Stop Changes

**Current code:**
```typescript
// Start user app
function startApp(userId: string, appId: string, port: number) {
    const sessionName = `wingman-apps-${userId}-${appId}`;
    
    exec(`tmux new-session -d -s ${sessionName} \
        "cd /path/to/app && PORT=${port} bun start"`);
}
```

**New code:**
```typescript
// Start user app inside container
async function startApp(userId: string, appId: string, port: number) {
    const user = await db.users.findById(userId);
    const app = await db.apps.findById(appId);
    const sessionName = `app-${appId}`;
    
    const containerPath = user.containerPath;
    const workspacePath = user.workspacePath;
    const appPath = `${workspacePath}/${app.directory}`;
    
    // Determine start command (from package.json or default)
    const startCommand = app.startCommand || "bun start";
    
    // Start app inside container via tmux
    const command = `
        systemd-nspawn -D ${containerPath} \\
            --bind=${workspacePath}:/workspace \\
            --setenv=PORT=${port} \\
            --setenv=HOME=/workspace \\
            /bin/bash -c "cd /workspace/${app.directory} && tmux new-session -d -s ${sessionName} '${startCommand}'"
    `;
    
    await execAsync(command);
    
    // Store session info for later management
    await db.apps.update(appId, {
        status: 'running',
        port: port,
        tmuxSession: sessionName,
        url: `https://${user.alias}.${port}.host.otherstuff.ai`
    });
    
    return {
        url: `https://${user.alias}.${port}.host.otherstuff.ai`,
        port: port
    };
}
```

**Stop app:**
```typescript
async function stopApp(userId: string, appId: string) {
    const user = await db.users.findById(userId);
    const app = await db.apps.findById(appId);
    
    const containerPath = user.containerPath;
    const workspacePath = user.workspacePath;
    const sessionName = app.tmuxSession;
    
    // Kill tmux session inside container
    const command = `
        systemd-nspawn -D ${containerPath} \\
            --bind=${workspacePath}:/workspace \\
            /bin/bash -c "tmux kill-session -t ${sessionName}"
    `;
    
    await execAsync(command).catch(() => {
        // Session might already be dead, that's ok
    });
    
    await db.apps.update(appId, {
        status: 'stopped',
        port: null,
        tmuxSession: null
    });
}
```

#### 3.3 Agent Start Changes

**Current code:**
```typescript
// Start agent
function startAgent(userId: string, agentPort: number) {
    const sessionName = `agent-${agentPort}`;
    
    exec(`tmux new-session -d -s ${sessionName} \
        "/root/code/wingmen/out/agentapi server --port ${agentPort}"`);
}
```

**New code:**
```typescript
async function startAgent(userId: string, agentPort: number) {
    const user = await db.users.findById(userId);
    const sessionName = `agent-${agentPort}`;
    
    const containerPath = user.containerPath;
    const workspacePath = user.workspacePath;
    
    // Copy agentapi binary into container (or have it in template)
    const agentBinaryPath = "/root/code/wingmen/out/agentapi";
    const containerBinaryPath = `${containerPath}/usr/local/bin/agentapi`;
    
    await execAsync(`cp ${agentBinaryPath} ${containerBinaryPath}`);
    await execAsync(`chmod +x ${containerBinaryPath}`);
    
    // Start agent inside container
    const command = `
        systemd-nspawn -D ${containerPath} \\
            --bind=${workspacePath}:/workspace \\
            --setenv=HOME=/workspace \\
            /bin/bash -c "cd /workspace && tmux new-session -d -s ${sessionName} 'agentapi server --port ${agentPort} --allowed-hosts localhost,127.0.0.1,[::1],${user.alias}.${agentPort}.host.otherstuff.ai'"
    `;
    
    await execAsync(command);
    
    return {
        port: agentPort,
        session: sessionName
    };
}
```

#### 3.4 URL Generation Changes

**Update everywhere URLs are displayed:**

```typescript
// Old URL format
function getAppUrl(port: number): string {
    return `https://host.otherstuff.ai/${port}`;
}

// New URL format
function getAppUrl(userAlias: string, port: number): string {
    return `https://${userAlias}.${port}.host.otherstuff.ai`;
}
```

**UI changes needed:**
- Update "Open App" buttons to show new URL format
- Update any documentation/tooltips
- Add "Copy URL" button for convenience

---

### Phase 4: Testing & Validation

#### 4.1 Unit Testing

**Test container creation:**
```bash
# Create test user container
source /root/scripts/container-utils.sh
create_user_container "test-user"

# Verify container exists
ls /var/lib/machines/test-user

# Verify workspace exists
ls /home/test-user/workspace

# Test execution inside container
container_exec "test-user" "bun --version"
container_exec "test-user" "node --version"
container_exec "test-user" "git --version"

# Cleanup
delete_user_container "test-user"
```

#### 4.2 Integration Testing

**Test app deployment flow:**

1. Create test user via Wingman UI
2. Verify container was created: `ls /var/lib/machines/`
3. Clone a test app (e.g., simple Express server)
4. Mark as "Web App" and assign port
5. Start the app
6. Verify URL works: `https://test-user.41001.host.otherstuff.ai`
7. Check logs inside container:
   ```bash
   container_exec "test-user" "tmux ls"
   container_exec "test-user" "tmux capture-pane -p -t app-session"
   ```

**Test isolation:**
```bash
# Inside container, try to access orchestrator files
container_exec "test-user" "ls /root/code/wingmen"
# Should fail - path doesn't exist in container

# Try to access other user's workspace
container_exec "test-user" "ls /home/other-user"
# Should fail - not mounted in container

# Try to access system files
container_exec "test-user" "cat /etc/shadow"
# Should fail - permission denied
```

#### 4.3 Performance Testing

**Measure container creation time:**
```bash
time create_user_container "perf-test"
# Target: < 30 seconds
```

**Measure container overhead:**
```bash
# Start 10 containers with apps running
# Monitor:
free -h              # Memory usage
df -h                # Disk usage
top                  # CPU usage
```

---

### Phase 5: Migration & Deployment

#### 5.1 Pre-Migration Checklist

- [ ] DNS wildcard record added and verified
- [ ] Wildcard SSL certificate obtained and tested
- [ ] New nginx config created and tested
- [ ] Container template created and validated
- [ ] Container utility scripts tested
- [ ] Orchestrator code changes completed
- [ ] Testing completed on staging/development environment

#### 5.2 Migration Strategy

**Option A: Big Bang (Recommended for small user base)**

1. Schedule maintenance window
2. Notify users of downtime
3. Deploy all changes at once:
   - Update nginx config
   - Create containers for existing users
   - Deploy orchestrator changes
4. Test with existing users
5. Resume service

**Option B: Gradual Migration (For larger deployments)**

1. Deploy networking changes (DNS, SSL, nginx) first
2. Keep both old and new nginx configs running
3. New users get containers automatically
4. Migrate existing users gradually:
   - Create container for user
   - Move their workspace files
   - Update database to use new URL format
5. Once all migrated, remove old nginx config

#### 5.3 Deployment Steps

```bash
# 1. Backup current configuration
cp -r /etc/nginx/sites-enabled /etc/nginx/sites-enabled.backup
pg_dump wingman > /root/backups/wingman-$(date +%Y%m%d).sql

# 2. Create container template
/root/scripts/create-template.sh

# 3. For each existing user, create container
for alias in $(get_all_user_aliases_from_db); do
    create_user_container "$alias"
    # Copy existing workspace if it exists
    if [ -d "/old/workspace/path/$alias" ]; then
        cp -r "/old/workspace/path/$alias/"* "/home/$alias/workspace/"
    fi
done

# 4. Update nginx
ln -s /etc/nginx/sites-available/host.otherstuff.ai-wildcard /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 5. Deploy new orchestrator code
cd /root/code/wingmen
git pull
bun install
bun run build

# 6. Restart orchestrator
systemctl restart wingman  # or your service name
# OR: tmux kill-session -t wingman && tmux new-session -d -s wingman "bun start"

# 7. Smoke test
curl -I https://test-user.41001.host.otherstuff.ai

# 8. Remove old nginx config (after validation)
rm /etc/nginx/sites-enabled/host.otherstuff.ai
systemctl reload nginx
```

#### 5.4 Rollback Plan

If issues arise:

```bash
# 1. Revert nginx
rm /etc/nginx/sites-enabled/host.otherstuff.ai-wildcard
ln -s /etc/nginx/sites-available/host.otherstuff.ai /etc/nginx/sites-enabled/
systemctl reload nginx

# 2. Revert orchestrator code
cd /root/code/wingmen
git checkout <previous-commit>
bun install
bun run build
systemctl restart wingman

# 3. Containers can stay (they're harmless if not used)
```

---

### Phase 6: Monitoring & Maintenance

#### 6.1 Monitoring

**Add monitoring for:**

1. **Container count:** Alert if > expected
   ```bash
   count=$(ls -1 /var/lib/machines/ | grep -v _template | wc -l)
   ```

2. **Disk usage:** Alert if containers directory > 80% full
   ```bash
   df -h /var/lib/machines
   ```

3. **Container health:** Check for zombie containers
   ```bash
   for container in /var/lib/machines/*/; do
       name=$(basename $container)
       # Check if any processes running
       systemd-nspawn -D $container ps aux
   done
   ```

4. **SSL certificate expiry:**
   ```bash
   certbot certificates | grep "Expiry Date"
   ```

#### 6.2 Maintenance Tasks

**Weekly:**
- Review disk usage: `du -sh /var/lib/machines/*`
- Check for orphaned containers (users deleted but container remains)
- Review nginx logs for errors: `tail -f /var/log/nginx/error.log`

**Monthly:**
- Update container template:
  ```bash
  systemd-nspawn -D /var/lib/machines/_template /bin/bash -c "apt-get update && apt-get upgrade -y"
  systemd-nspawn -D /var/lib/machines/_template /bin/bash -c "curl -fsSL https://bun.sh/install | bash"
  ```
- Optionally recreate user containers from updated template (requires coordination with users)

**Every 90 days:**
- Renew wildcard SSL certificate (currently requires manual DNS validation)
- Document this process or automate with DNS API

#### 6.3 Cleanup Script

**File:** `/root/scripts/cleanup-containers.sh`

```bash
#!/bin/bash

# Clean up containers for deleted users
for container in /var/lib/machines/*/; do
    name=$(basename $container)
    if [ "$name" == "_template" ]; then
        continue
    fi
    
    # Check if user exists in database
    exists=$(psql -U postgres wingman -tAc "SELECT COUNT(*) FROM users WHERE alias='$name'")
    
    if [ "$exists" -eq 0 ]; then
        echo "Found orphaned container: $name"
        read -p "Delete? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            delete_user_container "$name"
        fi
    fi
done
```

---

## Summary of Changes

### Infrastructure Changes
1. **DNS:** Wildcard A record `*.host.otherstuff.ai` → server IP
2. **SSL:** Wildcard certificate covering `*.host.otherstuff.ai`
3. **Nginx:** Subdomain-based reverse proxy with regex routing
4. **Containers:** systemd-nspawn containers per user (template + clone approach)

### Code Changes
1. **User registration:** Create container on user signup
2. **App start/stop:** Execute inside containers via `systemd-nspawn`
3. **Agent start:** Spawn agents inside user containers
4. **URL generation:** Change format to `alias.port.host.otherstuff.ai`
5. **UI updates:** Display new URL format

### Operational Changes
1. **User isolation:** Each user has isolated filesystem namespace
2. **Resource management:** Can set limits per container
3. **Template management:** Maintain golden image, update periodically
4. **SSL renewal:** Manual process every 90 days (document it)

### Benefits Delivered
- ✅ Clean URLs without path prefix issues
- ✅ Apps work without path-aware code
- ✅ Agents isolated from system and orchestrator
- ✅ Users isolated from each other
- ✅ Easy to manage per-user resources
- ✅ Fast provisioning (~30 seconds per user)

---

## Implementation Timeline

**Week 1:** Phase 1 (Networking)
- Day 1-2: DNS and SSL setup
- Day 3-4: Nginx configuration and testing
- Day 5: Validation and rollback testing

**Week 2:** Phase 2 (Containers)
- Day 1-2: Create template and scripts
- Day 3-4: Test container creation/deletion
- Day 5: Performance testing

**Week 3:** Phase 3 (Orchestrator)
- Day 1-3: Code changes to orchestrator
- Day 4-5: Integration testing

**Week 4:** Phase 4-6 (Testing, Migration, Monitoring)
- Day 1-2: End-to-end testing
- Day 3: Migration execution
- Day 4-5: Monitoring and bug fixes

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| SSL renewal forgotten | High | Medium | Set calendar reminder, document process |
| Container disk space exhaustion | High | Medium | Monitor disk usage, set alerts |
| Container escape vulnerability | High | Low | Keep kernel updated, follow security advisories |
| Migration breaks existing apps | High | Low | Test thoroughly, have rollback plan |
| DNS propagation delays | Low | Medium | Test with `@1.1.1.1` before going live |
| Networking complexity | Medium | Low | Use host networking (simpler) |

---

**For troubleshooting:**
- Check nginx logs: `/var/log/nginx/error.log`
- Check container logs: `journalctl -u systemd-nspawn@<container-name>`
- Test DNS: `dig <subdomain>`
- Test SSL: `curl -vI https://<subdomain>`