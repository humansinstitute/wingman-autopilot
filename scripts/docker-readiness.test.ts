import { describe, expect, test } from "bun:test";

import { buildConfigChecks } from "./docker-readiness";

function statusByName(checks: ReturnType<typeof buildConfigChecks>, name: string): string | undefined {
  return checks.find((check) => check.name === name)?.status;
}

const readyEnv = {
  WINGMAN_INSTANCE_NAME: "wingman-01",
  WINGMAN_BASE_URL: "https://wingman.example.test",
  DIRECTORY_DEF: "/workspace",
  FOLDERACCESS: "/workspace",
  IDENTITY_SESSION_SECRET: "secret",
  IDENTITY_COOKIE_SECURE: "true",
};

describe("docker readiness config checks", () => {
  test("fails missing admin npub in strict mode", () => {
    const checks = buildConfigChecks(readyEnv, true);

    expect(statusByName(checks, "ADMIN_NPUB")).toBe("fail");
  });

  test("passes required Docker config when admin npub is present", () => {
    const checks = buildConfigChecks({ ...readyEnv, ADMIN_NPUB: "npub1operator" }, true);

    expect(checks.every((check) => check.status === "pass")).toBe(true);
  });
});
