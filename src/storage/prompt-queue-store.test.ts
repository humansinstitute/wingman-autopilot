import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { PromptQueueStore } from './prompt-queue-store';

function makeTempDb(): string {
  return join(tmpdir(), `prompt-queue-store-${randomUUID()}.sqlite`);
}

describe('PromptQueueStore', () => {
  test('detects queued prompts by exact content within a session', () => {
    const store = new PromptQueueStore(makeTempDb());

    store.addPrompt('session-1', { content: 'Agent work dispatch.\nTask id: task-1' });
    store.addPrompt('session-2', { content: 'Agent work dispatch.\nTask id: task-1' });

    expect(store.hasQueuedPrompt('session-1', 'Agent work dispatch.\nTask id: task-1')).toBe(true);
    expect(store.hasQueuedPrompt('session-1', 'Agent work dispatch.\nTask id: task-2')).toBe(false);
    expect(store.hasQueuedPrompt('session-2', 'Agent work dispatch.\nTask id: task-1')).toBe(true);
  });

  test('detects queued agent-work task advisories by task id', () => {
    const store = new PromptQueueStore(makeTempDb());

    store.addPrompt('session-1', {
      content: 'Agent work dispatch.\nDispatch reason: task updated.\nTask id: task-42',
    });
    store.addPrompt('session-1', {
      content: 'Night Watch reflection check-in.',
    });

    expect(store.hasQueuedTaskDispatchPrompt('session-1', 'task-42')).toBe(true);
    expect(store.hasQueuedTaskDispatchPrompt('session-1', 'task-99')).toBe(false);
  });
});
