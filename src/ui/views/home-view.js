/**
 * Home view renderer — guest landing, orchestrator card, running apps table,
 * live agents session list, and archive component.
 *
 * Depends on: state, identity, session/app helpers, navigation (via DI).
 */

import { createHomeGuestHero } from "../home/hero.js";
import { createArchiveComponent } from "../home/archive.js";

const HOME_GUEST_FEATURES = [
  {
    icon: "\u{1F30D}",
    title: "Interact with your agents from anywhere",
    description:
      "Stay connected to your automations and copilots from any device so your work keeps flowing even away from your main workstation.",
  },
  {
    icon: "\u{1F91D}",
    title: "Share Claude, Codex, and Goose setups",
    description:
      "Package your preferred agent configurations once and roll them out to the rest of the team with shared guardrails and credentials.",
  },
  {
    icon: "\u26A1",
    title: "Orchestrate common business processes",
    description:
      "Coordinate hand-offs, approvals, and back-office tasks with reproducible workflows that run on schedule or on demand.",
  },
  {
    icon: "\u{1F680}",
    title: "Build custom apps in minutes",
    description:
      "Compose bespoke UIs and automations around your agents without leaving Wingman, then deploy them to the people who need them.",
  },
  {
    icon: "\u{1F3AF}",
    title: "Run your business on Wingman",
    description:
      "Centralize knowledge, tooling, and agent-powered operations in one control plane that scales as your team grows.",
  },
];

export function initHomeView(deps) {
  const {
    state,
    sessionsStore,
    getCurrentRoute,
    setCurrentRoute,
    render,
    // Navigation
    openIdentityLoginDialog,
    navigateToApps,
    navigateToChat,
    openDialog,
    openOrchestratorDialog,
    // Orchestrator
    renderOrchestratorPresetButtons,
    ensureOrchestratorPresetsLoaded,
    orchestratorFeatureEnabledForViewer,
    ensureFeatureFlagsLoaded,
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

  // ── Guest helpers ──────────────────────────────────────────────

  const renderHomeGuestHero = () => {
    return createHomeGuestHero({
      onLogin: openIdentityLoginDialog,
      onBrowse: () => navigateToApps(),
    });
  };

  const renderHomeGuestFeatures = () => {
    const card = document.createElement("section");
    card.className = "wm-card wm-home-guest-features";

    const header = document.createElement("div");
    header.className = "wm-home-section-header";
    const title = document.createElement("h2");
    title.textContent = "What you can do with Wingman";
    header.append(title);

    const list = document.createElement("ul");
    list.className = "wm-home-guest-feature-list";

    HOME_GUEST_FEATURES.forEach(({ icon, title: featureTitle, description }) => {
      const item = document.createElement("li");
      item.className = "wm-home-guest-feature";

      const itemIcon = document.createElement("div");
      itemIcon.className = "wm-home-guest-feature-icon";
      itemIcon.textContent = icon;

      const itemTitle = document.createElement("h3");
      itemTitle.textContent = featureTitle;

      const itemDescription = document.createElement("p");
      itemDescription.textContent = description;

      item.append(itemIcon, itemTitle, itemDescription);
      list.append(item);
    });

    card.append(header, list);
    return card;
  };

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

    if (!state.apps.initialized && !state.apps.loading) {
      // void ensureAppsLoaded(); // DISABLED
    }

    let orchestratorCard = null;
    if (orchestratorFeatureEnabledForViewer()) {
      orchestratorCard = document.createElement("section");
      orchestratorCard.className = "wm-card wm-home-orchestrator";

      const orchestratorHeader = document.createElement("div");
      orchestratorHeader.className = "wm-home-section-header";

      const orchestratorTitle = document.createElement("h2");
      orchestratorTitle.textContent = "Orchestrator";

      const orchestratorContent = document.createElement("div");
      orchestratorContent.className = "wm-home-orchestrator-content";
      orchestratorContent.id = "orchestrator-content";

      const setOrchestratorCollapsed = (collapsed) => {
        if (collapsed) {
          orchestratorCard.dataset.collapsed = "true";
          orchestratorContent.hidden = true;
          orchestratorHeader.setAttribute("aria-expanded", "false");
        } else {
          delete orchestratorCard.dataset.collapsed;
          orchestratorContent.hidden = false;
          orchestratorHeader.setAttribute("aria-expanded", "true");
        }
      };

      const orchestratorCreateButton = document.createElement("button");
      orchestratorCreateButton.type = "button";
      orchestratorCreateButton.className = "wm-button secondary wm-button-icon";
      orchestratorCreateButton.setAttribute("aria-label", "Add orchestrator preset");
      orchestratorCreateButton.innerHTML = '<span aria-hidden="true">+</span>';
      orchestratorCreateButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openOrchestratorDialog();
      });

      const orchestratorHeaderActions = document.createElement("div");
      orchestratorHeaderActions.className = "wm-home-section-actions";
      orchestratorHeaderActions.append(orchestratorCreateButton);

      const orchestratorActions = document.createElement("div");
      orchestratorActions.className = "wm-home-orchestrator-actions";
      renderOrchestratorPresetButtons(orchestratorActions);

      if (!state.orchestratorPresetsLoaded && !state.orchestratorPresetsLoading) {
        ensureOrchestratorPresetsLoaded();
      }

      orchestratorHeader.addEventListener("click", (event) => {
        if (orchestratorCreateButton.contains(event.target)) return;
        const currentlyCollapsed = orchestratorCard.dataset.collapsed === "true";
        setOrchestratorCollapsed(!currentlyCollapsed);
      });

      orchestratorHeader.append(orchestratorTitle, orchestratorHeaderActions);
      orchestratorContent.append(orchestratorActions);
      orchestratorCard.append(orchestratorHeader, orchestratorContent);
      setOrchestratorCollapsed(false);
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

    if (state.apps.error) {
      const error = document.createElement("p");
      error.className = "wm-home-apps-status";
      error.textContent = state.apps.error;
      appsContent.append(error);
    } else {
      const runningApps = Array.isArray(state.apps.items)
        ? state.apps.items.filter((app) => app?.status?.status === "running")
        : [];

      if (state.apps.loading && !state.apps.initialized) {
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
          nameCell.textContent = app.label ?? app.id;
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

    const liveCard = document.createElement("section");
    liveCard.className = "wm-card wm-home-live";

    const liveHeader = document.createElement("div");
    liveHeader.className = "wm-home-section-header";

    const liveTitle = document.createElement("h2");
    liveTitle.textContent = "Live Agents";

    const liveContent = document.createElement("div");
    liveContent.className = "wm-home-live-content";
    liveContent.id = "live-agents-content";

    const setCollapsed = (collapsed) => {
      if (collapsed) {
        liveCard.dataset.collapsed = "true";
        liveContent.hidden = true;
      } else {
        delete liveCard.dataset.collapsed;
        liveContent.hidden = false;
      }
    };

    liveHeader.addEventListener("click", () => {
      const currentlyCollapsed = liveCard.dataset.collapsed === "true";
      setCollapsed(!currentlyCollapsed);
    });

    liveHeader.append(liveTitle);
    liveCard.append(liveHeader);

    const renderSessionActions = (target, session) => {
      const resumeBtn = document.createElement("button");
      resumeBtn.className = "wm-button";
      resumeBtn.textContent = "Resume";
      resumeBtn.addEventListener("click", () => resumeSession(session.id));
      target.append(resumeBtn);

      if (isSessionActive(session)) {
        const stopBtn = document.createElement("button");
        stopBtn.className = "wm-button secondary";
        stopBtn.textContent = "Stop";
        stopBtn.addEventListener("click", () => stopSession(session.id));
        target.append(stopBtn);
      } else {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "wm-button secondary";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => deleteSession(session.id));
        target.append(deleteBtn);
      }
    };

    const actions = document.createElement("div");
    actions.className = "wm-actions";

    if (state.identity.isAdmin) {
      const filterContainer = document.createElement("div");
      filterContainer.className = "wm-session-filter";
      const filterLabel = document.createElement("label");
      filterLabel.textContent = "Identities";
      const filterSelect = document.createElement("select");
      filterSelect.className = "wm-select";
      buildSessionFilterOptions().forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        const currentFilterNpub = sessionsStore()?.filters?.npub ?? state.sessionFilters.npub;
        if (option.value === currentFilterNpub) {
          opt.selected = true;
        }
        filterSelect.append(opt);
      });
      filterSelect.addEventListener("change", (event) => {
        const target = event.target;
        const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
        state.sessionFilters.npub = value;
        state.sessionFilters.initialized = true;
        const ss = sessionsStore();
        if (ss) {
          ss.filters.npub = value;
          ss.filters.initialized = true;
        }
        void fetchSessions().then(() => {
          syncMenuTabs();
          const route = getCurrentRoute();
          if (route === "home" || route === "live") {
            render();
          }
        });
      });
      filterLabel.append(filterSelect);
      filterContainer.append(filterLabel);
      actions.append(filterContainer);
    }

    const launchBtn = document.createElement("button");
    launchBtn.className = "wm-button";
    launchBtn.textContent = "Launch Agent Session";
    launchBtn.addEventListener("click", openDialog);
    actions.append(launchBtn);

    const privateChatBtn = document.createElement("button");
    privateChatBtn.className = "wm-button secondary";
    privateChatBtn.textContent = "Private Chats";
    privateChatBtn.title = "View private AI chats";
    privateChatBtn.addEventListener("click", () => navigateToChat(null));
    actions.append(privateChatBtn);

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "wm-button secondary";
    refreshBtn.textContent = "Refresh";
    refreshBtn.title = "Refresh sessions";
    refreshBtn.addEventListener("click", () => {
      void fetchSessions();
    });
    actions.append(refreshBtn);

    const table = document.createElement("table");
    table.className = "session-table";

    const colgroup = document.createElement("colgroup");
    [
      "actions",
      "name",
      "agent",
      "identity",
      "status",
      "port",
      "pid",
      "started",
      "directory",
    ].forEach((key) => {
      const col = document.createElement("col");
      col.className = `session-col-${key}`;
      colgroup.append(col);
    });
    table.append(colgroup);

    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr><th>Actions</th><th>Name</th><th>Agent</th><th>Identity</th><th>Status</th><th>Port</th><th>PID</th><th>Started</th><th>Directory</th></tr>";
    table.append(thead);

    const tbody = document.createElement("tbody");
    if (state.sessions.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 9;
      cell.textContent = "No active sessions";
      row.append(cell);
      tbody.append(row);
    } else {
      state.sessions.forEach((session) => {
        const row = document.createElement("tr");
        const displayName = getSessionDisplayName(session);
        const identityAlias = typeof session.identityAlias === "string" && session.identityAlias.trim().length > 0 ? session.identityAlias.trim() : null;
        const identityLabel = identityAlias ?? (session.npub && session.npub.length > 0 ? session.npub : "Anonymous");
        const identityTooltip = session.npub && session.npub.length > 0 ? session.npub : identityLabel;
        row.innerHTML = `
        <td class="actions-cell"></td>
        <td class="session-name-cell">
          <span class="session-name-text">${escapeHtml(displayName)}</span>
          <button type="button" class="wm-link-button session-name-edit" data-action="rename-session">Edit</button>
        </td>
        <td>${escapeHtml(session.agent)}</td>
        <td class="identity-cell" title="${escapeHtml(identityTooltip)}">${escapeHtml(identityLabel)}</td>
        <td class="session-status-cell">
          <div class="wm-agent-status-indicator" data-session-id="${escapeHtml(session.id)}"></div>
          <span class="session-status-text">${escapeHtml(session.status)}</span>
        </td>
        <td>${escapeHtml(session.port)}</td>
        <td>${session.pid ?? "-"}</td>
        <td>${new Date(session.startedAt).toLocaleTimeString()}</td>
        <td class="directory-cell"></td>
      `;
        const directoryCell = row.querySelector(".directory-cell");
        if (directoryCell) {
          const directoryValue =
            session.workingDirectory ??
            state.config?.defaultDirectory ??
            "-";
          directoryCell.textContent = directoryValue;
          if (typeof session.workingDirectory === "string") {
            directoryCell.title = session.workingDirectory;
          } else {
            directoryCell.removeAttribute("title");
          }
        }
        const renameButton = row.querySelector('[data-action="rename-session"]');
        if (renameButton instanceof HTMLButtonElement) {
          renameButton.addEventListener("click", (event) => {
            event.preventDefault();
            promptRenameSession(session);
          });
        }

        const actionsCell = row.querySelector(".actions-cell");
        if (actionsCell) {
          renderSessionActions(actionsCell, session);
        }
        tbody.append(row);
      });
    }

    table.append(tbody);

    const tableContainer = document.createElement("div");
    tableContainer.className = "wm-table-container session-table-wrapper";
    tableContainer.append(table);

    const cardsContainer = document.createElement("div");
    cardsContainer.className = "session-card-list";
    if (state.sessions.length === 0) {
      const emptyCard = document.createElement("article");
      emptyCard.className = "session-card empty";
      emptyCard.textContent = "No active sessions";
      cardsContainer.append(emptyCard);
    } else {
      state.sessions.forEach((session) => {
        const card = document.createElement("article");
        card.className = "session-card";

        const header = document.createElement("header");
        header.className = "session-card-header";
        const title = document.createElement("h3");
        const displayName = getSessionDisplayName(session);
        title.textContent = displayName;
        const statusContainer = document.createElement("div");
        statusContainer.className = "session-status-container";
        const statusIndicator = createAgentStatusIndicator(session.id);
        statusIndicator.className += " status-small";
        const status = document.createElement("span");
        status.className = `session-status ${session.status}`;
        status.textContent = session.status;
        statusContainer.append(statusIndicator, status);
        const headerActions = document.createElement("div");
        headerActions.className = "session-card-header-actions";
        const editLink = document.createElement("button");
        editLink.type = "button";
        editLink.className = "wm-link-button session-card-edit";
        editLink.textContent = "Edit name";
        editLink.addEventListener("click", (event) => {
          event.preventDefault();
          promptRenameSession(session);
        });
        headerActions.append(statusContainer, editLink);
        header.append(title, headerActions);
        card.append(header);

        const details = document.createElement("div");
        details.className = "session-card-details";
        const addDetail = (label, value) => {
          const item = document.createElement("div");
          item.className = "session-card-detail";
          const term = document.createElement("span");
          term.className = "session-card-detail-label";
          term.textContent = label;
          const desc = document.createElement("span");
          desc.className = "session-card-detail-value";
          desc.textContent = value ?? "-";
          item.append(term, desc);
          details.append(item);
        };

        addDetail("Agent", session.agent);
        addDetail("Identity", session.npub ?? "Anonymous");
        addDetail("Port", session.port ?? "-");
        addDetail("PID", session.pid ?? "-");
        addDetail("Started", new Date(session.startedAt).toLocaleTimeString());
        const directoryValue =
          session.workingDirectory ?? state.config?.defaultDirectory ?? "-";
        addDetail("Directory", directoryValue);
        card.append(details);

        const actionRow = document.createElement("div");
        actionRow.className = "session-card-actions";
        renderSessionActions(actionRow, session);
        card.append(actionRow);

        cardsContainer.append(card);
      });
    }

    liveContent.append(actions, cardsContainer, tableContainer);
    liveCard.append(liveContent);

    setCollapsed(false);
    wrapper.append(appsCard);
    wrapper.append(liveCard);
    if (orchestratorCard) {
      wrapper.append(orchestratorCard);
    }

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
