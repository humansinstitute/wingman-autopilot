import { TextEncoder } from "node:util";

let cachedSecret: Uint8Array | null = null;

const encoder = new TextEncoder();

export const getSessionSecretBytes = (): Uint8Array => {
  if (cachedSecret) {
    return cachedSecret;
  }

  const source =
    (Bun.env.IDENTITY_SESSION_SECRET ?? "").trim() ||
    (Bun.env.SESSION_SECRET ?? "").trim() ||
    (Bun.env.COOKIE_SECRET ?? "").trim();

  if (!source) {
    throw new Error("IDENTITY_SESSION_SECRET (or SESSION_SECRET/COOKIE_SECRET) must be configured");
  }

  cachedSecret = encoder.encode(source);
  return cachedSecret;
};
