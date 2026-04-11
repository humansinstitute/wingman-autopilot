import { updateSessionMetadataApi } from "../services/sessions.js";
import { fetchNightWatchReports } from "../nightwatch/api.js";
import { createStatusBadge, formatTimestamp } from "../nightwatch/helpers.js";
import {
  ensureNightWatchSessionToggleLoaded,
  toggleNightWatchForSession,
} from "../nightwatch/session-toggle.js";

const MOBILE_BREAKPOINT = 768;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getLiveDrawerMode(viewportWidth = 1024) {
  return Number(viewportWidth) <= MOBILE_BREAKPOINT ? "mobile" : "desktop";
}

export function isLiveDrawerVisible(drawerState = {}, viewportWidth = 1024) {
  const mode = getLiveDrawerMode(viewportWidth);
  if (mode === "mobile") {
    return Boolean(drawerState.open);
  }
  if (drawerState.userToggled) {
    return Boolean(drawerState.open);
  }
  return true;
}

export function getSessionDrawerRelatedRecords(session) {
  const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const taskIds = Array.isArray(metadata.taskIds)
    ? metadata.taskIds.map((value) => trimText(value)).filter(Boolean)
    : [];

  return {
    project: trimText(metadata.project),
    bindingType: trimText(metadata.bindingType),
    bindingId: trimText(metadata.bindingId),
    flowId: trimText(metadata.flowId),
    flowRunId: trimText(metadata.flowRunId),
    taskIds,
  };
}

export function filterNightWatchReportsForSession(reports = [], sessionId = "") {
  const normalizedSessionId = trimText(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return (Array.isArray(reports) ? reports : [])
    .filter((report) => {
      const reportSessionId =
        trimText(report?.sessionId) ||
        trimText(report?.session_id) ||
        trimText(report?.session?.id);
      return reportSessionId === normalizedSessionId;
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left?.createdAt || left?.created_at || 0);
      const rightTime = Date.parse(right?.createdAt || right?.created_at || 0);
      return rightTime - leftTime;
    });
}

export function syncLiveDrawerDrafts(drawerState, session) {
  const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const sessionId = trimText(session?.id);
  if (!sessionId) {
    return;
  }
  if (!drawerState.goalDrafts.has(sessionId)) {
    drawerState.goalDrafts.set(sessionId, trimText(metadata.goal));
  }
  if (!drawerState.nextActionPayloadDrafts.has(sessionId)) {
    drawerState.nextActionPayloadDrafts.set(sessionId, trimText(metadata.nextActionPayload));
  }
}

export async function ensureNightWatchReportsLoaded(state, onUpdated) {
  if (!state?.nightwatch) {
    return [];
  }
  if (state.nightwatch.reportsLoading) {
    return state.nightwatch.reports;
  }
  if (state.nightwatch.reportsInitialized) {
    return state.nightwatch.reports;
  }

  state.nightwatch.reportsLoading = true;
  if (state.liveDrawer) {
    state.liveDrawer.reportsError = null;
  }
  onUpdated?.();

  try {
    const data = await fetchNightWatchReports();
    state.nightwatch.reports = data?.reports || [];
    state.nightwatch.reportsInitialized = true;
    return state.nightwatch.reports;
  } catch (error) {
    if (state.liveDrawer) {
      state.liveDrawer.reportsError = error instanceof Error ? error.message : "Failed to load reports";
    }
    return [];
  } finally {
    state.nightwatch.reportsLoading = false;
    onUpdated?.();
  }
}

async function saveSessionMetadata({
  session,
  state,
  showToast,
  onUpdated,
} = {}) {
  const sessionId = trimText(session?.id);
  if (!sessionId) {
    return null;
  }

  const goal = trimText(state.liveDrawer.goalDrafts.get(sessionId));
  const nextActionPayload = trimText(state.liveDrawer.nextActionPayloadDrafts.get(sessionId));
  state.liveDrawer.saving = true;
  onUpdated?.();

  try {
    const metadataResult = await updateSessionMetadataApi(sessionId, {
      goal,
      nextActionPayload,
    });
    const normalizedMetadata =
      metadataResult && typeof metadataResult === "object" && metadataResult.metadata
        ? metadataResult.metadata
        : {};
    session.metadata = normalizedMetadata;
    state.liveDrawer.goalDrafts.set(sessionId, trimText(normalizedMetadata.goal));
    state.liveDrawer.nextActionPayloadDrafts.set(
      sessionId,
      trimText(normalizedMetadata.nextActionPayload),
    );
    showToast?.("Session metadata updated", { type: "success" });
    return normalizedMetadata;
  } catch (error) {
    showToast?.(`Failed to update session metadata: ${error.message}`, { type: "error" });
    throw error;
  } finally {
    state.liveDrawer.saving = false;
    onUpdated?.();
  }
}

function createField({ label, value, rows = 3, testId, onInput }) {
  const field = document.createElement("label");
  field.className = "wm-live-drawer__field";

  const labelEl = document.createElement("span");
  labelEl.className = "wm-live-drawer__field-label";
  labelEl.textContent = label;

  const input = document.createElement("textarea");
  input.className = "wm-live-drawer__textarea";
  input.rows = rows;
  input.value = value;
  input.spellcheck = false;
  if (testId) {
    input.dataset.testid = testId;
  }
  input.addEventListener("input", (event) => {
    onInput?.(event.currentTarget.value);
  });

  field.append(labelEl, input);
  return field;
}

function createRelatedRecord(label, value) {
  const item = document.createElement("div");
  item.className = "wm-live-drawer__record";

  const labelEl = document.createElement("span");
  labelEl.className = "wm-live-drawer__record-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("code");
  valueEl.className = "wm-live-drawer__record-value";
  valueEl.textContent = value;

  item.append(labelEl, valueEl);
  return item;
}

function createReportRow(report, onOpen) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "wm-live-drawer__report-row";
  row.addEventListener("click", () => onOpen(report.id));

  const summary = document.createElement("div");
  summary.className = "wm-live-drawer__report-summary";

  const top = document.createElement("div");
  top.className = "wm-live-drawer__report-top";
  top.append(createStatusBadge(report.status));

  const time = document.createElement("span");
  time.className = "wm-live-drawer__report-time";
  time.textContent = formatTimestamp(report.createdAt || report.created_at);
  top.append(time);

  const body = document.createElement("p");
  body.className = "wm-live-drawer__report-text";
  body.textContent = trimText(report.summary) || "No summary";

  summary.append(top, body);
  row.append(summary);
  return row;
}

function createReportModal(report, onClose) {
  const overlay = document.createElement("div");
  overlay.className = "wm-live-drawer-modal";
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      onClose();
    }
  });

  const dialog = document.createElement("section");
  dialog.className = "wm-live-drawer-modal__dialog";

  const header = document.createElement("header");
  header.className = "wm-live-drawer-modal__header";

  const title = document.createElement("h2");
  title.textContent = report?.sessionName || "Night Watch report";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "wm-live-drawer-modal__close";
  close.textContent = "Close";
  close.addEventListener("click", onClose);

  header.append(title, close);

  const meta = document.createElement("div");
  meta.className = "wm-live-drawer-modal__meta";
  meta.append(createStatusBadge(report?.status || "raw"));

  const created = document.createElement("span");
  created.textContent = formatTimestamp(report?.createdAt || report?.created_at);
  meta.append(created);

  if (report?.cycleCount != null) {
    const cycle = document.createElement("span");
    cycle.textContent = `Cycle ${report.cycleCount}`;
    meta.append(cycle);
  }

  const body = document.createElement("div");
  body.className = "wm-live-drawer-modal__body";

  const summary = document.createElement("section");
  summary.className = "wm-live-drawer-modal__section";
  summary.innerHTML = "<h3>Summary</h3>";
  const summaryText = document.createElement("p");
  summaryText.textContent = trimText(report?.summary) || "No summary";
  summary.append(summaryText);

  body.append(summary);

  if (trimText(report?.reasoning)) {
    const reasoning = document.createElement("section");
    reasoning.className = "wm-live-drawer-modal__section";
    reasoning.innerHTML = "<h3>Reasoning</h3>";
    const reasoningText = document.createElement("pre");
    reasoningText.textContent = report.reasoning;
    reasoning.append(reasoningText);
    body.append(reasoning);
  }

  if (trimText(report?.inputRaw)) {
    const input = document.createElement("section");
    input.className = "wm-live-drawer-modal__section";
    input.innerHTML = "<h3>Input</h3>";
    const inputText = document.createElement("pre");
    inputText.textContent = report.inputRaw;
    input.append(inputText);
    body.append(input);
  }

  dialog.append(header, meta, body);
  overlay.append(dialog);
  return overlay;
}

export function createLiveSessionDrawer({
  session,
  state,
  showToast,
  render,
  viewportWidth,
} = {}) {
  const drawerState = state.liveDrawer;
  const mode = getLiveDrawerMode(viewportWidth);
  syncLiveDrawerDrafts(drawerState, session);

  const visible = isLiveDrawerVisible(drawerState, viewportWidth);
  if (visible) {
    void ensureNightWatchReportsLoaded(state, render);
    void ensureNightWatchSessionToggleLoaded({
      sessionId: session?.id,
      state,
      onResolved: () => render?.(),
    });
  }

  const sessionId = trimText(session?.id);
  const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const toggleState = state.nightwatch.sessionToggles.get(sessionId) || { enabled: false };
  const reports = filterNightWatchReportsForSession(state.nightwatch.reports, sessionId);
  const selectedReportId = trimText(drawerState.selectedReportId);
  const selectedReport = reports.find((report) => report.id === selectedReportId) || null;

  const aside = document.createElement("aside");
  aside.className = `wm-live-drawer wm-live-drawer--${mode}`;
  aside.dataset.testid = "live-session-drawer";

  const header = document.createElement("header");
  header.className = "wm-live-drawer__header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = "Session Drawer";
  const subtitle = document.createElement("p");
  subtitle.textContent = session?.name || "Current live session";
  titleWrap.append(title, subtitle);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "wm-live-drawer__close";
  close.textContent = mode === "mobile" ? "Close" : "Hide";
  close.addEventListener("click", () => {
    drawerState.userToggled = true;
    drawerState.open = false;
    render?.();
  });

  header.append(titleWrap, close);
  aside.append(header);

  const metadataSection = document.createElement("section");
  metadataSection.className = "wm-live-drawer__section";
  metadataSection.innerHTML = "<h3>Session metadata</h3>";

  metadataSection.append(
    createField({
      label: "Goal",
      value: drawerState.goalDrafts.get(sessionId) || "",
      rows: 4,
      testId: "live-drawer-goal-input",
      onInput: (value) => drawerState.goalDrafts.set(sessionId, value),
    }),
  );

  metadataSection.append(
    createField({
      label: "Current next action",
      value: drawerState.nextActionPayloadDrafts.get(sessionId) || "",
      rows: 3,
      testId: "live-drawer-next-action-input",
      onInput: (value) => drawerState.nextActionPayloadDrafts.set(sessionId, value),
    }),
  );

  const metadataActions = document.createElement("div");
  metadataActions.className = "wm-live-drawer__actions";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "wm-button";
  saveButton.textContent = drawerState.saving ? "Saving..." : "Save metadata";
  saveButton.disabled = drawerState.saving;
  saveButton.addEventListener("click", async () => {
    try {
      await saveSessionMetadata({ session, state, showToast, onUpdated: render });
    } catch {
      // Error toast already shown.
    }
  });

  metadataActions.append(saveButton);
  metadataSection.append(metadataActions);
  aside.append(metadataSection);

  const nightWatchSection = document.createElement("section");
  nightWatchSection.className = "wm-live-drawer__section";
  nightWatchSection.innerHTML = "<h3>Night Watch</h3>";

  const statusRow = document.createElement("div");
  statusRow.className = "wm-live-drawer__nightwatch-status";
  const status = document.createElement("span");
  status.className = "wm-live-drawer__pill";
  status.textContent = toggleState.enabled ? "Enabled" : "Disabled";
  statusRow.append(status);

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "wm-button secondary";
  toggleButton.textContent = toggleState.enabled ? "Disable Night Watch" : "Enable Night Watch";
  toggleButton.addEventListener("click", async () => {
    try {
      await toggleNightWatchForSession({
        sessionId,
        sessionName: session?.name,
        sessionMetadata: metadata,
        state,
        showToast,
        onChanged: () => {
          state.nightwatch.reportsInitialized = false;
          render?.();
        },
      });
      render?.();
    } catch (error) {
      showToast?.(`Night Watch toggle failed: ${error.message}`, { type: "error" });
    }
  });
  statusRow.append(toggleButton);
  nightWatchSection.append(statusRow);
  aside.append(nightWatchSection);

  const relatedSection = document.createElement("section");
  relatedSection.className = "wm-live-drawer__section";
  relatedSection.innerHTML = "<h3>Related records</h3>";
  const related = getSessionDrawerRelatedRecords(session);
  const relatedList = document.createElement("div");
  relatedList.className = "wm-live-drawer__records";

  if (related.project) {
    relatedList.append(createRelatedRecord("Project", related.project));
  }
  if (related.bindingType && related.bindingId) {
    relatedList.append(createRelatedRecord(`Binding (${related.bindingType})`, related.bindingId));
  }
  if (related.flowId) {
    relatedList.append(createRelatedRecord("Flow", related.flowId));
  }
  if (related.flowRunId) {
    relatedList.append(createRelatedRecord("Flow run", related.flowRunId));
  }
  related.taskIds.forEach((taskId, index) => {
    relatedList.append(createRelatedRecord(`Task ${index + 1}`, taskId));
  });
  if (!relatedList.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "wm-live-drawer__empty";
    empty.textContent = "No related records on this session yet.";
    relatedList.append(empty);
  }
  relatedSection.append(relatedList);
  aside.append(relatedSection);

  const historySection = document.createElement("section");
  historySection.className = "wm-live-drawer__section";
  historySection.innerHTML = "<h3>Night Watch history</h3>";

  if (state.nightwatch.reportsLoading) {
    const loading = document.createElement("p");
    loading.className = "wm-live-drawer__empty";
    loading.textContent = "Loading Night Watch history...";
    historySection.append(loading);
  } else if (drawerState.reportsError) {
    const unavailable = document.createElement("p");
    unavailable.className = "wm-live-drawer__empty";
    unavailable.textContent = "Night Watch history is currently unavailable.";
    historySection.append(unavailable);
  } else if (reports.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-live-drawer__empty";
    empty.textContent = "No Night Watch reports for this session yet.";
    historySection.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "wm-live-drawer__report-list";
    reports.slice(0, 5).forEach((report) => {
      list.append(createReportRow(report, (reportId) => {
        drawerState.selectedReportId = reportId;
        drawerState.reportModalOpen = true;
        render?.();
      }));
    });
    historySection.append(list);
  }
  aside.append(historySection);

  const result = {
    mode,
    visible,
    aside,
    backdrop: null,
    modal: null,
  };

  if (mode === "mobile" && visible) {
    const backdrop = document.createElement("div");
    backdrop.className = "wm-live-drawer-backdrop";
    backdrop.addEventListener("click", () => {
      drawerState.userToggled = true;
      drawerState.open = false;
      render?.();
    });
    result.backdrop = backdrop;
  }

  if (drawerState.reportModalOpen && selectedReport) {
    result.modal = createReportModal(selectedReport, () => {
      drawerState.reportModalOpen = false;
      drawerState.selectedReportId = "";
      render?.();
    });
  }

  return result;
}
