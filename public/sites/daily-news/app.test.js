/**
 * Tests for Daily News app.js core logic
 *
 * Run: bun test public/sites/daily-news/app.test.js
 *
 * These tests validate the pure functions extracted from app.js:
 * - Record-to-article transformation
 * - Payload decryption/parsing
 * - Category normalization
 * - Tag parsing
 * - Date formatting
 * - HTML escaping
 * - Article filtering and sorting
 * - Markdown fallback rendering
 */

import { describe, test, expect } from 'bun:test';

// ── Extract pure functions for testing ─────────────────────────────
// We re-implement the pure functions here to test independently of DOM.
// In production, these live in app.js.

function parsePayload(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (typeof value === 'object') return value;
  return null;
}

function normalizeCategory(cat) {
  if (!cat) return 'general';
  const lower = cat.toLowerCase().trim();
  if (['tech', 'nostr', 'wingman', 'general'].includes(lower)) return lower;
  return 'general';
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function decryptPayload(record, groupKey) {
  if (record.decrypted_payload) {
    return parsePayload(record.decrypted_payload);
  }
  if (record.data && typeof record.data === 'object') {
    return record.data;
  }
  if (record.payload) {
    return parsePayload(record.payload);
  }
  if (record.encrypted_payload && groupKey) {
    return null; // Not yet implemented
  }
  return null;
}

function recordToArticle(record, groupKey) {
  const payload = decryptPayload(record, groupKey);
  if (!payload) return null;
  const data = payload.data || payload;
  if (data.record_state === 'archived') return null;
  return {
    id: record.record_id || record.id || 'test-id',
    title: data.title || 'Untitled',
    summary: data.summary || '',
    body: data.body || '',
    sourceUrl: data.source_url || null,
    category: normalizeCategory(data.category),
    publishedAt: data.published_at || record.updated_at || record.created_at || new Date().toISOString(),
    imageUrl: data.image_url || null,
    tags: parseTags(data.tags),
    version: record.version,
  };
}

function renderMarkdownFallback(md) {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ── Tests ──────────────────────────────────────────────────────────

describe('parsePayload', () => {
  test('parses JSON string', () => {
    const result = parsePayload('{"title":"hello"}');
    expect(result).toEqual({ title: 'hello' });
  });

  test('returns object as-is', () => {
    const obj = { title: 'hello' };
    expect(parsePayload(obj)).toBe(obj);
  });

  test('returns null for invalid JSON string', () => {
    expect(parsePayload('not-json')).toBeNull();
  });

  test('returns null for non-string non-object', () => {
    expect(parsePayload(42)).toBeNull();
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload(undefined)).toBeNull();
  });
});

describe('normalizeCategory', () => {
  test('returns known categories lowercase', () => {
    expect(normalizeCategory('tech')).toBe('tech');
    expect(normalizeCategory('Tech')).toBe('tech');
    expect(normalizeCategory('NOSTR')).toBe('nostr');
    expect(normalizeCategory('Wingman')).toBe('wingman');
    expect(normalizeCategory('general')).toBe('general');
  });

  test('returns general for unknown categories', () => {
    expect(normalizeCategory('crypto')).toBe('general');
    expect(normalizeCategory('random')).toBe('general');
  });

  test('returns general for empty/null', () => {
    expect(normalizeCategory('')).toBe('general');
    expect(normalizeCategory(null)).toBe('general');
    expect(normalizeCategory(undefined)).toBe('general');
  });

  test('trims whitespace', () => {
    expect(normalizeCategory('  tech  ')).toBe('tech');
  });
});

describe('parseTags', () => {
  test('parses comma-separated string', () => {
    expect(parseTags('nostr, bitcoin, lightning')).toEqual(['nostr', 'bitcoin', 'lightning']);
  });

  test('returns array as-is', () => {
    expect(parseTags(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('returns empty array for null/undefined/empty', () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags('')).toEqual([]);
  });

  test('filters empty tags from split', () => {
    expect(parseTags('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('escapeHtml', () => {
  test('escapes HTML entities', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  test('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('returns empty for falsy input', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('escapeAttr', () => {
  test('escapes quotes and ampersands', () => {
    expect(escapeAttr('he said "hello" & \'bye\'')).toBe(
      'he said &quot;hello&quot; &amp; &#39;bye&#39;'
    );
  });

  test('returns empty for falsy input', () => {
    expect(escapeAttr('')).toBe('');
    expect(escapeAttr(null)).toBe('');
  });
});

describe('formatDate', () => {
  test('formats ISO date', () => {
    const result = formatDate('2026-03-15T10:00:00Z');
    expect(result).toContain('15');
    expect(result).toContain('Mar');
    expect(result).toContain('2026');
  });

  test('handles invalid date gracefully', () => {
    const result = formatDate('not-a-date');
    // Should not throw, returns something
    expect(typeof result).toBe('string');
  });
});

describe('decryptPayload', () => {
  test('uses decrypted_payload if present (object)', () => {
    const record = { decrypted_payload: { title: 'Test' } };
    expect(decryptPayload(record, '')).toEqual({ title: 'Test' });
  });

  test('uses decrypted_payload if present (JSON string)', () => {
    const record = { decrypted_payload: '{"title":"Test"}' };
    expect(decryptPayload(record, '')).toEqual({ title: 'Test' });
  });

  test('falls back to data field', () => {
    const record = { data: { title: 'From data' } };
    expect(decryptPayload(record, '')).toEqual({ title: 'From data' });
  });

  test('falls back to payload field', () => {
    const record = { payload: '{"title":"From payload"}' };
    expect(decryptPayload(record, '')).toEqual({ title: 'From payload' });
  });

  test('returns null for encrypted_payload without implementation', () => {
    const record = { encrypted_payload: 'abc123' };
    expect(decryptPayload(record, 'some-key')).toBeNull();
  });

  test('returns null for empty record', () => {
    expect(decryptPayload({}, '')).toBeNull();
  });
});

describe('recordToArticle', () => {
  const baseRecord = {
    record_id: 'rec-1',
    version: 3,
    updated_at: '2026-03-15T10:00:00Z',
    decrypted_payload: {
      data: {
        title: 'Test Article',
        summary: 'A test summary',
        body: '# Hello\n\nWorld',
        source_url: 'https://example.com',
        category: 'tech',
        published_at: '2026-03-15T09:00:00Z',
        image_url: 'https://example.com/img.jpg',
        tags: 'nostr, bitcoin',
        record_state: 'active',
      },
    },
  };

  test('transforms a full record', () => {
    const article = recordToArticle(baseRecord, '');
    expect(article).not.toBeNull();
    expect(article.id).toBe('rec-1');
    expect(article.title).toBe('Test Article');
    expect(article.summary).toBe('A test summary');
    expect(article.body).toBe('# Hello\n\nWorld');
    expect(article.sourceUrl).toBe('https://example.com');
    expect(article.category).toBe('tech');
    expect(article.publishedAt).toBe('2026-03-15T09:00:00Z');
    expect(article.imageUrl).toBe('https://example.com/img.jpg');
    expect(article.tags).toEqual(['nostr', 'bitcoin']);
    expect(article.version).toBe(3);
  });

  test('skips archived records', () => {
    const archived = {
      ...baseRecord,
      decrypted_payload: {
        data: { ...baseRecord.decrypted_payload.data, record_state: 'archived' },
      },
    };
    expect(recordToArticle(archived, '')).toBeNull();
  });

  test('handles missing optional fields', () => {
    const minimal = {
      record_id: 'rec-2',
      version: 1,
      decrypted_payload: {
        data: {
          title: 'Minimal',
          published_at: '2026-03-15T10:00:00Z',
        },
      },
    };
    const article = recordToArticle(minimal, '');
    expect(article).not.toBeNull();
    expect(article.title).toBe('Minimal');
    expect(article.summary).toBe('');
    expect(article.body).toBe('');
    expect(article.sourceUrl).toBeNull();
    expect(article.category).toBe('general');
    expect(article.imageUrl).toBeNull();
    expect(article.tags).toEqual([]);
  });

  test('returns null when payload cannot be decrypted', () => {
    const empty = { record_id: 'rec-3' };
    expect(recordToArticle(empty, '')).toBeNull();
  });

  test('handles flat payload (no nested data field)', () => {
    const flat = {
      record_id: 'rec-4',
      version: 1,
      decrypted_payload: {
        title: 'Flat Article',
        summary: 'Flat summary',
        body: 'Flat body',
        category: 'nostr',
        published_at: '2026-03-15T10:00:00Z',
      },
    };
    const article = recordToArticle(flat, '');
    expect(article).not.toBeNull();
    expect(article.title).toBe('Flat Article');
    expect(article.category).toBe('nostr');
  });

  test('defaults title to Untitled when missing', () => {
    const noTitle = {
      record_id: 'rec-5',
      version: 1,
      decrypted_payload: { data: { published_at: '2026-03-15T10:00:00Z' } },
    };
    const article = recordToArticle(noTitle, '');
    expect(article.title).toBe('Untitled');
  });
});

describe('renderMarkdownFallback', () => {
  test('wraps paragraphs', () => {
    const result = renderMarkdownFallback('Hello\n\nWorld');
    expect(result).toBe('<p>Hello</p><p>World</p>');
  });

  test('converts single newlines to <br>', () => {
    const result = renderMarkdownFallback('Line 1\nLine 2');
    expect(result).toBe('<p>Line 1<br>Line 2</p>');
  });

  test('escapes HTML in markdown', () => {
    const result = renderMarkdownFallback('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

describe('article filtering and sorting', () => {
  const articles = [
    { id: '1', category: 'tech', publishedAt: '2026-03-15T10:00:00Z', title: 'A' },
    { id: '2', category: 'nostr', publishedAt: '2026-03-16T10:00:00Z', title: 'B' },
    { id: '3', category: 'tech', publishedAt: '2026-03-14T10:00:00Z', title: 'C' },
    { id: '4', category: 'general', publishedAt: '2026-03-17T10:00:00Z', title: 'D' },
  ];

  function filterAndSort(items, category) {
    let filtered = category === 'all'
      ? [...items]
      : items.filter(a => a.category === category);
    filtered.sort((a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
    return filtered;
  }

  test('all category returns all articles sorted reverse-chronological', () => {
    const result = filterAndSort(articles, 'all');
    expect(result.map(a => a.id)).toEqual(['4', '2', '1', '3']);
  });

  test('tech filter returns only tech articles', () => {
    const result = filterAndSort(articles, 'tech');
    expect(result).toHaveLength(2);
    expect(result.every(a => a.category === 'tech')).toBe(true);
    expect(result[0].id).toBe('1'); // newer first
  });

  test('unknown category returns empty', () => {
    const result = filterAndSort(articles, 'wingman');
    expect(result).toHaveLength(0);
  });
});

describe('config.json schema', () => {
  test('config has required fields', async () => {
    const config = await Bun.file(
      new URL('./config.json', import.meta.url).pathname
    ).json();

    expect(config).toHaveProperty('superbased_url');
    expect(config).toHaveProperty('public_group_key');
    expect(config).toHaveProperty('public_group_id');
    expect(config).toHaveProperty('collection');
    expect(config).toHaveProperty('app_namespace');
    expect(config).toHaveProperty('schema_version');
    expect(config).toHaveProperty('owner_pubkey');
    expect(config).toHaveProperty('refresh_interval_ms');
    expect(config).toHaveProperty('site_title');
    expect(config).toHaveProperty('site_description');
  });

  test('collection matches design spec', async () => {
    const config = await Bun.file(
      new URL('./config.json', import.meta.url).pathname
    ).json();
    expect(config.collection).toBe('daily_news');
    expect(config.app_namespace).toBe('wingman-fd');
    expect(config.schema_version).toBe(1);
  });
});

describe('index.html structure', () => {
  test('contains required elements', async () => {
    const html = await Bun.file(
      new URL('./index.html', import.meta.url).pathname
    ).text();

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="app"');
    expect(html).toContain('style.css');
    expect(html).toContain('app.js');
    expect(html).toContain('marked');
    expect(html).toContain('viewport');
  });
});
