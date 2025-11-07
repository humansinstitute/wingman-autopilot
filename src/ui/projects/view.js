function createProjectView({ state, actions }) {
  function renderPage() {
    const container = document.createElement("div");
    container.className = "wm-projects-page";

    const header = document.createElement("div");
    header.className = "wm-projects-header";
    const title = document.createElement("h1");
    title.textContent = "Projects";
    header.append(title);

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "wm-button secondary";
    refreshButton.textContent = state.loading ? "Refreshing…" : "Refresh";
    refreshButton.disabled = state.loading;
    refreshButton.addEventListener("click", () => {
      refreshButton.disabled = true;
      void actions.refresh();
    });
    header.append(refreshButton);

    container.append(header);
    container.append(renderCreateCard());
    container.append(renderProjectList());
    return container;
  }

  function renderCreateCard() {
    const card = document.createElement("section");
    card.className = "wm-card wm-project-card";

    const title = document.createElement("h2");
    title.textContent = "Create a Project";
    card.append(title);

    const description = document.createElement("p");
    description.className = "wm-project-card__description";
    description.textContent =
      "Define a root folder for your project so apps can be organised beneath it.";
    card.append(description);

    const form = document.createElement("form");
    form.className = "wm-project-form";
    form.noValidate = true;

    const fields = document.createElement("div");
    fields.className = "wm-project-form__fields";

    fields.append(
      createInputField({
        label: "Project name",
        placeholder: "Wingman Demo",
        value: state.createForm.name,
        onInput: (value) => actions.setCreateFormValue("name", value),
      }),
    );

    fields.append(
      createInputField({
        label: "Project folder",
        placeholder: "/Users/you/code/wingman-demo",
        value: state.createForm.rootPath,
        onInput: (value) => actions.setCreateFormValue("rootPath", value),
      }),
    );

    form.append(fields);

    if (state.createForm.error) {
      const error = document.createElement("p");
      error.className = "wm-project-form__error";
      error.textContent = state.createForm.error;
      form.append(error);
    }

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "wm-button";
    submit.textContent = state.createForm.submitting ? "Creating…" : "Create Project";
    submit.disabled = state.createForm.submitting;
    form.append(submit);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void actions.submitCreateProject();
    });

    card.append(form);
    return card;
  }

  function renderProjectList() {
    const wrapper = document.createElement("section");
    wrapper.className = "wm-project-list";

    if (state.error) {
      const error = document.createElement("div");
      error.className = "wm-alert wm-alert-error";
      error.textContent = state.error;
      wrapper.append(error);
    }

    if (state.loading && !state.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-projects-empty";
      loading.textContent = "Loading projects…";
      wrapper.append(loading);
      return wrapper;
    }

    const projects = Array.isArray(state.items) ? state.items : [];
    if (projects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-projects-empty";
      empty.textContent = "No projects yet. Create one to start organising apps.";
      wrapper.append(empty);
      return wrapper;
    }

    projects.forEach((project) => {
      wrapper.append(renderProjectCard(project));
    });

    return wrapper;
  }

  function renderProjectCard(project) {
    const card = document.createElement("section");
    card.className = "wm-card wm-project-card";

    const header = document.createElement("div");
    header.className = "wm-project-card__header";

    const title = document.createElement("h3");
    title.textContent = project.name;
    header.append(title);

    const path = document.createElement("code");
    path.className = "wm-project-card__path";
    path.textContent = project.rootPath;
    header.append(path);

    card.append(header);

    const appsHeader = document.createElement("div");
    appsHeader.className = "wm-project-apps__header";
    const appsTitle = document.createElement("p");
    appsTitle.className = "wm-project-apps__title";
    appsTitle.textContent = "Apps";
    appsHeader.append(appsTitle);
    card.append(appsHeader);

    card.append(renderAppList(project));
    card.append(renderAppForm(project));

    return card;
  }

  function renderAppList(project) {
    const apps = Array.isArray(project.apps) ? project.apps : [];
    const list = document.createElement("ul");
    list.className = "wm-project-apps";

    if (apps.length === 0) {
      const empty = document.createElement("li");
      empty.className = "wm-project-apps__empty";
      empty.textContent = "No apps linked yet.";
      list.append(empty);
      return list;
    }

    apps.forEach((app) => {
      const item = document.createElement("li");
      item.className = "wm-project-app";

      const name = document.createElement("p");
      name.className = "wm-project-app__name";
      name.textContent = app.name;

      const folder = document.createElement("code");
      folder.className = "wm-project-app__path";
      folder.textContent = app.folderPath;

      item.append(name, folder);
      list.append(item);
    });

    return list;
  }

  function renderAppForm(project) {
    const form = document.createElement("form");
    form.className = "wm-project-app-form";
    form.noValidate = true;

    const formState = actions.getAppForm(project.id);

    const nameField = createInputField({
      label: "App name",
      placeholder: "Docs viewer",
      value: formState?.name ?? "",
      onInput: (value) => actions.setAppFormValue(project.id, "name", value),
    });
    nameField.classList.add("wm-project-app-form__field");

    const folderField = createInputField({
      label: "App folder",
      placeholder: `${project.rootPath}/apps/docs`,
      value: formState?.folderPath ?? "",
      onInput: (value) => actions.setAppFormValue(project.id, "folderPath", value),
    });
    folderField.classList.add("wm-project-app-form__field");

    form.append(nameField, folderField);

    if (formState?.error) {
      const error = document.createElement("p");
      error.className = "wm-project-form__error";
      error.textContent = formState.error;
      form.append(error);
    }

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "wm-button secondary";
    submit.textContent = formState?.submitting ? "Adding…" : "Add App";
    submit.disabled = Boolean(formState?.submitting);
    form.append(submit);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void actions.submitProjectApp(project.id);
    });

    return form;
  }

  function createInputField({ label, value, placeholder, onInput }) {
    const field = document.createElement("label");
    field.className = "wm-project-field";

    const caption = document.createElement("span");
    caption.className = "wm-project-field__label";
    caption.textContent = label;

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder ?? "";
    input.addEventListener("input", (event) => {
      onInput(event.target.value);
    });

    field.append(caption, input);
    return field;
  }

  return {
    renderPage,
  };
}

export { createProjectView };
