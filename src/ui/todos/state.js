import { sortTodos, parseDateInputValue, toDateInputValue } from "./utils.js";

function buildDraftValues(todo) {
  return {
    title: todo.title ?? "",
    description: todo.description ?? "",
    dueDate: toDateInputValue(todo.dueDate) || null,
    priority: Number.isInteger(todo.priority) ? todo.priority : 0,
    appId: todo.appId ?? "",
    starred: Boolean(todo.starred),
  };
}

async function getErrorMessage(response) {
  const payload = await response.json().catch(() => ({}));
  const message = typeof payload?.error === "string" ? payload.error : response.statusText;
  return message || "Request failed";
}

function createTodoState({ onStateChange, getApps }) {
  const state = {
    items: [],
    loading: false,
    error: null,
    initialized: false,
    lastLoadedAt: null,
    expandedId: null,
    drafts: new Map(),
    savingIds: new Set(),
    deletingIds: new Set(),
    composer: {
      value: "",
      saving: false,
      error: null,
      shouldFocus: false,
    },
  };

  function notify() {
    if (typeof onStateChange === "function") {
      onStateChange();
    }
  }

  function getAppLabel(appId) {
    if (!appId) {
      return null;
    }
    const apps = typeof getApps === "function" ? getApps() : [];
    if (!Array.isArray(apps)) {
      return null;
    }
    const match = apps.find((app) => app?.id === appId);
    return match?.label ?? match?.id ?? appId;
  }

  function getAppOptions() {
    const apps = typeof getApps === "function" ? getApps() : [];
    return Array.isArray(apps) ? apps : [];
  }

  function setTodos(todos) {
    state.items = sortTodos(todos);
    state.lastLoadedAt = new Date().toISOString();
    if (state.expandedId) {
      const openTodo = state.items.find((item) => item.id === state.expandedId);
      if (!openTodo) {
        const previousId = state.expandedId;
        state.expandedId = null;
        state.drafts.delete(previousId);
      } else {
        syncDraftFromTodo(openTodo);
      }
    }
    notify();
  }

  function syncDraftFromTodo(todo) {
    const draft = state.drafts.get(todo.id);
    if (!draft) {
      return;
    }
    const nextValues = buildDraftValues(todo);
    draft.initial = nextValues;
    if (!draft.dirty) {
      draft.values = nextValues;
    }
  }

  function setError(message) {
    state.error = message;
    notify();
  }

  async function fetchTodos() {
    if (state.loading) {
      return;
    }
    state.loading = true;
    state.error = null;
    notify();
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
      notify();
    }
  }

  async function ensureLoaded() {
    if (state.initialized || state.loading) {
      return;
    }
    await fetchTodos();
  }

  function setComposerValue(value) {
    state.composer.value = value;
    if (state.composer.error) {
      state.composer.error = null;
      state.composer.shouldFocus = true;
      notify();
    }
  }

  async function createTodoFromComposer() {
    const rawValue = state.composer.value.trim();
    if (!rawValue) {
      return;
    }
    if (state.composer.saving) {
      return;
    }
    state.composer.saving = true;
    state.composer.error = null;
    notify();
    try {
      const response = await fetch("/api/todos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: rawValue,
        }),
      });
      if (!response.ok) {
        throw new Error(await getErrorMessage(response));
      }
      const payload = await response.json().catch(() => ({}));
      const created = payload?.todo;
      if (created) {
        setTodos([...state.items, created]);
      }
      state.composer.value = "";
      state.composer.shouldFocus = true;
    } catch (error) {
      state.composer.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.composer.saving = false;
      notify();
    }
  }

  async function updateTodo(id, input) {
    state.error = null;
    notify();
    const response = await fetch(`/api/todos/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      state.error = await getErrorMessage(response);
      notify();
      throw new Error(state.error);
    }
    const payload = await response.json().catch(() => ({}));
    const updated = payload?.todo;
    if (updated) {
      const mapped = state.items.map((existing) => (existing.id === updated.id ? updated : existing));
      setTodos(mapped);
    } else {
      notify();
    }
    return updated;
  }

  async function deleteTodo(id) {
    if (state.deletingIds.has(id)) {
      return;
    }
    state.deletingIds.add(id);
    notify();
    try {
      const response = await fetch(`/api/todos/${id}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(await getErrorMessage(response));
      }
      const filtered = state.items.filter((todo) => todo.id !== id);
      setTodos(filtered);
      state.drafts.delete(id);
      if (state.expandedId === id) {
        state.expandedId = null;
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      state.deletingIds.delete(id);
      notify();
    }
  }

  async function toggleStar(todo) {
    const targetId = todo?.id;
    if (!targetId || state.savingIds.has(targetId)) {
      return;
    }
    state.savingIds.add(targetId);
    notify();
    try {
      await updateTodo(targetId, { starred: !todo.starred });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      state.savingIds.delete(targetId);
      notify();
    }
  }

  async function setPriority(todo, priority) {
    const targetId = todo?.id;
    if (!targetId || state.savingIds.has(targetId)) {
      return;
    }
    state.savingIds.add(targetId);
    notify();
    try {
      await updateTodo(targetId, { priority });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      state.savingIds.delete(targetId);
      notify();
    }
  }

  function openTodo(id) {
    if (!id) {
      return;
    }
    if (state.expandedId === id) {
      return;
    }
    state.expandedId = id;
    const todo = state.items.find((item) => item.id === id);
    if (todo) {
      state.drafts.set(id, {
        values: buildDraftValues(todo),
        initial: buildDraftValues(todo),
        dirty: false,
        saving: false,
        error: null,
      });
    }
    notify();
  }

  function closeTodo(id) {
    if (state.expandedId !== id) {
      return;
    }
    state.expandedId = null;
    notify();
  }

  function getDraft(id) {
    return state.drafts.get(id) ?? null;
  }

  function updateDraft(id, updates) {
    const draft = state.drafts.get(id);
    if (!draft) {
      return;
    }
    const nextValues = { ...draft.values, ...updates };
    draft.values = nextValues;
    draft.dirty = hasDraftChanged(draft.initial, nextValues);
    notify();
  }

  function resetDraft(id) {
    const draft = state.drafts.get(id);
    if (!draft) {
      return;
    }
    draft.values = draft.initial;
    draft.dirty = false;
    draft.error = null;
    notify();
  }

  async function saveDraft(id) {
    const draft = state.drafts.get(id);
    if (!draft || draft.saving) {
      return;
    }
    const todo = state.items.find((item) => item.id === id);
    if (!todo) {
      return;
    }
    const diff = collectDraftDiff(draft.initial, draft.values);
    if (!diff) {
      draft.dirty = false;
      notify();
      return;
    }
    draft.saving = true;
    draft.error = null;
    notify();
    try {
      if (diff.dueDate && typeof diff.dueDate === "string") {
        diff.dueDate = parseDateInputValue(diff.dueDate);
      }
      await updateTodo(id, diff);
      draft.initial = buildDraftValues(state.items.find((item) => item.id === id) ?? todo);
      draft.values = draft.initial;
      draft.dirty = false;
    } catch (error) {
      draft.error = error instanceof Error ? error.message : String(error);
    } finally {
      draft.saving = false;
      notify();
    }
  }

  function collectDraftDiff(initial, current) {
    const diff = {};
    let changed = false;
    if (initial.title !== current.title) {
      diff.title = current.title;
      changed = true;
    }
    if ((initial.description ?? "") !== (current.description ?? "")) {
      diff.description = current.description || null;
      changed = true;
    }
    if ((initial.dueDate ?? null) !== (current.dueDate ?? null)) {
      diff.dueDate = current.dueDate || null;
      changed = true;
    }
    if ((initial.appId ?? "") !== (current.appId ?? "")) {
      diff.appId = current.appId ? current.appId : null;
      changed = true;
    }
    if ((initial.priority ?? 0) !== (current.priority ?? 0)) {
      diff.priority = Number.parseInt(String(current.priority), 10) || 0;
      changed = true;
    }
    if (Boolean(initial.starred) !== Boolean(current.starred)) {
      diff.starred = Boolean(current.starred);
      changed = true;
    }
    return changed ? diff : null;
  }

  function hasDraftChanged(initial, current) {
    return Boolean(collectDraftDiff(initial, current));
  }

  function getHighlightedTodos() {
    return state.items.filter((todo) => todo.starred || (Number.isInteger(todo.priority) && todo.priority >= 3)).slice(0, 5);
  }

  function refresh() {
    return fetchTodos();
  }

  function reset() {
    state.items = [];
    state.loading = false;
    state.error = null;
    state.initialized = false;
    state.lastLoadedAt = null;
    state.expandedId = null;
    state.drafts.clear();
    state.savingIds.clear();
    state.deletingIds.clear();
    state.composer.value = "";
    state.composer.saving = false;
    state.composer.error = null;
    state.composer.shouldFocus = false;
    notify();
  }

  function consumeComposerFocus() {
    if (!state.composer.shouldFocus) {
      return false;
    }
    state.composer.shouldFocus = false;
    return true;
  }

  return {
    state,
    ensureLoaded,
    refresh,
    createTodoFromComposer,
    setComposerValue,
    toggleStar,
    setPriority,
    deleteTodo,
    openTodo,
    closeTodo,
    getDraft,
    updateDraft,
    resetDraft,
    saveDraft,
    getAppLabel,
    getAppOptions,
    getHighlightedTodos,
    consumeComposerFocus,
    reset,
  };
}

export { createTodoState };
