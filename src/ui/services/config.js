/**
 * Config API client - pure HTTP wrappers for configuration endpoints.
 * These functions handle HTTP requests and return parsed data.
 * State and UI updates should be handled by the caller.
 */

import { DEFAULT_CONNECT_RELAYS } from "../state/index.js";

/**
 * Normalizes connect relay configuration.
 * @param {string | string[] | null | undefined} candidate - Relay input
 * @returns {string[]} Normalized array of relay URLs
 */
export function normaliseConnectRelays(candidate) {
  if (!candidate) return [...DEFAULT_CONNECT_RELAYS];
  const values = Array.isArray(candidate) ? candidate : String(candidate).split(",");
  const cleaned = values
    .map((value) => (value && typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) {
    return [...DEFAULT_CONNECT_RELAYS];
  }
  return Array.from(new Set(cleaned));
}

/**
 * Fetches the application configuration from the server.
 * @returns {Promise<Object>} Configuration data
 */
export async function fetchConfigApi() {
  const response = await fetch("/api/config");
  return response.json();
}

/**
 * Fetches the current restart status.
 * @returns {Promise<Object>} Restart status data
 */
export async function fetchRestartStatusApi() {
  const response = await fetch("/api/system/restart");
  if (!response.ok) {
    throw new Error(response.statusText || "Failed to fetch restart status");
  }
  return response.json();
}

/**
 * Triggers a warm restart of the system.
 * @returns {Promise<Object>} Restart response
 * @throws {Error} If the request fails
 */
export async function triggerWarmRestartApi() {
  const response = await fetch("/api/system/restart", { method: "POST" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : response.statusText || "Failed to initiate restart";
    throw new Error(message);
  }
  return payload;
}

/**
 * Triggers system cleanup (stops all sessions and apps).
 * @returns {Promise<Object>} Cleanup result
 * @throws {Error} If the request fails
 */
export async function runSystemCleanupApi() {
  const response = await fetch("/api/system/cleanup", { method: "POST" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : response.statusText || "Failed to stop agents and apps";
    throw new Error(message);
  }
  if (!payload || typeof payload !== "object" || typeof payload.timestamp !== "string") {
    throw new Error("Unexpected cleanup response");
  }
  return payload;
}
