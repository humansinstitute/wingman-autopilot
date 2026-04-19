export function shouldFullRenderOnSessionUpdate(route) {
  return route !== "files" && route !== "live";
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
  focusComposerTextarea,
  setActiveNav,
  syncMenuTabs,
  syncDesktopSessionIndicator,
  syncHeaderWebviewToggle,
  syncHeaderWriterToggle,
  updateAgentStatusIndicators,
  updateDocumentTitle,
}) {
  let renderDebounceTimer = null;
  let isRendering = false;
  let previousRenderRoute = null;
  const stablePages = new Set(["scheduler", "jobs"]);

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
        const currentRoute = getCurrentRoute();
        const routeChanged = previousRenderRoute !== currentRoute;
        previousRenderRoute = syncLiveRouteTransport({
          previousRoute: previousRenderRoute,
          currentRoute,
          activeSessionId: sessionsStore().activeSessionId,
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

        const resolvedRoute = getCurrentRoute();
        const focusSnapshot = captureFocusSnapshot();
        if (!routeChanged && stablePages.has(resolvedRoute)) {
          setActiveNav();
          syncMenuTabs();
          syncDesktopSessionIndicator();
          updateAgentStatusIndicators();
          updateDocumentTitle();
          return;
        }

        appRoot.innerHTML = "";
        const view = renderRouteView(resolvedRoute);
        appRoot.append(view);
        renderFileEditorOverlay();
        renderWorktreeModal();
        appRoot.dataset.route = resolvedRoute;
        restoreFocusFromSnapshot(focusSnapshot);

        if (resolvedRoute === "live" && (!document.activeElement || document.activeElement === document.body)) {
          const textarea = document.querySelector(".wm-composer textarea");
          focusComposerTextarea(textarea, "restore");
        }

        setActiveNav();
        syncMenuTabs();
        syncDesktopSessionIndicator();
        if (resolvedRoute !== "live") {
          syncHeaderWebviewToggle(null);
          syncHeaderWriterToggle(null);
        }
        updateAgentStatusIndicators();
        updateDocumentTitle();
      } finally {
        isRendering = false;
        renderDebounceTimer = null;
      }
    }, 50);
  }

  function handleSessionsStoreItemsChanged() {
    syncMenuTabs();
    syncDesktopSessionIndicator();
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
