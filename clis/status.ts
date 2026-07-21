#!/usr/bin/env bun

/**
 * Wingman system status CLI (NIP-98 authenticated).
 *
 * Commands: overview (default), full, apps, sessions, config, flags, restart, restart-resume, restart-status
 */

import { parseCommonFlags, buildConfig, requestJson } from "./lib/auth";

const USAGE = `Wingman system status CLI (NIP-98)

Usage:
  bun clis/status.ts [command] [options]

Commands:
  overview             Apps + sessions dashboard (default)
  full                 Complete system view (apps, sessions, config, flags, archives)
  apps                 List registered apps
  sessions             List active sessions
  config               Show server configuration
  flags                Show feature flags
  flags-set <id> <val> Set a feature flag (val: true/false)
  restart              Trigger warm restart
  restart-resume       Stop sessions, restart, and native-resume them on startup
  restart-status       Check restart status

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Nostr private key (env: WINGMAN_NSEC)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/status.ts
  bun clis/status.ts full --url http://localhost:3600
  bun clis/status.ts config --json
  bun clis/status.ts flags
  bun clis/status.ts restart
  bun clis/status.ts restart-resume`;

interface AppInfo {
  id?: string;
  label?: string;
  status?: string | Record<string, unknown>;
  running?: boolean;
  [key: string]: unknown;
}

interface SessionInfo {
  id?: string;
  name?: string;
  agent?: string;
  status?: string;
  directory?: string;
  [key: string]: unknown;
}

function appStatus(app: AppInfo): { status: string; running: boolean } {
  const sv = app.status;
  const nested = sv && typeof sv === "object" ? (sv as Record<string, unknown>) : null;
  const status = typeof sv === "string" ? sv : typeof nested?.status === "string" ? (nested.status as string) : "unknown";
  const running = typeof app.running === "boolean" ? app.running : typeof nested?.running === "boolean" ? (nested.running as boolean) : false;
  return { status, running };
}

function printOverview(apps: AppInfo[], sessions: SessionInfo[]) {
  console.log("=== Wingman Status ===\n");

  console.log(`Apps: ${apps.length}`);
  for (const app of apps) {
    const { status, running } = appStatus(app);
    const marker = running ? "+" : "-";
    console.log(`  [${marker}] ${app.id ?? "?"}\t${status}`);
  }

  console.log(`\nSessions: ${sessions.length}`);
  for (const s of sessions) {
    const id = String(s.id ?? "").slice(0, 8);
    console.log(`  ${id}\t${s.name ?? "-"}\t${s.agent ?? "-"}\t${s.status ?? "-"}`);
  }
}

function extractSessions(payload: unknown): SessionInfo[] {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.sessions)) return p.sessions;
  }
  if (Array.isArray(payload)) return payload as SessionInfo[];
  return [];
}

async function run() {
  const { args, urlInput, keyInput, asJson, help } = parseCommonFlags(Bun.argv.slice(2));

  const command = args[0]?.toLowerCase() ?? "overview";

  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  const { baseUrl, secretKey } = buildConfig(urlInput, keyInput);

  switch (command) {
    case "overview": {
      const [appsPayload, sessionsPayload] = await Promise.all([
        requestJson<{ apps?: AppInfo[] }>(baseUrl, secretKey, "GET", "/api/apps"),
        requestJson<unknown>(baseUrl, secretKey, "GET", "/api/sessions"),
      ]);
      const apps = Array.isArray(appsPayload.apps) ? appsPayload.apps : [];
      const sessions = extractSessions(sessionsPayload);

      if (asJson) {
        console.log(JSON.stringify({ apps, sessions }, null, 2));
      } else {
        printOverview(apps, sessions);
      }
      break;
    }

    case "full": {
      const [appsPayload, sessionsPayload, configPayload, flagsPayload, archivePayload] = await Promise.all([
        requestJson<{ apps?: AppInfo[] }>(baseUrl, secretKey, "GET", "/api/apps"),
        requestJson<unknown>(baseUrl, secretKey, "GET", "/api/sessions"),
        requestJson<Record<string, unknown>>(baseUrl, secretKey, "GET", "/api/config").catch(() => null),
        requestJson<{ flags?: Record<string, unknown> }>(baseUrl, secretKey, "GET", "/api/feature-flags").catch(() => null),
        requestJson<{ sessions?: SessionInfo[] }>(baseUrl, secretKey, "GET", "/api/archive?limit=5").catch(() => null),
      ]);

      const apps = Array.isArray(appsPayload.apps) ? appsPayload.apps : [];
      const sessions = extractSessions(sessionsPayload);
      const archives = archivePayload
        ? (Array.isArray(archivePayload.sessions) ? archivePayload.sessions : [])
        : [];

      if (asJson) {
        console.log(JSON.stringify({
          apps,
          sessions,
          config: configPayload,
          featureFlags: flagsPayload?.flags ?? null,
          recentArchives: archives,
        }, null, 2));
        break;
      }

      // Print combined dashboard
      console.log("=== Wingman Full Status ===\n");

      // Config summary
      if (configPayload) {
        console.log(`Server: ${configPayload.hostUrlBase ?? baseUrl}`);
        console.log(`Port: ${configPayload.port ?? "?"}`);
        console.log(`Agent ports: ${configPayload.agentPortStart ?? "?"}-${configPayload.agentPortMax ?? "?"}`);
        const agents = Array.isArray(configPayload.agents)
          ? (configPayload.agents as Array<{ id: string; label?: string }>).map(a => a.id).join(", ")
          : "-";
        console.log(`Agents: ${agents}`);
        console.log(`Default: ${configPayload.defaultAgent ?? "-"}`);
        console.log("");
      }

      // Feature flags
      if (flagsPayload?.flags) {
        const flags = flagsPayload.flags as Record<string, unknown>;
        const entries = Object.entries(flags);
        if (entries.length > 0) {
          console.log("Feature flags:");
          for (const [key, val] of entries) {
            const enabled = typeof val === "object" && val !== null
              ? (val as Record<string, unknown>).enabled
              : val;
            console.log(`  ${key}: ${enabled}`);
          }
          console.log("");
        }
      }

      // Apps
      console.log(`Apps: ${apps.length}`);
      for (const app of apps) {
        const { status, running } = appStatus(app);
        const marker = running ? "+" : "-";
        console.log(`  [${marker}] ${app.id ?? "?"}\t${status}`);
      }

      // Sessions
      console.log(`\nSessions: ${sessions.length}`);
      for (const s of sessions) {
        const id = String(s.id ?? "").slice(0, 8);
        const dir = String(s.directory ?? "").split("/").pop() ?? "-";
        console.log(`  ${id}\t${s.name ?? "-"}\t${s.agent ?? "-"}\t${s.status ?? "-"}\t${dir}`);
      }

      // Recent archives
      if (archives.length > 0) {
        console.log(`\nRecent archives: ${archives.length}`);
        for (const a of archives) {
          const id = String(a.id ?? "").slice(0, 8);
          console.log(`  ${id}\t${a.name ?? "-"}\t${a.agent ?? "-"}`);
        }
      }
      break;
    }

    case "apps": {
      const payload = await requestJson<{ apps?: AppInfo[] }>(
        baseUrl, secretKey, "GET", "/api/apps",
      );
      const apps = Array.isArray(payload.apps) ? payload.apps : [];
      if (asJson) {
        console.log(JSON.stringify(apps, null, 2));
      } else {
        if (apps.length === 0) {
          console.log("No apps registered.");
        } else {
          for (const app of apps) {
            const { status, running } = appStatus(app);
            console.log(`${app.id}\t${app.label ?? app.id}\t${status}\trunning=${running ? "yes" : "no"}`);
          }
        }
      }
      break;
    }

    case "sessions": {
      const payload = await requestJson<unknown>(
        baseUrl, secretKey, "GET", "/api/sessions",
      );
      const sessions = extractSessions(payload);
      if (asJson) {
        console.log(JSON.stringify(sessions, null, 2));
      } else {
        if (sessions.length === 0) {
          console.log("No active sessions.");
        } else {
          console.log("ID\tNAME\tAGENT\tSTATUS");
          for (const s of sessions) {
            const id = String(s.id ?? "").slice(0, 8);
            console.log(`${id}\t${s.name ?? "-"}\t${s.agent ?? "-"}\t${s.status ?? "-"}`);
          }
        }
      }
      break;
    }

    case "config": {
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "GET", "/api/config",
      );
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "flags": {
      const payload = await requestJson<{ flags?: Record<string, unknown> }>(
        baseUrl, secretKey, "GET", "/api/feature-flags",
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const flags = payload.flags ?? {};
        const entries = Object.entries(flags);
        if (entries.length === 0) {
          console.log("No feature flags.");
        } else {
          for (const [key, val] of entries) {
            const enabled = typeof val === "object" && val !== null
              ? (val as Record<string, unknown>).enabled
              : val;
            console.log(`${key}\t${enabled}`);
          }
        }
      }
      break;
    }

    case "flags-set": {
      const flagId = args[1];
      const flagVal = args[2];
      if (!flagId || !flagVal) throw new Error("flags-set requires <flag-id> <true|false>");
      const enabled = flagVal === "true";
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST", "/api/feature-flags",
        { id: flagId, enabled },
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`${flagId} = ${enabled}`);
      }
      break;
    }

    case "restart": {
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST", "/api/system/restart",
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Restart scheduled. Sessions preserved: ${JSON.stringify(payload.sessions ?? [])}`);
      }
      break;
    }

    case "restart-resume": {
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST", "/api/system/restart-and-resume",
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Restart scheduled. Sessions queued for native resume: ${JSON.stringify(payload.sessions ?? [])}`);
      }
      break;
    }

    case "restart-status": {
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "GET", "/api/system/restart/status",
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`In progress: ${payload.inProgress ?? false}`);
        if (payload.outcome) console.log(`Outcome: ${JSON.stringify(payload.outcome)}`);
      }
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
