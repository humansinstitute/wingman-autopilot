export function createLiveSessionToolbar({
  title = "Current session",
  meta = "",
  drawerVisible = false,
  onToggleDrawer,
} = {}) {
  const toolbar = document.createElement("section");
  toolbar.className = "wm-live-session-toolbar";
  toolbar.dataset.testid = "live-session-toolbar";

  const details = document.createElement("div");
  details.className = "wm-live-session-toolbar__details";

  const eyebrow = document.createElement("span");
  eyebrow.className = "wm-live-session-toolbar__eyebrow";
  eyebrow.textContent = "Live session";

  const heading = document.createElement("h2");
  heading.className = "wm-live-session-toolbar__title";
  heading.textContent = title;

  details.append(eyebrow, heading);

  if (meta) {
    const metaLine = document.createElement("p");
    metaLine.className = "wm-live-session-toolbar__meta";
    metaLine.textContent = meta;
    details.append(metaLine);
  }

  const actions = document.createElement("div");
  actions.className = "wm-live-session-toolbar__actions";

  const drawerButton = document.createElement("button");
  drawerButton.type = "button";
  drawerButton.className = "wm-button secondary";
  drawerButton.textContent = drawerVisible ? "Hide Session Drawer" : "Open Session Drawer";
  drawerButton.dataset.testid = "live-session-drawer-toggle";
  drawerButton.setAttribute("aria-label", drawerVisible ? "Hide session drawer" : "Open session drawer");
  drawerButton.addEventListener("click", () => {
    onToggleDrawer?.();
  });

  actions.append(drawerButton);
  toolbar.append(details, actions);
  return toolbar;
}
