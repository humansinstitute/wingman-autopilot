import {
  escapeHtml,
  renderJsonBlock,
} from "./view-utils.js";

export function serializeInspectionValue(value) {
  return encodeURIComponent(JSON.stringify(encodeInspectionValue(value)));
}

export function bindPipelineValueInspector(root) {
  root.querySelectorAll('[data-action="inspect-pipeline-value"]').forEach((button) => {
    button.addEventListener("click", () => {
      showPipelineValueInspector({
        title: button.dataset.valueTitle ?? "Value",
        encodedValue: button.dataset.value ?? "",
      });
    });
  });
}

function showPipelineValueInspector({ title, encodedValue }) {
  const existing = document.getElementById("pipeline-value-inspector");
  existing?.remove();

  const value = parseInspectionValue(encodedValue);
  const modal = document.createElement("div");
  modal.id = "pipeline-value-inspector";
  modal.className = "wm-pipeline-value-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "pipeline-value-inspector-title");
  modal.dataset.testid = "pipeline-value-inspector";
  modal.innerHTML = `
    <section class="wm-pipeline-value-modal-content">
      <div class="wm-pipeline-section-heading wm-pipeline-step-modal-header">
        <div>
          <h3 id="pipeline-value-inspector-title">${escapeHtml(title)}</h3>
          <p class="wm-muted">Click nested objects or arrays to expand their values.</p>
        </div>
        <button type="button" class="wm-pipeline-step-close" data-action="close-pipeline-value-inspector" aria-label="Close value inspector" data-testid="pipeline-value-inspector-close">Close</button>
      </div>
      ${renderJsonBlock("Value", value)}
    </section>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target?.dataset?.action === "close-pipeline-value-inspector") {
      modal.remove();
    }
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.remove();
  });

  document.body.append(modal);
  const closeButton = modal.querySelector('[data-action="close-pipeline-value-inspector"]');
  if (closeButton && typeof closeButton.focus === "function") {
    closeButton.focus({ preventScroll: true });
  }
}

function parseInspectionValue(encodedValue) {
  try {
    return decodeInspectionValue(JSON.parse(decodeURIComponent(encodedValue)));
  } catch {
    return null;
  }
}

function encodeInspectionValue(value) {
  if (value === undefined) return { __pipelineValueType: "undefined" };
  return { __pipelineValueType: "json", value };
}

function decodeInspectionValue(payload) {
  if (payload?.__pipelineValueType === "undefined") return undefined;
  if (payload?.__pipelineValueType === "json") return payload.value;
  return null;
}
