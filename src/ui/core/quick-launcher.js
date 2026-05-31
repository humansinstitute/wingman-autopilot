/**
 * Quick launcher menu — project-based session launcher (CMD+K style).
 *
 * Depends on: state.config, launchSession, showToast (via DI).
 */

import { launchProjectSession } from "./project-session-launcher.js";

export function initQuickLauncher(deps) {
  const { state, launchSession, showToast } = deps;

  const quickLauncherButton = document.getElementById("quick-launcher-button");
  const quickLauncherMenu = document.getElementById("quick-launcher-menu");
  const quickLauncherList = document.getElementById("quick-launcher-list");

  const quickLauncherState = {
    projects: [],
    loading: false,
  };

  const fetchQuickLauncherProjects = async () => {
    quickLauncherState.loading = true;
    try {
      const response = await fetch("/api/npub-projects", { credentials: "include" });
      if (!response.ok) {
        quickLauncherState.projects = [];
        return;
      }
      const data = await response.json();
      quickLauncherState.projects = Array.isArray(data.projects) ? data.projects : [];
    } catch {
      quickLauncherState.projects = [];
    } finally {
      quickLauncherState.loading = false;
    }
  };

  const renderQuickLauncherMenu = () => {
    if (!quickLauncherList) return;
    quickLauncherList.innerHTML = "";

    if (quickLauncherState.projects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-quick-launcher-empty";
      empty.textContent = quickLauncherState.loading ? "Loading..." : "No projects yet";
      quickLauncherList.append(empty);
      return;
    }

    quickLauncherState.projects.forEach((project) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wm-quick-launcher-item";
      item.dataset.projectId = project.id;

      const name = document.createElement("span");
      name.className = "wm-quick-launcher-item-name";
      name.textContent = project.name;

      const path = document.createElement("span");
      path.className = "wm-quick-launcher-item-path";
      path.textContent = project.directoryPath;
      path.title = project.directoryPath;

      item.append(name, path);
      item.addEventListener("click", () => {
        quickLaunchSession(project);
      });
      quickLauncherList.append(item);
    });
  };

  const quickLaunchSession = async (project) => {
    closeQuickLauncherMenu();
    await launchProjectSession({ project, state, launchSession, showToast });
  };

  const openQuickLauncherMenu = async () => {
    if (!quickLauncherMenu || !quickLauncherButton) return;
    await fetchQuickLauncherProjects();
    renderQuickLauncherMenu();
    quickLauncherMenu.hidden = false;
    quickLauncherButton.setAttribute("aria-expanded", "true");

    const closeOnClickOutside = (event) => {
      if (!quickLauncherMenu.contains(event.target) && event.target !== quickLauncherButton) {
        closeQuickLauncherMenu();
        document.removeEventListener("mousedown", closeOnClickOutside);
      }
    };
    document.addEventListener("mousedown", closeOnClickOutside);
  };

  const closeQuickLauncherMenu = () => {
    if (!quickLauncherMenu || !quickLauncherButton) return;
    quickLauncherMenu.hidden = true;
    quickLauncherButton.setAttribute("aria-expanded", "false");
  };

  const toggleQuickLauncherMenu = () => {
    if (quickLauncherMenu?.hidden) {
      openQuickLauncherMenu();
    } else {
      closeQuickLauncherMenu();
    }
  };

  // Bind event listener
  if (quickLauncherButton) {
    quickLauncherButton.addEventListener("click", toggleQuickLauncherMenu);
  }

  return {
    openQuickLauncherMenu,
    closeQuickLauncherMenu,
    toggleQuickLauncherMenu,
  };
}
