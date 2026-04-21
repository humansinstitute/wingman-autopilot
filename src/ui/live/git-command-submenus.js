import { executeGitAction, executeGitHubAction, parseGitRemoteList } from './git-command-api.js';
import { openGitOutputDialog, openGitRemoteDialog } from './git-dialogs.js';

function isValidBranchName(branch) {
  return /^[a-zA-Z0-9._/-]+$/.test(branch);
}

function isGitHubHttpsRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

async function showGitStatus({ sessionsStore, sessionId, showToast }) {
  const result = await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'status',
    showSuccessToast: false,
  });
  if (!result) {
    return;
  }

  await openGitOutputDialog({
    title: 'Git Status',
    description: 'Current branch and working tree state for this session directory.',
    output: result.stdout,
    testId: 'live-view-git-status-dialog',
  });
}

async function promptGitHubRemote({
  sessionsStore,
  sessionId,
  showToast,
}) {
  const listResult = await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'listRemotes',
    showSuccessToast: false,
    errorLabel: 'Git remote lookup',
  });
  if (!listResult) {
    return;
  }

  const remoteInput = await openGitRemoteDialog({
    remotes: parseGitRemoteList(listResult.stdout),
    initialRemoteName: 'origin',
    title: 'GitHub Remote',
    description: 'Set the GitHub HTTPS remote used by PAT-authenticated pull and push actions.',
    confirmLabel: 'Save GitHub Remote',
    testId: 'live-view-github-remote-dialog',
  });
  if (!remoteInput) {
    return;
  }

  if (!isGitHubHttpsRemoteUrl(remoteInput.url)) {
    showToast('GitHub remote must use an HTTPS github.com URL so the personal access token helper can authenticate push and pull.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'setRemote',
    options: {
      remote: remoteInput.remote,
      remoteUrl: remoteInput.url,
    },
    successMessage: `GitHub remote "${remoteInput.remote}" saved`,
    errorLabel: `GitHub remote "${remoteInput.remote}"`,
  });
}

async function promptSwitchBranch({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
}) {
  const branch = await openTextPromptDialog({
    title: 'Switch Git Branch',
    description: 'Enter the branch name to switch this directory to.',
    label: 'Branch name',
    value: '',
    confirmLabel: 'Switch',
    testId: 'live-view-git-branch-dialog',
    validate: (value) => {
      if (!value) {
        return 'Branch name is required.';
      }
      return isValidBranchName(value)
        ? ''
        : 'Invalid branch name. Use alphanumeric characters, dots, underscores, slashes, and hyphens.';
    },
  });
  if (!branch) {
    return;
  }

  await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'switchBranch',
    options: { branch },
    successMessage: `Switched to branch "${branch}"`,
    errorLabel: `Git switch branch "${branch}"`,
  });
}

async function promptGitHubCommit({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
}) {
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

  const addResult = await executeGitHubAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'addAll',
  });
  if (!addResult) {
    return;
  }

  await executeGitHubAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'commit',
    options: { message },
  });
}

async function promptWorktreeFork({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  const directory = session?.workingDirectory ?? null;
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
  if (!isValidBranchName(trimmedBranch)) {
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

function createGitMenuItems({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
}) {
  return [
    {
      label: 'Status',
      handler: () => showGitStatus({ sessionsStore, sessionId, showToast }),
    },
    {
      label: 'Switch Branch...',
      handler: () => promptSwitchBranch({ sessionId, sessionsStore, openTextPromptDialog, showToast }),
    },
    {
      label: 'Init',
      handler: () => executeGitAction({ sessionsStore, sessionId, showToast, action: 'init' }),
    },
    {
      label: 'Add All',
      handler: () => executeGitAction({
        sessionsStore,
        sessionId,
        showToast,
        action: 'addAll',
        successMessage: 'Git add all successful',
      }),
    },
  ];
}

function createGitHubMenuItems({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  return [
    {
      label: 'Remote...',
      handler: () => promptGitHubRemote({ sessionsStore, sessionId, showToast }),
    },
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
      handler: () => promptGitHubCommit({ sessionId, sessionsStore, openTextPromptDialog, showToast }),
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
  ];
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

function createGiteaMenuItems({
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
        const session = sessionsStore().items.find((item) => item.id === sessionId);
        const directory = session?.workingDirectory ?? null;
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

export function addGitCommandSubmenus({
  addSubmenu,
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  addSubmenu('Git', createGitMenuItems({
    sessionId,
    sessionsStore,
    openTextPromptDialog,
    showToast,
  }));

  addSubmenu('GitHub', createGitHubMenuItems({
    sessionId,
    sessionsStore,
    openTextPromptDialog,
    showToast,
    forkSessionToWorktreeApi,
  }));

  addSubmenu('Gitea', createGiteaMenuItems({
    sessionId,
    sessionsStore,
    openTextPromptDialog,
    showToast,
  }));
}
