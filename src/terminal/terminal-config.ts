import { isAbsolute, normalize, resolve } from "node:path";

export interface TerminalConfig {
  pin: string;
  shell: string;
  cwd: string;
  ticketTtlMs: number;
}

export interface TerminalConfigInput {
  env?: Record<string, string | undefined>;
  defaultCwd: string;
}

const DEFAULT_PIN = "44444";
const DEFAULT_TICKET_TTL_MS = 30_000;

function parsePin(value: string | undefined): string {
  const pin = value?.trim() || DEFAULT_PIN;
  if (!/^\d{5}$/.test(pin)) {
    throw new Error("TMAN_PIN must be exactly 5 digits");
  }
  return pin;
}

function parseTicketTtlMs(value: string | undefined): number {
  if (!value) return DEFAULT_TICKET_TTL_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TICKET_TTL_MS;
  }
  return Math.min(parsed * 1000, 5 * 60 * 1000);
}

function expandHome(input: string, env: Record<string, string | undefined>): string {
  if (!input.startsWith("~")) return input;
  return input.replace("~", env.HOME ?? "~");
}

function resolveCwd(input: string | undefined, defaultCwd: string, env: Record<string, string | undefined>): string {
  const raw = input?.trim() || defaultCwd;
  const expanded = expandHome(raw, env);
  return normalize(isAbsolute(expanded) ? expanded : resolve(defaultCwd, expanded));
}

export function resolveTerminalConfig({
  env = Bun.env,
  defaultCwd,
}: TerminalConfigInput): TerminalConfig {
  const shell = env.TMAN_SHELL?.trim() || env.SHELL?.trim() || "/bin/bash";
  return {
    pin: parsePin(env.TMAN_PIN),
    shell,
    cwd: resolveCwd(env.TMAN_CWD, defaultCwd, env),
    ticketTtlMs: parseTicketTtlMs(env.TMAN_TICKET_TTL_SECONDS),
  };
}
