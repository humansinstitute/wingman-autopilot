import { getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { getBotDisplayName } from "./bot-identity-publisher";

export interface WingmanInstanceIdentity {
  nsec: string;
  nsecHex: string;
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
  displayName: string;
  source: "env";
}

type ConfigEnvironment = Record<string, string | undefined>;

let cachedIdentity: WingmanInstanceIdentity | null | undefined;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.substring(index, index + 2), 16);
  }
  return bytes;
}

function decodeWingmanPriv(input: string): Uint8Array {
  const value = input.trim();
  if (!value) {
    throw new Error("WINGMAN_PRIV is empty");
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return hexToBytes(value);
  }

  const decoded = nip19.decode(value);
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("WINGMAN_PRIV must be an nsec1 private key");
  }
  if (decoded.data.length !== 32) {
    throw new Error("WINGMAN_PRIV nsec must decode to 32 bytes");
  }
  return new Uint8Array(decoded.data);
}

export function loadWingmanInstanceIdentity(
  env: ConfigEnvironment = Bun.env,
): WingmanInstanceIdentity | null {
  if (env === Bun.env && cachedIdentity !== undefined) {
    return cachedIdentity;
  }

  const raw = env.WINGMAN_PRIV?.trim();
  if (!raw) {
    if (env === Bun.env) cachedIdentity = null;
    return null;
  }

  const secretKey = decodeWingmanPriv(raw);
  const pubkeyHex = getPublicKey(secretKey);
  const nsec = nip19.nsecEncode(secretKey);
  const identity: WingmanInstanceIdentity = {
    nsec,
    nsecHex: bytesToHex(secretKey),
    secretKey,
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    displayName: getBotDisplayName(pubkeyHex),
    source: "env",
  };

  if (env === Bun.env) cachedIdentity = identity;
  return identity;
}

