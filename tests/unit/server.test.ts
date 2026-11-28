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

  it('drops Playwright call logs and colour codes', () => {
    const e = new Error('page.goto: net::ERR_FAILED at https://x/d2l/home\nCall log:\n\u001b[2m  - navigating\u001b[22m');
    expect(textOf(errorResult(e))).toBe('Error: page.goto: net::ERR_FAILED at https://x/d2l/home');
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
    expect(names).toHaveLength(26);
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

describe('prompts and resources', () => {
  it('offers the guide prompts and the d2l:// resource templates', async () => {
    const c = await connected();
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(['assignment-guide', 'study-guide', 'catch-up']));
    const templates = (await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(
      expect.arrayContaining(['d2l://course/{orgUnitId}/assignment/{assignmentId}', 'd2l://course/{orgUnitId}/module/{moduleId}', 'd2l://course/{orgUnitId}/topic/{topicId}'])
    );
    const p = await c.getPrompt({ name: 'assignment-guide', arguments: { course: 'EE101', assignment: 'Lab 2' } });
    const text = (p.messages[0].content as { text: string }).text;
    expect(text).toContain('get_assignment_bundle');
    expect(text).toContain('Do not write the assignment itself.');
  });
});
