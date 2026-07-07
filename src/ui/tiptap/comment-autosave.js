export function createCommentAutosave({
  delayMs = 5000,
  canSave,
  save,
  onSuccess,
  onError,
} = {}) {
  let timer = null;

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function queue() {
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (canSave?.() === false) return;
      void Promise.resolve(save?.())
        .then(() => onSuccess?.())
        .catch((error) => onError?.(error));
    }, delayMs);
  }

  return { queue, clear };
}
