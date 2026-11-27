import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSessionPath,
  getSessionStatus,
  isHeadlessOnly,
  markSessionExpired,
  markSessionValid,
  parseExportFile,
  resetSessionStatus,
  SESSION_EXPIRED_MESSAGE,
} from '../../src/session.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
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

describe('getSessionPath', () => {
  it('uses D2L_SESSION_PATH when set', () => {
    process.env.D2L_SESSION_PATH = '/var/lib/d2l/session';
    expect(getSessionPath()).toBe('/var/lib/d2l/session');
  });

  it('defaults to ~/.d2l-session', () => {
    delete process.env.D2L_SESSION_PATH;
    expect(getSessionPath()).toMatch(/\.d2l-session$/);
  });
});

describe('session status', () => {
  beforeEach(() => resetSessionStatus());

  it('starts unknown', () => {
    expect(getSessionStatus().state).toBe('unknown');
    expect(getSessionStatus().lastSuccessAt).toBeNull();
  });

  it('records a valid session and token expiry', () => {
    const expiry = Date.now() + 3600000;
    markSessionValid(expiry);
    const s = getSessionStatus();
    expect(s.state).toBe('valid');
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.tokenExpiresAt).toBe(new Date(expiry).toISOString());
  });

  it('records expiry with the re-login instructions', () => {
    markSessionValid(Date.now());
    markSessionExpired();
    const s = getSessionStatus();
    expect(s.state).toBe('expired');
    expect(s.lastFailureAt).not.toBeNull();
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.tokenExpiresAt).toBeNull();
    expect(s.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(s.message).toContain('d2l-mcp-auth');
  });
});

describe('parseExportFile', () => {
  it('accepts an export file', () => {
    const f = parseExportFile(
      JSON.stringify({ format: 'd2l-mcp-session', version: 1, host: 'x', exportedAt: '', cookies: [] })
    );
    expect(f.cookies).toEqual([]);
  });

  it('rejects other JSON', () => {
    expect(() => parseExportFile(JSON.stringify({ cookies: [] }))).toThrow(/Not a d2l-mcp-auth/);
  });
});
