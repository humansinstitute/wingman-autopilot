/**
 * Floating "scroll to bottom" pill indicator.
 *
 * Shows a small pill above the composer when new content arrives and the user
 * is scrolled up. Clicking it smooth-scrolls to the bottom.
 *
 * Also includes a second pill ("last prompt") that appears near the top of the
 * visible chat area and jumps to the latest user message.
 */

const THRESHOLD = 50;
const USER_MESSAGE_SELECTOR = '.wm-message[data-role="user"]';
const HEADER_OFFSET_FALLBACK = 12;
const LAST_PROMPT_TOP_CLEARANCE = 56;

function isDocumentScrollTarget(el) {
  return (
    el === document.body ||
    el === document.documentElement ||
    el === document.scrollingElement
  );
}

function getHeaderInset(scrollTarget) {
  const header = document.querySelector(".wm-header");
  if (!header) {
    return HEADER_OFFSET_FALLBACK;
  }
  if (isDocumentScrollTarget(scrollTarget)) {
    return Math.max(HEADER_OFFSET_FALLBACK, header.getBoundingClientRect().height);
  }
  const containerRect = getScrollContainerRect(scrollTarget);
  const headerRect = header.getBoundingClientRect();
  if (headerRect.height <= 0) {
    return HEADER_OFFSET_FALLBACK;
  }
  const overlap = headerRect.bottom - containerRect.top;
  return Math.max(HEADER_OFFSET_FALLBACK, overlap);
}

function clampScrollTop(scrollTop, scrollElement) {
  const maxTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  return Math.max(0, Math.min(maxTop, scrollTop));
}

function scrollToElementAtTop(scrollElement, element) {
  if (!scrollElement || !(scrollElement instanceof HTMLElement) || !element || !(element instanceof HTMLElement)) {
    return;
  }
  const targetRect = element.getBoundingClientRect();
  const containerRect = getScrollContainerRect(scrollElement);
  const headerInset = getHeaderInset(scrollElement);

  if (isDocumentScrollTarget(scrollElement)) {
    const currentTop = window.scrollY || (document.scrollingElement?.scrollTop ?? 0);
    const targetTop = currentTop + (targetRect.top - containerRect.top) - headerInset;
    window.scrollTo({ top: targetTop, behavior: "smooth" });
    return;
  }

  const targetOffset = scrollElement.scrollTop + (targetRect.top - containerRect.top) - headerInset;
  const finalTop = clampScrollTop(targetOffset, scrollElement);
  scrollElement.scrollTo({ top: finalTop, behavior: "smooth" });
}

function createPillState() {
  return {
    pillEl: null,
    scrollTarget: null,
    conversationElement: null,
    scrollListener: null,
    scrollListenerTarget: null,
    resizeListener: null,
    mutationObserver: null,
    lastMessageElement: null,
  };
}

const bottomPillState = createPillState();
const lastPromptPillState = createPillState();

function resolveListenerTarget(el) {
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return window;
  }
  return el;
}

function getScrollContainerRect(el) {
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return {
      top: 0,
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
    };
  }
  return el.getBoundingClientRect();
}

function checkNearBottom(el) {
  if (!el) return true;
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    const doc = document.scrollingElement || document.documentElement || document.body;
    return doc.scrollHeight - doc.scrollTop - doc.clientHeight < THRESHOLD;
  }
  return el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
}

function cleanupPillState(state) {
  if (state.scrollListenerTarget && state.scrollListener) {
    state.scrollListenerTarget.removeEventListener("scroll", state.scrollListener);
  }
  if (state.mutationObserver) {
    state.mutationObserver.disconnect();
  }
  if (state.resizeListener) {
    window.removeEventListener("resize", state.resizeListener);
  }
  if (state.pillEl && state.pillEl.parentNode) {
    state.pillEl.parentNode.removeChild(state.pillEl);
  }
  state.pillEl = null;
  state.scrollTarget = null;
  state.conversationElement = null;
  state.scrollListener = null;
  state.scrollListenerTarget = null;
  state.resizeListener = null;
  state.lastMessageElement = null;
}

function resolveConversationElement(scrollElement, conversationElement) {
  if (conversationElement instanceof Element) {
    if (conversationElement.isConnected) {
      return conversationElement;
    }
  }
  if (scrollElement?.querySelector instanceof Function) {
    const fromScroll = scrollElement.querySelector(".wm-live-conversation");
    if (fromScroll) {
      return fromScroll;
    }
  }
  const fallback = document.querySelector(".wm-live-conversation");
  if (fallback) {
    return fallback;
  }
  if (conversationElement instanceof Element) {
    return conversationElement;
  }
  return null;
}

function getLatestUserMessage(conversationElement) {
  if (!(conversationElement instanceof Element)) {
    return null;
  }
  const messages = conversationElement.querySelectorAll(USER_MESSAGE_SELECTOR);
  if (!messages.length) {
    return null;
  }
  return messages[messages.length - 1] || null;
}

export function isMessageRectInView(messageRect, scrollRect, headerInset = 0) {
  return (
    messageRect.top >= scrollRect.top + headerInset &&
    messageRect.bottom <= scrollRect.bottom
  );
}

export function isMessageRectAboveView(messageRect, scrollRect, headerInset = 0) {
  return messageRect.bottom < scrollRect.top + headerInset;
}

function isMessageInView(messageElement, scrollElement) {
  if (!(messageElement instanceof Element) || !scrollElement) {
    return true;
  }
  const headerInset = getHeaderInset(scrollElement);
  const scrollRect = getScrollContainerRect(scrollElement);
  const messageRect = messageElement.getBoundingClientRect();
  return isMessageRectInView(messageRect, scrollRect, headerInset);
}

function isMessageAboveView(messageElement, scrollElement) {
  if (!(messageElement instanceof Element) || !scrollElement) {
    return false;
  }
  const headerInset = getHeaderInset(scrollElement);
  const scrollRect = getScrollContainerRect(scrollElement);
  const messageRect = messageElement.getBoundingClientRect();
  return isMessageRectAboveView(messageRect, scrollRect, headerInset);
}

export function getLastPromptPillPosition(scrollRect, headerInset = 0) {
  return {
    top: scrollRect.top + headerInset + LAST_PROMPT_TOP_CLEARANCE,
    left: scrollRect.left + ((scrollRect.right - scrollRect.left) / 2),
  };
}

function positionLastPromptPill(state) {
  if (!state?.pillEl || !state.scrollTarget) {
    return;
  }
  const scrollRect = getScrollContainerRect(state.scrollTarget);
  const position = getLastPromptPillPosition(scrollRect, getHeaderInset(state.scrollTarget));
  state.pillEl.style.top = `${position.top}px`;
  state.pillEl.style.left = `${position.left}px`;
}

function updateLastPromptPillVisibility(state) {
  if (!state || !state.pillEl) return;
  state.conversationElement = resolveConversationElement(state.scrollTarget, state.conversationElement);
  const latestMessage = getLatestUserMessage(state.conversationElement);
  state.lastMessageElement = latestMessage;
  if (!latestMessage) {
    state.pillEl.style.display = "none";
    return;
  }
  const shouldShow = !isMessageInView(latestMessage, state.scrollTarget)
    && isMessageAboveView(latestMessage, state.scrollTarget);
  state.pillEl.style.display = shouldShow ? "" : "none";
  if (shouldShow) {
    positionLastPromptPill(state);
  }
}

/**
 * Create (or re-use) the floating pill and attach it to a parent container.
 * The parent should be position:sticky or position:relative so the pill can
 * anchor itself via position:absolute.
 *
 * @param {HTMLElement} parent  - element to append the pill into (e.g. composer-shell)
 * @param {HTMLElement} scrollElement - the scrollable element to watch & scroll
 */
export function attachScrollPill(parent, scrollElement) {
  cleanupPillState(bottomPillState);

  if (!parent || !scrollElement) return;

  bottomPillState.scrollTarget = scrollElement;

  const button = document.createElement("button");
  button.className = "wm-scroll-pill";
  button.textContent = "scroll to bottom";
  button.setAttribute("aria-label", "Scroll to bottom");
  button.style.display = "none";

  button.addEventListener("click", () => {
    if (!bottomPillState.scrollTarget) return;
    bottomPillState.scrollTarget.scrollTo({ top: bottomPillState.scrollTarget.scrollHeight, behavior: "smooth" });
    const docTarget = document.scrollingElement || document.documentElement || document.body;
    if (docTarget !== bottomPillState.scrollTarget) {
      docTarget.scrollTo({ top: docTarget.scrollHeight, behavior: "smooth" });
    }
    hide();
  });

  parent.appendChild(button);
  bottomPillState.pillEl = button;

  bottomPillState.scrollListener = () => {
    if (!bottomPillState.scrollTarget || !bottomPillState.pillEl) return;
    if (checkNearBottom(bottomPillState.scrollTarget)) hide();
  };
  bottomPillState.scrollListenerTarget = resolveListenerTarget(scrollElement);
  bottomPillState.scrollListenerTarget.addEventListener("scroll", bottomPillState.scrollListener, { passive: true });

  bottomPillState.pillEl = button;
}

/**
 * Create and attach a "last prompt" pill near the top of the visible chat area.
 *
 * @param {HTMLElement} parent  - fallback element to append the pill into
 * @param {HTMLElement} scrollElement - the scrollable element to watch
 * @param {HTMLElement} conversationElement - optional conversation wrapper
 */
export function attachLastPromptPill(parent, scrollElement, conversationElement = null) {
  cleanupPillState(lastPromptPillState);

  if (!parent || !scrollElement) return;

  lastPromptPillState.scrollTarget = scrollElement;
  lastPromptPillState.conversationElement = resolveConversationElement(scrollElement, conversationElement);

  const button = document.createElement("button");
  button.className = "wm-scroll-pill wm-scroll-pill--last-prompt";
  button.textContent = "last prompt";
  button.setAttribute("aria-label", "Scroll to last prompt");
  button.dataset.testid = "scroll-to-last-prompt";
  button.style.display = "none";

  button.addEventListener("click", () => {
    lastPromptPillState.conversationElement = resolveConversationElement(
      lastPromptPillState.scrollTarget,
      lastPromptPillState.conversationElement,
    );
    const latestMessage = getLatestUserMessage(lastPromptPillState.conversationElement);
    if (!latestMessage) {
      hideLastPromptPill();
      return;
    }
    scrollToElementAtTop(lastPromptPillState.scrollTarget, latestMessage);
    hideLastPromptPill();
  });

  const pillParent = document.body || parent;
  pillParent.appendChild(button);
  lastPromptPillState.pillEl = button;

  lastPromptPillState.scrollListener = () => {
    if (!lastPromptPillState.scrollTarget || !lastPromptPillState.pillEl) return;
    updateLastPromptPillVisibility(lastPromptPillState);
  };
  lastPromptPillState.scrollListenerTarget = resolveListenerTarget(scrollElement);
  lastPromptPillState.scrollListenerTarget.addEventListener("scroll", lastPromptPillState.scrollListener, { passive: true });
  lastPromptPillState.resizeListener = () => {
    updateLastPromptPillVisibility(lastPromptPillState);
  };
  window.addEventListener("resize", lastPromptPillState.resizeListener, { passive: true });

  if (typeof MutationObserver === "function" && lastPromptPillState.conversationElement) {
    lastPromptPillState.mutationObserver = new MutationObserver(() => {
      if (!lastPromptPillState.pillEl) return;
      updateLastPromptPillVisibility(lastPromptPillState);
    });
    lastPromptPillState.mutationObserver.observe(lastPromptPillState.conversationElement, {
      childList: true,
      subtree: true,
    });
  }

  updateLastPromptPillVisibility(lastPromptPillState);
  lastPromptPillState.pillEl = button;
}

/** Show the bottom pill (call when new content arrives and user is scrolled up). */
export function show() {
  if (bottomPillState.pillEl) bottomPillState.pillEl.style.display = "";
}

/** Hide the bottom pill. */
export function hide() {
  if (bottomPillState.pillEl) bottomPillState.pillEl.style.display = "none";
}

export function hideLastPromptPill() {
  if (lastPromptPillState.pillEl) lastPromptPillState.pillEl.style.display = "none";
}

/** Returns true if the scroll target is near the bottom. */
export function isNearBottom() {
  return checkNearBottom(bottomPillState.scrollTarget);
}

export function scrollLastMessageToTop(scrollElement, conversationElement) {
  const activeConversation = resolveConversationElement(scrollElement, conversationElement);
  const latestMessage = getLatestUserMessage(activeConversation);
  if (!latestMessage || !scrollElement) {
    return;
  }
  scrollToElementAtTop(scrollElement, latestMessage);
}

/** Remove listeners and elements. Call on view teardown. */
export function cleanup() {
  cleanupPillState(bottomPillState);
  cleanupPillState(lastPromptPillState);
}
