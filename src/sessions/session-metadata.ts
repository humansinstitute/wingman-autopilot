export interface SessionMetadata {
  AGENT: boolean;
  billingMode: "subscription" | "credits";
  role?: string;
  project?: string;
  taskIds?: string[];
  routerRunId?: string;
  autoStop?: boolean;
  routedBy?: string;
  agentChatAgentId?: string;
  agentChatBotNpub?: string;
  ownerNpub?: string;
  createdByNpub?: string;
  lastManagedByNpub?: string;
  chargeToNpub?: string;
  delegateRelationshipId?: string;
}

export type SessionMetadataInput = Partial<SessionMetadata> | null | undefined;

export const DEFAULT_SESSION_METADATA: SessionMetadata = Object.freeze({
  AGENT: false,
  billingMode: "subscription",
});

export const normaliseSessionMetadata = (
  metadata: SessionMetadataInput,
): SessionMetadata => {
  const role = typeof metadata?.role === "string" ? metadata.role.trim() : "";
  const project = typeof metadata?.project === "string" ? metadata.project.trim() : "";
  const routerRunId = typeof metadata?.routerRunId === "string" ? metadata.routerRunId.trim() : "";
  const routedBy = typeof metadata?.routedBy === "string" ? metadata.routedBy.trim() : "";
  const agentChatAgentId = typeof metadata?.agentChatAgentId === "string" ? metadata.agentChatAgentId.trim() : "";
  const agentChatBotNpub = typeof metadata?.agentChatBotNpub === "string" ? metadata.agentChatBotNpub.trim() : "";
  const ownerNpub = typeof metadata?.ownerNpub === "string" ? metadata.ownerNpub.trim() : "";
  const createdByNpub = typeof metadata?.createdByNpub === "string" ? metadata.createdByNpub.trim() : "";
  const lastManagedByNpub = typeof metadata?.lastManagedByNpub === "string" ? metadata.lastManagedByNpub.trim() : "";
  const chargeToNpub = typeof metadata?.chargeToNpub === "string" ? metadata.chargeToNpub.trim() : "";
  const delegateRelationshipId =
    typeof metadata?.delegateRelationshipId === "string" ? metadata.delegateRelationshipId.trim() : "";
  const taskIds = Array.isArray(metadata?.taskIds)
    ? metadata.taskIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    : undefined;

  return {
    AGENT: Boolean(metadata?.AGENT),
    billingMode: metadata?.billingMode === "credits" ? "credits" : "subscription",
    role: role || undefined,
    project: project || undefined,
    taskIds: taskIds?.length ? taskIds : undefined,
    routerRunId: routerRunId || undefined,
    autoStop: Boolean(metadata?.autoStop),
    routedBy: routedBy || undefined,
    agentChatAgentId: agentChatAgentId || undefined,
    agentChatBotNpub: agentChatBotNpub || undefined,
    ownerNpub: ownerNpub || undefined,
    createdByNpub: createdByNpub || undefined,
    lastManagedByNpub: lastManagedByNpub || undefined,
    chargeToNpub: chargeToNpub || undefined,
    delegateRelationshipId: delegateRelationshipId || undefined,
  };
};

export const isAgentManagedSession = (
  metadata: SessionMetadata | null | undefined,
): boolean => Boolean(metadata?.AGENT);

export const isCreditsBillingSession = (
  metadata: SessionMetadata | null | undefined,
): boolean => metadata?.billingMode === "credits";

export const resolveSessionChargeNpub = (
  metadata: SessionMetadata | null | undefined,
  fallbackNpub: string | null | undefined,
): string | null => {
  const candidate = typeof metadata?.chargeToNpub === "string" ? metadata.chargeToNpub.trim() : "";
  if (candidate) {
    return candidate;
  }
  return typeof fallbackNpub === "string" && fallbackNpub.trim().length > 0 ? fallbackNpub.trim() : null;
};

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
