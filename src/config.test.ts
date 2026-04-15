import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadConfig, resolveAgentLaunchConfig } from "./config";

const ENV_KEYS = [
  "AGENT_MODE",
  "AGENT_SPAWN_MODE",
  "AGENTAPI_BIN",
  "DEFAULT_AGENT",
  "GLOVES",
  "PI_CLI",
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

  test("keeps AGENT_MODE=tmux only as a deprecated binary-selection bridge", () => {
    const result = resolveAgentLaunchConfig({ AGENT_MODE: "tmux" });

    expect(result.agentApiBinarySource).toBe("legacy_agent_mode_tmux");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi-tmux"))).toBe(true);
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("default");
    expect(result.warnings).toContain(
      "AGENT_MODE=tmux is deprecated; set AGENTAPI_BIN to the tmux agentapi binary path instead.",
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

  test("prefers AGENTAPI_BIN over the deprecated AGENT_MODE=tmux binary alias", () => {
    const result = resolveAgentLaunchConfig({
      AGENT_MODE: "tmux",
      AGENTAPI_BIN: " /tmp/custom-agentapi ",
    });

    expect(result.agentApiBinary).toBe("/tmp/custom-agentapi");
    expect(result.agentApiBinarySource).toBe("agentapi_bin");
    expect(result.warnings).toContain(
      "AGENT_MODE=tmux is deprecated and ignored because AGENTAPI_BIN is set; configure the binary path with AGENTAPI_BIN only.",
    );
  });
});

describe("loadConfig", () => {
  test("builds agent commands from the resolved AGENTAPI_BIN path", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
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

  test("accepts pi as a configured default agent and launcher target", () => {
    applyEnv({
      DEFAULT_AGENT: "pi",
      PI_CLI: "/opt/bin/pi",
      AGENTAPI_BIN: "/tmp/custom-agentapi",
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
});
