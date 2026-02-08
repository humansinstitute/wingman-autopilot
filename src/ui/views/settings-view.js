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

  function renderApiKeysSection() {
    const container = document.createElement("div");
    container.className = "wm-settings__api-keys";

    const heading = document.createElement("h3");
    heading.textContent = "API Keys";
    container.append(heading);

    const description = document.createElement("p");
    description.className = "wm-settings__port-note";
    description.textContent = "Configure API keys for agent tools. Keys are stored per-user and used when agents generate images or call external APIs.";
    container.append(description);

    // OpenRouter API Key
    const keyRow = document.createElement("div");
    keyRow.className = "wm-settings__key-row";
    keyRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";

    const label = document.createElement("label");
    label.textContent = "OpenRouter API Key";
    label.style.cssText = "font-size:0.85em;font-weight:500;min-width:140px;";

    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "sk-or-...";
    input.className = "wm-input";
    input.style.cssText = "flex:1;font-family:monospace;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "wm-button secondary";
    saveBtn.textContent = "Save";
    saveBtn.style.cssText = "font-size:0.85em;padding:6px 12px;";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "wm-button secondary";
    clearBtn.textContent = "Clear";
    clearBtn.style.cssText = "font-size:0.85em;padding:6px 12px;";

    const status = document.createElement("span");
    status.style.cssText = "font-size:0.8em;color:var(--text-muted);";

    // Load current masked value
    fetch("/api/user/settings")
      .then((r) => r.json())
      .then((data) => {
        const masked = data.settings?.openrouter_api_key;
        if (masked) {
          input.placeholder = masked;
          status.textContent = "Key set";
          status.style.color = "var(--success, #4caf50)";
        }
      })
      .catch(() => {});

    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      try {
        const resp = await fetch("/api/user/settings/openrouter_api_key", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
        if (resp.ok) {
          input.value = "";
          input.placeholder = value.slice(0, 4) + ".." + value.slice(-4);
          status.textContent = "Saved";
          status.style.color = "var(--success, #4caf50)";
        } else {
          const err = await resp.json();
          status.textContent = err.error || "Save failed";
          status.style.color = "var(--error, #f44336)";
        }
      } catch (e) {
        status.textContent = "Network error";
        status.style.color = "var(--error, #f44336)";
      }
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    });

    clearBtn.addEventListener("click", async () => {
      clearBtn.disabled = true;
      try {
        await fetch("/api/user/settings/openrouter_api_key", { method: "DELETE" });
        input.value = "";
        input.placeholder = "sk-or-...";
        status.textContent = "Cleared";
        status.style.color = "var(--text-muted)";
      } catch {
        status.textContent = "Failed to clear";
        status.style.color = "var(--error, #f44336)";
      }
      clearBtn.disabled = false;
    });

    keyRow.append(label, input, saveBtn, clearBtn, status);
    container.append(keyRow);

    const helpText = document.createElement("p");
    helpText.className = "wm-settings__port-note";
    helpText.style.cssText = "margin-top:6px;font-size:0.8em;";
    helpText.innerHTML = 'Get your API key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Used by the <code>generate_image</code> agent tool.';
    container.append(helpText);

    return container;
  }

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

    // API Keys section (only for authenticated users)
    if (state.identity.authenticated) {
      wingmanCard.append(renderApiKeysSection());
    }

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
      const coreApp = appsStore().items.find((item) => item?.id === "wingman-core");
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
