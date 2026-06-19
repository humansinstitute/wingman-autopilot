import { parseTowerError, type FetchLike } from "../agent-chat/tower-client";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import { loadYokeBotHelpers } from "../agent-chat/yoke-bot-helpers";

export interface TowerWappRegistrationInput {
  towerUrl: string;
  workspaceOwnerNpub: string;
  appNpub: string;
  appName: string;
  authority: RuntimeBotIdentity;
}

export interface TowerWappRegistrationResult {
  workspaceOwnerNpub: string;
  appNpub: string;
  app: Record<string, unknown> | null;
}

export interface TowerWappRegistrar {
  register(input: TowerWappRegistrationInput): Promise<TowerWappRegistrationResult>;
}

export class TowerWappRegistrationError extends Error {
  readonly status: number | null;
  readonly detailCode: string | null;
  readonly details: unknown;

  constructor(message: string, options: { status?: number | null; detailCode?: string | null; details?: unknown } = {}) {
    super(message);
    this.name = "TowerWappRegistrationError";
    this.status = options.status ?? null;
    this.detailCode = options.detailCode ?? null;
    this.details = options.details;
  }
}

export class HttpTowerWappRegistrar implements TowerWappRegistrar {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async register(input: TowerWappRegistrationInput): Promise<TowerWappRegistrationResult> {
    return registerTowerWappWithTower(input, this.fetchImpl);
  }
}

export async function registerTowerWappWithTower(
  input: TowerWappRegistrationInput,
  fetchImpl: FetchLike = fetch,
): Promise<TowerWappRegistrationResult> {
  const path = `/api/v4/workspaces/${encodeURIComponent(input.workspaceOwnerNpub)}/apps`;
  const url = new URL(path, input.towerUrl).toString();
  const body = {
    app_npub: input.appNpub,
    app_name: input.appName,
    capabilities: ["wapp", "app-db"],
    enabled: true,
  };
  const helpers = await loadYokeBotHelpers();
  const authorization = helpers.signBotRequest({
    botSecret: input.authority.botSecret,
    botNpub: input.authority.botNpub,
    url,
    method: "POST",
    body,
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await parseTowerError(response, "wapp_workspace_app_register");
    throw new TowerWappRegistrationError(error.message, {
      status: error.status,
      detailCode: error.detailCode,
      details: error.details,
    });
  }
  const payload = await response.json().catch(() => null) as { app?: Record<string, unknown> } | null;
  return {
    workspaceOwnerNpub: input.workspaceOwnerNpub,
    appNpub: input.appNpub,
    app: payload?.app ?? null,
  };
}
