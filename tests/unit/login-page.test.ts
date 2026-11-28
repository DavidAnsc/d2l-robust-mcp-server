import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loginCredentials } from '../../src/config.js';
import { findSamlLink, isLoginPage, isMicrosoftLogin } from '../../src/login-page.js';

describe('findSamlLink', () => {
  // As it appears on wcdsb.elearningontario.ca: inside an HTML-encoded attribute, encoded twice.
  const page =
    '<d2l-html-block html="&lt;a rel=&quot;noopener&quot; href=&quot;/d2l/lp/auth/saml/initiate-login?entityId=' +
    'https%3A%2F%2Fsts.windows.net%2F723db893-17ed-44ec-8613-011938c37276%2F&amp;amp;target=%2fd2l%2fhome&quot;&gt;">';

  it('finds the Microsoft sign-in link and makes it absolute', () => {
    expect(findSamlLink(page, 'https://school.example')).toBe(
      'https://school.example/d2l/lp/auth/saml/initiate-login?entityId=' +
        'https%3A%2F%2Fsts.windows.net%2F723db893-17ed-44ec-8613-011938c37276%2F&target=%2fd2l%2fhome'
    );
  });

  it('returns null on a page without one', () => {
    expect(findSamlLink('<form><input name="userName"></form>', 'https://school.example')).toBeNull();
  });
});

describe('page kinds', () => {
  it('treats D2L and Microsoft sign-in pages as login pages', () => {
    expect(isLoginPage('https://school.example/d2l/login?target=%2fd2l%2fhome')).toBe(true);
    expect(isLoginPage('https://login.microsoftonline.com/abc/saml2?SAMLRequest=x')).toBe(true);
    expect(isLoginPage('https://school.example/d2l/home')).toBe(false);
    expect(isMicrosoftLogin('https://login.microsoftonline.com/abc/saml2')).toBe(true);
    expect(isMicrosoftLogin('https://school.example/d2l/login')).toBe(false);
  });
});

describe('loginCredentials', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('is undefined when nothing is set', () => {
    expect(loginCredentials({})).toBeUndefined();
  });

  it('reads the password from the environment or from a file', () => {
    expect(loginCredentials({ D2L_USERNAME: 'me@school.ca', D2L_PASSWORD: 'pw' })).toEqual({ username: 'me@school.ca', password: 'pw' });
    const dir = mkdtempSync(join(tmpdir(), 'd2l-pw-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'pw'), 'from file\n');
    expect(loginCredentials({ D2L_USERNAME: 'me@school.ca', D2L_PASSWORD_FILE: join(dir, 'pw') })?.password).toBe('from file');
  });

  it('refuses half a configuration', () => {
    expect(() => loginCredentials({ D2L_USERNAME: 'me@school.ca' })).toThrow(/both/);
    expect(() => loginCredentials({ D2L_PASSWORD: 'pw' })).toThrow(/both/);
  });
});
