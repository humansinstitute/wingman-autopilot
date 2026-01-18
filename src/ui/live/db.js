/**
 * Dexie database for persistent live session data.
 * Stores messages and session state in IndexedDB.
 */

import Dexie from "/vendor/dexie/dexie.mjs";

// Create database instance
export const db = new Dexie("WingmanLive");

// Define schema
// Version 1: Initial schema with messages and sessions tables
db.version(1).stores({
  // Messages table
  // Primary key: auto-increment id
  // Indexes: sessionId, compound [sessionId+createdAt] for ordered queries, messageHash for dedup
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  // Sessions table for status caching
  sessions: "id, status, updatedAt",
});

/**
 * Generate a hash for message deduplication.
 * Uses sessionId, role, createdAt, and first 100 chars of content.
 */
const hashMessage = (sessionId, role, content, createdAt) => {
  return `${sessionId}:${role}:${createdAt}:${content.slice(0, 100)}`;
};

/**
 * Message store operations.
 */
export const MessageStore = {
  /**
   * Upsert a message (insert or update if exists).
   * Handles streaming updates where content changes but message identity stays same.
   */
  async upsertMessage(sessionId, message) {
    const role = message.role || message.type || "assistant";
    const content = message.content || message.message || "";
    const createdAt = message.createdAt || message.created_at || new Date().toISOString();

    const messageHash = hashMessage(sessionId, role, content, createdAt);

    // Check for existing message with same hash (streaming update)
    const existing = await db.messages.where("messageHash").equals(messageHash).first();

    if (existing) {
      // Update content for streaming (content might have grown)
      if (content.length > existing.content.length) {
        await db.messages.update(existing.id, {
          content,
          updatedAt: new Date().toISOString(),
        });
      }
      return existing.id;
    }

    // Insert new message
    return db.messages.add({
      sessionId,
      role,
      content,
      createdAt,
      updatedAt: new Date().toISOString(),
      messageHash,
    });
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
   * Sync messages from server (initial load or refresh).
   * Performs bulk upsert within a transaction.
   */
  async syncFromServer(sessionId, messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    await db.transaction("rw", db.messages, async () => {
      for (const msg of messages) {
        await this.upsertMessage(sessionId, msg);
      }
    });
  },

  /**
   * Subscribe to message changes for a session.
   * Returns an observable-like object with subscribe method.
   * Uses Dexie's liveQuery under the hood.
   */
  liveQuery(sessionId) {
    // Return a function that creates the live query when called
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
   * Get session status.
   */
  async getSession(sessionId) {
    return db.sessions.get(sessionId);
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
 * Database utilities.
 */
export const DbUtils = {
  /**
   * Clear all data from the database.
   */
  async clearAll() {
    await db.messages.clear();
    await db.sessions.clear();
  },

  /**
   * Get database statistics.
   */
  async getStats() {
    const messageCount = await db.messages.count();
    const sessionCount = await db.sessions.count();
    return { messageCount, sessionCount };
  },

  /**
   * Export all data (for debugging).
   */
  async exportAll() {
    const messages = await db.messages.toArray();
    const sessions = await db.sessions.toArray();
    return { messages, sessions };
  },
};

// Re-export Dexie for liveQuery usage
export { Dexie };
