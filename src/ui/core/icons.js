/**
 * SVG icon construction, text helpers, and scroll utilities.
 *
 * Pure functions — no framework or state dependencies.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export const createSvgShape = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });
  if (!attributes.fill) {
    element.setAttribute("fill", "none");
  }
  if (!attributes.stroke) {
    element.setAttribute("stroke", "currentColor");
  }
  if (!attributes["stroke-width"]) {
    element.setAttribute("stroke-width", "1.8");
  }
  if ((tag === "path" || tag === "line" || tag === "polyline") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "path" || tag === "polyline") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  return element;
};

export const createIconSvg = (definition) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wm-icon");
  definition.forEach(([tag, attrs]) => {
    svg.append(createSvgShape(tag, attrs));
  });
  return svg;
};

export const FILE_BROWSER_ICON_DEFS = {
  arrowUp: [
    ["line", { x1: 12, y1: 19, x2: 12, y2: 7 }],
    ["polyline", { points: "6 11 12 5 18 11" }],
  ],
  refresh: [
    ["polyline", { points: "23 4 23 10 17 10" }],
    ["path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36" }],
  ],
  eye: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
  ],
  eyeOff: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
    ["line", { x1: 4, y1: 4, x2: 20, y2: 20 }],
  ],
  folder: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M3 7h18" }],
  ],
  file: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
  ],
  fileText: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: 16, y1: 13, x2: 8, y2: 13 }],
    ["line", { x1: 16, y1: 17, x2: 8, y2: 17 }],
    ["path", { d: "M10 9h4" }],
  ],
  fileCode: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["polyline", { points: "10 13 8 15 10 17" }],
    ["polyline", { points: "14 17 16 15 14 13" }],
  ],
  ban: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["line", { x1: 5, y1: 19, x2: 19, y2: 5 }],
  ],
  folderPlus: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M12 11v4" }],
    ["path", { d: "M10 13h4" }],
  ],
  filePlus: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["path", { d: "M12 13v4" }],
    ["path", { d: "M10 15h4" }],
  ],
  upload: [
    ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }],
    ["polyline", { points: "16 6 12 2 8 6" }],
    ["line", { x1: 12, y1: 2, x2: 12, y2: 16 }],
  ],
  branchPlus: [
    ["circle", { cx: 6, cy: 6, r: 2.5 }],
    ["circle", { cx: 6, cy: 18, r: 2.5 }],
    ["circle", { cx: 18, cy: 12, r: 2.5 }],
    ["line", { x1: 6, y1: 8.5, x2: 6, y2: 15.5 }],
    ["path", { d: "M8.5 8.5a5 5 0 0 1 5.5 4.5" }],
    ["line", { x1: 18, y1: 14.5, x2: 18, y2: 20 }],
    ["line", { x1: 16, y1: 17, x2: 20, y2: 17 }],
  ],
};

export const setIconButton = (button, iconKey, label) => {
  const definition = FILE_BROWSER_ICON_DEFS[iconKey];
  if (!definition) return;
  while (button.firstChild) {
    button.removeChild(button.firstChild);
  }
  button.append(createIconSvg(definition));
  if (label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  } else {
    button.removeAttribute("aria-label");
    button.removeAttribute("title");
  }
};

export const getSessionDisplayName = (session) => {
  if (!session || typeof session !== "object") return "";
  const rawName = typeof session.name === "string" ? session.name.trim() : "";
  if (rawName.length > 0) return rawName;
  const agent = typeof session.agent === "string" ? session.agent : "agent";
  const port = typeof session.port === "number" ? session.port : "";
  return port ? `${agent} :${port}` : agent;
};

export const truncateText = (value, maxLength = 31) => {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  const safeLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, safeLength)}...`;
};

export const scrollConversationToBottom = (element) => {
  if (!element) return;
  requestAnimationFrame(() => {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      const target = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, target.scrollHeight);
      return;
    }
    element.scrollTop = element.scrollHeight;
  });
};

export const getConversationScrollElement = (sessionId, conversationContainers) => {
  const container = conversationContainers.get(sessionId);
  if (!container) return null;
  return container.closest('.wm-live-conversation');
};

export const scrollConversationAreaToBottom = (sessionId, conversationContainers, options = {}) => {
  const { includeWindow = false } = options;
  const target =
    getConversationScrollElement(sessionId, conversationContainers) ??
    document.querySelector('.wm-live-conversation');
  if (target) {
    scrollConversationToBottom(target);
  }
  if (includeWindow) {
    const fallback = document.scrollingElement || document.documentElement || document.body;
    if (fallback && fallback !== target) {
      scrollConversationToBottom(fallback);
    }
  }
};

export const isConversationScrolledToBottom = (sessionId, conversationContainers) => {
  const scrollElement = getConversationScrollElement(sessionId, conversationContainers);
  if (!scrollElement) {
    const doc = document.scrollingElement || document.documentElement || document.body;
    const threshold = 50;
    return doc.scrollHeight - doc.scrollTop - doc.clientHeight < threshold;
  }
  const threshold = 50;
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < threshold;
};

export const isMobileFilesLayout = () => {
  if (window.matchMedia) {
    try {
      return window.matchMedia("(max-width: 720px)").matches;
    } catch {
      // fall through to manual check
    }
  }
  return window.innerWidth <= 720;
};

export const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

export const escapeAttribute = (value) => {
  if (value === null || value === undefined) return "#";
  const trimmed = String(value).trim();
  const allowed = /^(https?:\/\/|\/|#|mailto:|tel:)/i;
  const safe = allowed.test(trimmed) ? trimmed : "#";
  return escapeHtml(safe).replace(/"/g, "&quot;");
};

export const sanitizeLanguageClass = (value) => {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
};
