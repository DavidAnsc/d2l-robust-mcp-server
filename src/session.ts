/**
 * Login-session state shared by the auth module, the API client and the tools:
 * whether the saved session last worked, the error raised when it has expired, and
 * the file format `d2l-mcp-auth --export` / `--import` use.
 */

export const SESSION_EXPIRED_MESSAGE =
  'D2L session expired or missing. Log in again by running `d2l-mcp-auth` on this machine ' +
  '(or on another machine, then copy it over with `d2l-mcp-auth --export` / `--import`).';

/** Thrown when the saved session can no longer produce an API token and no one can log in interactively. */
export class SessionExpiredError extends Error {
  constructor(message: string = SESSION_EXPIRED_MESSAGE) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export type SessionState = 'unknown' | 'valid' | 'expired';

export interface SessionStatus {
  state: SessionState;
  /** ISO time of the last successful token capture or API call. */
  lastSuccessAt: string | null;
  /** ISO time the session was last found to be expired. */
  lastFailureAt: string | null;
  /** ISO time the cached API token stops being reused (tokens are refreshed from the session after this). */
  tokenExpiresAt: string | null;
  message: string;
}

let state: SessionState = 'unknown';
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let tokenExpiresAt: number | null = null;

export function markSessionValid(tokenExpiry?: number): void {
  state = 'valid';
  lastSuccessAt = Date.now();
  if (tokenExpiry !== undefined) tokenExpiresAt = tokenExpiry;
}

export function markSessionExpired(): void {
  state = 'expired';
  lastFailureAt = Date.now();
  tokenExpiresAt = null;
}

export function getSessionStatus(): SessionStatus {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  const message =
    state === 'valid'
      ? 'Session is valid.'
      : state === 'expired'
        ? SESSION_EXPIRED_MESSAGE
        : 'Session has not been checked yet since the server started.';
  return {
    state,
    lastSuccessAt: iso(lastSuccessAt),
    lastFailureAt: iso(lastFailureAt),
    tokenExpiresAt: iso(tokenExpiresAt),
    message,
  };
}

/** Test helper. */
export function resetSessionStatus(): void {
  state = 'unknown';
  lastSuccessAt = null;
  lastFailureAt = null;
  tokenExpiresAt = null;
}

/** A cookie as Playwright's storageState() returns it. */
export interface ExportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** The file `d2l-mcp-auth --export` writes and `--import` reads. */
export interface ExportFile {
  format: 'd2l-mcp-session';
  version: 1;
  host: string;
  exportedAt: string;
  cookies: ExportedCookie[];
}

export function parseExportFile(text: string): ExportFile {
  const data = JSON.parse(text);
  if (data?.format !== 'd2l-mcp-session' || data.version !== 1 || !Array.isArray(data.cookies)) {
    throw new Error('Not a d2l-mcp-auth --export file.');
  }
  return data as ExportFile;
}
