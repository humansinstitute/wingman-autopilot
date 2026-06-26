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

export function attachWorkingNotesToggle(root = document) {
  if (attached || !root?.addEventListener) {
    return;
  }
  attached = true;
  root.addEventListener('dblclick', (event) => {
    if (event.defaultPrevented || shouldIgnoreTarget(event.target)) {
      return;
    }
    const panel = findWorkingNotesPanel(event.target);
    if (!panel || !togglePanel(panel)) {
      return;
    }
    event.preventDefault();
  });
}
