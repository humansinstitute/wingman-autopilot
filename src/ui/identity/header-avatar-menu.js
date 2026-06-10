import { applyAvatarImage } from "../utils/avatar.js";

function getIdentityDisplayName(identity) {
  const npub = typeof identity?.npub === "string" ? identity.npub : "";
  const alias = typeof identity?.alias === "string" && identity.alias.trim().length > 0
    ? identity.alias.trim()
    : null;
  if (alias) return alias;
  if (!npub) return "?";
  return npub.length > 20 ? `${npub.slice(0, 10)}\u2026${npub.slice(-4)}` : npub;
}

export function initHeaderAvatarMenu({ button, state, identityEventNames = [] }) {
  const avatar = button?.querySelector("#menu-toggle-avatar");
  if (!(button instanceof HTMLElement) || !(avatar instanceof HTMLElement)) {
    return { update: () => {}, destroy: () => {} };
  }

  function update() {
    const identity = state.identity ?? {};
    const displayName = getIdentityDisplayName(identity);
    applyAvatarImage(avatar, identity.picture, displayName);
    button.title = displayName === "?" ? "Open account menu" : `Open account menu for ${displayName}`;
  }

  const trackedEvents = ["wingman:identity-ui-state", ...identityEventNames];
  trackedEvents.forEach((eventName) => {
    window.addEventListener(eventName, update);
  });

  update();

  return {
    update,
    destroy() {
      trackedEvents.forEach((eventName) => {
        window.removeEventListener(eventName, update);
      });
    },
  };
}
