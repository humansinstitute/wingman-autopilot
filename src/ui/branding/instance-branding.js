import { saveInstanceSetting } from '../services/instance-settings.js';

const DEFAULT_NAME = 'Wingman';
const DEFAULT_HIGHLIGHT_COLOR = '#10b981';
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function normalizeInstanceBranding(branding) {
  const name = typeof branding?.name === 'string' && branding.name.trim()
    ? branding.name.trim()
    : DEFAULT_NAME;
  const highlightColor = typeof branding?.highlightColor === 'string'
    && HEX_COLOR_PATTERN.test(branding.highlightColor.trim())
    ? branding.highlightColor.trim().toLowerCase()
    : DEFAULT_HIGHLIGHT_COLOR;
  return { name, highlightColor };
}

export function applyInstanceBranding(branding) {
  const normalized = normalizeInstanceBranding(branding);
  document.documentElement.style.setProperty('--accent-primary', normalized.highlightColor);
  const heading = document.querySelector('[data-testid="autopilot-name"]');
  if (heading) heading.textContent = normalized.name;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', normalized.highlightColor);
  return normalized;
}

export function getInstanceName(config) {
  return normalizeInstanceBranding(config?.branding).name;
}

export function createInstanceBrandingSection({ config, onSaved }) {
  const branding = normalizeInstanceBranding(config?.branding);
  const card = document.createElement('section');
  card.className = 'wm-card wm-branding-settings';
  card.setAttribute('data-testid', 'instance-branding-settings');

  const heading = document.createElement('h2');
  heading.textContent = 'Autopilot Branding';
  const description = document.createElement('p');
  description.textContent = 'Give this Autopilot a distinct name and highlight colour. The rest of its accent palette is derived automatically.';

  const form = document.createElement('form');
  form.className = 'wm-branding-settings__form';

  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'autopilot-branding-name';
  nameLabel.textContent = 'Autopilot name';
  const nameInput = document.createElement('input');
  nameInput.id = 'autopilot-branding-name';
  nameInput.type = 'text';
  nameInput.maxLength = 80;
  nameInput.required = true;
  nameInput.value = branding.name;
  nameInput.setAttribute('data-testid', 'autopilot-branding-name');

  const colorLabel = document.createElement('label');
  colorLabel.htmlFor = 'autopilot-branding-color';
  colorLabel.textContent = 'Highlight colour';
  const colorRow = document.createElement('div');
  colorRow.className = 'wm-branding-settings__color-row';
  const colorInput = document.createElement('input');
  colorInput.id = 'autopilot-branding-color';
  colorInput.type = 'color';
  colorInput.value = branding.highlightColor;
  colorInput.setAttribute('aria-label', 'Choose Autopilot highlight colour');
  colorInput.setAttribute('data-testid', 'autopilot-branding-color');
  const colorValue = document.createElement('code');
  colorValue.textContent = branding.highlightColor;
  colorInput.addEventListener('input', () => {
    colorValue.textContent = colorInput.value;
    applyInstanceBranding({ name: nameInput.value, highlightColor: colorInput.value });
  });
  colorRow.append(colorInput, colorValue);

  const status = document.createElement('p');
  status.className = 'wm-instance-settings__status';
  status.setAttribute('aria-live', 'polite');
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'wm-button';
  saveButton.textContent = 'Save Branding';
  saveButton.setAttribute('data-testid', 'autopilot-branding-save');

  form.append(nameLabel, nameInput, colorLabel, colorRow, saveButton, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    try {
      await Promise.all([
        saveInstanceSetting('branding.name', name),
        saveInstanceSetting('branding.highlight_color', colorInput.value),
      ]);
      const nextBranding = applyInstanceBranding({ name, highlightColor: colorInput.value });
      status.textContent = 'Branding saved';
      await onSaved?.(nextBranding);
    } catch (error) {
      status.textContent = error?.message || 'Failed to save branding';
    } finally {
      saveButton.disabled = false;
    }
  });

  card.append(heading, description, form);
  return card;
}
