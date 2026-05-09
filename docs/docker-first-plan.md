# Docker-First Wingman Plan

## Goal

Run Wingman as a self-contained agent computer:

- one Wingman instance
- one bot identity
- one workspace boundary
- one persistent home directory
- multiple approved human operators

If another isolated agent computer is needed, deploy another Wingman instance with a separate container, volume, bot key, workspace, and hostname.

## First Deployment Model

Start with a single Docker Compose stack per Wingman.

The default generated instance name should be `wingman-01`. If that name is already taken on the base machine, provisioning should continue with `wingman-02`, `wingman-03`, and so on.

The image should contain the tools that are common to every Wingman:

- Bun
- Node and npm
- git
- bash and core Linux tools
- build essentials
- agentapi
- Codex CLI
- Claude CLI
- Goose CLI
- OpenCode CLI

Gemini and Pi should use the same explicit CLI path model when enabled by an
operator, but they are optional for the first image until their install flow is
chosen.

Install the agent CLIs in their default upstream-supported way where possible. The goal is that a running Wingman can use the normal CLI update flow when those tools release updates, rather than requiring a custom package path for every upgrade.

The container should keep identity, CLI auth, caches, and Wingman state in persistent volumes:

- `/home/wingman`
- `/app/data`
- `/app/tmp`
- `/workspace`

The key assumption is explicit: after the container starts, an operator will open a shell inside it and log in to the required CLIs there. Those login files remain in the persistent `/home/wingman` volume.

## Example Shape

```yaml
services:
  wingman:
    build: .
    ports:
      - "3600:3600"
    environment:
      PORT: "3600"
      HOME: /home/wingman
      DIRECTORY_DEF: /workspace
      FOLDERACCESS: /workspace
      WINGMAN_BASE_URL: https://wingman.example.com
      APP_ROUTING: path
      AGENT_SPAWN_MODE: bun
    volumes:
      - wingman-home:/home/wingman
      - wingman-data:/app/data
      - wingman-tmp:/app/tmp
      - wingman-workspace:/workspace

volumes:
  wingman-home:
  wingman-data:
  wingman-tmp:
  wingman-workspace:
```

## CLI Login Workflow

Start the stack:

```bash
docker compose up -d
```

Open a shell in the running container:

```bash
docker compose exec wingman bash
```

Then log in or configure the CLIs from inside the container:

```bash
codex
claude
goose configure
opencode
```

The exact commands may change by CLI, but the important point is that the authentication files are written into `/home/wingman`, which is a persistent Docker volume.

## Shell Access

SSH is usually not needed for Docker containers.

Use Docker's built-in shell access instead:

```bash
docker compose exec wingman bash
```

or, without Compose:

```bash
docker exec -it <container-name> bash
```

If the image does not include bash:

```bash
docker compose exec wingman sh
```

Running an SSH server inside the container is possible, but it adds keys, ports, packages, and another network service to secure. For this project, `docker exec` should be the default. Other useful options are VS Code Dev Containers, `docker compose logs -f wingman`, and `docker cp` for one-off file movement.

## Cloudflare Tunnel

For a public URL, prefer a Cloudflare Tunnel on the base machine, routing hostnames to local container ports.

This keeps tunnel management outside the Wingman container and lets one base machine route multiple Wingman instances:

```text
alpha.example.com -> http://localhost:3600
beta.example.com  -> http://localhost:3601
```

For a Wingman exposed at `wmd.otherstuff.ai`, hosted app subdomains need both
public hostnames mapped to the same Wingman port:

```text
wmd.otherstuff.ai   -> http://localhost:3600
*.wmd.otherstuff.ai -> http://localhost:3600
```

Each Wingman should set `WINGMAN_BASE_URL` to its public tunnel hostname.

When Wingman hosts apps, external traffic should still enter through the base tunnel and land on the Wingman port. Wingman can then proxy to the hosted app using its own routing layer, either with path routing or subdomain routing.

Bundling `cloudflared` into the Wingman image is not the default plan. It may still be useful for a single-container appliance mode later, but the base-machine tunnel is simpler for the first Docker-first deployment.

Hosted app routing should use the existing Wingman subdomain/host routing model from the current Wingmen implementation.

The Docker env for wildcard app routing is:

```env
WINGMAN_APP_ROUTING=subdomain
WINGMAN_SUBDOMAIN_BASE_DOMAIN=wmd.otherstuff.ai
WINGMAN_SUBDOMAIN_PROXY_ENABLED=true
WINGMAN_BASE_URL=https://wmd.otherstuff.ai
```

The Settings UI should expose a workspace routing panel that shows the current
mode, current app domain, expected Cloudflare hostnames, and a copyable Docker
env snippet. Applying the env still requires editing the Docker `.env` and
restarting the container because routing config is read during server startup.

## Isolation Model

The Docker container is the trust boundary.

Inside one Wingman container, approved users are operators of the same bot. They should expect shared memory, shared workspace, shared pipelines, and shared tool credentials.

For stronger separation, create another Wingman container instead of trying to isolate private agents inside one container.

## First-Run Setup

Add a first-run setup workflow that walks an operator through container readiness. The preferred surface is the UI on first run, with scriptable checks underneath so the same logic can be used from the shell.

The checklist should report:

- whether the expected CLIs are installed
- whether each CLI appears authenticated
- whether `/home/wingman`, `/app/data`, `/app/tmp`, and `/workspace` are writable
- the configured `WINGMAN_BASE_URL`
- the configured workspace and folder access
- whether required Wingman secrets are present

The UI workflow should appear when the instance has not completed setup. It should guide the operator through:

- confirming the Wingman instance name
- confirming the public base URL
- confirming the workspace volume
- setting or confirming the operator whitelist
- checking installed CLIs
- explaining that subscription CLIs such as Claude and Codex require shell login inside the container
- marking setup complete only after required configuration is present

Provisioning should also include a small script that generates a Compose project name and `.env` file for each Wingman instance.

## Terminal Access

Shell access should remain operator-only for now through Docker:

```bash
docker compose exec wingman bash
```

A future browser terminal route is possible, but it is a separate security-sensitive feature. It would need:

- a PTY process inside the Wingman container
- WebSocket transport between browser and server
- strict admin-only authorization
- audit logging of terminal starts and stops
- clear separation from normal user chat surfaces
- guardrails around environment variables and secrets

Because a terminal is equivalent to direct access to the Wingman computer, it should not be part of the first Docker-first milestone.

## Decisions

- The default instance name is `wingman-01`, incrementing to `wingman-02`, `wingman-03`, and onward when names are already taken.
- Each Wingman instance should be created by a small provisioning script that generates the Compose project name and `.env` file.
- Cloudflare Tunnel runs on the base machine by default, mapping public URLs to Wingman container ports.
- Hosted app traffic should enter through the Wingman port and be proxied by Wingman's app routing.
- Hosted app routing should follow the existing subdomain/host routing model.
- The first Docker image installs the common agent CLIs by default.
- Agent CLIs should be installed in their normal/default manner so they can be updated in-place using their standard update paths.
- All agent command paths should be explicit in Docker env. Bundled CLIs use `/usr/local/bin/*`; optional CLIs such as Gemini and Pi should warn in readiness checks until installed.
- A first-run setup workflow should be UI-first, backed by reusable scriptable checks.
- CLI authentication for subscription tools such as Claude and Codex is handled by operator shell access inside the container for v1.
- Shell access remains operator-only through Docker commands for now.
