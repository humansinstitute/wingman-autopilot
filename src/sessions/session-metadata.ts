export interface SessionMetadata {
  AGENT: boolean;
  billingMode: "subscription" | "credits";
}

export type SessionMetadataInput = Partial<SessionMetadata> | null | undefined;

export const DEFAULT_SESSION_METADATA: SessionMetadata = Object.freeze({
  AGENT: false,
  billingMode: "subscription",
});

export const normaliseSessionMetadata = (
  metadata: SessionMetadataInput,
): SessionMetadata => ({
  AGENT: Boolean(metadata?.AGENT),
  billingMode: metadata?.billingMode === "credits" ? "credits" : "subscription",
});

export const isAgentManagedSession = (
  metadata: SessionMetadata | null | undefined,
): boolean => Boolean(metadata?.AGENT);

export const isCreditsBillingSession = (
  metadata: SessionMetadata | null | undefined,
): boolean => metadata?.billingMode === "credits";

const LEGACY_AGENT_ORIGIN_TYPES = new Set([
  "scheduler",
  "nostr",
  "mg-task",
  "file-watcher",
  "agent-session",
]);

type OriginLike = {
  type?: unknown;
} | null | undefined;

export const isLegacyAgentOrigin = (origin: OriginLike): boolean => {
  const type = typeof origin?.type === "string" ? origin.type.trim().toLowerCase() : "";
  if (!type) {
    return false;
  }
  return LEGACY_AGENT_ORIGIN_TYPES.has(type);
};

export const isAgentManagedByMetadataOrOrigin = (
  metadata: SessionMetadata | null | undefined,
  origin: OriginLike,
): boolean => isAgentManagedSession(metadata) || isLegacyAgentOrigin(origin);
