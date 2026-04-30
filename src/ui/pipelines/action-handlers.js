import { fetchPipelineStep } from "./api.js";
import { makePipelinePath } from "./routes.js";
import { ensureSelectedDefinition } from "./state.js";

export function createPipelineActionHandlers(deps) {
  const {
    state,
    loadAll,
    hydrateRouteDetail,
    updatePage,
    updatePageAndRestoreFocus,
    navigateToPipelinePath,
    showToast,
    startCreateWizard,
    startEditWizard,
    startSelectedRun,
    startFunctionWizard,
  } = deps;

  const updateField = (page, key, value) => {
    state[key] = value;
    updatePage(page);
  };
  const updateSearch = (page, key, value, selector) => {
    state[key] = value;
    updatePageAndRestoreFocus(page, selector);
  };

  return {
    navigate: navigateToPipelinePath,
    refresh: async (page) => {
      await loadAll();
      await hydrateRouteDetail();
      updatePage(page);
      showToast("Pipelines refreshed");
    },
    openLauncher: (page) => {
      state.launcherOpen = true;
      ensureSelectedDefinition(state);
      state.runInputText = "";
      updatePage(page);
    },
    closeLauncher: (page) => updateField(page, "launcherOpen", false),
    updateRunSearch: (page, value) => updateSearch(page, "runSearch", value, '[data-action="run-search"]'),
    setRunFilter: (page, value) => updateField(page, "runFilter", value),
    openRun: (page, id) => navigateToPipelinePath(page, makePipelinePath("runs", id)),
    setRunTab: (page, value) => updateField(page, "selectedRunTab", value),
    selectStep: async (page, runId, stepId) => {
      if (!runId || !stepId) return;
      state.selectedStep = await fetchPipelineStep(runId, stepId);
      updatePage(page);
    },
    updateDefinitionSearch: (page, value) => updateSearch(page, "definitionSearch", value, '[data-action="definition-search"]'),
    setDefinitionFilter: (page, value) => updateField(page, "definitionFilter", value),
    openDefinition: async (page, id) => {
      if (!id) return;
      state.selectedDefinitionId = id;
      state.creatorOpen = false;
      state.editDefinitionId = "";
      await navigateToPipelinePath(page, makePipelinePath("definitions", id));
    },
    selectLauncherDefinition: (page, id) => {
      state.selectedDefinitionId = id;
      state.runInputText = "";
      updatePage(page);
    },
    updateRunInput: (value) => { state.runInputText = value; },
    openLauncherForDefinition: (page, id) => {
      if (id) state.selectedDefinitionId = id;
      state.launcherOpen = true;
      state.runInputText = "";
      updatePage(page);
    },
    openCreator: async (page) => {
      state.creatorOpen = true;
      state.editDefinitionId = "";
      state.wizardResult = null;
      await navigateToPipelinePath(page, makePipelinePath("definitions"));
    },
    closeCreator: (page) => updateField(page, "creatorOpen", false),
    updateWizardPrompt: (value) => { state.wizardPrompt = value; },
    startCreateWizard,
    openEditWizard: (page, id) => {
      if (!id) return;
      state.creatorOpen = false;
      state.editDefinitionId = id;
      state.editPrompt = "";
      state.editResult = null;
      updatePage(page);
    },
    cancelEditWizard: (page) => {
      state.editDefinitionId = "";
      state.editPrompt = "";
      state.editResult = null;
      updatePage(page);
    },
    updateEditPrompt: (value) => { state.editPrompt = value; },
    startEditWizard,
    startSelectedRun,
    openFunctionCreator: async (page) => {
      state.functionCreatorOpen = true;
      state.functionResult = null;
      await navigateToPipelinePath(page, makePipelinePath("functions"));
    },
    closeFunctionCreator: (page) => updateField(page, "functionCreatorOpen", false),
    updateFunctionPrompt: (value) => { state.functionPrompt = value; },
    startFunctionWizard,
    openFunction: (page, name) => navigateToPipelinePath(page, makePipelinePath("functions", name)),
  };
}
