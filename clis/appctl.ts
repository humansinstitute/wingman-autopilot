#!/usr/bin/env bun

/**
 * Wingman app lifecycle CLI (NIP-98 authenticated).
 *
 * Commands: list, status, start, stop, restart, build, setup, register, unregister,
 *           clone, starters, starters-create, starters-delete
 */

import { parseCommonFlags, buildConfig, requestJson, requestJsonBotCrypto, resolveBaseUrl } from "./lib/auth";

type AppAction = "start" | "stop" | "restart" | "build" | "setup";
type Command =
  | "list"
  | "status"
  | AppAction
  | "register"
  | "unregister"
  | "clone"
  | "starters"
  | "starters-create"
  | "starters-delete"
  | "tower-bindings"
  | "tower-binding-create"
  | "tower-binding-default"
  | "help";

const USAGE = `Wingman app lifecycle CLI (NIP-98)

Usage:
  bun clis/appctl.ts <command> [app-id] [options]

Commands:
  list                 List registered apps
  status <app-id>      Show app details and runtime status
  start <app-id>       Start app
  stop <app-id>        Stop app
  restart <app-id>     Restart app
  build <app-id>       Run app build script
  setup <app-id>       Run app setup script
  register <app-id>    Register an app (requires --directory)
  unregister <app-id>  Unregister an app
  clone <repo-url>     Clone a git repo into the workspace
  starters             List starter project templates
  starters-create      Create a starter template (requires --name, --git-url)
  starters-delete <id> Delete a starter template
  tower-bindings       List WApp Tower bindings
  tower-binding-create Create WApp Tower binding (requires --name, --tower-url, --workspace-owner-npub)
  tower-binding-default <id> Select default WApp Tower binding

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Nostr private key (env: WINGMAN_NSEC)
  --directory <path>   App directory (for register) or folder name (for clone)
  --name <name>        Starter project name (for starters-create)
  --git-url <url>      Git repo URL (for starters-create)
  --tower-url <url>    Tower base URL (for tower-binding-create)
  --workspace-owner-npub <npub> Workspace owner npub (for tower-binding-create)
  --user-alias <alias> User alias to inject into Tower-backed WApps
  --default            Mark created WApp Tower binding as default
  --web-app            Mark as a web app (for register and starters-create)
  --bot-crypto         Sign via bot-crypto API (for agent sessions)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/appctl.ts list
  bun clis/appctl.ts status my-app
  bun clis/appctl.ts start my-app --url http://localhost:3600
  bun clis/appctl.ts clone https://github.com/org/repo.git --directory my-project
  bun clis/appctl.ts starters
  bun clis/appctl.ts starters-create --name "My Template" --git-url https://github.com/org/repo`;

function resolveAppStatus(app: Record<string, unknown> | undefined): { status: string; running: boolean } {
  if (!app) return { status: "unknown", running: false };

  const statusValue = app.status;
  const nestedStatus =
    statusValue && typeof statusValue === "object" ? (statusValue as Record<string, unknown>) : null;

  const status =
    typeof statusValue === "string"
      ? statusValue
      : typeof nestedStatus?.status === "string"
        ? (nestedStatus.status as string)
        : "unknown";

  const running =
    typeof app.running === "boolean"
      ? app.running
      : typeof nestedStatus?.running === "boolean"
        ? (nestedStatus.running as boolean)
        : false;

  return { status, running };
}

function printList(payload: { apps?: Array<Record<string, unknown>> }) {
  const apps = Array.isArray(payload.apps) ? payload.apps : [];
  if (apps.length === 0) {
    console.log("No apps registered.");
    return;
  }
  for (const app of apps) {
    const id = String(app.id ?? "");
    const label = String(app.label ?? id);
    const { status, running } = resolveAppStatus(app);
    console.log(`${id}\t${label}\t${status}\trunning=${running ? "yes" : "no"}`);
  }
}

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));

  // Extract command-specific flags from remaining args
  let directory: string | undefined;
  let starterName: string | undefined;
  let gitUrl: string | undefined;
  let towerUrl: string | undefined;
  let workspaceOwnerNpub: string | undefined;
  let userAlias: string | undefined;
  let makeDefault = false;
  let webApp = false;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--directory") {
      directory = args[++i];
      if (!directory) throw new Error("--directory requires a value");
    } else if (flag === "--name") {
      starterName = args[++i];
      if (!starterName) throw new Error("--name requires a value");
    } else if (flag === "--git-url") {
      gitUrl = args[++i];
      if (!gitUrl) throw new Error("--git-url requires a value");
    } else if (flag === "--tower-url") {
      towerUrl = args[++i];
      if (!towerUrl) throw new Error("--tower-url requires a value");
    } else if (flag === "--workspace-owner-npub") {
      workspaceOwnerNpub = args[++i];
      if (!workspaceOwnerNpub) throw new Error("--workspace-owner-npub requires a value");
    } else if (flag === "--user-alias") {
      userAlias = args[++i];
      if (!userAlias) throw new Error("--user-alias requires a value");
    } else if (flag === "--default") {
      makeDefault = true;
    } else if (flag === "--web-app") {
      webApp = true;
    } else {
      filteredArgs.push(flag);
    }
  }

  // Parse command
  const commandStr = filteredArgs[0]?.toLowerCase() ?? "help";
  const validCommands = [
    "list", "status", "start", "stop", "restart", "build", "setup",
    "register", "unregister", "clone", "starters", "starters-create", "starters-delete",
    "tower-bindings", "tower-binding-create", "tower-binding-default", "help",
  ];
  if (!validCommands.includes(commandStr)) {
    throw new Error(`Unknown command: ${commandStr}`);
  }
  const command = (help ? "help" : commandStr) as Command;
  const appId = filteredArgs[1];

  if (command === "help") {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);

  // Unified request helper: bot-crypto signs via API, otherwise uses local key
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (botCrypto) {
      return requestJsonBotCrypto<T>(baseUrl, method, path, body);
    }
    const { secretKey } = buildConfig(urlInput, keyInput);
    return requestJson<T>(baseUrl, secretKey, method, path, body);
  }

  if (command === "list") {
    const payload = await req<{ apps?: Array<Record<string, unknown>> }>(
      "GET", "/api/apps",
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printList(payload);
    }
    return;
  }

  if (command === "starters") {
    const payload = await req<{ projects?: Array<Record<string, unknown>> }>(
      "GET", "/api/apps/starter-projects",
    );
    const projects = Array.isArray(payload.projects)
      ? payload.projects
      : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
    if (asJson) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      if (projects.length === 0) {
        console.log("No starter projects.");
      } else {
        for (const p of projects) {
          const webFlag = p.webApp ? "web" : "cli";
          console.log(`${p.id}\t${p.name ?? "-"}\t${webFlag}\t${p.gitUrl ?? "-"}`);
        }
      }
    }
    return;
  }

  if (command === "tower-bindings") {
    const payload = await req<{ bindings?: Array<Record<string, unknown>>; defaultBinding?: Record<string, unknown> | null }>(
      "GET", "/api/wapps/tower-bindings",
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
      if (bindings.length === 0) {
        console.log("No WApp Tower bindings.");
      } else {
        for (const binding of bindings) {
          const marker = binding.isDefault ? "*" : " ";
          console.log(`${marker}\t${binding.id ?? ""}\t${binding.label ?? ""}\t${binding.towerUrl ?? ""}\t${binding.workspaceOwnerNpub ?? ""}`);
        }
      }
    }
    return;
  }

  if (command === "tower-binding-create") {
    if (!starterName) throw new Error("tower-binding-create requires --name <name>");
    if (!towerUrl) throw new Error("tower-binding-create requires --tower-url <url>");
    if (!workspaceOwnerNpub) throw new Error("tower-binding-create requires --workspace-owner-npub <npub>");
    const payload = await req<Record<string, unknown>>(
      "POST",
      "/api/wapps/tower-bindings",
      {
        label: starterName,
        towerUrl,
        workspaceOwnerNpub,
        userAlias,
        isDefault: makeDefault,
      },
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const binding = payload.binding as Record<string, unknown> | undefined;
      console.log(`Created WApp Tower binding: ${binding?.id ?? starterName}`);
    }
    return;
  }

  if (command === "starters-create") {
    if (!starterName) throw new Error("starters-create requires --name <name>");
    if (!gitUrl) throw new Error("starters-create requires --git-url <url>");
    const body: Record<string, unknown> = { name: starterName, gitUrl };
    if (webApp) body.webApp = true;
    const payload = await req<Record<string, unknown>>(
      "POST", "/api/admin/starter-projects", body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Created starter: ${payload.id ?? starterName}`);
    }
    return;
  }

  if (command === "clone") {
    const repoUrl = appId; // positional[1] is the repo URL for clone
    if (!repoUrl) throw new Error("clone requires <repo-url>");
    const body: Record<string, unknown> = { url: repoUrl };
    if (directory) body.directory = directory;
    const payload = await req<Record<string, unknown>>(
      "POST", "/api/apps/clone", body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Cloned: ${payload.root ?? payload.label ?? repoUrl}`);
    }
    return;
  }

  if (!appId) throw new Error(`Command "${command}" requires <app-id>`);

  if (command === "starters-delete") {
    await req("DELETE", `/api/admin/starter-projects/${encodeURIComponent(appId)}`);
    console.log(`Deleted starter: ${appId}`);
    return;
  }

  if (command === "tower-binding-default") {
    const payload = await req<Record<string, unknown>>(
      "PATCH",
      `/api/wapps/tower-bindings/${encodeURIComponent(appId)}`,
      { isDefault: true },
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Selected default WApp Tower binding: ${appId}`);
    }
    return;
  }

  if (command === "status") {
    const payload = await req<Record<string, unknown>>(
      "GET", `/api/apps/${encodeURIComponent(appId)}`,
    );
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "register") {
    if (!directory) throw new Error("register requires --directory <path>");
    const body: Record<string, unknown> = { root: directory, label: appId };
    if (webApp) body.webApp = true;
    const payload = await req<Record<string, unknown>>(
      "POST", "/api/apps",
      body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Registered: ${appId}`);
    }
    return;
  }

  if (command === "unregister") {
    const payload = await req<Record<string, unknown>>(
      "DELETE", `/api/apps/${encodeURIComponent(appId)}`,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Unregistered: ${appId}`);
    }
    return;
  }

  // Action commands: start, stop, restart, build, setup
  const payload = await req<Record<string, unknown>>(
    "POST",
    `/api/apps/${encodeURIComponent(appId)}/actions`,
    { action: command },
  );
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const app = payload.app as Record<string, unknown> | undefined;
    const { status, running } = resolveAppStatus(app);
    console.log(`${command} ok: ${appId} status=${status} running=${running ? "yes" : "no"}`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
