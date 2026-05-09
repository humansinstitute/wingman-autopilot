import { afterEach, describe, expect, test } from "bun:test";

import { validateNonInteractiveSetupConfig } from "./wizard";

const ENV_KEYS = [
  "ADMIN_NPUB",
  "WINGMAN_ADMIN_NPUB",
  "DIRECTORY_DEF",
  "WINGMAN_DIRECTORY_DEF",
  "IDENTITY_SESSION_SECRET",
  "WINGMAN_IDENTITY_SESSION_SECRET",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, Bun.env[key]]),
);

function clearSetupEnv(): void {
  for (const key of ENV_KEYS) {
    delete Bun.env[key];
    delete process.env[key];
  }
}

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

afterEach(() => {
  restoreEnv();
});

describe("noninteractive setup validation", () => {
  test("requires admin npub before completing Docker setup", () => {
    clearSetupEnv();
    const missing = validateNonInteractiveSetupConfig(new Map([
      ["DIRECTORY_DEF", "/workspace"],
      ["IDENTITY_SESSION_SECRET", "secret"],
    ]));

    expect(missing).toEqual(["ADMIN_NPUB"]);
  });

  test("accepts generated Docker env aliases for the happy path", () => {
    clearSetupEnv();
    const missing = validateNonInteractiveSetupConfig(new Map([
      ["WINGMAN_DIRECTORY_DEF", "/workspace"],
      ["WINGMAN_IDENTITY_SESSION_SECRET", "secret"],
      ["WINGMAN_ADMIN_NPUB", "npub1operator"],
    ]));

    expect(missing).toEqual([]);
  });
});
