import { describe, expect, test } from "bun:test";

import { injectMcpConfig } from "./mcp-injector";
import type { WingmanConfig } from "../config";

describe("injectMcpConfig codex structured config", () => {
  test("emits a structured codexConfig mirroring the wingman MCP CLI overrides", async () => {
    const result = await injectMcpConfig({
      sessionId: "session-xyz",
      agent: "codex",
      workingDirectory: "/tmp/project",
      config: { port: 3600 } as WingmanConfig,
      botNpub: "npub1bot",
    });

    const mcp = result.codexConfig?.mcp_servers as Record<string, any> | undefined;
    const wingman = mcp?.wingman;

    expect(wingman?.command).toBe("bun");
    expect(Array.isArray(wingman?.args)).toBe(true);
    expect(wingman?.args[0]).toBe("run");
    expect(wingman?.env?.SESSION_ID).toBe("session-xyz");
    expect(wingman?.env?.WINGMAN_URL).toBe("http://localhost:3600");

    // The structured config must carry the same MCP server path the CLI args use.
    const argsPath = (() => {
      const idx = (result.commandArgs ?? []).findIndex((a) => a.startsWith("mcp_servers.wingman.args="));
      if (idx === -1) return null;
      const raw = result.commandArgs![idx].split("=").slice(1).join("=");
      return JSON.parse(raw)[1];
    })();
    expect(wingman?.args[1]).toBe(argsPath);
  });
});
