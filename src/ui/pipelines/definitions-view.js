import { renderCreator, renderEditWizard } from "./launcher-view.js";
import {
  DEFINITION_FILTERS,
  collectTags,
  countSteps,
  escapeAttribute,
  escapeHtml,
  expandPreviewSteps,
  renderEmptyDetail,
  renderEmptyState,
  renderTagPills,
  statusLabel,
} from "./view-utils.js";

export function renderDefinitionsWorkspace(state, selected) {
  const definitions = getFilteredDefinitions(state);
  return `
    <section class="wm-pipeline-workspace wm-pipeline-definitions-workspace" aria-labelledby="pipeline-definitions-title">
      <div class="wm-pipeline-panel wm-pipeline-list-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-definitions-title">Definitions</h2>
            <p class="wm-muted">${state.definitions.length} definition${state.definitions.length === 1 ? "" : "s"} available</p>
          </div>
          <button type="button" data-action="open-creator" data-testid="pipeline-new-action">New Pipeline</button>
        </div>
        ${renderDefinitionControls(state)}
        ${definitions.length ? renderDefinitionList(state, definitions) : renderEmptyState("No pipeline definitions match this view.", "New Pipeline", "open-creator")}
      </div>
      <div class="wm-pipeline-panel wm-pipeline-detail-panel">
        ${state.creatorOpen ? renderCreator(state) : selected ? renderDefinitionDetail(state, selected) : renderEmptyDetail("Select a definition to preview, run, or create a new version.")}
      </div>
    </section>
  `;
}

export function renderDefinitionsListPage(state) {
  const definitions = getFilteredDefinitions(state);
  return `
    <section class="wm-pipeline-page-section wm-pipeline-definitions-page" aria-labelledby="pipeline-definitions-title">
      <div class="wm-pipeline-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-definitions-title">Definitions</h2>
            <p class="wm-muted">${state.definitions.length} definition${state.definitions.length === 1 ? "" : "s"} available</p>
          </div>
          <button type="button" data-action="open-creator" data-testid="pipeline-new-action">New Pipeline</button>
        </div>
        ${state.creatorOpen ? renderCreator(state) : ""}
        ${renderDefinitionControls(state)}
        ${definitions.length ? renderDefinitionList(state, definitions) : renderEmptyState("No pipeline definitions match this view.", "New Pipeline", "open-creator")}
      </div>
    </section>
  `;
}

export function renderDefinitionDetailPage(state, definition) {
  return `
    <section class="wm-pipeline-page-section wm-pipeline-definition-detail-page" aria-labelledby="pipeline-definition-detail-title">
      <div class="wm-pipeline-panel">
        <div>
          <button type="button" data-action="navigate-pipeline" data-path="/pipelines/definitions">Back to Definitions</button>
        </div>
        ${definition ? renderDefinitionDetail(state, definition) : renderMissingDefinition()}
      </div>
    </section>
  `;
}

function renderMissingDefinition() {
  return `
    <div class="wm-pipeline-empty-detail">
      <h2 id="pipeline-definition-detail-title">Definition Not Found</h2>
      <p>Pipeline definition not found.</p>
    </div>
  `;
}

function renderDefinitionControls(state) {
  const tags = collectTags(state.definitions);
  return `
    <div class="wm-pipeline-toolbar">
      <label>
        <span class="wm-sr-only">Search definitions</span>
        <input type="search" data-action="definition-search" value="${escapeAttribute(state.definitionSearch)}" placeholder="Search definitions" data-testid="pipeline-definition-search">
      </label>
      <div class="wm-pipeline-segmented" role="group" aria-label="Filter definitions">
        ${DEFINITION_FILTERS.map((filter) => `
          <button type="button" data-action="set-definition-filter" data-filter="${escapeAttribute(filter)}" aria-pressed="${state.definitionFilter === filter}">
            ${escapeHtml(statusLabel(filter))}
          </button>
        `).join("")}
      </div>
      <label class="wm-pipeline-filter-field">
        <span class="wm-sr-only">Filter definitions by tag</span>
        <select data-action="definition-tag-filter" data-testid="pipeline-definition-tag-filter" aria-label="Filter definitions by tag">
          <option value="">All tags</option>
          ${tags.map((tag) => `<option value="${escapeAttribute(tag)}" ${state.definitionTagFilter === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("")}
        </select>
      </label>
    </div>
  `;
}

function renderDefinitionList(state, definitions) {
  return `
    <div class="wm-pipeline-definition-list" data-testid="pipeline-definition-list">
      ${definitions.map((definition) => `
        <button type="button" class="wm-pipeline-definition-item" data-action="open-definition" data-id="${escapeAttribute(definition.id)}" aria-current="${state.selectedDefinitionId === definition.id}" data-testid="pipeline-definition-row">
          <span>
            <strong>${escapeHtml(definition.name)}</strong>
            <small>${escapeHtml(definition.description || "No description")}</small>
            ${renderTagPills(definition.tags)}
          </span>
          <span class="wm-pipeline-definition-meta">
            ${definition.default ? `<span>Default</span>` : ""}
            <span>${escapeHtml(definition.scope)}</span>
            <span>${escapeHtml(`${countSteps(definition)} steps`)}</span>
          </span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderDefinitionDetail(state, definition) {
  return `
    <article class="wm-pipeline-definition-detail" data-testid="pipeline-definition-detail">
      <header class="wm-pipeline-detail-header">
        <div>
          <h2 id="pipeline-definition-detail-title">${escapeHtml(definition.name)}</h2>
          ${definition.description ? `<p>${escapeHtml(definition.description)}</p>` : `<p class="wm-muted">No description.</p>`}
          <p><code>${escapeHtml(definition.id)}</code></p>
          ${renderTagPills(definition.tags)}
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(definition.default ? "default" : definition.scope)}">${escapeHtml(definition.default ? "Default" : definition.scope)}</span>
      </header>
      <div class="wm-pipeline-definition-actions">
        <button type="button" data-action="open-launcher-for-definition" data-id="${escapeAttribute(definition.id)}" aria-label="Run pipeline definition">Run</button>
        <button type="button" data-action="open-manual-edit" data-id="${escapeAttribute(definition.id)}" aria-label="Manually edit pipeline definition" ${definition.scope !== "user" ? "disabled title='Shared definitions must be duplicated before editing'" : ""}>Manual Edit</button>
        <button type="button" data-action="open-edit-wizard" data-id="${escapeAttribute(definition.id)}" aria-label="Edit pipeline definition with wizard" ${definition.scope !== "user" ? "disabled title='Shared definitions must be duplicated before editing'" : ""}>Edit with Wizard</button>
      </div>
      ${definition.scope !== "user" ? `<p class="wm-muted">Shared definitions cannot be edited directly. Create a user-owned version before changing them.</p>` : ""}
      <dl class="wm-pipeline-facts">
        <div><dt>Version</dt><dd>${escapeHtml(definition.version ?? "--")}</dd></div>
        <div><dt>Default</dt><dd>${definition.default ? "Yes" : "No"}</dd></div>
        <div><dt>Tags</dt><dd>${escapeHtml((definition.tags ?? []).join(", ") || "--")}</dd></div>
        <div><dt>Steps</dt><dd>${countSteps(definition)}</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(definition.scope)}</dd></div>
        <div><dt>Path</dt><dd><code>${escapeHtml(definition.path)}</code></dd></div>
      </dl>
      ${state.manualEditDefinitionId === definition.id ? renderManualEditPanel(state, definition) : ""}
      ${state.editDefinitionId === definition.id ? renderEditWizard(state, definition) : ""}
      <h3>Step Preview</h3>
      ${renderDefinitionFlow(definition)}
      <details>
        <summary>Default input</summary>
        <pre>${escapeHtml(JSON.stringify(definition.input ?? {}, null, 2))}</pre>
      </details>
    </article>
  `;
}

function renderManualEditPanel(state, definition) {
  const form = state.manualEditForm ?? {};
  return `
    <section class="wm-pipeline-creator wm-pipeline-edit-panel" aria-labelledby="pipeline-manual-edit-title" data-testid="pipeline-manual-edit-panel">
      <div class="wm-pipeline-section-heading">
        <div>
          <h3 id="pipeline-manual-edit-title">Manual Edit</h3>
          <p class="wm-muted">Saves a new versioned JSON declaration and leaves this file untouched.</p>
        </div>
        <button type="button" data-action="cancel-manual-edit" aria-label="Close manual edit panel">Close</button>
      </div>
      <label class="wm-pipeline-field">
        <span>Title</span>
        <input type="text" data-action="manual-edit-field" data-field="name" value="${escapeAttribute(form.name ?? definition.name)}" data-testid="pipeline-manual-edit-title-input" aria-label="Pipeline title">
      </label>
      <label class="wm-pipeline-field">
        <span>Description</span>
        <textarea data-action="manual-edit-field" data-field="description" rows="3" aria-label="Pipeline description">${escapeHtml(form.description ?? definition.description ?? "")}</textarea>
      </label>
      <label class="wm-pipeline-field">
        <span>Tags</span>
        <input type="text" data-action="manual-edit-field" data-field="tagsText" value="${escapeAttribute(form.tagsText ?? (definition.tags ?? []).join(", "))}" aria-label="Pipeline tags">
      </label>
      <label class="wm-pipeline-checkbox-field">
        <input type="checkbox" data-action="manual-edit-default" ${(form.default ?? definition.default) ? "checked" : ""} aria-label="Mark pipeline as default">
        <span>Mark as default pipeline</span>
      </label>
      <label class="wm-pipeline-field">
        <span>Default input JSON</span>
        <textarea data-action="manual-edit-field" data-field="inputText" rows="8" spellcheck="false" aria-label="Pipeline default input JSON">${escapeHtml(form.inputText ?? JSON.stringify(definition.input ?? {}, null, 2))}</textarea>
      </label>
      <label class="wm-pipeline-field">
        <span>Workflow steps JSON</span>
        <textarea data-action="manual-edit-field" data-field="stepsText" rows="12" spellcheck="false" aria-label="Pipeline workflow steps JSON">${escapeHtml(form.stepsText ?? JSON.stringify(definition.steps ?? [], null, 2))}</textarea>
      </label>
      <div class="wm-pipeline-launcher-actions">
        <button type="button" data-action="cancel-manual-edit" aria-label="Cancel manual edit">Cancel</button>
        <button type="button" data-action="save-manual-edit" data-id="${escapeAttribute(definition.id)}" aria-label="Save manual edit as next version" ${state.manualEditBusy ? "disabled" : ""}>
          ${state.manualEditBusy ? "Saving..." : "Save Next Version"}
        </button>
      </div>
      ${state.manualEditResult ? renderManualEditResult(state.manualEditResult) : ""}
    </section>
  `;
}

function renderManualEditResult(result) {
  return `
    <div class="wm-pipeline-wizard-result" role="status">
      <strong>Saved new version</strong>
      <p>Target <code>${escapeHtml(result.targetPath ?? "")}</code></p>
      ${result.sourcePath ? `<p>Source <code>${escapeHtml(result.sourcePath)}</code></p>` : ""}
    </div>
  `;
}

function renderDefinitionFlow(definition) {
  const steps = expandPreviewSteps(Array.isArray(definition.steps) ? definition.steps : []);
  if (!steps.length) return `<p class="wm-muted">No steps defined.</p>`;
  return `
    <div class="wm-pipeline-definition-flow">
      ${steps.map((step, index) => renderDefinitionStep(step, index)).join("")}
    </div>
  `;
}

function renderDefinitionStep(step, index) {
  return `
    <article class="wm-pipeline-definition-step ${step.previewExpandedFrom ? "wm-pipeline-definition-step-expanded" : ""}">
      <div>
        <span class="wm-pipeline-step-number">${index + 1}</span>
        <strong>${escapeHtml(step.name)}</strong>
        <small>${escapeHtml(step.type)}${step.block ? ` - ${escapeHtml(step.block)}` : ""}${step.function ? ` - ${escapeHtml(step.function)}` : ""}${step.agent ? ` - ${escapeHtml(step.agent)}` : ""}</small>
      </div>
      ${step.previewExpandedFrom ? `<p class="wm-muted">Expanded from <code>${escapeHtml(step.previewExpandedFrom)}</code></p>` : ""}
      ${step.description ? `<p>${escapeHtml(step.description)}</p>` : ""}
      ${step.target ? `<p class="wm-muted">Loops to <code>${escapeHtml(step.target)}</code>${step.iterations ? ` until <code>${escapeHtml(String(step.iterations))}</code> passes complete` : ""}</p>` : ""}
      ${step.assign ? `<p class="wm-muted">Assigns to <code>${escapeHtml(step.assign)}</code></p>` : ""}
    </article>
  `;
}

function getFilteredDefinitions(state) {
  const query = state.definitionSearch.trim().toLowerCase();
  const tag = state.definitionTagFilter;
  return state.definitions.filter((definition) => {
    const scopeMatches = state.definitionFilter === "all"
      || (state.definitionFilter === "default" ? definition.default === true : definition.scope === state.definitionFilter);
    const tags = Array.isArray(definition.tags) ? definition.tags : [];
    const tagMatches = !tag || tags.includes(tag);
    const textMatches = !query || `${definition.name} ${definition.description ?? ""} ${definition.id} ${tags.join(" ")}`.toLowerCase().includes(query);
    return scopeMatches && tagMatches && textMatches;
  });
}
