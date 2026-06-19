import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runFlightDeckPgCli } from './cli';

const testKey = '1'.repeat(64);
const originalFetch = globalThis.fetch;

describe('flightdeck pg cli', () => {
  beforeEach(() => {
    delete Bun.env.SESSION_ID;
    delete Bun.env.WINGMAN_URL;
    delete Bun.env.TOWER_URL;
    delete Bun.env.FLIGHTDECK_TOWER_URL;
    delete Bun.env.FLIGHTDECK_APP_NPUB;
    delete Bun.env.AGENT_NSEC;
    delete Bun.env.WINGMAN_NSEC;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('context returns explicit no-session context without calling sync clients', async () => {
    const result = await runFlightDeckPgCli([
      'context',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
      '--url',
      'http://wingman.test',
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout || '{}');
    expect(payload.mode).toBe('flightdeck_pg');
    expect(payload.context_available).toBe(false);
  });

  test('lists tasks through channel PG route', async () => {
    const requests: Request[] = [];
    const result = await runFlightDeckPgCli([
      'tasks',
      'list',
      '--workspace',
      'workspace-1',
      '--channel',
      'channel-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
    ], {
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ tasks: [{ id: 'task-1' }], next_cursor: null });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(requests[0]?.url).toBe('http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/tasks');
    expect(requests[0]?.headers.get('authorization')).toMatch(/^Nostr /);
    expect(requests[0]?.headers.get('x-flightdeck-pg-app-npub')).toBe('npub1app');
    expect(JSON.parse(result.stdout || '{}').tasks[0].id).toBe('task-1');
  });

  test('workspace task list without channel or scope fails as route gap', async () => {
    const result = await runFlightDeckPgCli([
      'tasks',
      'list',
      '--workspace',
      'workspace-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stderr || '{}');
    expect(payload.missingRoute.path).toBe('/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks');
  });

  test('hydrates task defaults from active dispatch context', async () => {
    Bun.env.SESSION_ID = 'session-1';
    const { router, requests } = makeFlightDeckRouter();
    globalThis.fetch = router as typeof fetch;

    const result = await runFlightDeckPgCli([
      'task',
      'show',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
      '--url',
      'http://wingman.test',
    ], { fetchImpl: router as typeof fetch });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout || '{}').task.id).toBe('task-1');
    expect(requests.map((request) => request.url)).toEqual([
      'http://wingman.test/api/mcp/wingman/flightdeck',
      'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1',
    ]);
  });

  test('covers task comments, comment, and state routes', async () => {
    const { router, requests } = makeFlightDeckRouter();
    globalThis.fetch = router as typeof fetch;

    const common = [
      '--workspace',
      'workspace-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
    ];

    expect((await runFlightDeckPgCli(['task', 'comments', 'task-1', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
    expect((await runFlightDeckPgCli(['task', 'comment', 'task-1', '--body', 'Done', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
    expect((await runFlightDeckPgCli(['task', 'state', 'task-1', '--state', 'in_progress', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);

    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments?limit=200' && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments' && request.method === 'POST')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/edit-leases/acquire' && request.method === 'POST')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/state' && request.method === 'POST')).toBe(true);
  });

  test('covers thread read and reply paths', async () => {
    const { router, requests } = makeFlightDeckRouter();
    globalThis.fetch = router as typeof fetch;
    const common = [
      '--workspace',
      'workspace-1',
      '--channel',
      'channel-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
    ];

    expect((await runFlightDeckPgCli(['thread', 'read', 'thread-1', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
    expect((await runFlightDeckPgCli(['chat', 'reply', '--thread', 'thread-1', '--body', 'Reply', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);

    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/messages?thread_id=thread-1&limit=200' && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/messages' && request.method === 'POST')).toBe(true);
  });

  test('covers document create, read, update, comments, and reply paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flightdeck-cli-doc-'));
    const bodyFile = join(tempDir, 'body.md');
    writeFileSync(bodyFile, '# Body\n', 'utf8');
    const { router, requests } = makeFlightDeckRouter();
    globalThis.fetch = router as typeof fetch;
    const common = [
      '--workspace',
      'workspace-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
    ];

    try {
      expect((await runFlightDeckPgCli(['doc', 'create', '--channel', 'channel-1', '--title', 'Plan', '--body-file', bodyFile, ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
      expect((await runFlightDeckPgCli(['doc', 'show', 'doc-1', '--body', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
      expect((await runFlightDeckPgCli(['doc', 'update', 'doc-1', '--body-file', bodyFile, ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
      expect((await runFlightDeckPgCli(['doc', 'comments', 'doc-1', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
      expect((await runFlightDeckPgCli(['doc', 'reply', 'doc-1', '--body', 'Looks good', ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/docs' && request.method === 'POST')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/body' && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1' && request.method === 'PATCH')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments?limit=200' && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments' && request.method === 'POST')).toBe(true);
  });

  test('downloads a Flight Deck document with comments and local storage links', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flightdeck-cli-doc-download-'));
    const outPath = join(tempDir, 'design.md');
    const docId = '11111111-1111-4111-8111-111111111111';
    const objectId = '22222222-2222-4222-8222-222222222222';
    const { router, requests } = makeFlightDeckRouter();
    globalThis.fetch = router as typeof fetch;
    const common = [
      '--workspace',
      'workspace-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
    ];

    try {
      const result = await runFlightDeckPgCli([
        'doc',
        'download',
        `@[Design](mention:doc:${docId})`,
        '--out',
        outPath,
        ...common,
      ], { fetchImpl: router as typeof fetch });

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout || '{}');
      expect(payload).toMatchObject({
        ok: true,
        documentId: docId,
        outPath,
        comments: 2,
      });
      const markdown = readFileSync(outPath, 'utf8');
      expect(markdown).toContain('Document ID: 11111111-1111-4111-8111-111111111111');
      expect(markdown).toContain(`![Screen](design.assets/${objectId}.png)`);
      expect(markdown).toContain('<comment id="doc-comment-inline"');
      expect(markdown).toContain('Inline note.');
      expect(markdown).toContain('## Flight Deck Comments');
      expect(markdown).toContain('General note.');
      expect(existsSync(join(tempDir, 'design.assets', `${objectId}.png`))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(requests.some((request) => request.url === `http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/docs/${docId}/body` && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === `http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/docs/${docId}/comments?limit=500` && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === `http://tower.test/api/v4/storage/${objectId}` && request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url === `http://tower.test/api/v4/storage/${objectId}/content` && request.method === 'GET')).toBe(true);
  });

  test('covers file and audio upload storage paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flightdeck-cli-upload-'));
    const artifactPath = join(tempDir, 'artifact.txt');
    const audioPath = join(tempDir, 'note.m4a');
    writeFileSync(artifactPath, 'artifact', 'utf8');
    writeFileSync(audioPath, 'audio', 'utf8');
    const { router, requests } = makeFlightDeckRouter();
    globalThis.fetch = router as typeof fetch;
    const common = [
      '--workspace',
      'workspace-1',
      '--channel',
      'channel-1',
      '--json',
      '--key',
      testKey,
      '--app-npub',
      'npub1app',
      '--tower-url',
      'http://tower.test',
    ];

    try {
      expect((await runFlightDeckPgCli(['file', 'upload', '--path', artifactPath, ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
      expect((await runFlightDeckPgCli(['audio', 'create', '--file', audioPath, ...common], { fetchImpl: router as typeof fetch })).exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(requests.filter((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/storage/prepare')).toHaveLength(2);
    expect(requests.filter((request) => request.url.startsWith('http://tower.test/api/v4/storage/object-') && request.method === 'PUT')).toHaveLength(2);
    expect(requests.filter((request) => request.url.startsWith('http://tower.test/api/v4/storage/object-') && request.url.endsWith('/complete'))).toHaveLength(2);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/files' && request.method === 'POST')).toBe(true);
    expect(requests.some((request) => request.url === 'http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/audio-notes' && request.method === 'POST')).toBe(true);
  });
});

function makeFlightDeckRouter(): {
  requests: Request[];
  router: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} {
  const requests: Request[] = [];
  let objectCounter = 0;
  const router = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.origin === 'http://wingman.test' && url.pathname === '/api/mcp/wingman/flightdeck') {
      return Response.json({
        ok: true,
        mode: 'flightdeck_pg',
        workspace: {
          workspaceId: 'workspace-1',
          backendBaseUrl: 'http://tower.test',
          sourceAppNpub: 'npub1app',
        },
        chat: {
          channelId: 'channel-1',
          threadId: 'thread-1',
        },
        routing: {
          bindingType: 'task',
          bindingId: 'task-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
          scopeId: 'scope-1',
        },
        record: {
          recordFamily: 'task',
          recordId: 'task-1',
        },
      });
    }

    if (url.pathname.endsWith('/storage/prepare') && method === 'POST') {
      objectCounter += 1;
      return Response.json({ object_id: `object-${objectCounter}` });
    }
    if (/\/api\/v4\/storage\/object-\d+$/.test(url.pathname) && method === 'PUT') {
      return Response.json({ ok: true });
    }
    if (/\/api\/v4\/storage\/object-\d+\/complete$/.test(url.pathname) && method === 'POST') {
      return Response.json({ completed_at: '2026-06-18T00:00:00.000Z' });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1' && method === 'GET') {
      return Response.json({ task: { id: 'task-1', row_version: 7 } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments' && method === 'GET') {
      return Response.json({ comments: [{ id: 'comment-1' }], next_cursor: null });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments' && method === 'POST') {
      return Response.json({ comment: { id: 'comment-2' } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/edit-leases/acquire' && method === 'POST') {
      return Response.json({ lease: { lease_token: 'lease-1' } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/state' && method === 'POST') {
      return Response.json({ task: { id: 'task-1', state: 'in_progress' } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/messages' && method === 'GET') {
      return Response.json({ messages: [{ id: 'message-1' }], next_cursor: null });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/messages' && method === 'POST') {
      return Response.json({ message: { id: 'message-2' } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/docs' && method === 'POST') {
      return Response.json({ doc: { id: 'doc-1', title: 'Plan', row_version: 3 } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/body' && method === 'GET') {
      return Response.json({
        doc: { id: 'doc-1', title: 'Plan', row_version: 3 },
        body: {
          encoding: 'base64',
          base64_data: Buffer.from(JSON.stringify({ content_model: { content: '# Body\n' } })).toString('base64'),
        },
      });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/11111111-1111-4111-8111-111111111111/body' && method === 'GET') {
      return Response.json({
        doc: { id: '11111111-1111-4111-8111-111111111111', title: 'Design', row_version: 7 },
        body: {
          encoding: 'base64',
          base64_data: Buffer.from(JSON.stringify({
            content_model: {
              content: '# Design\n\n![Screen](storage://22222222-2222-4222-8222-222222222222)\n\nImplement this.',
            },
          })).toString('base64'),
        },
      });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1' && method === 'GET') {
      return Response.json({ doc: { id: 'doc-1', title: 'Plan', row_version: 3 } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1' && method === 'PATCH') {
      return Response.json({ doc: { id: 'doc-1', row_version: 4 } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments' && method === 'GET') {
      return Response.json({ comments: [{ id: 'doc-comment-1' }], next_cursor: null });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/11111111-1111-4111-8111-111111111111/comments' && method === 'GET') {
      return Response.json({
        comments: [
          {
            id: 'doc-comment-inline',
            body: 'Inline note.',
            created_by_actor_npub: 'npub1pete',
            created_at: '2026-06-19T09:00:00.000Z',
            metadata: { line: 3 },
          },
          {
            id: 'doc-comment-general',
            body: 'General note.',
            created_by_actor_npub: 'npub1pete',
            created_at: '2026-06-19T09:01:00.000Z',
          },
        ],
        next_cursor: null,
      });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments' && method === 'POST') {
      return Response.json({ comment: { id: 'doc-comment-2' } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/files' && method === 'POST') {
      return Response.json({ file: { id: 'file-1' } });
    }
    if (url.pathname === '/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/audio-notes' && method === 'POST') {
      return Response.json({ audio_note: { id: 'audio-1' } });
    }
    if (url.pathname === '/api/v4/storage/22222222-2222-4222-8222-222222222222' && method === 'GET') {
      return Response.json({
        object_id: '22222222-2222-4222-8222-222222222222',
        content_type: 'image/png',
        content_url: 'http://tower.test/api/v4/storage/22222222-2222-4222-8222-222222222222/content',
      });
    }
    if (url.pathname === '/api/v4/storage/22222222-2222-4222-8222-222222222222/content' && method === 'GET') {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      });
    }

    return Response.json({ error: `${method} ${url.pathname} was not mocked` }, { status: 404 });
  };
  return { requests, router };
}
