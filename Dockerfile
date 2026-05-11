FROM node:22-bookworm

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG INSTALL_AGENT_CLIS=true
ARG CODEX_PACKAGE=@openai/codex@latest
ARG CLAUDE_PACKAGE=@anthropic-ai/claude-code@latest
ARG OPENCODE_PACKAGE=opencode-ai@latest
ARG FLIGHTDECK_CLI_PACKAGE=@runwingman/flightdeck-cli@latest

ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:/usr/local/bin:/home/wingman/.local/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    bzip2 \
    ca-certificates \
    coreutils \
    curl \
    file \
    findutils \
    g++ \
    gcc \
    git \
    jq \
    less \
    make \
    openssh-client \
    pkg-config \
    procps \
    python3 \
    tar \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
  && ln -sf /usr/local/bun/bin/bunx /usr/local/bin/bunx

RUN if [[ "${INSTALL_AGENT_CLIS}" == "true" ]]; then \
    bun install -g "${CODEX_PACKAGE}"; \
    ln -sf /usr/local/bun/bin/codex /usr/local/bin/codex; \
    npm install -g "${CLAUDE_PACKAGE}" "${OPENCODE_PACKAGE}"; \
    curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \
      | GOOSE_BIN_DIR=/usr/local/bin CONFIGURE=false bash; \
  fi

ARG GEMINI_PACKAGE=@google/gemini-cli@latest
ARG PI_PACKAGE=@earendil-works/pi-coding-agent@latest

RUN if [[ "${INSTALL_AGENT_CLIS}" == "true" ]]; then \
    npm install -g "${GEMINI_PACKAGE}" "${PI_PACKAGE}"; \
  fi

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "${FLIGHTDECK_CLI_PACKAGE}" \
  && FLIGHTDECK_CLI_ROOT="$(npm root -g)/@runwingman/flightdeck-cli" \
  && test -f "${FLIGHTDECK_CLI_ROOT}/src/cli.js" \
  && ln -sfn "${FLIGHTDECK_CLI_ROOT}" /opt/flightdeck-cli

RUN useradd --create-home --home-dir /home/wingman --shell /bin/bash --uid 10001 wingman \
  && mkdir -p /app/data /app/tmp /app/out /workspace \
  && chown -R wingman:wingman \
    /app \
    /home/wingman \
    /usr/local/bin \
    /usr/local/bun \
    /usr/local/lib/node_modules \
    /workspace

WORKDIR /app

COPY --chown=wingman:wingman package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile \
  && chown -R wingman:wingman /app/node_modules /usr/local/bun

COPY --chown=wingman:wingman . .
RUN chmod +x scripts/docker-entrypoint.sh

USER wingman

ENV HOME=/home/wingman
ENV PORT=3600
ENV DIRECTORY_DEF=/workspace
ENV FOLDERACCESS=/workspace
ENV APP_ROUTING=path
ENV AGENT_SPAWN_MODE=bun
ENV AGENTAPI_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
ENV CODEX_CLI=/usr/local/bin/codex
ENV CODEX_YOLO=true
ENV CODEX_TRUSTED_WORKSPACE=/workspace
ENV CLAUDE_CLI=/usr/local/bin/claude
ENV GLOVES=OFF
ENV CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL=0
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV GOOSE_CLI=/usr/local/bin/goose
ENV OPENCODE_CLI=/usr/local/bin/opencode
ENV GEMINI_CLI=/usr/local/bin/gemini
ENV PI_CLI=/usr/local/bin/pi
ENV WINGMAN_SHARED_INSTANCE=true
ENV WINGMAN_SETUP_NONINTERACTIVE=true
ENV AGENT_CHAT_YOKE_HELPERS_PATH=/opt/flightdeck-cli/src/bot-helpers.js
ENV AGENT_CHAT_YOKE_TRANSLATORS_PATH=/opt/flightdeck-cli/src/translators.js
ENV AGENT_CHAT_YOKE_CLI_PATH=/opt/flightdeck-cli/src/cli.js
ENV AGENT_CHAT_YOKE_CLIENT_PATH=/opt/flightdeck-cli/src/client.js
ENV AGENT_CHAT_YOKE_WORKSPACE_KEYS_PATH=/opt/flightdeck-cli/src/workspace-keys.js
ENV AGENT_CHAT_YOKE_NOSTR_PATH=/opt/flightdeck-cli/src/nostr.js

RUN bun -e "import { ensureAgentApiBinary } from './src/server/bootstrap/agentapi.ts'; await ensureAgentApiBinary({ agentApiBinaryPath: '/app/out/agentapi', projectRootDirectory: '/app' });"

EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD bun run scripts/docker-readiness.ts --strict --json >/dev/null

CMD ["scripts/docker-entrypoint.sh", "bun", "start"]
