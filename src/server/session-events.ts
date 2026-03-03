/**
 * SSE proxy for session events from AgentAPI.
 * Proxies /api/sessions/:id/events to the agent's /events endpoint.
 */

import type { ProcessManager } from "../agents/process-manager";

export interface SessionEventsOptions {
  manager: ProcessManager;
  agentHost: string;
  /** Interval in ms for sending SSE keepalive comments (default: 30000) */
  sseKeepaliveIntervalMs?: number;
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30000;
const UPSTREAM_RETRY_BASE_DELAY_MS = 1000;
const UPSTREAM_RETRY_MAX_DELAY_MS = 10000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSessionEventsHandler(options: SessionEventsOptions) {
  const { manager, agentHost, sseKeepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS } = options;

  return async function handleSessionEvents(
    sessionId: string,
    request: Request
  ): Promise<Response> {
    const session = manager.getSession(sessionId);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "running") {
      return Response.json({ error: "Session not running" }, { status: 400 });
    }

    const adapter = manager.getAdapter(sessionId);
    const agentEventsUrl = adapter?.getEventsUrl();
    if (!agentEventsUrl) {
      return Response.json({ error: "No event stream available for this session" }, { status: 400 });
    }

    // Abort controller for cleanup
    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener("abort", () => {
      abortController.abort();
    });

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const writeSseComment = (comment: string) => {
      if (!streamController) return;
      streamController.enqueue(encoder.encode(`: ${comment}\n\n`));
    };

    const writeSseEvent = (event: string, payload: Record<string, unknown>) => {
      if (!streamController) return;
      streamController.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
      );
    };

    const readUpstreamStream = async (reader: any) => {
      try {
        while (streamController && !abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          if (value && streamController) {
            streamController.enqueue(value);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    };

    const pumpUpstreamWithReconnect = async () => {
      let attempt = 0;
      while (streamController && !abortController.signal.aborted) {
        const currentSession = manager.getSession(sessionId);
        if (!currentSession || currentSession.status !== "running") {
          writeSseEvent("status", { type: "session_stopped", sessionId });
          break;
        }

        try {
          const agentResponse = await fetch(agentEventsUrl.toString(), {
            signal: abortController.signal,
            headers: { Accept: "text/event-stream" },
          });

          if (!agentResponse.ok || !agentResponse.body) {
            const statusCode = agentResponse.status;
            attempt += 1;
            const delayMs = Math.min(
              UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
              UPSTREAM_RETRY_MAX_DELAY_MS,
            );
            console.warn(
              `[session-events] Upstream unavailable for ${sessionId} (status ${statusCode}), retry in ${delayMs}ms`,
            );
            writeSseEvent("status", {
              type: "upstream_unavailable",
              sessionId,
              status: statusCode,
              retryInMs: delayMs,
            });
            await sleep(delayMs);
            continue;
          }

          // Reset attempts once upstream is reachable.
          attempt = 0;
          writeSseComment("upstream-connected");
          await readUpstreamStream(agentResponse.body.getReader());
          writeSseComment("upstream-disconnected");
        } catch (error: any) {
          if (error?.name === "AbortError") {
            break;
          }
          attempt += 1;
          const delayMs = Math.min(
            UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            UPSTREAM_RETRY_MAX_DELAY_MS,
          );
          console.error(`[session-events] Upstream stream error for ${sessionId}:`, error?.message || error);
          writeSseEvent("status", {
            type: "upstream_error",
            sessionId,
            message: error?.message || String(error),
            retryInMs: delayMs,
          });
          await sleep(delayMs);
        }
      }
    };

    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller;
          writeSseComment("connected");
          keepaliveTimer = setInterval(() => {
            try {
              // Use a real SSE event (not a comment) so browser JS can observe
              // heartbeat traffic and avoid false "stale" health checks.
              writeSseEvent("heartbeat", { ts: Date.now() });
            } catch {
              if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
              }
            }
          }, sseKeepaliveIntervalMs);
          pumpUpstreamWithReconnect().finally(() => {
            if (streamController) {
              try {
                streamController.close();
              } catch {}
              streamController = null;
            }
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          });
        },
        cancel() {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          streamController = null;
          abortController.abort();
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  };
}
