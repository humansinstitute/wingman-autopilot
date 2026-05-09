import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { buildWingmanIdentityEnv, loadWingmanInstanceIdentity } from "./wingman-instance-identity";

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

  test("builds compatibility env without exposing WINGMAN_PRIV", () => {
    const secretKey = generateSecretKey();
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: nip19.nsecEncode(secretKey) });

    if (!identity) throw new Error("expected identity");
    const env = buildWingmanIdentityEnv(identity);

    expect(env.WINGMAN_NPUB).toBe(identity.npub);
    expect(env.BOT_NPUB).toBe(identity.npub);
    expect(env.BOT_PUBKEY_HEX).toBe(identity.pubkeyHex);
    expect(env.AGENT_NSEC).toBe(bytesToHex(secretKey));
    expect(env.WINGMAN_PRIV).toBeUndefined();
  });

  test("returns null when WINGMAN_PRIV is absent", () => {
    expect(loadWingmanInstanceIdentity({})).toBeNull();
  });

  test("throws when WINGMAN_PRIV is present but invalid", () => {
    expect(() => loadWingmanInstanceIdentity({ WINGMAN_PRIV: "not-an-nsec" })).toThrow(
      "WINGMAN_PRIV",
    );
  });
});
