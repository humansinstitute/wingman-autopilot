function readMessageField(message, ...keys) {
  for (const key of keys) {
    const value = message?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

export function areConversationMessagesEqual(previousMessages, nextMessages) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];

  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const current = previous[index] ?? {};
    const incoming = next[index] ?? {};

    if (
      readMessageField(current, "id") !== readMessageField(incoming, "id") ||
      readMessageField(current, "role", "type") !== readMessageField(incoming, "role", "type") ||
      readMessageField(current, "content", "message") !== readMessageField(incoming, "content", "message") ||
      readMessageField(current, "createdAt", "created_at") !== readMessageField(incoming, "createdAt", "created_at")
    ) {
      return false;
    }
  }

  return true;
}
