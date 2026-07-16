import {
  backupEnvFile,
  cleanupEnvFile,
  deleteInstanceSetting,
  fetchInstanceSettings,
  importInstanceSettings,
  saveInstanceSetting,
} from '../../services/instance-settings.js';

const CATEGORY_LABELS = {
  runtime: 'Runtime',
  agents: 'Agents',
  integrations: 'Integrations',
  pipelines: 'Pipelines',
  identity: 'Identity',
  internal: 'Internal',
};

function createStatus() {
  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.setAttribute('aria-live', 'polite');
  return status;
}

function createButton(label, className = 'wm-button secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function formatCleanupStatus(status) {
  if (status === 'cleanupSupported') return 'Env cleanup supported';
  if (status === 'cleanupReadOnly') return 'Env file is read-only';
  return 'Env cleanup unavailable in this runtime';
}

function groupByCategory(items) {
  return items.reduce((groups, item) => {
    const key = item.category || 'runtime';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function createBadge(text) {
  const badge = document.createElement('span');
  badge.className = 'wm-settings__port-note';
  badge.style.cssText = 'display:inline-block;margin-left:6px;font-size:0.78em;';
  badge.textContent = text;
  return badge;
}

function createSettingRow(setting, onReload, setStatus) {
  const row = document.createElement('div');
  row.className = 'wm-settings__key-row';
  row.style.cssText = 'display:grid;grid-template-columns:minmax(160px, 220px) minmax(0,1fr) auto;gap:8px;align-items:start;margin:8px 0;';
  row.setAttribute('data-testid', `instance-setting-${setting.key}`);

  const label = document.createElement('label');
  label.style.cssText = 'font-weight:600;font-size:0.88em;';
  label.textContent = setting.label;

  const details = document.createElement('div');
  const value = document.createElement('div');
  value.style.cssText = 'font-family:monospace;font-size:0.84em;word-break:break-word;';
  value.textContent = setting.configured
    ? (setting.maskedValue || 'configured')
    : (setting.maskedValue ? `env: ${setting.maskedValue}` : 'not configured');
  details.append(value);

  const meta = document.createElement('div');
  meta.className = 'wm-settings__port-note';
  meta.textContent = `${setting.envAliases.join(', ')}${setting.source ? ` • ${setting.source}` : ''}`;
  if (setting.requiresRestart) meta.append(createBadge('restart'));
  if (setting.bootstrapOnly) meta.append(createBadge('env only'));
  details.append(meta);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;';

  if (!setting.bootstrapOnly) {
    const input = document.createElement('input');
    input.className = 'wm-input';
    input.type = setting.secret ? 'password' : 'text';
    input.placeholder = setting.secret ? 'Replace secret' : 'Set value';
    input.setAttribute('aria-label', `Value for ${setting.label}`);
    input.setAttribute('data-testid', `instance-setting-input-${setting.key}`);
    input.style.cssText = 'min-width:180px;';

    const save = createButton('Save');
    save.setAttribute('aria-label', `Save ${setting.label}`);
    save.setAttribute('data-testid', `instance-setting-save-${setting.key}`);
    save.addEventListener('click', async () => {
      const nextValue = input.value.trim();
      if (!nextValue) return;
      save.disabled = true;
      try {
        await saveInstanceSetting(setting.key, nextValue);
        input.value = '';
        setStatus(`${setting.label} saved`);
        await onReload();
      } catch (error) {
        setStatus(error?.message || 'Save failed');
      } finally {
        save.disabled = false;
      }
    });
    controls.append(input, save);

    if (setting.configured) {
      const clear = createButton('Delete');
      clear.className = 'wm-button secondary danger';
      clear.setAttribute('aria-label', `Delete ${setting.label}`);
      clear.setAttribute('data-testid', `instance-setting-delete-${setting.key}`);
      clear.addEventListener('click', async () => {
        clear.disabled = true;
        try {
          await deleteInstanceSetting(setting.key);
          setStatus(`${setting.label} deleted`);
          await onReload();
        } catch (error) {
          setStatus(error?.message || 'Delete failed');
        } finally {
          clear.disabled = false;
        }
      });
      controls.append(clear);
    }
  }

  row.append(label, details, controls);
  return row;
}

function createImportTable(candidates, selectedKeys) {
  const table = document.createElement('table');
  table.className = 'wm-admin-users__table';
  table.setAttribute('data-testid', 'instance-settings-import-table');

  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Import</th><th>Setting</th><th>Env</th><th>Status</th></tr>';
  const tbody = document.createElement('tbody');

  candidates.forEach((candidate) => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', `instance-settings-import-${candidate.key}`);

    const checkboxCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = candidate.bootstrapOnly;
    checkbox.checked = candidate.canAutoImport || (!candidate.configured && !candidate.bootstrapOnly && !candidate.validationError);
    checkbox.setAttribute('aria-label', `Select ${candidate.label} for import`);
    if (checkbox.checked) selectedKeys.add(candidate.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedKeys.add(candidate.key);
      else selectedKeys.delete(candidate.key);
    });
    checkboxCell.append(checkbox);

    const settingCell = document.createElement('td');
    settingCell.textContent = candidate.label;

    const envCell = document.createElement('td');
    envCell.textContent = `${candidate.envKeys.join(', ')} = ${candidate.maskedEnvValue || 'set'}`;

    const statusCell = document.createElement('td');
    if (candidate.conflict) statusCell.textContent = 'conflict';
    else if (candidate.configured) statusCell.textContent = 'already configured';
    else if (candidate.blockedReason) statusCell.textContent = candidate.blockedReason;
    else statusCell.textContent = 'ready';

    tr.append(checkboxCell, settingCell, envCell, statusCell);
    tbody.append(tr);
  });

  table.append(thead, tbody);
  return table;
}

export function createInstanceSettingsSection() {
  const card = document.createElement('section');
  card.className = 'wm-card';
  card.setAttribute('data-testid', 'instance-settings-section');

  const heading = document.createElement('h2');
  heading.textContent = 'Environment & Runtime Settings';
  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Manage imported environment values as encrypted instance settings. Bootstrap values stay in the runtime environment.';
  const status = createStatus();
  status.textContent = 'Loading settings...';

  const actions = document.createElement('div');
  actions.className = 'wm-settings__ports-admin-actions';
  const reloadButton = createButton('Reload');
  reloadButton.setAttribute('aria-label', 'Reload instance settings');
  reloadButton.setAttribute('data-testid', 'instance-settings-reload');
  const importButton = createButton('Import Selected', 'wm-button');
  importButton.setAttribute('aria-label', 'Import selected environment settings');
  importButton.setAttribute('data-testid', 'instance-settings-import-selected');
  const backupButton = createButton('Back Up Env');
  backupButton.setAttribute('aria-label', 'Back up env file');
  backupButton.setAttribute('data-testid', 'instance-settings-backup-env');
  const cleanupButton = createButton('Clean Up Env');
  cleanupButton.setAttribute('aria-label', 'Remove selected imported keys from env file');
  cleanupButton.setAttribute('data-testid', 'instance-settings-cleanup-env');
  actions.append(reloadButton, importButton, backupButton, cleanupButton);

  const body = document.createElement('div');
  const selectedKeys = new Set();
  let latestPayload = null;

  const setStatus = (message) => {
    status.textContent = message;
  };

  const renderPayload = (payload) => {
    latestPayload = payload;
    selectedKeys.clear();
    body.replaceChildren();

    const cleanup = document.createElement('p');
    cleanup.className = 'wm-settings__port-note';
    cleanup.textContent = `${formatCleanupStatus(payload.cleanupStatus)}${payload.envFile?.path ? ` • ${payload.envFile.path}` : ''}`;
    body.append(cleanup);

    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (candidates.length > 0) {
      const importHeading = document.createElement('h3');
      importHeading.textContent = 'Detected Environment Values';
      body.append(importHeading, createImportTable(candidates, selectedKeys));
    }

    const settings = Array.isArray(payload.settings) ? payload.settings : [];
    for (const [category, items] of groupByCategory(settings)) {
      const section = document.createElement('section');
      const categoryHeading = document.createElement('h3');
      categoryHeading.textContent = CATEGORY_LABELS[category] || category;
      section.append(categoryHeading);
      items.forEach((setting) => {
        section.append(createSettingRow(setting, load, setStatus));
      });
      body.append(section);
    }

    cleanupButton.disabled = payload.cleanupStatus !== 'cleanupSupported';
    backupButton.disabled = payload.cleanupStatus !== 'cleanupSupported';
    importButton.disabled = candidates.length === 0;
  };

  async function load() {
    reloadButton.disabled = true;
    try {
      const payload = await fetchInstanceSettings();
      renderPayload(payload);
      setStatus('Settings loaded');
    } catch (error) {
      body.replaceChildren();
      setStatus(error?.message || 'Failed to load settings');
    } finally {
      reloadButton.disabled = false;
    }
  }

  reloadButton.addEventListener('click', () => {
    void load();
  });

  importButton.addEventListener('click', async () => {
    const keys = Array.from(selectedKeys);
    if (keys.length === 0) {
      setStatus('Select at least one setting to import');
      return;
    }
    importButton.disabled = true;
    try {
      const result = await importInstanceSettings(keys);
      setStatus(`Imported ${result.imported?.length || 0} setting(s)`);
      await load();
    } catch (error) {
      setStatus(error?.message || 'Import failed');
    } finally {
      importButton.disabled = false;
    }
  });

  backupButton.addEventListener('click', async () => {
    backupButton.disabled = true;
    try {
      const result = await backupEnvFile();
      setStatus(`Env backed up to ${result.backupPath}`);
      await load();
    } catch (error) {
      setStatus(error?.message || 'Backup failed');
    } finally {
      backupButton.disabled = latestPayload?.cleanupStatus !== 'cleanupSupported';
    }
  });

  cleanupButton.addEventListener('click', async () => {
    const keys = Array.from(selectedKeys);
    if (keys.length === 0) {
      setStatus('Select imported settings before cleanup');
      return;
    }
    cleanupButton.disabled = true;
    try {
      const result = await cleanupEnvFile(keys);
      setStatus(`Removed ${result.removedKeys?.length || 0} env key(s); backup ${result.backupPath}`);
      await load();
    } catch (error) {
      setStatus(error?.message || 'Cleanup failed');
    } finally {
      cleanupButton.disabled = latestPayload?.cleanupStatus !== 'cleanupSupported';
    }
  });

  card.append(heading, description, status, actions, body);
  void load();
  return card;
}
