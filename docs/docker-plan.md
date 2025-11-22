Docker packaging plan

- Base image: use the official Bun image (`oven/bun:<version>`) published by Oven, the company behind Bun. It keeps Bun preinstalled and slimmer than Node images.
- Multi-stage build:
  - Stage 1 (builder): `WORKDIR /app`; copy `package.json`, `bun.lock`, `tsconfig.json`; run `bun install --frozen-lockfile` to cache deps; copy `src`, `public`, and other needed assets; run `bun run build:bunker-client` to produce `public/vendor/bunker-client.js`.
  - Fetch agentapi during build: read `downloads.json` entry for Linux (Intel/ARM), `curl`/`wget` it into `out/agentapi`, verify SHA256, and `chmod +x` so runtime avoids first-boot download.
  - Stage 2 (runtime): start from clean `oven/bun:<version>`; `WORKDIR /app`; copy `node_modules` (or `bun install --production`), `public`, `src`, config files, and `out/agentapi` from builder.
- Runtime defaults:
  - `ENV NODE_ENV=production PORT=3600 AGENT_PORTS=3700 AGENT_MAX=10 DIRECTORY_DEF=/workspace FOLDERACCESS=/workspace AGENTAPI_ALLOWED_ORIGINS=* AGENTAPI_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]`.
  - `VOLUME /workspace /app/data` to persist working dirs and DBs; `EXPOSE 3600 3700-3710` (adjust range with `AGENT_MAX`).
  - `CMD ["bun","start"]`; optional `HEALTHCHECK` hitting `/health` when added.
- Agent CLI dependencies: container needs binaries for `codex`, `claude`, `goose`, `opencode`, `gemini` reachable via PATH or set `*_CLI` envs; if unavailable, document or bake them in a custom image.
- Security/ops:
  - Consider non-root user for runtime.
  - Lock `AGENTAPI_ALLOWED_ORIGINS/HOSTS` for production deployments instead of `*`.
  - Avoid writing under `out/agentapi` at runtime—prebuilt binary covers that.
  - Mount host project dirs into `/workspace` in compose/k8s to give agents file access; mount `/app/data` for DB durability.
