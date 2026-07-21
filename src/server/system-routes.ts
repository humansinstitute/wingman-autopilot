/**
 * API route handlers for system endpoints (restart, cleanup).
 * Extracted from server.ts to reduce file size.
 */

import { stat } from "node:fs/promises";
import type { ProcessManager } from "../agents/process-manager";
import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import {
  clearWarmRestartMarker,
  type WarmRestartMarker,
  warmRestartOutcome,
  warmRestartState,
  writeWarmRestartMarker,
} from "./bootstrap/warm-restart";
import {
  NativeResumeLaunchError,
  resolveNativeResumeLaunch,
} from "../sessions/native-resume-launch";
import type { AgentType } from "../config";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Context supplied by server.ts ----------

export interface SystemRoutesContext {
  restartMarkerPath: string;
  warmRestartManagerScriptPath: string;
  projectRoot: string;
  configPort: number;
  wingmanCoreTmuxSession: string;
  manager: ProcessManager;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { SystemManage: AccessAction };
  isAgentType: (agent: string) => agent is AgentType;
  isTrustedRestartAgent: (authContext: RequestAuthContext) => boolean;
  launchRestart?: (marker: WarmRestartMarker) => Promise<Response>;
  setPreserveSessionsOnShutdown: (value: boolean) => void;
  initiateShutdown: (reason: string) => void;
  performSystemCleanup: (deps: {
    manager: ProcessManager;
    messageStore: unknown;
    appProcessManager: unknown;
    appRegistry: unknown;
    requestedBy?: string | null;
  }) => Promise<unknown>;
  messageStore: unknown;
  appProcessManager: unknown;
  appRegistry: unknown;
}

async function launchRestartManager(ctx: SystemRoutesContext, marker: WarmRestartMarker): Promise<Response> {
  warmRestartState.inProgress = true;
  warmRestartState.marker = marker;
  warmRestartOutcome.current = null;
  ctx.setPreserveSessionsOnShutdown(true);

  try {
    await stat(ctx.warmRestartManagerScriptPath);
    Bun.spawn([
      Bun.env.WINGMAN_MANAGER_COMMAND?.trim() || "bun",
      "run",
      ctx.warmRestartManagerScriptPath,
      process.pid.toString(),
      ctx.projectRoot,
      String(ctx.configPort),
      ctx.restartMarkerPath,
      ctx.wingmanCoreTmuxSession,
      "wingman-core",
    ], {
      cwd: ctx.projectRoot,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warmRestartState.inProgress = false;
    ctx.setPreserveSessionsOnShutdown(false);
    return Response.json({ error: `Failed to launch restart: ${message}` }, { status: 500 });
  }

  setTimeout(() => {
    void ctx.initiateShutdown("warm-restart");
  }, 250).unref?.();
  return Response.json({
    status: "scheduled",
    mode: marker.mode ?? "preserve",
    sessions: marker.sessionIds ?? [],
  }, { status: 202 });
}

// ---------- Main handler ----------

export async function handleSystemRoutes(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: SystemRoutesContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // GET /api/system/restart/status
  if (pathname === "/api/system/restart/status" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied && !ctx.isTrustedRestartAgent(authContext)) return denied;
    return Response.json({
      inProgress: warmRestartState.inProgress,
      marker: warmRestartState.marker,
      outcome: warmRestartOutcome.current,
    });
  }

  // POST /api/system/restart
  if (pathname === "/api/system/restart" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (warmRestartState.inProgress) {
      return Response.json({ error: "Restart already in progress" }, { status: 409 });
    }

    const activeSessions = ctx.manager
      .listSessions()
      .filter((session) => session.status === "starting" || session.status === "running");

    const marker: WarmRestartMarker = {
      createdAt: new Date().toISOString(),
      sessionIds: activeSessions.map((session) => session.id),
      reason: "ui-restart",
      version: 2,
      mode: "preserve",
    };

    try {
      await writeWarmRestartMarker(ctx.restartMarkerPath, marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to write restart marker: ${message}` }, { status: 500 });
    }

    return ctx.launchRestart ? ctx.launchRestart(marker) : launchRestartManager(ctx, marker);
  }

  // POST /api/system/restart-and-resume
  if (pathname === "/api/system/restart-and-resume" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied && !ctx.isTrustedRestartAgent(authContext)) return denied;
    if (warmRestartState.inProgress) {
      return Response.json({ error: "Restart already in progress" }, { status: 409 });
    }

    const activeSessions = ctx.manager
      .listSessions()
      .filter((session) => session.status === "starting" || session.status === "running");
    const requestedBy = authContext.actorNpub ?? authContext.npub ?? null;
    const blockers: Array<{ sessionId: string; name: string; error: string }> = [];
    for (const session of activeSessions) {
      try {
        resolveNativeResumeLaunch(session, ctx.isAgentType, requestedBy);
      } catch (error) {
        blockers.push({
          sessionId: session.id,
          name: session.name,
          error: error instanceof NativeResumeLaunchError ? error.message : String(error),
        });
      }
    }
    if (blockers.length > 0) {
      return Response.json({
        error: "All active sessions must have native resume metadata before restart",
        blockers,
      }, { status: 409 });
    }
    if (!ctx.launchRestart) {
      try {
        await stat(ctx.warmRestartManagerScriptPath);
      } catch (error) {
        return Response.json({
          error: `Restart script missing: ${error instanceof Error ? error.message : String(error)}`,
        }, { status: 500 });
      }
    }

    const marker: WarmRestartMarker = {
      createdAt: new Date().toISOString(),
      sessionIds: activeSessions.map((session) => session.id),
      reason: "stop-restart-native-resume",
      version: 2,
      mode: "native-resume",
      requestedBy,
      status: "stopping-sessions",
    };
    try {
      await writeWarmRestartMarker(ctx.restartMarkerPath, marker);
    } catch (error) {
      return Response.json({
        error: `Failed to record sessions for restart: ${error instanceof Error ? error.message : String(error)}`,
      }, { status: 500 });
    }

    const stopped = [];
    try {
      for (const session of activeSessions) {
        await ctx.manager.stopSession(session.id);
        stopped.push(session);
      }
    } catch (error) {
      const rollbackFailed: string[] = [];
      for (const source of stopped) {
        try {
          const launch = resolveNativeResumeLaunch(source, ctx.isAgentType, requestedBy);
          await ctx.manager.createSession(
            launch.agent,
            launch.workingDirectory,
            launch.name,
            launch.origin,
            undefined,
            launch.ownerNpub,
            launch.metadata,
          );
        } catch {
          rollbackFailed.push(source.id);
        }
      }
      await clearWarmRestartMarker(ctx.restartMarkerPath);
      return Response.json({
        error: `Failed to stop every session: ${error instanceof Error ? error.message : String(error)}`,
        rollbackFailed,
      }, { status: 500 });
    }

    marker.status = "sessions-stopped";
    try {
      await writeWarmRestartMarker(ctx.restartMarkerPath, marker);
    } catch (error) {
      console.warn(
        `[restart] sessions stopped but marker status update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return ctx.launchRestart ? ctx.launchRestart(marker) : launchRestartManager(ctx, marker);
  }

  // POST /api/system/cleanup
  if (pathname === "/api/system/cleanup" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    try {
      const result = await ctx.performSystemCleanup({
        manager: ctx.manager,
        messageStore: ctx.messageStore,
        appProcessManager: ctx.appProcessManager,
        appRegistry: ctx.appRegistry,
        requestedBy: authContext.actorNpub ?? authContext.npub ?? null,
      });
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[system] cleanup failure: ${message}`);
      return Response.json({ error: `System cleanup failed: ${message}` }, { status: 500 });
    }
  }

  return null;
}
