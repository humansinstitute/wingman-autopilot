function getSessionWorkingDirectory(sessionsStore, sessionId) {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  return session?.workingDirectory ?? null;
}

async function executeGiteaAction({ sessionId, showToast, action, options = {} }) {
  try {
    const response = await fetch(`/api/gitea/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...options }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(`Gitea ${action} failed: ${data.error || 'Unknown error'}`, { type: 'error', duration: 5000 });
      return null;
    }
    showToast(`Gitea ${action} successful`, { type: 'success' });
    if (data.stdout) {
      console.log(`Gitea ${action} output:`, data.stdout);
    }
    return data;
  } catch (error) {
    showToast(`Gitea ${action} failed: ${error.message}`, { type: 'error' });
    return null;
  }
}

export function createGiteaMenuItems({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
}) {
  return [
    {
      label: 'Go to repo',
      handler: async () => {
        try {
          const response = await fetch(`/api/gitea/remote-url?sessionId=${sessionId}`);
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.configured) {
            showToast(data.error || 'No Gitea remote configured — run Setup first', { type: 'warning', duration: 4000 });
            return;
          }
          window.open(data.webUrl, '_blank', 'noopener');
        } catch (error) {
          showToast(`Failed to get repo URL: ${error.message}`, { type: 'error' });
        }
      },
    },
    {
      label: 'Setup',
      handler: async () => {
        const directory = getSessionWorkingDirectory(sessionsStore, sessionId);
        const dirName = directory ? directory.split('/').pop() || '' : '';
        const projectName = await openTextPromptDialog({
          title: 'Gitea Project Name',
          description: 'Choose the project name to use when creating the remote repository.',
          label: 'Project name',
          value: dirName,
          confirmLabel: 'Setup',
          testId: 'live-view-gitea-project-dialog',
        });
        if (projectName === null) {
          return;
        }
        showToast('Setting up Gitea repo...', { type: 'info' });
        const data = await executeGiteaAction({
          sessionId,
          showToast,
          action: 'set-remote',
          options: { projectName: projectName || undefined },
        });
        if (data?.cloneUrl) {
          showToast(`Gitea repo ready: ${data.cloneUrl}`, { type: 'success', duration: 5000 });
        }
      },
    },
    {
      label: 'Push',
      handler: () => executeGiteaAction({ sessionId, showToast, action: 'push' }),
    },
    {
      label: 'Pull',
      handler: () => executeGiteaAction({ sessionId, showToast, action: 'pull' }),
    },
    {
      label: 'Commit and Push All',
      handler: async () => {
        const message = await openTextPromptDialog({
          title: 'Commit And Push',
          description: 'Enter the commit message to use before pushing all changes.',
          label: 'Commit message',
          value: 'updates',
          confirmLabel: 'Commit And Push',
          testId: 'live-view-gitea-commit-dialog',
        });
        if (message === null) {
          return;
        }
        await executeGiteaAction({
          sessionId,
          showToast,
          action: 'commit-and-push',
          options: { message: message || 'updates' },
        });
      },
    },
  ];
}
