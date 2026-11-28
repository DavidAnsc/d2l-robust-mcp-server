import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../../src/client.js', () => ({ client: { getMyEnrollments: vi.fn(), whoami: vi.fn() } }));
vi.mock('../../src/auth.js', () => ({ importCookies: vi.fn() }));

import { createHttpApp } from '../../src/http.js';
import { allowedRedirect } from '../../src/oauth.js';

const TOKEN = 'server-token-0123456789abcdef';
const REDIRECT = 'https://client.example/callback';
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('allowedRedirect', () => {
  it('allows https and loopback http only', () => {
    expect(allowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(allowedRedirect('http://localhost:6274/cb')).toBe(true);
    expect(allowedRedirect('http://evil.example/cb')).toBe(false);
    expect(allowedRedirect('javascript:alert(1)')).toBe(false);
  });
});

describe('createHttpApp with OAuth', () => {
  it('needs a public URL and a token', () => {
    expect(() => createHttpApp({ host: '127.0.0.1', port: 0, token: TOKEN, oauth: true })).toThrow(/D2L_PUBLIC_URL/);
    expect(() => createHttpApp({ host: '127.0.0.1', port: 0, allowNoAuth: true, oauth: true, publicUrl: 'https://x' })).toThrow(/D2L_HTTP_TOKEN/);
  });
});

describe('OAuth flow', () => {
  let app: Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'd2l-oauth-test-'));
    app = createHttpApp({ host: '127.0.0.1', port: 0, token: TOKEN, oauth: true, publicUrl: 'https://pi.example', oauthStatePath: join(dir, 'oauth.json') });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => app.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('points unauthenticated MCP requests at the metadata', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://pi.example/.well-known/oauth-protected-resource"');
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta).toMatchObject({ issuer: 'https://pi.example', token_endpoint: 'https://pi.example/token', code_challenge_methods_supported: ['S256'] });
  });

  it('registers, approves with the server token, swaps the code, refreshes, and the token works', async () => {
    const reg = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test <b>app</b>' }) });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const q = { client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };

    const page = await fetch(`${base}/authorize?${new URLSearchParams(q)}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Test &lt;b&gt;app&lt;/b&gt;'); // escaped
    expect(html).toContain('client.example');

    const wrong = await fetch(`${base}/authorize`, { method: 'POST', body: new URLSearchParams({ ...q, password: 'nope' }), redirect: 'manual' });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${base}/authorize`, { method: 'POST', body: new URLSearchParams({ ...q, password: TOKEN }), redirect: 'manual' });
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    const bad = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: 'wrong' }) });
    expect(bad.status).toBe(400);
    // The code was used up by the failed attempt.
    const reused = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
    expect(reused.status).toBe(400);

    // Approve again and do it right.
    const ok2 = await fetch(`${base}/authorize`, { method: 'POST', body: new URLSearchParams({ ...q, password: TOKEN }), redirect: 'manual' });
    const code2 = new URL(ok2.headers.get('location')!).searchParams.get('code')!;
    const tok = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(t.token_type).toBe('Bearer');

    const health = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(health.status).toBe(200);

    const refreshed = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id }) });
    expect(refreshed.status).toBe(200);
    // Refresh tokens rotate: the old one no longer works.
    const again = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id }) });
    expect(again.status).toBe(400);

    expect(statSync(join(dir, 'oauth.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses unregistered redirects without redirecting', async () => {
    const reg = await fetch(`${base}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }), headers: { 'Content-Type': 'application/json' } });
    const { client_id } = (await reg.json()) as { client_id: string };
    const res = await fetch(`${base}/authorize?${new URLSearchParams({ client_id, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: 'x', code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('still accepts the plain server token', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(res.status).toBe(200);
  });
});
