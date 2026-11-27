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

export function d2lHost(): string {
  return (process.env.D2L_HOST || DEFAULT_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '');
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
  };
}

/** When set, download_file only writes inside this folder. */
export function downloadRoot(): string | undefined {
  return process.env.D2L_DOWNLOAD_DIR || undefined;
}
