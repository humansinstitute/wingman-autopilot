import { normaliseSessionTags } from "./session-metadata";

export const AUTOSESSION_STALE_MINUTES = 63;

export interface AutosessionCleanupCandidate {
  id?: string;
  lastUpdatedAt?: string | null;
  metadata?: {
    tags?: unknown;
  } | null;
}

export interface AutosessionCleanupDecision {
  eligible: boolean;
  reason: "eligible" | "self" | "not-autosession" | "missing-last-updated-at" | "not-stale";
}

export function assessAutosessionCleanupCandidate(
  session: AutosessionCleanupCandidate,
  options: { currentSessionId: string; nowMs: number },
): AutosessionCleanupDecision {
  const sessionId = typeof session.id === "string" ? session.id.trim() : "";
  if (sessionId && sessionId === options.currentSessionId) {
    return { eligible: false, reason: "self" };
  }

  const tags = normaliseSessionTags(session.metadata?.tags) ?? [];
  if (!tags.includes("autosession")) {
    return { eligible: false, reason: "not-autosession" };
  }

  if (typeof session.lastUpdatedAt !== "string" || !session.lastUpdatedAt.trim()) {
    return { eligible: false, reason: "missing-last-updated-at" };
  }
  const lastUpdatedAtMs = Date.parse(session.lastUpdatedAt);
  if (!Number.isFinite(lastUpdatedAtMs)) {
    return { eligible: false, reason: "missing-last-updated-at" };
  }

  const staleAfterMs = AUTOSESSION_STALE_MINUTES * 60 * 1000;
  if (options.nowMs - lastUpdatedAtMs <= staleAfterMs) {
    return { eligible: false, reason: "not-stale" };
  }

  return { eligible: true, reason: "eligible" };
}

export async function cleanupStaleAutosessions(
  sessions: AutosessionCleanupCandidate[],
  options: {
    currentSessionId: string;
    nowMs: number;
    stopSession: (sessionId: string) => Promise<void>;
  },
) {
  const stopped: string[] = [];
  const skipped: Array<{ id: string; reason: AutosessionCleanupDecision["reason"] }> = [];

  for (const session of sessions) {
    const id = typeof session.id === "string" ? session.id.trim() : "";
    if (!id) continue;
    const decision = assessAutosessionCleanupCandidate(session, options);
    if (!decision.eligible) {
      skipped.push({ id, reason: decision.reason });
      continue;
    }
    await options.stopSession(id);
    stopped.push(id);
  }

  return { stopped, skipped };
}
