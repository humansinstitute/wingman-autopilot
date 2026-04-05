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
import { attachDirAutocomplete } from "./dir-autocomplete.js";

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
    case "every_2h":      return `${mm} */2 * * *`;
    case "every_3h":      return `${mm} */3 * * *`;
    case "every_4h":      return `${mm} */4 * * *`;
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
  return ["hourly", "every_2h", "every_3h", "every_4h", "every_6h", "daily", "weekdays", "weekly"].includes(freq);
}

/** Check whether frequency needs hour picker (not just minute). */
function frequencyNeedsHour(freq) {
  return ["daily", "weekdays", "weekly"].includes(freq);
}

/** Parse a cron expression back into friendly schedule picker fields. */
function parseCron(expr) {
  if (!expr) return { frequency: "daily", hour: 9, minute: 0, weekday: "1" };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: "daily", hour: 9, minute: 0, weekday: "1" };
  const [mm, hh, , , dow] = parts;

  // Fixed-interval patterns
  if (expr === "* * * * *") return { frequency: "every_minute", hour: 9, minute: 0, weekday: "1" };
  if (expr === "*/5 * * * *") return { frequency: "every_5min", hour: 9, minute: 0, weekday: "1" };
  if (expr === "*/15 * * * *") return { frequency: "every_15min", hour: 9, minute: 0, weekday: "1" };
  if (expr === "*/30 * * * *") return { frequency: "every_30min", hour: 9, minute: 0, weekday: "1" };

  const minute = parseInt(mm, 10) || 0;
  const hour = parseInt(hh, 10) || 9;

  if (hh === "*") return { frequency: "hourly", hour: 9, minute, weekday: "1" };
  if (hh === "*/2") return { frequency: "every_2h", hour: 9, minute, weekday: "1" };
  if (hh === "*/3") return { frequency: "every_3h", hour: 9, minute, weekday: "1" };
  if (hh === "*/4") return { frequency: "every_4h", hour: 9, minute, weekday: "1" };
  if (hh === "*/6") return { frequency: "every_6h", hour: 9, minute, weekday: "1" };
  if (hh.startsWith("*/")) return { frequency: "every_6h", hour: 9, minute, weekday: "1" };
  if (dow === "1-5") return { frequency: "weekdays", hour, minute, weekday: "1" };
  if (dow !== "*") return { frequency: "weekly", hour, minute, weekday: dow };
  return { frequency: "daily", hour, minute, weekday: "1" };
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
    // Autocomplete cleanup handles
    _acCleanups: [],

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
      activeStartTime: "",
      activeEndTime: "",
    },
    // Schedule picker state (separate from form to keep API payload clean)
    sched: {
      frequency: "daily",
      hour: 9,
      minute: 0,
      weekday: "1", // Monday
    },
    submitting: false,

    // Edit state
    editingJobId: null,
    editTriggerType: "cron",
    editForm: {},
    editSched: {},
    editSubmitting: false,

    // Run history
    runsJobId: null,
    runs: [],
    loadingRuns: false,

    get isCron() {
      return this.triggerType === "cron";
    },

    get isNostr() {
      return this.triggerType === "nostr";
    },

    get isFileWatcher() {
      return this.triggerType === "file_watcher";
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

    init() {
      // Watch showForm toggle to attach/detach autocomplete on create form
      this.$watch("showForm", (open) => {
        if (open) {
          this.$nextTick(() => this._attachCreateAC());
        } else {
          this._detachAC();
        }
      });
      // Re-attach when trigger type changes (watch dir input appears/disappears)
      this.$watch("triggerType", () => {
        if (this.showForm) {
          this.$nextTick(() => this._attachCreateAC());
        }
      });
      // Watch editingJobId to attach/detach autocomplete on edit form
      this.$watch("editingJobId", (id) => {
        if (id) {
          this.$nextTick(() => this._attachEditAC());
        } else {
          this._detachAC();
        }
      });
      // Re-attach when edit trigger type changes
      this.$watch("editTriggerType", () => {
        if (this.editingJobId) {
          this.$nextTick(() => this._attachEditAC());
        }
      });
    },

    _attachCreateAC() {
      this._detachAC();
      const root = this.$el;
      const workDirInput = root.querySelector("[data-ac='create-workdir']");
      const workDirList = root.querySelector("[data-ac='create-workdir-list']");
      if (workDirInput && workDirList) {
        this._acCleanups.push(attachDirAutocomplete(workDirInput, workDirList));
      }
      const watchDirInput = root.querySelector("[data-ac='create-watchdir']");
      const watchDirList = root.querySelector("[data-ac='create-watchdir-list']");
      if (watchDirInput && watchDirList) {
        this._acCleanups.push(attachDirAutocomplete(watchDirInput, watchDirList));
      }
    },

    _attachEditAC() {
      this._detachAC();
      const root = this.$el;
      const workDirInput = root.querySelector("[data-ac='edit-workdir']");
      const workDirList = root.querySelector("[data-ac='edit-workdir-list']");
      if (workDirInput && workDirList) {
        this._acCleanups.push(attachDirAutocomplete(workDirInput, workDirList));
      }
      const watchDirInput = root.querySelector("[data-ac='edit-watchdir']");
      const watchDirList = root.querySelector("[data-ac='edit-watchdir-list']");
      if (watchDirInput && watchDirList) {
        this._acCleanups.push(attachDirAutocomplete(watchDirInput, watchDirList));
      }
    },

    _detachAC() {
      this._acCleanups.forEach((fn) => fn());
      this._acCleanups = [];
    },

    get editIsCron() {
      return this.editTriggerType === "cron";
    },

    get editIsNostr() {
      return this.editTriggerType === "nostr";
    },

    get editIsFileWatcher() {
      return this.editTriggerType === "file_watcher";
    },

    get editComputedCron() {
      return buildCron(this.editSched.frequency, this.editSched.hour, this.editSched.minute, this.editSched.weekday);
    },

    get editCronDescription() {
      return describeCron(this.editComputedCron);
    },

    get editNeedsTime() {
      return frequencyNeedsTime(this.editSched.frequency);
    },

    get editNeedsHour() {
      return frequencyNeedsHour(this.editSched.frequency);
    },

    get editNeedsWeekday() {
      return this.editSched.frequency === "weekly";
    },

    startEdit(job) {
      this.editingJobId = job.id;
      this.editTriggerType = job.triggerType || "cron";
      this.editForm = {
        name: job.name,
        agent: job.agent,
        workingDirectory: job.workingDirectory,
        initialPrompt: job.initialPrompt,
        timezone: job.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        nightwatchmanEnabled: !!job.nightwatchmanEnabled,
        watchDirectory: job.watchDirectory || "",
        filePattern: job.filePattern || "*",
        activeStartTime: job.activeStartTime || "",
        activeEndTime: job.activeEndTime || "",
      };
      this.editSched = parseCron(job.cronExpression);
    },

    cancelEdit() {
      this.editingJobId = null;
      this.editForm = {};
      this.editSched = {};
    },

    async saveEdit() {
      if (this.editSubmitting) return;
      this.editSubmitting = true;
      try {
        const payload = {
          name: this.editForm.name,
          agent: this.editForm.agent,
          workingDirectory: this.editForm.workingDirectory,
          initialPrompt: this.editForm.initialPrompt,
          nightwatchmanEnabled: this.editForm.nightwatchmanEnabled,
          triggerType: this.editTriggerType,
        };
        if (this.editTriggerType === "cron") {
          payload.cronExpression = this.editComputedCron;
          payload.timezone = this.editForm.timezone;
        } else if (this.editTriggerType === "file_watcher") {
          payload.watchDirectory = this.editForm.watchDirectory;
          payload.filePattern = this.editForm.filePattern;
        }
        // Active window
        if (this.editForm.activeStartTime && this.editForm.activeEndTime) {
          payload.activeStartTime = this.editForm.activeStartTime;
          payload.activeEndTime = this.editForm.activeEndTime;
        } else {
          payload.activeStartTime = null;
          payload.activeEndTime = null;
        }
        await this.$store.scheduler.update(this.editingJobId, payload);
        this.editingJobId = null;
        this.editForm = {};
        this.editSched = {};
      } catch { /* store shows toast */ }
      this.editSubmitting = false;
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
        activeStartTime: "",
        activeEndTime: "",
      };
      this.sched = { frequency: "daily", hour: 9, minute: 0, weekday: "1" };
      this._detachAC();
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
        } else if (this.triggerType === "file_watcher") {
          payload.watchDirectory = this.form.watchDirectory;
          payload.filePattern = this.form.filePattern;
        }
        // Active window (applies to cron and file_watcher)
        if (this.form.activeStartTime && this.form.activeEndTime) {
          payload.activeStartTime = this.form.activeStartTime;
          payload.activeEndTime = this.form.activeEndTime;
        }
        // nostr triggers need no extra fields
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
      if (job.triggerType === "nostr") return "Nostr Remote Trigger";
      if (job.triggerType === "file_watcher") {
        const pat = job.filePattern && job.filePattern !== "*" ? ` (${job.filePattern})` : "";
        return `Watching: ${job.watchDirectory}${pat}`;
      }
      let desc = describeCron(job.cronExpression);
      if (job.activeStartTime && job.activeEndTime) {
        desc += ` (${job.activeStartTime}\u2013${job.activeEndTime})`;
      }
      return desc;
    },

    async copyToClipboard(text, label) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`${label} copied`);
      } catch {
        showToast("Copy failed", { type: "error" });
      }
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
  <div class="wm-scheduler-header">
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
          :class="triggerType === 'cron' ? 'wm-btn--primary' : ''"
          @click="triggerType = 'cron'">Schedule</button>
        <button type="button" class="wm-btn wm-btn--sm"
          :class="triggerType === 'file_watcher' ? 'wm-btn--primary' : ''"
          @click="triggerType = 'file_watcher'">File Watcher</button>
        <button type="button" class="wm-btn wm-btn--sm"
          :class="triggerType === 'nostr' ? 'wm-btn--primary' : ''"
          @click="triggerType = 'nostr'">Nostr</button>
      </div>

      <!-- Row 1: Name + Agent -->
      <div class="wm-scheduler-grid-two">
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
        <input type="text" class="wm-input" x-model="form.workingDirectory" placeholder="/path/to/project"
          data-ac="create-workdir" list="create-workdir-suggestions" autocomplete="off">
        <datalist id="create-workdir-suggestions" data-ac="create-workdir-list"></datalist>
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
              <option value="every_2h">Every 2 hours</option>
              <option value="every_3h">Every 3 hours</option>
              <option value="every_4h">Every 4 hours</option>
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
      <template x-if="isFileWatcher">
        <div style="margin-top: 0.75rem;">
          <div class="wm-scheduler-grid-split">
            <div class="wm-form-group">
              <label>Watch Directory</label>
              <input type="text" class="wm-input" x-model="form.watchDirectory" placeholder="/path/to/watch"
                data-ac="create-watchdir" list="create-watchdir-suggestions" autocomplete="off">
              <datalist id="create-watchdir-suggestions" data-ac="create-watchdir-list"></datalist>
            </div>
            <div class="wm-form-group">
              <label>File Pattern</label>
              <input type="text" class="wm-input" x-model="form.filePattern" placeholder="*.json">
            </div>
          </div>
        </div>
      </template>

      <!-- Row 3c: Nostr info -->
      <template x-if="isNostr">
        <div style="margin-top: 0.75rem; padding: 0.75rem; background: var(--bg-primary); border-radius: 6px; border: 1px solid var(--border-primary);">
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin: 0;">
            Nostr triggers are activated by publishing a <strong>kind 9256</strong> event encrypted to your bot's pubkey.
            After creating this trigger, you'll see the Trigger ID and Bot Pubkey needed to fire it remotely.
          </p>
        </div>
      </template>

      <!-- Active Window (cron and file_watcher only) -->
      <template x-if="!isNostr">
        <div style="margin-top: 0.75rem;">
          <label style="font-weight: 600; font-size: 0.85rem; display: block; margin-bottom: 0.25rem;">Active Window <span style="font-weight: 400; color: var(--text-secondary);">(optional)</span></label>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <input type="time" class="wm-input" style="width: 8rem;" x-model="form.activeStartTime" placeholder="HH:MM">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">to</span>
            <input type="time" class="wm-input" style="width: 8rem;" x-model="form.activeEndTime" placeholder="HH:MM">
          </div>
          <small style="color: var(--text-secondary); margin-top: 4px; display: block;">
            <template x-if="form.activeStartTime && form.activeEndTime">
              <span x-text="'Only fires between ' + form.activeStartTime + ' and ' + form.activeEndTime + ' (' + form.timezone + ')'"></span>
            </template>
            <template x-if="!form.activeStartTime || !form.activeEndTime">
              <span>Leave empty to run at any time. Set to restrict when the trigger fires.</span>
            </template>
          </small>
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
          <div class="wm-scheduler-timezone">
            <span style="font-size: 0.8rem; color: var(--text-secondary);">TZ:</span>
            <input type="text" class="wm-input wm-scheduler-timezone-input" x-model="form.timezone">
          </div>
        </template>
      </div>

      <!-- Submit row -->
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; border-top: 1px solid var(--border-primary); padding-top: 0.75rem;">
        <button type="button" class="wm-btn wm-btn--sm" @click="showForm = false; resetForm()">Cancel</button>
        <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="submitJob()"
          :disabled="submitting || !form.name || !form.workingDirectory || !form.initialPrompt || (triggerType === 'file_watcher' && !form.watchDirectory)">
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
        <div class="wm-scheduler-job-row">
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
          <div class="wm-scheduler-job-info">
            <div style="display: flex; align-items: baseline; gap: 0.5rem;">
              <strong x-text="job.name" style="font-size: 0.95rem;"></strong>
              <span x-text="job.agent" style="font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase;"></span>
              <span x-text="describeTrigger(job)" style="font-size: 0.75rem; color: var(--accent-primary);"></span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
              <span x-text="job.workingDirectory" style="opacity: 0.8;"></span>
              <template x-if="job.nextRunAt && job.triggerType !== 'file_watcher' && job.triggerType !== 'nostr'">
                <span> &middot; Next: <span x-text="formatTime(job.nextRunAt)"></span></span>
              </template>
              <template x-if="job.lastRunAt">
                <span> &middot; Last: <span x-text="formatTime(job.lastRunAt)"></span></span>
              </template>
            </div>
          </div>

          <!-- Actions -->
          <button type="button" class="wm-btn wm-btn--sm" @click="startEdit(job)" title="Edit" x-show="editingJobId !== job.id">Edit</button>
          <button type="button" class="wm-btn wm-btn--sm" @click="showRuns(job)" title="View runs">Runs</button>
          <button type="button" class="wm-btn wm-btn--sm" @click="triggerJob(job)" title="Run now">Trigger</button>
          <button type="button" class="wm-btn wm-btn--sm wm-btn--danger" @click="deleteJob(job)" title="Delete">&times;</button>
        </div>

        <!-- Trigger Info (nostr jobs — always visible when not editing) -->
        <template x-if="job.triggerType === 'nostr' && editingJobId !== job.id">
          <div style="margin-top: 0.5rem; padding: 0.5rem 0.75rem; background: var(--bg-primary); border-radius: 6px; border: 1px solid var(--border-primary);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem;">
              <span style="font-size: 0.75rem; color: var(--text-secondary); min-width: 5rem;">Trigger ID</span>
              <code style="font-size: 0.75rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" x-text="job.id"></code>
              <button type="button" class="wm-btn wm-btn--sm" style="font-size: 0.7rem; padding: 2px 8px;"
                @click="copyToClipboard(job.id, 'Trigger ID')">Copy</button>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 0.75rem; color: var(--text-secondary); min-width: 5rem;">Bot Pubkey</span>
              <code style="font-size: 0.75rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" x-text="job.botPubkeyHex || 'Loading\u2026'"></code>
              <button type="button" class="wm-btn wm-btn--sm" style="font-size: 0.7rem; padding: 2px 8px;"
                @click="copyToClipboard(job.botPubkeyHex, 'Bot Pubkey')" :disabled="!job.botPubkeyHex">Copy</button>
            </div>
          </div>
        </template>

        <!-- Trigger ID (non-nostr jobs — collapsible) -->
        <template x-if="job.triggerType !== 'nostr' && editingJobId !== job.id">
          <div style="margin-top: 0.5rem;">
            <details>
              <summary style="cursor: pointer; font-size: 0.8rem; color: var(--text-secondary);">Trigger ID</summary>
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem; padding: 0.5rem; background: var(--bg-primary); border-radius: 4px;">
                <code style="font-size: 0.75rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" x-text="job.id"></code>
                <button type="button" class="wm-btn wm-btn--sm" style="font-size: 0.7rem; padding: 2px 8px;"
                  @click="copyToClipboard(job.id, 'Trigger ID')">Copy</button>
              </div>
            </details>
          </div>
        </template>

        <!-- Prompt preview (shown when NOT editing) -->
        <template x-if="editingJobId !== job.id">
          <details style="margin-top: 0.5rem;">
            <summary style="cursor: pointer; font-size: 0.8rem; color: var(--text-secondary);">Prompt</summary>
            <pre style="font-size: 0.8rem; white-space: pre-wrap; margin: 0.25rem 0 0; padding: 0.5rem; background: var(--bg-primary); border-radius: 4px; max-height: 200px; overflow: auto;" x-text="job.initialPrompt"></pre>
          </details>
        </template>

        <!-- Inline Edit Form -->
        <template x-if="editingJobId === job.id">
          <div style="margin-top: 0.75rem; border-top: 1px solid var(--border-primary); padding-top: 0.75rem;">

            <!-- Trigger Type Selector -->
            <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem;">
              <button type="button" class="wm-btn wm-btn--sm"
                :class="editTriggerType === 'cron' ? 'wm-btn--primary' : ''"
                @click="editTriggerType = 'cron'">Schedule</button>
              <button type="button" class="wm-btn wm-btn--sm"
                :class="editTriggerType === 'file_watcher' ? 'wm-btn--primary' : ''"
                @click="editTriggerType = 'file_watcher'">File Watcher</button>
              <button type="button" class="wm-btn wm-btn--sm"
                :class="editTriggerType === 'nostr' ? 'wm-btn--primary' : ''"
                @click="editTriggerType = 'nostr'">Nostr</button>
            </div>

            <!-- Row 1: Name + Agent -->
            <div class="wm-scheduler-grid-two">
              <div class="wm-form-group">
                <label>Trigger Name</label>
                <input type="text" class="wm-input" x-model="editForm.name">
              </div>
              <div class="wm-form-group">
                <label>Agent</label>
                <select class="wm-select" x-model="editForm.agent">
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
              <input type="text" class="wm-input" x-model="editForm.workingDirectory"
                data-ac="edit-workdir" list="edit-workdir-suggestions" autocomplete="off">
              <datalist id="edit-workdir-suggestions" data-ac="edit-workdir-list"></datalist>
            </div>

            <!-- Row 3a: Schedule Picker (cron only) -->
            <template x-if="editIsCron">
              <div style="margin-top: 0.75rem;">
                <label style="font-weight: 600; font-size: 0.85rem; display: block; margin-bottom: 0.25rem;">Schedule</label>
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                  <select class="wm-select" x-model="editSched.frequency">
                    <option value="every_minute">Every minute</option>
                    <option value="every_5min">Every 5 minutes</option>
                    <option value="every_15min">Every 15 minutes</option>
                    <option value="every_30min">Every 30 minutes</option>
                    <option value="hourly">Hourly</option>
                    <option value="every_2h">Every 2 hours</option>
                    <option value="every_3h">Every 3 hours</option>
                    <option value="every_4h">Every 4 hours</option>
                    <option value="every_6h">Every 6 hours</option>
                    <option value="daily">Daily</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekly">Weekly</option>
                  </select>
                  <template x-if="editNeedsWeekday">
                    <select class="wm-select" x-model="editSched.weekday">
                      <option value="1">Monday</option>
                      <option value="2">Tuesday</option>
                      <option value="3">Wednesday</option>
                      <option value="4">Thursday</option>
                      <option value="5">Friday</option>
                      <option value="6">Saturday</option>
                      <option value="0">Sunday</option>
                    </select>
                  </template>
                  <template x-if="editNeedsTime">
                    <span style="font-size: 0.85rem; color: var(--text-secondary);">at</span>
                  </template>
                  <template x-if="editNeedsHour">
                    <select class="wm-select" x-model.number="editSched.hour">
                      ${hourOptions()}
                    </select>
                  </template>
                  <template x-if="editNeedsHour">
                    <span style="font-size: 0.85rem; color: var(--text-secondary);">:</span>
                  </template>
                  <template x-if="editNeedsTime">
                    <select class="wm-select" x-model.number="editSched.minute">
                      ${minuteOptions()}
                    </select>
                  </template>
                </div>
                <small style="color: var(--text-secondary); margin-top: 4px; display: block;" x-text="editCronDescription"></small>
              </div>
            </template>

            <!-- Row 3b: File Watcher fields -->
            <template x-if="editIsFileWatcher">
              <div style="margin-top: 0.75rem;">
                <div class="wm-scheduler-grid-split">
                  <div class="wm-form-group">
                    <label>Watch Directory</label>
                    <input type="text" class="wm-input" x-model="editForm.watchDirectory"
                      data-ac="edit-watchdir" list="edit-watchdir-suggestions" autocomplete="off">
                    <datalist id="edit-watchdir-suggestions" data-ac="edit-watchdir-list"></datalist>
                  </div>
                  <div class="wm-form-group">
                    <label>File Pattern</label>
                    <input type="text" class="wm-input" x-model="editForm.filePattern">
                  </div>
                </div>
              </div>
            </template>

            <!-- Row 3c: Nostr info -->
            <template x-if="editIsNostr">
              <div style="margin-top: 0.75rem; padding: 0.75rem; background: var(--bg-primary); border-radius: 6px; border: 1px solid var(--border-primary);">
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin: 0;">
                  Nostr triggers are activated by publishing a <strong>kind 9256</strong> event encrypted to your bot's pubkey.
                </p>
              </div>
            </template>

            <!-- Active Window (cron and file_watcher only) -->
            <template x-if="!editIsNostr">
              <div style="margin-top: 0.75rem;">
                <label style="font-weight: 600; font-size: 0.85rem; display: block; margin-bottom: 0.25rem;">Active Window <span style="font-weight: 400; color: var(--text-secondary);">(optional)</span></label>
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                  <input type="time" class="wm-input" style="width: 8rem;" x-model="editForm.activeStartTime" placeholder="HH:MM">
                  <span style="font-size: 0.85rem; color: var(--text-secondary);">to</span>
                  <input type="time" class="wm-input" style="width: 8rem;" x-model="editForm.activeEndTime" placeholder="HH:MM">
                </div>
                <small style="color: var(--text-secondary); margin-top: 4px; display: block;">
                  <template x-if="editForm.activeStartTime && editForm.activeEndTime">
                    <span x-text="'Only fires between ' + editForm.activeStartTime + ' and ' + editForm.activeEndTime + ' (' + editForm.timezone + ')'"></span>
                  </template>
                  <template x-if="!editForm.activeStartTime || !editForm.activeEndTime">
                    <span>Leave empty to run at any time.</span>
                  </template>
                </small>
              </div>
            </template>

            <!-- Row 4: Initial Prompt -->
            <div class="wm-form-group" style="margin-top: 0.75rem;">
              <label>Initial Prompt</label>
              <textarea class="wm-input" x-model="editForm.initialPrompt" rows="4"></textarea>
            </div>

            <!-- Row 5: Night Watchman + Timezone -->
            <div style="display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem; flex-wrap: wrap;">
              <label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; cursor: pointer;">
                <input type="checkbox" x-model="editForm.nightwatchmanEnabled">
                <span style="font-weight: 600;">Enable Night Watchman</span>
              </label>
              <template x-if="editIsCron">
                <div class="wm-scheduler-timezone">
                  <span style="font-size: 0.8rem; color: var(--text-secondary);">TZ:</span>
                  <input type="text" class="wm-input wm-scheduler-timezone-input" x-model="editForm.timezone">
                </div>
              </template>
            </div>

            <!-- Save / Cancel -->
            <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; border-top: 1px solid var(--border-primary); padding-top: 0.75rem;">
              <button type="button" class="wm-btn wm-btn--sm" @click="cancelEdit()">Cancel</button>
              <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="saveEdit()"
                :disabled="editSubmitting || !editForm.name || !editForm.workingDirectory || !editForm.initialPrompt || (editTriggerType === 'file_watcher' && !editForm.watchDirectory)">
                <span x-text="editSubmitting ? 'Saving\u2026' : 'Save Changes'"></span>
              </button>
            </div>
          </div>
        </template>
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
