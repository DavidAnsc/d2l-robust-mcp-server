import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/client.js', () => ({
  client: { whoami: vi.fn() },
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { client as d2l } from '../../src/client.js';
import { createServer, errorResult } from '../../src/server.js';
import { markSessionExpired, resetSessionStatus, SessionExpiredError } from '../../src/session.js';

async function connected(opts?: Parameters<typeof createServer>[0]) {
  const server = createServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

const textOf = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

describe('errorResult', () => {
  it('prefixes expired sessions with SESSION_EXPIRED', () => {
    const r = errorResult(new SessionExpiredError());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^SESSION_EXPIRED: .*d2l-mcp-auth/);
  });

  it('passes other errors through', () => {
    expect(textOf(errorResult(new Error('boom')))).toBe('Error: boom');
  });
});

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionStatus();
  });

  it('registers download_file by default (stdio behaviour unchanged)', async () => {
    const c = await connected();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('download_file');
    expect(names).toHaveLength(13);
  });

  it('can leave download_file out', async () => {
    const c = await connected({ enableDownload: false });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('download_file');
  });

  it('get_session_status reports without a live call by default', async () => {
    markSessionExpired();
    const c = await connected();
    const r = await c.callTool({ name: 'get_session_status', arguments: {} });
    expect(JSON.parse(textOf(r as never)).state).toBe('expired');
    expect(d2l.whoami).not.toHaveBeenCalled();
  });

  it('get_session_status with check=true makes a live call', async () => {
    vi.mocked(d2l.whoami).mockResolvedValue({});
    const c = await connected();
    await c.callTool({ name: 'get_session_status', arguments: { check: true } });
    expect(d2l.whoami).toHaveBeenCalledTimes(1);
  });

  it('get_session_status includes non-auth check errors', async () => {
    vi.mocked(d2l.whoami).mockRejectedValue(new Error('D2L API error 500: down'));
    const c = await connected();
    const r = await c.callTool({ name: 'get_session_status', arguments: { check: true } });
    expect(JSON.parse(textOf(r as never)).checkError).toContain('500');
  });
});
