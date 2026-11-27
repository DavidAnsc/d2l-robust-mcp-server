import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'http';
import { timingSafeEqual, createHash } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, ServerOptions } from './server.js';
import { getSessionStatus } from './session.js';
import { sessionStatusText } from './server.js';

export interface HttpOptions extends ServerOptions {
  host: string;
  port: number;
  /** Shared secret clients must send. Undefined only when allowNoAuth is set. */
  token?: string;
  /** Run without a token, for when something in front (e.g. Cloudflare Access) already authenticates. */
  allowNoAuth?: boolean;
}

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const port = parseInt(env.D2L_HTTP_PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid D2L_HTTP_PORT: ${env.D2L_HTTP_PORT}`);
  }
  const download = env.D2L_HTTP_ENABLE_DOWNLOAD?.toLowerCase();
  return {
    host: env.D2L_HTTP_HOST || '127.0.0.1',
    port,
    token: env.D2L_HTTP_TOKEN || undefined,
    allowNoAuth: env.D2L_HTTP_ALLOW_NO_AUTH === 'true',
    // download_file writes to this machine's disk, so it is off for remote clients unless asked for.
    enableDownload: download === 'true' || download === '1',
  };
}

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

async function handleMcp(req: IncomingMessage, res: ServerResponse, opts: HttpOptions): Promise<void> {
  // Stateless: a fresh MCP server + transport per request. No session map to leak or expire,
  // and the D2L token cache (module-level) is still shared across requests.
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
        const status = live ? JSON.parse(await sessionStatusText(true)) : getSessionStatus();
        // Unauthenticated callers only learn the state word, nothing else.
        const body = live ? status : { state: status.state };
        return sendJson(res, status.state === 'expired' ? 503 : 200, body);
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
