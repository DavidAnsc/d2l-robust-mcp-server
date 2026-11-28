import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { d2lHost, savedLoginHost } from '../../src/config.js';
import { cookiesToRestore, readSavedCookies, writeSavedCookies } from '../../src/saved-cookies.js';

const saved = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd2l-cookies-'));
  process.env.D2L_SESSION_PATH = dir;
  delete process.env.D2L_HOST;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const cookie = (name: string, expires = -1) => ({
  name, value: 'v', domain: 'school.example', path: '/', expires,
  httpOnly: true, secure: true, sameSite: 'Lax' as const,
});

describe('saved login cookies', () => {
  it('remembers the host, so a later run without D2L_HOST uses it', () => {
    expect(savedLoginHost()).toBeUndefined();
    writeSavedCookies([cookie('d2lSessionVal')], 'school.example');
    expect(savedLoginHost()).toBe('school.example');
    expect(d2lHost()).toBe('school.example');
    process.env.D2L_HOST = 'other.example';
    expect(d2lHost()).toBe('other.example');
  });

  it('writes the file owner-only', () => {
    writeSavedCookies([cookie('a')], 'school.example');
    expect(statSync(join(dir, 'd2l-mcp-cookies.json')).mode & 0o777).toBe(0o600);
    expect(readSavedCookies()?.cookies).toHaveLength(1);
  });

  it('restores only cookies the profile dropped, and not expired ones', () => {
    const now = Date.UTC(2026, 0, 1);
    const savedSet = [cookie('session'), cookie('persistent', now / 1000 + 3600), cookie('old', now / 1000 - 10)];
    const present = [cookie('persistent', now / 1000 + 7200)];
    expect(cookiesToRestore(savedSet, present, now).map((c) => c.name)).toEqual(['session']);
  });
});
