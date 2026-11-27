import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSessionStatus,
  markSessionExpired,
  markSessionValid,
  parseExportFile,
  resetSessionStatus,
  SESSION_EXPIRED_MESSAGE,
} from '../../src/session.js';

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
