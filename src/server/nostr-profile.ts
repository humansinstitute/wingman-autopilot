import { SimplePool, nip19 } from "nostr-tools";

import { normaliseNpub } from "../identity/npub-utils";
import { identityUserStore } from "../storage/identity-user-store";

const DEFAULT_PROFILE_RELAYS = [
  "wss://relay.nsec.app",
  "wss://nos.lol",
  "wss://relay.getalby.com/v1",
  "wss://nostr.mineracks.com",
];

const NOSTR_PROFILE_TIMEOUT_MS = 4500;
const nostrProfilePool = new SimplePool();

const decodeNpubToHex = (npub: string): string => {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === "npub") {
      if (typeof decoded.data === "string") return decoded.data;
      if (decoded.data && typeof decoded.data === "object" && "pubkey" in decoded.data) {
        return (decoded.data as { pubkey: string }).pubkey;
      }
    }
  } catch {
    // ignore
  }
  throw new Error("Invalid npub");
};

const sanitisePictureUrl = (value: string | null | undefined): string | null => {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
};

const fetchNostrProfileMetadata = async (
  npub: string,
  relays: string[],
): Promise<{ pictureUrl: string | null; name: string | null } | null> => {
  const pubkey = decodeNpubToHex(npub);
  const timeout = new Promise<null>((_, reject) =>
    setTimeout(() => reject(new Error("nostr profile lookup timed out")), NOSTR_PROFILE_TIMEOUT_MS),
  );
  try {
    const event = (await Promise.race([
      nostrProfilePool.get(relays, { kinds: [0], authors: [pubkey] }),
      timeout,
    ])) as { content?: string } | null;
    if (!event?.content) {
      return null;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(event.content);
    } catch {
      return null;
    }
    if (!metadata || typeof metadata !== "object") {
      return null;
    }
    const record = metadata as Record<string, unknown>;
    const picture = sanitisePictureUrl(
      typeof record.picture === "string" ? record.picture : (record.image as string | undefined),
    );
    const displayName =
      typeof record.display_name === "string"
        ? record.display_name
        : typeof record.name === "string"
          ? record.name
          : null;
    return { pictureUrl: picture, name: displayName };
  } catch (error) {
    console.warn("[nostr] profile lookup failed:", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    try {
      nostrProfilePool.close(relays);
    } catch {
      // ignore close errors
    }
  }
};

export const resolveAndCacheNostrProfile = async (
  npub: string,
  options: { force?: boolean; relays?: string[] } = {},
): Promise<{ pictureUrl: string | null; name: string | null; source: "cache" | "fetched" }> => {
  const normalized = normaliseNpub(npub);
  if (!normalized) {
    throw new Error("A valid npub is required");
  }
  const relays =
    Array.isArray(options.relays) && options.relays.length > 0 ? options.relays : DEFAULT_PROFILE_RELAYS;
  const existing = identityUserStore.getByNormalized(normalized);
  if (existing?.pictureUrl && !options.force) {
    return { pictureUrl: existing.pictureUrl, name: existing.alias ?? null, source: "cache" };
  }

  const metadata = await fetchNostrProfileMetadata(npub, relays);
  if (!metadata) {
    if (!existing) {
      identityUserStore.touch(npub);
    }
    return { pictureUrl: existing?.pictureUrl ?? null, name: existing?.alias ?? null, source: "cache" };
  }

  const { pictureUrl, name } = metadata;
  const updated = pictureUrl ? identityUserStore.setPictureUrl(npub, pictureUrl) : existing ?? null;
  if (!existing) {
    identityUserStore.touch(npub);
  }

  return {
    pictureUrl: pictureUrl ?? updated?.pictureUrl ?? null,
    name: name ?? updated?.alias ?? null,
    source: "fetched",
  };
};
