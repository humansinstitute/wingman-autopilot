function getSessionWorkingDirectory(sessionsStore, sessionId) {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  return session?.workingDirectory ?? null;
}

async function executeGitHubAction({ sessionsStore, sessionId, showToast, action, options = {} }) {
  const directory = getSessionWorkingDirectory(sessionsStore, sessionId);
  if (!directory) {
    showToast('No working directory set for this session', { type: 'error' });
    return null;
  }

  try {
    const response = await fetch('/api/docs/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory,
        action,
        remote: 'origin',
        expectedRemoteHost: 'github.com',
        ...options,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(`GitHub ${action} failed: ${data.error || 'Unknown error'}`, { type: 'error', duration: 5000 });
      return null;
    }
    showToast(`GitHub ${action} successful`, { type: 'success' });
    if (data.stdout) {
      console.log(`GitHub ${action} output:`, data.stdout);
    }
    return data;
  } catch (error) {
    showToast(`GitHub ${action} failed: ${error.message}`, { type: 'error' });
    return null;
  }
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

async function promptWorktreeFork({ sessionId, sessionsStore, openTextPromptDialog, showToast, forkSessionToWorktreeApi }) {
  const directory = getSessionWorkingDirectory(sessionsStore, sessionId);
  if (!directory) {
    showToast('No working directory set for this session', { type: 'error' });
    return;
  }

  const trimmedBranch = await openTextPromptDialog({
    title: 'Fork To Worktree',
    description: 'Create a new worktree and session with the last 5 messages as context.',
    label: 'Branch name',
    value: '',
    confirmLabel: 'Create',
    testId: 'live-view-worktree-branch-dialog',
    validate: (value) => (value ? '' : 'Branch name is required.'),
  });
  if (!trimmedBranch) {
    return;
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch)) {
    showToast('Invalid branch name. Use alphanumeric characters, dots, underscores, and hyphens.', { type: 'error' });
    return;
  }

  showToast(`Creating worktree "${trimmedBranch}"...`, { type: 'info' });

  try {
    const result = await forkSessionToWorktreeApi(sessionId, trimmedBranch, 5);
    if (result.session?.id) {
      if (result.initialPrompt) {
        try {
          localStorage.setItem(`session-draft-${result.session.id}`, result.initialPrompt);
          localStorage.setItem(`session-autosubmit-${result.session.id}`, 'true');
        } catch {
          // Ignore localStorage errors.
        }
      }

      window.open(`/live/${result.session.id}`, '_blank', 'noopener');
      showToast(`Forked to worktree: ${result.worktreePath}`, { type: 'success', duration: 5000 });
    }
  } catch (error) {
    showToast(`Fork failed: ${error.message}`, { type: 'error', duration: 5000 });
  }
}

export function addGitCommandSubmenus({
  addSubmenu,
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  addSubmenu('GitHub', [
    {
      label: 'Pull',
      handler: () => executeGitHubAction({ sessionsStore, sessionId, showToast, action: 'pull' }),
    },
    {
      label: 'Push',
      handler: () => executeGitHubAction({ sessionsStore, sessionId, showToast, action: 'push' }),
    },
    {
      label: 'Commit...',
      handler: async () => {
        const message = await openTextPromptDialog({
          title: 'GitHub Commit',
          description: 'Enter the commit message to use for all staged changes before pushing to GitHub.',
          label: 'Commit message',
          value: '',
          confirmLabel: 'Commit',
          testId: 'live-view-github-commit-dialog',
          validate: (value) => (value ? '' : 'Commit message is required.'),
        });
        if (!message) {
          return;
        }
        const addResult = await executeGitHubAction({ sessionsStore, sessionId, showToast, action: 'addAll' });
        if (addResult) {
          await executeGitHubAction({
            sessionsStore,
            sessionId,
            showToast,
            action: 'commit',
            options: { message },
          });
        }
      },
    },
    {
      label: 'Fork to Worktree...',
      handler: () => promptWorktreeFork({
        sessionId,
        sessionsStore,
        openTextPromptDialog,
        showToast,
        forkSessionToWorktreeApi,
      }),
    },
  ]);

  addSubmenu('Gitea', [
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
  ]);
}
