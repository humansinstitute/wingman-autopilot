import {
  fetchPipelineDefinitions,
  fetchPipelineRoot,
  fetchPipelineRuns,
  fetchPipelineRun,
  fetchPipelineStep,
  editPipelineWithWizard,
  runPipelineDefinition,
  startPipelineWizard,
} from "./api.js";
import { renderDefinitionsWorkspace } from "./definitions-view.js";
import { renderRunLauncher } from "./launcher-view.js";
import { renderRunsWorkspace } from "./runs-view.js";
import { escapeAttribute, escapeHtml } from "./view-utils.js";

export function initPipelinesPage({ showToast }) {
  const state = {
    activeTab: "runs",
    root: null,
    definitions: [],
    runs: [],
    selectedRun: null,
    selectedStep: null,
    selectedRunTab: "overview",
    selectedDefinitionId: "",
    runFilter: "all",
    definitionFilter: "all",
    runSearch: "",
    definitionSearch: "",
    launcherOpen: false,
    creatorOpen: false,
    wizardPrompt: "",
    wizardBusy: false,
    wizardResult: null,
    editDefinitionId: "",
    editPrompt: "",
    editBusy: false,
    editResult: null,
    runInputText: "",
    runningId: null,
    loading: false,
    error: null,
  };

  async function ensureLoaded() {
    await loadAll();
  }

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-page wm-pipelines-page";
    page.append(renderShell());
    void loadAll().then(() => updatePage(page)).catch((error) => renderError(page, error));
    return page;
  }

  async function loadAll() {
    state.loading = true;
    const [root, definitions, runs] = await Promise.all([
      fetchPipelineRoot(),
      fetchPipelineDefinitions(),
      fetchPipelineRuns(),
    ]);
    state.root = root;
    state.definitions = definitions.definitions ?? [];
    state.runs = runs.runs ?? [];
    ensureSelectedDefinition();
    state.loading = false;
  }

  function updatePage(page) {
    page.innerHTML = "";
    page.append(renderShell());
  }

  function renderError(page, error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
    updatePage(page);
  }

  function renderShell() {
    const wrap = document.createElement("main");
    wrap.className = "wm-pipelines-shell";
    wrap.setAttribute("aria-labelledby", "pipelines-title");
    const selected = getSelectedDefinition();
    if (state.launcherOpen) {
      ensureRunInputForSelection(selected);
    }
    wrap.innerHTML = `
      ${renderHeader()}
      ${state.error ? `<p class="wm-error" role="alert">${escapeHtml(state.error)}</p>` : ""}
      ${state.launcherOpen ? renderRunLauncher(state, selected) : ""}
      ${state.activeTab === "runs"
        ? renderRunsWorkspace(state)
        : renderDefinitionsWorkspace(state, selected)}
    `;
    bindActions(wrap);
    return wrap;
  }

  function renderHeader() {
    const rootLabel = state.root?.root ?? "~/.wingmen/pipelines";
    return `
      <header class="wm-pipelines-header">
        <div>
          <h1 id="pipelines-title">Pipelines</h1>
          <p class="wm-muted">Declarative object-in/object-out workflows from <code>${escapeHtml(rootLabel)}</code></p>
        </div>
        <div class="wm-pipelines-header-actions">
          <button type="button" data-action="open-launcher" data-testid="pipeline-run-action">Run Pipeline</button>
          <button type="button" data-action="refresh" data-testid="pipeline-refresh-action">Refresh</button>
        </div>
      </header>
      <nav class="wm-pipeline-tabs" aria-label="Pipeline sections" data-testid="pipeline-tabs">
        <button type="button" data-action="set-tab" data-tab="runs" aria-selected="${state.activeTab === "runs"}">Runs</button>
        <button type="button" data-action="set-tab" data-tab="definitions" aria-selected="${state.activeTab === "definitions"}">Definitions</button>
      </nav>
    `;
  }

  function bindActions(root) {
    const page = root.closest(".wm-pipelines-page") ?? root;
    bindHeaderActions(root, page);
    bindRunActions(root, page);
    bindDefinitionActions(root, page);
    bindWizardActions(root, page);
  }

  function bindHeaderActions(root, page) {
    root.querySelector('[data-action="refresh"]')?.addEventListener("click", async () => {
      await loadAll();
      updatePage(page);
      showToast("Pipelines refreshed");
    });
    root.querySelectorAll('[data-action="set-tab"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab === "definitions" ? "definitions" : "runs";
        state.creatorOpen = false;
        updatePage(page);
      });
    });
    root.querySelectorAll('[data-action="open-launcher"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.launcherOpen = true;
        ensureSelectedDefinition();
        state.runInputText = "";
        updatePage(page);
      });
    });
    root.querySelectorAll('[data-action="close-launcher"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.launcherOpen = false;
        updatePage(page);
      });
    });
  }

  function bindRunActions(root, page) {
    root.querySelector('[data-action="run-search"]')?.addEventListener("input", (event) => {
      state.runSearch = event.target?.value ?? "";
      updatePageAndRestoreFocus(page, '[data-action="run-search"]');
    });
    root.querySelectorAll('[data-action="set-run-filter"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.runFilter = button.dataset.filter ?? "all";
        updatePage(page);
      });
    });
    root.querySelectorAll('[data-action="select-run"]').forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.id;
        if (!id) return;
        state.selectedRun = await fetchPipelineRun(id);
        state.selectedStep = null;
        state.selectedRunTab = "overview";
        updatePage(page);
      });
    });
    root.querySelectorAll('[data-action="set-run-tab"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedRunTab = button.dataset.tab ?? "overview";
        updatePage(page);
      });
    });
    root.querySelectorAll('[data-action="select-step"]').forEach((button) => {
      button.addEventListener("click", async () => {
        const runId = button.dataset.runId;
        const stepId = button.dataset.stepId;
        if (!runId || !stepId) return;
        state.selectedStep = await fetchPipelineStep(runId, stepId);
        updatePage(page);
      });
    });
  }

  function bindDefinitionActions(root, page) {
    root.querySelector('[data-action="definition-search"]')?.addEventListener("input", (event) => {
      state.definitionSearch = event.target?.value ?? "";
      updatePageAndRestoreFocus(page, '[data-action="definition-search"]');
    });
    root.querySelectorAll('[data-action="set-definition-filter"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.definitionFilter = button.dataset.filter ?? "all";
        updatePage(page);
      });
    });
    root.querySelectorAll('[data-action="select-definition-card"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedDefinitionId = button.dataset.id ?? "";
        state.creatorOpen = false;
        state.editDefinitionId = "";
        updatePage(page);
      });
    });
    root.querySelector('[data-action="select-launcher-definition"]')?.addEventListener("change", (event) => {
      state.selectedDefinitionId = event.target?.value ?? "";
      state.runInputText = "";
      updatePage(page);
    });
    root.querySelector('[data-action="run-input"]')?.addEventListener("input", (event) => {
      state.runInputText = event.target?.value ?? "";
    });
    root.querySelector('[data-action="open-launcher-for-definition"]')?.addEventListener("click", (event) => {
      const id = event.currentTarget?.dataset?.id ?? "";
      if (id) state.selectedDefinitionId = id;
      state.launcherOpen = true;
      state.runInputText = "";
      updatePage(page);
    });
  }

  function bindWizardActions(root, page) {
    root.querySelectorAll('[data-action="open-creator"]').forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = "definitions";
        state.creatorOpen = true;
        state.editDefinitionId = "";
        state.wizardResult = null;
        updatePage(page);
      });
    });
    root.querySelector('[data-action="close-creator"]')?.addEventListener("click", () => {
      state.creatorOpen = false;
      updatePage(page);
    });
    root.querySelector('[data-action="wizard-prompt"]')?.addEventListener("input", (event) => {
      state.wizardPrompt = event.target?.value ?? "";
    });
    root.querySelector('[data-action="start-wizard"]')?.addEventListener("click", async () => {
      await startCreateWizard(page);
    });
    root.querySelector('[data-action="open-edit-wizard"]')?.addEventListener("click", (event) => {
      const id = event.currentTarget?.dataset?.id ?? "";
      if (!id) return;
      state.creatorOpen = false;
      state.editDefinitionId = id;
      state.editPrompt = "";
      state.editResult = null;
      updatePage(page);
    });
    root.querySelector('[data-action="cancel-edit-wizard"]')?.addEventListener("click", () => {
      state.editDefinitionId = "";
      state.editPrompt = "";
      state.editResult = null;
      updatePage(page);
    });
    root.querySelector('[data-action="edit-prompt"]')?.addEventListener("input", (event) => {
      state.editPrompt = event.target?.value ?? "";
    });
    root.querySelector('[data-action="start-edit-wizard"]')?.addEventListener("click", async (event) => {
      await startEditWizard(page, event.currentTarget?.dataset?.id ?? "");
    });
    root.querySelector('[data-action="run-selected-definition"]')?.addEventListener("click", async () => {
      await startSelectedRun(page);
    });
  }

  async function startCreateWizard(page) {
    const prompt = state.wizardPrompt.trim();
    if (!prompt) {
      showToast("Describe the pipeline first", { type: "warning" });
      return;
    }
    state.wizardBusy = true;
    state.wizardResult = null;
    state.error = null;
    updatePage(page);
    try {
      state.wizardResult = await startPipelineWizard(prompt);
      showToast("Pipeline wizard session started", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.wizardBusy = false;
      updatePage(page);
    }
  }

  async function startEditWizard(page, id) {
    const prompt = state.editPrompt.trim();
    if (!id || !prompt) {
      showToast("Describe the change first", { type: "warning" });
      return;
    }
    state.editBusy = true;
    state.editResult = null;
    state.error = null;
    updatePage(page);
    try {
      state.editResult = await editPipelineWithWizard(id, prompt);
      showToast("Pipeline edit wizard session started", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.editBusy = false;
      updatePage(page);
    }
  }

  async function startSelectedRun(page) {
    const id = state.selectedDefinitionId || pickDefaultDefinitionId();
    if (!id) return;
    state.runningId = id;
    state.error = null;
    updatePage(page);
    try {
      const payload = await runPipelineDefinition(id, parseRunInput());
      state.selectedRun = payload;
      state.selectedStep = null;
      state.selectedRunTab = "overview";
      state.activeTab = "runs";
      state.launcherOpen = false;
      const runs = await fetchPipelineRuns();
      state.runs = runs.runs ?? [];
      showToast("Pipeline run complete", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.runningId = null;
      updatePage(page);
    }
  }

  function updatePageAndRestoreFocus(page, selector) {
    updatePage(page);
    const input = page.querySelector(selector);
    if (input && typeof input.focus === "function") {
      input.focus({ preventScroll: true });
      if (typeof input.setSelectionRange === "function") {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
  }

  function getSelectedDefinition() {
    return state.definitions.find((definition) => definition.id === state.selectedDefinitionId) ?? state.definitions[0] ?? null;
  }

  function ensureSelectedDefinition() {
    if (state.selectedDefinitionId && state.definitions.some((definition) => definition.id === state.selectedDefinitionId)) {
      return;
    }
    state.selectedDefinitionId = pickDefaultDefinitionId();
  }

  function ensureRunInputForSelection(definition) {
    if (state.runInputText || !definition) return;
    state.runInputText = JSON.stringify(definition.input ?? {}, null, 2);
  }

  function parseRunInput() {
    const text = state.runInputText.trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Run input must be a JSON object");
    }
    return parsed;
  }

  function pickDefaultDefinitionId() {
    return state.definitions.find((definition) => definition.name === "demo-paragraph-two-agent-analysis")?.id
      ?? state.definitions[0]?.id
      ?? "";
  }

  return { renderPage, ensureLoaded };
}
