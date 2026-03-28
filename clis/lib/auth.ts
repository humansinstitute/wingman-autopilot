/**
 * Shared NIP-98 authentication library for Wingman CLIs.
 *
 * Handles secret key resolution, NIP-98 header construction,
 * and authenticated JSON requests against the Wingman HTTP API.
 */

import { finalizeEvent, nip19 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const NIP98_KIND = 27235;

export interface CliConfig {
  baseUrl: string;
  secretKey: Uint8Array;
}

export interface BotCryptoConfig {
  baseUrl: string;
  botCrypto: true;
}

/**
 * Resolve a signing key from CLI flag, env vars, or throw.
 * Priority: keyInput arg → WINGMAN_NSEC
 */
export function resolveSecretKey(keyInput?: string): Uint8Array {
  const raw = (
    keyInput ??
    Bun.env.WINGMAN_NSEC ??
    ""
  ).trim();

  if (!raw) {
    throw new Error(
      "Missing signing key. Provide --key or set WINGMAN_NSEC.",
    );
  }

  if (raw.startsWith("nsec1")) {
    const decoded = nip19.decode(raw);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Invalid nsec key");
    }
    return decoded.data;
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return hexToBytes(raw);
  }

  throw new Error("Signing key must be nsec or 64-char hex");
}

/**
 * Build a NIP-98 Authorization header value.
 */
export function buildAuthHeader(
  url: string,
  method: string,
  secretKey: Uint8Array,
  body?: unknown,
): string {
  const upperMethod = method.toUpperCase();
  const tags: string[][] = [
    ["u", url],
    ["method", upperMethod],
  ];

  if (body !== undefined && body !== null) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    tags.push(["payload", bytesToHex(sha256(bodyBytes))]);
  }

  const event = finalizeEvent(
    {
      kind: NIP98_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    secretKey,
  );

  const token = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
  return `Nostr ${token}`;
}

/**
 * Build a NIP-98 Authorization header by signing via the wingman bot-crypto API.
 * Used when --bot-crypto flag is set (agents in sessions use their bot key).
 */
export async function buildBotCryptoAuthHeader(
  baseUrl: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<string> {
  const upperMethod = method.toUpperCase();
  const tags: string[][] = [
    ["u", url],
    ["method", upperMethod],
  ];

  if (body !== undefined && body !== null) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    tags.push(["payload", bytesToHex(sha256(bodyBytes))]);
  }

  const sessionId = Bun.env.SESSION_ID;
  if (!sessionId) {
    throw new Error("--bot-crypto requires SESSION_ID env var (set automatically in agent sessions)");
  }

  const signResponse = await fetch(`${baseUrl}/api/mcp/bot-crypto/sign-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      event: {
        kind: NIP98_KIND,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
    }),
  });

  if (!signResponse.ok) {
    const errText = await signResponse.text();
    throw new Error(`bot-crypto sign-event failed (${signResponse.status}): ${errText}`);
  }

  const result = await signResponse.json() as { event: Record<string, unknown> };
  const signedEvent = result.event;
  const token = Buffer.from(JSON.stringify(signedEvent), "utf8").toString("base64");
  return `Nostr ${token}`;
}

/**
 * Make an authenticated JSON request to the Wingman API.
 */
export async function requestJson<T>(
  baseUrl: string,
  secretKey: Uint8Array,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, baseUrl).toString();
  const authorization = buildAuthHeader(url, method, secretKey, body);

  const response = await fetch(url, {
    method,
    headers: {
      authorization,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let payload: unknown = {};
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { error: rawText };
    }
  }

  if (!response.ok) {
    const message =
      typeof (payload as { error?: unknown })?.error === "string"
        ? (payload as { error: string }).error
        : response.statusText || "Request failed";
    throw new Error(`${response.status} ${message}`);
  }

  return payload as T;
}

/**
 * Make an authenticated JSON request using bot-crypto signing.
 */
export async function requestJsonBotCrypto<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, baseUrl).toString();
  const authorization = await buildBotCryptoAuthHeader(baseUrl, url, method, body);

  const response = await fetch(url, {
    method,
    headers: {
      authorization,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let payload: unknown = {};
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { error: rawText };
    }
  }

  if (!response.ok) {
    const message =
      typeof (payload as { error?: unknown })?.error === "string"
        ? (payload as { error: string }).error
        : response.statusText || "Request failed";
    throw new Error(`${response.status} ${message}`);
  }

  return payload as T;
}

/**
 * Resolve the Wingman base URL from CLI flag or env.
 * Priority: urlInput arg → WINGMAN_URL → http://localhost:{PORT} → http://localhost:3000
 */
export function resolveBaseUrl(urlInput?: string): string {
  let url: string;
  if (urlInput) {
    url = urlInput.replace(/\/$/, "");
  } else if (Bun.env.WINGMAN_URL) {
    url = Bun.env.WINGMAN_URL.replace(/\/$/, "");
  } else {
    const port = Number.parseInt(Bun.env.PORT ?? "3000", 10);
    const effectivePort = Number.isFinite(port) && port > 0 ? port : 3000;
    url = `http://127.0.0.1:${effectivePort}`;
  }
  // Validate URL scheme to prevent SSRF via protocol smuggling
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("base_url must use http or https scheme");
  }
  return url;
}

/**
 * Parse common CLI flags (--url, --key, --json, --help) from argv.
 * Returns remaining positional args and parsed config.
 */
export function parseCommonFlags(argv: string[]): {
  args: string[];
  urlInput?: string;
  keyInput?: string;
  asJson: boolean;
  help: boolean;
  botCrypto: boolean;
} {
  const args: string[] = [];
  let urlInput: string | undefined;
  let keyInput: string | undefined;
  let asJson = false;
  let help = false;
  let botCrypto = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--url":
      case "--base-url": {
        const value = argv[i + 1];
        if (!value) throw new Error(`${flag} requires a value`);
        urlInput = value;
        i++;
        break;
      }
      case "--key": {
        const value = argv[i + 1];
        if (!value) throw new Error("--key requires a value");
        keyInput = value;
        i++;
        break;
      }
      case "--json":
        asJson = true;
        break;
      case "--bot-crypto":
        botCrypto = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        args.push(flag);
    }
  }

  return { args, urlInput, keyInput, asJson, help, botCrypto };
}

/**
 * Build a CliConfig from parsed flags.
 */
export function buildConfig(urlInput?: string, keyInput?: string): CliConfig {
  return {
    baseUrl: resolveBaseUrl(urlInput),
    secretKey: resolveSecretKey(keyInput),
  };
}
