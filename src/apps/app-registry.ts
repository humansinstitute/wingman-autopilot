import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

import { generateIdentityAlias } from "../identity/identity-alias";
import { normaliseNpub } from "../identity/npub-utils";
import { identityUserStore } from "../storage/identity-user-store";
import { isPortAvailable } from "../utils/port-utils";
import { appAliasRegistry } from "./app-alias-registry";

const registryFilePath = new URL("../../data/apps.json", import.meta.url).pathname;

export type AppLifecycleAction = "start" | "stop" | "restart" | "setup" | "build";

export type AppLifecycleScripts = Partial<Record<AppLifecycleAction, string>>;

export interface AppRecord {
  id: string;
  label: string;
  root: string;
  scripts: AppLifecycleScripts;
  /** @deprecated Use pm2Name instead. Kept for backward compatibility. */
  tmuxSession: string;
  /** PM2 process name for this app. */
  pm2Name?: string;
  /** Directory where PM2 logs are stored. */
  logsDir?: string;
  notes?: string;
  ownerNpub: string | null;
  createdAt: string;
  updatedAt: string;
  webApp: boolean;
  webAppPort: number | null;
}

export interface RegisterAppInput {
  id?: string;
  label: string;
  root: string;
  scripts?: AppLifecycleScripts;
  /** @deprecated */
  tmuxSession?: string;
  pm2Name?: string;
  logsDir?: string;
  notes?: string;
  ownerNpub?: string | null;
  webApp?: boolean;
  webAppPort?: number | null;
}

export interface UpdateAppInput {
  label?: string;
  root?: string;
  scripts?: AppLifecycleScripts;
  /** @deprecated */
  tmuxSession?: string;
  pm2Name?: string;
  logsDir?: string;
  notes?: string | null;
  ownerNpub?: string | null;
  webApp?: boolean;
  webAppPort?: number | null;
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

const MAX_TMUX_NAME_LENGTH = 48;

const sanitiseWindowName = (input: string | undefined | null): string => {
  if (!input) return "";
  return input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
};

const deriveOwnerAlias = (ownerNpub: string | null): string | null => {
  if (!ownerNpub) {
    return null;
  }
  return sanitiseWindowName(generateIdentityAlias(ownerNpub));
};

const normaliseWindowName = (
  value: string | undefined,
  label: string,
  root: string,
  id: string,
  ownerAlias: string | null,
): string => {
  const provided = sanitiseWindowName(value);
  if (provided) {
    return provided.slice(0, MAX_TMUX_NAME_LENGTH);
  }

  const baseLabel = sanitiseWindowName(label) || sanitiseWindowName(basename(root));
  const alias = ownerAlias ? ownerAlias.slice(0, MAX_TMUX_NAME_LENGTH) : "";
  const components = [alias, baseLabel].filter((part) => part.length > 0);
  if (components.length > 0) {
    const combined = components.join("--");
    const trimmed = sanitiseWindowName(combined).slice(0, MAX_TMUX_NAME_LENGTH);
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const fallbackBase = `app-${id.slice(0, 8)}`;
  const fallback = alias ? `${alias}--${fallbackBase}` : fallbackBase;
  const sanitisedFallback = sanitiseWindowName(fallback).slice(0, MAX_TMUX_NAME_LENGTH);
  return sanitisedFallback.length > 0 ? sanitisedFallback : fallbackBase.slice(0, MAX_TMUX_NAME_LENGTH);
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
    const ownerNpub = normaliseNpub(input.ownerNpub ?? null);
    const ownerAlias = deriveOwnerAlias(ownerNpub);
    const tmuxSession = normaliseWindowName(input.tmuxSession, label, root, id, ownerAlias);
    const scripts = this.normaliseScripts(input.scripts);
    const webAppEnabled = Boolean(input.webApp);
    const preferredPort =
      typeof input.webAppPort === "number" && Number.isFinite(input.webAppPort)
        ? Math.trunc(input.webAppPort)
        : null;
    let webAppPort: number | null = null;
    if (webAppEnabled) {
      if (!ownerNpub) {
        throw new Error("Unable to assign a web app port without a registered owner.");
      }
      webAppPort = this.assignWebAppPort(ownerNpub, id, preferredPort);
    }
    const record: AppRecord = {
      id,
      label,
      root,
      scripts,
      tmuxSession,
      pm2Name: input.pm2Name,
      logsDir: input.logsDir,
      notes: input.notes?.trim() || undefined,
      ownerNpub,
      createdAt: now,
      updatedAt: now,
      webApp: webAppEnabled,
      webAppPort,
    };
    this.apps.set(record.id, record);
    await this.persist();

    // Register subdomain alias for routing
    if (ownerNpub) {
      await appAliasRegistry.registerAlias(record.id, ownerNpub, root);
    }

    return record;
  }

  async updateApp(id: string, input: UpdateAppInput): Promise<AppRecord> {
    await this.ensureLoaded();
    const existing = this.apps.get(id);
    if (!existing) {
      throw new Error(`Unknown app: ${id}`);
    }
    const nextLabel = input.label?.trim() || existing.label;
    const nextRoot = input.root ? ensureAbsolutePath(input.root) : existing.root;
    const nextScripts = input.scripts ? this.normaliseScripts(input.scripts) : existing.scripts;
    const nextNotes = input.notes === null ? undefined : input.notes?.trim() || existing.notes;
    const nextOwnerNpub =
      input.ownerNpub !== undefined ? normaliseNpub(input.ownerNpub ?? null) ?? null : existing.ownerNpub;
    const nextOwnerAlias = deriveOwnerAlias(nextOwnerNpub);
    const nextTmux = normaliseWindowName(
      input.tmuxSession ?? existing.tmuxSession,
      nextLabel,
      nextRoot,
      id,
      nextOwnerAlias,
    );
    const nextWebApp = input.webApp !== undefined ? Boolean(input.webApp) : existing.webApp;
    const requestedPort =
      typeof input.webAppPort === "number" && Number.isFinite(input.webAppPort)
        ? Math.trunc(input.webAppPort)
        : undefined;
    let nextWebAppPort: number | null = existing.webAppPort;
    if (!nextWebApp) {
      nextWebAppPort = null;
    } else {
      if (!nextOwnerNpub) {
        throw new Error("Unable to assign a web app port without a registered owner.");
      }
      const preferred = requestedPort ?? existing.webAppPort ?? undefined;
      nextWebAppPort = this.assignWebAppPort(nextOwnerNpub, id, preferred);
    }
    const next: AppRecord = {
      ...existing,
      label: nextLabel,
      root: nextRoot,
      scripts: nextScripts,
      tmuxSession: nextTmux,
      pm2Name: input.pm2Name !== undefined ? input.pm2Name : existing.pm2Name,
      logsDir: input.logsDir !== undefined ? input.logsDir : existing.logsDir,
      notes: nextNotes,
      ownerNpub: nextOwnerNpub,
      updatedAt: new Date().toISOString(),
      webApp: nextWebApp,
      webAppPort: nextWebAppPort,
    };
    if (next.root !== existing.root) {
      const conflict = Array.from(this.apps.values()).find((app) => app.id !== id && app.root === next.root);
      if (conflict) {
        throw new Error(`Another app is already registered for root "${next.root}"`);
      }
    }
    this.apps.set(id, next);
    await this.persist();

    // Update subdomain alias if owner or root changed
    if (next.ownerNpub) {
      await appAliasRegistry.registerAlias(id, next.ownerNpub, next.root);
    } else {
      // No owner, remove alias
      await appAliasRegistry.removeAlias(id);
    }

    return next;
  }

  async removeApp(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.apps.delete(id);
    if (existed) {
      await this.persist();
      await appAliasRegistry.removeAlias(id);
    }
    return existed;
  }

  /**
   * Get the subdomain alias for an app.
   */
  async getAppAlias(id: string): Promise<string | null> {
    const record = await appAliasRegistry.getByAppId(id);
    return record?.alias ?? null;
  }

  async discoverScripts(root: string): Promise<AppLifecycleScripts> {
    const absolute = ensureAbsolutePath(root);
    try {
      const packagePath = join(absolute, "package.json");
      const contents = await readFile(packagePath, "utf8");
      const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
      const scripts: AppLifecycleScripts = {};
      if (parsed.scripts) {
        const candidates: AppLifecycleAction[] = ["start", "stop", "restart", "setup", "build"];
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

  private assignWebAppPort(ownerNpub: string, appId: string | null, preferred?: number | null): number {
    const normalizedOwner = normaliseNpub(ownerNpub ?? null);
    if (!normalizedOwner) {
      throw new Error("Web apps require an owner with a valid npub");
    }
    const ports = identityUserStore.ensurePortsFor(normalizedOwner);
    if (!ports || ports.length === 0) {
      throw new Error("No reserved ports are available for this owner.");
    }

    // Build set of ports assigned to other apps for this user
    const assignedToApps = new Set<number>();
    for (const app of this.apps.values()) {
      if (app.id === appId) continue;
      if (app.ownerNpub === normalizedOwner && app.webApp && typeof app.webAppPort === "number") {
        assignedToApps.add(app.webAppPort);
      }
    }

    // Check if a port is available (not assigned to another app AND not in use on system)
    const isAvailable = (port: number): boolean => {
      if (assignedToApps.has(port)) {
        return false;
      }
      if (!isPortAvailable(port)) {
        console.warn(`[app-registry] port ${port} is in use on system, skipping`);
        return false;
      }
      return true;
    };

    // Try preferred port first
    if (typeof preferred === "number" && Number.isFinite(preferred)) {
      const intValue = Math.trunc(preferred);
      if (ports.includes(intValue) && isAvailable(intValue)) {
        return intValue;
      }
    }

    // Find first available port from reserved range
    const available = ports.find(isAvailable);
    if (available === undefined) {
      throw new Error("All reserved ports are either assigned to other apps or in use on the system.");
    }
    return available;
  }

  private hydrateRecord(input: Partial<AppRecord> & { id: string; root: string }): AppRecord {
    const now = new Date().toISOString();
    const root = ensureAbsolutePath(input.root);
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const label = input.label?.trim() || basename(root);
    const ownerNpub = normaliseNpub(input.ownerNpub ?? null);
    const ownerAlias = deriveOwnerAlias(ownerNpub);
    const tmuxSession = normaliseWindowName(input.tmuxSession, label, root, input.id, ownerAlias);
    const scripts = this.normaliseScripts(input.scripts);
    const notes = input.notes?.trim() || undefined;
    const webApp = Boolean(input.webApp);
    const storedPort =
      typeof input.webAppPort === "number" && Number.isFinite(input.webAppPort)
        ? Math.trunc(input.webAppPort)
        : null;
    const webAppPort = webApp ? storedPort : null;
    return {
      id: input.id,
      label,
      root,
      scripts,
      tmuxSession,
      pm2Name: input.pm2Name,
      logsDir: input.logsDir,
      notes,
      ownerNpub,
      createdAt,
      updatedAt,
      webApp,
      webAppPort,
    };
  }
}

export const appRegistry = new AppRegistry();
