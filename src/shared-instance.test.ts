import { describe, expect, test } from 'bun:test';

import { isSharedAgentDispatchEnabled, isSharedInstanceAccessEnabled } from './shared-instance';

describe('isSharedInstanceAccessEnabled', () => {
  test('accepts explicit true values only', () => {
    expect(isSharedInstanceAccessEnabled({ WINGMAN_SHARED_INSTANCE: 'true' })).toBe(true);
    expect(isSharedInstanceAccessEnabled({ WINGMAN_SHARED_INSTANCE: '1' })).toBe(true);
    expect(isSharedInstanceAccessEnabled({ WINGMAN_SHARED_INSTANCE: 'false' })).toBe(false);
    expect(isSharedInstanceAccessEnabled({})).toBe(false);
  });
});

describe('isSharedAgentDispatchEnabled', () => {
  test('inherits shared instance mode by default', () => {
    expect(isSharedAgentDispatchEnabled({ WINGMAN_SHARED_INSTANCE: 'true' })).toBe(true);
    expect(isSharedAgentDispatchEnabled({ WINGMAN_SHARED_INSTANCE: 'false' })).toBe(false);
  });

  test('accepts explicit agent dispatch override', () => {
    expect(isSharedAgentDispatchEnabled({
      WINGMAN_SHARED_INSTANCE: 'false',
      WINGMAN_SHARED_AGENT_DISPATCH: 'true',
    })).toBe(true);
    expect(isSharedAgentDispatchEnabled({
      WINGMAN_SHARED_INSTANCE: 'true',
      WINGMAN_SHARED_AGENT_DISPATCH: 'false',
    })).toBe(false);
  });

  test('accepts seeAgentSubs compatibility flag', () => {
    expect(isSharedAgentDispatchEnabled({ WINGMAN_SEE_AGENT_SUBS: 'true' })).toBe(true);
    expect(isSharedAgentDispatchEnabled({ WINGMAN_SEE_AGENT_SUBS: 'false', WINGMAN_SHARED_INSTANCE: 'true' })).toBe(false);
  });
});
