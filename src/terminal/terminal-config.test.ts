import { describe, expect, test } from "bun:test";
import { resolveTerminalConfig } from "./terminal-config";

describe("terminal config", () => {
  test("defaults TMAN_PIN to 44444", () => {
    const config = resolveTerminalConfig({
      env: { SHELL: "/bin/zsh" },
      defaultCwd: "/tmp/autopilot",
    });
    expect(config.pin).toBe("44444");
    expect(config.shell).toBe("/bin/zsh");
    expect(config.cwd).toBe("/tmp/autopilot");
    expect(config.ptyMode).toBe("bridge");
  });

  test("accepts a custom 5 digit TMAN_PIN", () => {
    const config = resolveTerminalConfig({
      env: { TMAN_PIN: "12345", TMAN_CWD: "workspace" },
      defaultCwd: "/tmp/autopilot",
    });
    expect(config.pin).toBe("12345");
    expect(config.cwd).toBe("/tmp/autopilot/workspace");
  });

  test("allows direct PTY mode for diagnostics", () => {
    const config = resolveTerminalConfig({
      env: { TMAN_PTY_MODE: "direct" },
      defaultCwd: "/tmp/autopilot",
    });

    expect(config.ptyMode).toBe("direct");
  });

  test("rejects non-5-digit TMAN_PIN values", () => {
    expect(() => resolveTerminalConfig({
      env: { TMAN_PIN: "1234" },
      defaultCwd: "/tmp/autopilot",
    })).toThrow("TMAN_PIN must be exactly 5 digits");
  });

  test("rejects invalid PTY mode values", () => {
    expect(() => resolveTerminalConfig({
      env: { TMAN_PTY_MODE: "docker" },
      defaultCwd: "/tmp/autopilot",
    })).toThrow('TMAN_PTY_MODE must be "bridge" or "direct"');
  });
});
