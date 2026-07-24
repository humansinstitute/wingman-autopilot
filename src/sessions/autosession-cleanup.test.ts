import { describe, expect, test } from "bun:test";
import {
  assessAutosessionCleanupCandidate,
  cleanupStaleAutosessions,
} from "./autosession-cleanup";

const nowMs = Date.parse("2026-07-24T10:30:00.000Z");
const atMinutesAgo = (minutes: number) => new Date(nowMs - minutes * 60 * 1000).toISOString();
const autosession = (id: string, lastUpdatedAt: string | null) => ({
  id,
  lastUpdatedAt,
  metadata: { tags: ["autosession"] },
});

describe("autosession cleanup eligibility", () => {
  test("stops stale autosessions", () => {
    expect(assessAutosessionCleanupCandidate(autosession("stale", atMinutesAgo(64)), {
      currentSessionId: "cleanup",
      nowMs,
    })).toEqual({ eligible: true, reason: "eligible" });
  });

  test("keeps fresh autosessions", () => {
    expect(assessAutosessionCleanupCandidate(autosession("fresh", atMinutesAgo(62)), {
      currentSessionId: "cleanup",
      nowMs,
    }).eligible).toBe(false);
  });

  test("keeps stale sessions without the autosession tag", () => {
    expect(assessAutosessionCleanupCandidate({
      id: "manual",
      lastUpdatedAt: atMinutesAgo(64),
      metadata: { tags: ["scheduler"] },
    }, { currentSessionId: "cleanup", nowMs })).toEqual({
      eligible: false,
      reason: "not-autosession",
    });
  });

  test("keeps autosessions at the exact 63 minute boundary", () => {
    expect(assessAutosessionCleanupCandidate(autosession("boundary", atMinutesAgo(63)), {
      currentSessionId: "cleanup",
      nowMs,
    })).toEqual({ eligible: false, reason: "not-stale" });
  });

  test("keeps autosessions with a missing timestamp", () => {
    expect(assessAutosessionCleanupCandidate(autosession("missing", null), {
      currentSessionId: "cleanup",
      nowMs,
    })).toEqual({ eligible: false, reason: "missing-last-updated-at" });
  });

  test("protects the executing cleanup session", async () => {
    const stopped: string[] = [];
    const result = await cleanupStaleAutosessions([
      autosession("cleanup", atMinutesAgo(120)),
      autosession("other", atMinutesAgo(64)),
    ], {
      currentSessionId: "cleanup",
      nowMs,
      stopSession: async (id) => { stopped.push(id); },
    });

    expect(stopped).toEqual(["other"]);
    expect(result.skipped).toContainEqual({ id: "cleanup", reason: "self" });
  });
});
