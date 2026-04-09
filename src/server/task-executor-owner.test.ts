import { describe, expect, test } from 'bun:test';

import { resolveTaskExecutorOwnerNpub } from './task-executor-owner';

describe('resolveTaskExecutorOwnerNpub', () => {
  test('prefers ADMIN_NPUB when present', () => {
    expect(resolveTaskExecutorOwnerNpub('npub1admin0000000000000000000000000000000000000000000000000000000000', 'npub1task00000000000000000000000000000000000000000000000000000000000'))
      .toBe('npub1admin0000000000000000000000000000000000000000000000000000000000');
  });

  test('falls back to the task-listener identity when ADMIN_NPUB is missing', () => {
    expect(resolveTaskExecutorOwnerNpub(null, 'npub1task00000000000000000000000000000000000000000000000000000000000'))
      .toBe('npub1task00000000000000000000000000000000000000000000000000000000000');
  });

  test('returns undefined when neither identity is configured', () => {
    expect(resolveTaskExecutorOwnerNpub(null, null)).toBeUndefined();
  });
});
