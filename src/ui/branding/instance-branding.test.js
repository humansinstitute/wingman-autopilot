import { describe, expect, test } from 'bun:test';

import { getInstanceName, normalizeInstanceBranding } from './instance-branding.js';

describe('instance branding', () => {
  test('normalizes configured instance branding', () => {
    expect(normalizeInstanceBranding({ name: ' Rick ', highlightColor: '#A855F7' })).toEqual({
      name: 'Rick',
      highlightColor: '#a855f7',
    });
  });

  test('uses safe defaults for missing or invalid values', () => {
    expect(normalizeInstanceBranding({ name: ' ', highlightColor: 'green' })).toEqual({
      name: 'Wingman',
      highlightColor: '#10b981',
    });
    expect(getInstanceName(null)).toBe('Wingman');
  });
});
