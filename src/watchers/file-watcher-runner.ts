import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, normalize, relative, resolve, sep } from "node:path";

import type { ProcessManager } from "../agents/process-manager";
import type { FileWatcherRecord, JsonValue } from "../storage/file-watcher-store";
import { fileWatcherStore } from "../storage/file-watcher-store";

type CleanupStrategy = "delete" | "none";

interface ActiveWatcher {
  record: FileWatcherRecord;
  directory: string;
  matcher: RegExp;
  fsWatcher: FSWatcher;
  signature: string;
}

interface PendingKey {
  watcherId: string;
  filePath: string;
}

const pointerSeparator = "/";

const escapeForRegex = (input: string) => input.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const globToRegExp = (pattern: string): RegExp => {
  const escaped = escapeForRegex(pattern);
  const converted = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${converted}$`, "i");
};

const isRecord = (value: JsonValue): value is Record<string, JsonValue> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const resolvePointer = (value: JsonValue, pointer: string): JsonValue | undefined => {
  if (!pointer || pointer === pointerSeparator) {
    return value;
  }

  if (!pointer.startsWith(pointerSeparator)) {
    throw new Error(`Invalid JSON pointer "${pointer}"`);
  }

  const segments = pointer
    .split(pointerSeparator)
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: JsonValue = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    if (!(segment in current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
};

const matchesExpectedPayload = (candidate: JsonValue, expected: JsonValue): boolean => {
  if (isRecord(expected)) {
    if (!isRecord(candidate)) {
      return false;
    }
    return Object.entries(expected).every(([key, expectedValue]) =>
      matchesExpectedPayload(candidate[key] ?? undefined, expectedValue),
    );
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(candidate) || expected.length !== candidate.length) {
      return false;
    }
    return expected.every((value, index) => matchesExpectedPayload(candidate[index], value));
  }

  return candidate === expected;
};

const normaliseCleanupStrategy = (value: unknown): CleanupStrategy => {
  if (value === "delete") {
    return "delete";
  }
  return "none";
};

const toPendingKey = ({ watcherId, filePath }: PendingKey) => `${watcherId}::${filePath}`;

export class FileWatcherRunner {
  private readonly manager: ProcessManager;
  private readonly root: string;
  private readonly rootBoundary: string;
  private readonly refreshInterval: number;
  private readonly watchers = new Map<string, ActiveWatcher>();
  private readonly pending = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { root: string; manager: ProcessManager; refreshIntervalMs?: number }) {
    this.root = normalize(options.root);
    this.rootBoundary = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    this.manager = options.manager;
    this.refreshInterval = Math.max(2000, options.refreshIntervalMs ?? 10000);
  }

  async start() {
    await this.refreshWatchers();
    this.refreshTimer = setInterval(() => {
      void this.refreshWatchers();
    }, this.refreshInterval);
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const active of this.watchers.values()) {
      active.fsWatcher.close();
    }
    this.watchers.clear();
  }

  private async refreshWatchers() {
    const enabled = fileWatcherStore.listEnabledWatchers();
    const seen = new Set<string>();

    for (const record of enabled) {
      seen.add(record.id);
      await this.ensureWatcher(record).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        fileWatcherStore.recordError(record.id, message);
        console.warn(`[watchers] failed to initialise watcher ${record.id}: ${message}`);
      });
    }

    for (const [id, active] of this.watchers.entries()) {
      if (!seen.has(id)) {
        active.fsWatcher.close();
        this.watchers.delete(id);
      }
    }
  }

  private async ensureWatcher(record: FileWatcherRecord) {
    const signature = JSON.stringify(record);
    const existing = this.watchers.get(record.id);
    if (existing && existing.signature === signature) {
      return;
    }

    if (existing) {
      existing.fsWatcher.close();
      this.watchers.delete(record.id);
    }

    const directory = await this.resolveDirectory(record.relativeDir);
    const matcher = globToRegExp(record.pattern);

    const fsWatcher = watch(directory, (eventType, filename) => {
      if (!filename) {
        return;
      }

      const candidateName = typeof filename === "string" ? filename : filename.toString();
      if (!matcher.test(candidateName)) {
        return;
      }

      const filePath = join(directory, candidateName);
      this.queueFile(record.id, filePath);
    });

    this.watchers.set(record.id, {
      record,
      directory,
      matcher,
      fsWatcher,
      signature,
    });

    const relativePath = relative(this.root, directory) || ".";
    console.log(`[watchers] watching ${record.actionKey} in ${relativePath} (${record.pattern})`);
  }

  private queueFile(watcherId: string, filePath: string) {
    const key = toPendingKey({ watcherId, filePath });
    if (this.pending.has(key)) {
      return;
    }

    this.pending.add(key);
    const relativePath = relative(this.root, filePath);
    console.log(
      `[watchers] detected ${relativePath || basename(filePath)} for watcher ${watcherId}`,
    );
    void this.handleFile(watcherId, filePath).finally(() => {
      this.pending.delete(key);
    });
  }

  private async handleFile(watcherId: string, filePath: string) {
    const active = this.watchers.get(watcherId);
    if (!active) {
      return;
    }

    const { record } = active;
    try {
      await this.delay(50);

      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        return;
      }

      const raw = await readFile(filePath, "utf8");
      let payload: JsonValue;
      try {
        payload = JSON.parse(raw) as JsonValue;
      } catch {
        throw new Error(`Invalid JSON in ${basename(filePath)}`);
      }

      const candidate = resolvePointer(payload, record.payloadPointer);
      if (candidate === undefined) {
        return;
      }

      if (!matchesExpectedPayload(candidate, record.expectedPayload)) {
        return;
      }

      await this.performAction(record, payload, filePath);

      fileWatcherStore.markTriggered(record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fileWatcherStore.recordError(record.id, message);
      console.warn(`[watchers] failed to handle ${basename(filePath)} for ${watcherId}: ${message}`);
    }
  }

  private async performAction(record: FileWatcherRecord, payload: JsonValue, filePath: string) {
    switch (record.actionKey) {
      case "stop-session":
        await this.handleStopSession(record, payload, filePath);
        break;
      default:
        throw new Error(`Unsupported action ${record.actionKey}`);
    }
  }

  private async handleStopSession(record: FileWatcherRecord, payload: JsonValue, filePath: string) {
    if (!isRecord(payload)) {
      throw new Error("Stop session trigger payload must be an object");
    }

    const options = isRecord(record.options) ? record.options : {};
    const sessionPointer = typeof options.sessionPointer === "string" ? options.sessionPointer : "/session";
    const cleanupStrategy = normaliseCleanupStrategy(options.cleanupStrategy);

    const sessionId = resolvePointer(payload, sessionPointer);
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new Error(`Session id missing via pointer ${sessionPointer}`);
    }

    const session = await this.manager.stopSession(sessionId.trim());
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    console.log(`[watchers] stopped session ${sessionId} via ${record.id}`);

    if (cleanupStrategy === "delete") {
      await rm(filePath).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[watchers] failed to remove trigger ${basename(filePath)}: ${message}`);
      });
    }
  }

  private async resolveDirectory(relativeDir: string): Promise<string> {
    const target = resolve(this.root, relativeDir);
    if (target !== this.root && !target.startsWith(this.rootBoundary)) {
      throw new Error(`Watcher directory ${relativeDir} escapes root`);
    }

    await mkdir(target, { recursive: true });
    return target;
  }

  private async delay(ms: number) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  }
}
