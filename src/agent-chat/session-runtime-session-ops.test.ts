import { describe, expect, test } from 'bun:test';

import type { AgentAdapter } from '../agents/agent-adapter';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { sendPromptAndAwaitAssistantReply } from './session-runtime-session-ops';

class FakeAdapter implements AgentAdapter {
  private sent = false;
  private readonly assistantContent: string;

  constructor(content: string) {
    this.assistantContent = content;
  }

  async fetchStatus() {
    return 'running' as const;
  }

  async sendMessage() {
    this.sent = true;
  }

  async fetchMessages() {
    if (!this.sent) {
      return [];
    }
    return [
      {
        role: 'assistant',
        content: this.assistantContent,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  async interruptCurrentTurn() {
    return false;
  }

  getEventsUrl() {
    return null;
  }

  async waitForReady() {}

  async dispose() {}
}

function buildManager(session: SessionSnapshot, adapter: AgentAdapter): ProcessManager {
  return {
    getSession: () => session,
    getAdapter: () => adapter,
  } as unknown as ProcessManager;
}

describe('sendPromptAndAwaitAssistantReply', () => {
  test('settles a stable parseable decision even when runtime status stays running', async () => {
    const session: SessionSnapshot = {
      id: 'session-1',
      agent: 'codex',
      port: 0,
      name: 'Agent Chat',
      status: 'running',
      agentRuntimeStatus: 'running',
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: '/tmp',
      logs: [],
    };
    const manager = buildManager(session, new FakeAdapter('AGENT_CHAT_DECISION: ignore'));

    const reply = await sendPromptAndAwaitAssistantReply(manager, session.id, 'prompt', {
      timeoutMs: 250,
      pollIntervalMs: 10,
      stablePolls: 2,
      decisionFallbackStablePolls: 3,
    });

    expect(reply.content).toBe('AGENT_CHAT_DECISION: ignore');
    expect(reply.settledWithoutStableRuntime).toBe(true);
  });

  test('returns the settled decision even if the session stops after the assistant reply lands', async () => {
    let pollCount = 0;
    let sent = false;
    const session: SessionSnapshot = {
      id: 'session-2',
      agent: 'codex',
      port: 0,
      name: 'Agent Chat',
      status: 'running',
      agentRuntimeStatus: 'running',
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: '/tmp',
      logs: [],
    };
    const adapter: AgentAdapter = {
      async fetchStatus() {
        return 'running';
      },
      async sendMessage() {
        sent = true;
      },
      async fetchMessages() {
        if (!sent) {
          return [];
        }
        pollCount += 1;
        if (pollCount >= 4) {
          session.status = 'stopped';
        }
        return [
          {
            role: 'assistant',
            content: 'AGENT_CHAT_DECISION: ignore',
            createdAt: new Date().toISOString(),
          },
        ];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };

    const reply = await sendPromptAndAwaitAssistantReply(buildManager(session, adapter), session.id, 'prompt', {
      timeoutMs: 250,
      pollIntervalMs: 10,
      stablePolls: 2,
      decisionFallbackStablePolls: 3,
    });

    expect(reply.content).toBe('AGENT_CHAT_DECISION: ignore');
  });

  test('treats a trailing decision line inside Codex transcript output as parseable', async () => {
    const session: SessionSnapshot = {
      id: 'session-3',
      agent: 'codex',
      port: 0,
      name: 'Agent Chat',
      status: 'running',
      agentRuntimeStatus: 'running',
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: '/tmp',
      logs: [],
    };
    const transcriptReply = [
      'Ran bun mycode/yoke.js chat reply-current --body "done"',
      '{"status":"sent"}',
      '',
      '• AGENT_CHAT_DECISION: respond',
    ].join('\n');
    const manager = buildManager(session, new FakeAdapter(transcriptReply));

    const reply = await sendPromptAndAwaitAssistantReply(manager, session.id, 'prompt', {
      timeoutMs: 250,
      pollIntervalMs: 10,
      stablePolls: 2,
      decisionFallbackStablePolls: 3,
    });

    expect(reply.content).toBe(transcriptReply);
    expect(reply.settledWithoutStableRuntime).toBe(true);
  });
});
