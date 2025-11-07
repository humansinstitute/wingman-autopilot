import { createProjectState } from "./state.js";
import { createProjectView } from "./view.js";

function createProjectFeature({ onRenderRequested, onCreateRequested }) {
  const requestRender = () => {
    if (typeof onRenderRequested === "function") {
      onRenderRequested();
    }
  };

  const stateApi = createProjectState({
    onStateChange: requestRender,
  });

  const actions = {
    refresh: stateApi.refresh,
    setCreateFormValue: stateApi.setCreateFormValue,
    submitCreateProject: stateApi.submitCreateProject,
    getAppForm: stateApi.getAppForm,
    setAppFormValue: stateApi.setAppFormValue,
    submitProjectApp: stateApi.submitProjectApp,
    openCreateDialog: () => {
      if (typeof onCreateRequested === "function") {
        onCreateRequested();
      }
    },
  };

  const view = createProjectView({
    state: stateApi.state,
    actions,
  });

  return {
    state: stateApi.state,
    ensureLoaded: stateApi.ensureLoaded,
    refresh: stateApi.refresh,
    renderPage: view.renderPage,
    setCreateFormValue: stateApi.setCreateFormValue,
    submitCreateProject: stateApi.submitCreateProject,
    getAppForm: stateApi.getAppForm,
    setAppFormValue: stateApi.setAppFormValue,
    submitProjectApp: stateApi.submitProjectApp,
  };
}

export { createProjectFeature };
