/**
 * Getting past a Brightspace login page without a person.
 *
 *  1. The school's single-sign-on button, if it has one (a still-valid SSO session then
 *     redirects straight back).
 *  2. With D2L_USERNAME and D2L_PASSWORD (or D2L_PASSWORD_FILE) set: follow the page's
 *     Microsoft sign-in link (Brightspace's `saml/initiate-login`), fill in Microsoft's
 *     email and password pages, answer "Stay signed in?", and come back to D2L.
 *
 * It stops, with a message, at anything it can't do: a wrong password, two-step
 * verification, or a page it doesn't recognise. A rejected password is not tried again in
 * the same process, so repeated tool calls can't lock the account.
 */
import type { Page } from 'playwright';
import { createHash } from 'crypto';
import { d2lBaseUrl, LoginCredentials } from './config.js';
import { markSessionExpired, SessionExpiredError } from './session.js';

const SSO_BUTTON = 'button.d2l-button-sso-1, button:has-text("Student & Staff Login")';
const SAML_LINK = /\/d2l\/lp\/auth\/saml\/initiate-login\?entityId=[^"'<>\s]+/;

// Microsoft sign-in page (login.microsoftonline.com). Old and new page designs both covered.
const MS = {
  email: 'input[name="loginfmt"]:visible',
  password: 'input[name="passwd"]:visible, input[type="password"]:visible',
  submit: '#idSIButton9:visible, button[type="submit"]:visible, input[type="submit"]:visible',
  error: '#usernameError:visible, #passwordError:visible, #errorText:visible, [role="alert"]:visible',
  /** "Stay signed in?" */
  staySignedIn: '#KmsiDescription:visible, :text-matches("Stay signed in\\?", "i"):visible',
  /** Two-step verification, or a prompt to set it up. */
  twoStep:
    'input[name="otc"]:visible, #idDiv_SAOTCS_Proofs:visible, #idRichContext_DisplaySign:visible, ' +
    ':text-matches("Approve sign.in request|Enter code|Verify your identity|More information required", "i"):visible',
};

export function isLoginPage(url: string): boolean {
  return url.includes('login') || url.includes('microsoftonline') || url.includes('sso') || url.includes('adfs');
}

export function isMicrosoftLogin(url: string): boolean {
  return /^https:\/\/login\.(microsoftonline|microsoft|live)\.com\//.test(url);
}

/** The login was turned down: wrong credentials, or a step a program can't do. */
export class AutoLoginError extends SessionExpiredError {
  constructor(message: string) {
    super(message);
    this.name = 'AutoLoginError';
  }
}

let rejected: string | null = null;
const fingerprint = (c: LoginCredentials) => createHash('sha256').update(`${c.username}\0${c.password}`).digest('hex');

/** For tests. */
export function resetRejectedCredentials(): void {
  rejected = null;
}

function fail(message: string): never {
  markSessionExpired();
  throw new AutoLoginError(message);
}

/** The Microsoft sign-in link on a D2L login page, as an absolute URL, or null. */
export function findSamlLink(html: string, base: string = d2lBaseUrl()): string | null {
  // The link sits inside an HTML-encoded attribute (sometimes encoded twice): decode fully first.
  let text = html;
  for (let i = 0; i < 3; i++) {
    text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  const m = SAML_LINK.exec(text);
  return m ? new URL(m[0], base).toString() : null;
}

/**
 * On a login page, press the school's single-sign-on button if there is one. Returns
 * whether we left the login page.
 */
export async function trySsoLogin(page: Page, timeoutMs: number): Promise<boolean> {
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

/** The error Microsoft shows under a field (wrong email or password), or ''. */
async function errorText(page: Page): Promise<string> {
  const texts = await page.locator(MS.error).allInnerTexts().catch(() => [] as string[]);
  return texts.map((t) => t.trim()).filter(Boolean).join(' ');
}

/**
 * Type into a field and press the page's submit button. Microsoft's page can still be
 * setting itself up and clear a value typed too early, so wait for it, and check the value
 * stuck before submitting.
 */
async function fillAndSubmit(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const field = page.locator(selector).first();
  for (let attempt = 0; attempt < 5; attempt++) {
    await field.fill(value);
    await page.waitForTimeout(500);
    if ((await field.inputValue().catch(() => '')) === value) {
      await page.locator(MS.submit).first().click();
      return;
    }
  }
  fail('Could not type into the Microsoft sign-in page (it kept clearing the field). Run `d2l-mcp-auth` to log in yourself.');
}

const visible = (page: Page, selector: string) => page.locator(selector).first().isVisible().catch(() => false);

/**
 * Work through Microsoft's sign-in pages until we are back on D2L. Each pass looks at
 * which page is showing and does that page's one step.
 */
async function microsoftLogin(page: Page, credentials: LoginCredentials, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let sentEmail = false;
  let sentPassword = false;

  while (Date.now() < deadline) {
    const url = page.url();
    if (!isLoginPage(url)) return; // back on D2L
    if (!isMicrosoftLogin(url)) {
      await page.waitForTimeout(500); // a redirect in between
      continue;
    }

    const said = sentEmail || sentPassword ? await errorText(page) : '';
    if (said) {
      rejected = fingerprint(credentials);
      fail(
        `Microsoft did not accept D2L_USERNAME / D2L_PASSWORD: "${said}". ` +
          'Fix them and restart; they will not be retried until then (to avoid locking the account).'
      );
    }
    if (await visible(page, MS.twoStep)) {
      fail('Microsoft asked for two-step verification, which automatic login cannot do. Run `d2l-mcp-auth` to log in yourself.');
    }

    // Email before password: the email page also holds a password box (for browser
    // autofill) that counts as visible, so the password step is when the email box is gone.
    const emailShown = await visible(page, MS.email);
    if (await visible(page, MS.staySignedIn)) {
      await page.locator(MS.submit).first().click(); // "Yes": keeps the Microsoft login for next time
    } else if (emailShown && !sentEmail) {
      await fillAndSubmit(page, MS.email, credentials.username);
      sentEmail = true;
    } else if (!emailShown && !sentPassword && (await visible(page, MS.password))) {
      await fillAndSubmit(page, MS.password, credentials.password);
      sentPassword = true;
    } else if (await visible(page, `[data-test-id="${credentials.username}"]`)) {
      await page.locator(`[data-test-id="${credentials.username}"]`).first().click(); // "Pick an account"
    }
    await page.waitForTimeout(1000);
  }
  fail(`Microsoft sign-in did not finish within ${Math.round(timeoutMs / 1000)}s (stuck at ${new URL(page.url()).host}). Run \`d2l-mcp-auth\` to log in yourself.`);
}

/**
 * From a D2L login page, sign in with Microsoft using the given credentials. Returns false
 * when the page offers no Microsoft sign-in; throws AutoLoginError when sign-in fails.
 */
export async function tryMicrosoftLogin(page: Page, credentials: LoginCredentials, timeoutMs: number): Promise<boolean> {
  if (!isMicrosoftLogin(page.url())) {
    const link = findSamlLink(await page.content());
    if (!link) return false;
    if (rejected === fingerprint(credentials)) {
      fail(
        'Microsoft already rejected D2L_USERNAME / D2L_PASSWORD since this server started, so they were not ' +
          'tried again (to avoid locking the account). Fix them and restart, or run `d2l-mcp-auth`.'
      );
    }
    // Microsoft's page redirects to itself a few times while loading; let that settle.
    await page.goto(link, { waitUntil: 'networkidle' });
  }
  await microsoftLogin(page, credentials, timeoutMs);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return true;
}

/** Try every way of logging in that needs no person. Returns whether we left the login page. */
export async function tryAutoLogin(
  page: Page,
  credentials: LoginCredentials | undefined,
  timeouts: { sso: number; password: number }
): Promise<boolean> {
  if (await trySsoLogin(page, timeouts.sso)) return true;
  if (!credentials) return false;
  const ok = await tryMicrosoftLogin(page, credentials, timeouts.password);
  if (ok) console.error('D2L session had ended; signed in again as D2L_USERNAME.');
  return ok;
}
