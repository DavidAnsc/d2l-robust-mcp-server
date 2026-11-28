import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * All environment-driven settings in one place.
 *
 * Read lazily (functions, not constants) so a value set after import, by a test or by
 * the CLI entry point, is still picked up.
 */

/** Kept for compatibility with the original project's default. Set D2L_HOST for your school. */
export const DEFAULT_HOST = 'learn.ul.ie';

/**
 * The Brightspace host: D2L_HOST, else the host the saved login was made for, else the default.
 * The middle step means `D2L_HOST=x d2l-mcp-auth` followed by a plain `d2l-mcp-auth --status`
 * checks x, not the default.
 */
export function d2lHost(): string {
  return (process.env.D2L_HOST || savedLoginHost() || DEFAULT_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export function d2lBaseUrl(): string {
  return `https://${d2lHost()}`;
}

/** Brightspace API versions used for the two API families. */
export const API_VERSION = {
  le: '1.57', // Learning Environment: content, grades, dropbox, calendar, news
  lp: '1.43', // Learning Platform: users, enrollments
} as const;

export function defaultCourseId(): number | undefined {
  const raw = process.env.D2L_COURSE_ID;
  if (!raw) return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`D2L_COURSE_ID must be a positive whole number, got "${raw}".`);
  }
  return id;
}

/** The course to query: the one the caller gave, else D2L_COURSE_ID. */
export function resolveCourseId(provided?: number): number {
  const id = provided ?? defaultCourseId();
  if (!id) {
    throw new Error(
      'orgUnitId is required. Pass it (get_my_courses lists them) or set the D2L_COURSE_ID environment variable.'
    );
  }
  return id;
}

/**
 * IANA time zone for dates in tool output, e.g. "America/Toronto".
 * Undefined means the machine's own zone, which on a server is often UTC.
 */
export function displayTimeZone(): string | undefined {
  return process.env.D2L_TIMEZONE || undefined;
}

/**
 * Where the Playwright browser profile (cookies, SSO state) lives.
 * Override with D2L_SESSION_PATH, e.g. when running as a dedicated service user.
 */
export function sessionPath(): string {
  return process.env.D2L_SESSION_PATH || join(homedir(), '.d2l-session');
}

/** The copy of the login cookies kept beside the profile (see saved-cookies.ts). */
export function savedCookiesPath(): string {
  return join(sessionPath(), 'd2l-mcp-cookies.json');
}

/** The host recorded with the saved login, if there is one. */
export function savedLoginHost(): string | undefined {
  const file = savedCookiesPath();
  if (!existsSync(file)) return undefined;
  try {
    const host = (JSON.parse(readFileSync(file, 'utf-8')) as { host?: unknown }).host;
    return typeof host === 'string' && host ? host : undefined;
  } catch {
    return undefined;
  }
}

export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * The school account to sign in with automatically when the D2L session ends:
 * D2L_USERNAME plus D2L_PASSWORD, or D2L_PASSWORD_FILE (a file holding just the password,
 * which keeps it out of the process environment). Undefined when not configured.
 */
export function loginCredentials(env: NodeJS.ProcessEnv = process.env): LoginCredentials | undefined {
  const username = env.D2L_USERNAME?.trim();
  let password = env.D2L_PASSWORD;
  if (!password && env.D2L_PASSWORD_FILE) {
    try {
      password = readFileSync(env.D2L_PASSWORD_FILE, 'utf-8').replace(/\r?\n$/, '');
    } catch (error) {
      throw new Error(`Cannot read D2L_PASSWORD_FILE (${env.D2L_PASSWORD_FILE}): ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!username && !password) return undefined;
  if (!username || !password) {
    throw new Error('Automatic login needs both D2L_USERNAME and D2L_PASSWORD (or D2L_PASSWORD_FILE); only one is set.');
  }
  return { username, password };
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name]?.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

/**
 * True when the server must never open a visible browser window: either it was
 * asked to (D2L_HEADLESS=true, or HTTP mode), or there is no display to show
 * one on (a Linux box without X/Wayland, such as a headless Raspberry Pi).
 */
export function isHeadlessOnly(): boolean {
  const flag = envFlag('D2L_HEADLESS');
  if (flag !== undefined) return flag;
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Shared secret clients must send. */
  token?: string;
  /** Run without a token, for when something in front (e.g. Cloudflare Access) already authenticates. */
  allowNoAuth: boolean;
  /** Expose download_file, which writes to this machine's disk. */
  enableDownload: boolean;
  /** Accept a fresh login at POST /session (from `d2l-mcp-auth --push`). Default true. */
  allowSessionPush: boolean;
}

export function httpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const port = Number(env.D2L_HTTP_PORT || '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid D2L_HTTP_PORT: ${env.D2L_HTTP_PORT}`);
  }
  const download = env.D2L_HTTP_ENABLE_DOWNLOAD?.toLowerCase();
  return {
    host: env.D2L_HTTP_HOST || '127.0.0.1',
    port,
    token: env.D2L_HTTP_TOKEN || undefined,
    allowNoAuth: env.D2L_HTTP_ALLOW_NO_AUTH === 'true',
    enableDownload: download === 'true' || download === '1',
    allowSessionPush: !['false', '0'].includes(env.D2L_HTTP_ALLOW_SESSION_PUSH?.toLowerCase() ?? ''),
  };
}

/**
 * Where to send a message when the login session expires, e.g. https://ntfy.sh/<your-topic>.
 * The message is POSTed as plain text.
 */
export function notifyUrl(): string | undefined {
  return process.env.D2L_NOTIFY_URL || undefined;
}

/** Where Google Chrome is installed by default, per platform. Used when it exists. */
export const SYSTEM_CHROME: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};

/**
 * Which browser binary to launch, or undefined for the Chromium Playwright downloaded:
 *  1. D2L_BROWSER_PATH, if set (D2L_BROWSER_PATH=playwright forces Playwright's own);
 *  2. else Google Chrome at its default location, if it is installed there (macOS);
 *  3. else Playwright's Chromium.
 */
export function browserPath(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  const configured = process.env.D2L_BROWSER_PATH;
  if (configured) return configured.toLowerCase() === 'playwright' ? undefined : configured;
  const chrome = SYSTEM_CHROME[platform];
  return chrome && exists(chrome) ? chrome : undefined;
}

/** Options for launching the browser (see browserPath). */
export function browserLaunchOptions(): { executablePath?: string } {
  const path = browserPath();
  return path ? { executablePath: path } : {};
}

/** Largest file read_file will fetch, in bytes (D2L_MAX_FILE_MB, default 50). */
export function maxFileBytes(): number {
  const mb = Number(process.env.D2L_MAX_FILE_MB || '50');
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

/** When set, download_file only writes inside this folder. */
export function downloadRoot(): string | undefined {
  return process.env.D2L_DOWNLOAD_DIR || undefined;
}
