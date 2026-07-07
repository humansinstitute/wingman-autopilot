function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function createDisclosureButton({ text, expanded = false, controls }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-tiptap-comments__toggle";
  button.textContent = text;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (controls) button.setAttribute("aria-controls", controls);
  return button;
}

function renderThread(thread, deps) {
  const item = document.createElement("article");
  item.className = "wm-tiptap-comments__thread";
  item.dataset.status = thread.status || "open";
  item.dataset.testid = "tiptap-comment-thread";

  const header = document.createElement("div");
  header.className = "wm-tiptap-comments__thread-header";
  const quote = document.createElement("blockquote");
  quote.textContent = thread.anchor?.text || "Unanchored comment";
  header.append(quote);

  const statusButton = document.createElement("button");
  statusButton.type = "button";
  statusButton.className = "wm-tiptap-comments__status";
  statusButton.textContent = thread.status === "resolved" ? "Reopen" : "Resolve";
  statusButton.setAttribute("aria-label", thread.status === "resolved" ? "Reopen comment thread" : "Resolve comment thread");
  statusButton.addEventListener("click", () => {
    deps.onSetStatus?.(thread.id, thread.status === "resolved" ? "open" : "resolved");
  });
  header.append(statusButton);
  item.append(header);

  if (thread.anchor?.blockHint) {
    const hint = document.createElement("div");
    hint.className = "wm-tiptap-comments__hint";
    hint.textContent = thread.anchor.blockHint;
    item.append(hint);
  }

  const messages = document.createElement("div");
  messages.className = "wm-tiptap-comments__messages";
  for (const message of thread.messages || []) {
    const row = document.createElement("div");
    row.className = "wm-tiptap-comments__message";
    const meta = document.createElement("div");
    meta.className = "wm-tiptap-comments__meta";
    meta.textContent = [message.author, formatTimestamp(message.createdAt)].filter(Boolean).join(" · ");
    const body = document.createElement("p");
    body.textContent = message.body;
    row.append(meta, body);
    messages.append(row);
  }
  item.append(messages);

  const footer = document.createElement("div");
  footer.className = "wm-tiptap-comments__thread-actions";
  const replyToggle = createDisclosureButton({ text: "Reply" });
  footer.append(replyToggle);
  item.append(footer);

  const replyForm = document.createElement("form");
  replyForm.className = "wm-tiptap-comments__reply";
  replyForm.hidden = true;
  const replyInput = document.createElement("textarea");
  replyInput.rows = 2;
  replyInput.placeholder = "Reply";
  replyInput.setAttribute("aria-label", "Reply to comment thread");
  const replyButton = document.createElement("button");
  replyButton.type = "submit";
  replyButton.className = "wm-button secondary";
  replyButton.textContent = "Send reply";
  replyForm.append(replyInput, replyButton);
  replyToggle.addEventListener("click", () => {
    const isOpen = replyToggle.getAttribute("aria-expanded") === "true";
    replyToggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
    replyForm.hidden = isOpen;
  });
  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    deps.onAddReply?.(thread.id, replyInput.value);
  });
  item.append(replyForm);

  return item;
}

export function createCommentsPanel({
  threads = [],
  onAddThread,
  onAddReply,
  onSetStatus,
} = {}) {
  const panel = document.createElement("aside");
  panel.className = "wm-tiptap-comments";
  panel.dataset.testid = "tiptap-comments-panel";
  panel.setAttribute("aria-label", "Markdown comments");
  const bodyId = `tiptap-comments-${Math.random().toString(36).slice(2)}`;

  const header = document.createElement("div");
  header.className = "wm-tiptap-comments__header";
  const headerText = document.createElement("div");
  headerText.className = "wm-tiptap-comments__header-text";
  const title = document.createElement("h3");
  title.textContent = "Comments";
  const count = document.createElement("span");
  count.className = "wm-tiptap-comments__count";
  count.textContent = String(threads.length);
  headerText.append(title, count);
  const panelToggle = createDisclosureButton({
    text: threads.length > 0 ? "Show comments" : "Add comment",
    expanded: false,
    controls: bodyId,
  });
  header.append(headerText, panelToggle);
  panel.append(header);

  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "wm-tiptap-comments__body";
  body.hidden = true;
  panel.append(body);

  const newToggle = createDisclosureButton({ text: "Comment on selection" });
  newToggle.classList.add("wm-tiptap-comments__new-toggle");
  body.append(newToggle);

  const form = document.createElement("form");
  form.className = "wm-tiptap-comments__new";
  form.hidden = true;
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = "Comment on selection";
  textarea.setAttribute("aria-label", "New comment body");
  textarea.dataset.testid = "tiptap-new-comment-input";
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "wm-button";
  button.textContent = "Add comment";
  button.dataset.testid = "tiptap-add-comment-button";
  form.append(textarea, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onAddThread?.(textarea.value);
  });
  newToggle.addEventListener("click", () => {
    const isOpen = newToggle.getAttribute("aria-expanded") === "true";
    newToggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
    form.hidden = isOpen;
  });
  body.append(form);

  const list = document.createElement("div");
  list.className = "wm-tiptap-comments__list";
  if (threads.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-tiptap-comments__empty";
    empty.textContent = "No comments";
    list.append(empty);
  } else {
    for (const thread of threads) {
      list.append(renderThread(thread, { onAddReply, onSetStatus }));
    }
  }
  body.append(list);

  panelToggle.addEventListener("click", () => {
    const isOpen = panelToggle.getAttribute("aria-expanded") === "true";
    panelToggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
    body.hidden = isOpen;
    panelToggle.textContent = isOpen
      ? (threads.length > 0 ? "Show comments" : "Add comment")
      : "Hide comments";
  });

  return panel;
}
