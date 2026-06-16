import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadConfig, resolveAgentLaunchConfig } from "./config";

const ENV_KEYS = [
  "AGENT_MODE",
  "AGENT_CLI_AUTOUPDATE",
  "AGENT_SPAWN_MODE",
  "AGENT_STATUS_POLL_TIMEOUT_MS",
  "AGENT_TMUX_SESSION",
  "AGENTAPI_BIN",
  "APP_ROUTING",
  "CODEX_CLI",
  "DEFAULT_AGENT",
  "GLOVES",
  "PI_CLI",
  "SUBDOMAIN_BASE_DOMAIN",
  "SUBDOMAIN_PROXY_ENABLED",
  "WINGMAN_APP_ROUTING",
  "WINGMAN_SUBDOMAIN_BASE_DOMAIN",
  "WINGMAN_SUBDOMAIN_PROXY_ENABLED",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, Bun.env[key]]),
);

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete Bun.env[key];
      delete process.env[key];
    } else {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
}

function applyEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  restoreEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete Bun.env[key];
      delete process.env[key];
    } else {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

describe("resolveAgentLaunchConfig", () => {
  test("defaults to the standard agentapi binary and bun spawn mode", () => {
    const result = resolveAgentLaunchConfig({});

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("default");
    expect(result.warnings).toEqual([]);
  });

  test("keeps AGENT_MODE=pm2 as a deprecated spawn-mode compatibility bridge", () => {
    const result = resolveAgentLaunchConfig({ AGENT_MODE: "pm2" });

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("pm2");
    expect(result.agentSpawnModeSource).toBe("legacy_agent_mode_pm2");
    expect(result.warnings).toContain("AGENT_MODE=pm2 is deprecated; use AGENT_SPAWN_MODE=pm2.");
  });

  test("keeps AGENT_MODE=tmux as a deprecated spawn-mode compatibility bridge", () => {
    const result = resolveAgentLaunchConfig({ AGENT_MODE: "tmux" });

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("tmux");
    expect(result.agentSpawnModeSource).toBe("legacy_agent_mode_tmux");
    expect(result.warnings).toContain(
      "AGENT_MODE=tmux is deprecated; use AGENT_SPAWN_MODE=tmux.",
    );
  });

  test("prefers AGENT_SPAWN_MODE over the deprecated AGENT_MODE=pm2 alias", () => {
    const result = resolveAgentLaunchConfig({
      AGENT_MODE: "pm2",
      AGENT_SPAWN_MODE: "bun",
    });

    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("agent_spawn_mode");
    expect(result.warnings).toContain(
      "AGENT_MODE=pm2 is deprecated and ignored because AGENT_SPAWN_MODE=bun.",
    );
  });

  test("accepts AGENT_SPAWN_MODE=tmux with the standard agentapi binary", () => {
    const result = resolveAgentLaunchConfig({ AGENT_SPAWN_MODE: "tmux" });

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("tmux");
    expect(result.agentSpawnModeSource).toBe("agent_spawn_mode");
    expect(result.warnings).toEqual([]);
  });

  test("keeps AGENTAPI_BIN independent from the deprecated AGENT_MODE=tmux alias", () => {
    const result = resolveAgentLaunchConfig({
      AGENT_MODE: "tmux",
      AGENTAPI_BIN: " /tmp/custom-agentapi ",
    });

    expect(result.agentApiBinary).toBe("/tmp/custom-agentapi");
    expect(result.agentApiBinarySource).toBe("agentapi_bin");
    expect(result.agentSpawnMode).toBe("tmux");
    expect(result.warnings).toContain(
      "AGENT_MODE=tmux is deprecated; use AGENT_SPAWN_MODE=tmux.",
    );
  });
});

describe("loadConfig", () => {
  test("builds agent commands from the resolved AGENTAPI_BIN path", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();
    const command = config.agents.codex.command({
      agent: "codex",
      config,
      port: 3701,
    });

    expect(command[0]).toBe("/tmp/custom-agentapi");
    expect(config.agentSpawnMode).toBe("bun");
  });

  test("loads tmux spawn mode and session name", () => {
    applyEnv({
      AGENT_SPAWN_MODE: "tmux",
      AGENT_TMUX_SESSION: "custom-agents",
      AGENT_MODE: undefined,
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agentSpawnMode).toBe("tmux");
    expect(config.agentTmuxSession).toBe("custom-agents");
  });

  test("defaults to codex when DEFAULT_AGENT is not set", () => {
    applyEnv({
      DEFAULT_AGENT: undefined,
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.defaultAgent).toBe("codex");
  });

  test("passes explicit agentapi type flags for command-backed agents", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();
    const claudeCommand = config.agents.claude.command({ agent: "claude", config, port: 3701 });
    const gooseCommand = config.agents.goose.command({ agent: "goose", config, port: 3702 });
    const geminiCommand = config.agents.gemini.command({ agent: "gemini", config, port: 3703 });

    expect(claudeCommand).toContain("--type=claude");
    expect(gooseCommand).toContain("--type=goose");
    expect(geminiCommand).toContain("--type=gemini");
  });

  test("exposes Claude model aliases for session launch overrides", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.claude.modelOptions).toEqual([
      "default",
      "opus",
      "sonnet",
      "sonnet[1m]",
      "haiku",
    ]);
  });

  test("uses GLOVES=OFF as the single approval bypass for Codex and Claude", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_CLI_AUTOUPDATE: "true",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: "OFF",
    });

    const config = loadConfig();
    const codexCommand = config.agents.codex.command({ agent: "codex", config, port: 3701 });
    const claudeCommand = config.agents.claude.command({ agent: "claude", config, port: 3702 });

    expect(codexCommand).toEqual([
      "/tmp/custom-agentapi",
      "server",
      "--port",
      "3701",
      "--allowed-origins",
      "*",
      "--allowed-hosts",
      "localhost,127.0.0.1,[::1]",
      "--type=codex",
      "--",
      "codex",
      "--yolo",
    ]);
    expect(claudeCommand.slice(-3)).toEqual(["--", "claude", "--dangerously-skip-permissions"]);
  });

  test("disables Codex and Claude background update checks by default", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_CLI_AUTOUPDATE: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.codex.env).toEqual({
      NO_UPDATE_NOTIFIER: "1",
      npm_config_update_notifier: "false",
    });
    expect(config.agents.claude.env).toEqual({
      DISABLE_AUTOUPDATER: "1",
    });

    const codexCommand = config.agents.codex.command({ agent: "codex", config, port: 3701 });
    expect(codexCommand.slice(-2)).toEqual([
      "-c",
      "check_for_update_on_startup=false",
    ]);
  });

  test("allows explicit Codex and Claude CLI auto-update opt-in", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_CLI_AUTOUPDATE: "true",
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.codex.env).toEqual({});
    expect(config.agents.claude.env).toEqual({});

    const codexCommand = config.agents.codex.command({ agent: "codex", config, port: 3701 });
    expect(codexCommand).not.toContain("check_for_update_on_startup=false");
  });

  test("accepts pi as a configured default agent and launcher target", () => {
    applyEnv({
      DEFAULT_AGENT: "pi",
      PI_CLI: "/opt/bin/pi",
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();
    const command = config.agents.pi.command({
      agent: "pi",
      config,
      port: 3701,
    });

    expect(config.defaultAgent).toBe("pi");
    expect(command[0]).toBe("/tmp/custom-agentapi");
    expect(command.slice(-2)).toEqual(["--", "/opt/bin/pi"]);
  });

  test("defaults status polling to a short local request timeout", () => {
    applyEnv({
      AGENT_STATUS_POLL_TIMEOUT_MS: undefined,
    });

    const config = loadConfig();

    expect(config.agentStatusPollTimeoutMs).toBe(1000);
  });

  test("allows status polling timeout override", () => {
    applyEnv({
      AGENT_STATUS_POLL_TIMEOUT_MS: "2500",
    });

    const config = loadConfig();

    expect(config.agentStatusPollTimeoutMs).toBe(2500);
  });

  test("uses Wingman-prefixed app routing settings over Docker defaults", () => {
    applyEnv({
      APP_ROUTING: "path",
      SUBDOMAIN_BASE_DOMAIN: undefined,
      SUBDOMAIN_PROXY_ENABLED: undefined,
      WINGMAN_APP_ROUTING: "subdomain",
      WINGMAN_SUBDOMAIN_BASE_DOMAIN: "rick.runwingman.com",
      WINGMAN_SUBDOMAIN_PROXY_ENABLED: "true",
    });

    const config = loadConfig();

    expect(config.appRoutingMode).toBe("subdomain");
    expect(config.subdomainBaseDomain).toBe("rick.runwingman.com");
    expect(config.subdomainProxyEnabled).toBe(true);
  });
});
