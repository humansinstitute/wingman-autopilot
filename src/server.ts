import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve as resolvePath } from "node:path";

import { AgentType, loadConfig } from "./config";
import { ProcessManager } from "./agents/process-manager";
import { messageStore, ReplaceMessageInput } from "./storage/message-store";

const config = loadConfig();
const manager = new ProcessManager(config);

manager.on((event) => {
  if (event.type === "session-started") {
    messageStore.recordSession(event.session.id, event.session.agent, event.session.startedAt);
    messageStore.replaceMessages(event.session.id, []);
  }
});

const MAX_DIRECTORY_RESULTS = 50;

const expandHomeDirectory = (input: string): string => {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = Bun.env.HOME ?? "";
  return home ? input.replace("~", home) : input;
};

const toAbsoluteDirectory = (input: string): string => {
  const expanded = expandHomeDirectory(input);
  const candidate = isAbsolute(expanded)
    ? expanded
    : resolvePath(config.defaultWorkingDirectory, expanded);
  return normalize(candidate);
};

const ensureDirectory = async (input: string | null | undefined): Promise<string> => {
  const source = input?.trim();
  const candidate = source && source.length > 0 ? source : config.defaultWorkingDirectory;
  const absolute = toAbsoluteDirectory(candidate);
  let resolved = absolute;

  try {
    resolved = await realpath(absolute);
  } catch {
    // realpath fails when the directory does not exist; keep the normalized path.
    resolved = absolute;
  }

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error(`Directory not found: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  return resolved;
};

const listDirectories = async (input: string | null | undefined, query?: string) => {
  const directory = await ensureDirectory(input);
  const entries = await readdir(directory, { withFileTypes: true });
  const term = query?.toLowerCase().trim();

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: normalize(join(directory, entry.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => {
      if (!term) return true;
      return entry.name.toLowerCase().includes(term);
    })
    .slice(0, MAX_DIRECTORY_RESULTS);

  const parent = (() => {
    const candidate = dirname(directory);
    return candidate === directory ? null : candidate;
  })();

  return {
    path: directory,
    parent,
    entries: directories,
  };
};

type HttpMethod = "GET" | "POST" | "DELETE";

const assetMap: Record<string, { path: string; type: string }> = {
  "/app.js": { path: "./ui/app.js", type: "application/javascript; charset=utf-8" },
  "/styles.css": { path: "./ui/styles.css", type: "text/css; charset=utf-8" },
};

const resolveAsset = (pathname: string) => {
  const asset = assetMap[pathname];
  if (!asset) return undefined;
  const url = new URL(asset.path, import.meta.url);
  const file = Bun.file(url);
  if (!file.size) return undefined;
  return new Response(file, {
    headers: {
      "content-type": asset.type,
      "cache-control": "public, max-age=60",
    },
  });
};

const servePublicAsset = (pathname: string) => {
  const normalized = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!normalized) return undefined;
  const url = new URL(`../public/${normalized}`, import.meta.url);
  const file = Bun.file(url);
  if (!file.size) return undefined;

  const type = file.type || undefined;
  return new Response(file, {
    headers: {
      ...(type ? { "content-type": type } : {}),
      "cache-control": "public, max-age=3600",
    },
  });
};

const serveIndex = () => {
  const url = new URL("./ui/index.html", import.meta.url);
  return new Response(Bun.file(url), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
};

const isAgentType = (value: string): value is AgentType => {
  return ["codex", "claude", "goose", "opencode"].includes(value);
};

const buildAgentUrl = (port: number, path: string): URL => {
  return new URL(path, `http://127.0.0.1:${port}/`);
};

const normaliseAgentMessages = (items: unknown[]): ReplaceMessageInput[] => {
  const base = Date.now();
  return items
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const value = item as Record<string, unknown>;
      const role =
        typeof value.type === "string" && value.type.length > 0
          ? value.type
          : typeof value.role === "string" && value.role.length > 0
            ? value.role
            : "assistant";

      const contentRaw =
        typeof value.content === "string" && value.content.length > 0
          ? value.content
          : typeof value.message === "string" && value.message.length > 0
            ? value.message
            : "";

      if (!contentRaw) {
        return undefined;
      }

      const createdAtCandidate =
        typeof value.createdAt === "string"
          ? value.createdAt
          : typeof value.created_at === "string"
            ? value.created_at
            : typeof value.timestamp === "string"
              ? value.timestamp
              : undefined;

      const createdAt = createdAtCandidate ?? new Date(base + index).toISOString();

      return {
        role,
        content: contentRaw,
        createdAt,
      };
    })
    .filter((item): item is ReplaceMessageInput => Boolean(item));
};

const syncSessionMessages = async (sessionId: string, force = false) => {
  if (!force && messageStore.hasMessages(sessionId)) {
    return messageStore.listSessionMessages(sessionId);
  }

  const session = manager.getSession(sessionId);
  if (!session) {
    return messageStore.listSessionMessages(sessionId);
  }

  try {
    const agentUrl = buildAgentUrl(session.port, "/messages");
    const response = await fetch(agentUrl);
    if (!response.ok) {
      return messageStore.listSessionMessages(sessionId);
    }
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : [];
    const messages = normaliseAgentMessages(items);
    messageStore.replaceMessages(sessionId, messages);
  } catch (error) {
    console.error(`Failed to synchronise messages for session ${sessionId}:`, error);
  }

  return messageStore.listSessionMessages(sessionId);
};

const handleApi = async (request: Request, url: URL, method: HttpMethod): Promise<Response> => {
  const pathname = url.pathname;
  if (pathname === "/api/config" && method === "GET") {
    return Response.json({
      port: config.port,
      agentPortStart: config.agentPortStart,
      agentPortMax: config.agentPortMax,
      defaultDirectory: config.defaultWorkingDirectory,
      agents: Object.entries(config.agents).map(([key, definition]) => ({
        id: key,
        label: definition.label,
      })),
    });
  }

  if (pathname === "/api/directories" && method === "GET") {
    try {
      const data = await listDirectories(url.searchParams.get("path"), url.searchParams.get("query") ?? undefined);
      return Response.json(data);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/sessions" && method === "GET") {
    const sessions = manager.listSessions();
    return Response.json({ sessions });
  }

  if (pathname === "/api/sessions" && method === "POST") {
    try {
      const payload = await request.json();
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      let workingDirectory: string;
      try {
        workingDirectory = await ensureDirectory(directoryInput);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const session = await manager.createSession(agent, workingDirectory);
      messageStore.recordSession(session.id, session.agent, session.startedAt);
      await syncSessionMessages(session.id, true);
      return Response.json(session, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname.startsWith("/api/sessions/")) {
    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    if (method === "GET" && parts.length === 4) {
      const session = manager.getSession(id);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(session);
    }

    if (method === "DELETE" && parts.length === 4) {
      const session = await manager.stopSession(id);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(session);
    }

    if (method === "GET" && parts[4] === "logs") {
      const logs = manager.getLogs(id);
      if (!logs) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id, logs });
    }

    if (parts[4] === "messages") {
      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (refresh ? syncSessionMessages(id, true) : messageStore.listSessionMessages(id));
        return Response.json({ id, messages });
      }

      if (method === "POST") {
        const session = manager.getSession(id);
        if (!session) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch (error) {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }

        const content =
          typeof (payload as Record<string, unknown>)?.content === "string"
            ? (payload as Record<string, unknown>).content.trim()
            : "";

        if (!content) {
          return Response.json({ error: "Message content is required" }, { status: 400 });
        }

        try {
          const agentUrl = buildAgentUrl(session.port, "/message");
          const agentResponse = await fetch(agentUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "user", content }),
          });
          if (!agentResponse.ok) {
            const errorPayload = await agentResponse.json().catch(() => ({}));
            const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
            return Response.json({ error: message }, { status: agentResponse.status });
          }
        } catch (error) {
          return Response.json({ error: `Failed to contact agent: ${(error as Error).message}` }, { status: 502 });
        }

        const messages = await syncSessionMessages(id, true);
        return Response.json({ id, messages });
      }
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

const server = Bun.serve({
  port: config.port,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method as HttpMethod;

    if (pathname === "/" && method === "GET") {
      return Response.redirect(`${url.origin}/home`, 302);
    }

    if (pathname === "/home" || pathname === "/live") {
      return serveIndex();
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(request, url, method);
    }

    const assetResponse = resolveAsset(pathname);
    if (assetResponse) {
      return assetResponse;
    }

    const publicAsset = servePublicAsset(pathname);
    if (publicAsset) {
      return publicAsset;
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `Wingman V2 orchestrator listening on http://localhost:${config.port} (agents ${config.agentPortStart} - ${config.agentPortStart + config.agentPortMax - 1})`,
);

export { server, manager, config };
