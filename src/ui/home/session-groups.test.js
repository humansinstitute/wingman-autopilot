import { describe, expect, test } from 'bun:test';

import {
  countSessionsByHomeGroup,
  filterSessionsForHomeGroup,
  getHomeSessionGroup,
} from './session-groups.js';

describe('home session groups', () => {
  const sessions = [
    {
      id: 'my-1',
      metadata: { AGENT: false, billingMode: 'subscription' },
      origin: null,
    },
    {
      id: 'task-1',
      metadata: { AGENT: true, billingMode: 'subscription', role: 'agent-work', bindingType: 'task' },
      origin: { type: 'agent-work', id: 'task-1' },
    },
    {
      id: 'chat-1',
      metadata: { AGENT: true, billingMode: 'subscription', role: 'agent-chat' },
      origin: { type: 'agent-chat', id: 'thread-1' },
    },
    {
      id: 'agent-1',
      metadata: { AGENT: true, billingMode: 'subscription' },
      origin: { type: 'cli', id: 'npub1example' },
    },
    {
      id: 'fork-1',
      metadata: { AGENT: false, billingMode: 'subscription' },
      origin: { type: 'fork', id: 'base-1' },
    },
  ];

  test('classifies home session groups by origin and metadata', () => {
    expect(getHomeSessionGroup(sessions[0])).toBe('my');
    expect(getHomeSessionGroup(sessions[1])).toBe('task-dispatch');
    expect(getHomeSessionGroup(sessions[2])).toBe('chat-dispatch');
    expect(getHomeSessionGroup(sessions[3])).toBe('agent-sessions');
    expect(getHomeSessionGroup(sessions[4])).toBe('my');
  });

  test('filters sessions for the selected home group', () => {
    expect(filterSessionsForHomeGroup(sessions, 'my').map((session) => session.id)).toEqual(['my-1', 'fork-1']);
    expect(filterSessionsForHomeGroup(sessions, 'task-dispatch').map((session) => session.id)).toEqual(['task-1']);
    expect(filterSessionsForHomeGroup(sessions, 'chat-dispatch').map((session) => session.id)).toEqual(['chat-1']);
    expect(filterSessionsForHomeGroup(sessions, 'agent-sessions').map((session) => session.id)).toEqual(['agent-1']);
  });

  test('counts sessions for each home group', () => {
    expect(countSessionsByHomeGroup(sessions)).toEqual({
      my: 2,
      'task-dispatch': 1,
      'chat-dispatch': 1,
      'agent-sessions': 1,
    });
  });
});
