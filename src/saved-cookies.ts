/**
 * A copy of the login cookies kept next to the browser profile.
 *
 * Why: Chromium drops session cookies (ones with no expiry date) when the profile is
 * closed, and Brightspace's login cookies are session cookies on many sites. Without this
 * copy, `d2l-mcp-auth` logs in, closes the browser, and the next run finds itself logged
 * out. We save the cookies after every successful login check and put back any that
 * Chromium dropped when the profile is opened again.
 *
 * The file also records which D2L_HOST the login was for, so later commands run without
 * D2L_HOST still talk to the right school (see config.ts).
 */
import type { BrowserContext } from 'playwright';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { d2lHost, savedCookiesPath } from './config.js';

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

export interface SavedCookies {
  host: string;
  savedAt: string;
  cookies: Cookie[];
}

export function writeSavedCookies(cookies: Cookie[], host: string = d2lHost()): void {
  const file = savedCookiesPath();
  const data: SavedCookies = { host, savedAt: new Date().toISOString(), cookies };
  // As sensitive as the profile itself: owner-only.
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Save the context's current cookies. Call only when the context is known to be logged in. */
export async function saveCookies(context: BrowserContext): Promise<void> {
  writeSavedCookies(await context.cookies());
}

export function readSavedCookies(): SavedCookies | null {
  const file = savedCookiesPath();
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as SavedCookies;
    return Array.isArray(data.cookies) ? data : null;
  } catch {
    return null;
  }
}

const key = (c: Pick<Cookie, 'name' | 'domain' | 'path'>) => `${c.name}\u0000${c.domain}\u0000${c.path}`;

/** Which saved cookies to put back: unexpired ones the profile no longer has. */
export function cookiesToRestore(saved: Cookie[], present: Cookie[], now: number = Date.now()): Cookie[] {
  const have = new Set(present.map(key));
  return saved.filter((c) => !have.has(key(c)) && !(c.expires > 0 && c.expires * 1000 < now));
}

/** Put back cookies Chromium dropped when the profile was last closed. */
export async function restoreCookies(context: BrowserContext): Promise<void> {
  const saved = readSavedCookies();
  if (!saved || saved.host !== d2lHost()) return;
  const missing = cookiesToRestore(saved.cookies, await context.cookies());
  if (missing.length) await context.addCookies(missing);
}
