import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { warmRestartState } from "./bootstrap/warm-restart";
import { handleSystemRoutes, type SystemRoutesContext } from "./system-routes";
import type { RequestAuthContext } from "../auth/request-context";

const agentAuth: RequestAuthContext = {
  npub: "npub1wingman",
  actorNpub: "npub1wingman",
  session: null,
  delegatedByBot: false,
};

describe("handleSystemRoutes restart-and-resume", () => {
  beforeEach(() => {
    warmRestartState.inProgress = false;
    warmRestartState.marker = null;
  });

  test("allows the trusted Wingman agent but blocks shutdown when native metadata is missing", async () => {
    let stopCalls = 0;
    const ctx = {
      manager: {
        listSessions: () => [{
          id: "session-1",
          name: "Uncaptured session",
          agent: "codex",
          status: "running",
          npub: "npub1owner",
          workingDirectory: "/tmp/project",
          metadata: {},
        }],
        stopSession: async () => {
          stopCalls += 1;
        },
      },
      ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      AccessActions: { SystemManage: "system:manage" },
      isAgentType: (agent: string) => agent === "codex",
      isTrustedRestartAgent: () => true,
    } as unknown as SystemRoutesContext;
    const url = new URL("http://localhost/api/system/restart-and-resume");

    const response = await handleSystemRoutes(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      agentAuth,
      ctx,
    );
    const payload = await response!.json() as { blockers: Array<{ sessionId: string }> };

    expect(response!.status).toBe(409);
    expect(payload.blockers).toEqual([{ sessionId: "session-1", name: "Uncaptured session", error: "Session does not have a native agent session id to resume" }]);
    expect(stopCalls).toBe(0);
  });

  test("records and stops every eligible session before scheduling restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-restart-"));
    const stopped: string[] = [];
    let scheduledMarker: unknown = null;
    const session = {
      id: "session-1",
      name: "Release session",
      agent: "codex",
      status: "running",
      npub: "npub1owner",
      workingDirectory: "/tmp/project",
      metadata: {
        nativeAgentSession: {
          agent: "codex",
          sessionId: "native-123",
          workingDirectory: "/tmp/project",
        },
      },
    };
    const ctx = {
      restartMarkerPath: join(root, "restart.json"),
      manager: {
        listSessions: () => [session],
        stopSession: async (sessionId: string) => {
          stopped.push(sessionId);
          return { ...session, status: "stopped" };
        },
      },
      ensureApiAccess: async () => null,
      AccessActions: { SystemManage: "system:manage" },
      isAgentType: (agent: string) => agent === "codex",
      isTrustedRestartAgent: () => false,
      launchRestart: async (marker: unknown) => {
        scheduledMarker = marker;
        return Response.json({ status: "scheduled" }, { status: 202 });
      },
    } as unknown as SystemRoutesContext;
    const url = new URL("http://localhost/api/system/restart-and-resume");

    const response = await handleSystemRoutes(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      agentAuth,
      ctx,
    );
    const storedMarker = await Bun.file(ctx.restartMarkerPath).json();

    expect(response!.status).toBe(202);
    expect(stopped).toEqual(["session-1"]);
    expect(storedMarker).toMatchObject({
      mode: "native-resume",
      status: "sessions-stopped",
      sessionIds: ["session-1"],
    });
    expect(scheduledMarker).toMatchObject({ mode: "native-resume", sessionIds: ["session-1"] });
  });
});
