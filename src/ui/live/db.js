/**
 * Dexie database for persistent live session data.
 * Stores messages and session state in IndexedDB.
 */

import Dexie from "/vendor/dexie/dexie.mjs";
import {
  areConversationMessagesEqual,
  normalizeConversationMessage,
  normalizeConversationMessages,
} from "./conversation-sync.js";

// Create database instance
export const db = new Dexie("WingmanLive");

// Define schema
// Version 1: Initial schema with messages and sessions tables
db.version(1).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
});

// Version 2: Add apiSessions (full session objects from /api/sessions) and apps tables
db.version(2).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt",
  apps: "id, label, updatedAt",
});

// Version 3: Add targetFile index to apiSessions for writer-mode lookups
db.version(3).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
});

/**
 * Message store operations.
 *
 * Messages are identified by session + position index (messageIdx).
 * Streaming updates grow the content of the last message in-place
 * rather than inserting duplicates.
 */
export const MessageStore = {
  /**
   * Upsert a single SSE message.
   * For streaming, the server re-sends the last message with growing content.
   * We find the last message for this session+role and update it in-place
   * when the new content is a longer version of the existing content.
   */
  async upsertMessage(sessionId, message) {
    const normalized = normalizeConversationMessage(message);
    const role = normalized.role;
    const content = normalized.content;
    const createdAt = normalized.createdAt;
    const now = new Date().toISOString();

    const matchingTimestampMessages = createdAt
      ? await db.messages
          .where("[sessionId+createdAt]")
          .equals([sessionId, createdAt])
          .toArray()
      : [];
    const matchingMessage = [...matchingTimestampMessages]
      .reverse()
      .find((entry) => entry.role === role);

    if (matchingMessage) {
      await db.messages.update(matchingMessage.id, {
        content,
        speech: normalized.speech ?? null,
        updatedAt: now,
      });
      return { id: matchingMessage.id, isStreamingUpdate: true };
    }

    // Find the last message for this session
    const existing = await db.messages
      .where("sessionId").equals(sessionId)
      .last();

    // Streaming update: same role and new content extends the old content
    if (existing && existing.role === role) {
      const oldContent = existing.content || "";
      if (content.length > oldContent.length && content.startsWith(oldContent.slice(0, 50))) {
        await db.messages.update(existing.id, {
          content,
          speech: normalized.speech ?? null,
          updatedAt: now,
        });
        return { id: existing.id, isStreamingUpdate: true };
      }
    }

    // New message
    const id = await db.messages.add({
      sessionId,
      role,
      content,
      speech: normalized.speech ?? null,
      createdAt,
      updatedAt: now,
      messageHash: `${sessionId}:${role}:${Date.now()}`,
    });
    return { id, isStreamingUpdate: false };
  },

  /**
   * Get all messages for a session, ordered by createdAt.
   */
  async getSessionMessages(sessionId) {
    return db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
      .toArray();
  },

  /**
   * Get message count for a session.
   */
  async getMessageCount(sessionId) {
    return db.messages.where("sessionId").equals(sessionId).count();
  },

  /**
   * Clear all messages for a session.
   */
  async clearSession(sessionId) {
    return db.messages.where("sessionId").equals(sessionId).delete();
  },

  /**
   * Sync full conversation from server (initial load or refresh).
   * Updates existing messages in-place (preserving Dexie IDs so Alpine
   * `:key` stays stable) and only adds/removes rows when the count changes.
   */
  async syncFromServer(sessionId, messages) {
    if (!Array.isArray(messages)) return;

    await db.transaction("rw", db.messages, async () => {
      const existing = await db.messages
        .where("[sessionId+createdAt]")
        .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
        .toArray();

      const now = new Date().toISOString();
      const incoming = normalizeConversationMessages(messages, now);

      // Update existing rows in-place where content changed
      const updates = [];
      const minLen = Math.min(existing.length, incoming.length);
      for (let i = 0; i < minLen; i++) {
        const old = existing[i];
        const inc = incoming[i];
        if (
          old.content === inc.content &&
          old.role === inc.role &&
          JSON.stringify(old.speech ?? null) === JSON.stringify(inc.speech ?? null)
        ) {
          continue;
        }
        // Don't let a momentarily-stale server snapshot shrink a bubble that the
        // SSE stream has already grown further. A streamed assistant turn only
        // ever grows, so when the incoming content is a prefix of what we already
        // have for the same role, keep the longer local copy.
        const isStreamingShrink =
          old.role === inc.role &&
          inc.content.length < (old.content || "").length &&
          (old.content || "").startsWith(inc.content);
        if (isStreamingShrink) {
          continue;
        }
        updates.push(
          db.messages.update(old.id, {
            content: inc.content,
            role: inc.role,
            speech: inc.speech ?? null,
            updatedAt: now,
          }),
        );
      }

      // Remove extras if server has fewer messages
      if (existing.length > incoming.length) {
        const idsToDelete = existing.slice(incoming.length).map((m) => m.id);
        updates.push(db.messages.bulkDelete(idsToDelete));
      }

      // Add new messages if server has more
      if (incoming.length > existing.length) {
        const newRows = incoming.slice(existing.length).map((inc, idx) => ({
          sessionId,
          role: inc.role,
          content: inc.content,
          speech: inc.speech ?? null,
          createdAt: inc.createdAt,
          updatedAt: now,
          messageHash: `${sessionId}:${existing.length + idx}:${now}`,
        }));
        updates.push(db.messages.bulkAdd(newRows));
      }

      await Promise.all(updates);
    });
  },

  /**
   * Sync a full conversation only when the canonical message rows changed.
   * Returns the canonical messages plus a changed flag so callers can skip
   * redundant DOM work after no-op refreshes.
   */
  async syncFromServerIfChanged(sessionId, messages) {
    const normalized = normalizeConversationMessages(messages);
    const existing = await this.getSessionMessages(sessionId);

    if (areConversationMessagesEqual(existing, normalized)) {
      return {
        changed: false,
        messages: existing,
      };
    }

    await this.syncFromServer(sessionId, normalized);
    return {
      changed: true,
      messages: normalized,
    };
  },

  /**
   * Subscribe to message changes for a session.
   * Returns a function for Dexie's liveQuery.
   */
  liveQuery(sessionId) {
    return () => this.getSessionMessages(sessionId);
  },
};

/**
 * Session store operations.
 */
export const SessionStore = {
  /**
   * Update session status.
   */
  async updateStatus(sessionId, status, agentRuntimeStatus = null) {
    return db.sessions.put({
      id: sessionId,
      status,
      agentRuntimeStatus: agentRuntimeStatus || status,
      updatedAt: new Date().toISOString(),
    });
  },

  /**
   * Patch a cached session status record in-place.
   */
  async patchSession(sessionId, updates) {
    if (!sessionId || !updates || typeof updates !== "object") {
      return null;
    }

    const existing = await db.sessions.get(sessionId);
    const next = {
      ...(existing ?? { id: sessionId }),
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await db.sessions.put(next);
    return next;
  },

  /**
   * Get session status.
   */
  async getSession(sessionId) {
    return db.sessions.get(sessionId);
  },

  /**
   * Subscribe to a single session status record.
   */
  liveQuery(sessionId) {
    return () => this.getSession(sessionId);
  },

  /**
   * Check if session is busy (running).
   */
  async isBusy(sessionId) {
    const session = await this.getSession(sessionId);
    return session?.agentRuntimeStatus === "running" || session?.status === "running";
  },

  /**
   * Clear session status.
   */
  async clearSession(sessionId) {
    return db.sessions.delete(sessionId);
  },
};

/**
 * API session store operations.
 * Caches full session objects from /api/sessions for instant page loads.
 */
export const ApiSessionStore = {
  /** Get all cached API sessions. */
  async getAll() {
    return db.apiSessions.toArray();
  },

  /** Bulk upsert sessions from API response. Replaces cache with server truth. */
  async upsertMany(sessions) {
    if (!Array.isArray(sessions)) return;
    await db.transaction("rw", db.apiSessions, async () => {
      await db.apiSessions.clear();
      if (sessions.length > 0) {
        await db.apiSessions.bulkPut(
          sessions.map((s) => ({ ...s, updatedAt: new Date().toISOString() })),
        );
      }
    });
  },

  /** Get a single session by id. */
  async getById(id) {
    return db.apiSessions.get(id);
  },

  /**
   * Patch a cached API session in-place without replacing the full table.
   */
  async patchSession(id, updates) {
    if (!id || !updates || typeof updates !== "object") {
      return null;
    }

    const existing = await db.apiSessions.get(id);
    if (!existing) {
      return null;
    }

    const next = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await db.apiSessions.put(next);
    return next;
  },

  /** Remove a single session by id. */
  async remove(id) {
    return db.apiSessions.delete(id);
  },

  /** Clear all cached sessions. */
  async clear() {
    return db.apiSessions.clear();
  },
};

/**
 * Apps table operations.
 * Caches full app objects from /api/apps for instant page loads.
 */
export const AppsTable = {
  /** Get all cached apps. */
  async getAll() {
    return db.apps.toArray();
  },

  /** Bulk upsert apps from API response. Replaces cache with server truth. */
  async upsertMany(apps) {
    if (!Array.isArray(apps) || apps.length === 0) return;
    await db.transaction("rw", db.apps, async () => {
      await db.apps.clear();
      await db.apps.bulkPut(
        apps.map((a) => ({ ...a, updatedAt: new Date().toISOString() })),
      );
    });
  },

  /** Get a single app by id. */
  async getById(id) {
    return db.apps.get(id);
  },

  /** Remove a single app by id. */
  async remove(id) {
    return db.apps.delete(id);
  },

  /** Clear all cached apps. */
  async clear() {
    return db.apps.clear();
  },
};

/**
 * Database utilities.
 */
export const DbUtils = {
  /**
   * Clear all data from the database.
   */
  async clearAll() {
    await db.messages.clear();
    await db.sessions.clear();
    await db.apiSessions.clear();
    await db.apps.clear();
  },

  /**
   * Get database statistics.
   */
  async getStats() {
    const [messageCount, sessionCount, apiSessionCount, appCount] = await Promise.all([
      db.messages.count(),
      db.sessions.count(),
      db.apiSessions.count(),
      db.apps.count(),
    ]);
    return { messageCount, sessionCount, apiSessionCount, appCount };
  },

  /**
   * Export all data (for debugging).
   */
  async exportAll() {
    const [messages, sessions, apiSessions, apps] = await Promise.all([
      db.messages.toArray(),
      db.sessions.toArray(),
      db.apiSessions.toArray(),
      db.apps.toArray(),
    ]);
    return { messages, sessions, apiSessions, apps };
  },
};

// Re-export Dexie for liveQuery usage
export { Dexie };
