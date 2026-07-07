function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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

  const replyForm = document.createElement("form");
  replyForm.className = "wm-tiptap-comments__reply";
  const replyInput = document.createElement("textarea");
  replyInput.rows = 2;
  replyInput.placeholder = "Reply";
  replyInput.setAttribute("aria-label", "Reply to comment thread");
  const replyButton = document.createElement("button");
  replyButton.type = "submit";
  replyButton.className = "wm-button secondary";
  replyButton.textContent = "Reply";
  replyForm.append(replyInput, replyButton);
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

  const header = document.createElement("div");
  header.className = "wm-tiptap-comments__header";
  const title = document.createElement("h3");
  title.textContent = "Comments";
  const count = document.createElement("span");
  count.className = "wm-tiptap-comments__count";
  count.textContent = String(threads.length);
  header.append(title, count);
  panel.append(header);

  const form = document.createElement("form");
  form.className = "wm-tiptap-comments__new";
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
  panel.append(form);

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
  panel.append(list);

  return panel;
}
