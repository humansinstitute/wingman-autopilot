import { normaliseNpub } from "../identity/npub-utils";
import type { WappScopeLineage } from "./types";

export interface ScopeAccessInput {
  scopeId: string;
  ownerNpub: string;
  allowedNpubs?: unknown;
  scopeLineage?: Partial<WappScopeLineage> | null;
}

export function normalizeWappScopeLineage(
  scopeId: string,
  input?: Partial<WappScopeLineage> | null,
): WappScopeLineage {
  return {
    scopeId,
    l1Id: input?.l1Id ?? null,
    l2Id: input?.l2Id ?? null,
    l3Id: input?.l3Id ?? null,
    l4Id: input?.l4Id ?? null,
    l5Id: input?.l5Id ?? null,
  };
}

export function normalizeNpubList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = normaliseNpub(typeof value === "string" ? value : null);
    if (normalized) {
      unique.set(normalized, normalized);
    }
  }
  return Array.from(unique.values()).sort();
}

export function resolveWappAllowedNpubs(input: ScopeAccessInput): string[] {
  const owner = normaliseNpub(input.ownerNpub);
  if (!owner) {
    throw new Error("WApp owner npub is required");
  }
  const unique = new Map<string, string>();
  unique.set(owner, owner);
  for (const npub of normalizeNpubList(input.allowedNpubs)) {
    unique.set(npub, npub);
  }
  return Array.from(unique.values()).sort();
}
