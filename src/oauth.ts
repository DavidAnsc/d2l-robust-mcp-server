/**
 * A small OAuth 2.1 authorization server for one person, so clients that only connect through
 * OAuth (claude.ai custom connectors, some desktop apps) can use the HTTP server.
 *
 * How it works:
 *  1. The client finds this server through /.well-known/oauth-protected-resource and
 *     /.well-known/oauth-authorization-server, and registers itself at /register.
 *  2. It sends you to /authorize. That page names the client and where it will send you back,
 *     and asks for this server's D2L_HTTP_TOKEN. Only someone who knows the token can approve.
 *  3. The client swaps the one-time code (with its PKCE verifier) for an access token at /token,
 *     and refreshes it there later.
 *
 * Only S256 PKCE and public clients are supported. Tokens are stored hashed, in a file readable
 * only by this user, so they survive restarts.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname } from 'path';

const ACCESS_TTL_S = 24 * 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 50;
const MAX_BODY = 64 * 1024;

interface StoredClient {
  client_name?: string;
  redirect_uris: string[];
  created: number;
}

interface StoredToken {
  client_id: string;
  kind: 'access' | 'refresh';
  /** Unix seconds. */
  expires: number;
}

interface State {
  clients: Record<string, StoredClient>;
  /** Keyed by the token's SHA-256. */
  tokens: Record<string, StoredToken>;
}

interface PendingCode {
  client_id: string;
  redirect_uri: string;
  challenge: string;
  expires: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (bytes = 32) => b64url(randomBytes(bytes));

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Redirect URIs a client may register: https anywhere, or http only to this computer. */
export function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Form-encoded or JSON body as a flat string map. */
async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const text = await readBody(req);
  if ((req.headers['content-type'] || '').includes('application/json')) {
    const obj = JSON.parse(text || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The approval page must not be framed by another site (clickjacking).
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

export interface OAuthOptions {
  /** The public base URL, e.g. https://pi.tailnet.ts.net (no trailing slash). */
  issuer: string;
  /** What the approval page asks for: the server's D2L_HTTP_TOKEN. */
  password: string;
  statePath: string;
  /** For tests. */
  now?: () => number;
}

export class OAuthServer {
  private state: State;
  private codes = new Map<string, PendingCode>();
  private failures: number[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: OAuthOptions) {
    this.now = opts.now ?? Date.now;
    this.state = this.load();
  }

  get resourceMetadataUrl(): string {
    return `${this.opts.issuer}/.well-known/oauth-protected-resource`;
  }

  private load(): State {
    try {
      if (existsSync(this.opts.statePath)) {
        const s = JSON.parse(readFileSync(this.opts.statePath, 'utf-8')) as State;
        return { clients: s.clients ?? {}, tokens: s.tokens ?? {} };
      }
    } catch (error) {
      console.error('Could not read the OAuth state file; starting empty:', error instanceof Error ? error.message : error);
    }
    return { clients: {}, tokens: {} };
  }

  private save(): void {
    const nowS = this.now() / 1000;
    for (const [k, t] of Object.entries(this.state.tokens)) if (t.expires < nowS) delete this.state.tokens[k];
    mkdirSync(dirname(this.opts.statePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.opts.statePath, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(this.opts.statePath, 0o600);
  }

  /** True when `token` is a live access token this server issued. */
  verifyAccessToken(token: string): boolean {
    const t = this.state.tokens[sha256(token)];
    return !!t && t.kind === 'access' && t.expires > this.now() / 1000 && !!this.state.clients[t.client_id];
  }

  /** Handle an OAuth route. Returns false when the path isn't one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (req.method === 'OPTIONS' && (path.startsWith('/.well-known/') || ['/register', '/token'].includes(path))) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
      });
      res.end();
      return true;
    }
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      json(res, 200, { resource: `${this.opts.issuer}/mcp`, authorization_servers: [this.opts.issuer], bearer_methods_supported: ['header'] });
      return true;
    }
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
      json(res, 200, {
        issuer: this.opts.issuer,
        authorization_endpoint: `${this.opts.issuer}/authorize`,
        token_endpoint: `${this.opts.issuer}/token`,
        registration_endpoint: `${this.opts.issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['d2l:read'],
      });
      return true;
    }
    if (path === '/register' && req.method === 'POST') return this.register(req, res).then(() => true);
    if (path === '/authorize' && req.method === 'GET') return (this.authorizePage(res, Object.fromEntries(url.searchParams)), true);
    if (path === '/authorize' && req.method === 'POST') return this.authorizeSubmit(req, res).then(() => true);
    if (path === '/token' && req.method === 'POST') return this.token(req, res).then(() => true);
    return false;
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Body must be JSON.' });
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || !uris.every(allowedRedirect)) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs, or http://localhost.' });
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method "none") are supported.' });
    }
    const id = random(16);
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : undefined;
    this.state.clients[id] = { client_name: name, redirect_uris: uris, created: this.now() };
    // Keep the newest clients only; a registration costs nothing, so bound it.
    const ids = Object.entries(this.state.clients).sort((a, b) => a[1].created - b[1].created).map(([k]) => k);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_CLIENTS))) delete this.state.clients[old];
    this.save();
    json(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(this.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  /** The request's client and redirect, or a reason it can't go ahead (shown, never redirected to). */
  private check(p: Record<string, string>): { client: StoredClient } | { problem: string } {
    const client = this.state.clients[p.client_id ?? ''];
    if (!client) return { problem: 'Unknown client. Remove and re-add the connector, so it registers again.' };
    if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) return { problem: 'The redirect address is not one this client registered.' };
    if (p.response_type !== 'code') return { problem: 'Only response_type=code is supported.' };
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return { problem: 'PKCE with S256 is required.' };
    return { client };
  }

  private authorizePage(res: ServerResponse, p: Record<string, string>, error?: string): void {
    const c = this.check(p);
    if ('problem' in c) return html(res, 400, page('Cannot sign in', `<p>${escapeHtml(c.problem)}</p>`));
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .filter((k) => p[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p[k])}">`)
      .join('');
    const host = new URL(p.redirect_uri).host;
    html(
      res,
      error ? 401 : 200,
      page(
        'Allow access to your Brightspace?',
        `<p><b>${escapeHtml(c.client.client_name || 'An app')}</b> wants read-only access to your courses through this server.</p>
<p>After you allow it, you'll be sent to <b>${escapeHtml(host)}</b>. If you don't recognise that, close this page.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<label>Server token (D2L_HTTP_TOKEN)<br><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Allow</button></form>`
      )
    );
  }

  private async authorizeSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const p = await readParams(req);
    const now = this.now();
    this.failures = this.failures.filter((t) => t > now - 60_000);
    if (this.failures.length >= 5) return html(res, 429, page('Too many tries', '<p>Wait a minute and try again.</p>'));
    const c = this.check(p);
    if ('problem' in c) return html(res, 400, page('Cannot sign in', `<p>${escapeHtml(c.problem)}</p>`));
    if (!p.password || !sameSecret(p.password, this.opts.password)) {
      this.failures.push(now);
      return this.authorizePage(res, p, 'That is not the server token.');
    }
    const code = random();
    this.codes.set(code, { client_id: p.client_id, redirect_uri: p.redirect_uri, challenge: p.code_challenge, expires: now + CODE_TTL_MS });
    const back = new URL(p.redirect_uri);
    back.searchParams.set('code', code);
    if (p.state) back.searchParams.set('state', p.state);
    back.searchParams.set('iss', this.opts.issuer);
    res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  private issue(client_id: string): Record<string, unknown> {
    const access = random();
    const refresh = random();
    const nowS = Math.floor(this.now() / 1000);
    this.state.tokens[sha256(access)] = { client_id, kind: 'access', expires: nowS + ACCESS_TTL_S };
    this.state.tokens[sha256(refresh)] = { client_id, kind: 'refresh', expires: nowS + REFRESH_TTL_S };
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'd2l:read' };
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let p: Record<string, string>;
    try {
      p = await readParams(req);
    } catch {
      return json(res, 400, { error: 'invalid_request' });
    }
    if (p.grant_type === 'authorization_code') {
      const pending = this.codes.get(p.code ?? '');
      this.codes.delete(p.code ?? ''); // one use only, even when it fails
      if (!pending || pending.expires < this.now()) return json(res, 400, { error: 'invalid_grant', error_description: 'Code unknown or expired.' });
      if (pending.client_id !== p.client_id || pending.redirect_uri !== p.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'Code was issued to another client or redirect.' });
      if (!p.code_verifier || b64url(createHash('sha256').update(p.code_verifier).digest()) !== pending.challenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
      }
      return json(res, 200, this.issue(pending.client_id));
    }
    if (p.grant_type === 'refresh_token') {
      const key = sha256(p.refresh_token ?? '');
      const t = this.state.tokens[key];
      if (!t || t.kind !== 'refresh' || t.expires < this.now() / 1000 || (p.client_id && p.client_id !== t.client_id) || !this.state.clients[t.client_id]) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token unknown or expired.' });
      }
      delete this.state.tokens[key]; // rotate
      return json(res, 200, this.issue(t.client_id));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}
input[type=password]{width:100%;padding:.5rem;margin:.25rem 0 1rem;font:inherit;box-sizing:border-box}
button{padding:.5rem 1.25rem;font:inherit;cursor:pointer}.err{color:#b00020}
@media (prefers-color-scheme:dark){body{color:#eee;background:#181818}}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
