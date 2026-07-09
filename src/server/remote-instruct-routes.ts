import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import {
  buildRemoteInstructVariables,
  loadRemoteInstruct,
  RemoteInstructConfigError,
} from "../remote-instruct/remote-instruct";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface RemoteInstructRoutesContext {
  promptPath: string;
  config: {
    baseUrl: string;
    agents: Record<string, { label: string }>;
  };
  getDefaultWorkdir: (authContext: RequestAuthContext) => string;
  projectReference: string | null;
  resolveNip98AuthContext: (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => RequestAuthContext;
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: {
    SessionsManage: AccessAction;
  };
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method-not-allowed" },
    { status: 405, headers: { allow: "GET" } },
  );
}

export async function handleRemoteInstructApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: RemoteInstructRoutesContext,
): Promise<Response | null> {
  if (url.pathname !== "/api/remote-instruct") {
    return null;
  }

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { allow: "GET" } });
  }
  if (method !== "GET" && method !== "HEAD") {
    return methodNotAllowed();
  }

  const remoteAuthContext = ctx.resolveNip98AuthContext(request, url, authContext);
  const denied = await ctx.ensureApiAccess(
    ctx.AccessActions.SessionsManage,
    request,
    url,
    remoteAuthContext,
  );
  if (denied) {
    return denied;
  }

  if (!remoteAuthContext.npub) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const variables = buildRemoteInstructVariables({
      autopilotUrl: ctx.config.baseUrl,
      defaultWorkdir: ctx.getDefaultWorkdir(remoteAuthContext),
      agentTypes: Object.keys(ctx.config.agents),
      viewerNpub: remoteAuthContext.npub,
      authMethod: remoteAuthContext.authMethod ?? null,
      projectReference: ctx.projectReference,
    });
    const rendered = await loadRemoteInstruct({
      promptPath: ctx.promptPath,
      variables,
    });

    return Response.json({
      ok: true,
      name: "Remote Instruct",
      version: 1,
      content: rendered.content,
      variables: rendered.variables,
      missingVariables: rendered.missingVariables,
    });
  } catch (error) {
    if (error instanceof RemoteInstructConfigError) {
      return Response.json(
        { error: "remote-instruct-not-configured", message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }
}
