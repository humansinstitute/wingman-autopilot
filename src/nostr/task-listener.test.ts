import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";

import { assertTaskListenerPubkeyHex } from "./task-listener";

describe("task listener", () => {
  test("accepts a derived hex public key", () => {
    expect(() => assertTaskListenerPubkeyHex(getPublicKey(generateSecretKey()))).not.toThrow();
  });

  test("rejects a missing public key", () => {
    expect(() => assertTaskListenerPubkeyHex(undefined as unknown as string)).toThrow("pubkeyHex");
  });
});
