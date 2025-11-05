import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { appRegistry, type AppRecord } from "../apps/app-registry";
import type { TodoRecord, TodoStore, UpdateTodoInput } from "./todo-store";

export interface TodoApiDependencies {
  store: TodoStore;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const parseRequestBody = async (request: Request): Promise<Record<string, unknown>> => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON payload");
  }
  return payload as Record<string, unknown>;
};

const toIsoStringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid due date");
  }
  return parsed.toISOString();
};

const parsePriority = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return null;
    }
    return Math.max(0, Math.min(3, Math.round(value)));
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed === "none") return 0;
    if (trimmed === "low") return 1;
    if (trimmed === "medium" || trimmed === "med") return 2;
    if (trimmed === "high") return 3;
    const numeric = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(numeric)) {
      return Math.max(0, Math.min(3, Math.round(numeric)));
    }
  }
  throw new Error("Invalid priority");
};

const parseBoolean = (value: unknown): boolean | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  throw new Error("Invalid boolean");
};

const normaliseOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const canAccessApp = (app: AppRecord, ownerNpub: string): boolean => {
  if (!app.ownerNpub) {
    return false;
  }
  return app.ownerNpub === ownerNpub;
};

const verifyAppOwnership = async (appId: string | null, ownerNpub: string): Promise<void> => {
  if (!appId) {
    return;
  }
  const app = await appRegistry.getApp(appId);
  if (!app) {
    throw new Error("Associated app not found");
  }
  if (!canAccessApp(app, ownerNpub)) {
    throw new Error("Associated app is not accessible");
  }
};

const serializeTodo = (record: TodoRecord) => ({
  id: record.id,
  title: record.title,
  description: record.description,
  dueDate: record.dueDate,
  appId: record.appId,
  priority: record.priority,
  starred: record.starred,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const handleTodoCollection = async (
  deps: TodoApiDependencies,
  method: HttpMethod,
  owner: string,
  request: Request,
): Promise<Response> => {
  if (method === "GET") {
    const todos = deps.store.list(owner).map(serializeTodo);
    return Response.json({ todos });
  }

  if (method === "POST") {
    const input = await parseRequestBody(request);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      return Response.json({ error: "Title is required" }, { status: 400 });
    }
    let dueDate: string | null = null;
    try {
      dueDate = toIsoStringOrNull(input.dueDate);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
    let priority: number | null = null;
    try {
      priority = parsePriority(input.priority);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
    let starred: boolean | null = null;
    try {
      starred = parseBoolean(input.starred);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
    const appId = normaliseOptionalString(input.appId);
    try {
      await verifyAppOwnership(appId, owner);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
    try {
      const created = deps.store.create({
        ownerNpub: owner,
        title,
        description: typeof input.description === "string" ? input.description : null,
        dueDate,
        appId,
        priority,
        starred,
      });
      return Response.json({ todo: serializeTodo(created) }, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

const handleTodoItem = async (
  deps: TodoApiDependencies,
  method: HttpMethod,
  owner: string,
  todoId: string,
  request: Request,
): Promise<Response> => {
  if (!todoId) {
    return Response.json({ error: "Todo id is required" }, { status: 400 });
  }

  const existing = deps.store.get(owner, todoId);
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (method === "GET") {
    return Response.json({ todo: serializeTodo(existing) });
  }

  if (method === "DELETE") {
    const removed = deps.store.delete(owner, todoId);
    if (!removed) {
      return Response.json({ error: "Unable to delete todo" }, { status: 500 });
    }
    return new Response(null, { status: 204 });
  }

  if (method === "PUT" || method === "PATCH") {
    const input = await parseRequestBody(request);
    const updates: UpdateTodoInput = {};

    if (input.title !== undefined) {
      if (typeof input.title !== "string" || !input.title.trim()) {
        return Response.json({ error: "Title is required" }, { status: 400 });
      }
      updates.title = input.title.trim();
    }

    if (input.description !== undefined) {
      if (input.description === null || typeof input.description === "string") {
        updates.description = input.description;
      } else {
        return Response.json({ error: "Invalid description" }, { status: 400 });
      }
    }

    if (input.dueDate !== undefined) {
      try {
        updates.dueDate = toIsoStringOrNull(input.dueDate);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (input.appId !== undefined) {
      if (input.appId === null || typeof input.appId === "string") {
        const appId = normaliseOptionalString(input.appId);
        try {
          await verifyAppOwnership(appId, owner);
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
        updates.appId = appId;
      } else {
        return Response.json({ error: "Invalid app id" }, { status: 400 });
      }
    }

    if (input.priority !== undefined) {
      try {
        updates.priority = parsePriority(input.priority);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (input.starred !== undefined) {
      try {
        const parsed = parseBoolean(input.starred);
        updates.starred = parsed ?? existing.starred;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    try {
      const updated = deps.store.update(owner, todoId, updates);
      if (!updated) {
        return Response.json({ error: "Unable to update todo" }, { status: 404 });
      }
      return Response.json({ todo: serializeTodo(updated) });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const createTodoApiHandler = (dependencies: TodoApiDependencies) => {
  const deps = dependencies;
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    authContext: RequestAuthContext,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/todos")) {
      return null;
    }

    const ownerNpub = normaliseNpub(authContext.npub ?? null);
    if (!ownerNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 2) {
      return handleTodoCollection(deps, method, ownerNpub, request);
    }
    if (segments.length === 3) {
      return handleTodoItem(deps, method, ownerNpub, segments[2], request);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
};
