import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'http';
import { timingSafeEqual, createHash } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpConfig } from './config.js';
import { createServer } from './server.js';
import { importCookies } from './auth.js';
import { d2lHost } from './config.js';
import { getSessionStatus, parseExportFile, SessionExpiredError } from './session.js';
import { sessionStatusReport } from './tools/session.js';
import { cleanMessage } from './server.js';

/** HttpConfig with the optional parts optional, for callers (and tests) that build it by hand. */
export type HttpOptions = Pick<HttpConfig, 'host' | 'port'> & Partial<Omit<HttpConfig, 'host' | 'port'>>;

function sameSecret(a: string, b: string): boolean {
  // Hash first so both buffers have equal length; timingSafeEqual needs that.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The token can arrive two ways:
 *  - `Authorization: Bearer <token>` header (preferred), or
 *  - as the last path segment, `/mcp/<token>`, for clients that only let you enter a URL.
 * Returns the MCP route the request is for, or null if it isn't one.
 */
function matchMcpRoute(pathname: string): { pathToken?: string } | null {
  if (pathname === '/mcp' || pathname === '/mcp/') return {};
  const m = pathname.match(/^\/mcp\/([^/]+)\/?$/);
  return m ? { pathToken: decodeURIComponent(m[1]) } : null;
}

function isAuthorized(req: IncomingMessage, opts: HttpOptions, pathToken?: string): boolean {
  if (!opts.token) return !!opts.allowNoAuth;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && sameSecret(header.slice(7).trim(), opts.token)) return true;
  if (pathToken !== undefined && sameSecret(pathToken, opts.token)) return true;
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** A session export is a few KB; refuse anything much bigger before reading it all. */
const MAX_SESSION_BODY = 1024 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * POST /session: replace the server's saved login with cookies from `d2l-mcp-auth --push`.
 * This is how a laptop re-logs the Pi in from anywhere, without SSH.
 */
async function handleSessionPush(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text: string;
  try {
    text = await readBody(req, MAX_SESSION_BODY);
  } catch {
    return sendJson(res, 413, { error: 'Body too large' });
  }

  let data;
  try {
    data = parseExportFile(text);
  } catch (error) {
    return sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid body' });
  }
  if (data.host !== d2lHost()) {
    return sendJson(res, 400, { error: `Session is for ${data.host}, but this server uses ${d2lHost()}.` });
  }

  try {
    const expiresAt = await importCookies(data.cookies);
    console.error(`Session replaced via POST /session (${data.cookies.length} cookies).`);
    return sendJson(res, 200, { state: 'valid', cookies: data.cookies.length, tokenExpiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return sendJson(res, 422, { state: 'expired', error: 'Those cookies do not log in. Log in again on the laptop, then push.' });
    }
    // Saved, but the check couldn't reach Brightspace (network, D2L down): say so.
    console.error('Session pushed, but checking it failed:', error);
    const reason = cleanMessage(error instanceof Error ? error.message : String(error));
    return sendJson(res, 502, { state: 'unknown', error: `Saved the login, but could not check it: ${reason}` });
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, opts: HttpOptions): Promise<void> {
  // Stateless: a fresh MCP server + transport per request. No session map to leak or expire,
  // and the D2L token cache (module-level) is still shared across requests.
  // download_file writes to this machine's disk, so remote clients only get it when asked for.
  const server = createServer({ enableDownload: opts.enableDownload ?? false });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function createHttpApp(opts: HttpOptions): Server {
  if (!opts.token && !opts.allowNoAuth) {
    throw new Error(
      'HTTP mode needs D2L_HTTP_TOKEN (a long random secret). ' +
        'Set D2L_HTTP_ALLOW_NO_AUTH=true only if something in front of this server already authenticates every request.'
    );
  }

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/health') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
        const live = url.searchParams.get('check') === 'true';
        if (live && !isAuthorized(req, opts)) {
          // A live check launches a browser; don't let anonymous callers trigger that.
          return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        }
        const status = live ? await sessionStatusReport(true) : getSessionStatus();
        // Unauthenticated callers only learn the state word, nothing else.
        const body = live ? status : { state: status.state };
        return sendJson(res, status.state === 'expired' ? 503 : 200, body);
      }

      if (url.pathname === '/session') {
        // Header token only: this endpoint changes state, so no token-in-URL form.
        if (!isAuthorized(req, opts)) return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        if (opts.allowSessionPush === false) return sendJson(res, 403, { error: 'Session push is off (D2L_HTTP_ALLOW_SESSION_PUSH=false).' });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
        return await handleSessionPush(req, res);
      }

      const route = matchMcpRoute(url.pathname);
      if (!route) return sendJson(res, 404, { error: 'Not found' });

      if (!isAuthorized(req, opts, route.pathToken)) {
        return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }

      if (req.method !== 'POST') {
        // Stateless server: no server-initiated SSE stream (GET) and no sessions to end (DELETE).
        return sendJson(
          res,
          405,
          { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
          { Allow: 'POST' }
        );
      }

      await handleMcp(req, res, opts);
    } catch (error) {
      console.error('HTTP request failed:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
}

export async function startHttpServer(opts: HttpOptions): Promise<Server> {
  const app = createHttpApp(opts);
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(opts.port, opts.host, () => resolve());
  });
  const addr = app.address();
  const where = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : `${opts.host}:${opts.port}`;
  console.error(`D2L Brightspace MCP server listening on http://${where}/mcp`);
  if (!opts.token) console.error('WARNING: running without D2L_HTTP_TOKEN (D2L_HTTP_ALLOW_NO_AUTH=true).');
  if (!['127.0.0.1', '::1', 'localhost'].includes(opts.host)) {
    console.error(`WARNING: bound to ${opts.host}, not loopback. Other machines on the network can reach it.`);
  }
  return app;
}
