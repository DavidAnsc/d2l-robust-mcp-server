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
import { existsSync } from 'fs';
import { d2lBaseUrl, isHeadlessOnly, sessionPath } from './config.js';
import { markSessionExpired, markSessionValid, SessionExpiredError } from './session.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // Brightspace tokens last about an hour
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SSO_BUTTON = 'button.d2l-button-sso-1, button:has-text("Student & Staff Login")';

/** How long to wait for each step, depending on whether a person may be logging in. */
const TIMEOUTS = {
  ssoRedirect: { unattended: 15_000, interactive: 60_000 },
  tokenCapture: { unattended: 10_000, interactive: 120_000 },
  manualLogin: 120_000,
};

let tokenCache = { token: '', expiresAt: 0 };
let inFlight: Promise<string> | null = null;

function isLoginPage(url: string): boolean {
  return url.includes('login') || url.includes('microsoftonline') || url.includes('sso') || url.includes('adfs');
}

function launch(headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(sessionPath(), {
    headless,
    viewport: { width: 1280, height: 720 },
  });
}

function expired(): never {
  markSessionExpired();
  throw new SessionExpiredError();
}

/**
 * On a login page, press the school's single-sign-on button if there is one. A still-valid
 * SSO session then redirects back without anyone typing. Returns whether we left the login page.
 */
async function trySsoLogin(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    const button = page.locator(SSO_BUTTON);
    if (!(await button.isVisible())) return false;
    await button.click();
    await page.waitForURL((url) => !isLoginPage(url.toString()), { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
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
      if (await trySsoLogin(page, TIMEOUTS.ssoRedirect[mode])) {
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
  const hasSession = existsSync(sessionPath());
  const headlessOnly = isHeadlessOnly();
  if (!hasSession && headlessOnly) expired();

  // With a saved session, try quietly first; only show a window if a login is needed.
  let context = await launch(hasSession);
  try {
    let token = await captureToken(context, hasSession);
    if (token === null) {
      await context.close();
      if (headlessOnly) expired();
      console.error('Session expired, opening browser for login...');
      context = await launch(false);
      token = await captureToken(context, false);
    }
    if (!token) expired();

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
  inFlight ??= fetchToken().finally(() => {
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
 * A logged-in browser context, for requests that need the session's cookies rather than
 * the API token (file downloads). The caller must close it.
 */
export async function getAuthenticatedContext(): Promise<BrowserContext> {
  const hasSession = existsSync(sessionPath());
  const headlessOnly = isHeadlessOnly();
  if (!hasSession && headlessOnly) expired();

  let headless = hasSession;
  let context = await launch(headless);
  try {
    let page = await context.newPage();
    await page.goto(`${d2lBaseUrl()}/d2l/home`, { waitUntil: 'domcontentloaded' });

    const mode = headless ? 'unattended' : 'interactive';
    if (isLoginPage(page.url()) && !(await trySsoLogin(page, TIMEOUTS.ssoRedirect[mode]))) {
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
    markSessionValid();
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
