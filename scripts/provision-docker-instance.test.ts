import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "wingman-docker-provision-"));
  tempDirs.push(path);
  return path;
}

function runProvision(args: string[]) {
  return spawnSync("bun", ["run", "scripts/provision-docker-instance.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docker provisioning", () => {
  test("rejects missing admin npub", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision(["--env", envPath, "--instance-name", "wingman-99"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--admin-npub is required");
  });

  test("writes required admin npub into generated env", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--host-port",
      "3999",
      "--base-url",
      "https://wingman.example.test",
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("WINGMAN_ADMIN_NPUB=npub1operator");
    expect(content).toContain("WINGMAN_IDENTITY_COOKIE_SECURE=true");
    expect(content).toContain("WINGMAN_CODEX_CLI=/usr/local/bin/codex");
    expect(content).toContain("WINGMAN_CODEX_TRUSTED_WORKSPACE=/workspace");
    expect(content).toContain("WINGMAN_PI_CLI=/usr/local/bin/pi");
    expect(content).toContain("WINGMAN_SETUP_NONINTERACTIVE=true");
  });

  test("disables secure cookies for local http base URLs", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--host-port",
      "3999",
      "--base-url",
      "http://localhost:3999",
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("WINGMAN_IDENTITY_COOKIE_SECURE=false");
  });
});
