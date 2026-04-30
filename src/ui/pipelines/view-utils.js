export const RUN_FILTERS = ["all", "running", "ok", "needs_input", "error"];
export const DEFINITION_FILTERS = ["all", "user", "shared"];

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

export function titleCase(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusLabel(value) {
  if (value === "ok") return "Complete";
  if (value === "error") return "Failed";
  if (value === "needs_input") return "Needs Input";
  return titleCase(value);
}

export function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(startValue, endValue) {
  if (!startValue) return "--";
  const start = new Date(startValue).getTime();
  const end = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "--";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

export function formatRunMeta(run) {
  const started = formatDateTime(run.startedAt ?? run.started_at);
  const duration = formatDuration(run.startedAt ?? run.started_at, run.completedAt ?? run.completed_at);
  return [started, duration].filter((value) => value && value !== "--").join(" - ") || "--";
}

export function renderJsonBlock(title, value) {
  return `
    <section class="wm-pipeline-json-block">
      <h3>${escapeHtml(title)}</h3>
      <pre>${escapeHtml(JSON.stringify(value ?? {}, null, 2))}</pre>
    </section>
  `;
}

export function renderEmptyState(message, actionLabel, action) {
  return `
    <div class="wm-pipeline-empty">
      <p>${escapeHtml(message)}</p>
      <button type="button" data-action="${escapeAttribute(action)}">${escapeHtml(actionLabel)}</button>
    </div>
  `;
}

export function renderEmptyDetail(message) {
  return `
    <div class="wm-pipeline-empty-detail">
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

export function expandPreviewSteps(steps) {
  return steps.flatMap((step) => {
    if (step?.type !== "block" || step.block !== "memory.graphContext") return [step];
    const scratchPath = `$.blocks.${sanitizePreviewPathPart(step.name || step.block)}`;
    const inputPath = `${scratchPath}.input`;
    const outputPath = step.assign || "$.graphMemory";
    return [
      {
        name: `${step.name} / extract-memory-entities`,
        description: "Extract searchable long-term-memory entities from the current prompt.",
        type: "agent",
        agent: `${inputPath}.agent`,
        input: { pick: { prompt: `${inputPath}.prompt`, entityLimit: `${inputPath}.entityLimit` } },
        assign: `${scratchPath}.entityExtraction`,
        previewExpandedFrom: step.block,
      },
      {
        name: `${step.name} / search-graph-memory`,
        description: "Run parallel vector searches for the extracted entities.",
        type: "code",
        function: "memory.searchEntities",
        input: { pick: { prompt: `${inputPath}.prompt`, entities: `${scratchPath}.entityExtraction.entities` } },
        assign: `${scratchPath}.rawMatches`,
        previewExpandedFrom: step.block,
      },
      {
        name: `${step.name} / consolidate-graph-context`,
        description: "Consolidate graph memory matches into agent-consumable graphContext.",
        type: "code",
        function: "memory.consolidateGraphContext",
        assign: outputPath,
        previewExpandedFrom: step.block,
      },
    ];
  });
}

export function countSteps(definition) {
  return Array.isArray(definition.steps) ? expandPreviewSteps(definition.steps).length : 0;
}

function sanitizePreviewPathPart(value) {
  const sanitized = String(value).replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "block";
}
