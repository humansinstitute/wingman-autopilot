import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { resolveSecretKey } from "./auth";

describe("resolveSecretKey — CLI auth env resolution", () => {
  const originalEnv = { ...Bun.env };

  afterEach(() => {
    // Restore env
    delete Bun.env.WINGMAN_NSEC;
    delete Bun.env.WINGMAN_NIP98_NSEC;
    delete Bun.env.KEYTELEPORT_PRIVKEY;
  });

  test("resolves from explicit keyInput arg", () => {
    const hex = "a".repeat(64);
    const result = resolveSecretKey(hex);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  test("resolves from WINGMAN_NSEC env var", () => {
    const hex = "b".repeat(64);
    Bun.env.WINGMAN_NSEC = hex;
    const result = resolveSecretKey();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  test("does not fall back to WINGMAN_NIP98_NSEC", () => {
    Bun.env.WINGMAN_NIP98_NSEC = "c".repeat(64);
    expect(() => resolveSecretKey()).toThrow(/WINGMAN_NSEC/);
  });

  test("does not fall back to KEYTELEPORT_PRIVKEY", () => {
    Bun.env.KEYTELEPORT_PRIVKEY = "d".repeat(64);
    expect(() => resolveSecretKey()).toThrow(/WINGMAN_NSEC/);
  });

  test("throws with helpful message mentioning WINGMAN_NSEC when no key available", () => {
    expect(() => resolveSecretKey()).toThrow(/WINGMAN_NSEC/);
  });

  test("prefers explicit keyInput over WINGMAN_NSEC env", () => {
    const inputHex = "a".repeat(64);
    const envHex = "b".repeat(64);
    Bun.env.WINGMAN_NSEC = envHex;
    const result = resolveSecretKey(inputHex);
    // Verify the result matches the input, not the env
    const { hexToBytes } = require("@noble/hashes/utils");
    expect(result).toEqual(hexToBytes(inputHex));
  });
});
