import { describe, it, expect, afterEach } from 'vitest';
import {
  browserPath,
  d2lBaseUrl,
  d2lHost,
  defaultCourseId,
  httpConfig,
  isHeadlessOnly,
  resolveCourseId,
  sessionPath,
} from '../../src/config.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('d2lHost', () => {
  it('strips a scheme and trailing slash people paste in', () => {
    process.env.D2L_HOST = 'https://school.brightspace.com/';
    expect(d2lHost()).toBe('school.brightspace.com');
    expect(d2lBaseUrl()).toBe('https://school.brightspace.com');
  });

  it('is read when called, not at import', () => {
    process.env.D2L_HOST = 'a.example';
    expect(d2lHost()).toBe('a.example');
    process.env.D2L_HOST = 'b.example';
    expect(d2lHost()).toBe('b.example');
  });
});

describe('course IDs', () => {
  it('prefers the provided ID', () => {
    process.env.D2L_COURSE_ID = '111';
    expect(resolveCourseId(222)).toBe(222);
  });

  it('falls back to D2L_COURSE_ID', () => {
    process.env.D2L_COURSE_ID = '111';
    expect(resolveCourseId()).toBe(111);
  });

  it('explains what to do when there is none', () => {
    delete process.env.D2L_COURSE_ID;
    expect(() => resolveCourseId()).toThrow(/orgUnitId is required.*get_my_courses/);
  });

  it('rejects a malformed D2L_COURSE_ID instead of guessing', () => {
    process.env.D2L_COURSE_ID = '12abc';
    expect(() => defaultCourseId()).toThrow(/positive whole number/);
  });
});

describe('isHeadlessOnly', () => {
  it('honours D2L_HEADLESS=true', () => {
    process.env.D2L_HEADLESS = 'true';
    expect(isHeadlessOnly()).toBe(true);
  });

  it('honours D2L_HEADLESS=false even without a display', () => {
    process.env.D2L_HEADLESS = 'false';
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(isHeadlessOnly()).toBe(false);
  });

  it.runIf(process.platform === 'linux')('is true on Linux with no display', () => {
    delete process.env.D2L_HEADLESS;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(isHeadlessOnly()).toBe(true);
  });

  it.runIf(process.platform === 'linux')('is false on Linux with a display', () => {
    delete process.env.D2L_HEADLESS;
    process.env.DISPLAY = ':0';
    expect(isHeadlessOnly()).toBe(false);
  });
});

describe('sessionPath', () => {
  it('uses D2L_SESSION_PATH when set', () => {
    process.env.D2L_SESSION_PATH = '/var/lib/d2l/session';
    expect(sessionPath()).toBe('/var/lib/d2l/session');
  });

  it('defaults to ~/.d2l-session', () => {
    delete process.env.D2L_SESSION_PATH;
    expect(sessionPath()).toMatch(/\.d2l-session$/);
  });
});

describe('httpConfig', () => {
  it('defaults to loopback, port 3000, no download tool', () => {
    expect(httpConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      token: undefined,
      allowNoAuth: false,
      enableDownload: false,
      allowSessionPush: true,
      oauth: false,
      publicUrl: undefined,
      oauthStatePath: undefined,
    });
  });

  it('reads the OAuth settings', () => {
    const o = httpConfig({ D2L_OAUTH: 'true', D2L_PUBLIC_URL: 'https://pi.example.net/', D2L_OAUTH_STATE: '/tmp/o.json' });
    expect(o).toMatchObject({ oauth: true, publicUrl: 'https://pi.example.net', oauthStatePath: '/tmp/o.json' });
  });

  it('reads overrides', () => {
    const o = httpConfig({
      D2L_HTTP_HOST: '0.0.0.0',
      D2L_HTTP_PORT: '8080',
      D2L_HTTP_TOKEN: 'abc',
      D2L_HTTP_ENABLE_DOWNLOAD: 'true',
    });
    expect(o).toMatchObject({ host: '0.0.0.0', port: 8080, token: 'abc', enableDownload: true });
  });

  it('rejects a bad port', () => {
    expect(() => httpConfig({ D2L_HTTP_PORT: 'abc' })).toThrow(/D2L_HTTP_PORT/);
    expect(() => httpConfig({ D2L_HTTP_PORT: '70000' })).toThrow(/D2L_HTTP_PORT/);
  });
});

describe('browserPath', () => {
  const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const yes = () => true;
  const no = () => false;

  it('uses Google Chrome on macOS when it is installed', () => {
    delete process.env.D2L_BROWSER_PATH;
    expect(browserPath('darwin', yes)).toBe(MAC_CHROME);
  });

  it("falls back to Playwright's Chromium when Chrome is not there", () => {
    delete process.env.D2L_BROWSER_PATH;
    expect(browserPath('darwin', no)).toBeUndefined();
  });

  it('has no default on other platforms', () => {
    delete process.env.D2L_BROWSER_PATH;
    expect(browserPath('linux', yes)).toBeUndefined();
    expect(browserPath('win32', yes)).toBeUndefined();
  });

  it('prefers D2L_BROWSER_PATH, and "playwright" forces the bundled Chromium', () => {
    process.env.D2L_BROWSER_PATH = '/usr/bin/chromium';
    expect(browserPath('darwin', yes)).toBe('/usr/bin/chromium');
    process.env.D2L_BROWSER_PATH = 'playwright';
    expect(browserPath('darwin', yes)).toBeUndefined();
  });
});
