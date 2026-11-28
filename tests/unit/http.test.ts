import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../../src/client.js', () => ({
  client: {
    getMyEnrollments: vi.fn(),
    whoami: vi.fn(),
  },
}));

vi.mock('../../src/auth.js', () => ({
  importCookies: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { client as d2l } from '../../src/client.js';
import { importCookies } from '../../src/auth.js';
import { createHttpApp } from '../../src/http.js';
import { markSessionExpired, resetSessionStatus, SessionExpiredError } from '../../src/session.js';
import enrollmentsFixture from '../fixtures/enrollments.json';

const TOKEN = 'test-token-0123456789abcdef';

async function listen(app: Server): Promise<string> {
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
}

describe('createHttpApp', () => {
  it('refuses to start without a token', () => {
    expect(() => createHttpApp({ host: '127.0.0.1', port: 0 })).toThrow(/D2L_HTTP_TOKEN/);
  });

  it('starts without a token only when explicitly allowed', () => {
    expect(() => createHttpApp({ host: '127.0.0.1', port: 0, allowNoAuth: true })).not.toThrow();
  });
});

describe('HTTP transport', () => {
  let app: Server;
  let base: string;

  beforeAll(async () => {
    app = createHttpApp({ host: '127.0.0.1', port: 0, token: TOKEN });
    base = await listen(app);
  });

  afterAll(async () => {
    await new Promise((r) => app.close(r));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionStatus();
  });

  it('rejects requests with no token', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects a wrong token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const res2 = await fetch(`${base}/mcp/wrong`, { method: 'POST', body: '{}' });
    expect(res2.status).toBe(401);
  });

  it('returns 404 for unknown paths and 405 for GET /mcp', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });

  it('lists tools over MCP with a bearer token, without download_file', async () => {
    const c = await connect(`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_upcoming_due_dates');
    expect(names).toContain('get_session_status');
    expect(names).not.toContain('download_file');
    expect(names).toHaveLength(25);
    expect(names).toContain('read_file');
    await c.close();
  });

  it('accepts the token as a path segment', async () => {
    const c = await connect(`${base}/mcp/${TOKEN}`);
    const { tools } = await c.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await c.close();
  });

  it('calls a tool and returns data', async () => {
    vi.mocked(d2l.getMyEnrollments).mockResolvedValue(enrollmentsFixture);
    const c = await connect(`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const result = await c.callTool({ name: 'get_my_courses', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0].text;
    expect(Array.isArray(JSON.parse(text))).toBe(true);
    await c.close();
  });

  it('turns an expired session into a clear tool error', async () => {
    vi.mocked(d2l.getMyEnrollments).mockRejectedValue(new SessionExpiredError());
    const c = await connect(`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const result = await c.callTool({ name: 'get_my_courses', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toMatch(/^SESSION_EXPIRED: /);
    expect(text).toContain('d2l-mcp-auth');
    await c.close();
  });

  it('serves /health without a token, revealing only the state', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'unknown' });

    markSessionExpired();
    const res2 = await fetch(`${base}/health`);
    expect(res2.status).toBe(503);
    expect(await res2.json()).toEqual({ state: 'expired' });
  });

  it('requires the token for a live /health check', async () => {
    expect((await fetch(`${base}/health?check=true`)).status).toBe(401);
    expect(d2l.whoami).not.toHaveBeenCalled();

    vi.mocked(d2l.whoami).mockResolvedValue({});
    const res = await fetch(`${base}/health?check=true`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(d2l.whoami).toHaveBeenCalledTimes(1);
    expect(await res.json()).toHaveProperty('message');
  });
});

describe('POST /session (login pushed from a laptop)', () => {
  let app: Server;
  let base: string;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const session = (host = 'learn.example.edu') =>
    JSON.stringify({ format: 'd2l-mcp-session', version: 1, host, exportedAt: '', cookies: [{ name: 'd2lSessionVal', value: 'x' }] });

  beforeAll(async () => {
    process.env.D2L_HOST = 'learn.example.edu';
    app = createHttpApp({ host: '127.0.0.1', port: 0, token: TOKEN });
    base = await listen(app);
  });

  afterAll(async () => {
    delete process.env.D2L_HOST;
    await new Promise((r) => app.close(r));
  });

  beforeEach(() => vi.clearAllMocks());

  it('imports the cookies and reports the session valid', async () => {
    vi.mocked(importCookies).mockResolvedValue(Date.UTC(2030, 0, 1));
    const res = await fetch(`${base}/session`, { method: 'POST', headers: auth, body: session() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'valid', cookies: 1, tokenExpiresAt: '2030-01-01T00:00:00.000Z' });
    expect(importCookies).toHaveBeenCalledWith([{ name: 'd2lSessionVal', value: 'x' }]);
  });

  it('needs the token in the header, not the URL', async () => {
    expect((await fetch(`${base}/session`, { method: 'POST', body: session() })).status).toBe(401);
    expect((await fetch(`${base}/session/${TOKEN}`, { method: 'POST', body: session() })).status).toBe(404);
    expect(importCookies).not.toHaveBeenCalled();
  });

  it('rejects a session for another school, or a body that is not an export', async () => {
    const other = await fetch(`${base}/session`, { method: 'POST', headers: auth, body: session('other.edu') });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toContain('other.edu');
    expect((await fetch(`${base}/session`, { method: 'POST', headers: auth, body: '{"a":1}' })).status).toBe(400);
    expect(importCookies).not.toHaveBeenCalled();
  });

  it('says so when the pushed cookies do not log in', async () => {
    vi.mocked(importCookies).mockRejectedValue(new SessionExpiredError());
    const res = await fetch(`${base}/session`, { method: 'POST', headers: auth, body: session() });
    expect(res.status).toBe(422);
  });

  it('can be turned off', async () => {
    const off = createHttpApp({ host: '127.0.0.1', port: 0, token: TOKEN, allowSessionPush: false });
    const url = await listen(off);
    expect((await fetch(`${url}/session`, { method: 'POST', headers: auth, body: session() })).status).toBe(403);
    await new Promise((r) => off.close(r));
  });
});
