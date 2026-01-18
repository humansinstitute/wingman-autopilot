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
    console.log(`[session-events] Proxying SSE for ${sessionId} to ${agentEventsUrl}`);

    // Abort controller for cleanup
    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener("abort", () => {
      console.log(`[session-events] Client disconnected from ${sessionId}`);
      abortController.abort();
    });

    try {
      // Connect to AgentAPI SSE
      const agentResponse = await fetch(agentEventsUrl.toString(), {
        signal: abortController.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!agentResponse.ok) {
        console.warn(`[session-events] Agent returned ${agentResponse.status} for ${sessionId}`);
        return Response.json(
          { error: "Failed to connect to agent", status: agentResponse.status },
          { status: 502 }
        );
      }

      if (!agentResponse.body) {
        console.warn(`[session-events] Agent returned no body for ${sessionId}`);
        return Response.json({ error: "No stream from agent" }, { status: 502 });
      }

      console.log(`[session-events] Connected to AgentAPI for ${sessionId}`);

      // Use a passthrough stream to forward data and log it
      const reader = agentResponse.body.getReader();

      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              console.log(`[session-events] Stream ended for ${sessionId}`);
              controller.close();
              return;
            }
            // Log the data being forwarded
            const text = new TextDecoder().decode(value);
            console.log(`[session-events] Forwarding ${value.byteLength} bytes for ${sessionId}: ${text.slice(0, 100)}...`);
            controller.enqueue(value);
          } catch (err) {
            console.error(`[session-events] Read error for ${sessionId}:`, err);
            controller.error(err);
          }
        },
        cancel() {
          console.log(`[session-events] Stream cancelled for ${sessionId}`);
          reader.cancel();
          abortController.abort();
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return new Response(null, { status: 499 }); // Client closed request
      }
      console.error(`[session-events] Failed to connect to agent for ${sessionId}:`, error);
      return Response.json(
        { error: "Failed to connect to agent", details: String(error) },
        { status: 502 }
      );
    }
  };
}
