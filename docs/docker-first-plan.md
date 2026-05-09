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

Each Wingman should set `WINGMAN_BASE_URL` to its public tunnel hostname.

When Wingman hosts apps, external traffic should still enter through the base tunnel and land on the Wingman port. Wingman can then proxy to the hosted app using its own routing layer, either with path routing or subdomain routing.

Bundling `cloudflared` into the Wingman image is not the default plan. It may still be useful for a single-container appliance mode later, but the base-machine tunnel is simpler for the first Docker-first deployment.

## Isolation Model

The Docker container is the trust boundary.

Inside one Wingman container, approved users are operators of the same bot. They should expect shared memory, shared workspace, shared pipelines, and shared tool credentials.

For stronger separation, create another Wingman container instead of trying to isolate private agents inside one container.

## First-Run Setup

Add a first-run checklist or setup script that walks an operator through container readiness.

The checklist should report:

- whether the expected CLIs are installed
- whether each CLI appears authenticated
- whether `/home/wingman`, `/app/data`, `/app/tmp`, and `/workspace` are writable
- the configured `WINGMAN_BASE_URL`
- the configured workspace and folder access
- whether required Wingman secrets are present

This should be usable from the shell first, then optionally surfaced in the UI.

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

- Cloudflare Tunnel runs on the base machine by default, mapping public URLs to Wingman container ports.
- Hosted app traffic should enter through the Wingman port and be proxied by Wingman's app routing.
- The first Docker image installs the common agent CLIs by default.
- Agent CLIs should be installed in their normal/default manner so they can be updated in-place using their standard update paths.
- A first-run checklist or setup script is part of the deployment plan.
- Shell access remains operator-only through Docker commands for now.

## Open Questions

- What exact hostname and port convention should a multi-Wingman base machine use?
- Should each Wingman instance get a generated Compose project name and `.env` file from a small provisioning script?
- Should the first-run checklist live as `scripts/check-container-setup.ts`, a UI page, or both?
- Which CLI auth checks are reliable enough to automate without accidentally starting an interactive login flow?
- Should hosted app routing start with path routing only, then add subdomain routing once the tunnel/DNS pattern is proven?
