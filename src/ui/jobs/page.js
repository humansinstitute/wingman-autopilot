/**
 * Autopilot Jobs Page
 *
 * Dedicated page for managing autopilot job definitions and viewing runs.
 * Uses Alpine.js for reactive UI.
 *
 * Exports initJobsPage({ showToast }) returning
 * { renderPage, ensureLoaded }.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { DEFAULT_AGENT, normalizeAgentValue, renderAgentOptions } from "../common/agent-options.js";
import { state } from "../state/index.js";

function getConfiguredDefaultAgent() {
  return normalizeAgentValue(state.config?.defaultAgent ?? state.config?.systemDefaultAgent ?? DEFAULT_AGENT);
}

// ============================================================
// Page Module
// ============================================================

export function initJobsPage({ showToast }) {
  async function ensureLoaded() {
    const store = Alpine.store("autopilotJobs");
    if (store) {
      await store.init();
    }
  }

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-jobs-page wm-page";
    page.setAttribute("x-data", "jobsPage");
    page.innerHTML = getPageTemplate();
    return page;
  }

  Alpine.data("jobsPage", () => ({
    // View mode: "definitions" or "runs"
    view: "definitions",

    // Create form state
    showForm: false,
    form: {
      id: "",
      name: "",
      worker_prompt: "",
      manager_prompt: "",
      manager_goal: "",
      worker_agent: getConfiguredDefaultAgent(),
      manager_agent: getConfiguredDefaultAgent(),
      manager_dir: "",
      check_interval: 300,
      enabled: true,
    },
    submitting: false,

    // Edit state
    editingJobId: null,
    editForm: {},
    editSubmitting: false,

    // Runs state
    runsFilter: "",
    runsStatusFilter: "",

    init() {},

    // ----- Definition Actions -----

    resetForm() {
      this.form = {
        id: "",
        name: "",
        worker_prompt: "",
        manager_prompt: "",
        manager_goal: "",
        worker_agent: getConfiguredDefaultAgent(),
        manager_agent: getConfiguredDefaultAgent(),
        manager_dir: "",
        check_interval: 300,
        enabled: true,
      };
    },

    async submitJob() {
      if (this.submitting) return;
      this.submitting = true;
      try {
        await this.$store.autopilotJobs.create({
          id: this.form.id,
          name: this.form.name,
          worker_prompt: this.form.worker_prompt,
          manager_prompt: this.form.manager_prompt,
          manager_goal: this.form.manager_goal,
          worker_agent: this.form.worker_agent,
          manager_agent: this.form.manager_agent,
          manager_dir: this.form.manager_dir,
          check_interval: parseInt(this.form.check_interval, 10) || 300,
          enabled: this.form.enabled,
        });
        this.showForm = false;
        this.resetForm();
      } catch { /* store shows toast */ }
      this.submitting = false;
    },

    startEdit(job) {
      this.editingJobId = job.id;
      this.editForm = {
        name: job.name,
        worker_prompt: job.worker_prompt,
        manager_prompt: job.manager_prompt,
        manager_goal: job.manager_goal,
        worker_agent: normalizeAgentValue(job.worker_agent || getConfiguredDefaultAgent()),
        manager_agent: normalizeAgentValue(job.manager_agent || getConfiguredDefaultAgent()),
        manager_dir: job.manager_dir,
        check_interval: job.check_interval,
        enabled: !!job.enabled,
      };
    },

    cancelEdit() {
      this.editingJobId = null;
      this.editForm = {};
    },

    async saveEdit() {
      if (this.editSubmitting) return;
      this.editSubmitting = true;
      try {
        await this.$store.autopilotJobs.update(this.editingJobId, {
          name: this.editForm.name,
          worker_prompt: this.editForm.worker_prompt,
          manager_prompt: this.editForm.manager_prompt,
          manager_goal: this.editForm.manager_goal,
          worker_agent: this.editForm.worker_agent,
          manager_agent: this.editForm.manager_agent,
          manager_dir: this.editForm.manager_dir,
          check_interval: parseInt(this.editForm.check_interval, 10) || 300,
          enabled: this.editForm.enabled,
        });
        this.editingJobId = null;
        this.editForm = {};
      } catch { /* store shows toast */ }
      this.editSubmitting = false;
    },

    async deleteJob(job) {
      if (!confirm(`Delete job "${job.name}"?`)) return;
      await this.$store.autopilotJobs.remove(job.id);
    },

    async toggleEnabled(job) {
      try {
        await this.$store.autopilotJobs.toggleEnabled(job.id, !job.enabled);
      } catch { /* store shows toast */ }
    },

    // ----- Runs Actions -----

    async loadRuns() {
      await this.$store.autopilotJobs.syncRuns(
        this.runsFilter || undefined,
        this.runsStatusFilter || undefined,
      );
    },

    async switchToRuns(jobId) {
      this.view = "runs";
      this.runsFilter = jobId || "";
      this.runsStatusFilter = "";
      await this.loadRuns();
    },

    async stopRun(run) {
      try {
        await this.$store.autopilotJobs.stop(run.id);
      } catch { /* store shows toast */ }
    },

    // ----- Helpers -----

    async refresh() {
      if (this.view === "definitions") {
        await this.$store.autopilotJobs.syncDefinitions();
      } else {
        await this.loadRuns();
      }
      showToast("Refreshed");
    },

    formatTime(iso) {
      return this.$store.autopilotJobs.formatTime(iso);
    },

    formatDuration(created, updated) {
      return this.$store.autopilotJobs.formatDuration(created, updated);
    },

    statusColor(status) {
      if (status === "complete") return "#22c55e";
      if (status === "running") return "#3b82f6";
      if (status === "starting") return "#eab308";
      if (status === "failed") return "#ef4444";
      if (status === "stopped") return "#6b7280";
      return "#9ca3af";
    },

    snippet(text, maxLen = 60) {
      if (!text) return "--";
      const oneLine = text.replace(/\\n/g, " ").trim();
      return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
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
  <div class="wm-scheduler-header">
    <h2 style="margin: 0; flex: 1;">Autopilot Jobs</h2>
    <div style="display: flex; gap: 0.5rem; align-items: center;">
      <button type="button" class="wm-btn wm-btn--sm"
        :class="view === 'definitions' ? 'wm-btn--primary' : ''"
        @click="view = 'definitions'">Definitions</button>
      <button type="button" class="wm-btn wm-btn--sm"
        :class="view === 'runs' ? 'wm-btn--primary' : ''"
        @click="switchToRuns()">Runs</button>
      <button type="button" class="wm-btn wm-btn--sm" @click="refresh()">Refresh</button>
    </div>
  </div>

  <!-- Definitions View -->
  <template x-if="view === 'definitions'">
    <div>
      <!-- New Job Button -->
      <div style="margin-bottom: 1rem;">
        <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" @click="showForm = !showForm">
          <span x-text="showForm ? 'Cancel' : '+ New Job'"></span>
        </button>
      </div>

      <!-- Create Form -->
      <template x-if="showForm">
        <div style="background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
          <!-- Row 1: ID + Name -->
          <div class="wm-scheduler-grid-two">
            <div class="wm-form-group">
              <label>Job ID</label>
              <input type="text" class="wm-input" x-model="form.id" placeholder="e.g. daily-review">
            </div>
            <div class="wm-form-group">
              <label>Name</label>
              <input type="text" class="wm-input" x-model="form.name" placeholder="e.g. Daily Code Review">
            </div>
          </div>

          <!-- Row 2: Manager Dir + Check Interval -->
          <div class="wm-scheduler-grid-two" style="margin-top: 0.75rem;">
            <div class="wm-form-group">
              <label>Worker Agent</label>
              <select class="wm-select" x-model="form.worker_agent" aria-label="Worker agent" data-testid="jobs-create-worker-agent">
                ${renderAgentOptions(DEFAULT_AGENT)}
              </select>
            </div>
            <div class="wm-form-group">
              <label>Manager Agent</label>
              <select class="wm-select" x-model="form.manager_agent" aria-label="Manager agent" data-testid="jobs-create-manager-agent">
                ${renderAgentOptions(DEFAULT_AGENT)}
              </select>
            </div>
          </div>

          <!-- Row 3: Manager Dir + Check Interval -->
          <div class="wm-scheduler-grid-two" style="margin-top: 0.75rem;">
            <div class="wm-form-group">
              <label>Manager Directory</label>
              <input type="text" class="wm-input" x-model="form.manager_dir" placeholder="/path/to/project">
            </div>
            <div class="wm-form-group">
              <label>Check Interval (seconds)</label>
              <input type="number" class="wm-input" x-model="form.check_interval" min="0" step="60">
            </div>
          </div>

          <!-- Row 4: Manager Goal -->
          <div class="wm-form-group" style="margin-top: 0.75rem;">
            <label>Manager Goal</label>
            <input type="text" class="wm-input" x-model="form.manager_goal" placeholder="High-level goal for the manager agent">
          </div>

          <!-- Row 5: Worker Prompt -->
          <div class="wm-form-group" style="margin-top: 0.75rem;">
            <label>Worker Prompt</label>
            <textarea class="wm-input" x-model="form.worker_prompt" rows="3" placeholder="Prompt for the worker agent session"></textarea>
          </div>

          <!-- Row 6: Manager Prompt -->
          <div class="wm-form-group" style="margin-top: 0.75rem;">
            <label>Manager Prompt</label>
            <textarea class="wm-input" x-model="form.manager_prompt" rows="3" placeholder="Prompt for the manager agent session"></textarea>
          </div>

          <!-- Row 7: Enabled + Submit -->
          <div style="display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem;">
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
              <input type="checkbox" x-model="form.enabled"> Enabled
            </label>
            <button type="button" class="wm-btn wm-btn--primary" @click="submitJob()" :disabled="submitting || !form.id || !form.name">
              <span x-text="submitting ? 'Creating...' : 'Create Job'"></span>
            </button>
          </div>
        </div>
      </template>

      <!-- Loading -->
      <template x-if="$store.autopilotJobs.loading">
        <p style="color: var(--text-secondary); padding: 1rem 0;">Loading job definitions...</p>
      </template>

      <!-- Empty State -->
      <template x-if="!$store.autopilotJobs.loading && $store.autopilotJobs.definitions.length === 0">
        <p style="color: var(--text-secondary); padding: 1rem 0;">No job definitions yet. Create one to get started.</p>
      </template>

      <!-- Job List -->
      <template x-for="job in $store.autopilotJobs.definitions" :key="job.id">
        <div style="background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;">

          <!-- Viewing mode -->
          <template x-if="editingJobId !== job.id">
            <div>
              <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                <span style="font-weight: 600; font-size: 1rem;" x-text="job.name"></span>
                <code style="font-size: 0.75rem; color: var(--text-secondary);" x-text="job.id"></code>
                <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px;"
                  :style="{ background: job.enabled ? '#22c55e22' : '#6b728022', color: job.enabled ? '#22c55e' : '#6b7280' }"
                  x-text="job.enabled ? 'Enabled' : 'Disabled'"></span>
                <span style="flex: 1;"></span>
                <button class="wm-btn wm-btn--sm" @click="switchToRuns(job.id)" title="View runs">Runs</button>
                <button class="wm-btn wm-btn--sm" @click="toggleEnabled(job)" x-text="job.enabled ? 'Disable' : 'Enable'"></button>
                <button class="wm-btn wm-btn--sm" @click="startEdit(job)">Edit</button>
                <button class="wm-btn wm-btn--sm" style="color: var(--danger, #ef4444);" @click="deleteJob(job)">Delete</button>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.25rem 1rem; font-size: 0.85rem; color: var(--text-secondary);">
                <div><strong>Worker Agent:</strong> <span x-text="job.worker_agent || 'claude'"></span></div>
                <div><strong>Manager Agent:</strong> <span x-text="job.manager_agent || 'claude'"></span></div>
                <div><strong>Manager Dir:</strong> <span x-text="job.manager_dir || '--'"></span></div>
                <div><strong>Check Interval:</strong> <span x-text="(job.check_interval || 300) + 's'"></span></div>
                <div style="grid-column: 1 / -1;"><strong>Manager Goal:</strong> <span x-text="snippet(job.manager_goal)"></span></div>
                <div style="grid-column: 1 / -1;"><strong>Worker Prompt:</strong> <span x-text="snippet(job.worker_prompt)"></span></div>
              </div>

              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem;">
                Created: <span x-text="formatTime(job.created_at)"></span>
                | Updated: <span x-text="formatTime(job.updated_at)"></span>
              </div>
            </div>
          </template>

          <!-- Editing mode -->
          <template x-if="editingJobId === job.id">
            <div>
              <div style="font-weight: 600; margin-bottom: 0.5rem;">Editing: <span x-text="job.id"></span></div>
              <div class="wm-scheduler-grid-two">
                <div class="wm-form-group">
                  <label>Name</label>
                  <input type="text" class="wm-input" x-model="editForm.name">
                </div>
                <div class="wm-form-group">
                  <label>Worker Agent</label>
                  <select class="wm-select" x-model="editForm.worker_agent" aria-label="Edit worker agent" data-testid="jobs-edit-worker-agent">
                    ${renderAgentOptions(DEFAULT_AGENT)}
                  </select>
                </div>
              </div>
              <div class="wm-scheduler-grid-two" style="margin-top: 0.75rem;">
                <div class="wm-form-group">
                  <label>Manager Agent</label>
                  <select class="wm-select" x-model="editForm.manager_agent" aria-label="Edit manager agent" data-testid="jobs-edit-manager-agent">
                    ${renderAgentOptions(DEFAULT_AGENT)}
                  </select>
                </div>
                <div class="wm-form-group">
                  <label>Manager Directory</label>
                  <input type="text" class="wm-input" x-model="editForm.manager_dir">
                </div>
              </div>
              <div class="wm-scheduler-grid-two" style="margin-top: 0.75rem;">
                <div class="wm-form-group">
                  <label>Manager Goal</label>
                  <input type="text" class="wm-input" x-model="editForm.manager_goal">
                </div>
                <div class="wm-form-group">
                  <label>Check Interval (seconds)</label>
                  <input type="number" class="wm-input" x-model="editForm.check_interval" min="0" step="60">
                </div>
              </div>
              <div class="wm-form-group" style="margin-top: 0.75rem;">
                <label>Worker Prompt</label>
                <textarea class="wm-input" x-model="editForm.worker_prompt" rows="3"></textarea>
              </div>
              <div class="wm-form-group" style="margin-top: 0.75rem;">
                <label>Manager Prompt</label>
                <textarea class="wm-input" x-model="editForm.manager_prompt" rows="3"></textarea>
              </div>
              <div style="display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem;">
                <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                  <input type="checkbox" x-model="editForm.enabled"> Enabled
                </label>
                <button type="button" class="wm-btn wm-btn--primary" @click="saveEdit()" :disabled="editSubmitting">
                  <span x-text="editSubmitting ? 'Saving...' : 'Save'"></span>
                </button>
                <button type="button" class="wm-btn" @click="cancelEdit()">Cancel</button>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </template>

  <!-- Runs View -->
  <template x-if="view === 'runs'">
    <div>
      <!-- Filters -->
      <div style="display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap;">
        <div class="wm-form-group" style="margin: 0;">
          <label style="font-size: 0.8rem;">Job ID Filter</label>
          <input type="text" class="wm-input" x-model="runsFilter" placeholder="All jobs" style="width: 180px;"
            @change="loadRuns()">
        </div>
        <div class="wm-form-group" style="margin: 0;">
          <label style="font-size: 0.8rem;">Status</label>
          <select class="wm-select" x-model="runsStatusFilter" @change="loadRuns()" style="width: 140px;">
            <option value="">All</option>
            <option value="running">Running</option>
            <option value="starting">Starting</option>
            <option value="complete">Complete</option>
            <option value="failed">Failed</option>
            <option value="stopped">Stopped</option>
          </select>
        </div>
        <button type="button" class="wm-btn wm-btn--sm" style="margin-top: auto;" @click="loadRuns()">Filter</button>
      </div>

      <!-- Loading -->
      <template x-if="$store.autopilotJobs.runsLoading">
        <p style="color: var(--text-secondary); padding: 1rem 0;">Loading runs...</p>
      </template>

      <!-- Empty State -->
      <template x-if="!$store.autopilotJobs.runsLoading && $store.autopilotJobs.runs.length === 0">
        <p style="color: var(--text-secondary); padding: 1rem 0;">No runs found.</p>
      </template>

      <!-- Runs List -->
      <template x-for="run in $store.autopilotJobs.runs" :key="run.id">
        <div style="background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
            <code style="font-size: 0.8rem;" x-text="run.id.slice(0, 8)"></code>
            <span style="font-size: 0.85rem; font-weight: 500;" x-text="run.job_id"></span>
            <span style="font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; font-weight: 600;"
              :style="{ background: statusColor(run.status) + '22', color: statusColor(run.status) }"
              x-text="run.status"></span>
            <span style="flex: 1;"></span>
            <span style="font-size: 0.8rem; color: var(--text-secondary);"
              x-text="formatDuration(run.created_at, run.updated_at)"></span>
            <template x-if="run.status === 'running' || run.status === 'starting'">
              <button class="wm-btn wm-btn--sm" style="color: var(--danger, #ef4444);" @click="stopRun(run)">Stop</button>
            </template>
          </div>

          <div style="font-size: 0.85rem; color: var(--text-secondary);">
            <template x-if="run.goal">
              <div><strong>Goal:</strong> <span x-text="snippet(run.goal, 100)"></span></div>
            </template>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.25rem 1rem; margin-top: 0.25rem;">
              <div><strong>Worker Agent:</strong> <span x-text="run.worker_agent || '--'"></span></div>
              <div><strong>Manager Agent:</strong> <span x-text="run.manager_agent || '--'"></span></div>
              <div><strong>Worker Session:</strong>
                <template x-if="run.worker_session_id">
                  <a :href="'/live/' + run.worker_session_id" style="color: var(--accent);"
                    x-text="run.worker_session_id.slice(0, 8) + '...'" @click.prevent="window.location.href = '/live/' + run.worker_session_id"></a>
                </template>
                <template x-if="!run.worker_session_id">
                  <span>--</span>
                </template>
              </div>
              <div><strong>Manager Session:</strong>
                <template x-if="run.manager_session_id">
                  <a :href="'/live/' + run.manager_session_id" style="color: var(--accent);"
                    x-text="run.manager_session_id.slice(0, 8) + '...'" @click.prevent="window.location.href = '/live/' + run.manager_session_id"></a>
                </template>
                <template x-if="!run.manager_session_id">
                  <span>--</span>
                </template>
              </div>
              <div><strong>Worker Dir:</strong> <span x-text="run.worker_dir || '--'"></span></div>
              <div><strong>Manager Dir:</strong> <span x-text="run.manager_dir || '--'"></span></div>
            </div>
            <template x-if="run.output_summary">
              <div style="margin-top: 0.25rem;"><strong>Output:</strong> <span x-text="snippet(run.output_summary, 120)"></span></div>
            </template>
          </div>

          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem;">
            Created: <span x-text="formatTime(run.created_at)"></span>
            | Updated: <span x-text="formatTime(run.updated_at)"></span>
          </div>
        </div>
      </template>
    </div>
  </template>
  `;
}
