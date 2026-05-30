export function rememberRecentItem(items, item, limit = 6) {
  if (!item?.id) return Array.isArray(items) ? items : [];
  const existing = Array.isArray(items) ? items : [];
  const next = [
    { ...item, updatedAt: item.updatedAt ?? new Date().toISOString() },
    ...existing.filter((entry) => entry?.id !== item.id),
  ];
  return next.slice(0, limit);
}

export function filterCommandPaletteItems(items, query) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => {
    const haystack = [
      item?.title,
      item?.subtitle,
      item?.groupLabel,
      item?.searchText,
    ].filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
