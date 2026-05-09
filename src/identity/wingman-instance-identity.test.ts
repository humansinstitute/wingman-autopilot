import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { loadWingmanInstanceIdentity } from "./wingman-instance-identity";

describe("Wingman instance identity", () => {
  test("loads WINGMAN_PRIV nsec and derives public identity", () => {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    const pubkeyHex = getPublicKey(secretKey);

    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: nsec });

    expect(identity?.nsec).toBe(nsec);
    expect(identity?.nsecHex).toBe(bytesToHex(secretKey));
    expect(identity?.pubkeyHex).toBe(pubkeyHex);
    expect(identity?.npub).toBe(nip19.npubEncode(pubkeyHex));
    expect(identity?.source).toBe("env");
  });

  test("returns null when WINGMAN_PRIV is absent", () => {
    expect(loadWingmanInstanceIdentity({})).toBeNull();
  });
});

