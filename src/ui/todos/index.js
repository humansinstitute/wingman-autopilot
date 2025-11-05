const PRIORITY_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
];

const PRIORITY_LABELS = new Map(PRIORITY_OPTIONS.map((option) => [option.value, option.label]));

const formatDisplayDate = (isoString) => {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const toDateInputValue = (isoString) => {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDateInputValue = (value) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }
  return date.toISOString();
};

const sortTodos = (todos) => {
  return [...todos].sort((left, right) => {
    const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
    const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
    return rightTime - leftTime;
  });
};

const getErrorMessage = async (response) => {
  const payload = await response.json().catch(() => ({}));
  const message = typeof payload?.error === "string" ? payload.error : response.statusText;
  return message || "Request failed";
};

export const createTodoFeature = ({ onRenderRequested, getApps }) => {
  const state = {
    items: [],
    loading: false,
    error: null,
    initialized: false,
    lastLoadedAt: null,
  };

  const requestRender = () => {
    if (typeof onRenderRequested === "function") {
      onRenderRequested();
    }
  };

  const getAppLabel = (appId) => {
    if (!appId) {
      return null;
    }
    const apps = typeof getApps === "function" ? getApps() : [];
    if (!Array.isArray(apps)) {
      return null;
    }
    const match = apps.find((app) => app?.id === appId);
    return match?.label ?? match?.id ?? appId;
  };

  const setTodos = (todos) => {
    state.items = sortTodos(todos);
    state.lastLoadedAt = new Date().toISOString();
    requestRender();
  };

  const updateTodoInState = (todo) => {
    const mapped = state.items.map((existing) => (existing.id === todo.id ? todo : existing));
    setTodos(mapped);
  };

  const removeTodoFromState = (id) => {
    const filtered = state.items.filter((todo) => todo.id !== id);
    setTodos(filtered);
  };

  const fetchTodos = async () => {
    if (state.loading) {
      return;
    }
    state.loading = true;
    state.error = null;
    requestRender();
    try {
      const response = await fetch("/api/todos", {
        headers: {
          "cache-control": "no-cache",
        },
      });
      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }
      const payload = await response.json().catch(() => ({}));
      const received = Array.isArray(payload?.todos) ? payload.todos : [];
      setTodos(received);
      state.initialized = true;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      requestRender();
    }
  };

  const ensureLoaded = async () => {
    if (state.initialized || state.loading) {
      return;
    }
    await fetchTodos();
  };

  const createTodo = async (input) => {
    state.error = null;
    requestRender();
    const response = await fetch("/api/todos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      state.error = await getErrorMessage(response);
      requestRender();
      throw new Error(state.error);
    }
    const payload = await response.json().catch(() => ({}));
    const created = payload?.todo;
    if (created) {
      setTodos([...state.items, created]);
    }
    return created;
  };

  const updateTodo = async (id, input) => {
    state.error = null;
    requestRender();
    const response = await fetch(`/api/todos/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      state.error = await getErrorMessage(response);
      requestRender();
      throw new Error(state.error);
    }
    const payload = await response.json().catch(() => ({}));
    const updated = payload?.todo;
    if (updated) {
      updateTodoInState(updated);
    }
    return updated;
  };

  const deleteTodo = async (id) => {
    state.error = null;
    requestRender();
    const response = await fetch(`/api/todos/${id}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) {
      state.error = await getErrorMessage(response);
      requestRender();
      throw new Error(state.error);
    }
    removeTodoFromState(id);
  };

  const toggleStar = async (todo) => {
    await updateTodo(todo.id, { starred: !todo.starred });
  };

  const setPriority = async (todo, priority) => {
    await updateTodo(todo.id, { priority });
  };

  const renderCreateForm = () => {
    const formCard = document.createElement("section");
    formCard.className = "wm-card wm-todo-form";

    const heading = document.createElement("h2");
    heading.textContent = "New Todo";
    formCard.append(heading);

    const form = document.createElement("form");
    form.noValidate = true;
    form.className = "wm-todo-form__form";

    const titleField = document.createElement("div");
    titleField.className = "wm-todo-field";
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Title";
    titleLabel.setAttribute("for", "todo-title");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.id = "todo-title";
    titleInput.name = "title";
    titleInput.required = true;
    titleInput.placeholder = "Define the task…";
    titleField.append(titleLabel, titleInput);

    const descriptionField = document.createElement("div");
    descriptionField.className = "wm-todo-field";
    const descriptionLabel = document.createElement("label");
    descriptionLabel.setAttribute("for", "todo-description");
    descriptionLabel.textContent = "Description";
    const descriptionInput = document.createElement("textarea");
    descriptionInput.id = "todo-description";
    descriptionInput.name = "description";
    descriptionInput.rows = 3;
    descriptionInput.placeholder = "Optional context or notes";
    descriptionField.append(descriptionLabel, descriptionInput);

    const dueField = document.createElement("div");
    dueField.className = "wm-todo-field";
    const dueLabel = document.createElement("label");
    dueLabel.setAttribute("for", "todo-due");
    dueLabel.textContent = "Due Date";
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.id = "todo-due";
    dueInput.name = "dueDate";
    dueField.append(dueLabel, dueInput);

    const priorityField = document.createElement("div");
    priorityField.className = "wm-todo-field";
    const priorityLabel = document.createElement("label");
    priorityLabel.setAttribute("for", "todo-priority");
    priorityLabel.textContent = "Priority";
    const prioritySelect = document.createElement("select");
    prioritySelect.id = "todo-priority";
    prioritySelect.name = "priority";
    PRIORITY_OPTIONS.forEach((option) => {
      const entry = document.createElement("option");
      entry.value = String(option.value);
      entry.textContent = option.label;
      prioritySelect.append(entry);
    });
    priorityField.append(priorityLabel, prioritySelect);

    const appField = document.createElement("div");
    appField.className = "wm-todo-field";
    const appLabel = document.createElement("label");
    appLabel.setAttribute("for", "todo-app");
    appLabel.textContent = "Associated App";
    const appSelect = document.createElement("select");
    appSelect.id = "todo-app";
    appSelect.name = "appId";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "None";
    appSelect.append(defaultOption);
    const apps = typeof getApps === "function" ? getApps() : [];
    if (Array.isArray(apps)) {
      apps.forEach((app) => {
        if (!app?.id) return;
        const option = document.createElement("option");
        option.value = app.id;
        option.textContent = app.label ?? app.id;
        appSelect.append(option);
      });
    }
    appField.append(appLabel, appSelect);

    const starField = document.createElement("div");
    starField.className = "wm-todo-field wm-todo-inline";
    const starLabel = document.createElement("label");
    starLabel.setAttribute("for", "todo-star");
    starLabel.textContent = "Starred";
    const starInput = document.createElement("input");
    starInput.type = "checkbox";
    starInput.id = "todo-star";
    starInput.name = "starred";
    starField.append(starLabel, starInput);

    const actions = document.createElement("div");
    actions.className = "wm-todo-actions";
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "wm-button";
    submitButton.textContent = "Add Todo";
    actions.append(submitButton);

    form.append(titleField, descriptionField, dueField, priorityField, appField, starField, actions);
    formCard.append(form);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const title = (formData.get("title") ?? "").toString().trim();
      if (!title) {
        titleInput.focus();
        return;
      }
      const description = formData.get("description");
      const dueDateValue = formData.get("dueDate")?.toString() ?? "";
      let dueDate = null;
      try {
        dueDate = parseDateInputValue(dueDateValue);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Invalid date");
        dueInput.focus();
        return;
      }
      const priorityValue = Number.parseInt(formData.get("priority")?.toString() ?? "0", 10) || 0;
      const appIdRaw = formData.get("appId");
      const appId = appIdRaw ? appIdRaw.toString().trim() || null : null;
      const starred = formData.get("starred") === "on";

      submitButton.disabled = true;
      submitButton.textContent = "Saving…";
      try {
        await createTodo({
          title,
          description: description ? description.toString() : null,
          dueDate,
          priority: priorityValue,
          appId,
          starred,
        });
        form.reset();
        titleInput.focus();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save todo";
        window.alert(message);
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Add Todo";
      }
    });

    return formCard;
  };

  const renderTodoItem = (todo) => {
    const card = document.createElement("article");
    card.className = "wm-card wm-todo-item";

    const header = document.createElement("div");
    header.className = "wm-todo-item__header";

    const starButton = document.createElement("button");
    starButton.type = "button";
    starButton.className = todo.starred ? "wm-todo-star is-active" : "wm-todo-star";
    starButton.setAttribute("aria-pressed", todo.starred ? "true" : "false");
    starButton.textContent = todo.starred ? "★" : "☆";
    starButton.title = todo.starred ? "Unstar todo" : "Star todo";
    starButton.addEventListener("click", async () => {
      if (starButton.disabled) return;
      starButton.disabled = true;
      try {
        await toggleStar(todo);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update todo";
        window.alert(message);
      } finally {
        starButton.disabled = false;
      }
    });

    const title = document.createElement("h3");
    title.className = "wm-todo-item__title";
    title.textContent = todo.title;

    const priorityContainer = document.createElement("div");
    priorityContainer.className = "wm-todo-item__priority";
    const priorityLabel = document.createElement("label");
    priorityLabel.textContent = "Priority";
    priorityLabel.htmlFor = `todo-priority-${todo.id}`;
    const prioritySelect = document.createElement("select");
    prioritySelect.id = `todo-priority-${todo.id}`;
    PRIORITY_OPTIONS.forEach((option) => {
      const entry = document.createElement("option");
      entry.value = String(option.value);
      entry.textContent = option.label;
      if (todo.priority === option.value) {
        entry.selected = true;
      }
      prioritySelect.append(entry);
    });
    prioritySelect.addEventListener("change", async () => {
      prioritySelect.disabled = true;
      const newValue = Number.parseInt(prioritySelect.value, 10) || 0;
      try {
        await setPriority(todo, newValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update priority";
        window.alert(message);
        prioritySelect.value = String(todo.priority);
      } finally {
        prioritySelect.disabled = false;
      }
    });
    priorityContainer.append(priorityLabel, prioritySelect);

    header.append(starButton, title, priorityContainer);

    const meta = document.createElement("dl");
    meta.className = "wm-todo-item__meta";
    if (todo.appId) {
      const appTerm = document.createElement("dt");
      appTerm.textContent = "App";
      const appValue = document.createElement("dd");
      appValue.textContent = getAppLabel(todo.appId) ?? todo.appId;
      meta.append(appTerm, appValue);
    }
    if (todo.dueDate) {
      const dueTerm = document.createElement("dt");
      dueTerm.textContent = "Due";
      const dueValue = document.createElement("dd");
      dueValue.textContent = formatDisplayDate(todo.dueDate);
      meta.append(dueTerm, dueValue);
    }
    const priorityTerm = document.createElement("dt");
    priorityTerm.textContent = "Priority";
    const priorityValue = document.createElement("dd");
    priorityValue.textContent = PRIORITY_LABELS.get(todo.priority) ?? todo.priority;
    meta.append(priorityTerm, priorityValue);

    const description = document.createElement("p");
    description.className = "wm-todo-item__description";
    description.textContent = todo.description ?? "";
    if (!todo.description) {
      description.hidden = true;
    }

    const actions = document.createElement("div");
    actions.className = "wm-todo-item__actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "wm-button secondary";
    editButton.textContent = "Edit";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wm-button secondary danger";
    deleteButton.textContent = "Delete";

    const editor = document.createElement("form");
    editor.className = "wm-todo-editor";
    editor.hidden = true;

    const editorTitleField = document.createElement("div");
    editorTitleField.className = "wm-todo-field";
    const editorTitleLabel = document.createElement("label");
    editorTitleLabel.textContent = "Title";
    editorTitleLabel.htmlFor = `todo-edit-title-${todo.id}`;
    const editorTitleInput = document.createElement("input");
    editorTitleInput.type = "text";
    editorTitleInput.id = `todo-edit-title-${todo.id}`;
    editorTitleInput.value = todo.title;
    editorTitleInput.required = true;
    editorTitleField.append(editorTitleLabel, editorTitleInput);

    const editorDescriptionField = document.createElement("div");
    editorDescriptionField.className = "wm-todo-field";
    const editorDescriptionLabel = document.createElement("label");
    editorDescriptionLabel.textContent = "Description";
    editorDescriptionLabel.htmlFor = `todo-edit-description-${todo.id}`;
    const editorDescriptionInput = document.createElement("textarea");
    editorDescriptionInput.id = `todo-edit-description-${todo.id}`;
    editorDescriptionInput.rows = 3;
    editorDescriptionInput.value = todo.description ?? "";
    editorDescriptionField.append(editorDescriptionLabel, editorDescriptionInput);

    const editorDueField = document.createElement("div");
    editorDueField.className = "wm-todo-field";
    const editorDueLabel = document.createElement("label");
    editorDueLabel.textContent = "Due date";
    editorDueLabel.htmlFor = `todo-edit-due-${todo.id}`;
    const editorDueInput = document.createElement("input");
    editorDueInput.type = "date";
    editorDueInput.id = `todo-edit-due-${todo.id}`;
    editorDueInput.value = toDateInputValue(todo.dueDate);
    editorDueField.append(editorDueLabel, editorDueInput);

    const editorAppField = document.createElement("div");
    editorAppField.className = "wm-todo-field";
    const editorAppLabel = document.createElement("label");
    editorAppLabel.textContent = "Associated app";
    editorAppLabel.htmlFor = `todo-edit-app-${todo.id}`;
    const editorAppSelect = document.createElement("select");
    editorAppSelect.id = `todo-edit-app-${todo.id}`;
    const editorDefaultOption = document.createElement("option");
    editorDefaultOption.value = "";
    editorDefaultOption.textContent = "None";
    editorAppSelect.append(editorDefaultOption);
    const apps = typeof getApps === "function" ? getApps() : [];
    if (Array.isArray(apps)) {
      apps.forEach((app) => {
        if (!app?.id) return;
        const option = document.createElement("option");
        option.value = app.id;
        option.textContent = app.label ?? app.id;
        if (todo.appId === app.id) {
          option.selected = true;
        }
        editorAppSelect.append(option);
      });
    }
    editorAppField.append(editorAppLabel, editorAppSelect);

    const editorStarField = document.createElement("div");
    editorStarField.className = "wm-todo-field wm-todo-inline";
    const editorStarLabel = document.createElement("label");
    editorStarLabel.textContent = "Starred";
    editorStarLabel.htmlFor = `todo-edit-star-${todo.id}`;
    const editorStarInput = document.createElement("input");
    editorStarInput.type = "checkbox";
    editorStarInput.id = `todo-edit-star-${todo.id}`;
    editorStarInput.checked = todo.starred;
    editorStarField.append(editorStarLabel, editorStarInput);

    const editorActions = document.createElement("div");
    editorActions.className = "wm-todo-actions";
    const editorSubmit = document.createElement("button");
    editorSubmit.type = "submit";
    editorSubmit.className = "wm-button";
    editorSubmit.textContent = "Save Changes";
    const editorCancel = document.createElement("button");
    editorCancel.type = "button";
    editorCancel.className = "wm-button secondary";
    editorCancel.textContent = "Cancel";
    editorActions.append(editorSubmit, editorCancel);

    editor.append(
      editorTitleField,
      editorDescriptionField,
      editorDueField,
      editorAppField,
      editorStarField,
      editorActions,
    );

    editButton.addEventListener("click", () => {
      editor.hidden = !editor.hidden;
      if (!editor.hidden) {
        editorTitleInput.focus();
      }
    });

    editorCancel.addEventListener("click", () => {
      editor.hidden = true;
      editorTitleInput.value = todo.title;
      editorDescriptionInput.value = todo.description ?? "";
      editorDueInput.value = toDateInputValue(todo.dueDate);
      editorAppSelect.value = todo.appId ?? "";
      editorStarInput.checked = todo.starred;
    });

    editor.addEventListener("submit", async (event) => {
      event.preventDefault();
      const updatedTitle = editorTitleInput.value.trim();
      if (!updatedTitle) {
        editorTitleInput.focus();
        return;
      }
      let dueDate = null;
      try {
        dueDate = parseDateInputValue(editorDueInput.value);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Invalid date");
        editorDueInput.focus();
        return;
      }
      const payload = {
        title: updatedTitle,
        description: editorDescriptionInput.value.trim() || null,
        dueDate,
        appId: editorAppSelect.value || null,
        starred: editorStarInput.checked,
      };
      editorSubmit.disabled = true;
      editorSubmit.textContent = "Saving…";
      try {
        await updateTodo(todo.id, payload);
        editor.hidden = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update todo";
        window.alert(message);
      } finally {
        editorSubmit.disabled = false;
        editorSubmit.textContent = "Save Changes";
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("Delete this todo?")) {
        return;
      }
      deleteButton.disabled = true;
      try {
        await deleteTodo(todo.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete todo";
        window.alert(message);
      } finally {
        deleteButton.disabled = false;
      }
    });

    actions.append(editButton, deleteButton);

    card.append(header);
    if (meta.children.length > 0) {
      card.append(meta);
    }
    card.append(description, actions, editor);

    return card;
  };

  const renderTodoList = () => {
    const listContainer = document.createElement("section");
    listContainer.className = "wm-todo-list";

    if (state.error) {
      const error = document.createElement("div");
      error.className = "wm-alert wm-alert-error";
      error.textContent = state.error;
      listContainer.append(error);
    }

    if (state.loading && !state.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-todo-status";
      loading.textContent = "Loading todos…";
      listContainer.append(loading);
      return listContainer;
    }

    if (!state.loading && state.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-todo-status";
      empty.textContent = "No todos yet. Add your first task to get started.";
      listContainer.append(empty);
      return listContainer;
    }

    state.items.forEach((todo) => {
      listContainer.append(renderTodoItem(todo));
    });

    return listContainer;
  };

  const renderPage = () => {
    const container = document.createElement("div");
    container.className = "wm-todos-page";

    const title = document.createElement("h1");
    title.className = "wm-todos-title";
    title.textContent = "Todos";
    container.append(title);

    container.append(renderCreateForm(), renderTodoList());

    return container;
  };

  const getHighlightedTodos = () => {
    return state.items.filter((todo) => todo.starred || todo.priority >= 3).slice(0, 5);
  };

  const renderHomeCard = () => {
    const highlighted = getHighlightedTodos();
    if (state.loading && !state.initialized) {
      return null;
    }
    if (highlighted.length === 0) {
      return null;
    }
    const card = document.createElement("section");
    card.className = "wm-card wm-home-todos";

    const header = document.createElement("div");
    header.className = "wm-home-section-header";
    const title = document.createElement("h2");
    title.textContent = "Priority Todos";
    const actions = document.createElement("div");
    actions.className = "wm-home-section-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "wm-button secondary";
    openButton.textContent = "Open Todos";
    openButton.addEventListener("click", () => {
      if (typeof window.navigateToTodos === "function") {
        window.navigateToTodos({ skipMenuClose: true });
      }
    });
    actions.append(openButton);
    header.append(title, actions);

    const list = document.createElement("ul");
    list.className = "wm-home-todo-list";
    highlighted.forEach((todo) => {
      const item = document.createElement("li");
      item.className = "wm-home-todo";
      const marker = document.createElement("span");
      marker.className = todo.starred ? "wm-home-todo__star" : "wm-home-todo__priority";
      marker.textContent = todo.starred ? "★" : PRIORITY_LABELS.get(todo.priority) ?? String(todo.priority);
      const text = document.createElement("span");
      text.className = "wm-home-todo__title";
      text.textContent = todo.title;
      const due = document.createElement("span");
      due.className = "wm-home-todo__due";
      due.textContent = formatDisplayDate(todo.dueDate);
      item.append(marker, text);
      if (due.textContent) {
        item.append(due);
      }
      list.append(item);
    });

    card.append(header, list);
    return card;
  };

  return {
    state,
    ensureLoaded,
    refresh: fetchTodos,
    renderPage,
    renderHomeCard,
    getHighlightedTodos,
    reset: () => {
      state.items = [];
      state.loading = false;
      state.error = null;
      state.initialized = false;
      state.lastLoadedAt = null;
      requestRender();
    },
  };
};
