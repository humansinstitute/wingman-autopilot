import { describe, expect, test } from 'bun:test';

import type { AgentAdapter } from '../agents/agent-adapter';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { sendPromptAndAwaitAssistantReply, sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';

class FakeAdapter implements AgentAdapter {
  private sent = false;
  private readonly assistantContent: string;

  constructor(content: string, private readonly replyRole = 'assistant') {
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
        role: this.replyRole,
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
  test('accepts the canonical agent role returned by the sessions API', async () => {
    const session: SessionSnapshot = {
      id: 'session-agent-role', agent: 'codex', port: 0, name: 'Agent Chat', status: 'running',
      agentRuntimeStatus: 'stable', startedAt: new Date().toISOString(), command: [], workingDirectory: '/tmp', logs: [],
    };
    const reply = await sendPromptAndAwaitAssistantReply(
      buildManager(session, new FakeAdapter('Done', 'agent')),
      session.id,
      'prompt',
      { timeoutMs: 250, pollIntervalMs: 10, stablePolls: 1 },
    );
    expect(reply.content).toBe('Done');
  });

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

describe('sendPromptAndAwaitFinalResponse', () => {
  function finalManager(messages: Array<{ role: string; content: string; createdAt: string }>, status: 'running' | 'stable' = 'stable') {
    const session = { id: 'direct-session', agent: 'codex', port: 0, name: 'Direct', status: 'running',
      agentRuntimeStatus: status, startedAt: new Date().toISOString(), command: [], workingDirectory: '/tmp', logs: [] } as SessionSnapshot;
    let sent = false;
    const adapter = {
      waitForReady: async () => {}, sendMessage: async () => { sent = true; },
      fetchMessages: async () => sent ? messages : [], fetchStatus: async () => status,
      interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
    } as AgentAdapter;
    return { session, manager: buildManager(session, adapter) };
  }

  test('publishes the final markdown card verbatim and excludes working progress', async () => {
    const markdown = '## Result\n\n- one\n- **two**\n';
    const { session, manager } = finalManager([
      { role: 'agent-working', content: 'Thinking and running tools', createdAt: '2026-01-01T00:00:01Z' },
      { role: 'agent', content: markdown, createdAt: '2026-01-01T00:00:02Z' },
    ]);
    const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, 'prompt', { timeoutMs: 100, pollIntervalMs: 10 });
    expect(reply.content).toBe(markdown);
  });

  test('accepts assistant as the other canonical final role', async () => {
    const { session, manager } = finalManager([{ role: 'assistant', content: 'Done', createdAt: '2026-01-01T00:00:01Z' }]);
    expect((await sendPromptAndAwaitFinalResponse(manager, session.id, 'prompt', { timeoutMs: 100, pollIntervalMs: 10 })).content).toBe('Done');
  });

  test('times out when a completed turn exposes progress but no final card', async () => {
    const { session, manager } = finalManager([{ role: 'agent-working', content: 'Only progress', createdAt: '2026-01-01T00:00:01Z' }]);
    await expect(sendPromptAndAwaitFinalResponse(manager, session.id, 'prompt', { timeoutMs: 30, pollIntervalMs: 10 })).rejects.toThrow('final response');
  });
});
