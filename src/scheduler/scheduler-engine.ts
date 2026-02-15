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
}

// ============================================================
// Engine
// ============================================================

class SchedulerEngine {
  private readonly deps: SchedulerEngineDeps;
  private readonly cronJobs = new Map<string, Cron>();

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
    console.log("[scheduler] Stopped all scheduled jobs");
  }

  /**
   * Schedule a single job. Calculates next run time and stores in DB.
   */
  scheduleJob(job: ScheduledJob): void {
    // Remove existing schedule if present
    this.unscheduleJob(job.id);

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
  }

  /**
   * Manually trigger a job. Returns the session ID on success.
   */
  async executeJob(jobId: string): Promise<string> {
    return this.onJobTriggered(jobId);
  }

  /**
   * Core execution flow when a job triggers.
   */
  private async onJobTriggered(jobId: string): Promise<string> {
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
      }

      // 3. Create session with explicit npub
      const sessionName = `[sched] ${job.name}`;
      const session = await this.deps.createSession(
        job.agent as AgentType,
        job.workingDirectory,
        sessionName,
        { type: "scheduler", id: job.id },
        undefined,
        job.userNpub,
      );

      // 4. Inject initial prompt
      this.deps.addPrompt(session.id, job.initialPrompt);

      // 5. Enable Night Watchman if configured
      if (job.nightwatchmanEnabled) {
        this.deps.nightWatchStore.enableSession(session.id);
      }

      // 6. Dispatch the prompt
      this.deps.dispatchPrompt(session);

      // 7. Update job and record success
      const now = new Date().toISOString();
      const cron = this.cronJobs.get(jobId);
      const nextRun = cron?.nextRun();
      this.deps.store.updateJob(jobId, {
        lastRunAt: now,
        nextRunAt: nextRun ? nextRun.toISOString() : undefined,
      });
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
