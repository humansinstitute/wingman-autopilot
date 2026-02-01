import { appendFileSync } from "node:fs";
import { appAliasRegistry } from "../apps/app-alias-registry";
import { appRegistry } from "../apps/app-registry";
import { appProcessManager } from "../apps/app-process-manager";
import { runtimePortRegistry } from "../apps/runtime-port-registry";

const ROUTING_LOG_PATH = "./tmp/logs-routing.log";

function logRouting(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const logLine = data
    ? `[${timestamp}] ${message} ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(ROUTING_LOG_PATH, logLine);
  } catch {
    // Ignore write errors
  }
}

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

export type ResolveAliasResult =
  | { success: true; port: number; appId: string }
  | { success: false; reason: "alias_not_found" | "app_not_found" | "app_not_running" | "port_not_registered"; alias: string; appId?: string; status?: string };

/**
 * Resolve an alias to a running app's port.
 * Uses the runtime port registry which tracks dynamically detected ports.
 *
 * @param alias - The subdomain alias (e.g., "bold-gem-boat")
 * @returns The port number and appId, or failure reason
 */
export const resolveAliasToPort = async (
  alias: string,
): Promise<ResolveAliasResult> => {
  logRouting(`resolveAliasToPort called`, { alias });

  const aliasRecord = await appAliasRegistry.getByAlias(alias);
  if (!aliasRecord) {
    logRouting(`FAIL: alias not found in registry`, { alias });
    return { success: false, reason: "alias_not_found", alias };
  }
  logRouting(`alias found`, { alias, appId: aliasRecord.appId });

  const app = await appRegistry.getApp(aliasRecord.appId);
  if (!app) {
    logRouting(`FAIL: app not found in registry`, { alias, appId: aliasRecord.appId });
    return { success: false, reason: "app_not_found", alias, appId: aliasRecord.appId };
  }
  logRouting(`app found`, { alias, appId: aliasRecord.appId, label: app.label });

  // Check if app is actually running
  const status = await appProcessManager.getStatus(aliasRecord.appId);
  logRouting(`app status`, { alias, appId: aliasRecord.appId, status: status.status });
  if (status.status !== "running") {
    logRouting(`FAIL: app not running`, { alias, appId: aliasRecord.appId, status: status.status });
    return { success: false, reason: "app_not_running", alias, appId: aliasRecord.appId, status: status.status };
  }

  // Get port from runtime registry (dynamically detected when app started)
  const port = runtimePortRegistry.get(aliasRecord.appId);
  const allPorts = Object.fromEntries(runtimePortRegistry.getAll());
  logRouting(`runtime port lookup`, { alias, appId: aliasRecord.appId, port, allRegisteredPorts: allPorts });
  if (port === null) {
    logRouting(`FAIL: port not in runtime registry`, { alias, appId: aliasRecord.appId });
    return { success: false, reason: "port_not_registered", alias, appId: aliasRecord.appId };
  }

  logRouting(`SUCCESS: resolved alias to port`, { alias, appId: aliasRecord.appId, port });
  return { success: true, port, appId: aliasRecord.appId };
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
  logRouting(`proxyRequestToApp`, { targetPort, targetUrl: targetUrl.toString(), method: request.method });

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

    // Buffer the response body to ensure it's fully read before returning
    // This fixes issues where streaming bodies may not be properly forwarded
    const bodyBuffer = await proxyResponse.arrayBuffer();
    logRouting(`proxy fetch success`, {
      targetPort,
      status: proxyResponse.status,
      contentLength: proxyResponse.headers.get("content-length"),
      bodySize: bodyBuffer.byteLength
    });

    return new Response(bodyBuffer, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logRouting(`proxy fetch FAILED`, { targetPort, error: message });
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
  const host = request.headers.get("host");
  logRouting(`handleSubdomainRequest called`, { host, enabled: config.enabled, baseDomain: config.baseDomain });

  if (!config.enabled || !config.baseDomain) {
    logRouting(`subdomain proxy disabled`, { enabled: config.enabled, baseDomain: config.baseDomain });
    return null;
  }

  const alias = extractSubdomainAlias(host, config.baseDomain);
  logRouting(`extracted alias`, { host, baseDomain: config.baseDomain, alias });

  if (!alias) {
    logRouting(`no alias extracted, not a subdomain request`);
    return null;
  }

  // Check if this is a valid alias
  const resolved = await resolveAliasToPort(alias);
  if (!resolved.success) {
    const errorMessages: Record<string, string> = {
      alias_not_found: `No app registered for alias "${alias}".`,
      app_not_found: `App ID ${resolved.appId} not found in registry.`,
      app_not_running: `App is not running (status: ${resolved.status}).`,
      port_not_registered: `App is running but port not detected. Try restarting the app.`,
    };
    console.warn(`[subdomain-proxy] ${alias}: ${resolved.reason}`, resolved);
    return new Response(
      JSON.stringify({
        error: "App not available",
        reason: resolved.reason,
        message: errorMessages[resolved.reason],
        alias,
        appId: resolved.appId,
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
