import { describe, expect, test } from "bun:test";

import { createWingmanMcpApiHandler, type WingmanMcpApiDependencies } from "./wingman-api";
import type { SessionSnapshot } from "../agents/process-manager";
import type { AgentType } from "../config";

function buildSession(input: Partial<SessionSnapshot> & { id: string }): SessionSnapshot {
  return {
    id: input.id,
    agent: (input.agent ?? "codex") as AgentType,
    port: input.port ?? 3700,
    name: input.name ?? input.id,
    status: input.status ?? "running",
    startedAt: input.startedAt ?? new Date().toISOString(),
    command: input.command ?? [],
    workingDirectory: input.workingDirectory ?? "/tmp",
    logs: input.logs ?? [],
    npub: input.npub,
    metadata: input.metadata ?? {},
  };
}

function makeDeps(sessions: Map<string, SessionSnapshot>): WingmanMcpApiDependencies {
  return {
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    listSessions: () => Array.from(sessions.values()),
    createSession: async (agent, _dir, name, explicitNpub) => {
      const created = buildSession({
        id: "worker-1",
        agent,
        name: name ?? "worker-1",
        npub: explicitNpub,
        metadata: { AGENT: true },
      });
      sessions.set(created.id, created);
      return created;
    },
    stopSession: async (sessionId) => {
      const existing = sessions.get(sessionId) ?? null;
      if (!existing) return null;
      sessions.delete(sessionId);
      return existing;
    },
    scheduleArchive: () => {},
    getSessionLogs: async () => [],
    listApps: async () => [],
    getAppStatus: async () => ({ running: false, pid: null, uptime: null }),
    runAppAction: async () => ({ running: false, pid: null, uptime: null }),
    tailAppLogs: async () => [],
    caproverStore: { listApps: () => [], getApp: () => null, createDeployment: () => ({ id: "d1" }) } as any,
    getCaproverClient: () => null,
    userSkillsRoot: "/tmp",
    defaultSkillsRoot: "/tmp",
    userSettingsStore: { get: () => null } as any,
    artifactsStore: {} as any,
    openRouterApiKey: null,
    findProjectByDirectory: () => null,
    memoryStore: {} as any,
    getWingmanNpub: () => null,
    setPinnedFile: () => undefined,
  };
}

describe("wingman-api session ownership", () => {
  test("create_session inherits caller npub so stop_session succeeds in same operator flow", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("caller-1", buildSession({ id: "caller-1", npub: "npub-user-1" }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const createResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", agent: "codex", name: "worker" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions"),
      "POST",
    );
    expect(createResponse?.status).toBe(200);
    const createdPayload = await createResponse!.json() as Record<string, unknown>;
    expect(createdPayload.id).toBe("worker-1");
    expect(sessions.get("worker-1")?.npub).toBe("npub-user-1");

    const stopResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", targetSessionId: "worker-1" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions/stop"),
      "POST",
    );
    expect(stopResponse?.status).toBe(200);
  });

  test("stop_session rejects cross-user targets", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("caller-1", buildSession({ id: "caller-1", npub: "npub-user-1" }));
    sessions.set("worker-2", buildSession({ id: "worker-2", npub: "npub-user-2" }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const stopResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", targetSessionId: "worker-2" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions/stop"),
      "POST",
    );

    expect(stopResponse?.status).toBe(403);
    const payload = await stopResponse!.json() as Record<string, unknown>;
    expect(payload.error).toBe("Cannot stop sessions belonging to another user");
  });
});
