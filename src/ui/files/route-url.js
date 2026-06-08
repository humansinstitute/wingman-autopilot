export function buildFilesPreviewRoutePath(filePath) {
  const path = typeof filePath === "string" ? filePath.trim() : "";
  if (!path) return "/files";
  return `/files/${encodeURIComponent(path)}`;
}
