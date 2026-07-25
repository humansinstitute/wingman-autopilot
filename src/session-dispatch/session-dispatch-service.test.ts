import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptQueueStore } from "../storage/prompt-queue-store";
import { SessionDispatchService } from "./session-dispatch-service";
import { SessionDispatchStore } from "./session-dispatch-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function session(id: string, owner = "npub1owner") {
  return { id, npub: owner, metadata: { AGENT: true, billingMode: "subscription", ownerNpub: owner },
    status: "running", agent: "claude-code", port: 3700 } as any;
}

describe("SessionDispatchService", () => {
  test("captures one terminal response, queues a typed callback, and supports closeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-service-")); roots.push(root);
    const dispatchStore = new SessionDispatchStore(join(root, "dispatch.db"));
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const sessions = new Map([["supervisor", session("supervisor")]]);
    const adapter = { deliversPromptsDirectly: () => true, fetchStatus: async () => "stable",
      fetchMessages: async () => [{ role: "user", content: "Build it", createdAt: "2026-01-01T00:00:00Z" },
        { role: "assistant", content: "Built and tested", createdAt: "2026-01-01T00:01:00Z" }] };
    const manager = { getSession: (id: string) => sessions.get(id), getAdapter: (id: string) => id === "worker" ? adapter : null,
      createSession: async () => { const worker = session("worker"); sessions.set("worker", worker); return worker; } } as any;
    const service = new SessionDispatchService(dispatchStore, manager, queue, () => {});
    const created = await service.create({ agent: "claude-code", prompt: "Build it", callbackEnabled: true,
      callbackSessionId: "supervisor" });
    await service.checkRunning();
    await service.checkRunning();
    const queued = queue.getSessionQueue("supervisor");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.type).toBe("dispatch_callback");
    expect(queued[0]?.payload?.dispatchId).toBe(created.dispatchId);
    expect(service.get(created.dispatchId, "supervisor").state).toBe("callback_delivered");
    service.acknowledge(created.dispatchId, "supervisor");
    expect(service.close(created.dispatchId, "supervisor").state).toBe("closed");
  });

  test("rejects access from a different owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-owner-")); roots.push(root);
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const sessions = new Map([["supervisor", session("supervisor")], ["intruder", session("intruder", "npub1other")]]);
    const manager = { getSession: (id: string) => sessions.get(id), getAdapter: () => null,
      createSession: async () => { const worker = session("worker"); sessions.set("worker", worker); return worker; } } as any;
    const service = new SessionDispatchService(new SessionDispatchStore(join(root, "dispatch.db")), manager, queue, () => {});
    const created = await service.create({ agent: "claude-code", prompt: "Build it", callbackEnabled: true,
      callbackSessionId: "supervisor" });
    expect(() => service.get(created.dispatchId, "intruder")).toThrow("another owner");
  });
});
