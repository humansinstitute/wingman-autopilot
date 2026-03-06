#!/usr/bin/env bun

/**
 * Wingman session management CLI (NIP-98 authenticated).
 *
 * Commands: list, create, stop, info, logs, send, artifacts, queue, queue-add,
 *           queue-next, archive, archive-info, archive-logs, archive-delete
 */

import { parseCommonFlags, buildConfig, requestJson } from "./lib/auth";

const USAGE = `Wingman session management CLI (NIP-98)

Usage:
  bun clis/sessions.ts <command> [id] [options]

Commands:
  list                 List active sessions
  create <agent-type>  Create a new session
  stop <id>            Stop and archive a session
  info <id>            Show session details
  logs <id>            Show session messages
  send <id> <message>  Send a message to a session
  artifacts <id>       List session artifacts
  queue <id>           Show prompt queue
  queue-add <id> <msg> Add prompt to queue
  queue-next <id>      Execute next queued prompt
  archive              List archived sessions
  archive-info <id>    Show archived session details
  archive-logs <id>    Show archived session messages
  archive-delete <id>  Delete an archived session

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Nostr private key (env: WINGMAN_NSEC)
  --name <name>        Session name (for create)
  --directory <path>   Working directory (for create)
  --model <model>      Model override (for create)
  --limit <n>          Pagination limit (for archive, default: 50)
  --offset <n>         Pagination offset (for archive)
  --filter <text>      Filter archived sessions
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/sessions.ts list
  bun clis/sessions.ts create claude-code --name "my-task" --directory /tmp/project
  bun clis/sessions.ts logs abc123
  bun clis/sessions.ts artifacts abc123
  bun clis/sessions.ts queue abc123
  bun clis/sessions.ts queue-add abc123 "run the tests"
  bun clis/sessions.ts archive --limit 20
  bun clis/sessions.ts stop abc123`;

interface Session {
  id?: string;
  name?: string;
  agent?: string;
  status?: string;
  directory?: string;
  created?: string;
  [key: string]: unknown;
}

function printSessionList(sessions: Session[]) {
  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }
  console.log("ID\tNAME\tAGENT\tSTATUS\tDIRECTORY");
  for (const s of sessions) {
    const id = String(s.id ?? "").slice(0, 8);
    const name = String(s.name ?? "-");
    const agent = String(s.agent ?? "-");
    const status = String(s.status ?? "-");
    const dir = String(s.directory ?? "-");
    console.log(`${id}\t${name}\t${agent}\t${status}\t${dir}`);
  }
}

function printMessages(messages: Array<Record<string, unknown>>) {
  if (messages.length === 0) {
    console.log("No messages.");
    return;
  }
  for (const msg of messages) {
    const role = String(msg.role ?? msg.type ?? "?");
    const content = String(msg.content ?? msg.message ?? msg.text ?? "");
    const ts = msg.timestamp ?? msg.created_at ?? "";
    console.log(`[${ts}] ${role}: ${content.slice(0, 200)}`);
  }
}

async function run() {
  const { args, urlInput, keyInput, asJson, help } = parseCommonFlags(Bun.argv.slice(2));

  // Extract session-specific flags
  let name: string | undefined;
  let directory: string | undefined;
  let model: string | undefined;
  let limit: string | undefined;
  let offset: string | undefined;
  let filter: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--name") {
      name = args[++i];
      if (!name) throw new Error("--name requires a value");
    } else if (flag === "--directory") {
      directory = args[++i];
      if (!directory) throw new Error("--directory requires a value");
    } else if (flag === "--model") {
      model = args[++i];
      if (!model) throw new Error("--model requires a value");
    } else if (flag === "--limit") {
      limit = args[++i];
      if (!limit) throw new Error("--limit requires a value");
    } else if (flag === "--offset") {
      offset = args[++i];
      if (!offset) throw new Error("--offset requires a value");
    } else if (flag === "--filter") {
      filter = args[++i];
      if (!filter) throw new Error("--filter requires a value");
    } else {
      positional.push(flag);
    }
  }

  const command = positional[0]?.toLowerCase() ?? "help";

  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  const { baseUrl, secretKey } = buildConfig(urlInput, keyInput);

  switch (command) {
    case "list": {
      const payload = await requestJson<{ sessions?: Session[] }>(
        baseUrl, secretKey, "GET", "/api/sessions",
      );
      const sessions = Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload) ? (payload as Session[]) : [];
      if (asJson) {
        console.log(JSON.stringify(sessions, null, 2));
      } else {
        printSessionList(sessions);
      }
      break;
    }

    case "create": {
      const agentType = positional[1];
      if (!agentType) throw new Error("create requires <agent-type>");
      const body: Record<string, unknown> = { agent: agentType };
      if (name) body.name = name;
      if (directory) body.directory = directory;
      if (model) body.model = model;
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST", "/api/sessions", body,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const sessionId = String(payload.id ?? payload.sessionId ?? "unknown");
        console.log(`Created session: ${sessionId}`);
      }
      break;
    }

    case "stop": {
      const id = positional[1];
      if (!id) throw new Error("stop requires <id>");
      await requestJson(baseUrl, secretKey, "DELETE", `/api/sessions/${encodeURIComponent(id)}`);
      console.log(`Stopped: ${id}`);
      break;
    }

    case "info": {
      const id = positional[1];
      if (!id) throw new Error("info requires <id>");
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "GET", `/api/sessions/${encodeURIComponent(id)}`,
      );
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "logs": {
      const id = positional[1];
      if (!id) throw new Error("logs requires <id>");
      const payload = await requestJson<{ messages?: Array<Record<string, unknown>> }>(
        baseUrl, secretKey, "GET", `/api/sessions/${encodeURIComponent(id)}/messages`,
      );
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        printMessages(messages);
      }
      break;
    }

    case "send": {
      const id = positional[1];
      const message = positional.slice(2).join(" ");
      if (!id) throw new Error("send requires <id> <message>");
      if (!message) throw new Error("send requires a message after the session id");
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST",
        `/api/sessions/${encodeURIComponent(id)}/messages`,
        { content: message },
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Sent to ${id}`);
      }
      break;
    }

    case "artifacts": {
      const id = positional[1];
      if (!id) throw new Error("artifacts requires <id>");
      const payload = await requestJson<{ artifacts?: Array<Record<string, unknown>> }>(
        baseUrl, secretKey, "GET",
        `/api/sessions/${encodeURIComponent(id)}/artifacts`,
      );
      const artifacts = Array.isArray(payload.artifacts)
        ? payload.artifacts
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(artifacts, null, 2));
      } else {
        if (artifacts.length === 0) {
          console.log("No artifacts.");
        } else {
          for (const a of artifacts) {
            const name = String(a.name ?? a.path ?? a.filename ?? "?");
            const type = String(a.type ?? a.kind ?? "-");
            console.log(`  ${name}\t${type}`);
          }
        }
      }
      break;
    }

    case "queue": {
      const id = positional[1];
      if (!id) throw new Error("queue requires <id>");
      const payload = await requestJson<{ queue?: Array<Record<string, unknown>> }>(
        baseUrl, secretKey, "GET",
        `/api/sessions/${encodeURIComponent(id)}/queue`,
      );
      const queue = Array.isArray(payload.queue)
        ? payload.queue
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(queue, null, 2));
      } else {
        if (queue.length === 0) {
          console.log("Queue empty.");
        } else {
          for (const item of queue) {
            const promptId = String(item.id ?? "?").slice(0, 8);
            const content = String(item.content ?? item.prompt ?? "").slice(0, 100);
            const status = String(item.status ?? "-");
            console.log(`  ${promptId}\t${status}\t${content}`);
          }
        }
      }
      break;
    }

    case "queue-add": {
      const id = positional[1];
      const prompt = positional.slice(2).join(" ");
      if (!id) throw new Error("queue-add requires <id> <prompt>");
      if (!prompt) throw new Error("queue-add requires a prompt after the session id");
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST",
        `/api/sessions/${encodeURIComponent(id)}/queue`,
        { content: prompt },
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Queued prompt for ${id}`);
      }
      break;
    }

    case "queue-next": {
      const id = positional[1];
      if (!id) throw new Error("queue-next requires <id>");
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST",
        `/api/sessions/${encodeURIComponent(id)}/queue/next`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Executing next prompt for ${id}`);
      }
      break;
    }

    case "archive": {
      const params = new URLSearchParams();
      if (limit) params.set("limit", limit);
      if (offset) params.set("offset", offset);
      if (filter) params.set("filter", filter);
      const qs = params.toString();
      const path = `/api/archive${qs ? `?${qs}` : ""}`;
      const payload = await requestJson<{ sessions?: Session[]; archives?: Session[] }>(
        baseUrl, secretKey, "GET", path,
      );
      const archives = Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload.archives)
          ? payload.archives
          : Array.isArray(payload) ? (payload as Session[]) : [];
      if (asJson) {
        console.log(JSON.stringify(archives, null, 2));
      } else {
        if (archives.length === 0) {
          console.log("No archived sessions.");
        } else {
          console.log("ID\tNAME\tAGENT\tSTATUS");
          for (const s of archives) {
            const id = String(s.id ?? "").slice(0, 8);
            console.log(`${id}\t${s.name ?? "-"}\t${s.agent ?? "-"}\t${s.status ?? "archived"}`);
          }
        }
      }
      break;
    }

    case "archive-info": {
      const id = positional[1];
      if (!id) throw new Error("archive-info requires <id>");
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "GET", `/api/archive/${encodeURIComponent(id)}`,
      );
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "archive-logs": {
      const id = positional[1];
      if (!id) throw new Error("archive-logs requires <id>");
      const payload = await requestJson<{ messages?: Array<Record<string, unknown>> }>(
        baseUrl, secretKey, "GET",
        `/api/archive/${encodeURIComponent(id)}/messages`,
      );
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        printMessages(messages);
      }
      break;
    }

    case "archive-delete": {
      const id = positional[1];
      if (!id) throw new Error("archive-delete requires <id>");
      await requestJson(baseUrl, secretKey, "DELETE", `/api/archive/${encodeURIComponent(id)}`);
      console.log(`Deleted archive: ${id}`);
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
