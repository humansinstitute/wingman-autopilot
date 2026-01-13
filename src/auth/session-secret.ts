import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TextEncoder } from "node:util";

let cachedSecret: Uint8Array | null = null;

const encoder = new TextEncoder();

const generateSecureSecret = (): string => {
  return randomBytes(48).toString("base64url");
};

const findProjectRoot = (): string => {
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = join(dir, "..");
  }
  return process.cwd();
};

const persistSecretToEnv = (secret: string): void => {
  const projectRoot = findProjectRoot();
  const envPath = join(projectRoot, ".env");
  const envLine = `\nIDENTITY_SESSION_SECRET=${secret}\n`;

  try {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      if (content.includes("IDENTITY_SESSION_SECRET=")) {
        return;
      }
    }
    appendFileSync(envPath, envLine);
    console.log("[auth] Generated and persisted session secret to .env");
  } catch (err) {
    console.warn("[auth] Could not persist session secret to .env:", err);
  }
};

export const getSessionSecretBytes = (): Uint8Array => {
  if (cachedSecret) {
    return cachedSecret;
  }

  let source =
    (Bun.env.IDENTITY_SESSION_SECRET ?? "").trim() ||
    (Bun.env.SESSION_SECRET ?? "").trim() ||
    (Bun.env.COOKIE_SECRET ?? "").trim();

  if (!source) {
    source = generateSecureSecret();
    persistSecretToEnv(source);
    Bun.env.IDENTITY_SESSION_SECRET = source;
    console.log("[auth] Auto-generated session secret for this instance");
  }

  cachedSecret = encoder.encode(source);
  return cachedSecret;
};
