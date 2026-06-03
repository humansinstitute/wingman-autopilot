import {
  escapeHtml,
  escapeAttribute,
  formatDateTime,
  formatDuration,
  formatRunMeta,
  renderJsonBlock,
  statusLabel,
} from "./view-utils.js";

const ACTIVE_PIPELINE_RUN_STATUSES = new Set(["queued", "running"]);
const RECENT_PIPELINE_RUN_PAGE_SIZE = 5;

export function isActivePipelineRun(run) {
  return ACTIVE_PIPELINE_RUN_STATUSES.has(String(run?.status ?? ""));
}

export function getActivePipelineRuns(runs) {
  return Array.isArray(runs) ? runs.filter((run) => isActivePipelineRun(run)) : [];
}

export function getRecentPipelineRunPage(runs, page = 0, pageSize = RECENT_PIPELINE_RUN_PAGE_SIZE) {
  const source = Array.isArray(runs) ? runs : [];
  const safePageSize = Math.max(1, Number(pageSize) || RECENT_PIPELINE_RUN_PAGE_SIZE);
  const safePage = Math.max(0, Number(page) || 0);
  const start = safePage * safePageSize;
  return source.slice(start, start + safePageSize);
}

export function getRecentPipelineRunPageCount(runs, pageSize = RECENT_PIPELINE_RUN_PAGE_SIZE) {
  const total = Array.isArray(runs) ? runs.length : 0;
  const safePageSize = Math.max(1, Number(pageSize) || RECENT_PIPELINE_RUN_PAGE_SIZE);
  return Math.max(1, Math.ceil(total / safePageSize));
}

export function getPipelineRunDisplayName(run) {
  const name = typeof run?.name === "string" ? run.name.trim() : "";
  if (name.length > 0) return name;
  return String(run?.id ?? "Pipeline run");
}

export function getPipelineStepSessionId(step) {
  const sessionId = typeof step?.wingmanSessionId === "string" ? step.wingmanSessionId.trim() : "";
  return sessionId.length > 0 ? sessionId : null;
}

export function renderRunningPipelineAgentSessionLink(step) {
  const sessionId = getPipelineStepSessionId(step);
  if (!sessionId) return "";
  return `
    <a
      class="wm-pipeline-agent-session-link"
      href="/live/${encodeURIComponent(sessionId)}"
      aria-label="Open agent session ${escapeAttribute(sessionId)}"
      title="Open agent session ${escapeAttribute(sessionId)}"
      data-testid="running-pipeline-agent-session-link"
    >
      Open session <code>${escapeHtml(sessionId.slice(0, 8))}</code>
    </a>
  `;
}

async function fetchPipelineRunDetail(runId, options) {
  const { fetchPipelineRun } = await import("./api.js");
  return fetchPipelineRun(runId, options);
}

async function fetchPipelineRunSummaries() {
  const { fetchPipelineRuns } = await import("./api.js");
  return fetchPipelineRuns();
}

async function startPipelineRun(definitionId, input) {
  const { runPipelineDefinition } = await import("./api.js");
  return runPipelineDefinition(definitionId, input);
}

export function showRunningPipelinesModal({ showToast } = {}) {
  const existing = document.getElementById("running-pipelines-modal");
  if (typeof HTMLDialogElement === "function" && existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
    existing.remove();
  } else {
    existing?.remove();
  }

  const dialog = document.createElement("dialog");
  dialog.id = "running-pipelines-modal";
  dialog.className = "wm-running-pipelines-modal";
  dialog.dataset.testid = "running-pipelines-modal";
  dialog.setAttribute("aria-labelledby", "running-pipelines-modal-title");

  const shell = document.createElement("div");
  shell.className = "wm-running-pipelines-modal__shell";

  const header = document.createElement("header");
  header.className = "wm-running-pipelines-modal__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "wm-running-pipelines-modal__title";
  const title = document.createElement("h2");
  title.id = "running-pipelines-modal-title";
  title.textContent = "Running Pipelines";
  const subtitle = document.createElement("p");
  subtitle.setAttribute("aria-live", "polite");
  titleWrap.append(title, subtitle);

  const headerActions = document.createElement("div");
  headerActions.className = "wm-running-pipelines-modal__header-actions";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary wm-button--small";
  refreshButton.textContent = "Refresh";
  refreshButton.dataset.testid = "running-pipelines-modal-refresh";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close running pipelines");
  closeButton.dataset.testid = "running-pipelines-modal-close";
  closeButton.addEventListener("click", () => dialog.close());

  headerActions.append(refreshButton, closeButton);
  header.append(titleWrap, headerActions);

  const body = document.createElement("div");
  body.className = "wm-running-pipelines-modal__body";

  const status = document.createElement("p");
  status.className = "wm-running-pipelines-modal__status";
  status.setAttribute("aria-live", "polite");

  shell.append(header, body, status);
  dialog.append(shell);

  let runs = [];
  let selectedRunId = null;
  let selectedRunDetail = null;
  let loading = false;
  let detailLoading = false;
  let showRecentRuns = false;
  let recentRunPage = 0;

  function setStatus(message, type = "") {
    status.textContent = message ?? "";
    status.dataset.state = type;
  }

  async function refreshModalRuns() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
    setStatus("Refreshing pipelines...");
    renderContent();
    try {
      const payload = await fetchPipelineRunSummaries();
      runs = Array.isArray(payload?.runs) ? payload.runs : [];
      const recentPageCount = getRecentPipelineRunPageCount(runs);
      if (recentRunPage >= recentPageCount) {
        recentRunPage = Math.max(0, recentPageCount - 1);
      }
      if (selectedRunId) {
        const stillVisible = runs.some((run) => run.id === selectedRunId);
        if (!stillVisible) {
          selectedRunId = null;
          selectedRunDetail = null;
        } else {
          await loadSelectedRun({ forceFresh: true, silent: true });
        }
      }
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh pipelines.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
      renderContent();
    }
  }

  async function loadSelectedRun({ forceFresh = false, silent = false } = {}) {
    if (!selectedRunId) return;
    detailLoading = true;
    if (!silent) {
      setStatus("Loading pipeline run...");
      renderContent();
    }
    try {
      selectedRunDetail = await fetchPipelineRunDetail(selectedRunId, {
        includeRunPayload: true,
        includeStepPayload: false,
        forceFresh,
      });
      if (!silent) setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load pipeline run.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      detailLoading = false;
      if (!silent) renderContent();
    }
  }

  async function openRunDetails(runId) {
    selectedRunId = runId;
    selectedRunDetail = null;
    await loadSelectedRun({ forceFresh: isActivePipelineRun(runs.find((run) => run.id === runId)) });
  }

  async function restartRun(run, button) {
    if (!run?.id || button.disabled) return;
    button.disabled = true;
    button.textContent = "Restarting...";
    setStatus(`Restarting ${getPipelineRunDisplayName(run)}...`);
    try {
      const detail = await fetchPipelineRunDetail(run.id, { includeRunPayload: true, forceFresh: true });
      const sourceRun = detail?.run ?? run;
      const definitionId = sourceRun.definitionId ?? sourceRun.definition_id;
      if (!definitionId) {
        throw new Error("Pipeline definition id is unavailable for this run.");
      }
      const input = sourceRun.input && typeof sourceRun.input === "object" && !Array.isArray(sourceRun.input)
        ? sourceRun.input
        : {};
      const payload = await startPipelineRun(definitionId, input);
      const nextRunId = payload?.run?.id;
      showToast?.("Pipeline run restarted", { type: "success" });
      await refreshModalRuns();
      if (nextRunId) {
        selectedRunId = nextRunId;
        selectedRunDetail = payload;
        renderContent();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restart pipeline.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Restart";
      }
    }
  }

  function renderStatusChip(value) {
    const chip = document.createElement("span");
    chip.className = "wm-pipeline-status-chip";
    chip.dataset.status = String(value ?? "");
    chip.textContent = statusLabel(value);
    return chip;
  }

  function renderListView() {
    const activeRuns = getActivePipelineRuns(runs);
    const recentPageCount = getRecentPipelineRunPageCount(runs);
    const recentRuns = getRecentPipelineRunPage(runs, recentRunPage);
    subtitle.textContent = loading
      ? "Refreshing..."
      : showRecentRuns
        ? `${runs.length} recent run${runs.length === 1 ? "" : "s"} - page ${recentRunPage + 1} of ${recentPageCount}`
        : `${activeRuns.length} active run${activeRuns.length === 1 ? "" : "s"}`;

    if (loading && activeRuns.length === 0) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-pipelines-modal__empty";
      loadingEl.textContent = "Loading pipelines...";
      body.append(loadingEl);
      renderRecentRunsToggle(runs.length);
      return;
    }

    if (activeRuns.length === 0 && !showRecentRuns) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "No pipeline runs are currently active.";
      body.append(empty);
    } else if (!showRecentRuns) {
      renderPipelineRunList(activeRuns, { testId: "running-pipelines-list" });
    }

    renderRecentRunsToggle(runs.length);
    renderRecentRunsList(recentRuns, recentPageCount);
  }

  function renderPipelineRunList(listRuns, { testId = "" } = {}) {
    const list = document.createElement("div");
    list.className = "wm-running-pipelines-list";
    if (testId) list.dataset.testid = testId;

    listRuns.forEach((run) => {
      list.append(renderPipelineRunListItem(run));
    });

    body.append(list);
  }

  function renderPipelineRunListItem(run) {
    const item = document.createElement("article");
    item.className = "wm-running-pipelines-list__item";
    item.dataset.runId = String(run.id ?? "");

    const mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "wm-running-pipelines-list__main";
    mainButton.dataset.testid = "running-pipeline-details";
    mainButton.setAttribute("aria-label", `Show details for ${getPipelineRunDisplayName(run)}`);
    mainButton.addEventListener("click", () => void openRunDetails(run.id));

    const name = document.createElement("span");
    name.className = "wm-running-pipelines-list__name";
    name.textContent = getPipelineRunDisplayName(run);

    const meta = document.createElement("span");
    meta.className = "wm-running-pipelines-list__meta";
    meta.textContent = `${run.definitionSlug ?? run.definitionId ?? "pipeline"} - ${formatRunMeta(run)}`;

    mainButton.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "wm-running-pipelines-list__actions";
    actions.append(renderStatusChip(run.status));

    const restartButton = document.createElement("button");
    restartButton.type = "button";
    restartButton.className = "wm-button secondary wm-button--small";
    restartButton.textContent = "Restart";
    restartButton.dataset.testid = "running-pipeline-restart";
    restartButton.setAttribute("aria-label", `Restart ${getPipelineRunDisplayName(run)}`);
    restartButton.addEventListener("click", () => void restartRun(run, restartButton));
    actions.append(restartButton);

    item.append(mainButton, actions);
    return item;
  }

  function renderRecentRunsToggle(totalRuns) {
    if (totalRuns === 0) return;
    const footer = document.createElement("div");
    footer.className = "wm-running-pipelines-modal__list-footer";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-button";
    button.textContent = showRecentRuns ? "Hide Recent" : "Show Recent";
    button.dataset.testid = "running-pipelines-show-recent-toggle";
    button.setAttribute("aria-label", showRecentRuns ? "Hide recent pipeline runs" : "Show recent pipeline runs");
    button.setAttribute("aria-expanded", showRecentRuns ? "true" : "false");
    button.addEventListener("click", () => {
      showRecentRuns = !showRecentRuns;
      if (!showRecentRuns) recentRunPage = 0;
      renderContent();
    });

    footer.append(button);
    body.append(footer);
  }

  function renderRecentRunsList(recentRuns, pageCount) {
    if (!showRecentRuns) return;

    const section = document.createElement("section");
    section.className = "wm-running-pipelines-modal__recent";
    section.setAttribute("aria-labelledby", "running-pipelines-recent-title");
    section.dataset.testid = "running-pipelines-recent";

    const header = document.createElement("div");
    header.className = "wm-running-pipelines-modal__recent-header";

    const heading = document.createElement("h3");
    heading.id = "running-pipelines-recent-title";
    heading.textContent = "Recent Runs";

    const pager = document.createElement("div");
    pager.className = "wm-running-pipelines-modal__pager";
    pager.setAttribute("aria-label", "Recent pipeline pages");

    const previousButton = document.createElement("button");
    previousButton.type = "button";
    previousButton.className = "wm-button secondary wm-button--small";
    previousButton.textContent = "Previous";
    previousButton.disabled = recentRunPage <= 0;
    previousButton.dataset.testid = "running-pipelines-recent-previous";
    previousButton.setAttribute("aria-label", "Show previous recent pipeline runs");
    previousButton.addEventListener("click", () => {
      recentRunPage = Math.max(0, recentRunPage - 1);
      renderContent();
    });

    const pageLabel = document.createElement("span");
    pageLabel.textContent = `Page ${recentRunPage + 1} of ${pageCount}`;
    pageLabel.setAttribute("aria-live", "polite");

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "wm-button secondary wm-button--small";
    nextButton.textContent = "Next";
    nextButton.disabled = recentRunPage >= pageCount - 1;
    nextButton.dataset.testid = "running-pipelines-recent-next";
    nextButton.setAttribute("aria-label", "Show next recent pipeline runs");
    nextButton.addEventListener("click", () => {
      recentRunPage = Math.min(pageCount - 1, recentRunPage + 1);
      renderContent();
    });

    pager.append(previousButton, pageLabel, nextButton);
    header.append(heading, pager);
    section.append(header);

    if (recentRuns.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "No pipeline runs have been recorded yet.";
      section.append(empty);
      body.append(section);
      return;
    }

    const list = document.createElement("div");
    list.className = "wm-running-pipelines-list";
    list.dataset.testid = "running-pipelines-recent-list";
    recentRuns.forEach((run) => {
      list.append(renderPipelineRunListItem(run));
    });
    section.append(list);
    body.append(section);
  }

  function renderDetailsView() {
    const run = selectedRunDetail?.run ?? runs.find((entry) => entry.id === selectedRunId) ?? null;
    subtitle.textContent = run ? getPipelineRunDisplayName(run) : "Pipeline run";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "wm-button secondary wm-button--small wm-running-pipelines-modal__back";
    backButton.textContent = "Back to pipelines";
    backButton.dataset.testid = "running-pipelines-back";
    backButton.addEventListener("click", () => {
      selectedRunId = null;
      selectedRunDetail = null;
      renderContent();
    });
    body.append(backButton);

    if (detailLoading && !selectedRunDetail) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-pipelines-modal__empty";
      loadingEl.textContent = "Loading run details...";
      body.append(loadingEl);
      return;
    }

    if (!run) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "Pipeline run details are unavailable.";
      body.append(empty);
      return;
    }

    body.append(renderRunDetail(run, selectedRunDetail?.steps ?? []));
  }

  function renderRunDetail(run, steps) {
    const article = document.createElement("article");
    article.className = "wm-running-pipelines-detail";
    article.dataset.testid = "running-pipeline-detail";
    article.innerHTML = `
      <header class="wm-pipeline-detail-header">
        <div>
          <h2>${escapeHtml(getPipelineRunDisplayName(run))}</h2>
          <p><code>${escapeHtml(run.id)}</code></p>
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
      </header>
      <dl class="wm-pipeline-facts">
        <div><dt>Started</dt><dd>${escapeHtml(formatDateTime(run.startedAt ?? run.started_at))}</dd></div>
        <div><dt>Completed</dt><dd>${escapeHtml(formatDateTime(run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(run.startedAt ?? run.started_at, run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Definition</dt><dd>${escapeHtml(run.definitionSlug ?? run.definitionId ?? "--")}</dd></div>
        <div><dt>Steps</dt><dd>${escapeHtml(String(steps.length))}</dd></div>
      </dl>
      <section class="wm-running-pipelines-detail__steps" aria-label="Pipeline steps">
        ${steps.length ? steps.map((step) => renderStepSummary(step)).join("") : `<p class="wm-muted">No steps recorded for this run.</p>`}
      </section>
      <div class="wm-running-pipelines-detail__data">
        ${renderJsonBlock("Input", run.input ?? {})}
        ${renderJsonBlock("Result", run.result ?? run.error ?? {})}
      </div>
    `;
    return article;
  }

  function renderStepSummary(step) {
    const sessionId = getPipelineStepSessionId(step);
    return `
      <div class="wm-running-pipelines-step">
        <span class="wm-pipeline-step-number">${escapeHtml(String(step.stepIndex ?? ""))}</span>
        <span class="wm-pipeline-step-main">
          <strong>${escapeHtml(step.name ?? "Step")}</strong>
          <small>${escapeHtml(step.kind ?? "")}${sessionId ? ` - ${escapeHtml(String(sessionId).slice(0, 8))}` : ""}</small>
        </span>
        <span class="wm-running-pipelines-step__actions">
          ${renderRunningPipelineAgentSessionLink(step)}
          <span class="wm-pipeline-status-chip" data-status="${escapeHtml(step.status)}">${escapeHtml(statusLabel(step.status))}</span>
        </span>
      </div>
    `;
  }

  function renderContent() {
    body.innerHTML = "";
    if (selectedRunId) {
      renderDetailsView();
      return;
    }
    renderListView();
  }

  refreshButton.addEventListener("click", () => void refreshModalRuns());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  renderContent();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (typeof dialog.show === "function") {
    dialog.show();
  } else {
    dialog.setAttribute("open", "open");
  }

  void refreshModalRuns();
}
