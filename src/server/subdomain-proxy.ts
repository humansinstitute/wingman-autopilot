import { appAliasRegistry } from "../apps/app-alias-registry";
import { appRegistry } from "../apps/app-registry";
import { appProcessManager } from "../apps/app-process-manager";

/**
 * Configuration for subdomain routing.
 */
export interface SubdomainProxyConfig {
  /** Base domain for app subdomains, e.g., "apps.example.com" */
  baseDomain: string | null;
  /** Whether subdomain routing is enabled */
  enabled: boolean;
}

/**
 * Extract subdomain alias from Host header.
 *
 * @param host - Host header value (e.g., "bold-gem-boat.apps.example.com")
 * @param baseDomain - Base domain to match against (e.g., "apps.example.com")
 * @returns The subdomain alias, or null if not a subdomain request
 */
export const extractSubdomainAlias = (
  host: string | null,
  baseDomain: string | null,
): string | null => {
  if (!host || !baseDomain) {
    return null;
  }

  // Remove port if present
  const hostWithoutPort = host.split(":")[0].toLowerCase();
  const normalizedBase = baseDomain.toLowerCase();

  // Check if host ends with .baseDomain
  const suffix = `.${normalizedBase}`;
  if (!hostWithoutPort.endsWith(suffix)) {
    return null;
  }

  // Extract the subdomain part
  const subdomain = hostWithoutPort.slice(0, -suffix.length);

  // Validate it looks like an alias (non-empty, no dots)
  if (!subdomain || subdomain.includes(".")) {
    return null;
  }

  return subdomain;
};

/**
 * Resolve an alias to a running app's port.
 *
 * @param alias - The subdomain alias (e.g., "bold-gem-boat")
 * @returns The port number, or null if app not found or not running
 */
export const resolveAliasToPort = async (
  alias: string,
): Promise<{ port: number; appId: string } | null> => {
  const aliasRecord = await appAliasRegistry.getByAlias(alias);
  if (!aliasRecord) {
    return null;
  }

  const app = await appRegistry.getApp(aliasRecord.appId);
  if (!app || !app.webApp || !app.webAppPort) {
    return null;
  }

  // Check if app is actually running
  const status = await appProcessManager.getStatus(aliasRecord.appId);
  if (status.state !== "running") {
    return null;
  }

  return {
    port: app.webAppPort,
    appId: aliasRecord.appId,
  };
};

/**
 * Proxy a request to an app running on a specific port.
 *
 * @param request - Original incoming request
 * @param targetPort - Port to proxy to
 * @returns Proxied response
 */
export const proxyRequestToApp = async (
  request: Request,
  targetPort: number,
): Promise<Response> => {
  const url = new URL(request.url);

  // Build target URL
  const targetUrl = new URL(url.pathname + url.search, `http://127.0.0.1:${targetPort}`);

  // Clone headers, removing hop-by-hop headers
  const headers = new Headers();
  const hopByHopHeaders = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  for (const [key, value] of request.headers) {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  // Add X-Forwarded headers
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  headers.set("X-Forwarded-For", request.headers.get("x-forwarded-for") ?? "127.0.0.1");

  try {
    const proxyResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - Bun supports duplex but types may not reflect it
      duplex: "half",
    });

    // Clone response headers, removing hop-by-hop
    const responseHeaders = new Headers();
    for (const [key, value] of proxyResponse.headers) {
      if (!hopByHopHeaders.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[subdomain-proxy] Failed to proxy to port ${targetPort}: ${message}`);

    return new Response(
      JSON.stringify({
        error: "App unavailable",
        message: "The application is not responding. It may be starting up or has stopped.",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

/**
 * Handle WebSocket upgrade for subdomain proxy.
 *
 * @param request - Original upgrade request
 * @param targetPort - Port to proxy to
 * @param server - Bun server instance for WebSocket upgrade
 * @returns Response or undefined if handled as WebSocket
 */
export const proxyWebSocketToApp = async (
  request: Request,
  targetPort: number,
  server: { upgrade: (request: Request, options?: object) => boolean },
): Promise<Response | undefined> => {
  // For now, return an error - WebSocket proxying needs more work
  // Bun's WebSocket API requires different handling than HTTP
  console.warn(`[subdomain-proxy] WebSocket proxy not yet implemented for port ${targetPort}`);

  return new Response(
    JSON.stringify({
      error: "WebSocket proxy not implemented",
      message: "WebSocket connections through subdomain routing are not yet supported.",
    }),
    {
      status: 501,
      headers: { "Content-Type": "application/json" },
    },
  );
};

/**
 * Main entry point for subdomain routing.
 * Should be called early in the request handler.
 *
 * @param request - Incoming request
 * @param config - Subdomain proxy configuration
 * @returns Response if handled, null if not a subdomain request
 */
export const handleSubdomainRequest = async (
  request: Request,
  config: SubdomainProxyConfig,
): Promise<Response | null> => {
  if (!config.enabled || !config.baseDomain) {
    return null;
  }

  const host = request.headers.get("host");
  const alias = extractSubdomainAlias(host, config.baseDomain);

  if (!alias) {
    return null;
  }

  // Check if this is a valid alias
  const resolved = await resolveAliasToPort(alias);
  if (!resolved) {
    return new Response(
      JSON.stringify({
        error: "App not found",
        message: `No running app found for alias "${alias}". The app may not exist or is not currently running.`,
        alias,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Check for WebSocket upgrade
  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader?.toLowerCase() === "websocket") {
    // WebSocket handling would go here
    // For now, fall back to returning an error
    return new Response(
      JSON.stringify({
        error: "WebSocket not supported",
        message: "WebSocket connections through subdomain routing are not yet fully supported.",
      }),
      {
        status: 501,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Proxy HTTP request
  return proxyRequestToApp(request, resolved.port);
};
