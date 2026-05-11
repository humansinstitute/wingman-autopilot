import { constants, existsSync } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentDefinitionRecord } from './types';

const TEMPLATE_ROOT = new URL('../../templates/agent-workspace', import.meta.url).pathname;
const TEMPLATE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'goals.md',
  'personality.md',
  'mycode/README.md',
  'mynotes/.gitkeep',
  'myskills/.gitkeep',
  'mystrategies/.gitkeep',
];

interface AgentWorkspaceBootstrapInput {
  agentId: string;
  label: string;
  botNpub: string;
  workspaceOwnerNpub: string;
  workingDirectory: string;
  createdAt?: string;
}

export interface AgentWorkspaceBootstrapResult {
  workingDirectory: string;
  createdFiles: string[];
  skippedFiles: string[];
}

function templateValues(input: AgentWorkspaceBootstrapInput): Record<string, string> {
  return {
    AGENT_ID: input.agentId,
    AGENT_LABEL: input.label || input.agentId,
    BOT_NPUB: input.botNpub || 'not configured',
    WORKSPACE_OWNER_NPUB: input.workspaceOwnerNpub || 'not configured',
    CREATED_AT: input.createdAt ?? new Date().toISOString(),
  };
}

function renderTemplate(contents: string, values: Record<string, string>): string {
  return contents.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(path: string, contents: string): Promise<boolean> {
  try {
    await writeFile(path, contents, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

export async function bootstrapAgentWorkspace(
  input: AgentWorkspaceBootstrapInput,
): Promise<AgentWorkspaceBootstrapResult> {
  const workingDirectory = input.workingDirectory.trim();
  if (!workingDirectory) {
    throw new Error('Agent working directory is required.');
  }
  if (!existsSync(TEMPLATE_ROOT)) {
    throw new Error(`Agent workspace template is missing: ${TEMPLATE_ROOT}`);
  }

  await mkdir(workingDirectory, { recursive: true });
  const values = templateValues(input);
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const relativePath of TEMPLATE_FILES) {
    const sourcePath = join(TEMPLATE_ROOT, relativePath);
    const targetPath = join(workingDirectory, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    const source = await readFile(sourcePath, 'utf8');
    const wrote = await writeIfMissing(targetPath, renderTemplate(source, values));
    if (wrote) {
      createdFiles.push(relativePath);
      if (await canExecute(sourcePath)) {
        await chmod(targetPath, 0o755);
      }
    } else {
      skippedFiles.push(relativePath);
    }
  }

  return {
    workingDirectory,
    createdFiles,
    skippedFiles,
  };
}

export async function bootstrapAgentDefinitionWorkspace(
  agent: AgentDefinitionRecord | null,
  createdAt?: string,
): Promise<AgentWorkspaceBootstrapResult | null> {
  if (!agent?.workingDirectory?.trim()) {
    return null;
  }
  return await bootstrapAgentWorkspace({
    agentId: agent.agentId,
    label: agent.label,
    botNpub: agent.botNpub,
    workspaceOwnerNpub: agent.workspaceOwnerNpub,
    workingDirectory: agent.workingDirectory,
    createdAt,
  });
}
