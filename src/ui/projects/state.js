function createProjectState({ onStateChange }) {
  const state = {
    items: [],
    loading: false,
    error: null,
    initialized: false,
    createForm: {
      name: "",
      rootPath: "",
      submitting: false,
      error: null,
    },
    appForms: new Map(),
  };

  const notify = () => {
    if (typeof onStateChange === "function") {
      onStateChange();
    }
  };

  const readError = async (response) => {
    const payload = await response.json().catch(() => ({}));
    const message = typeof payload?.error === "string" ? payload.error : response.statusText;
    return message || "Request failed";
  };

  const setProjects = (projects) => {
    state.items = Array.isArray(projects) ? projects : [];
    state.initialized = true;
  };

  const upsertProject = (project) => {
    if (!project || !project.id) {
      return;
    }
    const index = state.items.findIndex((item) => item.id === project.id);
    if (index === -1) {
      state.items = [project, ...state.items];
      return;
    }
    const next = state.items.slice();
    next[index] = project;
    state.items = next;
  };

  const getAppForm = (projectId) => {
    if (!projectId) {
      return null;
    }
    let form = state.appForms.get(projectId);
    if (!form) {
      form = {
        name: "",
        folderPath: "",
        submitting: false,
        error: null,
      };
      state.appForms.set(projectId, form);
    }
    return form;
  };

  const fetchProjects = async () => {
    state.loading = true;
    state.error = null;
    notify();
    try {
      const response = await fetch("/api/projects", {
        headers: {
          "cache-control": "no-cache",
        },
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json().catch(() => ({}));
      setProjects(Array.isArray(payload?.projects) ? payload.projects : []);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      notify();
    }
  };

  const ensureLoaded = async () => {
    if (state.initialized || state.loading) {
      return;
    }
    await fetchProjects();
  };

  const refresh = async () => {
    await fetchProjects();
  };

  const setCreateFormValue = (field, value) => {
    if (!Object.prototype.hasOwnProperty.call(state.createForm, field)) {
      return;
    }
    state.createForm[field] = value;
    if (state.createForm.error) {
      state.createForm.error = null;
    }
    notify();
  };

  const submitCreateProject = async () => {
    if (state.createForm.submitting) {
      return;
    }
    const name = state.createForm.name.trim();
    const rootPath = state.createForm.rootPath.trim();
    if (!name || !rootPath) {
      state.createForm.error = "Project name and folder are required";
      notify();
      return;
    }
    state.createForm.submitting = true;
    state.createForm.error = null;
    notify();
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name,
          rootPath,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json().catch(() => ({}));
      if (payload?.project) {
        upsertProject(payload.project);
      } else {
        await fetchProjects();
      }
      state.createForm.name = "";
      state.createForm.rootPath = "";
    } catch (error) {
      state.createForm.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.createForm.submitting = false;
      notify();
    }
  };

  const setAppFormValue = (projectId, field, value) => {
    const form = getAppForm(projectId);
    if (!form) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(form, field)) {
      return;
    }
    form[field] = value;
    if (form.error) {
      form.error = null;
    }
    notify();
  };

  const submitProjectApp = async (projectId) => {
    if (!projectId) {
      return;
    }
    const form = getAppForm(projectId);
    if (!form || form.submitting) {
      return;
    }
    const name = form.name.trim();
    const folderPath = form.folderPath.trim();
    if (!name || !folderPath) {
      form.error = "App name and folder are required";
      notify();
      return;
    }
    form.submitting = true;
    form.error = null;
    notify();
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/apps`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name,
          folderPath,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json().catch(() => ({}));
      if (payload?.project) {
        upsertProject(payload.project);
      } else {
        await fetchProjects();
      }
      form.name = "";
      form.folderPath = "";
    } catch (error) {
      form.error = error instanceof Error ? error.message : String(error);
    } finally {
      form.submitting = false;
      notify();
    }
  };

  return {
    state,
    ensureLoaded,
    refresh,
    setCreateFormValue,
    submitCreateProject,
    getAppForm,
    setAppFormValue,
    submitProjectApp,
  };
}

export { createProjectState };
