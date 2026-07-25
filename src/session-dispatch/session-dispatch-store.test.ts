import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDispatchStore } from "./session-dispatch-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("SessionDispatchStore", () => {
  test("persists optional reporting context and terminal state across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-store-")); roots.push(root);
    const path = join(root, "dispatches.db");
    const store = new SessionDispatchStore(path);
    const created = store.create({ workerSessionId: "worker", callbackSessionId: "supervisor", ownerNpub: "npub1owner",
      state: "running", prompt: "Do it", promptQueuedAt: "2026-01-01T00:00:00.000Z",
      reportingContext: { taskId: "optional" }, terminalStatus: null, terminalMessage: null,
      terminalMessageCreatedAt: null, terminalFingerprint: null, callbackPrompt: null,
      callbackAttemptCount: 0, callbackQueuedAt: null, callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    store.update(created.dispatchId, { state: "callback_delivered", terminalStatus: "completed", terminalMessage: "Done" });
    const reopened = new SessionDispatchStore(path).get(created.dispatchId);
    expect(reopened?.reportingContext).toEqual({ taskId: "optional" });
    expect(reopened?.terminalMessage).toBe("Done");
  });
});
