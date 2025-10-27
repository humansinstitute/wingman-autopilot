#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type WarmRestartMarker = {
  createdAt: string;
  preserveTmux: boolean;
  sessionIds?: string[];
  reason?: string;
  version?: number;
  status?: string;
  message?: string;
};

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error("Usage: bun run scripts/warm-restart-manager.ts <wingman-pid> <project-root> <server-port> <marker-path>");
  process.exit(1);
}

const [pidArg, projectRootInput, portArg, markerPathInput] = args;
const targetPid = Number.parseInt(pidArg, 10);
const serverPort = Number.parseInt(portArg, 10);
const projectRoot = resolve(projectRootInput);
const markerPath = resolve(markerPathInput);

if (!Number.isFinite(targetPid) || targetPid <= 0) {
  console.error(`[manager] Invalid Wingman PID: ${pidArg}`);
  process.exit(1);
}

if (!Number.isFinite(serverPort) || serverPort <= 0) {
  console.error(`[manager] Invalid Wingman port: ${portArg}`);
  process.exit(1);
}

const bunCommand = Bun.env.WINGMAN_RESTART_COMMAND?.trim() || "bun";
const bunArgs =
  Bun.env.WINGMAN_RESTART_ARGS?.trim()?.split(/\s+/).filter(Boolean) || ["run", "src/index.ts"];

const log = (message: string) => {
  console.log(`[manager] ${message}`);
};

const updateMarker = async (updates: Partial<WarmRestartMarker>) => {
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as WarmRestartMarker;
    const next: WarmRestartMarker = { ...parsed, ...updates };
    await writeFile(markerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`Failed to update restart marker: ${(error as Error).message}`);
  }
};

const isProcessAlive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

const waitForExit = async (pid: number, timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(250);
  }
  return !isProcessAlive(pid);
};

const waitForServer = async (port: number, timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/system/restart/status`, {
        method: "GET",
        headers: {
          "cache-control": "no-cache",
        },
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Ignore until timeout.
    }
    await delay(500);
  }
  return false;
};

const main = async () => {
  await updateMarker({ status: "stopping" });

  if (isProcessAlive(targetPid)) {
    try {
      process.kill(targetPid, "SIGTERM");
      log(`Sent SIGTERM to Wingman process ${targetPid}`);
    } catch (error) {
      log(`Unable to signal Wingman process ${targetPid}: ${(error as Error).message}`);
    }
  }

  const exited = await waitForExit(targetPid, 30_000);
  if (!exited) {
    await updateMarker({
      status: "failed",
      message: `Wingman process ${targetPid} did not exit within timeout`,
    });
    console.error(`[manager] Wingman process ${targetPid} did not exit within timeout`);
    process.exit(1);
  }

  await updateMarker({ status: "starting" });

  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(bunCommand, bunArgs, {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
      },
    });
  } catch (error) {
    await updateMarker({
      status: "failed",
      message: `Failed to spawn Wingman: ${(error as Error).message}`,
    });
    console.error(`[manager] Failed to spawn Wingman: ${(error as Error).message}`);
    process.exit(1);
  }

  if (!child?.pid) {
    await updateMarker({
      status: "failed",
      message: "Failed to spawn Wingman: child pid missing",
    });
    console.error("[manager] Failed to spawn Wingman: child pid missing");
    process.exit(1);
  }

  child.unref();
  log(`Launched replacement Wingman process (pid ${child.pid})`);

  const ready = await waitForServer(serverPort, 30_000);
  if (!ready) {
    await updateMarker({
      status: "failed",
      message: "Wingman restart launched but new server did not respond in time",
    });
    console.error("[manager] New Wingman instance did not respond within timeout");
    process.exit(1);
  }

  await updateMarker({ status: "completed", message: "Warm restart completed" });
  await rm(markerPath, { force: true }).catch(() => undefined);
  log("Warm restart completed");
};

void main().catch((error) => {
  console.error(`[manager] Unexpected failure: ${(error as Error).message}`);
  process.exit(1);
});

