const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[data-working-notes-ignore-toggle]',
].join(',');

let attached = false;
const panelOpenState = new Map();

function getElementTarget(target) {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node && target.parentElement) {
    return target.parentElement;
  }
  return null;
}

function isHTMLElement(value) {
  return value instanceof HTMLElement;
}

function shouldIgnoreTarget(target) {
  const element = getElementTarget(target);
  return isHTMLElement(element) && Boolean(element.closest(INTERACTIVE_SELECTOR));
}

function findWorkingNotesPanel(target) {
  const element = getElementTarget(target);
  if (!isHTMLElement(element)) {
    return null;
  }
  const bubble = element.closest('.wm-message[data-role="agent-working"]');
  if (!bubble) {
    return null;
  }
  return bubble.querySelector('[data-working-notes-panel]');
}

function togglePanel(panel) {
  if (!(panel instanceof HTMLDetailsElement)) {
    return false;
  }
  panel.open = !panel.open;
  return true;
}

function getPanelKey(panel) {
  return typeof panel?.dataset?.workingNotesKey === 'string' && panel.dataset.workingNotesKey.length > 0
    ? panel.dataset.workingNotesKey
    : null;
}

function rememberPanelState(panel) {
  if (!(panel instanceof HTMLDetailsElement)) {
    return;
  }
  const key = getPanelKey(panel);
  if (!key) {
    return;
  }
  panelOpenState.set(key, panel.open);
}

export function getWorkingNotesPanelKey(sessionId, message) {
  const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'session';
  const messageKey =
    message?.id ??
    message?.messageId ??
    message?.createdAt ??
    `${message?.role ?? message?.type ?? 'agent-working'}:${String(message?.content ?? message?.message ?? '').slice(0, 64)}`;
  return `${sid}:${messageKey}`;
}

export function getWorkingNotesPanelState(key) {
  return panelOpenState.get(key);
}

export function attachWorkingNotesToggle(root = document) {
  if (attached || !root?.addEventListener) {
    return;
  }
  attached = true;
  root.addEventListener('click', (event) => {
    if (event.defaultPrevented || shouldIgnoreTarget(event.target)) {
      return;
    }
    const panel = findWorkingNotesPanel(event.target);
    if (!(panel instanceof HTMLDetailsElement) || panel.open) {
      return;
    }
    panel.open = true;
    rememberPanelState(panel);
    event.preventDefault();
  });
  root.addEventListener('dblclick', (event) => {
    if (event.defaultPrevented || shouldIgnoreTarget(event.target)) {
      return;
    }
    const panel = findWorkingNotesPanel(event.target);
    if (!panel || !togglePanel(panel)) {
      return;
    }
    rememberPanelState(panel);
    event.preventDefault();
  });
  root.addEventListener('toggle', (event) => {
    if (event.target instanceof HTMLDetailsElement && event.target.matches('[data-working-notes-panel]')) {
      rememberPanelState(event.target);
    }
  }, true);
}
