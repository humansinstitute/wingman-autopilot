/**
 * SSE proxy for session events from AgentAPI.
 * Proxies /api/sessions/:id/events to the agent's /events endpoint.
 */

import { buildAgentUrl } from "../agents/agent-client";
import type { ProcessManager } from "../agents/process-manager";

export interface SessionEventsOptions {
  manager: ProcessManager;
  agentHost: string;
}

export function createSessionEventsHandler(options: SessionEventsOptions) {
  const { manager, agentHost } = options;

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

    const agentEventsUrl = buildAgentUrl(agentHost, session.port, "/events");

    // Create a TransformStream to proxy SSE
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Abort controller for cleanup
    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener("abort", () => {
      abortController.abort();
    });

    // Connect to AgentAPI SSE in the background
    (async () => {
      try {
        const response = await fetch(agentEventsUrl.toString(), {
          signal: abortController.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!response.ok || !response.body) {
          // Send error event and close
          await writer.write(
            encoder.encode(`event: error\ndata: {"error": "Failed to connect to agent"}\n\n`)
          );
          await writer.close();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          try {
            await writer.write(encoder.encode(decoder.decode(value, { stream: true })));
          } catch {
            // Writer closed (client disconnected)
            break;
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.warn(`[session-events] SSE proxy error for ${sessionId}:`, error);
          try {
            await writer.write(
              encoder.encode(`event: error\ndata: {"error": "Connection lost"}\n\n`)
            );
          } catch {
            // Ignore write errors on close
          }
        }
      } finally {
        try {
          await writer.close();
        } catch {
          // Already closed
        }
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
      },
    });
  };
}
