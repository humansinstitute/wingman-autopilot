/**
 * Scheduler Engine
 *
 * Loads enabled jobs from SQLite, schedules them via croner, and on trigger:
 *   1. Unwraps the escrow UUID from the wrapped key
 *   2. Unlocks the bot key via escrow
 *   3. Creates a session with the explicit npub
 *   4. Injects the initial prompt
 *   5. Enables Night Watchman if configured
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { Cron } from "croner";

import type { SchedulerStore, ScheduledJob } from "./scheduler-store";
import { unwrapEscrowUuid } from "./key-wrapper";
import { unlockViaEscrow, storeBotKeyInMemory, isBotKeyUnlocked } from "../identity/bot-key-manager";
import type { BotKeyStore } from "../identity/bot-key-store";
import type { NightWatchStore } from "../nightwatch/nightwatch-store";
import type { AgentType } from "../config";
import type { SessionSnapshot, SessionOrigin } from "../agents/process-manager";
import { getSessionSecretBytes } from "../auth/session-secret";

// ============================================================
// Types
// ============================================================

export interface SchedulerEngineDeps {
  store: SchedulerStore;
  botKeyStore: BotKeyStore;
  nightWatchStore: NightWatchStore;
  createSession: (
    agent: AgentType,
    dir: string,
    name: string,
    origin: SessionOrigin,
    targetFile: string | undefined,
    explicitNpub: string,
  ) => Promise<SessionSnapshot>;
  addPrompt: (sessionId: string, content: string) => void;
  dispatchPrompt: (session: SessionSnapshot) => void;
  onBotKeyUnlocked?: (npub: string, secretKey: Uint8Array, botPubkeyHex: string) => void;
}

// ============================================================
// Engine
// ============================================================

/** Convert a simple glob pattern (e.g. "*.json") into a RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

interface FileWatcherEntry {
  watcher: FSWatcher;
  seenFiles: Set<string>;
}

class SchedulerEngine {
  private readonly deps: SchedulerEngineDeps;
  private readonly cronJobs = new Map<string, Cron>();
  private readonly fileWatchers = new Map<string, FileWatcherEntry>();

  constructor(deps: SchedulerEngineDeps) {
    this.deps = deps;
  }

  /**
   * Load all enabled jobs and schedule them.
   */
  start(): void {
    const jobs = this.deps.store.listEnabledJobs();
    for (const job of jobs) {
      this.scheduleJob(job);
    }
    if (jobs.length > 0) {
      console.log(`[scheduler] Started ${jobs.length} scheduled job(s)`);
    }
  }

  /**
   * Stop all scheduled cron jobs.
   */
  stop(): void {
    for (const [id, cron] of this.cronJobs) {
      cron.stop();
      this.cronJobs.delete(id);
    }
    for (const [id, entry] of this.fileWatchers) {
      entry.watcher.close();
      this.fileWatchers.delete(id);
    }
    console.log("[scheduler] Stopped all scheduled jobs");
  }

  /**
   * Schedule a single job. Calculates next run time and stores in DB.
   */
  scheduleJob(job: ScheduledJob): void {
    // Remove existing schedule if present
    this.unscheduleJob(job.id);

    if (job.triggerType === "nostr") {
      // Nostr triggers are handled by the trigger listener, not scheduled
      return;
    }

    if (job.triggerType === "file_watcher") {
      this.startFileWatcher(job);
      return;
    }

    try {
      const cron = new Cron(job.cronExpression, {
        timezone: job.timezone || "UTC",
      }, () => {
        void this.onJobTriggered(job.id);
      });

      this.cronJobs.set(job.id, cron);

      // Update next run time
      const nextRun = cron.nextRun();
      if (nextRun) {
        this.deps.store.updateJob(job.id, {
          nextRunAt: nextRun.toISOString(),
        });
      }
    } catch (err) {
      console.error(`[scheduler] Failed to schedule job ${job.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Remove a job from the cron scheduler.
   */
  unscheduleJob(jobId: string): void {
    const existing = this.cronJobs.get(jobId);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(jobId);
    }
    const watcher = this.fileWatchers.get(jobId);
    if (watcher) {
      watcher.watcher.close();
      this.fileWatchers.delete(jobId);
    }
  }

  /**
   * Start an fs.watch listener for a file_watcher job.
   */
  private startFileWatcher(job: ScheduledJob): void {
    const dir = job.watchDirectory;
    if (!dir) {
      console.error(`[scheduler] File watcher job ${job.id} has no watchDirectory`);
      return;
    }

    const pattern = globToRegex(job.filePattern || "*");
    const seenFiles = new Set<string>();

    // Seed with existing files so we only trigger on NEW arrivals
    readdir(dir).then((files) => {
      for (const f of files) {
        if (pattern.test(f)) seenFiles.add(f);
      }
    }).catch((err) => {
      console.error(`[scheduler] Failed to read watch directory ${dir}: ${(err as Error).message}`);
    });

    try {
      const watcher = fsWatch(dir, async (eventType, filename) => {
        if (!filename || eventType !== "rename") return;
        if (!pattern.test(filename)) return;
        if (seenFiles.has(filename)) return;

        // Verify file actually exists (rename fires for both create and delete)
        try {
          await stat(join(dir, filename));
        } catch {
          return; // File was deleted, not created
        }

        seenFiles.add(filename);
        console.log(`[scheduler] File watcher "${job.name}" detected new file: ${filename}`);
        void this.onJobTriggered(job.id);
      });

      this.fileWatchers.set(job.id, { watcher, seenFiles });
      console.log(`[scheduler] File watcher started for job "${job.name}" on ${dir} (pattern: ${job.filePattern})`);
    } catch (err) {
      console.error(`[scheduler] Failed to start file watcher for job ${job.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Manually trigger a job. Returns the session ID on success.
   */
  async executeJob(jobId: string): Promise<string> {
    return this.onJobTriggered(jobId);
  }

  /**
   * Trigger a job with an appended message (used by Nostr triggers).
   * Composes the prompt as `initialPrompt + "\n\n" + message`.
   */
  async executeJobWithMessage(jobId: string, message?: string): Promise<string> {
    const job = this.deps.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const promptOverride = message
      ? `${job.initialPrompt}\n\n${message}`
      : undefined;

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const sessionNamePrefix = `[nostr] ${job.name} ${dd}/${mm} ${hh}:${min}`;

    return this.onJobTriggered(jobId, promptOverride, { type: "nostr", id: jobId }, sessionNamePrefix);
  }

  /**
   * Core execution flow when a job triggers.
   */
  private async onJobTriggered(
    jobId: string,
    promptOverride?: string,
    originOverride?: SessionOrigin,
    sessionNameOverride?: string,
  ): Promise<string> {
    // Reload job from DB to get latest state
    const job = this.deps.store.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!job.enabled) {
      throw new Error(`Job ${jobId} is disabled`);
    }

    const runId = this.deps.store.recordRun(jobId);

    try {
      // 1. Unwrap the escrow UUID
      const sessionSecretBytes = getSessionSecretBytes();
      const escrowUuid = unwrapEscrowUuid(
        { ciphertext: job.wrappedKeyCiphertext, nonce: job.wrappedKeyNonce },
        sessionSecretBytes,
      );

      // 2. Lookup bot key and unlock via escrow
      const botKey = this.deps.botKeyStore.getActiveKeyForUser(job.userNpub);
      if (!botKey) {
        throw new Error(`No active bot key for user ${job.userNpub}`);
      }

      if (!isBotKeyUnlocked(job.userNpub)) {
        const secretKey = unlockViaEscrow(
          botKey.encryptedEscrow,
          botKey.botPubkeyHex,
          escrowUuid,
        );
        storeBotKeyInMemory(job.userNpub, secretKey, botKey.botPubkeyHex, "escrow");
        this.deps.onBotKeyUnlocked?.(job.userNpub, secretKey, botKey.botPubkeyHex);
      }

      // 3. Create session with explicit npub
      let sessionName: string;
      if (sessionNameOverride) {
        sessionName = sessionNameOverride;
      } else {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const hh = String(now.getHours()).padStart(2, "0");
        const min = String(now.getMinutes()).padStart(2, "0");
        sessionName = `[sched] ${job.name} ${dd}/${mm} ${hh}:${min}`;
      }
      const origin = originOverride ?? { type: "scheduler" as const, id: job.id };
      const session = await this.deps.createSession(
        job.agent as AgentType,
        job.workingDirectory,
        sessionName,
        origin,
        undefined,
        job.userNpub,
      );

      // 4. Inject initial prompt (or override)
      this.deps.addPrompt(session.id, promptOverride ?? job.initialPrompt);

      // 5. Enable Night Watchman if configured
      if (job.nightwatchmanEnabled) {
        this.deps.nightWatchStore.enableSession(session.id);
      }

      // 6. Dispatch the prompt
      this.deps.dispatchPrompt(session);

      // 7. Update job and record success
      const now = new Date().toISOString();
      const updateFields: Record<string, unknown> = { lastRunAt: now };
      const cron = this.cronJobs.get(jobId);
      if (cron) {
        const nextRun = cron.nextRun();
        if (nextRun) updateFields.nextRunAt = nextRun.toISOString();
      }
      this.deps.store.updateJob(jobId, updateFields);
      this.deps.store.completeRun(runId, "success", session.id);

      console.log(`[scheduler] Job "${job.name}" triggered — session ${session.id}`);
      return session.id;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.deps.store.completeRun(runId, "error", undefined, message);
      console.error(`[scheduler] Job "${job.name}" failed: ${message}`);
      throw err;
    }
  }
}

export { SchedulerEngine };
