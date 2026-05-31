import { nip19 } from "nostr-tools";

import {
  syncSuperbasedPlaintextRecords,
  type SuperbasedApiDependencies,
  type SuperbasedSyncPlaintextResult,
} from "../superbased/superbased-api";
import type { WappRecord } from "./types";

export interface FlightDeckWappRecordPayload {
  app_namespace: string;
  collection_space: "wapp";
  schema_version: 1;
  record_id: string;
  data: {
    title: string;
    description: string | null;
    owner_npub: string;
    wapp_id: string;
    app_id: string;
    launch_url: string;
    source_wingman_url: string | null;
    workspace_owner_npub: string;
    scope_id: string;
    scope_l1_id: string | null;
    scope_l2_id: string | null;
    scope_l3_id: string | null;
    scope_l4_id: string | null;
    scope_l5_id: string | null;
    status: string;
    schedule: {
      timezone?: string | null;
      starts_at?: string | null;
      ends_at?: string | null;
      windows?: Array<{
        days?: number[];
        start_time: string;
        end_time: string;
      }>;
    } | null;
    record_state: string;
  };
  encrypt_to_npubs: string[];
}

export function buildFlightDeckWappRecordPayload(
  wapp: WappRecord,
  appNamespace: string,
): FlightDeckWappRecordPayload {
  return {
    app_namespace: appNamespace,
    collection_space: "wapp",
    schema_version: 1,
    record_id: wapp.id,
    data: {
      title: wapp.title,
      description: wapp.description,
      owner_npub: wapp.ownerNpub,
      wapp_id: wapp.id,
      app_id: wapp.appId,
      launch_url: wapp.launchUrl,
      source_wingman_url: wapp.sourceWingmanUrl,
      workspace_owner_npub: wapp.workspaceOwnerNpub,
      scope_id: wapp.scopeId,
      scope_l1_id: wapp.scopeLineage.l1Id,
      scope_l2_id: wapp.scopeLineage.l2Id,
      scope_l3_id: wapp.scopeLineage.l3Id,
      scope_l4_id: wapp.scopeLineage.l4Id,
      scope_l5_id: wapp.scopeLineage.l5Id,
      status: wapp.status,
      schedule: wapp.schedule
        ? {
          timezone: wapp.schedule.timezone ?? null,
          starts_at: wapp.schedule.startsAt ?? null,
          ends_at: wapp.schedule.endsAt ?? null,
          windows: wapp.schedule.windows?.map((window) => ({
            days: window.days,
            start_time: window.startTime,
            end_time: window.endTime,
          })) ?? [],
        }
        : null,
      record_state: wapp.recordState,
    },
    encrypt_to_npubs: wapp.allowedNpubs,
  };
}

export interface WappPublisher {
  publish(payload: FlightDeckWappRecordPayload): Promise<{
    published: boolean;
    reference?: string | null;
    error?: string | null;
    status?: number;
  }>;
}

export type SuperbasedSyncRecords = (
  deps: SuperbasedApiDependencies,
  input: {
    owner_pubkey: string;
    records: Array<{
      record_id: string;
      collection: string;
      plaintext_payload: string;
      delegate_pubkeys: string[];
    }>;
    user_npub?: string;
  },
) => Promise<SuperbasedSyncPlaintextResult>;

function npubToPubkeyHex(npub: string): string | null {
  const trimmed = npub.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === "npub" && typeof decoded.data === "string" ? decoded.data : null;
  } catch {
    return null;
  }
}

export class SuperbasedWappPublisher implements WappPublisher {
  constructor(
    private readonly deps: SuperbasedApiDependencies,
    private readonly syncRecords: SuperbasedSyncRecords = syncSuperbasedPlaintextRecords,
  ) {}

  async publish(payload: FlightDeckWappRecordPayload): Promise<{
    published: boolean;
    reference?: string | null;
    error?: string | null;
    status?: number;
  }> {
    if (!this.deps.defaultBaseUrl) {
      return {
        published: false,
        error: "wapp-publish-transport-unavailable",
        status: 503,
      };
    }

    const ownerPubkey = npubToPubkeyHex(payload.data.workspace_owner_npub);
    if (!ownerPubkey) {
      return {
        published: false,
        error: "wapp-publish-invalid-workspace-owner",
        status: 400,
      };
    }

    const delegatePubkeys = Array.from(
      new Set(
        payload.encrypt_to_npubs
          .map(npubToPubkeyHex)
          .filter((pubkey): pubkey is string => Boolean(pubkey && pubkey !== ownerPubkey)),
      ),
    ).sort();

    try {
      const result = await this.syncRecords(this.deps, {
        owner_pubkey: ownerPubkey,
        user_npub: payload.data.owner_npub,
        records: [{
          record_id: payload.record_id,
          collection: payload.collection_space,
          plaintext_payload: JSON.stringify(payload),
          delegate_pubkeys: delegatePubkeys,
        }],
      });
      const reference = result.synced[0]
        ? `superbased:${result.synced[0].record_id}:v${result.synced[0].version}`
        : `superbased:${payload.record_id}`;
      return { published: true, reference };
    } catch (error) {
      return {
        published: false,
        error: (error as Error).message,
        status: 502,
      };
    }
  }
}
