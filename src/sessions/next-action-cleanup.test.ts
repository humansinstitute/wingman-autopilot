import { describe, expect, test } from 'bun:test';
import { isDirectChatSessionProtected } from '../agent-chat/direct-chat-lifecycle';
import { cleanupStopNextActionSessions } from './next-action-cleanup';

function session(id: string) {
  return { id, agent: 'codex', name: id, metadata: { nextAction: 'stop' } } as any;
}

describe('next-action cleanup', () => {
  test('does not stop a Flight Deck session with active, pending, or accepted work', async () => {
    for (const state of ['active', 'pending', 'idle'] as const) {
      const stopped: string[] = [];
      const intercept = { routingKey: `route-${state}`, sessionId: `chat-${state}`, state,
        pendingMessageCount: state === 'pending' ? 2 : 0 } as any;
      const turn = state === 'idle' ? { state: 'accepted' } : null;
      const result = await cleanupStopNextActionSessions({ manager: { listSessions: () => [session(`chat-${state}`)],
        stopSession: async (id: string) => { stopped.push(id); } } as any, scheduleArchive: () => {},
        isSessionProtected: (id) => isDirectChatSessionProtected(id, { listAll: () => [intercept] } as any,
          { getPending: () => turn } as any) });
      expect(result.matched).toBe(0); expect(stopped).toEqual([]);
    }
  });

  test('still stops and archives a genuinely terminal eligible session', async () => {
    const stopped: string[] = []; const archived: string[] = [];
    const result = await cleanupStopNextActionSessions({ manager: { listSessions: () => [session('terminal-worker')],
      stopSession: async (id: string) => { stopped.push(id); } } as any, scheduleArchive: (id) => archived.push(id),
      isSessionProtected: () => false });
    expect(result.matched).toBe(1); expect(result.stopped).toBe(1);
    expect(stopped).toEqual(['terminal-worker']); expect(archived).toEqual(['terminal-worker']);
  });
});
