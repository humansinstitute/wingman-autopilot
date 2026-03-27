export interface SessionMetadata {
  AGENT: boolean;
  billingMode: "subscription" | "credits";
  role?: string;
  project?: string;
  taskIds?: string[];
  routerRunId?: string;
  autoStop?: boolean;
  routedBy?: string;
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
  };
};

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
