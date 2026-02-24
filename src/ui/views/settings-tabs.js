export function createSettingsTabs({ tabDefs, activeTabId, onTabChange }) {
  const shell = document.createElement('div');
  shell.className = 'wm-settings-tabs';

  const tabList = document.createElement('div');
  tabList.className = 'wm-settings-tabs__list';
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Settings sections');

  const panels = document.createElement('div');
  panels.className = 'wm-settings-tabs__panels';

  const panel = document.createElement('section');
  panel.className = 'wm-settings-tabs__panel';
  panel.setAttribute('role', 'tabpanel');

  const tabButtons = [];
  const tabMap = new Map(tabDefs.map((tabDef) => [tabDef.id, tabDef]));
  const defaultTabId = tabDefs[0]?.id ?? '';
  let currentTabId = tabMap.has(activeTabId) ? activeTabId : defaultTabId;

  function renderActivePanel(tabId) {
    panel.replaceChildren();
    const currentTab = tabMap.get(tabId);
    if (!currentTab) {
      return;
    }
    panel.id = `wm-settings-panel-${tabId}`;
    panel.append(currentTab.render());
  }

  function activateTab(tabId) {
    const nextTabId = tabMap.has(tabId) ? tabId : defaultTabId;
    if (!nextTabId) {
      return;
    }

    currentTabId = nextTabId;
    onTabChange?.(nextTabId);

    tabButtons.forEach((button) => {
      const isActive = button.dataset.tabId === nextTabId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    const activeButton = tabButtons.find((button) => button.dataset.tabId === nextTabId);
    if (activeButton) {
      panel.setAttribute('aria-labelledby', activeButton.id);
    }

    renderActivePanel(nextTabId);
  }

  tabDefs.forEach((tabDef) => {
    const tabButton = document.createElement('button');
    tabButton.type = 'button';
    tabButton.className = 'wm-settings-tabs__tab';
    tabButton.dataset.tabId = tabDef.id;
    tabButton.id = `wm-settings-tab-${tabDef.id}`;
    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-controls', `wm-settings-panel-${tabDef.id}`);
    tabButton.textContent = tabDef.label;
    tabButton.addEventListener('click', () => {
      activateTab(tabDef.id);
    });

    tabList.append(tabButton);
    tabButtons.push(tabButton);
  });

  tabList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }

    const currentIndex = tabButtons.findIndex((button) => button.dataset.tabId === currentTabId);
    if (currentIndex < 0) {
      return;
    }

    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + offset + tabButtons.length) % tabButtons.length;
    const nextButton = tabButtons[nextIndex];
    if (!nextButton?.dataset.tabId) {
      return;
    }

    activateTab(nextButton.dataset.tabId);
    nextButton.focus();
    event.preventDefault();
  });

  panels.append(panel);
  shell.append(tabList, panels);
  activateTab(currentTabId);

  return shell;
}
