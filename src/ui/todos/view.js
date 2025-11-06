import {
  PRIORITY_OPTIONS,
  PRIORITY_LABELS,
  formatDisplayDate,
  toDateInputValue,
} from "./utils.js";

function createTodoView({ state, actions }) {
  function renderPage() {
    const container = document.createElement("div");
    container.className = "wm-todos-page";

    const title = document.createElement("h1");
    title.className = "wm-todos-title";
    title.textContent = "Todos";
    container.append(title);

    container.append(renderTable());

    return container;
  }

  function renderTable() {
    const wrapper = document.createElement("section");
    wrapper.className = "wm-card wm-todo-table";

    wrapper.append(renderComposerRow());

    if (state.error) {
      const error = document.createElement("div");
      error.className = "wm-alert wm-alert-error";
      error.textContent = state.error;
      wrapper.append(error);
    }

    const table = document.createElement("table");
    table.className = "wm-todo-grid";
    const header = document.createElement("thead");
    header.append(renderHeaderRow());
    table.append(header);

    const body = document.createElement("tbody");
    if (state.loading && !state.initialized) {
      body.append(renderStatusRow("Loading todos…"));
    } else if (!state.loading && state.items.length === 0) {
      body.append(renderStatusRow("No todos yet. Capture your first task above."));
    } else {
      state.items.forEach((todo) => {
        body.append(renderTodoRow(todo));
        if (state.expandedId === todo.id) {
          body.append(renderExpandedRow(todo));
        }
      });
    }
    table.append(body);
    wrapper.append(table);

    return wrapper;
  }

  function renderComposerRow() {
    const composer = document.createElement("div");
    composer.className = state.composer.error ? "wm-todo-composer has-error" : "wm-todo-composer";

    const input = document.createElement("input");
    input.className = "wm-todo-composer__input";
    input.type = "text";
    input.placeholder = "Capture a new todo and press Enter";
    input.value = state.composer.value;
    input.disabled = state.composer.saving;
    input.addEventListener("input", (event) => {
      actions.setComposerValue(event.target.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        actions.createTodoFromComposer();
      }
    });

    const inputWrapper = document.createElement("div");
    inputWrapper.className = "wm-todo-composer__input-wrapper";
    inputWrapper.append(input);

    const icon = document.createElement("span");
    icon.className = "wm-todo-composer__icon";
    icon.textContent = "+";

    composer.append(inputWrapper, icon);

    if (typeof actions.consumeComposerFocus === "function" && actions.consumeComposerFocus()) {
      requestAnimationFrame(() => {
        input.focus();
      });
    }

    if (state.composer.error) {
      const message = document.createElement("p");
      message.className = "wm-todo-composer__error";
      message.textContent = state.composer.error;
      composer.append(message);
    }

    return composer;
  }

  function renderHeaderRow() {
    const headerRow = document.createElement("tr");
    headerRow.className = "wm-todo-header";

    const columns = [
      { label: "", className: "wm-todo-col-star" },
      { label: "Todo", className: "wm-todo-col-title" },
      { label: "Due", className: "wm-todo-col-due" },
      { label: "App", className: "wm-todo-col-app" },
      { label: "Priority", className: "wm-todo-col-priority" },
      { label: "Created", className: "wm-todo-col-created" },
    ];

    columns.forEach((column) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column.label;
      if (column.className) {
        cell.className = column.className;
      }
      headerRow.append(cell);
    });

    return headerRow;
  }

  function renderStatusRow(message) {
    const row = document.createElement("tr");
    row.className = "wm-todo-row is-status";

    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = message;
    row.append(cell);

    return row;
  }

  function renderTodoRow(todo) {
    const isExpanded = state.expandedId === todo.id;
    const row = document.createElement("tr");
    row.className = isExpanded ? "wm-todo-row is-expanded" : "wm-todo-row";
    row.dataset.todoId = todo.id;

    row.addEventListener("click", (event) => {
      if (event.target.closest("button") || event.target.closest("a") || event.target.closest("select") || event.target.tagName === "INPUT") {
        return;
      }
      actions.openTodo(todo.id);
    });

    row.append(renderStarCell(todo));
    row.append(renderTitleCell(todo));
    row.append(renderDueCell(todo));
    row.append(renderAppCell(todo));
    row.append(renderPriorityCell(todo));
    row.append(renderCreatedCell(todo));

    return row;
  }

  function renderStarCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-star";

    const button = document.createElement("button");
    button.type = "button";
    button.className = todo.starred ? "wm-todo-star is-active" : "wm-todo-star";
    button.setAttribute("aria-pressed", todo.starred ? "true" : "false");
    const starLabel = todo.starred ? "Unstar todo" : "Star todo";
    button.title = starLabel;
    button.setAttribute("aria-label", starLabel);
    button.textContent = todo.starred ? "★" : "☆";
    button.disabled = state.savingIds.has(todo.id);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.toggleStar(todo);
    });

    cell.append(button);
    return cell;
  }

  function renderTitleCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-title";

    const title = document.createElement("span");
    title.className = "wm-todo-title";
    title.textContent = todo.title;
    cell.append(title);

    if (todo.description) {
      const description = document.createElement("span");
      description.className = "wm-todo-subtitle";
      description.textContent = todo.description;
      cell.append(description);
    }

    return cell;
  }

  function renderDueCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-due";
    cell.textContent = formatDisplayDate(todo.dueDate) || "—";
    return cell;
  }

  function renderAppCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-app";
    cell.textContent = actions.getAppLabel(todo.appId) ?? "—";
    return cell;
  }

  function renderPriorityCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-priority";
    const label = PRIORITY_LABELS.get(todo.priority) ?? PRIORITY_LABELS.get(0) ?? "None";
    cell.textContent = label;
    return cell;
  }

  function renderCreatedCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-created";
    const createdAt = todo.createdAt ?? todo.updatedAt ?? null;
    cell.textContent = formatDisplayDate(createdAt) || "—";
    return cell;
  }

  function renderExpandedRow(todo) {
    const draft = actions.getDraft(todo.id);
    const row = document.createElement("tr");
    row.className = "wm-todo-row-details";

    const cell = document.createElement("td");
    cell.colSpan = 6;

    if (!draft) {
      const placeholder = document.createElement("p");
      placeholder.textContent = "Unable to load details for this todo.";
      cell.append(placeholder);
      row.append(cell);
      return row;
    }

    const form = document.createElement("form");
    form.className = "wm-todo-detail-form";
    form.noValidate = true;

    const titleField = createField({
      label: "Title",
      input: () => {
        const input = document.createElement("input");
        input.type = "text";
        input.required = true;
        input.value = draft.values.title;
        input.addEventListener("input", (event) => {
          actions.updateDraft(todo.id, { title: event.target.value });
        });
        return input;
      },
    });

    const descriptionField = createField({
      label: "Description",
      input: () => {
        const textarea = document.createElement("textarea");
        textarea.rows = 3;
        textarea.value = draft.values.description;
        textarea.addEventListener("input", (event) => {
          actions.updateDraft(todo.id, { description: event.target.value });
        });
        return textarea;
      },
    });

    const dueField = createField({
      label: "Due date",
      input: () => {
        const input = document.createElement("input");
        input.type = "date";
        input.value = toDateInputValue(draft.values.dueDate) || "";
        input.addEventListener("input", (event) => {
          actions.updateDraft(todo.id, { dueDate: event.target.value || null });
        });
        return input;
      },
    });

    const priorityField = createField({
      label: "Priority",
      input: () => {
        const select = document.createElement("select");
        PRIORITY_OPTIONS.forEach((option) => {
          const entry = document.createElement("option");
          entry.value = String(option.value);
          entry.textContent = option.label;
          if (Number(draft.values.priority) === option.value) {
            entry.selected = true;
          }
          select.append(entry);
        });
        select.addEventListener("change", (event) => {
          const value = Number.parseInt(event.target.value, 10) || 0;
          actions.updateDraft(todo.id, { priority: value });
        });
        return select;
      },
    });

    const appField = createField({
      label: "Associated app",
      input: () => {
        const select = document.createElement("select");
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "None";
        select.append(defaultOption);
        const apps = actions.getAppOptions();
        apps.forEach((app) => {
          if (!app?.id) {
            return;
          }
          const option = document.createElement("option");
          option.value = app.id;
          option.textContent = app.label ?? app.id;
          if (draft.values.appId === app.id) {
            option.selected = true;
          }
          select.append(option);
        });
        select.addEventListener("change", (event) => {
          actions.updateDraft(todo.id, { appId: event.target.value });
        });
        return select;
      },
    });

    const starredField = createField({
      label: "Starred",
      input: () => {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(draft.values.starred);
        checkbox.addEventListener("change", (event) => {
          actions.updateDraft(todo.id, { starred: event.target.checked });
        });
        return checkbox;
      },
    });

    const actionsBar = document.createElement("div");
    actionsBar.className = "wm-todo-detail-actions";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "wm-button secondary";
    closeButton.textContent = "Close";
    closeButton.hidden = draft.dirty;
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      actions.closeTodo(todo.id);
    });

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wm-button secondary";
    cancelButton.textContent = "Cancel";
    cancelButton.hidden = !draft.dirty;
    cancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      actions.resetDraft(todo.id);
    });

    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "wm-button";
    saveButton.textContent = draft.saving ? "Saving…" : "Save";
    saveButton.disabled = draft.saving;
    saveButton.hidden = !draft.dirty;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wm-button secondary danger";
    deleteButton.textContent = state.deletingIds.has(todo.id) ? "Deleting…" : "Delete";
    deleteButton.disabled = state.deletingIds.has(todo.id);
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      const confirmed = window.confirm("Delete this todo?");
      if (confirmed) {
        actions.deleteTodo(todo.id);
      }
    });

    actionsBar.append(closeButton, cancelButton, saveButton, deleteButton);

    if (draft.error) {
      const error = document.createElement("p");
      error.className = "wm-todo-detail-error";
      error.textContent = draft.error;
      actionsBar.append(error);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      actions.saveDraft(todo.id);
    });

    form.append(titleField, descriptionField, dueField, priorityField, appField, starredField, actionsBar);
    cell.append(form);
    row.append(cell);
    return row;
  }

  function createField({ label, input }) {
    const field = document.createElement("label");
    field.className = "wm-todo-detail-field";

    const caption = document.createElement("span");
    caption.className = "wm-todo-detail-label";
    caption.textContent = label;

    const control = document.createElement("div");
    control.className = "wm-todo-detail-control";
    control.append(input());

    field.append(caption, control);
    return field;
  }

  function renderHomeCard() {
    if (state.loading && !state.initialized) {
      return null;
    }
    const highlighted = actions.getHighlightedTodos();
    if (highlighted.length === 0) {
      return null;
    }

    const card = document.createElement("section");
    card.className = "wm-card wm-home-todos";

    const header = document.createElement("div");
    header.className = "wm-home-section-header";
    const title = document.createElement("h2");
    title.textContent = "Priority Todos";
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "wm-home-section-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "wm-button secondary";
    openButton.textContent = "Open Todos";
    openButton.addEventListener("click", () => {
      if (typeof window.navigateToTodos === "function") {
        window.navigateToTodos({ skipMenuClose: true });
      }
    });
    actionsContainer.append(openButton);
    header.append(title, actionsContainer);

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
  }

  return {
    renderPage,
    renderHomeCard,
  };
}

export { createTodoView };
