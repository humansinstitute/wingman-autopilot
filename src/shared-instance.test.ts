import { describe, expect, test } from 'bun:test';

import { isSharedInstanceAccessEnabled } from './shared-instance';

describe('isSharedInstanceAccessEnabled', () => {
  test('accepts explicit true values only', () => {
    expect(isSharedInstanceAccessEnabled({ WINGMAN_SHARED_INSTANCE: 'true' })).toBe(true);
    expect(isSharedInstanceAccessEnabled({ WINGMAN_SHARED_INSTANCE: '1' })).toBe(true);
    expect(isSharedInstanceAccessEnabled({ WINGMAN_SHARED_INSTANCE: 'false' })).toBe(false);
    expect(isSharedInstanceAccessEnabled({})).toBe(false);
  });
});
