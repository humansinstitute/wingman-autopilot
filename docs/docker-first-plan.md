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
- optional cloudflared

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

For a public URL, prefer a Cloudflare Tunnel in one of two forms:

- host-level `cloudflared` routing hostnames to local container ports
- sidecar `cloudflared` container in the same Compose stack

Host-level routing is simpler when one machine runs many Wingmen:

```text
alpha.example.com -> http://localhost:3600
beta.example.com  -> http://localhost:3601
```

Each Wingman should set `WINGMAN_BASE_URL` to its public tunnel hostname.

## Isolation Model

The Docker container is the trust boundary.

Inside one Wingman container, approved users are operators of the same bot. They should expect shared memory, shared workspace, shared pipelines, and shared tool credentials.

For stronger separation, create another Wingman container instead of trying to isolate private agents inside one container.

## Open Questions

- Should `cloudflared` be bundled in the main image or provided as a sidecar?
- Should the first image install all agent CLIs by default, or use build arguments for selected CLIs?
- Should the app create a first-run checklist that shows which CLIs are installed and authenticated?
- Should Wingman expose a controlled terminal route, or should shell access remain an operator-only Docker command?
