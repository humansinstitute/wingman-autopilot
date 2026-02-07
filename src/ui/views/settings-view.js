/**
 * Settings page renderer — identity, wingman settings, admin tools.
 *
 * Depends on: state, render, various panel renderers, admin APIs (via DI).
 */

export function initSettingsView(deps) {
  const {
    state,
    appsStore,
    getCurrentRoute,
    render,
    normalisePortList,
    generateAdminPorts,
    renderIdentityPanel,
    renderFeatureFlagsPanel,
    ensureFeatureFlagsLoaded,
    renderAdminUsersPanel,
    fetchAdminUsers,
    renderWingmanCard,
    npubProjectsState,
    fetchNpubProjects,
    renderNpubProjectsPanel,
  } = deps;

  const renderSettings = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-settings";

    const pageTitle = document.createElement("h1");
    pageTitle.textContent = "Settings";
    wrapper.append(pageTitle);

    wrapper.append(renderIdentityPanel());

    const wingmanCard = document.createElement("section");
    wingmanCard.className = "wm-card";
    const wingmanHeading = document.createElement("h2");
    wingmanHeading.textContent = "Wingman Settings";
    const wingmanDescription = document.createElement("p");
    wingmanDescription.textContent = "Adjust global preferences for the Wingman workspace.";
    wingmanCard.append(wingmanHeading, wingmanDescription);

    const portsContainer = document.createElement("div");
    portsContainer.className = "wm-settings__ports";
    const portsHeading = document.createElement("h3");
    portsHeading.textContent = "Assigned Web App Ports";
    const portsList = document.createElement("ul");
    portsList.className = "wm-settings__port-list";
    const assignedPorts = Array.isArray(state.identity.ports) ? normalisePortList(state.identity.ports) : [];
    if (assignedPorts.length > 0) {
      assignedPorts.forEach((port) => {
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = String(port);
        item.append(code);
        portsList.append(item);
      });
    } else {
      const item = document.createElement("li");
      item.className = "wm-settings__port-empty";
      item.textContent = state.identity.authenticated ? "Assigned ports will appear here once available." : "Sign in to view your assigned ports.";
      portsList.append(item);
    }
    const portsNote = document.createElement("p");
    portsNote.className = "wm-settings__port-note";
    portsNote.textContent = "These dedicated ports are reserved for your personal Wingman web applications.";
    portsContainer.append(portsHeading, portsList, portsNote);

    if (state.identity.isAdmin) {
      const adminPortsActions = document.createElement("div");
      adminPortsActions.className = "wm-settings__ports-admin-actions";
      const generatePortsButton = document.createElement("button");
      generatePortsButton.type = "button";
      generatePortsButton.className = "wm-button secondary";
      generatePortsButton.textContent = "Generate 3 More Ports";
      generatePortsButton.addEventListener("click", async () => {
        generatePortsButton.disabled = true;
        generatePortsButton.textContent = "Generating\u2026";
        const result = await generateAdminPorts(3);
        if (result && result.success) {
          render();
        } else {
          generatePortsButton.disabled = false;
          generatePortsButton.textContent = "Generate 3 More Ports";
          alert(result?.error || "Failed to generate ports");
        }
      });
      adminPortsActions.append(generatePortsButton);
      portsContainer.append(adminPortsActions);
    }

    wingmanCard.append(portsContainer);
    wrapper.append(wingmanCard);

    if (state.identity.authenticated) {
      if (!npubProjectsState.loading && npubProjectsState.items.length === 0 && !npubProjectsState.error) {
        fetchNpubProjects().then(() => {
          if (getCurrentRoute() === "settings") {
            render();
          }
        });
      }
      wrapper.append(renderNpubProjectsPanel(() => {
        fetchNpubProjects().then(() => {
          if (getCurrentRoute() === "settings") {
            render();
          }
        });
      }));
    }

    if (state.identity.isAdmin) {
      ensureFeatureFlagsLoaded();
      wrapper.append(renderFeatureFlagsPanel());
      if (!state.adminUsers.initialized && !state.adminUsers.loading && !state.adminUsers.error) {
        void fetchAdminUsers();
      }
      wrapper.append(renderAdminUsersPanel());
      const coreApp = (appsStore()?.items ?? state.apps.items).find((item) => item?.id === "wingman-core");
      if (coreApp) {
        const coreSection = document.createElement("section");
        coreSection.className = "wm-card wm-app-card-core";
        coreSection.append(renderWingmanCard(coreApp));
        wrapper.append(coreSection);
      }
    }

    return wrapper;
  };

  return { renderSettings };
}
