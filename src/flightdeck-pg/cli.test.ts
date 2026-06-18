import { beforeEach, describe, expect, test } from 'bun:test';

import { runFlightDeckPgCli } from './cli';

const testKey = '1'.repeat(64);

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
});
