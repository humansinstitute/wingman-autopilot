/**
 * Night Watch Page
 *
 * Dedicated page for Night Watchman configuration and report cards.
 * Uses Alpine.js for reactive UI backed by Dexie IndexedDB cache.
 *
 * Exports initNightWatchPage({ state, render, showToast }) returning
 * { renderPage, ensureLoaded }.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";

// ============================================================
// Page Module
// ============================================================

export function initNightWatchPage({ state, showToast }) {
  /**
   * Ensure the Alpine store is initialized and data is loaded.
   * Called by app.js when navigating to /nightwatch.
   */
  async function ensureLoaded() {
    const store = Alpine.store("nightwatch");
    if (store) {
      await store.init();
    }
  }

  /**
   * Build the Alpine-powered page template.
   * Returns a DOM element with Alpine directives that render reactively.
   */
  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-nightwatch-page wm-page";
    page.setAttribute("x-data", "nightwatchPage");
    page.innerHTML = getPageTemplate();
    return page;
  }

  // Register Alpine component for page-local methods
  Alpine.data("nightwatchPage", () => ({
    promptDraft: "",
    promptOpen: false,

    init() {
      // Populate prompt draft from cached config
      const cfg = this.$store.nightwatch.config;
      if (cfg) {
        this.promptDraft = cfg.prompt || cfg.defaultPrompt || "";
      }
      // Watch for config changes to keep prompt draft in sync (initial load)
      this.$watch("$store.nightwatch.config", (cfg) => {
        if (cfg && !this.promptDraft) {
          this.promptDraft = cfg.prompt || cfg.defaultPrompt || "";
        }
      });
    },

    async onModelChange(event) {
      try {
        const data = await this.$store.nightwatch.updateConfig({ model: event.target.value });
        showToast(`Model set to ${data.model}`);
      } catch { /* store already shows error toast */ }
    },

    async onCyclesChange(event) {
      try {
        const data = await this.$store.nightwatch.updateConfig({ maxCycles: Number(event.target.value) });
        showToast(`Max cycles set to ${data.maxCycles}`);
      } catch { /* store already shows error toast */ }
    },

    async savePrompt() {
      try {
        const data = await this.$store.nightwatch.updateConfig({ prompt: this.promptDraft });
        this.promptDraft = data.prompt || data.defaultPrompt || "";
        showToast("Prompt saved");
      } catch { /* store already shows error toast */ }
    },

    async resetPrompt() {
      try {
        const data = await this.$store.nightwatch.updateConfig({ prompt: "" });
        this.promptDraft = data.defaultPrompt || "";
        showToast("Prompt reset to default");
      } catch { /* store already shows error toast */ }
    },

    async refresh() {
      await this.$store.nightwatch.sync();
      showToast("Refreshed");
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
  <div class="wm-nightwatch-header">
    <h2 style="margin: 0;">Night Watchman</h2>
    <button type="button" class="wm-btn wm-btn--sm" @click="refresh()">Refresh</button>
  </div>

  <!-- Config row (only show when config is loaded) -->
  <template x-if="$store.nightwatch.config">
    <div class="wm-nightwatch-config">
      <!-- Model selector -->
      <div class="wm-form-group" style="flex: 1;">
        <label style="font-weight: 600;">Default Model</label>
        <select class="wm-select" @change="onModelChange($event)">
          <template x-for="m in $store.nightwatch.config.models" :key="m">
            <option :value="m" x-text="m" :selected="m === $store.nightwatch.config.model"></option>
          </template>
        </select>
      </div>
      <!-- Max cycles selector -->
      <div class="wm-form-group" style="flex: 0 0 auto;">
        <label style="font-weight: 600;">Max Cycles</label>
        <select class="wm-select" @change="onCyclesChange($event)">
          <template x-for="c in ($store.nightwatch.config.maxCycleOptions || [6, 21, 256])" :key="c">
            <option :value="String(c)" x-text="String(c)" :selected="c === $store.nightwatch.config.maxCycles"></option>
          </template>
        </select>
      </div>
    </div>
  </template>

  <!-- Prompt editor -->
  <template x-if="$store.nightwatch.config">
    <details class="wm-nightwatch-prompt" :open="promptOpen" @toggle="promptOpen = $el.open">
      <summary style="cursor: pointer; font-weight: 600; margin-bottom: 0.5rem;">System Prompt</summary>
      <textarea class="wm-nightwatch-prompt-textarea"
                x-model="promptDraft"
                spellcheck="false"></textarea>
      <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
        <button type="button" class="wm-btn wm-btn--sm" @click="savePrompt()">Save</button>
        <button type="button" class="wm-btn wm-btn--sm" @click="resetPrompt()">Reset to Default</button>
      </div>
    </details>
  </template>

  <!-- Filter bar -->
  <div class="wm-nightwatch-filters">
    <select class="wm-select" x-model="$store.nightwatch.filterProject">
      <option value="">All Projects</option>
      <template x-for="dir in $store.nightwatch.uniqueProjects" :key="dir">
        <option :value="dir" x-text="$store.nightwatch.extractProject(dir) || dir"></option>
      </template>
    </select>
    <select class="wm-select" x-model="$store.nightwatch.filterStatus">
      <option value="">All Statuses</option>
      <option value="continue">Continue</option>
      <option value="complete">Complete</option>
      <option value="error">Error</option>
      <option value="humanInput">Human Input</option>
    </select>
  </div>

  <!-- Report list -->
  <div class="wm-nightwatch-report-list">
    <!-- Loading state -->
    <template x-if="$store.nightwatch.loading && $store.nightwatch.reports.length === 0">
      <p style="opacity: 0.6;">Loading reports...</p>
    </template>

    <!-- Empty state -->
    <template x-if="!$store.nightwatch.loading && $store.nightwatch.filteredReports.length === 0">
      <p style="opacity: 0.6;">No report cards match the current filters.</p>
    </template>

    <!-- Report cards -->
    <template x-for="report in $store.nightwatch.filteredReports" :key="report.id">
      <div class="wm-nightwatch-report-card">
        <!-- Header row -->
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <!-- Status badge -->
          <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; color: #fff;"
                :style="'background:' + $store.nightwatch.statusColor(report.status)"
                x-text="$store.nightwatch.statusLabel(report.status)"></span>

          <!-- RAW tag -->
          <template x-if="report.inputMode === 'raw'">
            <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; color: #fff; background: #8b5cf6; letter-spacing: 0.05em;">RAW</span>
          </template>

          <!-- Project tag -->
          <template x-if="$store.nightwatch.extractProject(report.workingDirectory)">
            <span class="wm-nightwatch-report-card__project"
                  x-text="$store.nightwatch.extractProject(report.workingDirectory)"></span>
          </template>

          <!-- Session name/link -->
          <template x-if="report.sessionName">
            <a :href="'/live/' + report.sessionId"
               x-text="report.sessionName"
               style="font-weight: 600; text-decoration: none; color: var(--accent-color, #7dd3fc);"></a>
          </template>
          <template x-if="!report.sessionName">
            <span style="font-weight: 600;" x-text="report.sessionId.slice(0, 8)"></span>
          </template>

          <!-- Meta -->
          <span style="font-size: 0.75rem; opacity: 0.6; margin-left: auto;"
                x-text="report.cycleCount + ' cycles \\u00b7 ' + $store.nightwatch.formatTime(report.createdAt)"></span>
        </div>

        <!-- Summary -->
        <p style="margin: 0; font-size: 0.85rem; line-height: 1.4;" x-text="report.summary"></p>

        <!-- Reasoning -->
        <template x-if="report.reasoning">
          <p style="margin: 0.25rem 0 0; font-size: 0.8rem; line-height: 1.3; opacity: 0.7; font-style: italic; border-left: 2px solid rgba(255,255,255,0.15); padding-left: 0.5rem;"
             x-text="report.reasoning"></p>
        </template>

        <!-- Dismiss button -->
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="wm-btn wm-btn--sm"
                  @click="$store.nightwatch.dismiss(report.id)">Dismiss</button>
        </div>
      </div>
    </template>
  </div>
`;
}
