/**
 * Task Listener
 *
 * Subscribes to Nostr relays for kind 9802 events addressed to Wingman's pubkey.
 * Decrypts NIP-44 encrypted payloads and dispatches task assignments.
 */

import { nip44, SimplePool, verifyEvent } from "nostr-tools";

// ============================================================
// Types
// ============================================================

export interface TaskAssignment {
  taskUrl: string;
  taskId: number;
  teamSlug: string;
  title: string;
  description: string;
  workingDirectory?: string;
}

export interface TaskListenerDeps {
  secretKey: Uint8Array;
  pubkeyHex: string;
  relays: string[];
  onTaskAssigned: (task: TaskAssignment) => Promise<void>;
}

// ============================================================
// Main
// ============================================================

export function startTaskListener(deps: TaskListenerDeps): () => void {
  const { secretKey, pubkeyHex, relays, onTaskAssigned } = deps;

  if (relays.length === 0) {
    console.warn("[task-listener] No relays configured, skipping");
    return () => {};
  }

  const pool = new SimplePool();
  const since = Math.floor(Date.now() / 1000);

  // Dedup: same event arrives once per relay
  const processedEvents = new Set<string>();

  console.log(`[task-listener] Subscribing to ${relays.length} relays for kind 9802 events (pubkey: ${pubkeyHex.slice(0, 12)}...)`);

  const sub = pool.subscribeMany(
    relays,
    { kinds: [9802], "#p": [pubkeyHex], since },
    {
      onevent(event) {
        // Dedup across relays
        if (processedEvents.has(event.id)) return;
        processedEvents.add(event.id);
        if (processedEvents.size > 1000) {
          const entries = [...processedEvents];
          entries.slice(0, 500).forEach((id) => processedEvents.delete(id));
        }

        // Verify event signature
        if (!verifyEvent(event)) {
          console.warn("[task-listener] Received event with invalid signature, ignoring");
          return;
        }

        // Decrypt NIP-44 content
        let payload: TaskAssignment;
        try {
          const conversationKey = nip44.v2.utils.getConversationKey(secretKey, event.pubkey);
          const decrypted = nip44.v2.decrypt(event.content, conversationKey);
          const parsed = JSON.parse(decrypted);

          if (parsed.type !== "task_assigned" || !parsed.taskUrl || !parsed.taskId || !parsed.teamSlug || !parsed.title) {
            console.warn("[task-listener] Received event with invalid payload, ignoring:", parsed.type);
            return;
          }

          payload = {
            taskUrl: parsed.taskUrl,
            taskId: parsed.taskId,
            teamSlug: parsed.teamSlug,
            title: parsed.title,
            description: parsed.description || "",
            workingDirectory: parsed.workingDirectory || undefined,
          };
        } catch (err) {
          console.error("[task-listener] Failed to decrypt/parse event:", err);
          return;
        }

        console.log(`[task-listener] Received task assignment: "${payload.title}" (task ${payload.taskId}, team ${payload.teamSlug})`);

        onTaskAssigned(payload).catch((err) => {
          console.error(`[task-listener] Failed to handle task assignment:`, err);
        });
      },
      oneose() {
        console.log("[task-listener] Connected to relays, listening for task assignments");
      },
    },
  );

  return () => {
    console.log("[task-listener] Shutting down");
    sub.close();
    pool.close(relays);
  };
}
