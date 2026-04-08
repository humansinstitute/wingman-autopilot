import type { RequestAuthContext } from "./request-context";

interface ResolveNip98AuthOptions {
  verifyNip98AuthHeader: (request: Request, url: URL) => string | null;
  lookupBotOwnerNpub?: (botNpub: string) => string | null;
}

/**
 * Resolve internal Wingman API auth from a verified NIP-98 signer.
 *
 * NIP-98 requests always preserve the signer as the effective caller.
 * Legacy bot-owner lookups are retained only as advisory delegation metadata.
 */
export function resolveNip98AuthContext(
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
  options: ResolveNip98AuthOptions,
): RequestAuthContext {
  if (authContext.session) {
    return authContext;
  }

  const signerNpub = options.verifyNip98AuthHeader(request, url);
  if (!signerNpub) {
    return authContext;
  }

  const ownerNpub = options.lookupBotOwnerNpub?.(signerNpub) ?? null;

  return {
    ...authContext,
    npub: signerNpub,
    actorNpub: signerNpub,
    signerNpub,
    subjectNpub: signerNpub,
    targetOwnerNpub: signerNpub,
    delegatedOwnerNpub: ownerNpub,
    delegateRelationshipId: authContext.delegateRelationshipId ?? null,
    delegateScopes: authContext.delegateScopes ?? null,
    session: null,
    authMethod: "nip98",
    delegatedByBot: Boolean(ownerNpub),
  };
}
