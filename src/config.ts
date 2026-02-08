import { isAbsolute, normalize, resolve } from "node:path";

export type AgentType = "codex" | "claude" | "goose" | "opencode" | "gemini";

/** How agent processes are spawned - "bun" for direct child process, "pm2" for PM2 managed */
export type AgentSpawnMode = "bun" | "pm2";

/** How apps are routed - "path" for /host/<alias>, "subdomain" for <alias>.domain.com */
export type AppRoutingMode = "path" | "subdomain";

export interface AgentCommandContext {
  port: number;
  agent: AgentType;
  config: WingmanConfig;
}

export interface AgentDefinition {
  /** Build the command used to spawn the agent API subprocess. */
  command(ctx: AgentCommandContext): string[];
  /** Additional environment variables passed to the subprocess. */
  env?: Record<string, string>;
  /** Human readable label used in the UI. */
  label: string;
}

export interface WingmanConfig {
  port: number;
  /** Public base URL for this Wingman instance (e.g. https://wm21.otherstuff.ai) */
  baseUrl: string;
  agentPortStart: number;
  agentPortMax: number;
  defaultWorkingDirectory: string;
  hostUrlBase: string;
  connectRelays: string[];
  allowedDirectories: string[];
  allowedOrigins: string;
  allowedHosts: string;
  agents: Record<AgentType, AgentDefinition>;
  /** Default agent for AI features (e.g., "Fix with AI", "Edit with AI") */
  defaultAgent: AgentType;
  agentStatusPollIntervalMs: number;
  agentStatusPollMaxIntervalMs: number;
  agentStatusPollTimeoutMs: number;
  /** Base domain for app subdomain routing (e.g., "apps.example.com") */
  subdomainBaseDomain: string | null;
  /** Whether subdomain-based app routing is enabled */
  subdomainProxyEnabled: boolean;
  /** Interval for SSE keepalive messages (prevents idle timeout) */
  sseKeepaliveIntervalMs: number;
  /** How agent processes are spawned - "bun" for direct child process, "pm2" for PM2 managed */
  agentSpawnMode: AgentSpawnMode;
  /** How apps are routed - "path" for /host/<alias>, "subdomain" for <alias>.domain.com */
  appRoutingMode: AppRoutingMode;
  /** Maple Proxy base URL for private chat AI completion */
  mapleProxyUrl: string;
  /** Default model for new private chats */
  mapleDefaultModel: string;
  /** API key for Maple Proxy authentication (null if not required) */
  mapleApiKey: string | null;
}

const DEFAULT_PORT = 3600;
const DEFAULT_AGENT_PORTS = 3700;
const DEFAULT_AGENT_MAX = 10;
const DEFAULT_DIRECTORY = "~/code";
const DEFAULT_HOST_URL_BASE = "https://host.otherstuff.ai/<port>";
const DEFAULT_CONNECT_RELAYS = [
  "wss://relay.nsec.app",
  "wss://nos.lol",
  "wss://relay.getalby.com/v1",
  "wss://nostr.mineracks.com",
];
const DEFAULT_ALLOWED_ORIGINS = "*";
const DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,[::1]";
const DEFAULT_STATUS_POLL_INTERVAL_MS = 100;
const DEFAULT_STATUS_POLL_MAX_INTERVAL_MS = 30000;
const DEFAULT_STATUS_POLL_TIMEOUT_MS = 5000;
const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 30000;

const sanitizeInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampPositiveInteger = (value: number, minimum: number): number => {
  return value >= minimum ? value : minimum;
};

const parseRelayList = (input: string | undefined): string[] => {
  if (!input) return [];
  return input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const expandHomeDirectory = (input: string): string => {
  if (!input.startsWith("~")) return input;
  const home = Bun.env.HOME ?? "~";
  return input.replace("~", home);
};

const normaliseDirectory = (input: string, baseDirectory: string): string => {
  const expanded = expandHomeDirectory(input);
  const absolute = isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded);
  return normalize(absolute);
};

const parseEnvironmentString = (input: string | undefined, fallback: string): string => {
  if (!input) return fallback;
  const trimmed = input.trim();
  if (trimmed.length === 0) return fallback;
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) {
    return trimmed.slice(1, -1).trim() || fallback;
  }
  return trimmed;
};

const defaultAgentApiPath = "../out/agentapi";
const agentApiBinary = Bun.env.AGENTAPI_BIN ?? new URL(defaultAgentApiPath, import.meta.url).pathname;

const baseCommand = (ctx: AgentCommandContext) => {
  return [
    agentApiBinary,
    "server",
    "--port",
    String(ctx.port),
    "--allowed-origins",
    ctx.config.allowedOrigins,
    "--allowed-hosts",
    ctx.config.allowedHosts,
  ];
};

const withAgentCommand = (
  label: string,
  agentCli: string,
  options?: { type?: string; extraArgs?: string[] },
): AgentDefinition => ({
  label,
  command: (ctx) => {
    const args = baseCommand(ctx);
    if (options?.type) {
      args.push(`--type=${options.type}`);
    }
    args.push("--", agentCli);
    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }
    return args;
  },
});

const defaultAgents: Record<AgentType, AgentDefinition> = {
  codex: withAgentCommand("Codex", Bun.env.CODEX_CLI ?? "codex", { type: "codex" }),
  claude: withAgentCommand("Claude", Bun.env.CLAUDE_CLI ?? "claude"),
  goose: withAgentCommand("Goose", Bun.env.GOOSE_CLI ?? "goose"),
  opencode: withAgentCommand("OpenCode", Bun.env.OPENCODE_CLI ?? "opencode"),
  gemini: withAgentCommand("Gemini", Bun.env.GEMINI_CLI ?? "gemini"),
};

export const loadConfig = (): WingmanConfig => {
  const port = sanitizeInteger(Bun.env.PORT, DEFAULT_PORT);
  const agentPortStart = sanitizeInteger(Bun.env.AGENT_PORTS, DEFAULT_AGENT_PORTS);
  const agentPortMax = sanitizeInteger(Bun.env.AGENT_MAX, DEFAULT_AGENT_MAX);
  const defaultDirectoryInput = Bun.env.DIRECTORY_DEF ?? DEFAULT_DIRECTORY;
  const defaultWorkingDirectory = normaliseDirectory(defaultDirectoryInput, process.cwd());
  const allowedDirectoryInput = Bun.env.FOLDERACCESS;
  const configuredAllowedDirectories = allowedDirectoryInput
    ? allowedDirectoryInput
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => normaliseDirectory(value, defaultWorkingDirectory))
    : [];
  const allowedDirectories = Array.from(
    new Set([
      ...configuredAllowedDirectories,
      defaultWorkingDirectory,
    ]),
  );
  const hostUrlBase = parseEnvironmentString(Bun.env.HOST_URL_BASE, DEFAULT_HOST_URL_BASE);
  const allowedOrigins = Bun.env.AGENTAPI_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS;
  const allowedHosts = Bun.env.AGENTAPI_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS;
  const agentStatusPollIntervalMs = clampPositiveInteger(
    sanitizeInteger(Bun.env.AGENT_STATUS_POLL_INTERVAL_MS, DEFAULT_STATUS_POLL_INTERVAL_MS),
    250,
  );
  const agentStatusPollMaxIntervalMs = clampPositiveInteger(
    sanitizeInteger(Bun.env.AGENT_STATUS_POLL_MAX_INTERVAL_MS, DEFAULT_STATUS_POLL_MAX_INTERVAL_MS),
    agentStatusPollIntervalMs,
  );
  const agentStatusPollTimeoutMs = clampPositiveInteger(
    sanitizeInteger(Bun.env.AGENT_STATUS_POLL_TIMEOUT_MS, DEFAULT_STATUS_POLL_TIMEOUT_MS),
    1000,
  );
  const connectRelays = parseRelayList(Bun.env.CONNECT_RELAYS);

  // Subdomain proxy configuration
  const subdomainBaseDomainInput = Bun.env.SUBDOMAIN_BASE_DOMAIN?.trim();
  const subdomainBaseDomain = subdomainBaseDomainInput && subdomainBaseDomainInput.length > 0
    ? subdomainBaseDomainInput
    : null;
  const subdomainProxyEnabled = subdomainBaseDomain !== null &&
    Bun.env.SUBDOMAIN_PROXY_ENABLED !== "false";

  const sseKeepaliveIntervalMs = clampPositiveInteger(
    sanitizeInteger(Bun.env.SSE_KEEPALIVE_INTERVAL_MS, DEFAULT_SSE_KEEPALIVE_INTERVAL_MS),
    5000,
  );

  // Default agent for AI features
  const validAgentTypes: AgentType[] = ["codex", "claude", "goose", "opencode", "gemini"];
  const defaultAgentInput = Bun.env.DEFAULT_AGENT?.trim().toLowerCase();
  const defaultAgent: AgentType = defaultAgentInput && validAgentTypes.includes(defaultAgentInput as AgentType)
    ? (defaultAgentInput as AgentType)
    : "claude";
  console.log(`[Config] Default agent: ${defaultAgent}${defaultAgentInput && defaultAgentInput !== defaultAgent ? ` (DEFAULT_AGENT="${defaultAgentInput}" was invalid)` : ""}`);

  // Agent spawn mode - "bun" (default) or "pm2" for persistence across restarts
  const validSpawnModes: AgentSpawnMode[] = ["bun", "pm2"];
  const spawnModeInput = Bun.env.AGENT_SPAWN_MODE?.trim().toLowerCase();
  const agentSpawnMode: AgentSpawnMode = spawnModeInput && validSpawnModes.includes(spawnModeInput as AgentSpawnMode)
    ? (spawnModeInput as AgentSpawnMode)
    : "bun";
  if (agentSpawnMode === "pm2") {
    console.log("[Config] Agent spawn mode: pm2 (sessions persist across restarts)");
  }

  // App routing mode - "path" for /host/<alias>, "subdomain" for <alias>.domain.com
  const validRoutingModes: AppRoutingMode[] = ["path", "subdomain"];
  const routingModeInput = Bun.env.APP_ROUTING?.trim().toLowerCase();
  const appRoutingMode: AppRoutingMode = routingModeInput && validRoutingModes.includes(routingModeInput as AppRoutingMode)
    ? (routingModeInput as AppRoutingMode)
    : "subdomain";
  if (appRoutingMode === "path") {
    console.log("[Config] App routing mode: path (/host/<alias>)");
  } else if (subdomainBaseDomain) {
    console.log(`[Config] App routing mode: subdomain (<alias>.${subdomainBaseDomain})`);
  }

  // Public base URL (for external links in notifications, etc.)
  const baseUrl = parseEnvironmentString(Bun.env.WINGMAN_BASE_URL, `http://localhost:${port}`);
  console.log(`[Config] Base URL: ${baseUrl}`);

  // Maple Proxy configuration for private chat
  const mapleProxyUrl = parseEnvironmentString(Bun.env.MAPLE_PROXY_URL, "http://localhost:8091");
  const mapleDefaultModel = parseEnvironmentString(Bun.env.MAPLE_DEFAULT_MODEL, "llama-3.3-70b");
  const mapleApiKeyInput = Bun.env.MAPLE_API?.trim();
  const mapleApiKey = mapleApiKeyInput && mapleApiKeyInput.length > 0 ? mapleApiKeyInput : null;

  return {
    port,
    baseUrl,
    agentPortStart,
    agentPortMax,
    defaultWorkingDirectory,
    hostUrlBase,
    connectRelays: connectRelays.length > 0 ? connectRelays : DEFAULT_CONNECT_RELAYS,
    allowedDirectories,
    allowedOrigins,
    allowedHosts,
    agents: defaultAgents,
    defaultAgent,
    agentStatusPollIntervalMs,
    agentStatusPollMaxIntervalMs,
    agentStatusPollTimeoutMs,
    subdomainBaseDomain,
    subdomainProxyEnabled,
    sseKeepaliveIntervalMs,
    agentSpawnMode,
    appRoutingMode,
    mapleProxyUrl,
    mapleDefaultModel,
    mapleApiKey,
  };
};

export type WingmanConfigSnapshot = ReturnType<typeof loadConfig>;

// =============================================================================
// Key Teleport Configuration
// =============================================================================

import { getPublicKey, nip19 } from "nostr-tools";

// Key Teleport environment variables
export const KEYTELEPORT_PRIVKEY = Bun.env.KEYTELEPORT_PRIVKEY ?? "";
export const KEYTELEPORT_WELCOME_PUBKEY = Bun.env.KEYTELEPORT_WELCOME_PUBKEY ?? "";
export const KEYTELEPORT_WELCOME_URL = Bun.env.KEYTELEPORT_WELCOME_URL ?? "https://welcome.nostr.com";

// Helper to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Get the Key Teleport identity (Wingmen's keypair for decrypting teleport blobs)
 */
export function getKeyTeleportIdentity(): {
  npub: string;
  pubkey: string;
  secretKey: Uint8Array;
} | null {
  if (!KEYTELEPORT_PRIVKEY) {
    return null;
  }

  try {
    let secretKey: Uint8Array;

    if (KEYTELEPORT_PRIVKEY.startsWith("nsec")) {
      const decoded = nip19.decode(KEYTELEPORT_PRIVKEY);
      if (decoded.type !== "nsec") {
        console.error("[KeyTeleport] KEYTELEPORT_PRIVKEY is not a valid nsec");
        return null;
      }
      secretKey = decoded.data as Uint8Array;
    } else if (/^[0-9a-fA-F]{64}$/.test(KEYTELEPORT_PRIVKEY)) {
      secretKey = hexToBytes(KEYTELEPORT_PRIVKEY);
    } else {
      console.error("[KeyTeleport] KEYTELEPORT_PRIVKEY must be nsec or 64-char hex");
      return null;
    }

    const pubkey = getPublicKey(secretKey);
    const npub = nip19.npubEncode(pubkey);

    return { npub, pubkey, secretKey };
  } catch (err) {
    console.error("[KeyTeleport] Failed to decode KEYTELEPORT_PRIVKEY:", err);
    return null;
  }
}

/**
 * Get the Welcome pubkey (trusted key manager) as hex
 */
export function getKeyTeleportWelcomePubkey(): string | null {
  if (!KEYTELEPORT_WELCOME_PUBKEY) {
    return null;
  }

  try {
    if (KEYTELEPORT_WELCOME_PUBKEY.startsWith("npub")) {
      const decoded = nip19.decode(KEYTELEPORT_WELCOME_PUBKEY);
      if (decoded.type !== "npub") {
        console.error("[KeyTeleport] KEYTELEPORT_WELCOME_PUBKEY is not a valid npub");
        return null;
      }
      return decoded.data as string;
    } else if (/^[0-9a-fA-F]{64}$/.test(KEYTELEPORT_WELCOME_PUBKEY)) {
      return KEYTELEPORT_WELCOME_PUBKEY;
    } else {
      console.error("[KeyTeleport] KEYTELEPORT_WELCOME_PUBKEY must be npub or 64-char hex");
      return null;
    }
  } catch (err) {
    console.error("[KeyTeleport] Failed to decode KEYTELEPORT_WELCOME_PUBKEY:", err);
    return null;
  }
}

// Startup logging for Key Teleport config
if (KEYTELEPORT_PRIVKEY && KEYTELEPORT_WELCOME_PUBKEY) {
  console.log("[KeyTeleport] Key Teleport configured");
  const identity = getKeyTeleportIdentity();
  if (identity) {
    console.log(`[KeyTeleport] Identity: ${identity.npub.slice(0, 20)}...`);
  }
} else if (KEYTELEPORT_PRIVKEY || KEYTELEPORT_WELCOME_PUBKEY) {
  console.warn("[KeyTeleport] Partially configured - both KEYTELEPORT_PRIVKEY and KEYTELEPORT_WELCOME_PUBKEY required");
}
