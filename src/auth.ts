/**
 * Getting from the saved browser session to a Brightspace API token.
 *
 * Brightspace's own web pages call its API with a short-lived bearer token. We open the
 * home page in the saved Playwright profile, watch its outgoing API requests and keep the
 * token they carry. The profile's cookies are what keep you logged in between runs.
 *
 * When the profile is no longer logged in:
 *  - with a display: a visible browser window opens so you can log in;
 *  - headless-only (no display, or HTTP mode): SessionExpiredError, so the caller can tell you.
 */
import { chromium, BrowserContext, Page } from 'playwright';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { browserLaunchOptions, d2lBaseUrl, isHeadlessOnly, loginCredentials, sessionPath } from './config.js';
import { isLoginPage, tryAutoLogin } from './login-page.js';
import { markSessionExpired, markSessionValid, SessionExpiredError } from './session.js';
import { restoreCookies, saveCookies, writeSavedCookies } from './saved-cookies.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // Brightspace tokens last about an hour
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How long to wait for each step, depending on whether a person may be logging in. */
const TIMEOUTS = {
  ssoRedirect: { unattended: 15_000, interactive: 60_000 },
  passwordLogin: 60_000,
  tokenCapture: { unattended: 10_000, interactive: 120_000 },
  manualLogin: 120_000,
};

let tokenCache = { token: '', expiresAt: 0 };
let inFlight: Promise<string> | null = null;

/**
 * Chromium can only have the saved profile open once at a time. Every use of it (token
 * refresh, cookie-based download, session import) runs through this queue.
 */
let profileQueue: Promise<unknown> = Promise.resolve();
export function withProfile<T>(fn: () => Promise<T>): Promise<T> {
  const run = profileQueue.then(fn, fn);
  profileQueue = run.catch(() => undefined);
  return run;
}

/**
 * Open a browser on a saved profile. If no browser is installed (the Chromium download was
 * skipped or failed during `npm ci`), say how to fix it instead of Playwright's long message.
 */
export async function launchProfile(
  profile: string,
  options: { headless: boolean; viewport?: { width: number; height: number } }
): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(profile, { ...browserLaunchOptions(), ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist|Failed to launch.*(ENOENT|no such file)/is.test(message)) {
      const custom = process.env.D2L_BROWSER_PATH;
      throw new Error(
        custom
          ? `No browser at D2L_BROWSER_PATH=${custom}. Point it at a Chrome or Chromium that exists.`
          : 'No browser installed for logging in to Brightspace. Run `npx playwright install chromium` ' +
            'in the d2l-robust-mcp-server folder, or set D2L_BROWSER_PATH to a Chrome you already have ' +
            '(on a Mac: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").'
      );
    }
    throw error;
  }
}

/** Open the saved profile, putting back the login cookies Chromium dropped on the last close. */
async function launch(headless: boolean, restore = true): Promise<BrowserContext> {
  const context = await launchProfile(sessionPath(), { headless, viewport: { width: 1280, height: 720 } });
  if (restore) {
    try {
      await restoreCookies(context);
    } catch (error) {
      console.error('Could not restore saved cookies:', error instanceof Error ? error.message : error);
    }
  }
  return context;
}

function expired(): never {
  markSessionExpired();
  throw new SessionExpiredError();
}

/**
 * Open the home page and capture the bearer token from its API calls.
 * `unattended`: nobody is watching, so give up quickly if a login is needed.
 * Returns null when a login is needed and `unattended` is true.
 */
async function captureToken(context: BrowserContext, unattended: boolean): Promise<string | null> {
  const mode = unattended ? 'unattended' : 'interactive';
  const page = await context.newPage();
  let token = '';

  page.on('request', (request) => {
    if (!request.url().includes('/d2l/api/')) return;
    const auth = request.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  });

  try {
    await page.goto(`${d2lBaseUrl()}/d2l/home`, { waitUntil: 'networkidle' });

    if (isLoginPage(page.url())) {
      if (await tryAutoLogin(page, loginCredentials(), { sso: TIMEOUTS.ssoRedirect[mode], password: TIMEOUTS.passwordLogin })) {
        await page.waitForLoadState('networkidle');
      } else if (unattended) {
        return null;
      }
    }

    const deadline = Date.now() + TIMEOUTS.tokenCapture[mode];
    while (!token && Date.now() < deadline) {
      if (isLoginPage(page.url())) {
        if (unattended) return null;
        await page.waitForTimeout(2000); // a person is logging in
        continue;
      }
      // Logged in; nudge the page into making API calls if it hasn't yet.
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.scrollBy(0, 100));
      await page.waitForTimeout(1000);
    }

    if (!token) {
      if (unattended) return null;
      throw new Error('Failed to capture authentication token. Please try again.');
    }
    return token;
  } finally {
    await page.close();
  }
}

async function fetchToken(): Promise<string> {
  // With a saved session or automatic-login credentials, try quietly first; only show a
  // window if that fails and there is a screen to show it on.
  const quiet = existsSync(sessionPath()) || loginCredentials() !== undefined;
  const headlessOnly = isHeadlessOnly();
  if (!quiet && headlessOnly) expired();

  let context = await launch(quiet);
  try {
    let token = await captureToken(context, quiet);
    if (token === null) {
      await context.close();
      if (headlessOnly) expired();
      console.error('Session expired, opening browser for login...');
      context = await launch(false);
      token = await captureToken(context, false);
    }
    if (!token) expired();

    await saveCookies(context);
    tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    markSessionValid(tokenCache.expiresAt);
    return token;
  } finally {
    await context.close();
  }
}

/** A valid API token, from cache or from the saved session. */
export async function getToken(): Promise<string> {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.token;
  }
  // Several tool calls can arrive at once; launch at most one browser for them.
  inFlight ??= withProfile(fetchToken).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function clearTokenCache(): void {
  tokenCache = { token: '', expiresAt: 0 };
}

export function getTokenExpiry(): number {
  return tokenCache.expiresAt;
}

/**
 * Run `fn` with a logged-in browser context, for requests that need the session's cookies
 * rather than the API token (files under /content/). The context is closed afterwards.
 */
export function withAuthenticatedContext<T>(fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  return withProfile(async () => {
    const context = await getAuthenticatedContext();
    try {
      return await fn(context);
    } finally {
      await context.close();
    }
  });
}

/**
 * Replace the saved session's cookies (from `d2l-mcp-auth --export`, or pushed over HTTP),
 * then check that they work. Returns the new token's expiry.
 */
export async function importCookies(cookies: Parameters<BrowserContext['addCookies']>[0]): Promise<number> {
  await withProfile(async () => {
    mkdirSync(sessionPath(), { recursive: true, mode: 0o700 });
    chmodSync(sessionPath(), 0o700);
    const context = await launch(true, false);
    try {
      await context.clearCookies();
      await context.addCookies(cookies);
      // Keep the imported set as the saved copy too, so an older copy can't be restored over it.
      writeSavedCookies(await context.cookies());
    } finally {
      await context.close();
    }
  });
  clearTokenCache();
  await getToken();
  return tokenCache.expiresAt;
}

/** Use withAuthenticatedContext instead: this one is not queued. The caller must close it. */
async function getAuthenticatedContext(): Promise<BrowserContext> {
  const quiet = existsSync(sessionPath()) || loginCredentials() !== undefined;
  const headlessOnly = isHeadlessOnly();
  if (!quiet && headlessOnly) expired();

  let headless = quiet;
  let context = await launch(headless);
  try {
    let page = await context.newPage();
    await page.goto(`${d2lBaseUrl()}/d2l/home`, { waitUntil: 'domcontentloaded' });

    const mode = headless ? 'unattended' : 'interactive';
    const auto = { sso: TIMEOUTS.ssoRedirect[mode], password: TIMEOUTS.passwordLogin };
    if (isLoginPage(page.url()) && !(await tryAutoLogin(page, loginCredentials(), auto))) {
      if (headless) {
        await context.close();
        if (headlessOnly) expired();
        console.error('Session expired, opening browser for login...');
        headless = false;
        context = await launch(false);
        page = await context.newPage();
        await page.goto(`${d2lBaseUrl()}/d2l/home`, { waitUntil: 'domcontentloaded' });
      }
      // A person is at the window: wait for them to finish logging in.
      await page.waitForURL((url) => !isLoginPage(url.toString()), { timeout: TIMEOUTS.manualLogin });
    }

    await page.close();
    await saveCookies(context);
    markSessionValid();
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
