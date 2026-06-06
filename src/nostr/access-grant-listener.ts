import { SimplePool, nip19 } from 'nostr-tools';

import {
  SBIP0009_ACCESS_GRANT_KIND,
  SBIP0009_ONBOARDING_PROTOCOL,
  type AccessGrantSubscriptionManager,
  processAccessGrantEvent,
} from '../access-grants/sbip0009';

export interface AccessGrantListener {
  subscribe(managedByNpub: string, recipientSecretKey: Uint8Array, recipientPubkeyHex: string): void;
  unsubscribe(recipientPubkeyHex: string): void;
  shutdown(): void;
}

export interface AccessGrantListenerDeps {
  relays: string[];
  subscriptionManager: AccessGrantSubscriptionManager;
}

export function createAccessGrantListener(deps: AccessGrantListenerDeps): AccessGrantListener {
  const pool = new SimplePool();
  const subscriptions = new Map<string, { close: () => void }>();
  const processedKeys = new Set<string>();

  function recipientNpubFromHex(pubkeyHex: string): string {
    return nip19.npubEncode(pubkeyHex);
  }

  return {
    subscribe(managedByNpub, recipientSecretKey, recipientPubkeyHex) {
      const normalizedHex = recipientPubkeyHex.toLowerCase();
      if (subscriptions.has(normalizedHex)) return;
      if (deps.relays.length === 0) {
        console.warn('[onboarding-33357] No relays configured, skipping onboarding subscription');
        return;
      }
      const since = Math.floor(Date.now() / 1000) - 300;
      const recipientNpub = recipientNpubFromHex(normalizedHex);
      const sub = pool.subscribe(
        deps.relays,
        {
          kinds: [SBIP0009_ACCESS_GRANT_KIND],
          '#p': [normalizedHex],
          '#protocol': [SBIP0009_ONBOARDING_PROTOCOL],
          since,
        },
        {
          onevent(event) {
            processAccessGrantEvent({
              event,
              recipientSecretKey,
              recipientNpub,
              managedByNpub,
              subscriptionManager: deps.subscriptionManager,
              processedKeys,
            }).then((result) => {
              const id = event.id?.slice(0, 12) ?? 'unknown';
              if (result.ok) {
                console.log(`[onboarding-33357] ${result.code} for event ${id}`);
              } else {
                console.warn(`[onboarding-33357] ${result.code} for event ${id}: ${result.message}`);
              }
            }).catch((error) => {
              console.error('[onboarding-33357] Failed to process onboarding event:', error);
            });
          },
          oneose() {
            console.log(`[onboarding-33357] Listening for onboarding events for ${normalizedHex.slice(0, 12)}...`);
          },
        },
      );
      subscriptions.set(normalizedHex, { close: () => sub.close() });
    },
    unsubscribe(recipientPubkeyHex) {
      const normalizedHex = recipientPubkeyHex.toLowerCase();
      const sub = subscriptions.get(normalizedHex);
      if (!sub) return;
      sub.close();
      subscriptions.delete(normalizedHex);
    },
    shutdown() {
      for (const sub of subscriptions.values()) sub.close();
      subscriptions.clear();
      pool.close(deps.relays);
    },
  };
}
