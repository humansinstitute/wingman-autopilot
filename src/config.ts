import { isAbsolute, normalize, resolve } from "node:path";
import {
  buildAgentCliUpdateArgs,
  buildAgentCliUpdateEnv,
  isAgentCliAutoUpdateEnabled,
} from "./agent-cli-update-policy";
import { AGENT_TYPES, DEFAULT_AGENT_TYPE, type AgentType } from "./agent-types";

export type { AgentType } from "./agent-types";

/** How agent processes are spawned. */
export type AgentSpawnMode = "bun" | "pm2" | "tmux";

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
  /** Selectable model overrides for this agent. "default" means no --model flag. */
  modelOptions: string[];
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
  /** How agent processes are spawned. */
  agentSpawnMode: AgentSpawnMode;
  /** Tmux session used when agentSpawnMode is "tmux". */
  agentTmuxSession: string;
  /** How apps are routed - "path" for /host/<alias>, "subdomain" for <alias>.domain.com */
  appRoutingMode: AppRoutingMode;
  /** Maple Proxy base URL for private chat AI completion */
  mapleProxyUrl: string;
  /** Default model for new private chats */
  mapleDefaultModel: string;
  /** API key for Maple Proxy authentication (null if not required) */
  mapleApiKey: string | null;
  /** Gitea instance base URL (e.g. https://gitea.pages.otherstuff.ai) */
  giteaUrl: string | null;
  /** Gitea API token for repo creation */
  giteaApiToken: string | null;
  /** Gitea username/org that owns created repos */
  giteaOwner: string | null;
  /** SuperBased / Flux Adaptor API base URL */
  superbasedUrl: string | null;
  /** Whether new user registration is allowed (REGISTER env var, default true) */
  registrationEnabled: boolean;
}

const DEFAULT_PORT = 3600;
const DEFAULT_AGENT_PORTS = 3700;
const DEFAULT_AGENT_MAX = 10;
const DEFAULT_DIRECTORY = "~/code";
const DEFAULT_HOST_URL_BASE = "https://host.otherstuff.ai/<port>";
const DEFAULT_CONNECT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://proxy.nostr-relay.app/8c5723f2601334234e1922d2e842d6bbf209283b07120b3f1d38660915f13793",
  "ws://127.0.0.1:4869",
];
const DEFAULT_ALLOWED_ORIGINS = "*";
const DEFAULT_ALLOWED_HOSTS = "localhost,127.0.0.1,[::1]";
const DEFAULT_STATUS_POLL_INTERVAL_MS = 100;
const DEFAULT_STATUS_POLL_MAX_INTERVAL_MS = 30000;
const DEFAULT_STATUS_POLL_TIMEOUT_MS = 1000;
const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 30000;
const DEFAULT_AGENTAPI_RELATIVE_PATH = "../out/agentapi";
const DEFAULT_AGENT_TMUX_SESSION = "wm-ap-agents";
const DEFAULT_MODEL_OPTION = "default";
const CODEX_MODEL_OPTIONS = [
  DEFAULT_MODEL_OPTION,
  "gpt-5.5",
  "gpt-5.4-mini",
];
const CLAUDE_MODEL_OPTIONS = [DEFAULT_MODEL_OPTION];
const GOOSE_MODEL_OPTIONS = [DEFAULT_MODEL_OPTION];
const OPENCODE_MODEL_OPTIONS = [
  DEFAULT_MODEL_OPTION,
  "opencode/big-pickle",
];
const GEMINI_MODEL_OPTIONS = [DEFAULT_MODEL_OPTION];
const PI_MODEL_OPTIONS = [DEFAULT_MODEL_OPTION];

type ConfigEnvironment = Record<string, string | undefined>;

type AgentApiBinarySource = "default" | "agentapi_bin";

type AgentSpawnModeSource = "default" | "agent_spawn_mode" | "legacy_agent_mode_pm2" | "legacy_agent_mode_tmux";

export interface AgentLaunchConfigResolution {
  agentApiBinary: string;
  agentApiBinarySource: AgentApiBinarySource;
  agentSpawnMode: AgentSpawnMode;
  agentSpawnModeSource: AgentSpawnModeSource;
  warnings: string[];
}

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

function readEnvValue(env: ConfigEnvironment, key: string): string | undefined {
  return env[key];
}

function readTrimmedEnvValue(env: ConfigEnvironment, key: string): string | null {
  const value = readEnvValue(env, key);
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readLowerCaseEnvValue(env: ConfigEnvironment, key: string): string | null {
  const trimmed = readTrimmedEnvValue(env, key);
  return trimmed ? trimmed.toLowerCase() : null;
}

function readWingmanOverrideEnvValue(env: ConfigEnvironment, key: string): string | null {
  return readTrimmedEnvValue(env, `WINGMAN_${key}`) ?? readTrimmedEnvValue(env, key);
}

function resolveDefaultAgentApiPath(relativePath: string): string {
  return new URL(relativePath, import.meta.url).pathname;
}

export function resolveAgentLaunchConfig(env: ConfigEnvironment = Bun.env): AgentLaunchConfigResolution {
  const warnings: string[] = [];
  const legacyModeInput = readLowerCaseEnvValue(env, "AGENT_MODE");
  const spawnModeInput = readLowerCaseEnvValue(env, "AGENT_SPAWN_MODE");
  const agentApiBinInput = readTrimmedEnvValue(env, "AGENTAPI_BIN");

  let agentApiBinarySource: AgentApiBinarySource = "default";
  let agentApiBinary = resolveDefaultAgentApiPath(DEFAULT_AGENTAPI_RELATIVE_PATH);
  if (agentApiBinInput) {
    agentApiBinarySource = "agentapi_bin";
    agentApiBinary = agentApiBinInput;
  }

  let agentSpawnModeSource: AgentSpawnModeSource = "default";
  let agentSpawnMode: AgentSpawnMode = "bun";
  const validSpawnModes: AgentSpawnMode[] = ["bun", "pm2", "tmux"];
  if (spawnModeInput && validSpawnModes.includes(spawnModeInput as AgentSpawnMode)) {
    agentSpawnModeSource = "agent_spawn_mode";
    agentSpawnMode = spawnModeInput as AgentSpawnMode;
    if (legacyModeInput === "pm2") {
      if (agentSpawnMode === "pm2") {
        warnings.push("AGENT_MODE=pm2 is deprecated; use AGENT_SPAWN_MODE=pm2.");
      } else {
        warnings.push(
          `AGENT_MODE=pm2 is deprecated and ignored because AGENT_SPAWN_MODE=${agentSpawnMode}.`,
        );
      }
    }
  } else if (spawnModeInput) {
    warnings.push(
      `Ignoring unrecognized AGENT_SPAWN_MODE="${spawnModeInput}"; expected "bun", "pm2", or "tmux".`,
    );
    if (legacyModeInput === "pm2") {
      agentSpawnModeSource = "legacy_agent_mode_pm2";
      agentSpawnMode = "pm2";
      warnings.push("AGENT_MODE=pm2 is deprecated; use AGENT_SPAWN_MODE=pm2.");
    }
  } else if (legacyModeInput === "pm2") {
    agentSpawnModeSource = "legacy_agent_mode_pm2";
    agentSpawnMode = "pm2";
    warnings.push("AGENT_MODE=pm2 is deprecated; use AGENT_SPAWN_MODE=pm2.");
  } else if (legacyModeInput === "tmux") {
    agentSpawnModeSource = "legacy_agent_mode_tmux";
    agentSpawnMode = "tmux";
    warnings.push("AGENT_MODE=tmux is deprecated; use AGENT_SPAWN_MODE=tmux.");
  }

  if (legacyModeInput === "standard") {
    warnings.push(
      "AGENT_MODE=standard is deprecated and has no effect; use AGENT_SPAWN_MODE and AGENTAPI_BIN for active configuration.",
    );
  } else if (legacyModeInput && !["pm2", "standard", "tmux"].includes(legacyModeInput)) {
    warnings.push(`Ignoring unrecognized AGENT_MODE="${legacyModeInput}".`);
  }

  return {
    agentApiBinary,
    agentApiBinarySource,
    agentSpawnMode,
    agentSpawnModeSource,
    warnings,
  };
}

function baseCommand(agentApiBinary: string, ctx: AgentCommandContext): string[] {
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
}

function withAgentCommand(
  agentApiBinary: string,
  label: string,
  agentCli: string,
  options?: { type?: string; extraArgs?: string[]; env?: Record<string, string>; modelOptions?: string[] },
): AgentDefinition {
  return {
    label,
    env: options?.env,
    modelOptions: options?.modelOptions ?? [DEFAULT_MODEL_OPTION],
    command: (ctx) => {
      const args = baseCommand(agentApiBinary, ctx);
      if (options?.type) {
        args.push(`--type=${options.type}`);
      }
      args.push("--", agentCli);
      if (options?.extraArgs) {
        args.push(...options.extraArgs);
      }
      return args;
    },
  };
}

function resolveClaudeExtraArgs(glovesValue: string | undefined): string[] {
  const normalized = glovesValue?.trim().toUpperCase() ?? "";
  if (["OFF", "FALSE", "0", "NO"].includes(normalized)) {
    return ["--dangerously-skip-permissions"];
  }
  return [];
}

function resolveCodexExtraArgs(glovesValue: string | undefined): string[] {
  const normalized = glovesValue?.trim().toUpperCase() ?? "";
  if (["OFF", "FALSE", "0", "NO"].includes(normalized)) {
    return ["--yolo"];
  }
  return [];
}

function resolveOpenCodeExtraArgs(modelValue: string | undefined): string[] {
  const model = modelValue?.trim();
  return model && model.length > 0 ? ["--model", model] : [];
}

function createDefaultAgents(
  env: ConfigEnvironment,
  agentApiBinary: string,
): Record<AgentType, AgentDefinition> {
  const openCodeExtraArgs = resolveOpenCodeExtraArgs(readEnvValue(env, "OPENCODE_MODEL"));
  const cliAutoUpdateEnabled = isAgentCliAutoUpdateEnabled(env);
  const codexExtraArgs = [
    ...resolveCodexExtraArgs(readEnvValue(env, "GLOVES")),
    ...buildAgentCliUpdateArgs("codex", cliAutoUpdateEnabled),
  ];
  const claudeExtraArgs = resolveClaudeExtraArgs(readEnvValue(env, "GLOVES"));

  return {
    codex: withAgentCommand(agentApiBinary, "Codex", readEnvValue(env, "CODEX_CLI") ?? "codex", {
      type: "codex",
      extraArgs: codexExtraArgs,
      env: buildAgentCliUpdateEnv("codex", cliAutoUpdateEnabled),
      modelOptions: CODEX_MODEL_OPTIONS,
    }),
    claude: withAgentCommand(agentApiBinary, "Claude", readEnvValue(env, "CLAUDE_CLI") ?? "claude", {
      type: "claude",
      extraArgs: claudeExtraArgs,
      env: buildAgentCliUpdateEnv("claude", cliAutoUpdateEnabled),
      modelOptions: CLAUDE_MODEL_OPTIONS,
    }),
    goose: withAgentCommand(agentApiBinary, "Goose", readEnvValue(env, "GOOSE_CLI") ?? "goose", {
      type: "goose",
      modelOptions: GOOSE_MODEL_OPTIONS,
    }),
    opencode: withAgentCommand(agentApiBinary, "OpenCode", readEnvValue(env, "OPENCODE_CLI") ?? "opencode", {
      type: "opencode",
      extraArgs: openCodeExtraArgs,
      modelOptions: OPENCODE_MODEL_OPTIONS,
    }),
    gemini: withAgentCommand(agentApiBinary, "Gemini", readEnvValue(env, "GEMINI_CLI") ?? "gemini", {
      type: "gemini",
      modelOptions: GEMINI_MODEL_OPTIONS,
    }),
    pi: withAgentCommand(agentApiBinary, "Pi", readEnvValue(env, "PI_CLI") ?? "pi", {
      modelOptions: PI_MODEL_OPTIONS,
    }),
  };
}

export const loadConfig = (): WingmanConfig => {
  const agentLaunchConfig = resolveAgentLaunchConfig();
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
  const subdomainBaseDomain = readWingmanOverrideEnvValue(Bun.env, "SUBDOMAIN_BASE_DOMAIN");
  const subdomainProxyEnabled = subdomainBaseDomain !== null &&
    readWingmanOverrideEnvValue(Bun.env, "SUBDOMAIN_PROXY_ENABLED") !== "false";

  const sseKeepaliveIntervalMs = clampPositiveInteger(
    sanitizeInteger(Bun.env.SSE_KEEPALIVE_INTERVAL_MS, DEFAULT_SSE_KEEPALIVE_INTERVAL_MS),
    5000,
  );

  // Default agent for AI features
  const defaultAgentInput = Bun.env.DEFAULT_AGENT?.trim().toLowerCase();
  const defaultAgent: AgentType = defaultAgentInput && AGENT_TYPES.includes(defaultAgentInput as AgentType)
    ? (defaultAgentInput as AgentType)
    : DEFAULT_AGENT_TYPE;
  console.log(`[Config] Default agent: ${defaultAgent}${defaultAgentInput && defaultAgentInput !== defaultAgent ? ` (DEFAULT_AGENT="${defaultAgentInput}" was invalid)` : ""}`);
  const codexExtraArgs = resolveCodexExtraArgs(Bun.env.GLOVES);
  const claudeExtraArgs = resolveClaudeExtraArgs(Bun.env.GLOVES);
  const agents = createDefaultAgents(Bun.env, agentLaunchConfig.agentApiBinary);
  if (codexExtraArgs.includes("--yolo")) {
    console.log("[Config] Codex approvals: disabled (GLOVES=OFF)");
  }
  if (claudeExtraArgs.includes("--dangerously-skip-permissions")) {
    console.log("[Config] Claude approvals: disabled (GLOVES=OFF)");
  }

  for (const warning of agentLaunchConfig.warnings) {
    console.warn(`[Config] ${warning}`);
  }
  if (agentLaunchConfig.agentSpawnMode === "pm2") {
    console.log("[Config] Agent spawn mode: pm2 (sessions persist across restarts)");
  } else if (agentLaunchConfig.agentSpawnMode === "tmux") {
    console.log("[Config] Agent spawn mode: tmux (sessions run in tmux windows)");
  }
  const agentTmuxSession = parseEnvironmentString(Bun.env.AGENT_TMUX_SESSION, DEFAULT_AGENT_TMUX_SESSION);

  // App routing mode - "path" for /host/<alias>, "subdomain" for <alias>.domain.com
  const validRoutingModes: AppRoutingMode[] = ["path", "subdomain"];
  const routingModeInput = readWingmanOverrideEnvValue(Bun.env, "APP_ROUTING")?.toLowerCase();
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

  // Gitea configuration for ngit repo hosting
  const giteaUrlInput = Bun.env.GITEA_URL?.trim();
  const giteaUrl = giteaUrlInput && giteaUrlInput.length > 0 ? giteaUrlInput.replace(/\/+$/, "") : null;
  const giteaApiTokenInput = Bun.env.GITEA_API_TOKEN?.trim();
  const giteaApiToken = giteaApiTokenInput && giteaApiTokenInput.length > 0 ? giteaApiTokenInput : null;
  const giteaOwnerInput = Bun.env.GITEA_OWNER?.trim();
  const giteaOwner = giteaOwnerInput && giteaOwnerInput.length > 0 ? giteaOwnerInput : null;
  if (giteaUrl && giteaApiToken && giteaOwner) {
    console.log(`[Config] Gitea: ${giteaUrl} (owner: ${giteaOwner})`);
  } else if (giteaUrl || giteaApiToken || giteaOwner) {
    console.warn("[Config] Gitea partially configured — need GITEA_URL, GITEA_API_TOKEN, and GITEA_OWNER");
  }

  // Registration toggle — set REGISTER=FALSE to block new signups
  const registerInput = (Bun.env.REGISTER ?? "").trim().toUpperCase();
  const registrationEnabled = registerInput !== "FALSE";
  if (!registrationEnabled) {
    console.log("[Config] Registration disabled (REGISTER=FALSE)");
  }

  // SuperBased / Flux Adaptor configuration
  const superbasedUrlInput = Bun.env.SUPERBASED_URL?.trim();
  const superbasedUrl = superbasedUrlInput && superbasedUrlInput.length > 0
    ? superbasedUrlInput.replace(/\/+$/, "")
    : null;
  if (superbasedUrl) {
    console.log(`[Config] SuperBased: ${superbasedUrl}`);
  }

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
    agents,
    defaultAgent,
    agentStatusPollIntervalMs,
    agentStatusPollMaxIntervalMs,
    agentStatusPollTimeoutMs,
    subdomainBaseDomain,
    subdomainProxyEnabled,
    sseKeepaliveIntervalMs,
    agentSpawnMode: agentLaunchConfig.agentSpawnMode,
    agentTmuxSession,
    appRoutingMode,
    mapleProxyUrl,
    mapleDefaultModel,
    mapleApiKey,
    giteaUrl,
    giteaApiToken,
    giteaOwner,
    superbasedUrl,
    registrationEnabled,
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
