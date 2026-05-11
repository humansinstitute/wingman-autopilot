import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

import { bootstrapAgentWorkspace } from './agent-workspace-bootstrap';

async function makeTempWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'wingman-agent-workspace-'));
}

describe('bootstrapAgentWorkspace', () => {
  test('creates a generic local agent workspace from templates', async () => {
    const dir = await makeTempWorkspace();
    try {
      const result = await bootstrapAgentWorkspace({
        agentId: 'lara',
        label: 'Lara',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        workingDirectory: dir,
        createdAt: '2026-05-11T00:00:00.000Z',
      });

      expect(result.createdFiles).toContain('AGENTS.md');
      expect(result.createdFiles).toContain('CLAUDE.md');
      expect(result.createdFiles).toContain('mycode/README.md');
      expect(existsSync(join(dir, 'mynotes'))).toBe(true);
      expect(existsSync(join(dir, 'myskills'))).toBe(true);
      expect(existsSync(join(dir, 'mystrategies'))).toBe(true);

      const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('You are Lara');
      expect(agents).toContain('Agent ID: `lara`');
      expect(agents).toContain('Bot npub: `npub1bot`');
      expect(agents).not.toContain('{{AGENT_ID}}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not overwrite existing operator-owned files', async () => {
    const dir = await makeTempWorkspace();
    try {
      await writeFile(join(dir, 'AGENTS.md'), 'custom instructions\n');
      const result = await bootstrapAgentWorkspace({
        agentId: 'lara',
        label: 'Lara',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        workingDirectory: dir,
      });

      expect(result.skippedFiles).toContain('AGENTS.md');
      expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('custom instructions\n');
      expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
