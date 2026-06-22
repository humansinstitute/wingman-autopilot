/**
 * Scheduler Engine
 *
 * Loads enabled jobs from SQLite, schedules them via croner, and on trigger:
 *   1. Uses the shared Wingman instance identity
 *   2. Creates a session with the requesting operator npub for audit
 *   3. Injects the initial prompt
 *   4. Enables Night Watchman if configured
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { Cron } from "croner";

import type { SchedulerStore, ScheduledJob } from "./scheduler-store";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { NightWatchStore } from "../nightwatch/nightwatch-store";
import type { AgentType } from "../config";
import type { SessionSnapshot, SessionOrigin } from "../agents/process-manager";
import type { SessionMetadataInput } from "../sessions/session-metadata";
import type { JsonObject } from "../pipelines/pipeline-store";

// ============================================================
// Types
// ============================================================

export interface SchedulerEngineDeps {
  store: SchedulerStore;
  nightWatchStore: NightWatchStore;
  createSession: (
    agent: AgentType,
    dir: string,
    name: string,
    origin: SessionOrigin,
    targetFile: string | undefined,
    explicitNpub: string,
    metadata?: SessionMetadataInput,
  ) => Promise<SessionSnapshot>;
  addPrompt: (sessionId: string, content: string) => void;
  dispatchPrompt: (session: SessionSnapshot) => void;
  awaitSessionReadyForPrompt?: (session: SessionSnapshot, agent: AgentType) => Promise<void>;
  runPipeline?: (job: ScheduledJob, input: JsonObject, onRunCreated?: (pipelineRunId: string) => void, pipelineAgent?: string) => Promise<string>;
  cleanupStopNextActionSessions?: (job: ScheduledJob) => Promise<SchedulerCleanupResult>;
  onBotKeyUnlocked?: (npub: string, secretKey: Uint8Array, botPubkeyHex: string) => void;
  getInstanceIdentity?: () => WingmanInstanceIdentity | null;
}

export interface SchedulerExecutionResult {
  sessionId?: string;
  pipelineRunId?: string;
  cleanup?: SchedulerCleanupResult;
}

export interface SchedulerCleanupResult {
  checked: number;
  matched: number;
  stopped: number;
  archiveScheduled: number;
  failed: number;
}

// ============================================================
// Engine
// ============================================================

/**
 * Check whether the current time (in the given timezone) falls within an
 * active time window defined by HH:MM start/end strings.
 * Handles overnight windows where start > end (e.g. 22:00–05:00).
 * Returns true if no window is configured (both null).
 */
function isWithinActiveWindow(
  startTime: string | null,
  endTime: string | null,
  timezone: string,
): boolean {
  if (!startTime || !endTime) return true;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone || "UTC",
  });
  const nowStr = formatter.format(now); // "HH:MM"
  const [nowH = 0, nowM = 0] = nowStr.split(":").map(Number);
  const nowMinutes = nowH * 60 + nowM;

  const [startH = 0, startM = 0] = startTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;

  const [endH = 0, endM = 0] = endTime.split(":").map(Number);
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day window: e.g. 09:00–17:00
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Overnight window: e.g. 22:00–05:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

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
      // Nostr triggers need the bot key in memory so the listener can decrypt payloads.
      // Best-effort unlock here allows triggers to work even with no active user session.
      void this.ensureNostrTriggerUnlocked(job);
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
   * Manually trigger a job. Returns the created session or pipeline run ID.
   */
  async executeJob(jobId: string): Promise<SchedulerExecutionResult> {
    return this.onJobTriggered(jobId);
  }

  private async ensureNostrTriggerUnlocked(job: ScheduledJob): Promise<void> {
    const identity = this.deps.getInstanceIdentity?.() ?? null;
    if (identity) {
      this.deps.onBotKeyUnlocked?.(job.userNpub, identity.secretKey, identity.pubkeyHex);
      console.log(`[scheduler] Nostr trigger listener armed for job "${job.name}" (${job.id})`);
      return;
    }

    console.warn(`[scheduler] WINGMAN_PRIV not configured; nostr trigger "${job.name}" (${job.id}) is not armed`);
  }

  /**
   * Trigger a job with an appended message (used by Nostr triggers).
   * Composes the prompt as `initialPrompt + "\n\n" + message`.
   */
  async executeJobWithMessage(jobId: string, message?: string): Promise<SchedulerExecutionResult> {
    const job = this.deps.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const promptOverride = message
      ? job.actionType === "pipeline"
        ? message
        : `${job.initialPrompt}\n\n${message}`
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
  ): Promise<SchedulerExecutionResult> {
    // Reload job from DB to get latest state
    const job = this.deps.store.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!job.enabled) {
      throw new Error(`Job ${jobId} is disabled`);
    }

    // Skip if outside the active time window (only for automatic triggers, not manual)
    if (!promptOverride && !originOverride) {
      if (!isWithinActiveWindow(job.activeStartTime, job.activeEndTime, job.timezone)) {
        console.log(`[scheduler] Job "${job.name}" skipped — outside active window (${job.activeStartTime}–${job.activeEndTime})`);
        return {};
      }
    }

    const runId = this.deps.store.recordRun(jobId);
    let linkedPipelineRunId: string | undefined;

    try {
      if (job.actionType === "cleanup") {
        const cleanup = await this.runCleanupAction(job);
        this.updateJobAfterSuccess(jobId);
        this.deps.store.completeRun(
          runId,
          cleanup.failed > 0 ? "error" : "success",
          undefined,
          cleanup.failed > 0 ? `Cleanup failed for ${cleanup.failed} session(s)` : undefined,
        );
        console.log(`[scheduler] Job "${job.name}" triggered — cleaned up ${cleanup.stopped}/${cleanup.matched} session(s)`);
        return { cleanup };
      }

      const instanceIdentity = this.deps.getInstanceIdentity?.() ?? null;
      if (!instanceIdentity) {
        throw new Error("WINGMAN_PRIV is required to execute scheduled jobs");
      }

      if (job.actionType === "pipeline") {
        const pipelineRunId = await this.runPipelineAction(job, promptOverride, (createdPipelineRunId) => {
          linkedPipelineRunId = createdPipelineRunId;
          this.deps.store.linkPipelineRun(runId, createdPipelineRunId);
        });
        linkedPipelineRunId = pipelineRunId;
        this.updateJobAfterSuccess(jobId);
        this.deps.store.completeRun(runId, "success", undefined, undefined, pipelineRunId);
        console.log(`[scheduler] Job "${job.name}" triggered — pipeline run ${pipelineRunId}`);
        return { pipelineRunId };
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
        { AGENT: true },
      );

      // 4. Wait for steady runtime readiness before prompt injection
      if (this.deps.awaitSessionReadyForPrompt) {
        await this.deps.awaitSessionReadyForPrompt(session, job.agent as AgentType);
      }

      // 5. Inject initial prompt (or override)
      this.deps.addPrompt(session.id, promptOverride ?? job.initialPrompt);

      // 6. Enable Night Watchman if configured
      if (job.nightwatchmanEnabled) {
        this.deps.nightWatchStore.enableSession(session.id);
      }

      // 7. Dispatch the prompt
      this.deps.dispatchPrompt(session);

      // 8. Update job and record success
      this.updateJobAfterSuccess(jobId);
      this.deps.store.completeRun(runId, "success", session.id);

      console.log(`[scheduler] Job "${job.name}" triggered — session ${session.id}`);
      return { sessionId: session.id };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.deps.store.completeRun(runId, "error", undefined, message, linkedPipelineRunId);
      console.error(`[scheduler] Job "${job.name}" failed: ${message}`);
      throw err;
    }
  }

  private async runPipelineAction(
    job: ScheduledJob,
    triggerMessage?: string,
    onRunCreated?: (pipelineRunId: string) => void,
  ): Promise<string> {
    if (!this.deps.runPipeline) {
      throw new Error("Scheduler pipeline execution is not configured");
    }
    if (!job.pipelineDefinitionId) {
      throw new Error("Pipeline trigger has no pipeline definition selected");
    }
    const parsed = job.pipelineInputJson ? JSON.parse(job.pipelineInputJson) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pipeline trigger input must be a JSON object");
    }
    const input = { ...(parsed as JsonObject) };
    if (triggerMessage) {
      input.triggerMessage = triggerMessage;
    }
    const pipelineAgent = job.pipelineAgent?.trim() || undefined;
    return this.deps.runPipeline(job, input, onRunCreated, pipelineAgent);
  }

  private async runCleanupAction(job: ScheduledJob): Promise<SchedulerCleanupResult> {
    if (!this.deps.cleanupStopNextActionSessions) {
      throw new Error("Scheduler cleanup execution is not configured");
    }
    return this.deps.cleanupStopNextActionSessions(job);
  }

  private updateJobAfterSuccess(jobId: string): void {
    const now = new Date().toISOString();
    const updateFields: Record<string, unknown> = { lastRunAt: now };
    const cron = this.cronJobs.get(jobId);
    if (cron) {
      const nextRun = cron.nextRun();
      if (nextRun) updateFields.nextRunAt = nextRun.toISOString();
    }
    this.deps.store.updateJob(jobId, updateFields);
  }
}

export { SchedulerEngine };
