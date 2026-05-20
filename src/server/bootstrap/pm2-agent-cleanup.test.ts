import { describe, expect, test } from "bun:test";

import { isWingmanAgentPm2Process } from "./pm2-agent-cleanup";
import { PM2_NAMESPACE_AGENTS } from "../../agents/ecosystem-generator";
import type { PM2ProcessDescription } from "../../agents/pm2-wrapper";

const makeProc = (pm2Env: Record<string, unknown>): PM2ProcessDescription => ({
  name: "test-process",
  pm2_env: pm2Env,
} as PM2ProcessDescription);

describe("isWingmanAgentPm2Process", () => {
  test("recognizes processes in the agent namespace", () => {
    expect(isWingmanAgentPm2Process(makeProc({ namespace: PM2_NAMESPACE_AGENTS }))).toBe(true);
  });

  test("does not trust inherited agent markers on default-namespace processes", () => {
    expect(isWingmanAgentPm2Process(makeProc({
      namespace: "default",
      env: { WINGMAN_PROCESS_KIND: "agent-session" },
    }))).toBe(false);
  });

  test("recognizes legacy default-namespace agent wrappers", () => {
    expect(isWingmanAgentPm2Process(makeProc({
      namespace: "default",
      args: [
        "-lc",
        "unset KEYTELEPORT_PRIVKEY; exec '/repo/out/agentapi' 'server' '--port' '3700' < /dev/null",
      ],
      env: {
        WINGMAN_PROCESS_KIND: "agent-session",
        SESSION_ID: "session-1",
        SESSION_PORT: "3700",
        SESSION_AGENT: "codex",
        SESSION_DIRECTORY: "/tmp/project",
      },
    }))).toBe(true);
  });

  test("does not classify the core autopilot process with inherited agent env", () => {
    expect(isWingmanAgentPm2Process(makeProc({
      namespace: "default",
      pm_exec_path: "/Users/mini/.bun/bin/bun",
      args: ["run", "src/index.ts"],
      env: {
        WINGMAN_PROCESS_KIND: "agent-session",
        SESSION_ID: "session-1",
        SESSION_PORT: "3700",
        SESSION_AGENT: "codex",
        SESSION_DIRECTORY: "/tmp/project",
      },
    }))).toBe(false);
  });

  test("does not classify inherited session env on the core process", () => {
    expect(isWingmanAgentPm2Process(makeProc({
      namespace: "default",
      pm_exec_path: "/Users/mini/.bun/bin/bun",
      args: ["start"],
      env: {
        SESSION_ID: "session-1",
        SESSION_PORT: "3700",
        SESSION_AGENT: "codex",
        SESSION_DIRECTORY: "/tmp/project",
      },
    }))).toBe(false);
  });

  test("does not classify user apps with inherited session env", () => {
    expect(isWingmanAgentPm2Process(makeProc({
      namespace: "default",
      args: ["-c", "npm run dev"],
      env: {
        APP_ID: "app-1",
        SESSION_ID: "session-1",
        SESSION_PORT: "3700",
        SESSION_AGENT: "codex",
        SESSION_DIRECTORY: "/tmp/project",
      },
    }))).toBe(false);
  });
});
