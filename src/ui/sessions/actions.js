/**
 * Session action handlers.
 *
 * Thin wrappers that call session APIs and sync changes to Dexie.
 * After each action the sessions Alpine store is synced so the liveQuery
 * fires and Alpine reactivity updates the DOM.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { ApiSessionStore } from "../live/db.js";
import {
  stopSessionApi,
  deleteSessionApi,
  updateSessionNameApi,
  resumeNativeSessionApi,
  forkSessionToWorktreeApi,
} from "../services/sessions.js";

/** Get the sessions store (safe to call after Alpine.start). */
function getStore() {
  return Alpine.store("sessions");
}

/**
 * Stop a running session.
 * @returns {{ success: boolean, error?: string }}
 */
export async function stopSession(sessionId) {
  const result = await stopSessionApi(sessionId);
  if (result.success) {
    await getStore().sync();
  }
  return result;
}

/**
 * Delete a session and remove it from Dexie cache.
 * @returns {{ success: boolean, error?: string }}
 */
export async function deleteSession(sessionId) {
  const result = await deleteSessionApi(sessionId);
  if (result.success) {
    await ApiSessionStore.remove(sessionId);
    await getStore().sync();
  }
  return result;
}

/**
 * Rename a session.
 * @returns {Promise<*>} API response
 */
export async function renameSession(sessionId, name) {
  const result = await updateSessionNameApi(sessionId, name);
  await getStore().sync();
  return result;
}

/**
 * Start a new Wingman session from a stored native agent session id.
 * @returns {Promise<*>} API response with { session }
 */
export async function resumeNativeSession(sessionId) {
  const result = await resumeNativeSessionApi(sessionId);
  await getStore().sync();
  return result;
}

/**
 * Fork a session to a new git worktree.
 * @returns {Promise<*>} API response with { session, worktreePath, initialPrompt }
 */
export async function forkToWorktree(sessionId, branch, messageCount = 5) {
  const result = await forkSessionToWorktreeApi(sessionId, branch, messageCount);
  // New session is created server-side — sync to pick it up
  await getStore().sync();
  return result;
}
