import { describe, expect, test } from "bun:test";
import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import { handleTerminalApi, type TerminalRoutesContext } from "./terminal-routes";

const adminAuth: RequestAuthContext = {
  npub: "npub1admin",
  actorNpub: "npub1admin",
  signerNpub: "npub1admin",
  subjectNpub: "npub1admin",
  targetOwnerNpub: "npub1admin",
  delegatedOwnerNpub: null,
  delegateRelationshipId: null,
  delegateScopes: null,
  session: {
    npub: "npub1admin",
    nonce: "nonce",
    issuedAt: 0,
    expiresAt: 999999,
  },
  authMethod: "session",
};

function createContext(overrides: Partial<TerminalRoutesContext> = {}): TerminalRoutesContext {
  return {
    config: {
      pin: "44444",
      shell: "/bin/bash",
      cwd: "/tmp/autopilot",
      ptyMode: "bridge",
      ticketTtlMs: 30000,
    },
    tickets: new TerminalTicketStore({ ttlMs: 30000, now: () => 100 }),
    sessions: {
      checkAvailability: async () => ({ available: true, error: null }),
    } as TerminalRoutesContext["sessions"],
    ensureApiAccess: async () => null,
    AccessActions: { TerminalAccess: AccessActions.TerminalAccess },
    ...overrides,
  };
}

describe("terminal routes", () => {
  test("GET /api/terminal/status returns PTY availability", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/status"),
      new URL("http://localhost/api/terminal/status"),
      "GET",
      adminAuth,
      createContext(),
    );

    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      available: true,
      pinRequired: true,
      cwd: "/tmp/autopilot",
      shell: "/bin/bash",
    });
  });

  test("POST /api/terminal/auth rejects wrong PIN", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", {
        method: "POST",
        body: JSON.stringify({ pin: "12345" }),
      }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      createContext(),
    );

    expect(response?.status).toBe(403);
  });

  test("POST /api/terminal/auth returns a consumable ticket for the admin", async () => {
    const ctx = createContext();
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", {
        method: "POST",
        body: JSON.stringify({ pin: "44444" }),
      }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      ctx,
    );

    expect(response?.status).toBe(200);
    const payload = await response!.json() as { ticket: string };
    expect(typeof payload.ticket).toBe("string");
    expect(ctx.tickets.consume(payload.ticket, "npub1admin")).toBe(true);
  });

  test("returns access denial from access policy", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/status"),
      new URL("http://localhost/api/terminal/status"),
      "GET",
      adminAuth,
      createContext({
        ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      }),
    );

    expect(response?.status).toBe(403);
  });
});
