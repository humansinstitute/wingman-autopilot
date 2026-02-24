/**
 * Nostr Trigger Listener
 *
 * Subscribes to Nostr relays for kind 9256 events addressed to per-user bot
 * pubkeys. Decrypts NIP-44 payloads and dispatches matching scheduler jobs.
 *
 * Lifecycle: subscribe() when a bot key is unlocked in memory,
 * unsubscribe() when cleared (last session stops). shutdown() on process exit.
 *
 * Follows the task-listener.ts dedup pattern (Set-based, cull at 500/1000).
 */

import { nip44, SimplePool, verifyEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";

import type { SchedulerStore, ScheduledJob } from "../scheduler/scheduler-store";

// ============================================================
// Types
// ============================================================

export interface TriggerListenerDeps {
  schedulerStore: SchedulerStore;
  relays: string[];
  onTriggerMatched: (job: ScheduledJob, message: string) => Promise<void>;
}

interface BotSubscription {
  ownerNpub: string;
  botPubkeyHex: string;
  cleanup: () => void;
}

interface TriggerPayload {
  type: "trigger";
  trigger_id: string;
  message?: string;
}

// ============================================================
// Helpers
// ============================================================

function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") throw new Error(`Expected npub, got ${decoded.type}`);
  return decoded.data as string;
}

function isValidTriggerPayload(parsed: unknown): parsed is TriggerPayload {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return (
    obj.type === "trigger" &&
    typeof obj.trigger_id === "string" &&
    obj.trigger_id.length > 0
  );
}

// ============================================================
// Listener
// ============================================================

function createTriggerListener(deps: TriggerListenerDeps) {
  const subscriptions = new Map<string, BotSubscription>();
  const pool = new SimplePool();

  // Shared dedup set across all subscriptions
  const processedEvents = new Set<string>();

  function cullDedup(): void {
    if (processedEvents.size > 1000) {
      const entries = [...processedEvents];
      entries.slice(0, 500).forEach((id) => processedEvents.delete(id));
    }
  }

  /**
   * Start listening for kind 9256 events addressed to a specific bot pubkey.
   * Call this when a bot key is unlocked in memory.
   */
  function subscribe(
    ownerNpub: string,
    botSecretKey: Uint8Array,
    botPubkeyHex: string,
  ): void {
    // Already subscribed for this user
    if (subscriptions.has(ownerNpub)) return;

    if (deps.relays.length === 0) {
      console.warn("[trigger-listener] No relays configured, skipping subscription");
      return;
    }

    let ownerPubkeyHex: string;
    try {
      ownerPubkeyHex = npubToHex(ownerNpub);
    } catch {
      console.error(`[trigger-listener] Invalid owner npub: ${ownerNpub.slice(0, 20)}…`);
      return;
    }

    const since = Math.floor(Date.now() / 1000);

    console.log(
      `[trigger-listener] Subscribing for bot ${botPubkeyHex.slice(0, 12)}… (owner: ${ownerNpub.slice(0, 20)}…) on ${deps.relays.length} relays: ${deps.relays.join(", ")}`,
    );
    console.log(
      `[trigger-listener] Filter: kinds=[9256], #p=[${botPubkeyHex}], since=${since} (${new Date(since * 1000).toISOString()})`,
    );

    const sub = pool.subscribe(
      deps.relays,
      { kinds: [9256], "#p": [botPubkeyHex], since },
      {
        onevent(event) {
          console.log(
            `[trigger-listener] Received kind 9256 event ${event.id.slice(0, 12)}… from ${event.pubkey.slice(0, 12)}… (created_at: ${new Date(event.created_at * 1000).toISOString()})`,
          );

          // Dedup across relays
          if (processedEvents.has(event.id)) {
            console.log(`[trigger-listener] Skipping duplicate event ${event.id.slice(0, 12)}…`);
            return;
          }
          processedEvents.add(event.id);
          cullDedup();

          // Verify event signature
          if (!verifyEvent(event)) {
            console.warn("[trigger-listener] Invalid signature, ignoring event");
            return;
          }

          // Authorization: only the bot's owner can trigger
          if (event.pubkey !== ownerPubkeyHex) {
            console.warn(
              `[trigger-listener] Unauthorized sender ${event.pubkey.slice(0, 12)}… (expected owner ${ownerPubkeyHex.slice(0, 12)}…)`,
            );
            return;
          }

          console.log(`[trigger-listener] Auth OK — decrypting NIP-44 payload…`);

          // Decrypt NIP-44 content
          let payload: TriggerPayload;
          try {
            const conversationKey = nip44.v2.utils.getConversationKey(
              botSecretKey,
              event.pubkey,
            );
            const decrypted = nip44.v2.decrypt(event.content, conversationKey);
            const parsed = JSON.parse(decrypted);
            console.log(`[trigger-listener] Decrypted payload: trigger_id=${(parsed as any)?.trigger_id}, type=${(parsed as any)?.type}`);

            if (!isValidTriggerPayload(parsed)) {
              console.warn("[trigger-listener] Invalid payload shape, ignoring");
              return;
            }
            payload = parsed;
          } catch (err) {
            console.error("[trigger-listener] Failed to decrypt/parse event:", err);
            return;
          }

          // Look up job by trigger_id
          const job = deps.schedulerStore.getJob(payload.trigger_id);
          if (!job) {
            console.warn(`[trigger-listener] No job found for trigger_id=${payload.trigger_id}`);
            const allJobs = deps.schedulerStore.listJobs();
            console.warn(`[trigger-listener] Known jobs (${allJobs.length}): ${allJobs.map(j => `${j.id} (${j.triggerType})`).join(", ")}`);
            return;
          }

          // Validate: job belongs to the owner, is a nostr trigger, and is enabled
          if (job.userNpub !== ownerNpub) {
            console.warn(`[trigger-listener] Job ${job.id} does not belong to sender (job owner: ${job.userNpub})`);
            return;
          }
          if (job.triggerType !== "nostr") {
            console.warn(`[trigger-listener] Job ${job.id} is not a nostr trigger (type: ${job.triggerType})`);
            return;
          }
          if (!job.enabled) {
            console.warn(`[trigger-listener] Job ${job.id} is disabled, ignoring`);
            return;
          }

          console.log(
            `[trigger-listener] Trigger matched: job "${job.name}" (${job.id}) ` +
            `${payload.message ? `with message: "${payload.message.slice(0, 80)}…"` : "(no message)"}`,
          );

          deps.onTriggerMatched(job, payload.message ?? "").catch((err) => {
            console.error(`[trigger-listener] Failed to execute trigger:`, err);
          });
        },
        oneose() {
          console.log(
            `[trigger-listener] EOSE — connected to relays for bot ${botPubkeyHex.slice(0, 12)}…, listening for new events`,
          );
        },
        onclose(reason) {
          if (!reason) return;
          const text = String(reason);
          if (text.includes("auth-required")) {
            console.warn(`[trigger-listener] Relay requested auth for bot ${botPubkeyHex.slice(0, 12)}…: ${text}`);
            return;
          }
          if (text.includes("closed by caller")) return;
          console.warn(`[trigger-listener] Relay subscription closed for bot ${botPubkeyHex.slice(0, 12)}…: ${text}`);
        },
      },
    );

    subscriptions.set(ownerNpub, {
      ownerNpub,
      botPubkeyHex,
      cleanup: () => {
        sub.close();
      },
    });
  }

  /**
   * Stop listening for a specific user's bot key.
   * Call this when a bot key is cleared from memory.
   */
  function unsubscribe(ownerNpub: string): void {
    const entry = subscriptions.get(ownerNpub);
    if (entry) {
      console.log(
        `[trigger-listener] Unsubscribing bot ${entry.botPubkeyHex.slice(0, 12)}…`,
      );
      entry.cleanup();
      subscriptions.delete(ownerNpub);
    }
  }

  /**
   * Shut down all subscriptions and close the relay pool.
   */
  function shutdown(): void {
    for (const [npub, entry] of subscriptions) {
      entry.cleanup();
      subscriptions.delete(npub);
    }
    pool.close(deps.relays);
    console.log("[trigger-listener] Shut down");
  }

  return { subscribe, unsubscribe, shutdown };
}

export { createTriggerListener };
export type TriggerListener = ReturnType<typeof createTriggerListener>;
