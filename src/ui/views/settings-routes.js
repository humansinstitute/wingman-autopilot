const SETTINGS_ROUTE = '/settings';
const SETTINGS_TAB_ROUTES = {
  profile: 'profile',
  workspace: 'workspace',
  flightdeck: 'flightdeck',
  agents: 'agents',
  users: 'users',
  projects: 'projects',
  admin: 'admin',
};
const SETTINGS_ROUTE_ALIASES = {
  'flight-deck': 'flightdeck',
};

export function getSettingsTabIdFromPath(pathname, tabDefs) {
  const availableTabIds = new Set(tabDefs.map((tabDef) => tabDef.id));
  const segment = String(pathname || '')
    .replace(/^\/settings\/?/, '')
    .split('/')[0]
    || '';
  const normalized = SETTINGS_ROUTE_ALIASES[segment] || segment;
  return availableTabIds.has(normalized) ? normalized : null;
}

export function getSettingsPathForTab(tabId) {
  const segment = SETTINGS_TAB_ROUTES[tabId] || tabId;
  return segment === SETTINGS_TAB_ROUTES.profile ? SETTINGS_ROUTE : `${SETTINGS_ROUTE}/${segment}`;
}
