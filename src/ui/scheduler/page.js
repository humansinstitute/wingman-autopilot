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
    form: {
      name: "",
      agent: "claude",
      workingDirectory: "",
      initialPrompt: "",
      cronExpression: "",
      timezone: "UTC",
      nightwatchmanEnabled: true,
    },
    submitting: false,

    // Run history
    runsJobId: null,
    runs: [],
    loadingRuns: false,

    async refresh() {
      await this.$store.scheduler.sync();
      showToast("Refreshed");
    },

    resetForm() {
      this.form = {
        name: "",
        agent: "claude",
        workingDirectory: "",
        initialPrompt: "",
        cronExpression: "",
        timezone: "UTC",
        nightwatchmanEnabled: true,
      };
    },

    async submitJob() {
      if (this.submitting) return;
      this.submitting = true;
      try {
        await this.$store.scheduler.create(this.form);
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
      if (!confirm(`Delete scheduled job "${job.name}"?`)) return;
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

    cronHint(expr) {
      if (!expr) return "";
      const presets = {
        "* * * * *": "Every minute",
        "*/5 * * * *": "Every 5 minutes",
        "*/15 * * * *": "Every 15 minutes",
        "*/30 * * * *": "Every 30 minutes",
        "0 * * * *": "Every hour",
        "0 */6 * * *": "Every 6 hours",
        "0 0 * * *": "Daily at midnight",
        "0 9 * * *": "Daily at 9am",
        "0 9 * * 1-5": "Weekdays at 9am",
        "0 0 * * 0": "Weekly on Sunday",
      };
      return presets[expr.trim()] || "";
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
// Alpine HTML Template
// ============================================================

function getPageTemplate() {
  return `
  <!-- Header -->
  <div class="wm-scheduler-header" style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
    <h2 style="margin: 0; flex: 1;">Scheduled Jobs</h2>
    <button type="button" class="wm-btn wm-btn--sm" @click="refresh()">Refresh</button>
    <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="showForm = !showForm">
      <span x-text="showForm ? 'Cancel' : '+ New Job'"></span>
    </button>
  </div>

  <!-- Create Form -->
  <template x-if="showForm">
    <div class="wm-scheduler-form" style="background: var(--wm-bg-secondary); border: 1px solid var(--wm-border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
        <div class="wm-form-group">
          <label style="font-weight: 600; font-size: 0.85rem;">Job Name</label>
          <input type="text" class="wm-input" x-model="form.name" placeholder="e.g. Daily code review">
        </div>
        <div class="wm-form-group">
          <label style="font-weight: 600; font-size: 0.85rem;">Agent</label>
          <select class="wm-select" x-model="form.agent">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="goose">Goose</option>
            <option value="opencode">OpenCode</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div class="wm-form-group" style="grid-column: 1 / -1;">
          <label style="font-weight: 600; font-size: 0.85rem;">Working Directory</label>
          <input type="text" class="wm-input" x-model="form.workingDirectory" placeholder="/path/to/project">
        </div>
        <div class="wm-form-group">
          <label style="font-weight: 600; font-size: 0.85rem;">Cron Expression</label>
          <input type="text" class="wm-input" x-model="form.cronExpression" placeholder="0 9 * * *">
          <small x-text="cronHint(form.cronExpression)" style="color: var(--wm-text-secondary); margin-top: 2px;"></small>
        </div>
        <div class="wm-form-group">
          <label style="font-weight: 600; font-size: 0.85rem;">Timezone</label>
          <input type="text" class="wm-input" x-model="form.timezone" placeholder="UTC">
        </div>
        <div class="wm-form-group" style="grid-column: 1 / -1;">
          <label style="font-weight: 600; font-size: 0.85rem;">Initial Prompt</label>
          <textarea class="wm-input" x-model="form.initialPrompt" rows="4" placeholder="What should the agent do?"></textarea>
        </div>
        <div class="wm-form-group" style="display: flex; align-items: center; gap: 0.5rem;">
          <input type="checkbox" id="sched-nw-enabled" x-model="form.nightwatchmanEnabled">
          <label for="sched-nw-enabled" style="font-weight: 600; font-size: 0.85rem; margin: 0;">Enable Night Watchman</label>
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.75rem;">
        <button type="button" class="wm-btn wm-btn--sm" @click="showForm = false; resetForm()">Cancel</button>
        <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="submitJob()" :disabled="submitting || !form.name || !form.cronExpression || !form.workingDirectory || !form.initialPrompt">
          <span x-text="submitting ? 'Creating…' : 'Create Job'"></span>
        </button>
      </div>
    </div>
  </template>

  <!-- Loading -->
  <template x-if="$store.scheduler.loading">
    <p style="color: var(--wm-text-secondary);">Loading…</p>
  </template>

  <!-- Empty state -->
  <template x-if="!$store.scheduler.loading && $store.scheduler.jobs.length === 0">
    <p style="color: var(--wm-text-secondary);">No scheduled jobs yet. Create one to get started.</p>
  </template>

  <!-- Job list -->
  <div class="wm-scheduler-jobs" style="display: flex; flex-direction: column; gap: 0.5rem;">
    <template x-for="job in $store.scheduler.jobs" :key="job.id">
      <div class="wm-scheduler-job-card" style="background: var(--wm-bg-secondary); border: 1px solid var(--wm-border); border-radius: 8px; padding: 0.75rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <!-- Enable toggle -->
          <button
            type="button"
            class="wm-btn wm-btn--sm"
            :style="'width: 2.5rem; color: ' + (job.enabled ? '#22c55e' : '#6b7280')"
            @click="toggleEnabled(job)"
            :title="job.enabled ? 'Disable' : 'Enable'"
            x-text="job.enabled ? 'ON' : 'OFF'"
          ></button>

          <!-- Job info -->
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: baseline; gap: 0.5rem;">
              <strong x-text="job.name" style="font-size: 0.95rem;"></strong>
              <span x-text="job.agent" style="font-size: 0.75rem; color: var(--wm-text-secondary); text-transform: uppercase;"></span>
              <code x-text="job.cronExpression" style="font-size: 0.75rem; color: var(--wm-text-secondary);"></code>
            </div>
            <div style="font-size: 0.8rem; color: var(--wm-text-secondary); margin-top: 2px;">
              <span x-text="job.workingDirectory" style="opacity: 0.8;"></span>
              <template x-if="job.nextRunAt">
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
          <summary style="cursor: pointer; font-size: 0.8rem; color: var(--wm-text-secondary);">Prompt</summary>
          <pre style="font-size: 0.8rem; white-space: pre-wrap; margin: 0.25rem 0 0; padding: 0.5rem; background: var(--wm-bg-primary); border-radius: 4px; max-height: 200px; overflow: auto;" x-text="job.initialPrompt"></pre>
        </details>
      </div>
    </template>
  </div>

  <!-- Run History Modal -->
  <template x-if="runsJobId">
    <div style="margin-top: 1rem; background: var(--wm-bg-secondary); border: 1px solid var(--wm-border); border-radius: 8px; padding: 0.75rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
        <strong>Run History</strong>
        <button type="button" class="wm-btn wm-btn--sm" @click="closeRuns()">Close</button>
      </div>
      <template x-if="loadingRuns">
        <p style="color: var(--wm-text-secondary); font-size: 0.85rem;">Loading…</p>
      </template>
      <template x-if="!loadingRuns && runs.length === 0">
        <p style="color: var(--wm-text-secondary); font-size: 0.85rem;">No runs yet.</p>
      </template>
      <template x-if="!loadingRuns && runs.length > 0">
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <template x-for="run in runs" :key="run.id">
            <div style="display: flex; align-items: center; gap: 0.75rem; font-size: 0.85rem; padding: 0.25rem 0; border-bottom: 1px solid var(--wm-border);">
              <span :style="'color: ' + statusColor(run.status); font-weight: 600;'" x-text="run.status"></span>
              <span x-text="formatTime(run.startedAt)" style="color: var(--wm-text-secondary);"></span>
              <template x-if="run.sessionId">
                <span style="font-family: monospace; font-size: 0.75rem;" x-text="run.sessionId.slice(0, 8) + '…'"></span>
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
