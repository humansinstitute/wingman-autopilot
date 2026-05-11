import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';

import { bootstrapAgentWorkspace } from './agent-workspace-bootstrap';

async function makeTempWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'wingman-agent-workspace-'));
}

const originalHome = Bun.env.HOME;
const originalCodexHome = Bun.env.CODEX_HOME;
const originalCodexTrustedWorkspace = Bun.env.CODEX_TRUSTED_WORKSPACE;

afterEach(() => {
  if (originalHome === undefined) {
    delete Bun.env.HOME;
  } else {
    Bun.env.HOME = originalHome;
  }
  if (originalCodexHome === undefined) {
    delete Bun.env.CODEX_HOME;
  } else {
    Bun.env.CODEX_HOME = originalCodexHome;
  }
  if (originalCodexTrustedWorkspace === undefined) {
    delete Bun.env.CODEX_TRUSTED_WORKSPACE;
  } else {
    Bun.env.CODEX_TRUSTED_WORKSPACE = originalCodexTrustedWorkspace;
  }
});

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

  test('marks generated workspaces trusted for Codex when under the trusted root', async () => {
    const root = await makeTempWorkspace();
    const home = await makeTempWorkspace();
    const codexHome = join(home, '.codex');
    try {
      Bun.env.HOME = home;
      Bun.env.CODEX_HOME = codexHome;
      Bun.env.CODEX_TRUSTED_WORKSPACE = root;
      await bootstrapAgentWorkspace({
        agentId: 'lara',
        label: 'Lara',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        workingDirectory: join(root, 'lara'),
      });

      const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
      expect(config).toContain(`[projects."${join(root, 'lara')}"]`);
      expect(config).toContain('trust_level = "trusted"');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
