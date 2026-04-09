const MODAL_STYLE_ID = "wm-nightwatch-enable-modal-styles";

function ensureNightWatchEnableModalStyles() {
  if (document.getElementById(MODAL_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = MODAL_STYLE_ID;
  style.textContent = `
    .wm-nightwatch-enable-modal {
      width: min(42rem, 92vw);
      max-width: 42rem;
    }

    .wm-nightwatch-enable-modal__form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      min-width: 0;
    }

    .wm-nightwatch-enable-modal__body {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .wm-nightwatch-enable-modal__hint {
      margin: 0.35rem 0 0;
      opacity: 0.75;
      font-size: 0.9rem;
      line-height: 1.4;
    }

    .wm-nightwatch-enable-modal__grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(0, 1fr) 12rem;
      align-items: start;
    }

    .wm-nightwatch-enable-modal__status {
      min-height: 1.25rem;
      margin: 0;
      font-size: 0.9rem;
      color: #fca5a5;
    }

    .wm-nightwatch-enable-modal__footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
    }

    @media (max-width: 640px) {
      .wm-nightwatch-enable-modal__grid {
        grid-template-columns: minmax(0, 1fr);
      }

      .wm-nightwatch-enable-modal__footer {
        flex-direction: column-reverse;
      }

      .wm-nightwatch-enable-modal__footer button {
        width: 100%;
      }
    }
  `;

  document.head.append(style);
}

export function openNightWatchEnableModal({
  sessionName,
  prompt,
  intervalMinutes,
  minIntervalMinutes,
  maxIntervalMinutes,
  maxCycles,
  maxCycleOptions,
}) {
  ensureNightWatchEnableModalStyles();

  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "wm-nightwatch-enable-modal";
    dialog.setAttribute("aria-labelledby", "wm-nightwatch-enable-title");
    dialog.dataset.testid = "nightwatch-enable-modal";

    const form = document.createElement("form");
    form.method = "dialog";
    form.className = "wm-nightwatch-enable-modal__form";

    const header = document.createElement("header");
    header.className = "wm-dialog__header";

    const title = document.createElement("h2");
    title.id = "wm-nightwatch-enable-title";
    title.textContent = "Enable Night Watch";

    const subtitle = document.createElement("p");
    subtitle.className = "wm-dialog__subtitle";
    subtitle.textContent = sessionName
      ? `Configure the check-in prompt for ${sessionName}.`
      : "Configure the check-in prompt for this session.";

    header.append(title, subtitle);

    const body = document.createElement("section");
    body.className = "wm-nightwatch-enable-modal__body";

    const grid = document.createElement("div");
    grid.className = "wm-nightwatch-enable-modal__grid";

    const promptField = document.createElement("label");
    promptField.className = "wm-dialog__field";
    promptField.textContent = "Prompt and instructions";

    const promptInput = document.createElement("textarea");
    promptInput.rows = 6;
    promptInput.value = prompt;
    promptInput.required = true;
    promptInput.spellcheck = false;
    promptInput.setAttribute("aria-label", "Night Watch prompt and instructions");
    promptInput.setAttribute("data-testid", "nightwatch-prompt-input");

    const promptHint = document.createElement("p");
    promptHint.className = "wm-nightwatch-enable-modal__hint";
    promptHint.textContent =
      "This exact message is sent to the agent each time the timer fires.";

    promptField.append(promptInput, promptHint);

    const timingFields = document.createElement("div");
    timingFields.style.display = "flex";
    timingFields.style.flexDirection = "column";
    timingFields.style.gap = "1rem";

    const intervalField = document.createElement("label");
    intervalField.className = "wm-dialog__field";
    intervalField.textContent = "How Often";

    const intervalInput = document.createElement("input");
    intervalInput.type = "number";
    intervalInput.min = String(minIntervalMinutes);
    intervalInput.max = String(maxIntervalMinutes);
    intervalInput.step = "1";
    intervalInput.value = String(intervalMinutes);
    intervalInput.required = true;
    intervalInput.setAttribute("aria-label", "Night Watch timer in minutes");
    intervalInput.setAttribute("data-testid", "nightwatch-interval-input");

    const intervalHint = document.createElement("p");
    intervalHint.className = "wm-nightwatch-enable-modal__hint";
    intervalHint.textContent = `Choose a timer between ${minIntervalMinutes} and ${maxIntervalMinutes} minutes.`;

    intervalField.append(intervalInput, intervalHint);

    const maxTurnsField = document.createElement("label");
    maxTurnsField.className = "wm-dialog__field";
    maxTurnsField.textContent = "Max Turns";

    const maxTurnsInput = document.createElement("select");
    maxTurnsInput.required = true;
    maxTurnsInput.setAttribute("aria-label", "Night Watch maximum turns");
    maxTurnsInput.setAttribute("data-testid", "nightwatch-max-cycles-input");

    const cycleOptions = Array.isArray(maxCycleOptions) && maxCycleOptions.length > 0
      ? maxCycleOptions
      : [6, 21, 256];
    const normalizedMaxCycles = Number.isFinite(Number(maxCycles)) && Number(maxCycles) > 0
      ? Math.trunc(Number(maxCycles))
      : cycleOptions[0];
    const uniqueCycleOptions = Array.from(new Set([...cycleOptions, normalizedMaxCycles]))
      .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      .map((value) => Math.trunc(Number(value)))
      .sort((a, b) => a - b);

    uniqueCycleOptions.forEach((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      if (value === normalizedMaxCycles) {
        option.selected = true;
      }
      maxTurnsInput.append(option);
    });

    const maxTurnsHint = document.createElement("p");
    maxTurnsHint.className = "wm-nightwatch-enable-modal__hint";
    maxTurnsHint.textContent = "Stop Night Watch automatically after this many check-ins.";

    maxTurnsField.append(maxTurnsInput, maxTurnsHint);
    timingFields.append(intervalField, maxTurnsField);

    grid.append(promptField, timingFields);
    body.append(grid);

    const status = document.createElement("p");
    status.className = "wm-nightwatch-enable-modal__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("data-testid", "nightwatch-enable-status");
    body.append(status);

    const footer = document.createElement("footer");
    footer.className = "wm-nightwatch-enable-modal__footer";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wm-btn wm-btn--sm";
    cancelButton.textContent = "Cancel";
    cancelButton.setAttribute("aria-label", "Cancel enabling Night Watch");
    cancelButton.addEventListener("click", () => dialog.close("cancel"));

    const confirmButton = document.createElement("button");
    confirmButton.type = "submit";
    confirmButton.className = "wm-btn wm-btn--sm";
    confirmButton.textContent = "Enable";
    confirmButton.setAttribute("aria-label", "Enable Night Watch");
    confirmButton.setAttribute("data-testid", "nightwatch-enable-confirm");

    footer.append(cancelButton, confirmButton);

    form.append(header, body, footer);
    dialog.append(form);

    const cleanup = () => {
      dialog.remove();
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const nextPrompt = promptInput.value.trim();
      if (!nextPrompt) {
        status.textContent = "Prompt cannot be empty.";
        promptInput.focus();
        return;
      }

      const nextInterval = Number(intervalInput.value);
      if (
        !Number.isFinite(nextInterval) ||
        nextInterval < minIntervalMinutes ||
        nextInterval > maxIntervalMinutes
      ) {
        status.textContent = `Timer must be between ${minIntervalMinutes} and ${maxIntervalMinutes} minutes.`;
        intervalInput.focus();
        return;
      }

      dialog.close("confirm");
      resolve({
        prompt: nextPrompt,
        intervalMinutes: Math.trunc(nextInterval),
        maxCycles: Math.trunc(Number(maxTurnsInput.value)),
      });
    });

    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "confirm") {
          resolve(null);
        }
        cleanup();
      },
      { once: true },
    );

    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => promptInput.focus());
  });
}
