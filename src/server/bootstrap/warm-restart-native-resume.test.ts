import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resumeStoppedNativeSessions } from "./warm-restart";

describe("resumeStoppedNativeSessions", () => {
  test("creates replacement sessions from the durable restart marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-native-resume-"));
    const markerPath = join(root, "restart.json");
    await writeFile(markerPath, "{}\n", "utf8");
    const launches: unknown[][] = [];
    const manager = {
      createSession: async (...args: unknown[]) => {
        launches.push(args);
        return { id: "session-new" };
      },
    };
    const store = {
      listSessions: () => [{
        id: "session-old",
        agent: "codex",
        name: "Release work",
        npub: "npub1owner",
        workingDirectory: "/tmp/project",
        metadata: {
          ownerNpub: "npub1owner",
          nativeAgentSession: {
            agent: "codex",
            sessionId: "native-123",
            workingDirectory: "/tmp/project",
          },
        },
      }],
    };

    const outcome = await resumeStoppedNativeSessions({
      createdAt: new Date().toISOString(),
      mode: "native-resume",
      sessionIds: ["session-old"],
      requestedBy: "npub1wingman",
    }, markerPath, manager as never, store as never, ["codex"]);

    expect(outcome).toMatchObject({
      restored: 1,
      failed: [],
      mode: "native-resume",
      resumedSessions: [{ sourceSessionId: "session-old", sessionId: "session-new" }],
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.[0]).toBe("codex");
    expect(launches[0]?.[2]).toBe("Release work (resumed)");
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  test("records missing source sessions without preventing other resumes", async () => {
    const outcome = await resumeStoppedNativeSessions({
      createdAt: new Date().toISOString(),
      mode: "native-resume",
      sessionIds: ["missing"],
    }, join(tmpdir(), `missing-restart-${crypto.randomUUID()}.json`), {
      createSession: async () => ({ id: "unused" }),
    } as never, { listSessions: () => [] } as never, ["codex"]);

    expect(outcome).toMatchObject({ restored: 0, failed: ["missing"] });
  });
});
