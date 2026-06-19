#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { join } from "node:path";

import { readEnvFile } from "../utils/env-file";
import { getWappRuntimeEnvForWapp } from "../wapps/runtime-env";
import { wappStore, type WappStore } from "../wapps/wapp-store";

export interface UserAppRunnerInput {
  appId: string;
  appLabel: string;
  appRoot: string;
  startScript: string;
  userAlias: string;
  port?: string;
  wappId?: string;
}

export interface UserAppRunnerDeps {
  store?: WappStore;
  hostEnv?: Record<string, string | undefined>;
  envFileReader?: (directory: string) => Promise<Record<string, string>>;
  redshiftDetector?: (directory: string) => Promise<boolean>;
  spawn?: typeof Bun.spawn;
}

export interface UserAppSpawnPlan {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}

function requireValue(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function appendEnv(env: Record<string, string>, key: string, value: string | undefined): void {
  if (value === undefined) return;
  env[key] = value;
}

function parseRunnerArgs(args: string[]): UserAppRunnerInput {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected runner argument: ${flag}`);
    }
    const key = flag.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    values.set(key, value);
    index += 1;
  }
  return {
    appId: requireValue(values.get("app-id"), "app-id"),
    appLabel: requireValue(values.get("app-label"), "app-label"),
    appRoot: requireValue(values.get("app-root"), "app-root"),
    startScript: requireValue(values.get("start-script"), "start-script"),
    userAlias: requireValue(values.get("user-alias"), "user-alias"),
    port: values.get("port"),
    wappId: values.get("wapp-id"),
  };
}

async function hasRedshiftConfig(directory: string): Promise<boolean> {
  try {
    await access(join(directory, "redshift.yaml"));
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return false;
    throw error;
  }
}

export async function buildUserAppSpawnPlan(
  input: UserAppRunnerInput,
  deps: UserAppRunnerDeps = {},
): Promise<UserAppSpawnPlan> {
  const hostEnv = deps.hostEnv ?? process.env;
  const envFile = await (deps.envFileReader ?? readEnvFile)(input.appRoot);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    appendEnv(env, key, value);
  }
  for (const [key, value] of Object.entries(envFile)) {
    appendEnv(env, key, value);
  }

  env.APP_ID = input.appId;
  env.APP_LABEL = input.appLabel;
  env.USER_ALIAS = input.userAlias;
  if (input.port) env.PORT = input.port;

  if (input.wappId) {
    Object.assign(
      env,
      getWappRuntimeEnvForWapp(input.wappId, input.appRoot, deps.store ?? wappStore),
    );
  }

  const hasRedshift = await (deps.redshiftDetector ?? hasRedshiftConfig)(input.appRoot);
  return {
    cmd: hasRedshift
      ? ["redshift", "run", "--", "bash", "-lc", input.startScript]
      : ["bash", "-lc", input.startScript],
    cwd: input.appRoot,
    env,
  };
}

export async function runUserApp(input: UserAppRunnerInput, deps: UserAppRunnerDeps = {}): Promise<number> {
  const plan = await buildUserAppSpawnPlan(input, deps);
  const spawn = deps.spawn ?? Bun.spawn;
  const child = spawn(plan.cmd, {
    cwd: plan.cwd,
    env: plan.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

async function main(): Promise<void> {
  const input = parseRunnerArgs(Bun.argv.slice(2));
  const exitCode = await runUserApp(input);
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
