import { describe, expect, test } from "bun:test";

import { resolveNip98AuthContext } from "./nip98-auth";
import type { RequestAuthContext } from "./request-context";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: null,
  actorNpub: null,
  session: null,
  ...overrides,
});

describe("resolveNip98AuthContext", () => {
  const request = new Request("http://localhost:3021/api/apps", {
    headers: { authorization: "Nostr test" },
  });
  const url = new URL(request.url);

  test("keeps cookie-backed auth unchanged", () => {
    const auth = makeAuth({ npub: "npub1cookie", actorNpub: "npub1cookie", session: { npub: "npub1cookie" } as any });
    const resolved = resolveNip98AuthContext(request, url, auth, {
      verifyNip98AuthHeader: () => "npub1ignored",
      lookupBotOwnerNpub: () => "npub1owner",
    });
    expect(resolved).toBe(auth);
  });

  test("uses signer npub directly for user-signed NIP-98", () => {
    const resolved = resolveNip98AuthContext(request, url, makeAuth(), {
      verifyNip98AuthHeader: () => "npub1user",
    });
    expect(resolved.npub).toBe("npub1user");
    expect(resolved.actorNpub).toBe("npub1user");
    expect(resolved.authMethod).toBe("nip98");
    expect(resolved.delegatedByBot).toBe(false);
  });

  test("preserves bot signer identity while surfacing legacy owner linkage", () => {
    const resolved = resolveNip98AuthContext(request, url, makeAuth(), {
      verifyNip98AuthHeader: () => "npub1bot",
      lookupBotOwnerNpub: (botNpub) => (botNpub === "npub1bot" ? "npub1owner" : null),
    });
    expect(resolved.npub).toBe("npub1bot");
    expect(resolved.actorNpub).toBe("npub1bot");
    expect(resolved.subjectNpub).toBe("npub1bot");
    expect(resolved.delegatedOwnerNpub).toBe("npub1owner");
    expect(resolved.authMethod).toBe("nip98");
    expect(resolved.delegatedByBot).toBe(true);
  });
});
