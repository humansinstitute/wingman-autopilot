/**
 * Night Watch Settings Panel
 *
 * Admin settings panel for configuring Night Watchman model, max cycles,
 * and viewing/dismissing report cards.
 */

import {
  fetchNightWatchConfig,
  updateNightWatchConfig,
  fetchNightWatchReports,
  deleteNightWatchReport,
} from "./api.js";

// ============================================================
// Status badge helpers
// ============================================================

const STATUS_COLORS = {
  complete: "#22c55e",
  error: "#ef4444",
  humanInput: "#f59e0b",
};

const STATUS_LABELS = {
  complete: "Complete",
  error: "Error",
  humanInput: "Human Input",
};

function createStatusBadge(status) {
  const badge = document.createElement("span");
  badge.style.cssText = `
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    background: ${STATUS_COLORS[status] || "#6b7280"};
  `;
  badge.textContent = STATUS_LABELS[status] || status;
  return badge;
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ============================================================
// Panel Init
// ============================================================

export function initNightWatchSettingsPanel({ state, render, showToast, createCollapsibleCard }) {
  async function loadConfig() {
    try {
      const data = await fetchNightWatchConfig();
      state.nightwatch.config.models = data.models || [];
      state.nightwatch.config.model = data.model || "google/gemini-3-flash-preview";
      state.nightwatch.config.maxCycles = data.maxCycles || 21;
      state.nightwatch.config.maxCycleOptions = data.maxCycleOptions || [6, 21, 256];
    } catch (err) {
      console.warn("[nightwatch] Failed to load config:", err);
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
      console.warn("[nightwatch] Failed to load reports:", err);
    } finally {
      state.nightwatch.reportsLoading = false;
    }
  }

  async function ensureLoaded() {
    if (!state.nightwatch.reportsInitialized) {
      await loadConfig();
      await loadReports();
    }
  }

  function renderPanel() {
    const nw = state.nightwatch;
    const { card, body } = createCollapsibleCard({
      title: "Night Watchman",
      className: "wm-nightwatch-settings",
      collapsed: state.settingsPanels.nightwatchCollapsed,
      onToggle(collapsed) {
        state.settingsPanels.nightwatchCollapsed = collapsed;
      },
    });

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

    const configRow = document.createElement("div");
    configRow.style.cssText = "display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;";
    modelGroup.style.flex = "1";
    cyclesGroup.style.flex = "0 0 auto";
    configRow.append(modelGroup, cyclesGroup);
    body.append(configRow);

    // Reports section
    const reportsTitle = document.createElement("h3");
    reportsTitle.textContent = "Report Cards";
    reportsTitle.style.cssText = "margin: 0.75rem 0 0.5rem; font-size: 0.9rem;";
    body.append(reportsTitle);

    if (nw.reportsLoading) {
      const loading = document.createElement("p");
      loading.textContent = "Loading reports...";
      loading.style.opacity = "0.6";
      body.append(loading);
    } else if (nw.reports.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No report cards yet.";
      empty.style.opacity = "0.6";
      body.append(empty);
    } else {
      const list = document.createElement("div");
      list.style.cssText = "display: flex; flex-direction: column; gap: 0.5rem;";
      for (const report of nw.reports) {
        list.append(renderReportCard(report));
      }
      body.append(list);
    }

    return card;
  }

  function renderReportCard(report) {
    const item = document.createElement("div");
    item.style.cssText = `
      border: 1px solid var(--border-color, #333);
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    `;

    // Header row: badge + session name + timestamp
    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;";
    header.append(createStatusBadge(report.status));

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

    item.append(header);

    // Summary
    const summary = document.createElement("p");
    summary.textContent = report.summary;
    summary.style.cssText = "margin: 0; font-size: 0.85rem; line-height: 1.4;";
    item.append(summary);

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
    item.append(actions);

    return item;
  }

  return { renderPanel, ensureLoaded };
}
