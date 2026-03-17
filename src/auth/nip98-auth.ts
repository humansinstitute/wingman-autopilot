import type { RequestAuthContext } from "./request-context";

interface ResolveNip98AuthOptions {
  verifyNip98AuthHeader: (request: Request, url: URL) => string | null;
  lookupBotOwnerNpub?: (botNpub: string) => string | null;
}

/**
 * Resolve internal Wingman API auth from a verified NIP-98 signer.
 *
 * For bot-signed requests, the effective auth identity becomes the mapped
 * owner user while preserving the bot signer in actorNpub for audit/debugging.
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
  if (ownerNpub) {
    return {
      ...authContext,
      npub: ownerNpub,
      actorNpub: signerNpub,
      session: null,
      authMethod: "nip98",
      delegatedByBot: true,
    };
  }

  return {
    ...authContext,
    npub: signerNpub,
    actorNpub: signerNpub,
    session: null,
    authMethod: "nip98",
    delegatedByBot: false,
  };
}
