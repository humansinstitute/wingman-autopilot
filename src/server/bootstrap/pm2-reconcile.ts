/**
 * PM2 Reconciliation Module
 *
 * On server startup, reconciles PM2 running processes with app registry records.
 * PM2 is the source of truth for runtime state (running/stopped).
 * Registry is the source of truth for app metadata.
 */

import { listProcesses, type PM2ProcessDescription } from "../../agents/pm2-wrapper";
import type { AppRegistry } from "../../apps/app-registry";

/**
 * Extract app ID from PM2 process environment.
 * User apps have APP_ID set in their env.
 */
function getAppIdFromPM2(proc: PM2ProcessDescription): string | null {
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;
  const appId = pm2Env?.APP_ID;
  return typeof appId === "string" ? appId : null;
}

/**
 * Extract PORT from PM2 process environment.
 * Returns the port number if set, null otherwise.
 */
function getPortFromPM2(proc: PM2ProcessDescription): number | null {
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;
  const portValue = pm2Env?.PORT;
  if (typeof portValue === "string") {
    const parsed = parseInt(portValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof portValue === "number" && Number.isFinite(portValue)) {
    return portValue > 0 ? portValue : null;
  }
  return null;
}

/**
 * Reconcile PM2 processes with app registry records.
 *
 * Algorithm:
 * 1. Get all PM2 processes with APP_ID env var
 * 2. Get all apps from registry
 * 3. For each PM2 process with APP_ID:
 *    - Find matching app in registry
 *    - Update app's pm2Name if PM2 is online
 * 4. For each app in registry with pm2Name but not in PM2:
 *    - Clear the pm2Name (process no longer exists)
 */
export async function reconcileAppsWithPM2(
  registry: AppRegistry,
): Promise<{ appsReconciled: number; appsCleared: number }> {
  let appsReconciled = 0;
  let appsCleared = 0;

  // Get current PM2 state
  let pm2Processes: PM2ProcessDescription[] = [];
  try {
    pm2Processes = await listProcesses();
  } catch (error) {
    console.warn(`[pm2-reconcile] failed to list PM2 processes for apps: ${(error as Error).message}`);
    return { appsReconciled: 0, appsCleared: 0 };
  }

  // Get apps from registry
  const apps = await registry.listApps();
  const appsById = new Map(apps.map((app) => [app.id, app]));

  // Build map of APP_ID -> PM2 process for running apps
  const pm2AppProcesses = new Map<string, PM2ProcessDescription>();
  for (const proc of pm2Processes) {
    const appId = getAppIdFromPM2(proc);
    if (appId) {
      pm2AppProcesses.set(appId, proc);
    }
  }

  // Reconcile: update apps that have running PM2 processes
  for (const [appId, proc] of pm2AppProcesses) {
    const app = appsById.get(appId);
    if (!app) {
      // PM2 process for unknown app - orphaned
      console.warn(`[pm2-reconcile] PM2 process ${proc.name} has APP_ID ${appId} but no registry entry`);
      continue;
    }

    const pm2Status = proc.pm2_env?.status;
    if (pm2Status === "online") {
      // Update app with PM2 info if it doesn't match
      const pm2Name = proc.name ?? undefined;
      const pm2Port = getPortFromPM2(proc);

      if (app.pm2Name !== pm2Name) {
        try {
          await registry.updateApp(appId, { pm2Name });
          const portInfo = pm2Port ? ` on port ${pm2Port}` : "";
          console.log(`[pm2-reconcile] updated app ${appId} with PM2 name ${pm2Name}${portInfo}`);
          appsReconciled++;
        } catch (error) {
          console.warn(`[pm2-reconcile] failed to update app ${appId}: ${(error as Error).message}`);
        }
      } else {
        appsReconciled++;
      }

      // Warn if PM2 port doesn't match registry
      if (pm2Port && app.webAppPort && pm2Port !== app.webAppPort) {
        console.warn(`[pm2-reconcile] app ${appId} port mismatch: PM2=${pm2Port}, registry=${app.webAppPort}`);
      }
    }
  }

  // Clear pm2Name for apps no longer in PM2
  for (const app of apps) {
    if (app.pm2Name && !pm2AppProcesses.has(app.id)) {
      // This app has a pm2Name but no PM2 process - clear it
      try {
        await registry.updateApp(app.id, { pm2Name: undefined });
        console.log(`[pm2-reconcile] cleared pm2Name for app ${app.id} (process not running)`);
        appsCleared++;
      } catch (error) {
        console.warn(`[pm2-reconcile] failed to clear pm2Name for app ${app.id}: ${(error as Error).message}`);
      }
    }
  }

  if (appsReconciled > 0) {
    console.log(`[pm2-reconcile] reconciled ${appsReconciled} app(s) with PM2`);
  }
  if (appsCleared > 0) {
    console.log(`[pm2-reconcile] cleared PM2 state for ${appsCleared} app(s)`);
  }

  return { appsReconciled, appsCleared };
}
