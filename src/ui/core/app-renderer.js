import {
  applyAuthRouteRedirect,
  renderAuthPendingView as defaultRenderAuthPendingView,
  shouldHoldProtectedRoute,
} from "./auth-route-guard.js";

export function shouldFullRenderOnSessionUpdate(route) {
  return route !== "home" && route !== "files" && route !== "live" && route !== "settings" && route !== "pipelines" && route !== "terminal";
}

export function createAppRenderer({
  appRoot,
  sessionsStore,
  getCurrentRoute,
  setCurrentRoute,
  sseManager,
  getLiveRefreshController,
  syncLiveRouteTransport,
  syncProjectsNavigationVisibility,
  syncNightWatchNavigationVisibility,
  homeRoute,
  projectsRoute,
  nightwatchRoute,
  captureFocusSnapshot,
  restoreFocusFromSnapshot,
  renderRouteView,
  renderFileEditorOverlay,
  renderWorktreeModal,
  renderAuthPendingView = defaultRenderAuthPendingView,
  focusComposerTextarea,
  setActiveNav,
  syncMenuTabs,
  updateAgentStatusIndicators,
  updateDocumentTitle,
  isAuthenticated = () => true,
  isAuthResolved = () => true,
}) {
  let renderDebounceTimer = null;
  let isRendering = false;
  let previousRenderRoute = null;
  let previousRenderPath = null;
  const stablePages = new Set(["scheduler", "jobs", "pipelines", "terminal"]);

  function render() {
    if (isRendering) {
      return;
    }

    if (renderDebounceTimer) {
      clearTimeout(renderDebounceTimer);
    }

    renderDebounceTimer = setTimeout(() => {
      isRendering = true;
      try {
        const authenticated = Boolean(isAuthenticated());
        const authResolved = Boolean(isAuthResolved());
        const initialRoute = getCurrentRoute();
        const authPending = shouldHoldProtectedRoute(initialRoute, {
          authenticated,
          authResolved,
        });
        const currentRoute = authPending
          ? initialRoute
          : applyAuthRouteRedirect({
              route: initialRoute,
              authenticated,
              authResolved,
              setCurrentRoute,
              fallbackRoute: "home",
              fallbackPath: homeRoute,
              replaceHistory: true,
            });
        const routeChanged = previousRenderRoute !== currentRoute;
        previousRenderRoute = syncLiveRouteTransport({
          previousRoute: previousRenderRoute,
          currentRoute: authPending ? "home" : currentRoute,
          activeSessionId: authPending ? null : sessionsStore().activeSessionId,
          sseManager,
          liveRefreshController: getLiveRefreshController(),
        });

        const projectsEnabled = syncProjectsNavigationVisibility();
        if (!projectsEnabled && getCurrentRoute() === "projects") {
          setCurrentRoute("home");
          if (window.location.pathname === projectsRoute) {
            window.history.replaceState({ route: "home" }, "", homeRoute);
          }
        }

        const nightwatchEnabled = syncNightWatchNavigationVisibility();
        if (!nightwatchEnabled && getCurrentRoute() === "nightwatch") {
          setCurrentRoute("home");
          if (window.location.pathname === nightwatchRoute) {
            window.history.replaceState({ route: "home" }, "", homeRoute);
          }
        }

        const resolvedRoute = authPending ? currentRoute : getCurrentRoute();
        const currentPath = window.location.pathname;
        const pathChanged = previousRenderPath !== currentPath;
        const focusSnapshot = captureFocusSnapshot();
        if (!routeChanged && !pathChanged && stablePages.has(resolvedRoute)) {
          setActiveNav();
          syncMenuTabs();
          updateAgentStatusIndicators();
          updateDocumentTitle();
          return;
        }
        previousRenderPath = currentPath;

        appRoot.innerHTML = "";
        const view = authPending ? renderAuthPendingView() : renderRouteView(resolvedRoute);
        appRoot.append(view);
        if (!authPending) {
          renderFileEditorOverlay();
          renderWorktreeModal();
        }
        appRoot.dataset.route = authPending ? "auth" : resolvedRoute;
        restoreFocusFromSnapshot(focusSnapshot);

        if (!authPending && resolvedRoute === "live" && (!document.activeElement || document.activeElement === document.body)) {
          const textarea = document.querySelector(".wm-composer textarea");
          focusComposerTextarea(textarea, "restore");
        }

        setActiveNav();
        syncMenuTabs();
        updateAgentStatusIndicators();
        if (authPending) {
          document.title = "Wingman";
        } else {
          updateDocumentTitle();
        }
      } finally {
        isRendering = false;
        renderDebounceTimer = null;
      }
    }, 50);
  }

  function handleSessionsStoreItemsChanged() {
    syncMenuTabs();
    if (shouldFullRenderOnSessionUpdate(getCurrentRoute())) {
      render();
    } else {
      updateAgentStatusIndicators();
    }
  }

  return {
    render,
    handleSessionsStoreItemsChanged,
  };
}
