/**
 * Home view renderer — guest landing, running apps table,
 * live agents session list, and archive component.
 *
 * Depends on: state, identity, session/app helpers, navigation (via DI).
 */

import { createArchiveComponent } from "../home/archive.js";
import { createLiveAgentsSection } from "../home/live-agents.js";
import { createRunningAppsSection } from "../home/running-apps.js";
import { createRunningPipelinesSection } from "../home/running-pipelines.js";
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
    ensureFeatureFlagsLoaded,
    isFeatureEnabledForViewer,
    // Session helpers
    isSessionActive,
    resumeSession,
    resumeNativeSession,
    stopSession,
    deleteSession,
    promptRenameSession,
    getSessionDisplayName,
    createAgentStatusIndicator,
    buildSessionFilterOptions,
    fetchSessions,
    syncMenuTabs,
    showToast,
    // App helpers
    isAppActionDisabled,
    triggerAppAction,
    // Utilities
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

    const quadrants = document.createElement("div");
    quadrants.className = "wm-home-quadrants";
    quadrants.dataset.testid = "home-quadrants";

    archiveComponent = createArchiveComponent({
      titleText: "Archive Sessions",
      defaultCollapsed: false,
      onViewSession: (session) => {
        const targetPath = `${LIVE_ROUTE_PREFIX}/${session.id}`;
        window.history.pushState({ route: "live", sessionId: session.id }, "", targetPath);
        setCurrentRoute("live");
        render();
      },
      resumeNativeSession,
      getSessionPendingAction,
      isSessionActionPending,
      withPendingSessionAction,
    });
    archiveComponent.element.classList.add("wm-home-quadrant");

    quadrants.append(
      createLiveAgentsSection({
        state,
        sessionsStore,
        getCurrentRoute,
        render,
        navigateToChat,
        openDialog,
        isFeatureEnabledForViewer,
        isSessionActive,
        resumeSession,
        resumeNativeSession,
        stopSession,
        deleteSession,
        promptRenameSession,
        getSessionDisplayName,
        createAgentStatusIndicator,
        buildSessionFilterOptions,
        fetchSessions,
        syncMenuTabs,
        showToast,
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
      createRunningAppsSection({
        appsStore,
        navigateToApps,
        isAppActionDisabled,
        triggerAppAction,
        appStatusLabels: APP_STATUS_LABELS,
        appActionLabels: APP_ACTION_LABELS,
      }),
      createRunningPipelinesSection({
        showToast,
        isFeatureEnabledForViewer,
      }).element,
      archiveComponent.element,
    );

    wrapper.append(quadrants);

    return wrapper;
  };

  return { renderHome };
}
