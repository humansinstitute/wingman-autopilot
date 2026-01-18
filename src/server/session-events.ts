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

    // Abort controller for cleanup
    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener("abort", () => {
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

      // Create a streaming response
      // IMPORTANT: start() must return immediately - async reading happens in background
      const reader = agentResponse.body.getReader();
      const encoder = new TextEncoder();

      // Store controller reference for background pump
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

      // Background pump function - reads from agent and pushes to client
      async function pumpData() {
        if (!streamController) return;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              try { streamController.close(); } catch {}
              break;
            }
            try {
              streamController.enqueue(value);
            } catch (err) {
              // Controller was closed (client disconnected)
              break;
            }
          }
        } catch (error) {
          console.error(`[session-events] Stream error for ${sessionId}:`, error);
          try { streamController?.close(); } catch {}
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller;
            // Send initial keepalive comment (SSE format)
            controller.enqueue(encoder.encode(": connected\n\n"));
            // Start background pump - DO NOT await, must return immediately
            pumpData();
          },
          cancel() {
            streamController = null;
            try { reader.cancel(); } catch {}
            abortController.abort();
          }
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no", // Disable proxy buffering
          },
        }
      );
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
