#!/usr/bin/env bun

import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import { buildAuthHeader, resolveBaseUrl, resolveSecretKey } from "../clis/lib/auth";

type AuthMode = "owner-cli" | "delegate-bot" | "in-session-agent";
type OutputMode = "pretty" | "json" | "raw";

type RequestBody = Record<string, unknown> | unknown[] | string | null | undefined;

type ResponseSnapshot = {
  method: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawBody: string;
  parsedBody: unknown;
};

type ParsedCommand = {
  raw: string;
  tokens: string[];
};

type ReplState = {
  baseUrl: string;
  authMode: AuthMode;
  outputMode: OutputMode;
  verbose: boolean;
  keyInput?: string;
  sessionId?: string;
  ownerTargetNpub?: string;
  currentSessionId?: string;
  currentAppId?: string;
  lastResponse?: ResponseSnapshot;
};

const HELP_TEXT = `Wingman API test REPL

Usage:
  bun tmp/testsrepl.ts
  bun tmp/testsrepl.ts "<command>"

Core commands:
  help
  state
  mode <owner-cli|delegate-bot|in-session-agent>
  set url <url>
  set key <nsec|hex>
  set session-id <id>
  set owner <npub>
  set output <pretty|json|raw>
  set verbose <on|off>
  use-session <id>
  use-app <id>
  clear-session
  clear-app
  clear-owner
  req <METHOD> <PATH> [JSON-or-text-body]
  quit

Session commands:
  sessions list
  sessions active
  sessions my-active
  sessions delegated-active [owner-npub]
  sessions create <agent> [--name <name>] [--directory <path>] [--model <model>] [--metadata <json>] [--target-file <path>]
  sessions info [id]
  sessions read [id] [--refresh true|false]
  sessions history [id]
  sessions send [id] <message>
  sessions send-raw [id] <message>
  sessions queue [id]
  sessions queue-add [id] <prompt>
  sessions queue-next [id]
  sessions events [id] [--seconds <n>]
  sessions stop [id]

Delegation commands:
  delegations list
  delegations owner-list [owner-npub]
  delegations create <signed-event-json>
  delegations revoke <id>

App commands:
  apps list
  apps status [id]
  apps action <start|stop|restart|build|setup> [id]
  apps register <label> --directory <path> [--web-app]
  apps unregister [id]
  apps clone <repo-url> [--directory <path>]

Examples:
  mode delegate-bot
  set owner npub1owner...
  sessions my-active
  sessions delegated-active
  sessions create codex --name worker --directory /Users/mini/code
  sessions send "inspect the repo and summarize auth bugs"
  delegations list
  req GET /api/owners/npub1owner.../sessions
  req POST /api/sessions {"agent":"codex","metadata":{"AGENT":true}}

Notes:
  - auth mode controls who signs, not which route family is used.
  - self-space convenience commands use /api/sessions and /api/apps.
  - if set owner <npub> is active, convenience commands switch to /api/owners/:ownerNpub/... routes.
  - delegate-bot no longer assumes /api/delegate-sessions; use req for legacy route debugging.
  - in-session-agent signs through /api/mcp/bot-crypto/sign-event using SESSION_ID.
  - queue/history/events now follow the owner-space route when owner targeting is active.`;

const APP_ACTIONS = new Set(["start", "stop", "restart", "build", "setup"]);

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function parseCommand(raw: string): ParsedCommand {
  return {
    raw,
    tokens: tokenizeCommand(raw.trim()),
  };
}

function parseOnOff(value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(`Expected on/off or true/false, received "${value}"`);
}

function parseJsonOrText(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function ensureString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function takeOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function prettyPrintJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseResponseBody(rawBody: string): unknown {
  if (!rawBody) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

async function buildBotCryptoAuthHeaderForSession(
  baseUrl: string,
  url: string,
  method: string,
  body: RequestBody,
  sessionId: string,
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (body !== undefined && body !== null && typeof body !== "string") {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    tags.push(["payload", bytesToHex(sha256(bodyBytes))]);
  } else if (typeof body === "string") {
    const bodyBytes = new TextEncoder().encode(body);
    tags.push(["payload", bytesToHex(sha256(bodyBytes))]);
  }

  const response = await fetch(`${baseUrl}/api/mcp/bot-crypto/sign-event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId,
      event: {
        kind: 27235,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
    }),
  });

  const raw = await response.text();
  const payload = parseResponseBody(raw);
  if (!response.ok) {
    const message = isJsonRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : raw || response.statusText;
    throw new Error(`bot-crypto sign-event failed (${response.status}): ${message}`);
  }

  const signedEvent = isJsonRecord(payload) ? payload.event : null;
  if (!isJsonRecord(signedEvent)) {
    throw new Error("bot-crypto sign-event returned an invalid response");
  }

  return `Nostr ${Buffer.from(JSON.stringify(signedEvent), "utf8").toString("base64")}`;
}

class WingmanTestRepl {
  private readonly rl: Interface;

  private readonly state: ReplState;

  constructor() {
    this.rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
    });

    this.state = {
      baseUrl: resolveBaseUrl(Bun.env.WINGMAN_URL),
      authMode: "delegate-bot",
      outputMode: "pretty",
      verbose: true,
      keyInput: Bun.env.WINGMAN_NSEC,
      sessionId: Bun.env.SESSION_ID,
      ownerTargetNpub: Bun.env.WINGMAN_OWNER_NPUB,
    };
  }

  async run(argv: string[]): Promise<void> {
    if (argv.length > 0) {
      const oneShot = argv.join(" ");
      if (oneShot === "--help" || oneShot === "help") {
        this.printLine(HELP_TEXT);
        return;
      }
      await this.executeLine(oneShot);
      return;
    }

    this.printBanner();
    while (true) {
      const line = await this.rl.question(this.prompt());
      const trimmed = line.trim();
      if (!trimmed) continue;
      const shouldExit = await this.executeLine(trimmed);
      if (shouldExit) break;
    }
  }

  close(): void {
    this.rl.close();
  }

  private prompt(): string {
    const sessionPart = this.state.currentSessionId ? ` s:${this.state.currentSessionId.slice(0, 8)}` : "";
    const ownerPart = this.state.ownerTargetNpub ? ` o:${this.state.ownerTargetNpub.slice(0, 10)}` : "";
    return `wingman:${this.state.authMode}${ownerPart}${sessionPart}> `;
  }

  private printBanner(): void {
    this.printLine("Wingman API test REPL");
    this.printLine(
      `baseUrl=${this.state.baseUrl} authMode=${this.state.authMode} owner=${this.state.ownerTargetNpub ?? "self"} output=${this.state.outputMode}`,
    );
    this.printLine('Type "help" for commands.');
  }

  private printLine(message: string): void {
    stdout.write(`${message}\n`);
  }

  private async executeLine(line: string): Promise<boolean> {
    const parsed = parseCommand(line);
    if (parsed.tokens.length === 0) return false;

    const [command] = parsed.tokens;

    try {
      switch (command) {
        case "help":
          this.printLine(HELP_TEXT);
          return false;
        case "quit":
        case "exit":
          return true;
        case "state":
          this.printState();
          return false;
        case "mode":
          this.handleMode(parsed.tokens);
          return false;
        case "set":
          this.handleSet(parsed.tokens);
          return false;
        case "use-session":
          this.handleUseSession(parsed.tokens);
          return false;
        case "use-app":
          this.handleUseApp(parsed.tokens);
          return false;
        case "clear-session":
          this.state.currentSessionId = undefined;
          this.printLine("Cleared current session.");
          return false;
        case "clear-app":
          this.state.currentAppId = undefined;
          this.printLine("Cleared current app.");
          return false;
        case "clear-owner":
          this.state.ownerTargetNpub = undefined;
          this.printLine("Cleared owner target. Convenience commands now use self-space routes.");
          return false;
        case "req":
          await this.handleReq(parsed.tokens);
          return false;
        case "sessions":
          await this.handleSessions(parsed);
          return false;
        case "delegations":
          await this.handleDelegations(parsed);
          return false;
        case "apps":
          await this.handleApps(parsed);
          return false;
        default:
          throw new Error(`Unknown command "${command}"`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.printLine(`Error: ${message}`);
      return false;
    }
  }

  private printState(): void {
    this.printLine(prettyPrintJson({
      baseUrl: this.state.baseUrl,
      authMode: this.state.authMode,
      outputMode: this.state.outputMode,
      verbose: this.state.verbose,
      hasKey: Boolean(this.state.keyInput || Bun.env.WINGMAN_NSEC),
      sessionId: this.state.sessionId ?? null,
      ownerTargetNpub: this.state.ownerTargetNpub ?? null,
      currentSessionId: this.state.currentSessionId ?? null,
      currentAppId: this.state.currentAppId ?? null,
      lastResponse: this.state.lastResponse
        ? {
            method: this.state.lastResponse.method,
            url: this.state.lastResponse.url,
            status: this.state.lastResponse.status,
          }
        : null,
    }));
  }

  private handleMode(tokens: string[]): void {
    const nextMode = tokens[1];
    if (
      nextMode !== "owner-cli" &&
      nextMode !== "delegate-bot" &&
      nextMode !== "in-session-agent"
    ) {
      throw new Error('mode requires "owner-cli", "delegate-bot", or "in-session-agent"');
    }
    this.state.authMode = nextMode;
    this.printLine(`Auth mode set to ${nextMode}.`);
  }

  private handleSet(tokens: string[]): void {
    const field = tokens[1];
    const value = tokens[2];
    if (!field || !value) {
      throw new Error("set requires a field and value");
    }

    switch (field) {
      case "url":
        this.state.baseUrl = ensureString(value, "URL is required");
        this.printLine(`baseUrl=${this.state.baseUrl}`);
        return;
      case "key":
        this.state.keyInput = ensureString(value, "Key is required");
        this.printLine("Updated signing key in REPL state.");
        return;
      case "session-id":
        this.state.sessionId = ensureString(value, "Session ID is required");
        this.printLine(`sessionId=${this.state.sessionId}`);
        return;
      case "owner":
        this.state.ownerTargetNpub = ensureString(value, "Owner npub is required");
        this.printLine(`ownerTargetNpub=${this.state.ownerTargetNpub}`);
        return;
      case "output":
        if (value !== "pretty" && value !== "json" && value !== "raw") {
          throw new Error('output requires "pretty", "json", or "raw"');
        }
        this.state.outputMode = value;
        this.printLine(`output=${value}`);
        return;
      case "verbose":
        this.state.verbose = parseOnOff(value);
        this.printLine(`verbose=${this.state.verbose}`);
        return;
      default:
        throw new Error(`Unknown set field "${field}"`);
    }
  }

  private handleUseSession(tokens: string[]): void {
    const id = tokens[1];
    if (!id) throw new Error("use-session requires <id>");
    this.state.currentSessionId = id;
    this.printLine(`currentSessionId=${id}`);
  }

  private handleUseApp(tokens: string[]): void {
    const id = tokens[1];
    if (!id) throw new Error("use-app requires <id>");
    this.state.currentAppId = id;
    this.printLine(`currentAppId=${id}`);
  }

  private async handleReq(tokens: string[]): Promise<void> {
    const method = tokens[1];
    const path = tokens[2];
    if (!method || !path) {
      throw new Error("req requires <METHOD> <PATH> [BODY]");
    }

    const bodyToken = tokens.slice(3).join(" ").trim();
    const body = bodyToken.length > 0 ? parseJsonOrText(bodyToken) : undefined;
    await this.performRequest(method.toUpperCase(), path, body as RequestBody);
  }

  private async handleSessions(parsed: ParsedCommand): Promise<void> {
    const [, subcommand, ...restTokens] = parsed.tokens;
    const args = [...restTokens];

    switch (subcommand) {
      case "list":
        await this.performRequest("GET", this.sessionCollectionPath(), undefined);
        return;
      case "active":
        await this.showActiveSessions(this.sessionCollectionPath(), {
          label: this.usingOwnerSpace()
            ? `Active sessions for owner ${this.state.ownerTargetNpub}`
            : "Active sessions",
        });
        return;
      case "my-active":
        await this.showActiveSessions("/api/sessions", {
          label: "My active sessions",
        });
        return;
      case "delegated-active": {
        const ownerNpub = args[0] ?? this.state.ownerTargetNpub;
        if (ownerNpub) {
          await this.showActiveSessions(`/api/owners/${encodeURIComponent(ownerNpub)}/sessions`, {
            label: `Delegated active sessions for ${ownerNpub}`,
          });
          return;
        }
        await this.showDelegatedActiveSessions();
        return;
      }
      case "create": {
        const agent = args.shift();
        if (!agent) throw new Error("sessions create requires <agent>");
        const name = takeOption(args, "--name");
        const directory = takeOption(args, "--directory");
        const model = takeOption(args, "--model");
        const metadataInput = takeOption(args, "--metadata");
        const targetFile = takeOption(args, "--target-file");
        if (args.length > 0) {
          throw new Error(`Unknown arguments: ${args.join(" ")}`);
        }

        const body: Record<string, unknown> = { agent };
        if (name) body.name = name;
        if (directory) body.directory = directory;
        if (model) body.model = model;
        if (targetFile) body.targetFile = targetFile;
        if (metadataInput) {
          const metadata = parseJsonOrText(metadataInput);
          if (!isJsonRecord(metadata)) {
            throw new Error("--metadata must be a JSON object");
          }
          body.metadata = metadata;
        }

        const response = await this.performRequest("POST", this.sessionCollectionPath(), body);
        const createdId = isJsonRecord(response.parsedBody) && typeof response.parsedBody.id === "string"
          ? response.parsedBody.id
          : null;
        if (createdId) {
          this.state.currentSessionId = createdId;
          this.printLine(`currentSessionId=${createdId}`);
        }
        return;
      }
      case "info": {
        const id = this.resolveSessionId(args[0]);
        await this.performRequest("GET", `${this.sessionResourceBasePath(id)}/${encodeURIComponent(id)}`, undefined);
        return;
      }
      case "read": {
        const explicitId = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
        const id = this.resolveSessionId(explicitId);
        const refreshInput = takeOption(args, "--refresh") ?? "true";
        if (args.length > 0) {
          throw new Error(`Unknown arguments: ${args.join(" ")}`);
        }
        const refresh = refreshInput === "true" ? "true" : "false";
        await this.performRequest("GET", `${this.sessionMessagesPath(id)}?refresh=${refresh}`, undefined);
        return;
      }
      case "history": {
        const id = this.resolveSessionId(args[0]);
        await this.performRequest("GET", this.sessionHistoryPath(id), undefined);
        return;
      }
      case "send":
      case "send-raw": {
        const first = args[0];
        const maybeHasExplicitId = Boolean(first && !first.startsWith("--") && args.length > 1);
        const explicitId = maybeHasExplicitId ? args.shift() : undefined;
        const id = this.resolveSessionId(explicitId);
        const content = args.join(" ").trim();
        if (!content) {
          throw new Error(`${subcommand} requires a message`);
        }
        const body: Record<string, unknown> = { content };
        if (subcommand === "send-raw") {
          body.type = "raw";
        }
        await this.performRequest("POST", this.sessionMessagesPath(id), body);
        return;
      }
      case "queue": {
        const id = this.resolveSessionId(args[0]);
        await this.performRequest("GET", this.sessionQueuePath(id), undefined);
        return;
      }
      case "queue-add": {
        const first = args[0];
        const maybeHasExplicitId = Boolean(first && !first.startsWith("--") && args.length > 1);
        const explicitId = maybeHasExplicitId ? args.shift() : undefined;
        const id = this.resolveSessionId(explicitId);
        const content = args.join(" ").trim();
        if (!content) {
          throw new Error("sessions queue-add requires a prompt");
        }
        await this.performRequest("POST", this.sessionQueuePath(id), { content });
        return;
      }
      case "queue-next": {
        const id = this.resolveSessionId(args[0]);
        await this.performRequest("POST", `${this.sessionQueuePath(id)}/next`, undefined);
        return;
      }
      case "events": {
        const explicitId = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
        const id = this.resolveSessionId(explicitId);
        const secondsInput = takeOption(args, "--seconds") ?? "15";
        if (args.length > 0) {
          throw new Error(`Unknown arguments: ${args.join(" ")}`);
        }
        const seconds = Number.parseInt(secondsInput, 10);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error("--seconds must be a positive integer");
        }
        await this.streamEvents(id, seconds);
        return;
      }
      case "stop": {
        const id = this.resolveSessionId(args[0]);
        await this.performRequest("DELETE", this.sessionDeletePath(id), undefined);
        return;
      }
      default:
        throw new Error(`Unknown sessions subcommand "${subcommand ?? ""}"`);
    }
  }

  private async handleDelegations(parsed: ParsedCommand): Promise<void> {
    const [, subcommand, ...restTokens] = parsed.tokens;
    const args = [...restTokens];

    switch (subcommand) {
      case "list":
        await this.performRequest("GET", "/api/delegations", undefined);
        return;
      case "owner-list": {
        const ownerNpub = args[0] ?? this.state.ownerTargetNpub;
        if (!ownerNpub) {
          throw new Error("delegations owner-list requires <owner-npub> or set owner <npub>");
        }
        await this.performRequest("GET", `/api/owners/${encodeURIComponent(ownerNpub)}/delegations`, undefined);
        return;
      }
      case "create": {
        const signedEventInput = args.join(" ").trim();
        if (!signedEventInput) {
          throw new Error("delegations create requires <signed-event-json>");
        }
        const signedEvent = parseJsonOrText(signedEventInput);
        if (!isJsonRecord(signedEvent)) {
          throw new Error("delegations create expects a JSON object for signedEvent");
        }
        await this.performRequest("POST", "/api/delegations", { signedEvent });
        return;
      }
      case "revoke": {
        const id = args[0];
        if (!id) {
          throw new Error("delegations revoke requires <id>");
        }
        await this.performRequest("DELETE", `/api/delegations/${encodeURIComponent(id)}`, undefined);
        return;
      }
      default:
        throw new Error(`Unknown delegations subcommand "${subcommand ?? ""}"`);
    }
  }

  private async handleApps(parsed: ParsedCommand): Promise<void> {
    const [, subcommand, ...restTokens] = parsed.tokens;
    const args = [...restTokens];

    switch (subcommand) {
      case "list":
        await this.performRequest("GET", this.appsCollectionPath(), undefined);
        return;
      case "status": {
        const id = this.resolveAppId(args[0]);
        await this.performRequest("GET", `${this.appsCollectionPath()}/${encodeURIComponent(id)}`, undefined);
        return;
      }
      case "action": {
        const action = args.shift();
        if (!action || !APP_ACTIONS.has(action)) {
          throw new Error("apps action requires start|stop|restart|build|setup");
        }
        const id = this.resolveAppId(args[0]);
        await this.performRequest("POST", `${this.appsCollectionPath()}/${encodeURIComponent(id)}/actions`, { action });
        return;
      }
      case "register": {
        const label = args.shift();
        if (!label) throw new Error("apps register requires <label>");
        const directory = takeOption(args, "--directory");
        const webApp = takeFlag(args, "--web-app");
        if (!directory) throw new Error("apps register requires --directory <path>");
        if (args.length > 0) {
          throw new Error(`Unknown arguments: ${args.join(" ")}`);
        }
        const response = await this.performRequest("POST", this.appsCollectionPath(), {
          label,
          root: directory,
          ...(webApp ? { webApp: true } : {}),
        });
        if (
          isJsonRecord(response.parsedBody) &&
          isJsonRecord(response.parsedBody.app) &&
          typeof response.parsedBody.app.id === "string"
        ) {
          this.state.currentAppId = response.parsedBody.app.id;
          this.printLine(`currentAppId=${this.state.currentAppId}`);
        }
        return;
      }
      case "unregister": {
        const id = this.resolveAppId(args[0]);
        await this.performRequest("DELETE", `${this.appsCollectionPath()}/${encodeURIComponent(id)}`, undefined);
        return;
      }
      case "clone": {
        const repoUrl = args.shift();
        if (!repoUrl) throw new Error("apps clone requires <repo-url>");
        const directory = takeOption(args, "--directory");
        if (args.length > 0) {
          throw new Error(`Unknown arguments: ${args.join(" ")}`);
        }
        await this.performRequest("POST", `${this.appsCollectionPath()}/clone`, {
          url: repoUrl,
          ...(directory ? { directory } : {}),
        });
        return;
      }
      default:
        throw new Error(`Unknown apps subcommand "${subcommand ?? ""}"`);
    }
  }

  private sessionCollectionPath(): string {
    if (this.state.ownerTargetNpub) {
      return `/api/owners/${encodeURIComponent(this.state.ownerTargetNpub)}/sessions`;
    }
    return "/api/sessions";
  }

  private sessionResourceBasePath(_id: string): string {
    return this.sessionCollectionPath();
  }

  private sessionMessagesPath(id: string): string {
    return `${this.sessionCollectionPath()}/${encodeURIComponent(id)}/messages`;
  }

  private sessionDeletePath(id: string): string {
    return `${this.sessionCollectionPath()}/${encodeURIComponent(id)}`;
  }

  private sessionHistoryPath(id: string): string {
    return `${this.sessionCollectionPath()}/${encodeURIComponent(id)}/history`;
  }

  private sessionQueuePath(id: string): string {
    return `${this.sessionCollectionPath()}/${encodeURIComponent(id)}/queue`;
  }

  private sessionEventsPath(id: string): string {
    return `${this.sessionCollectionPath()}/${encodeURIComponent(id)}/events`;
  }

  private appsCollectionPath(): string {
    if (this.state.ownerTargetNpub) {
      return `/api/owners/${encodeURIComponent(this.state.ownerTargetNpub)}/apps`;
    }
    return "/api/apps";
  }

  private usingOwnerSpace(): boolean {
    return Boolean(this.state.ownerTargetNpub);
  }

  private resolveSessionId(explicitId?: string): string {
    const id = explicitId ?? this.state.currentSessionId;
    if (!id) {
      throw new Error("Session ID required. Pass one explicitly or use use-session <id>.");
    }
    return id;
  }

  private resolveAppId(explicitId?: string): string {
    const id = explicitId ?? this.state.currentAppId;
    if (!id) {
      throw new Error("App ID required. Pass one explicitly or use use-app <id>.");
    }
    return id;
  }

  private extractSessionsFromSnapshot(snapshot: ResponseSnapshot): unknown[] {
    if (!isJsonRecord(snapshot.parsedBody)) {
      return [];
    }
    const sessions = snapshot.parsedBody.sessions;
    return isJsonArray(sessions) ? sessions : [];
  }

  private buildActiveSummary(label: string, sessions: unknown[]): Record<string, unknown> {
    const normalized = sessions
      .filter(isJsonRecord)
      .map((session) => ({
        id: typeof session.id === "string" ? session.id : null,
        name: typeof session.name === "string" ? session.name : null,
        agent: typeof session.agent === "string" ? session.agent : null,
        status: typeof session.status === "string" ? session.status : null,
        runtimeStatus: typeof session.agentRuntimeStatus === "string" ? session.agentRuntimeStatus : null,
        npub: typeof session.npub === "string" ? session.npub : null,
        startedAt: typeof session.startedAt === "string" ? session.startedAt : null,
        workingDirectory: typeof session.workingDirectory === "string" ? session.workingDirectory : null,
      }));

    return {
      label,
      activeCount: normalized.length,
      sessions: normalized,
    };
  }

  private printStructuredResult(value: unknown): void {
    switch (this.state.outputMode) {
      case "json":
      case "pretty":
        this.printLine(prettyPrintJson(value));
        return;
      case "raw":
      default:
        this.printLine(typeof value === "string" ? value : JSON.stringify(value));
    }
  }

  private async showActiveSessions(path: string, options: { label: string }): Promise<void> {
    const snapshot = await this.performRequest("GET", path, undefined, { display: false });
    if (this.state.verbose) {
      this.printLine(`< ${snapshot.status} ${snapshot.statusText}`);
    }
    const summary = this.buildActiveSummary(options.label, this.extractSessionsFromSnapshot(snapshot));
    this.printStructuredResult(summary);
  }

  private async showDelegatedActiveSessions(): Promise<void> {
    const delegationsSnapshot = await this.performRequest("GET", "/api/delegations", undefined, { display: false });
    if (!isJsonRecord(delegationsSnapshot.parsedBody)) {
      throw new Error("Delegations response was not a JSON object");
    }
    const delegations = isJsonArray(delegationsSnapshot.parsedBody.delegations)
      ? delegationsSnapshot.parsedBody.delegations.filter(isJsonRecord)
      : [];
    const ownerNpubs = Array.from(
      new Set(
        delegations
          .map((delegation) => (typeof delegation.ownerNpub === "string" ? delegation.ownerNpub : ""))
          .filter((ownerNpub) => ownerNpub.length > 0),
      ),
    );
    const results: Array<Record<string, unknown>> = [];
    for (const ownerNpub of ownerNpubs) {
      const snapshot = await this.performRequest(
        "GET",
        `/api/owners/${encodeURIComponent(ownerNpub)}/sessions`,
        undefined,
        { display: false },
      );
      results.push(this.buildActiveSummary(ownerNpub, this.extractSessionsFromSnapshot(snapshot)));
    }
    this.printStructuredResult({
      label: "Delegated active sessions",
      ownerCount: results.length,
      owners: results,
    });
  }

  private async buildAuthorizationHeader(
    method: string,
    url: string,
    body: RequestBody,
  ): Promise<string> {
    if (this.state.authMode === "in-session-agent") {
      const sessionId = this.state.sessionId ?? Bun.env.SESSION_ID;
      if (!sessionId) {
        throw new Error("in-session-agent mode requires SESSION_ID or set session-id <id>");
      }
      return buildBotCryptoAuthHeaderForSession(this.state.baseUrl, url, method, body, sessionId);
    }

    const keyInput = this.state.keyInput ?? Bun.env.WINGMAN_NSEC;
    const secretKey = resolveSecretKey(keyInput);
    return buildAuthHeader(url, method, secretKey, body);
  }

  private async performRequest(
    method: string,
    path: string,
    body: RequestBody,
    options: { display?: boolean } = {},
  ): Promise<ResponseSnapshot> {
    const url = new URL(path, this.state.baseUrl).toString();
    const authorization = await this.buildAuthorizationHeader(method, url, body);

    const headers = new Headers();
    headers.set("authorization", authorization);

    let serializedBody: string | undefined;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        serializedBody = body;
        headers.set("content-type", "text/plain; charset=utf-8");
      } else {
        serializedBody = JSON.stringify(body);
        headers.set("content-type", "application/json");
      }
    }

    if (this.state.verbose) {
      this.printLine(`> ${method.toUpperCase()} ${url}`);
      this.printLine(`> auth-mode=${this.state.authMode}`);
      this.printLine(`> route-scope=${this.usingOwnerSpace() ? `owner:${this.state.ownerTargetNpub}` : "self"}`);
      if (serializedBody) {
        this.printLine(`> body=${serializedBody}`);
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: serializedBody,
    });

    const rawBody = await response.text();
    const snapshot: ResponseSnapshot = {
      method: method.toUpperCase(),
      url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      rawBody,
      parsedBody: parseResponseBody(rawBody),
    };
    this.state.lastResponse = snapshot;

    if (options.display !== false) {
      this.printResponse(snapshot);
    }
    return snapshot;
  }

  private printResponse(snapshot: ResponseSnapshot): void {
    if (this.state.verbose) {
      this.printLine(`< ${snapshot.status} ${snapshot.statusText}`);
      for (const [key, value] of Object.entries(snapshot.headers)) {
        this.printLine(`< ${key}=${value}`);
      }
    }

    switch (this.state.outputMode) {
      case "json":
        this.printLine(prettyPrintJson(snapshot));
        return;
      case "raw":
        this.printLine(snapshot.rawBody || "(empty body)");
        return;
      case "pretty":
      default:
        if (typeof snapshot.parsedBody === "string") {
          this.printLine(snapshot.parsedBody || "(empty body)");
        } else {
          this.printLine(prettyPrintJson(snapshot.parsedBody));
        }
    }
  }

  private async streamEvents(sessionId: string, seconds: number): Promise<void> {
    const path = this.sessionEventsPath(sessionId);
    const url = new URL(path, this.state.baseUrl).toString();
    const authorization = await this.buildAuthorizationHeader("GET", url, undefined);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), seconds * 1000);

    try {
      this.printLine(`> GET ${url}`);
      this.printLine(`> auth-mode=${this.state.authMode}`);
      this.printLine(`Streaming for up to ${seconds}s...`);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          authorization,
        },
        signal: controller.signal,
      });

      this.printLine(`< ${response.status} ${response.statusText}`);
      if (!response.ok) {
        const body = await response.text();
        this.printLine(body || "(empty body)");
        return;
      }

      if (!response.body) {
        this.printLine("Response body was empty.");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trimEnd();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            this.printLine(line);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const tail = buffer.trim();
      if (tail.length > 0) {
        this.printLine(tail);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("abort")) {
        this.printLine(`Event stream stopped after ${seconds}s.`);
        return;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function main(): Promise<void> {
  const repl = new WingmanTestRepl();
  try {
    await repl.run(Bun.argv.slice(2));
  } finally {
    repl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stdout.write(`Error: ${message}\n`);
  process.exit(1);
});
