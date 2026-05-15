export interface WappScopeLineage {
  scopeId: string;
  l1Id: string | null;
  l2Id: string | null;
  l3Id: string | null;
  l4Id: string | null;
  l5Id: string | null;
}

export type WappRecordState = "active" | "archived" | "deleted";

export interface WappRecord {
  id: string;
  appId: string;
  title: string;
  description: string | null;
  ownerNpub: string;
  createdByNpub: string;
  workspaceOwnerNpub: string;
  scopeId: string;
  scopeLineage: WappScopeLineage;
  allowedNpubs: string[];
  launchUrl: string;
  sourceWingmanUrl: string | null;
  subdomainAlias: string | null;
  recordState: WappRecordState;
  createdAt: string;
  updatedAt: string;
  lastPublishedAt: string | null;
}

export interface CreateWappInput {
  id?: string;
  appId: string;
  title: string;
  description?: string | null;
  ownerNpub: string;
  createdByNpub: string;
  workspaceOwnerNpub: string;
  scopeId: string;
  scopeLineage?: Partial<WappScopeLineage> | null;
  allowedNpubs: string[];
  launchUrl: string;
  sourceWingmanUrl?: string | null;
  subdomainAlias?: string | null;
}

export interface UpdateWappInput {
  title?: string;
  description?: string | null;
  workspaceOwnerNpub?: string;
  scopeId?: string;
  scopeLineage?: Partial<WappScopeLineage> | null;
  allowedNpubs?: string[];
  launchUrl?: string;
  sourceWingmanUrl?: string | null;
  subdomainAlias?: string | null;
  recordState?: WappRecordState;
  lastPublishedAt?: string | null;
}
