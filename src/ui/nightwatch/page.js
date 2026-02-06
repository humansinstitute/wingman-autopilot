/**
 * Night Watch Page
 *
 * Dedicated page for Night Watchman configuration and report cards.
 * Exports initNightWatchPage({ state, render, showToast }) returning
 * { renderPage, ensureLoaded }.
 */

import {
  fetchNightWatchConfig,
  updateNightWatchConfig,
  fetchNightWatchReports,
  deleteNightWatchReport,
} from "./api.js";
import { createStatusBadge, formatTimestamp, extractProjectName } from "./helpers.js";

// ============================================================
// Page Module
// ============================================================

export function initNightWatchPage({ state, render, showToast }) {
  // Page-scoped filter state (not global)
  let filterProject = "";  // "" = all
  let filterStatus = "";   // "" = all

  // ----------------------------------------------------------
  // Data loading (shares state.nightwatch with settings panel)
  // ----------------------------------------------------------

  async function loadConfig() {
    try {
      const data = await fetchNightWatchConfig();
      state.nightwatch.config.models = data.models || [];
      state.nightwatch.config.model = data.model || "google/gemini-3-flash-preview";
      state.nightwatch.config.maxCycles = data.maxCycles || 21;
      state.nightwatch.config.maxCycleOptions = data.maxCycleOptions || [6, 21, 256];
      state.nightwatch.config.prompt = data.prompt || "";
      state.nightwatch.config.defaultPrompt = data.defaultPrompt || "";
    } catch (err) {
      console.warn("[nightwatch-page] Failed to load config:", err);
    }
  }

  async function loadReports() {
    if (state.nightwatch.reportsLoading) return;
    state.nightwatch.reportsLoading = true;
    try {
      const data = await fetchNightWatchReports();
      state.nightwatch.reports = data.reports || [];
      state.nightwatch.reportsInitialized = true;
    } catch (err) {
      console.warn("[nightwatch-page] Failed to load reports:", err);
    } finally {
      state.nightwatch.reportsLoading = false;
    }
  }

  async function ensureLoaded() {
    await loadConfig();
    await loadReports();
  }

  // ----------------------------------------------------------
  // Config controls
  // ----------------------------------------------------------

  function renderConfigRow() {
    const nw = state.nightwatch;
    const row = document.createElement("div");
    row.className = "wm-nightwatch-config";

    // Model selector
    const modelGroup = document.createElement("div");
    modelGroup.className = "wm-form-group";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Default Model";
    modelLabel.style.fontWeight = "600";
    const modelSelect = document.createElement("select");
    modelSelect.className = "wm-select";
    for (const m of nw.config.models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === nw.config.model) opt.selected = true;
      modelSelect.append(opt);
    }
    modelSelect.addEventListener("change", async () => {
      try {
        const data = await updateNightWatchConfig({ model: modelSelect.value });
        nw.config.model = data.model;
        showToast(`Model set to ${data.model}`);
      } catch (err) {
        showToast(`Failed to update model: ${err.message}`, { type: "error" });
      }
    });
    modelGroup.append(modelLabel, modelSelect);

    // Max cycles selector
    const cyclesGroup = document.createElement("div");
    cyclesGroup.className = "wm-form-group";
    const cyclesLabel = document.createElement("label");
    cyclesLabel.textContent = "Max Cycles";
    cyclesLabel.style.fontWeight = "600";
    const cyclesSelect = document.createElement("select");
    cyclesSelect.className = "wm-select";
    const options = nw.config.maxCycleOptions || [6, 21, 256];
    for (const c of options) {
      const opt = document.createElement("option");
      opt.value = String(c);
      opt.textContent = String(c);
      if (c === nw.config.maxCycles) opt.selected = true;
      cyclesSelect.append(opt);
    }
    cyclesSelect.addEventListener("change", async () => {
      try {
        const data = await updateNightWatchConfig({ maxCycles: Number(cyclesSelect.value) });
        nw.config.maxCycles = data.maxCycles;
        showToast(`Max cycles set to ${data.maxCycles}`);
      } catch (err) {
        showToast(`Failed to update max cycles: ${err.message}`, { type: "error" });
      }
    });
    cyclesGroup.append(cyclesLabel, cyclesSelect);

    modelGroup.style.flex = "1";
    cyclesGroup.style.flex = "0 0 auto";
    row.append(modelGroup, cyclesGroup);
    return row;
  }

  // ----------------------------------------------------------
  // Prompt editor
  // ----------------------------------------------------------

  function renderPromptEditor() {
    const nw = state.nightwatch;
    const section = document.createElement("details");
    section.className = "wm-nightwatch-prompt";

    const summary = document.createElement("summary");
    summary.textContent = "System Prompt";
    summary.style.cssText = "cursor: pointer; font-weight: 600; margin-bottom: 0.5rem;";
    section.append(summary);

    const currentPrompt = nw.config.prompt || nw.config.defaultPrompt || "";

    const textarea = document.createElement("textarea");
    textarea.className = "wm-nightwatch-prompt-textarea";
    textarea.value = currentPrompt;
    textarea.spellcheck = false;
    section.append(textarea);

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; gap: 0.5rem; margin-top: 0.5rem;";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "wm-btn wm-btn--sm";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      try {
        const data = await updateNightWatchConfig({ prompt: textarea.value });
        nw.config.prompt = data.prompt || "";
        nw.config.defaultPrompt = data.defaultPrompt || "";
        showToast("Prompt saved");
      } catch (err) {
        showToast(`Failed to save prompt: ${err.message}`, { type: "error" });
      }
    });

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "wm-btn wm-btn--sm";
    resetBtn.textContent = "Reset to Default";
    resetBtn.addEventListener("click", async () => {
      try {
        const data = await updateNightWatchConfig({ prompt: "" });
        nw.config.prompt = data.prompt || "";
        nw.config.defaultPrompt = data.defaultPrompt || "";
        textarea.value = nw.config.defaultPrompt;
        showToast("Prompt reset to default");
      } catch (err) {
        showToast(`Failed to reset prompt: ${err.message}`, { type: "error" });
      }
    });

    actions.append(saveBtn, resetBtn);
    section.append(actions);
    return section;
  }

  // ----------------------------------------------------------
  // Filter bar
  // ----------------------------------------------------------

  function getUniqueProjects() {
    const dirs = new Set();
    for (const r of state.nightwatch.reports) {
      if (r.workingDirectory) {
        dirs.add(r.workingDirectory);
      }
    }
    return Array.from(dirs).sort();
  }

  function renderFilterBar() {
    const bar = document.createElement("div");
    bar.className = "wm-nightwatch-filters";

    // Project dropdown
    const projectSelect = document.createElement("select");
    projectSelect.className = "wm-select";
    const allProjectsOpt = document.createElement("option");
    allProjectsOpt.value = "";
    allProjectsOpt.textContent = "All Projects";
    projectSelect.append(allProjectsOpt);
    for (const dir of getUniqueProjects()) {
      const opt = document.createElement("option");
      opt.value = dir;
      opt.textContent = extractProjectName(dir) || dir;
      if (dir === filterProject) opt.selected = true;
      projectSelect.append(opt);
    }
    projectSelect.addEventListener("change", () => {
      filterProject = projectSelect.value;
      render();
    });

    // Status dropdown
    const statusSelect = document.createElement("select");
    statusSelect.className = "wm-select";
    const statuses = [
      { value: "", label: "All Statuses" },
      { value: "complete", label: "Complete" },
      { value: "error", label: "Error" },
      { value: "humanInput", label: "Human Input" },
    ];
    for (const s of statuses) {
      const opt = document.createElement("option");
      opt.value = s.value;
      opt.textContent = s.label;
      if (s.value === filterStatus) opt.selected = true;
      statusSelect.append(opt);
    }
    statusSelect.addEventListener("change", () => {
      filterStatus = statusSelect.value;
      render();
    });

    bar.append(projectSelect, statusSelect);
    return bar;
  }

  // ----------------------------------------------------------
  // Report cards
  // ----------------------------------------------------------

  function getFilteredReports() {
    return state.nightwatch.reports.filter((r) => {
      if (filterStatus && r.status !== filterStatus) return false;
      if (filterProject && r.workingDirectory !== filterProject) return false;
      return true;
    });
  }

  function renderReportCard(report) {
    const card = document.createElement("div");
    card.className = "wm-nightwatch-report-card";

    // Header row: badge + project tag + session name + timestamp
    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;";
    header.append(createStatusBadge(report.status));

    const project = extractProjectName(report.workingDirectory);
    if (project) {
      const tag = document.createElement("span");
      tag.className = "wm-nightwatch-report-card__project";
      tag.textContent = project;
      header.append(tag);
    }

    if (report.sessionName) {
      const link = document.createElement("a");
      link.href = `/live/${report.sessionId}`;
      link.textContent = report.sessionName;
      link.style.cssText = "font-weight: 600; text-decoration: none; color: var(--accent-color, #7dd3fc);";
      header.append(link);
    } else {
      const idSpan = document.createElement("span");
      idSpan.textContent = report.sessionId.slice(0, 8);
      idSpan.style.fontWeight = "600";
      header.append(idSpan);
    }

    const meta = document.createElement("span");
    meta.textContent = `${report.cycleCount} cycles \u00b7 ${formatTimestamp(report.createdAt)}`;
    meta.style.cssText = "font-size: 0.75rem; opacity: 0.6; margin-left: auto;";
    header.append(meta);

    card.append(header);

    // Summary
    const summary = document.createElement("p");
    summary.textContent = report.summary;
    summary.style.cssText = "margin: 0; font-size: 0.85rem; line-height: 1.4;";
    card.append(summary);

    // Dismiss button
    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; justify-content: flex-end;";
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.className = "wm-btn wm-btn--sm";
    dismissBtn.addEventListener("click", async () => {
      try {
        await deleteNightWatchReport(report.id);
        state.nightwatch.reports = state.nightwatch.reports.filter((r) => r.id !== report.id);
        render();
        showToast("Report dismissed");
      } catch (err) {
        showToast(`Failed to dismiss: ${err.message}`, { type: "error" });
      }
    });
    actions.append(dismissBtn);
    card.append(actions);

    return card;
  }

  // ----------------------------------------------------------
  // Main page render
  // ----------------------------------------------------------

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-nightwatch-page wm-page";

    // Header
    const header = document.createElement("div");
    header.className = "wm-nightwatch-header";

    const title = document.createElement("h2");
    title.textContent = "Night Watchman";
    title.style.margin = "0";

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "wm-btn wm-btn--sm";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", async () => {
      await ensureLoaded();
      render();
    });

    header.append(title, refreshBtn);
    page.append(header);

    // Config row
    page.append(renderConfigRow());

    // Prompt editor
    page.append(renderPromptEditor());

    // Filter bar
    page.append(renderFilterBar());

    // Report list
    const nw = state.nightwatch;
    const list = document.createElement("div");
    list.className = "wm-nightwatch-report-list";

    if (nw.reportsLoading) {
      const loading = document.createElement("p");
      loading.textContent = "Loading reports...";
      loading.style.opacity = "0.6";
      list.append(loading);
    } else {
      const filtered = getFilteredReports();
      if (filtered.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No report cards match the current filters.";
        empty.style.opacity = "0.6";
        list.append(empty);
      } else {
        for (const report of filtered) {
          list.append(renderReportCard(report));
        }
      }
    }

    page.append(list);
    return page;
  }

  return { renderPage, ensureLoaded };
}
