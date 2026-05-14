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
      record_state: wapp.recordState,
    },
    encrypt_to_npubs: wapp.allowedNpubs,
  };
}

export interface WappPublisher {
  publish(payload: FlightDeckWappRecordPayload): Promise<{ published: boolean; reference?: string | null }>;
}

export class LocalPayloadWappPublisher implements WappPublisher {
  async publish(payload: FlightDeckWappRecordPayload): Promise<{ published: boolean; reference: string }> {
    return { published: false, reference: `local-payload:${payload.record_id}` };
  }
}
