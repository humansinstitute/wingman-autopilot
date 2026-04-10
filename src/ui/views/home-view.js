/**
 * Home view renderer — guest landing, running apps table,
 * live agents session list, and archive component.
 *
 * Depends on: state, identity, session/app helpers, navigation (via DI).
 */

import { createArchiveComponent } from "../home/archive.js";
import { createLiveAgentsSection } from "../home/live-agents.js";
import { DEFAULT_LIVE_SESSION_SORT } from "../home/session-table.js";
import { HOME_SESSION_GROUPS } from "../home/session-groups.js";

export function initHomeView(deps) {
  const {
    state,
    sessionsStore,
    appsStore,
    getCurrentRoute,
    setCurrentRoute,
    render,
    // Navigation
    openIdentityLoginDialog,
    navigateToApps,
    navigateToChat,
    openDialog,
    openJobDialog,
    ensureFeatureFlagsLoaded,
    isFeatureEnabledForViewer,
    // Session helpers
    isSessionActive,
    resumeSession,
    stopSession,
    deleteSession,
    promptRenameSession,
    getSessionDisplayName,
    createAgentStatusIndicator,
    buildSessionFilterOptions,
    fetchSessions,
    syncMenuTabs,
    // App helpers
    isAppActionDisabled,
    triggerAppAction,
    // Utilities
    escapeHtml,
    // Constants
    APP_STATUS_LABELS,
    APP_ACTION_LABELS,
    PRIVACY_ROUTE,
    LIVE_ROUTE_PREFIX,
  } = deps;

  let archiveComponent = null;
  let liveSessionSort = { ...DEFAULT_LIVE_SESSION_SORT };
  let liveSessionGroup = HOME_SESSION_GROUPS[0]?.id ?? 'my';
  const sessionActionPending = new Map();

  function getSessionPendingAction(sessionId) {
    if (!sessionId || typeof sessionId !== "string") {
      return null;
    }
    return sessionActionPending.get(sessionId) ?? null;
  }

  function isSessionActionPending(sessionId) {
    return Boolean(getSessionPendingAction(sessionId));
  }

  function rerenderHomeIfVisible() {
    if (getCurrentRoute() === "home") {
      render();
    }
  }

  function setSessionActionPending(sessionId, action) {
    if (!sessionId || typeof sessionId !== "string") {
      return;
    }
    if (!action) {
      sessionActionPending.delete(sessionId);
    } else {
      sessionActionPending.set(sessionId, action);
    }
    rerenderHomeIfVisible();
  }

  async function withPendingSessionAction(sessionId, action, callback) {
    if (isSessionActionPending(sessionId)) {
      return;
    }
    setSessionActionPending(sessionId, action);
    try {
      await callback();
    } finally {
      setSessionActionPending(sessionId, null);
    }
  }
  // ── Main renderer ──────────────────────────────────────────────

  const renderHome = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-home";

    if (!state.identity.authenticated) {
      wrapper.className = "wm-home wm-home-guest-landing";

      const content = document.createElement("div");
      content.className = "wm-home-guest-content";

      const heroText = document.createElement("div");
      heroText.className = "wm-home-guest-hero-text";

      const line1 = document.createElement("div");
      line1.className = "wm-home-guest-hero-line";
      line1.textContent = "YOU";

      const line2 = document.createElement("div");
      line2.className = "wm-home-guest-hero-line";
      line2.textContent = "CAN JUST";

      const line3 = document.createElement("div");
      line3.className = "wm-home-guest-hero-line";
      line3.textContent = "DO THINGS!";

      heroText.append(line1, line2, line3);

      const loginButton = document.createElement("button");
      loginButton.type = "button";
      loginButton.className = "wm-home-guest-login-button";
      loginButton.textContent = "LOG IN";
      loginButton.addEventListener("click", () => {
        openIdentityLoginDialog();
      });

      content.append(heroText, loginButton);

      const footer = document.createElement("footer");
      footer.className = "wm-home-guest-footer";

      const footerText = document.createElement("p");
      footerText.textContent = "Manage your own business - ";

      const footerLink = document.createElement("a");
      footerLink.href = "https://primal.net/pw";
      footerLink.textContent = "pw21";
      footerLink.target = "_blank";
      footerLink.rel = "noopener noreferrer";

      footerText.append(footerLink);

      const footerLinks = document.createElement("div");
      footerLinks.className = "wm-home-guest-footer__links";
      const privacyLink = document.createElement("a");
      privacyLink.href = PRIVACY_ROUTE;
      privacyLink.textContent = "Privacy Policy";
      privacyLink.addEventListener("click", (e) => {
        e.preventDefault();
        setCurrentRoute("privacy");
        window.history.pushState({ route: "privacy" }, "", PRIVACY_ROUTE);
        render();
      });
      footerLinks.append(privacyLink);

      footer.append(footerText, footerLinks);

      wrapper.append(content, footer);
      return wrapper;
    }

    ensureFeatureFlagsLoaded();

    if (!appsStore().initialized && !appsStore().loading) {
      // void ensureAppsLoaded(); // DISABLED
    }

    const appsCard = document.createElement("section");
    appsCard.className = "wm-card wm-home-apps";

    const appsHeader = document.createElement("div");
    appsHeader.className = "wm-home-section-header";

    const appsTitle = document.createElement("h2");
    appsTitle.textContent = "Running Apps";
    const appsHeaderActions = document.createElement("div");
    appsHeaderActions.className = "wm-home-section-actions";

    const newAppButton = document.createElement("button");
    newAppButton.type = "button";
    newAppButton.className = "wm-button secondary";
    newAppButton.textContent = "New App";
    newAppButton.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToApps({ openNewAppDialog: true });
    });

    appsHeaderActions.append(newAppButton);
    appsHeader.append(appsTitle, appsHeaderActions);
    appsCard.append(appsHeader);

    const appsContent = document.createElement("div");
    appsContent.className = "wm-home-apps-content";

    if (appsStore().error) {
      const error = document.createElement("p");
      error.className = "wm-home-apps-status";
      error.textContent = appsStore().error;
      appsContent.append(error);
    } else {
      const runningApps = Array.isArray(appsStore().items)
        ? appsStore().items.filter((app) => app?.status?.status === "running")
        : [];

      if (appsStore().loading && !appsStore().initialized) {
        const loading = document.createElement("p");
        loading.className = "wm-home-apps-status";
        loading.textContent = "Loading apps\u2026";
        appsContent.append(loading);
      } else if (runningApps.length === 0) {
        const empty = document.createElement("p");
        empty.className = "wm-home-apps-status";
        empty.textContent = "No apps are currently running.";
        appsContent.append(empty);
      } else {
        const table = document.createElement("table");
        table.className = "wm-home-apps-table";

        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        ["App", "Status", "Root", "Actions"].forEach((label) => {
          const th = document.createElement("th");
          th.textContent = label;
          headerRow.append(th);
        });
        thead.append(headerRow);
        table.append(thead);

        const tbody = document.createElement("tbody");
        runningApps.forEach((app) => {
          const row = document.createElement("tr");

          const nameCell = document.createElement("td");
          const nameLink = document.createElement("a");
          nameLink.textContent = app.label ?? app.id;
          nameLink.href = "/apps";
          nameLink.style.color = "inherit";
          nameLink.style.textDecoration = "underline";
          nameLink.style.cursor = "pointer";
          nameLink.addEventListener("click", (e) => {
            e.preventDefault();
            navigateToApps({ focusAppId: app.id });
          });
          nameCell.append(nameLink);
          row.append(nameCell);

          const statusCell = document.createElement("td");
          const statusValue = app?.status?.status ?? "unknown";
          statusCell.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
          row.append(statusCell);

          const rootCell = document.createElement("td");
          rootCell.textContent = app.root ?? "\u2014";
          rootCell.title = app.root ?? "";
          row.append(rootCell);

          const actionsCell = document.createElement("td");
          actionsCell.className = "wm-home-apps-actions";

          const addActionButton = (action) => {
            if (!app.availableScripts?.[action]) return;
            if (app.id === "wingman-core" && action === "stop") return;
            const button = document.createElement("button");
            button.type = "button";
            button.className = action === "stop" ? "wm-button secondary" : "wm-button";
            button.textContent = APP_ACTION_LABELS[action] ?? action;
            button.disabled = isAppActionDisabled(app, action);
            button.addEventListener("click", async () => {
              if (button.disabled) return;
              button.disabled = true;
              const success = await triggerAppAction(app.id, action);
              if (!success && button.isConnected) {
                button.disabled = false;
              }
            });
            actionsCell.append(button);
          };

          addActionButton("stop");
          addActionButton("restart");

          if (!actionsCell.hasChildNodes()) {
            actionsCell.textContent = "\u2014";
          }

          row.append(actionsCell);
          tbody.append(row);
        });

        table.append(tbody);
        appsContent.append(table);
      }
    }

    appsCard.append(appsContent);
    wrapper.append(appsCard);
    wrapper.append(
      createLiveAgentsSection({
        state,
        sessionsStore,
        getCurrentRoute,
        render,
        navigateToChat,
        openDialog,
        openJobDialog,
        isFeatureEnabledForViewer,
        isSessionActive,
        resumeSession,
        stopSession,
        deleteSession,
        promptRenameSession,
        getSessionDisplayName,
        createAgentStatusIndicator,
        buildSessionFilterOptions,
        fetchSessions,
        syncMenuTabs,
        escapeHtml,
        getSessionPendingAction,
        isSessionActionPending,
        withPendingSessionAction,
        sessionSort: liveSessionSort,
        onSessionSortChange(nextSort) {
          liveSessionSort = nextSort;
          rerenderHomeIfVisible();
        },
        sessionGroup: liveSessionGroup,
        onSessionGroupChange(nextGroup) {
          liveSessionGroup = nextGroup;
          rerenderHomeIfVisible();
        },
      }),
    );

    archiveComponent = createArchiveComponent({
      onViewSession: (session) => {
        const targetPath = `${LIVE_ROUTE_PREFIX}/${session.id}`;
        window.history.pushState({ route: "live", sessionId: session.id }, "", targetPath);
        setCurrentRoute("live");
        render();
      },
    });
    wrapper.append(archiveComponent.element);

    return wrapper;
  };

  return { renderHome };
}
