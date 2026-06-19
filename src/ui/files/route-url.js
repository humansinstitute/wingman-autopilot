export const FILES_ROUTE_PREFIX = "/files";
export const DOCS_ROUTE_PREFIX = "/docs";

export function isDocsRoutePath(pathname) {
  return pathname === DOCS_ROUTE_PREFIX || pathname.startsWith(`${DOCS_ROUTE_PREFIX}/`);
}

export function isFilesRoutePath(pathname) {
  return pathname === FILES_ROUTE_PREFIX || pathname.startsWith(`${FILES_ROUTE_PREFIX}/`);
}

export function getFilesRoutePrefixForPath(pathname) {
  return isDocsRoutePath(pathname) ? DOCS_ROUTE_PREFIX : FILES_ROUTE_PREFIX;
}

export function getFilesSurfaceFromPath(pathname) {
  return isDocsRoutePath(pathname) ? "docs" : "files";
}

export function buildFilesPreviewRoutePath(filePath, options = {}) {
  const path = typeof filePath === "string" ? filePath.trim() : "";
  const routePrefix = options.routePrefix === DOCS_ROUTE_PREFIX ? DOCS_ROUTE_PREFIX : FILES_ROUTE_PREFIX;
  if (!path) return routePrefix;
  return `${routePrefix}/${encodeURIComponent(path)}`;
}
