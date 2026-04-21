#!/usr/bin/env bun

import {
  buildInitSummary,
  createBoardClient,
  describeBoardContract,
  loadRepoBoardConfig,
  saveRepoBoardConfig,
  type RepoBoardConfig,
} from '../src/board/yoke-board';

function usage(): never {
  console.log(`Wingman board/bootstrap CLI

Usage:
  bun clis/wingman.ts init --workspace-owner <npub> --backend-url <url> --source-app <npub> [--repo <path>] [--state-dir <path>]
  bun clis/wingman.ts board sync
  bun clis/wingman.ts board status
  bun clis/wingman.ts board task show <task-id>
  bun clis/wingman.ts board task patch <task-id> [--state <state>] [--description <text>] [--tags <csv>]
  bun clis/wingman.ts board task comment <task-id> --body <text>
  bun clis/wingman.ts board task create --title <title> [--description <text>] [--state <state>] [--assign <npub>] [--parent <task-id>] [--flow-id <flow-id>] [--flow-run-id <flow-run-id>] [--flow-step <n>] [--predecessor <task-id> ...]
  bun clis/wingman.ts board flow show <flow-id>
  bun clis/wingman.ts board approval show <approval-id>
  bun clis/wingman.ts board approval create --title <title> [--flow-id <flow-id>] [--flow-run-id <flow-run-id>] [--flow-step <n>] [--task-ids <task-id> ...] [--brief <text>] [--approval-mode <manual|agent>]
  bun clis/wingman.ts board doc show <doc-id>
  bun clis/wingman.ts board scope list
  bun clis/wingman.ts board scope show <scope-id>
  bun clis/wingman.ts board chat context [--channel <channel-id>] [--thread <message-id>] [--message <message-id>] [--limit <n>]
  bun clis/wingman.ts board flow-dispatch <task-id>
  bun clis/wingman.ts board task-review <task-id>
  bun clis/wingman.ts board approval-dispatch <approval-id>
`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function flagValues(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index < 0) {
    return [];
  }
  const values: string[] = [];
  for (let i = index + 1; i < args.length; i += 1) {
    if (args[i]?.startsWith('--')) {
      break;
    }
    values.push(args[i] ?? '');
  }
  return values.filter(Boolean);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    usage();
  }

  if (command === 'init') {
    const repoRoot = flagValue(args, '--repo') || process.cwd();
    const config = saveRepoBoardConfig(repoRoot, {
      backendBaseUrl: flagValue(args, '--backend-url') || '',
      workspaceOwnerNpub: flagValue(args, '--workspace-owner') || '',
      sourceAppNpub: flagValue(args, '--source-app') || '',
      stateDir: flagValue(args, '--state-dir'),
    } satisfies RepoBoardConfig);
    if (!config.backendBaseUrl || !config.workspaceOwnerNpub || !config.sourceAppNpub) {
      throw new Error('init requires --workspace-owner, --backend-url, and --source-app');
    }
    const client = createBoardClient(repoRoot);
    await client.initialise();
    console.log(buildInitSummary(loadRepoBoardConfig(repoRoot)));
    return;
  }

  if (command !== 'board') {
    usage();
  }

  const client = createBoardClient(process.cwd());
  const subcommand = args[1];
  if (!subcommand) {
    usage();
  }

  if (subcommand === 'sync') {
    console.log(JSON.stringify(await client.sync(), null, 2));
    return;
  }
  if (subcommand === 'status') {
    console.log(JSON.stringify(await client.status(), null, 2));
    return;
  }
  if (subcommand === 'flow-dispatch') {
    const taskId = args[2];
    if (!taskId) usage();
    console.log(JSON.stringify(await client.runFlowDispatch(taskId), null, 2));
    return;
  }
  if (subcommand === 'task-review') {
    const taskId = args[2];
    if (!taskId) usage();
    console.log(JSON.stringify(await client.runTaskReview(taskId), null, 2));
    return;
  }
  if (subcommand === 'approval-dispatch') {
    const approvalId = args[2];
    if (!approvalId) usage();
    console.log(JSON.stringify(await client.runApprovalDispatch(approvalId), null, 2));
    return;
  }
  if (subcommand === 'contract') {
    console.log(describeBoardContract(loadRepoBoardConfig(process.cwd())));
    return;
  }

  const family = args[2];
  if (subcommand === 'task') {
    if (family === 'show') {
      console.log(JSON.stringify(await client.getTask(args[3] || ''), null, 2));
      return;
    }
    if (family === 'patch') {
      const taskId = args[3];
      if (!taskId) usage();
      console.log(JSON.stringify(await client.updateTask(taskId, {
        state: flagValue(args, '--state'),
        description: flagValue(args, '--description') ?? undefined,
        tags: flagValue(args, '--tags')?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? undefined,
      }), null, 2));
      return;
    }
    if (family === 'comment') {
      const taskId = args[3];
      const body = flagValue(args, '--body');
      if (!taskId || !body) usage();
      await client.commentTask(taskId, body);
      console.log(JSON.stringify({ ok: true }, null, 2));
      return;
    }
    if (family === 'create') {
      const title = flagValue(args, '--title');
      if (!title) usage();
      console.log(JSON.stringify(await client.createTask({
        title,
        description: flagValue(args, '--description') || '',
        state: flagValue(args, '--state') || 'new',
        assignedTo: flagValue(args, '--assign'),
        parentTaskId: flagValue(args, '--parent'),
        predecessorTaskIds: flagValues(args, '--predecessor'),
        flowId: flagValue(args, '--flow-id'),
        flowRunId: flagValue(args, '--flow-run-id'),
        flowStep: flagValue(args, '--flow-step') ? Number(flagValue(args, '--flow-step')) : null,
        scopeId: flagValue(args, '--scope'),
        tags: flagValue(args, '--tags')?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [],
      }), null, 2));
      return;
    }
  }

  if (subcommand === 'flow' && family === 'show') {
    console.log(JSON.stringify(await client.getFlow(args[3] || ''), null, 2));
    return;
  }

  if (subcommand === 'approval') {
    if (family === 'show') {
      console.log(JSON.stringify(await client.getApproval(args[3] || ''), null, 2));
      return;
    }
    if (family === 'create') {
      const title = flagValue(args, '--title');
      if (!title) usage();
      console.log(JSON.stringify(await client.createApproval({
        title,
        flowId: flagValue(args, '--flow-id'),
        flowRunId: flagValue(args, '--flow-run-id'),
        flowStep: flagValue(args, '--flow-step') ? Number(flagValue(args, '--flow-step')) : null,
        taskIds: flagValues(args, '--task-ids'),
        brief: flagValue(args, '--brief') || '',
        approvalMode: hasFlag(args, '--approval-mode') && flagValue(args, '--approval-mode') === 'agent' ? 'agent' : 'manual',
      }), null, 2));
      return;
    }
  }

  if (subcommand === 'doc' && family === 'show') {
    console.log(JSON.stringify(await client.getDocument(args[3] || ''), null, 2));
    return;
  }

  if (subcommand === 'scope') {
    if (family === 'list') {
      console.log(JSON.stringify(await client.listScopes(), null, 2));
      return;
    }
    if (family === 'show') {
      console.log(JSON.stringify(await client.getScope(args[3] || ''), null, 2));
      return;
    }
  }

  if (subcommand === 'chat' && family === 'context') {
    console.log(JSON.stringify(await client.getChatContext({
      channelId: flagValue(args, '--channel') || undefined,
      threadId: flagValue(args, '--thread') || undefined,
      messageId: flagValue(args, '--message') || undefined,
      limit: flagValue(args, '--limit') ? Number(flagValue(args, '--limit')) : undefined,
    }), null, 2));
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
