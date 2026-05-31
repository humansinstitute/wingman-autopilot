import {
  getActivePipelineRuns,
  getPipelineRunDisplayName,
  showRunningPipelinesModal,
} from "../pipelines/running-pipelines-modal.js";
import { formatRunMeta, statusLabel } from "../pipelines/view-utils.js";

function getPipelineDefinitionLabel(run) {
  const value = run?.definitionSlug ?? run?.definitionId ?? "";
  return String(value || "pipeline");
}

async function fetchPipelineRunSummaries() {
  const { fetchPipelineRuns } = await import("../pipelines/api.js");
  return fetchPipelineRuns();
}

export function getHomeRunningPipelineRows(runs) {
  return getActivePipelineRuns(runs)
    .filter((run) => run?.id)
    .map((run) => ({
      id: String(run.id),
      name: getPipelineRunDisplayName(run),
      status: String(run.status ?? ""),
      statusLabel: statusLabel(run.status),
      definitionLabel: getPipelineDefinitionLabel(run),
      meta: formatRunMeta(run),
    }));
}

export function createRunningPipelinesSection({ showToast } = {}) {
  const state = {
    rows: [],
    loading: false,
    initialized: false,
    error: null,
  };

  let refreshTimer = null;

  const card = document.createElement("section");
  card.className = "wm-card wm-home-running-pipelines";
  card.dataset.testid = "home-running-pipelines";
  card.setAttribute("aria-labelledby", "home-running-pipelines-title");

  const header = document.createElement("div");
  header.className = "wm-home-section-header wm-home-running-pipelines__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "wm-home-running-pipelines__title";

  const title = document.createElement("h2");
  title.id = "home-running-pipelines-title";
  title.textContent = "Running Pipelines";

  const badge = document.createElement("span");
  badge.className = "wm-home-running-pipelines__badge";
  badge.textContent = "0";
  badge.setAttribute("aria-label", "0 running pipelines");

  titleWrap.append(title, badge);

  const actions = document.createElement("div");
  actions.className = "wm-home-section-actions";

  const openListButton = document.createElement("button");
  openListButton.type = "button";
  openListButton.className = "wm-button secondary";
  openListButton.textContent = "Details";
  openListButton.dataset.testid = "home-running-pipelines-details";
  openListButton.setAttribute("aria-label", "Open running pipelines details");
  openListButton.addEventListener("click", () => {
    showRunningPipelinesModal({ showToast });
  });

  const pipelinesLink = document.createElement("a");
  pipelinesLink.className = "wm-button secondary";
  pipelinesLink.href = "/pipelines/runs";
  pipelinesLink.textContent = "Open Pipelines";
  pipelinesLink.dataset.testid = "home-running-pipelines-open";
  pipelinesLink.setAttribute("aria-label", "Open pipelines runs");

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary";
  refreshButton.textContent = "Refresh";
  refreshButton.dataset.testid = "home-running-pipelines-refresh";
  refreshButton.setAttribute("aria-label", "Refresh running pipelines");
  refreshButton.addEventListener("click", () => {
    void loadRuns({ showErrors: true });
  });

  actions.append(openListButton, pipelinesLink, refreshButton);
  header.append(titleWrap, actions);

  const content = document.createElement("div");
  content.className = "wm-home-running-pipelines__content";
  content.setAttribute("aria-live", "polite");

  card.append(header, content);

  function scheduleRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!card.isConnected) return;
      void loadRuns({ silent: true });
    }, 15000);
  }

  function render() {
    badge.textContent = String(state.rows.length);
    badge.setAttribute(
      "aria-label",
      `${state.rows.length} running pipeline${state.rows.length === 1 ? "" : "s"}`,
    );
    refreshButton.disabled = state.loading;
    refreshButton.textContent = state.loading ? "Refreshing..." : "Refresh";

    content.innerHTML = "";

    if (state.loading && !state.initialized) {
      content.append(createStatus("Loading pipelines..."));
      return;
    }

    if (state.error) {
      content.append(createStatus(state.error, "error"));
      return;
    }

    if (state.rows.length === 0) {
      content.append(createStatus("No pipeline runs are currently active."));
      return;
    }

    const list = document.createElement("div");
    list.className = "wm-home-running-pipelines__list";
    list.dataset.testid = "home-running-pipelines-list";

    state.rows.forEach((row) => {
      list.append(createRunItem(row));
    });

    content.append(list);
  }

  function createStatus(message, type = "") {
    const status = document.createElement("p");
    status.className = "wm-home-running-pipelines__status";
    if (type) {
      status.dataset.state = type;
      status.setAttribute("role", "alert");
    }
    status.textContent = message;
    return status;
  }

  function createRunItem(row) {
    const item = document.createElement("article");
    item.className = "wm-home-running-pipelines__item";
    item.dataset.testid = "home-running-pipeline-row";

    const link = document.createElement("a");
    link.className = "wm-home-running-pipelines__main";
    link.href = `/pipelines/runs/${encodeURIComponent(row.id)}`;
    link.setAttribute("aria-label", `Open pipeline run ${row.name}`);

    const name = document.createElement("strong");
    name.textContent = row.name;

    const meta = document.createElement("small");
    meta.textContent = `${row.definitionLabel} - ${row.meta}`;

    link.append(name, meta);

    const status = document.createElement("span");
    status.className = "wm-pipeline-status-chip";
    status.dataset.status = row.status;
    status.textContent = row.statusLabel;

    const code = document.createElement("code");
    code.textContent = row.id.slice(0, 8);

    item.append(link, status, code);
    return item;
  }

  async function loadRuns({ silent = false, showErrors = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    if (!silent) render();
    try {
      const payload = await fetchPipelineRunSummaries();
      state.rows = getHomeRunningPipelineRows(payload?.runs ?? []);
      state.initialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load running pipelines.";
      state.error = message;
      if (showErrors) {
        showToast?.(message, { type: "error" });
      }
    } finally {
      state.loading = false;
      render();
      scheduleRefresh();
    }
  }

  render();
  void loadRuns();

  return {
    element: card,
    refresh: loadRuns,
  };
}
