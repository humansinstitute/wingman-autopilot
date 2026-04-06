import { normalize } from "node:path";

import type {
  AppRecord,
  AppRegistry,
  RegisterAppInput,
  UpdateAppInput,
} from "../../apps/app-registry";

export const WINGMAN_CORE_APP_ID = "wingman-core";

const DEFAULT_RESTART_COMMAND = "bun run scripts/restart-wingman.ts";
const DEFAULT_TMUX_SESSION = "wingman-core";
const DEFAULT_NOTES = "Controls the Wingman server process.";

type AppRegistryLike = Pick<
  AppRegistry,
  "listApps" | "getApp" | "registerApp" | "updateApp" | "removeApp"
>;

type LoggerLike = Pick<Console, "log" | "warn" | "error">;

export interface EnsureWingmanCoreRegistrationOptions {
  projectRoot: string;
  adminNpub?: string | null;
  restartCommand?: string;
  tmuxSession?: string;
  notes?: string;
  logger?: LoggerLike;
}

export interface CleanupLegacyWingmanRootAppsOptions {
  projectRoot: string;
  logger?: LoggerLike;
}

export interface WingmanCoreRegistrationResult {
  action: "registered" | "updated" | "unchanged" | "blocked" | "error";
  app: AppRecord | null;
  legacyConflictIds: string[];
}

export interface WingmanCoreCleanupResult {
  matchedIds: string[];
  removedIds: string[];
  failedIds: string[];
}

export async function ensureWingmanCoreRegistration(
  registry: AppRegistryLike,
  options: EnsureWingmanCoreRegistrationOptions,
): Promise<WingmanCoreRegistrationResult> {
  const logger = options.logger ?? console;
  const expectedRoot = normalize(options.projectRoot);
  const restartCommand = options.restartCommand ?? DEFAULT_RESTART_COMMAND;
  const tmuxSession = options.tmuxSession ?? DEFAULT_TMUX_SESSION;
  const notes = options.notes ?? DEFAULT_NOTES;

  try {
    const apps = await registry.listApps();
    const legacyApps = findLegacyWingmanRootApps(apps, expectedRoot);
    const existing = await registry.getApp(WINGMAN_CORE_APP_ID);

    if (existing) {
      const updateInput = buildWingmanCoreUpdateInput(
        existing,
        expectedRoot,
        restartCommand,
        tmuxSession,
        notes,
        options.adminNpub ?? null,
      );
      const app = updateInput ? await registry.updateApp(WINGMAN_CORE_APP_ID, updateInput) : existing;
      if (updateInput) {
        logger.log("[apps] reconciled Wingman core app entry");
      }
      if (legacyApps.length > 0) {
        logger.warn(
          `[apps] preserving ${legacyApps.length} legacy Wingman app entr${legacyApps.length === 1 ? "y" : "ies"} during startup; run cleanupLegacyWingmanRootApps() to remove them explicitly`,
        );
      }
      return {
        action: updateInput ? "updated" : "unchanged",
        app,
        legacyConflictIds: legacyApps.map((appRecord) => appRecord.id),
      };
    }

    if (legacyApps.length > 0) {
      logger.warn(
        `[apps] wingman-core registration is blocked by ${legacyApps.length} legacy same-root app entr${legacyApps.length === 1 ? "y" : "ies"}; run cleanupLegacyWingmanRootApps() before retrying registration`,
      );
      return {
        action: "blocked",
        app: null,
        legacyConflictIds: legacyApps.map((appRecord) => appRecord.id),
      };
    }

    const app = await registry.registerApp(
      buildWingmanCoreRegistrationInput(expectedRoot, restartCommand, tmuxSession, notes, options.adminNpub ?? null),
    );
    logger.log("[apps] registered Wingman core app entry");
    return { action: "registered", app, legacyConflictIds: [] };
  } catch (error) {
    logger.error("[apps] Failed to ensure Wingman core registration:", error);
    return { action: "error", app: null, legacyConflictIds: [] };
  }
}

export async function cleanupLegacyWingmanRootApps(
  registry: AppRegistryLike,
  options: CleanupLegacyWingmanRootAppsOptions,
): Promise<WingmanCoreCleanupResult> {
  const logger = options.logger ?? console;
  const expectedRoot = normalize(options.projectRoot);

  try {
    const apps = await registry.listApps();
    const legacyApps = findLegacyWingmanRootApps(apps, expectedRoot);
    const matchedIds = legacyApps.map((app) => app.id);
    if (legacyApps.length === 0) {
      logger.log("[apps] explicit Wingman legacy cleanup found no matching app entries");
      return { matchedIds: [], removedIds: [], failedIds: [] };
    }

    logger.log(
      `[apps] running explicit Wingman legacy cleanup for ${legacyApps.length} same-root app entr${legacyApps.length === 1 ? "y" : "ies"}`,
    );

    const removedIds: string[] = [];
    const failedIds: string[] = [];
    for (const legacyApp of legacyApps) {
      try {
        const removed = await registry.removeApp(legacyApp.id);
        if (removed) {
          removedIds.push(legacyApp.id);
          logger.log(`[apps] removed legacy Wingman app entry (${legacyApp.id})`);
          continue;
        }
        failedIds.push(legacyApp.id);
        logger.warn(`[apps] legacy Wingman app entry disappeared before cleanup (${legacyApp.id})`);
      } catch (error) {
        failedIds.push(legacyApp.id);
        logger.warn(`[apps] failed to remove legacy Wingman app ${legacyApp.id}: ${(error as Error).message}`);
      }
    }

    logger.log(
      `[apps] explicit Wingman legacy cleanup removed ${removedIds.length} of ${legacyApps.length} matching app entr${legacyApps.length === 1 ? "y" : "ies"}`,
    );
    return { matchedIds, removedIds, failedIds };
  } catch (error) {
    logger.error("[apps] Failed to clean up legacy Wingman app entries:", error);
    return { matchedIds: [], removedIds: [], failedIds: [] };
  }
}

function findLegacyWingmanRootApps(apps: AppRecord[], projectRoot: string): AppRecord[] {
  return apps.filter((app) => app.id !== WINGMAN_CORE_APP_ID && normalize(app.root) === projectRoot);
}

function buildWingmanCoreRegistrationInput(
  projectRoot: string,
  restartCommand: string,
  tmuxSession: string,
  notes: string,
  adminNpub: string | null,
): RegisterAppInput {
  return {
    id: WINGMAN_CORE_APP_ID,
    label: "Wingman Server",
    root: projectRoot,
    scripts: { restart: restartCommand },
    tmuxSession,
    notes,
    ownerNpub: adminNpub,
  };
}

function buildWingmanCoreUpdateInput(
  existing: AppRecord,
  projectRoot: string,
  restartCommand: string,
  tmuxSession: string,
  notes: string,
  adminNpub: string | null,
): UpdateAppInput | null {
  const needsUpdate =
    existing.scripts.restart !== restartCommand ||
    existing.tmuxSession !== tmuxSession ||
    normalize(existing.root) !== projectRoot ||
    (!existing.ownerNpub && Boolean(adminNpub));

  if (!needsUpdate) {
    return null;
  }

  return {
    root: projectRoot,
    scripts: { restart: restartCommand },
    tmuxSession,
    notes: existing.notes ?? notes,
    ownerNpub: adminNpub ?? existing.ownerNpub ?? null,
  };
}
