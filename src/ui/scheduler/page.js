/**
 * Scheduler Page
 *
 * Dedicated page for managing scheduled agent jobs.
 * Uses Alpine.js for reactive UI backed by Dexie IndexedDB cache.
 *
 * Exports initSchedulerPage({ showToast }) returning
 * { renderPage, ensureLoaded }.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { fetchSchedulerJobRuns } from "./api.js";

// ============================================================
// Schedule → cron helpers
// ============================================================

/** Build a cron expression from the friendly schedule fields. */
function buildCron(frequency, hour, minute, weekday) {
  const mm = String(minute);
  const hh = String(hour);
  switch (frequency) {
    case "every_minute":  return "* * * * *";
    case "every_5min":    return "*/5 * * * *";
    case "every_15min":   return "*/15 * * * *";
    case "every_30min":   return "*/30 * * * *";
    case "hourly":        return `${mm} * * * *`;
    case "every_6h":      return `${mm} */6 * * *`;
    case "daily":         return `${mm} ${hh} * * *`;
    case "weekdays":      return `${mm} ${hh} * * 1-5`;
    case "weekly":        return `${mm} ${hh} * * ${weekday}`;
    default:              return `${mm} ${hh} * * *`;
  }
}

/** Describe a cron expression in plain English. */
function describeCron(expr) {
  if (!expr) return "";
  const map = {
    "* * * * *": "Every minute",
    "*/5 * * * *": "Every 5 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
  };
  if (map[expr]) return map[expr];
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mm, hh, , , dow] = parts;
  const time = `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
  if (parts[1] === "*") return `Hourly at :${mm.padStart(2, "0")}`;
  if (parts[1].startsWith("*/")) return `Every ${parts[1].slice(2)}h at :${mm.padStart(2, "0")}`;
  const days = { "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" };
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (dow !== "*" && days[dow]) return `${days[dow]}s at ${time}`;
  if (dow === "*") return `Daily at ${time}`;
  return expr;
}

/** Check whether frequency needs a time picker. */
function frequencyNeedsTime(freq) {
  return ["hourly", "every_6h", "daily", "weekdays", "weekly"].includes(freq);
}

/** Check whether frequency needs hour picker (not just minute). */
function frequencyNeedsHour(freq) {
  return ["daily", "weekdays", "weekly"].includes(freq);
}

// ============================================================
// Page Module
// ============================================================

export function initSchedulerPage({ showToast }) {
  async function ensureLoaded() {
    const store = Alpine.store("scheduler");
    if (store) {
      await store.init();
    }
  }

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-scheduler-page wm-page";
    page.setAttribute("x-data", "schedulerPage");
    page.innerHTML = getPageTemplate();
    return page;
  }

  Alpine.data("schedulerPage", () => ({
    // Create form state
    showForm: false,
    triggerType: "cron",
    form: {
      name: "",
      agent: "claude",
      workingDirectory: "",
      initialPrompt: "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      nightwatchmanEnabled: true,
      watchDirectory: "",
      filePattern: "*",
    },
    // Schedule picker state (separate from form to keep API payload clean)
    sched: {
      frequency: "daily",
      hour: 9,
      minute: 0,
      weekday: "1", // Monday
    },
    submitting: false,

    // Run history
    runsJobId: null,
    runs: [],
    loadingRuns: false,

    get isCron() {
      return this.triggerType === "cron";
    },

    get computedCron() {
      return buildCron(this.sched.frequency, this.sched.hour, this.sched.minute, this.sched.weekday);
    },

    get cronDescription() {
      return describeCron(this.computedCron);
    },

    get needsTime() {
      return frequencyNeedsTime(this.sched.frequency);
    },

    get needsHour() {
      return frequencyNeedsHour(this.sched.frequency);
    },

    get needsWeekday() {
      return this.sched.frequency === "weekly";
    },

    async refresh() {
      await this.$store.scheduler.sync();
      showToast("Refreshed");
    },

    resetForm() {
      this.triggerType = "cron";
      this.form = {
        name: "",
        agent: "claude",
        workingDirectory: "",
        initialPrompt: "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        nightwatchmanEnabled: true,
        watchDirectory: "",
        filePattern: "*",
      };
      this.sched = { frequency: "daily", hour: 9, minute: 0, weekday: "1" };
    },

    async submitJob() {
      if (this.submitting) return;
      this.submitting = true;
      try {
        const payload = {
          name: this.form.name,
          agent: this.form.agent,
          workingDirectory: this.form.workingDirectory,
          initialPrompt: this.form.initialPrompt,
          nightwatchmanEnabled: this.form.nightwatchmanEnabled,
          triggerType: this.triggerType,
        };
        if (this.triggerType === "cron") {
          payload.cronExpression = this.computedCron;
          payload.timezone = this.form.timezone;
        } else {
          payload.watchDirectory = this.form.watchDirectory;
          payload.filePattern = this.form.filePattern;
        }
        await this.$store.scheduler.create(payload);
        this.showForm = false;
        this.resetForm();
      } catch { /* store shows toast */ }
      this.submitting = false;
    },

    async toggleEnabled(job) {
      try {
        await this.$store.scheduler.toggleEnabled(job.id, !job.enabled);
      } catch { /* store shows toast */ }
    },

    async triggerJob(job) {
      try {
        await this.$store.scheduler.trigger(job.id);
      } catch { /* store shows toast */ }
    },

    async deleteJob(job) {
      if (!confirm(`Delete trigger "${job.name}"?`)) return;
      await this.$store.scheduler.remove(job.id);
    },

    async showRuns(job) {
      this.runsJobId = job.id;
      this.loadingRuns = true;
      try {
        const data = await fetchSchedulerJobRuns(job.id);
        this.runs = data.runs || [];
      } catch (err) {
        showToast(`Failed to load runs: ${err.message}`, { type: "error" });
        this.runs = [];
      }
      this.loadingRuns = false;
    },

    closeRuns() {
      this.runsJobId = null;
      this.runs = [];
    },

    formatTime(iso) {
      return this.$store.scheduler.formatTime(iso);
    },

    describeJobCron(expr) {
      return describeCron(expr);
    },

    describeTrigger(job) {
      if (job.triggerType === "file_watcher") {
        const pat = job.filePattern && job.filePattern !== "*" ? ` (${job.filePattern})` : "";
        return `Watching: ${job.watchDirectory}${pat}`;
      }
      return describeCron(job.cronExpression);
    },

    statusColor(status) {
      if (status === "success") return "#22c55e";
      if (status === "error") return "#ef4444";
      return "#eab308";
    },
  }));

  return { renderPage, ensureLoaded };
}

// ============================================================
// Hour / minute option generators (used in template)
// ============================================================

function hourOptions() {
  let opts = "";
  for (let h = 0; h < 24; h++) {
    const label = String(h).padStart(2, "0");
    opts += `<option value="${h}">${label}</option>`;
  }
  return opts;
}

function minuteOptions() {
  let opts = "";
  for (let m = 0; m < 60; m += 5) {
    const label = String(m).padStart(2, "0");
    opts += `<option value="${m}">${label}</option>`;
  }
  return opts;
}

// ============================================================
// Alpine HTML Template
// ============================================================

function getPageTemplate() {
  return `
  <!-- Header -->
  <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
    <h2 style="margin: 0; flex: 1;">Triggers</h2>
    <button type="button" class="wm-btn wm-btn--sm" @click="refresh()">Refresh</button>
    <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="showForm = !showForm">
      <span x-text="showForm ? 'Cancel' : '+ New Trigger'"></span>
    </button>
  </div>

  <!-- Create Form -->
  <template x-if="showForm">
    <div style="background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">

      <!-- Trigger Type Selector -->
      <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem;">
        <button type="button" class="wm-btn wm-btn--sm"
          :class="isCron ? 'wm-btn--primary' : ''"
          @click="triggerType = 'cron'">Schedule</button>
        <button type="button" class="wm-btn wm-btn--sm"
          :class="!isCron ? 'wm-btn--primary' : ''"
          @click="triggerType = 'file_watcher'">File Watcher</button>
      </div>

      <!-- Row 1: Name + Agent -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
        <div class="wm-form-group">
          <label>Trigger Name</label>
          <input type="text" class="wm-input" x-model="form.name" placeholder="e.g. Daily code review">
        </div>
        <div class="wm-form-group">
          <label>Agent</label>
          <select class="wm-select" x-model="form.agent">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="goose">Goose</option>
            <option value="opencode">OpenCode</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
      </div>

      <!-- Row 2: Working Directory -->
      <div class="wm-form-group" style="margin-top: 0.75rem;">
        <label>Working Directory</label>
        <input type="text" class="wm-input" x-model="form.workingDirectory" placeholder="/path/to/project">
      </div>

      <!-- Row 3a: Schedule Picker (cron only) -->
      <template x-if="isCron">
        <div style="margin-top: 0.75rem;">
          <label style="font-weight: 600; font-size: 0.85rem; display: block; margin-bottom: 0.25rem;">Schedule</label>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <select class="wm-select" x-model="sched.frequency">
              <option value="every_minute">Every minute</option>
              <option value="every_5min">Every 5 minutes</option>
              <option value="every_15min">Every 15 minutes</option>
              <option value="every_30min">Every 30 minutes</option>
              <option value="hourly">Hourly</option>
              <option value="every_6h">Every 6 hours</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
            </select>
            <template x-if="needsWeekday">
              <select class="wm-select" x-model="sched.weekday">
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                <option value="0">Sunday</option>
              </select>
            </template>
            <template x-if="needsTime">
              <span style="font-size: 0.85rem; color: var(--text-secondary);">at</span>
            </template>
            <template x-if="needsHour">
              <select class="wm-select" x-model.number="sched.hour">
                ${hourOptions()}
              </select>
            </template>
            <template x-if="needsHour">
              <span style="font-size: 0.85rem; color: var(--text-secondary);">:</span>
            </template>
            <template x-if="needsTime">
              <select class="wm-select" x-model.number="sched.minute">
                ${minuteOptions()}
              </select>
            </template>
          </div>
          <small style="color: var(--text-secondary); margin-top: 4px; display: block;" x-text="cronDescription"></small>
        </div>
      </template>

      <!-- Row 3b: File Watcher fields -->
      <template x-if="!isCron">
        <div style="margin-top: 0.75rem;">
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 0.75rem;">
            <div class="wm-form-group">
              <label>Watch Directory</label>
              <input type="text" class="wm-input" x-model="form.watchDirectory" placeholder="/path/to/watch">
            </div>
            <div class="wm-form-group">
              <label>File Pattern</label>
              <input type="text" class="wm-input" x-model="form.filePattern" placeholder="*.json">
            </div>
          </div>
        </div>
      </template>

      <!-- Row 4: Initial Prompt -->
      <div class="wm-form-group" style="margin-top: 0.75rem;">
        <label>Initial Prompt</label>
        <textarea class="wm-input" x-model="form.initialPrompt" rows="4" placeholder="What should the agent do?"></textarea>
      </div>

      <!-- Row 5: Night Watchman + Timezone -->
      <div style="display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem; flex-wrap: wrap;">
        <label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; cursor: pointer;">
          <input type="checkbox" x-model="form.nightwatchmanEnabled">
          <span style="font-weight: 600;">Enable Night Watchman</span>
        </label>
        <template x-if="isCron">
          <div style="margin-left: auto; display: flex; align-items: center; gap: 0.4rem;">
            <span style="font-size: 0.8rem; color: var(--text-secondary);">TZ:</span>
            <input type="text" class="wm-input" style="width: 10rem;" x-model="form.timezone">
          </div>
        </template>
      </div>

      <!-- Submit row -->
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; border-top: 1px solid var(--border-primary); padding-top: 0.75rem;">
        <button type="button" class="wm-btn wm-btn--sm" @click="showForm = false; resetForm()">Cancel</button>
        <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="submitJob()"
          :disabled="submitting || !form.name || !form.workingDirectory || !form.initialPrompt || (!isCron && !form.watchDirectory)">
          <span x-text="submitting ? 'Creating\u2026' : 'Create Trigger'"></span>
        </button>
      </div>
    </div>
  </template>

  <!-- Loading -->
  <template x-if="$store.scheduler.loading">
    <p style="color: var(--text-secondary);">Loading\u2026</p>
  </template>

  <!-- Empty state -->
  <template x-if="!$store.scheduler.loading && $store.scheduler.jobs.length === 0 && !showForm">
    <p style="color: var(--text-secondary);">No triggers yet. Create one to get started.</p>
  </template>

  <!-- Job list -->
  <div style="display: flex; flex-direction: column; gap: 0.5rem;">
    <template x-for="job in $store.scheduler.jobs" :key="job.id">
      <div style="background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 0.75rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <!-- Enable toggle -->
          <button
            type="button"
            class="wm-btn wm-btn--sm"
            :style="'min-width: 2.5rem; color: ' + (job.enabled ? '#22c55e' : '#6b7280')"
            @click="toggleEnabled(job)"
            :title="job.enabled ? 'Disable' : 'Enable'"
            x-text="job.enabled ? 'ON' : 'OFF'"
          ></button>

          <!-- Job info -->
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: baseline; gap: 0.5rem;">
              <strong x-text="job.name" style="font-size: 0.95rem;"></strong>
              <span x-text="job.agent" style="font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase;"></span>
              <span x-text="describeTrigger(job)" style="font-size: 0.75rem; color: var(--accent-primary);"></span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
              <span x-text="job.workingDirectory" style="opacity: 0.8;"></span>
              <template x-if="job.nextRunAt && job.triggerType !== 'file_watcher'">
                <span> &middot; Next: <span x-text="formatTime(job.nextRunAt)"></span></span>
              </template>
              <template x-if="job.lastRunAt">
                <span> &middot; Last: <span x-text="formatTime(job.lastRunAt)"></span></span>
              </template>
            </div>
          </div>

          <!-- Actions -->
          <button type="button" class="wm-btn wm-btn--sm" @click="showRuns(job)" title="View runs">Runs</button>
          <button type="button" class="wm-btn wm-btn--sm" @click="triggerJob(job)" title="Run now">Trigger</button>
          <button type="button" class="wm-btn wm-btn--sm wm-btn--danger" @click="deleteJob(job)" title="Delete">&times;</button>
        </div>

        <!-- Prompt preview -->
        <details style="margin-top: 0.5rem;">
          <summary style="cursor: pointer; font-size: 0.8rem; color: var(--text-secondary);">Prompt</summary>
          <pre style="font-size: 0.8rem; white-space: pre-wrap; margin: 0.25rem 0 0; padding: 0.5rem; background: var(--bg-primary); border-radius: 4px; max-height: 200px; overflow: auto;" x-text="job.initialPrompt"></pre>
        </details>
      </div>
    </template>
  </div>

  <!-- Run History Panel -->
  <template x-if="runsJobId">
    <div style="margin-top: 1rem; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 0.75rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
        <strong>Run History</strong>
        <button type="button" class="wm-btn wm-btn--sm" @click="closeRuns()">Close</button>
      </div>
      <template x-if="loadingRuns">
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Loading\u2026</p>
      </template>
      <template x-if="!loadingRuns && runs.length === 0">
        <p style="color: var(--text-secondary); font-size: 0.85rem;">No runs yet.</p>
      </template>
      <template x-if="!loadingRuns && runs.length > 0">
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <template x-for="run in runs" :key="run.id">
            <div style="display: flex; align-items: center; gap: 0.75rem; font-size: 0.85rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border-primary);">
              <span :style="'color: ' + statusColor(run.status) + '; font-weight: 600;'" x-text="run.status"></span>
              <span x-text="formatTime(run.startedAt)" style="color: var(--text-secondary);"></span>
              <template x-if="run.sessionId">
                <a :href="'/live/' + run.sessionId"
                   style="font-family: monospace; font-size: 0.75rem; color: var(--accent-primary); text-decoration: none;"
                   x-text="run.sessionId.slice(0, 8) + '\u2026'"
                   title="Open session"></a>
              </template>
              <template x-if="run.errorMessage">
                <span style="color: #ef4444; font-size: 0.8rem;" x-text="run.errorMessage"></span>
              </template>
            </div>
          </template>
        </div>
      </template>
    </div>
  </template>
  `;
}
