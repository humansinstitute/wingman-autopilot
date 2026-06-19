import { describe, expect, mock, test } from "bun:test";

mock.module("../agent-chat/yoke-bot-helpers", () => ({
  loadYokeBotHelpers: async () => ({
    signBotRequest: (params: { url: string; method: string; body: unknown }) => {
      return `Nostr signed:${params.method}:${params.url}:${JSON.stringify(params.body)}`;
    },
  }),
}));

const { registerTowerWappWithTower, TowerWappRegistrationError } = await import("./tower-registration");

describe("Tower WApp registration client", () => {
  test("posts workspace app registration with bot NIP-98 auth", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const result = await registerTowerWappWithTower({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
      appNpub: "npub1app",
      appName: "Ops Board",
      authority: {
        botNpub: "npub1bot",
        botPubkeyHex: "f".repeat(64),
        botSecret: new Uint8Array(32),
      },
    }, async (input, init) => {
      calls.push({ input, init });
      return Response.json({ app: { app_npub: "npub1app" } }, { status: 201 });
    });

    expect(result).toMatchObject({ workspaceOwnerNpub: "npub1workspace", appNpub: "npub1app" });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://tower.example/api/v4/workspaces/npub1workspace/apps");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toContain("Nostr signed:POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      app_npub: "npub1app",
      app_name: "Ops Board",
      enabled: true,
    });
  });

  test("surfaces Tower registration errors", async () => {
    await expect(registerTowerWappWithTower({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
      appNpub: "npub1app",
      appName: "Ops Board",
      authority: {
        botNpub: "npub1bot",
        botPubkeyHex: "f".repeat(64),
        botSecret: new Uint8Array(32),
      },
    }, async () => Response.json({ error: "Not authorized to manage this workspace" }, { status: 403 })))
      .rejects.toBeInstanceOf(TowerWappRegistrationError);
  });
});
