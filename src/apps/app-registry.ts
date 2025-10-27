import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

const registryFilePath = new URL("../../data/apps.json", import.meta.url).pathname;

export type AppLifecycleAction = "start" | "stop" | "restart" | "build";

export type AppLifecycleScripts = Partial<Record<AppLifecycleAction, string>>;

export interface AppRecord {
  id: string;
  label: string;
  root: string;
  scripts: AppLifecycleScripts;
  tmuxSession: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterAppInput {
  id?: string;
  label: string;
  root: string;
  scripts?: AppLifecycleScripts;
  tmuxSession?: string;
  notes?: string;
}

export interface UpdateAppInput {
  label?: string;
  root?: string;
  scripts?: AppLifecycleScripts;
  tmuxSession?: string;
  notes?: string | null;
}

export interface AppRegistryState {
  apps: AppRecord[];
}

const ensureAbsolutePath = (input: string): string => {
  if (!input) {
    throw new Error("App root path is required");
  }
  return resolvePath(input);
};

const defaultSessionName = (root: string): string => {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
  const suffix = slug || randomUUID().slice(0, 8);
  return `wingman-app-${suffix}`;
};

export class AppRegistry {
  private readonly filePath: string;
  private loaded = false;
  private apps = new Map<string, AppRecord>();
  private writeLock: Promise<void> = Promise.resolve();

  constructor(filePath: string = registryFilePath) {
    this.filePath = filePath;
  }

  async listApps(): Promise<AppRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.apps.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  async getApp(id: string): Promise<AppRecord | undefined> {
    await this.ensureLoaded();
    return this.apps.get(id);
  }

  async registerApp(input: RegisterAppInput): Promise<AppRecord> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const root = ensureAbsolutePath(input.root);
    const id = input.id?.trim() || randomUUID();
    if (this.apps.has(id)) {
      throw new Error(`App with id "${id}" already exists`);
    }
    const existingWithRoot = Array.from(this.apps.values()).find((app) => app.root === root);
    if (existingWithRoot) {
      throw new Error(`An app is already registered for root "${root}"`);
    }
    const label = input.label?.trim() || basename(root);
    const tmuxSession = input.tmuxSession?.trim() || defaultSessionName(root);
    const scripts = this.normaliseScripts(input.scripts);
    const record: AppRecord = {
      id,
      label,
      root,
      scripts,
      tmuxSession,
      notes: input.notes?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.apps.set(record.id, record);
    await this.persist();
    return record;
  }

  async updateApp(id: string, input: UpdateAppInput): Promise<AppRecord> {
    await this.ensureLoaded();
    const existing = this.apps.get(id);
    if (!existing) {
      throw new Error(`Unknown app: ${id}`);
    }
    const next: AppRecord = {
      ...existing,
      label: input.label?.trim() || existing.label,
      root: input.root ? ensureAbsolutePath(input.root) : existing.root,
      scripts: input.scripts ? this.normaliseScripts(input.scripts) : existing.scripts,
      tmuxSession: input.tmuxSession?.trim() || existing.tmuxSession,
      notes: input.notes === null ? undefined : input.notes?.trim() || existing.notes,
      updatedAt: new Date().toISOString(),
    };
    if (next.root !== existing.root) {
      const conflict = Array.from(this.apps.values()).find((app) => app.id !== id && app.root === next.root);
      if (conflict) {
        throw new Error(`Another app is already registered for root "${next.root}"`);
      }
    }
    this.apps.set(id, next);
    await this.persist();
    return next;
  }

  async removeApp(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.apps.delete(id);
    if (existed) {
      await this.persist();
    }
    return existed;
  }

  async discoverScripts(root: string): Promise<AppLifecycleScripts> {
    const absolute = ensureAbsolutePath(root);
    try {
      const packagePath = join(absolute, "package.json");
      const contents = await readFile(packagePath, "utf8");
      const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
      const scripts: AppLifecycleScripts = {};
      if (parsed.scripts) {
        const candidates: AppLifecycleAction[] = ["start", "stop", "restart", "build"];
        for (const action of candidates) {
          const command = parsed.scripts[action];
          if (typeof command === "string" && command.trim().length > 0) {
            scripts[action] = command.trim();
          }
        }
      }
      return scripts;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    try {
      const stats = await stat(this.filePath);
      if (!stats.isFile()) {
        this.apps.clear();
        await this.persist();
        this.loaded = true;
        return;
      }
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AppRegistryState | AppRecord[];
      const records: (Partial<AppRecord> & { id: string; root: string })[] = Array.isArray(parsed)
        ? parsed
        : parsed.apps ?? [];
      this.apps = new Map(records.map((record) => {
        const hydrated = this.hydrateRecord(record);
        return [hydrated.id, hydrated] as const;
      }));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.apps.clear();
        await this.persist();
      } else {
        throw error;
      }
    }
    this.loaded = true;
  }

  private async persist() {
    const payload: AppRegistryState = {
      apps: Array.from(this.apps.values()),
    };
    const writeOperation = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmpPath, this.filePath);
    };
    this.writeLock = this.writeLock.then(writeOperation, writeOperation);
    await this.writeLock;
  }

  private normaliseScripts(input?: AppLifecycleScripts): AppLifecycleScripts {
    if (!input) return {};
    const scripts: AppLifecycleScripts = {};
    for (const [key, value] of Object.entries(input)) {
      if (!value) continue;
      const action = key as AppLifecycleAction;
      scripts[action] = value.trim();
    }
    return scripts;
  }

  private hydrateRecord(input: Partial<AppRecord> & { id: string; root: string }): AppRecord {
    const now = new Date().toISOString();
    const root = ensureAbsolutePath(input.root);
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const label = input.label?.trim() || basename(root);
    const tmuxSession = input.tmuxSession?.trim() || defaultSessionName(root);
    const scripts = this.normaliseScripts(input.scripts);
    const notes = input.notes?.trim() || undefined;
    return {
      id: input.id,
      label,
      root,
      scripts,
      tmuxSession,
      notes,
      createdAt,
      updatedAt,
    };
  }
}

export const appRegistry = new AppRegistry();
