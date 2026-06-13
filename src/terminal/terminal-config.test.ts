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
  });

  test("accepts a custom 5 digit TMAN_PIN", () => {
    const config = resolveTerminalConfig({
      env: { TMAN_PIN: "12345", TMAN_CWD: "workspace" },
      defaultCwd: "/tmp/autopilot",
    });
    expect(config.pin).toBe("12345");
    expect(config.cwd).toBe("/tmp/autopilot/workspace");
  });

  test("rejects non-5-digit TMAN_PIN values", () => {
    expect(() => resolveTerminalConfig({
      env: { TMAN_PIN: "1234" },
      defaultCwd: "/tmp/autopilot",
    })).toThrow("TMAN_PIN must be exactly 5 digits");
  });
});
