import { isAbsolute, normalize, resolve } from "node:path";

export type AgentType = "codex" | "claude" | "goose" | "opencode" | "gemini";

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
  agentPortStart: number;
  agentPortMax: number;
  defaultWorkingDirectory: string;
  hostUrlBase: string;
  connectRelays: string[];
  allowedDirectories: string[];
  allowedOrigins: string;
  allowedHosts: string;
  agents: Record<AgentType, AgentDefinition>;
  agentStatusPollIntervalMs: number;
  agentStatusPollMaxIntervalMs: number;
  agentStatusPollTimeoutMs: number;
  /** Base domain for app subdomain routing (e.g., "apps.example.com") */
  subdomainBaseDomain: string | null;
  /** Whether subdomain-based app routing is enabled */
  subdomainProxyEnabled: boolean;
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
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1000;
const DEFAULT_STATUS_POLL_MAX_INTERVAL_MS = 30000;
const DEFAULT_STATUS_POLL_TIMEOUT_MS = 5000;

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

  return {
    port,
    agentPortStart,
    agentPortMax,
    defaultWorkingDirectory,
    hostUrlBase,
    connectRelays: connectRelays.length > 0 ? connectRelays : DEFAULT_CONNECT_RELAYS,
    allowedDirectories,
    allowedOrigins,
    allowedHosts,
    agents: defaultAgents,
    agentStatusPollIntervalMs,
    agentStatusPollMaxIntervalMs,
    agentStatusPollTimeoutMs,
    subdomainBaseDomain,
    subdomainProxyEnabled,
  };
};

export type WingmanConfigSnapshot = ReturnType<typeof loadConfig>;
