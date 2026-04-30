import {
  RUN_FILTERS,
  escapeAttribute,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatRunMeta,
  renderEmptyDetail,
  renderEmptyState,
  renderJsonBlock,
  statusLabel,
} from "./view-utils.js";

export function renderRunsWorkspace(state) {
  const runs = getFilteredRuns(state);
  return `
    <section class="wm-pipeline-workspace wm-pipeline-runs-workspace" aria-labelledby="pipeline-runs-title">
      <div class="wm-pipeline-panel wm-pipeline-list-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-runs-title">Previous Runs</h2>
            <p class="wm-muted">${state.runs.length} run${state.runs.length === 1 ? "" : "s"} recorded</p>
          </div>
        </div>
        ${renderRunControls(state)}
        ${runs.length ? renderRunList(state, runs) : renderEmptyState("No pipeline runs match this view.", "Run Pipeline", "open-launcher")}
      </div>
      <div class="wm-pipeline-panel wm-pipeline-detail-panel">
        ${state.selectedRun ? renderRunDetail(state) : renderEmptyDetail("Select a run to inspect its timeline, input, result, events, and callbacks.")}
      </div>
    </section>
  `;
}

export function renderRunsListPage(state) {
  const runs = getFilteredRuns(state);
  return `
    <section class="wm-pipeline-page-section wm-pipeline-runs-page" aria-labelledby="pipeline-runs-title">
      <div class="wm-pipeline-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-runs-title">Previous Runs</h2>
            <p class="wm-muted">${state.runs.length} run${state.runs.length === 1 ? "" : "s"} recorded</p>
          </div>
        </div>
        ${renderRunControls(state)}
        ${runs.length ? renderRunList(state, runs) : renderEmptyState("No pipeline runs match this view.", "Run Pipeline", "open-launcher")}
      </div>
    </section>
  `;
}

export function renderRunDetailPage(state, runId) {
  const loadedRunId = state.selectedRun?.run?.id ?? "";
  const detail = loadedRunId && loadedRunId === runId
    ? renderRunDetail(state)
    : `<div class="wm-pipeline-empty-detail"><h2 id="pipeline-run-detail-title">Loading Run</h2><p>Loading pipeline run...</p></div>`;
  return `
    <section class="wm-pipeline-page-section wm-pipeline-run-detail-page" aria-labelledby="pipeline-run-detail-title">
      <div class="wm-pipeline-panel">
        <div>
          <button type="button" data-action="navigate-pipeline" data-path="/pipelines/runs">Back to Runs</button>
        </div>
        ${detail}
      </div>
    </section>
  `;
}

function renderRunControls(state) {
  return `
    <div class="wm-pipeline-toolbar">
      <label>
        <span class="wm-sr-only">Search runs</span>
        <input type="search" data-action="run-search" value="${escapeAttribute(state.runSearch)}" placeholder="Search runs" data-testid="pipeline-run-search">
      </label>
      <div class="wm-pipeline-segmented" role="group" aria-label="Filter runs">
        ${RUN_FILTERS.map((filter) => `
          <button type="button" data-action="set-run-filter" data-filter="${escapeAttribute(filter)}" aria-pressed="${state.runFilter === filter}">
            ${escapeHtml(statusLabel(filter))}
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderRunList(state, runs) {
  return `
    <div class="wm-pipeline-run-list" data-testid="pipeline-run-list">
      ${runs.map((run) => `
        <button type="button" class="wm-pipeline-run-item" data-action="open-run" data-id="${escapeAttribute(run.id)}" aria-current="${state.selectedRun?.run?.id === run.id}" data-testid="pipeline-run-row">
          <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
          <span class="wm-pipeline-run-main">
            <strong>${escapeHtml(run.name)}</strong>
            <small>${escapeHtml(formatRunMeta(run))}</small>
          </span>
          <code>${escapeHtml(run.id.slice(0, 8))}</code>
        </button>
      `).join("")}
    </div>
  `;
}

function renderRunDetail(state) {
  const run = state.selectedRun.run;
  const steps = state.selectedRun.steps ?? [];
  return `
    <article class="wm-pipeline-run-detail" data-testid="pipeline-run-detail">
      <header class="wm-pipeline-detail-header">
        <div>
          <h2 id="pipeline-run-detail-title">${escapeHtml(run.name)}</h2>
          <p><code>${escapeHtml(run.id)}</code></p>
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
      </header>
      <dl class="wm-pipeline-facts">
        <div><dt>Started</dt><dd>${escapeHtml(formatDateTime(run.startedAt ?? run.started_at))}</dd></div>
        <div><dt>Completed</dt><dd>${escapeHtml(formatDateTime(run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(run.startedAt ?? run.started_at, run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Steps</dt><dd>${steps.length}</dd></div>
      </dl>
      <div class="wm-pipeline-detail-tabs" role="tablist" aria-label="Run detail">
        ${["overview", "input", "result"].map((tab) => `
          <button type="button" data-action="set-run-tab" data-tab="${tab}" role="tab" aria-selected="${state.selectedRunTab === tab}">
            ${escapeHtml(tab[0].toUpperCase() + tab.slice(1))}
          </button>
        `).join("")}
      </div>
      ${renderSelectedRunTab(state, run, steps)}
    </article>
  `;
}

function renderSelectedRunTab(state, run, steps) {
  if (state.selectedRunTab === "input") return renderJsonBlock("Input", run.input);
  if (state.selectedRunTab === "result") return renderJsonBlock("Result", run.result ?? run.error ?? {});
  return `
    <section class="wm-pipeline-step-timeline" aria-label="Pipeline steps">
      ${steps.length ? steps.map((step) => renderStepRow(state, run.id, step)).join("") : `<p class="wm-muted">No steps recorded for this run.</p>`}
    </section>
    ${state.selectedStep ? renderStepDetail(state) : ""}
  `;
}

function renderStepRow(state, runId, step) {
  return `
    <button type="button" class="wm-pipeline-step-row" data-action="select-step" data-run-id="${escapeAttribute(runId)}" data-step-id="${escapeAttribute(step.id)}" aria-current="${state.selectedStep?.step?.id === step.id}">
      <span class="wm-pipeline-step-number">${escapeHtml(String(step.stepIndex))}</span>
      <span class="wm-pipeline-step-main">
        <strong>${escapeHtml(step.name)}</strong>
        <small>${escapeHtml(step.kind)}${step.wingmanSessionId ? ` - ${escapeHtml(step.wingmanSessionId.slice(0, 8))}` : ""}</small>
      </span>
      <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(step.status)}">${escapeHtml(statusLabel(step.status))}</span>
    </button>
  `;
}

function renderStepDetail(state) {
  const { step, events = [], callbacks = [], previousSteps = [] } = state.selectedStep;
  return `
    <section class="wm-pipeline-step-detail" data-testid="pipeline-step-detail">
      <div class="wm-pipeline-section-heading">
        <div>
          <h3>${escapeHtml(step.name)}</h3>
          <p><code>${escapeHtml(step.id)}</code>${step.wingmanSessionId ? ` session <code>${escapeHtml(step.wingmanSessionId)}</code>` : ""}</p>
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(step.status)}">${escapeHtml(statusLabel(step.status))}</span>
      </div>
      <div class="wm-pipeline-json-grid">
        ${renderJsonBlock("Input", step.input)}
        ${renderJsonBlock("Output", step.result)}
      </div>
      ${renderStepDetailSection("Previous outputs", previousSteps.map((entry) => ({ name: entry.name, result: entry.result })))}
      ${renderStepDetailSection("Events", events)}
      ${renderStepDetailSection("Callbacks", callbacks)}
    </section>
  `;
}

function renderStepDetailSection(title, value) {
  return `
    <details>
      <summary>${escapeHtml(title)}</summary>
      <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
    </details>
  `;
}

function getFilteredRuns(state) {
  const query = state.runSearch.trim().toLowerCase();
  return state.runs.filter((run) => {
    const statusMatches = state.runFilter === "all" || run.status === state.runFilter;
    const textMatches = !query || `${run.name} ${run.id} ${run.status}`.toLowerCase().includes(query);
    return statusMatches && textMatches;
  });
}
