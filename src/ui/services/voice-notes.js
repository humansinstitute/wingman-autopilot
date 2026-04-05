/**
 * Voice note upload API client.
 */

export async function uploadVoiceNoteApi({ sessionId, agent, file, signal }) {
  const form = new FormData();
  form.append("agent", agent);
  form.append("sessionId", sessionId);
  form.append("audio", file, file.name);

  const response = await fetch("/api/uploads/voice-notes", {
    method: "POST",
    body: form,
    signal,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data?.error === "string" && data.error.length > 0
        ? data.error
        : response.statusText || "Voice note upload failed";
    const error = new Error(message);
    error.status = response.status;
    if (typeof data?.publicPath === "string") {
      error.publicPath = data.publicPath;
    }
    throw error;
  }

  return data ?? {};
}
