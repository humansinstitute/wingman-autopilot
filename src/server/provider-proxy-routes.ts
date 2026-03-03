import type { SessionSnapshot } from "../agents/process-manager";
import type { TeamBillingService } from "../billing/team-billing-service";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type ProviderKind = "openai" | "anthropic" | "openrouter";

export interface ProviderProxyApiContext {
  billingService: TeamBillingService;
  getSession: (sessionId: string) => SessionSnapshot | null;
  ensureProviderApiKey: () => Promise<string | null>;
}

const PROVIDER_PREFIX = "/api/provider/";

const PROVIDER_TARGET_BASE: Record<ProviderKind, string> = {
  openai: "https://openrouter.ai/api/v1",
  anthropic: "https://openrouter.ai/api",
  openrouter: "https://openrouter.ai",
};

const sensitiveRequestHeaders = new Set([
  "authorization",
  "x-api-key",
  "content-length",
  "host",
]);

const normaliseTokenCandidate = (value: string | null): string | null => {
  if (!value) return null;
  let token = value.trim();
  if (!token) return null;
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice("bearer ".length).trim();
  }
  if (
    (token.startsWith("\"") && token.endsWith("\"")) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token || null;
};

const extractProxyTokenCandidates = (request: Request): string[] => {
  const candidates = [
    normaliseTokenCandidate(request.headers.get("authorization")),
    normaliseTokenCandidate(request.headers.get("x-api-key")),
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(candidates));
};

const parseProviderKindAndPath = (pathname: string): { provider: ProviderKind; restPath: string } | null => {
  if (!pathname.startsWith(PROVIDER_PREFIX)) return null;
  const remainder = pathname.slice(PROVIDER_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  const providerRaw = (slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder).trim().toLowerCase();
  const rest = slashIndex >= 0 ? remainder.slice(slashIndex) : "/";
  if (providerRaw !== "openai" && providerRaw !== "anthropic" && providerRaw !== "openrouter") return null;
  return { provider: providerRaw, restPath: rest || "/" };
};

const buildUpstreamUrl = (provider: ProviderKind, restPath: string, search: string): string => {
  const base = PROVIDER_TARGET_BASE[provider];
  const normalizedPath = restPath.startsWith("/") ? restPath : `/${restPath}`;
  return `${base}${normalizedPath}${search || ""}`;
};

const pickProviderRequestId = (headers: Headers): string | null =>
  headers.get("x-request-id") ??
  headers.get("x-openrouter-request-id") ??
  headers.get("x-oai-request-id") ??
  null;

const isJsonResponse = (headers: Headers): boolean => {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json");
};

const isSseResponse = (headers: Headers): boolean => {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream");
};

const cloneProxyRequestHeaders = (request: Request, teamApiKey: string, provider: ProviderKind): Headers => {
  const outgoing = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (sensitiveRequestHeaders.has(key.toLowerCase())) continue;
    outgoing.set(key, value);
  }
  outgoing.set("Authorization", `Bearer ${teamApiKey}`);
  if (provider === "anthropic") {
    outgoing.set("x-api-key", teamApiKey);
  }
  if (!outgoing.get("HTTP-Referer")) {
    outgoing.set("HTTP-Referer", "https://wingman.local");
  }
  if (!outgoing.get("X-Title")) {
    outgoing.set("X-Title", "Wingman");
  }
  return outgoing;
};

export async function handleProviderProxyApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  ctx: ProviderProxyApiContext,
): Promise<Response | null> {
  const parsed = parseProviderKindAndPath(url.pathname);
  if (!parsed) return null;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!ctx.billingService.isCreditsEnabled()) {
    return Response.json({ error: "credits-disabled" }, { status: 403 });
  }

  const tokenCandidates = extractProxyTokenCandidates(request);
  if (tokenCandidates.length === 0) {
    return Response.json({ error: "missing-proxy-token" }, { status: 401 });
  }
  let payload: ReturnType<TeamBillingService["verifySessionProxyToken"]> = null;
  for (const candidate of tokenCandidates) {
    payload = ctx.billingService.verifySessionProxyToken(candidate);
    if (payload) break;
  }
  if (!payload) {
    return Response.json({ error: "invalid-proxy-token" }, { status: 401 });
  }

  const session = ctx.getSession(payload.sid);
  if (!session || session.status !== "running") {
    return Response.json({ error: "session-not-running" }, { status: 403 });
  }
  if (payload.npub && session.npub && payload.npub !== session.npub) {
    return Response.json({ error: "session-owner-mismatch" }, { status: 403 });
  }
  if (session.metadata?.billingMode !== "credits") {
    return Response.json({ error: "session-not-credits-enabled" }, { status: 403 });
  }

  const teamApiKey = await ctx.ensureProviderApiKey();
  if (!teamApiKey) {
    return Response.json({ error: "team-provider-key-unavailable" }, { status: 503 });
  }

  const upstreamUrl = buildUpstreamUrl(parsed.provider, parsed.restPath, url.search);
  const outgoingHeaders = cloneProxyRequestHeaders(request, teamApiKey, parsed.provider);
  const bodyRequired = !["GET", "HEAD"].includes(method);
  const upstreamBody = bodyRequired ? Buffer.from(await request.arrayBuffer()) : undefined;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: outgoingHeaders,
      body: upstreamBody,
      redirect: "manual",
    });
  } catch (error) {
    return Response.json({ error: `provider-request-failed: ${(error as Error).message}` }, { status: 502 });
  }

  const upstreamHeaders = new Headers(upstreamResponse.headers);
  upstreamHeaders.delete("content-length");

  const providerRequestId = pickProviderRequestId(upstreamResponse.headers);
  let parsedBodyForCost: unknown = null;
  if (isJsonResponse(upstreamResponse.headers)) {
    parsedBodyForCost = await upstreamResponse.clone().json().catch(() => null);
  }
  const parsedCostUsd = ctx.billingService.parseProxyCost(upstreamResponse.headers, parsedBodyForCost);

  void ctx.billingService.recordProxyUsage({
    sessionId: session.id,
    npub: session.npub ?? null,
    agent: session.agent,
    endpoint: parsed.restPath,
    method,
    statusCode: upstreamResponse.status,
    providerRequestId,
    costUsd: parsedCostUsd,
  });

  if (isSseResponse(upstreamResponse.headers)) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamHeaders,
    });
  }

  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  return new Response(responseBuffer, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamHeaders,
  });
}
