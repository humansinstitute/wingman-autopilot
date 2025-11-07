import { createProjectState } from "./state.js";
import { createProjectView } from "./view.js";

function createProjectFeature({ onRenderRequested }) {
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
  };
}

export { createProjectFeature };
