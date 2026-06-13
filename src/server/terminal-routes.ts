import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import type { TerminalConfig } from "../terminal/terminal-config";
import type { TerminalSessionManager } from "../terminal/terminal-session-manager";
import type { TerminalTicketStore } from "../terminal/terminal-ticket-store";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface TerminalRoutesContext {
  config: TerminalConfig;
  tickets: TerminalTicketStore;
  sessions: TerminalSessionManager;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { TerminalAccess: AccessAction };
}

export async function handleTerminalApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: TerminalRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/terminal/")) {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.TerminalAccess, request, url, authContext);
  if (denied) return denied;

  if (url.pathname === "/api/terminal/status" && method === "GET") {
    const availability = await ctx.sessions.checkAvailability();
    return Response.json({
      available: availability.available,
      error: availability.error,
      pinRequired: true,
      cwd: ctx.config.cwd,
      shell: ctx.config.shell,
    });
  }

  if (url.pathname === "/api/terminal/auth" && method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const pin = typeof payload === "object" && payload && "pin" in payload
      ? String((payload as { pin?: unknown }).pin ?? "")
      : "";
    if (pin !== ctx.config.pin) {
      return Response.json({ error: "Invalid PIN" }, { status: 403 });
    }

    const npub = getEffectiveOwnerNpub(authContext);
    if (!npub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const ticket = ctx.tickets.create(npub);
    return Response.json(ticket);
  }

  return null;
}
