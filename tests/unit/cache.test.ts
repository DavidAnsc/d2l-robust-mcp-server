import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { diskCacheGet, diskCachePut, pruneCache } from '../../src/cache.js';

let dir: string;
const entry = { filename: 'a.pdf', size: 10, extracted: { kind: 'pdf' as const, text: 'hello' } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd2l-cache-test-'));
  process.env.D2L_CACHE = 'on';
  process.env.D2L_CACHE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.D2L_CACHE = 'off';
  delete process.env.D2L_CACHE_DIR;
});

describe('disk text cache', () => {
  it('returns what was stored under the same key and stamp only', () => {
    diskCachePut('topic:1:2', '2026-11-01', entry);
    expect(diskCacheGet('topic:1:2', '2026-11-01')).toEqual(entry);
    expect(diskCacheGet('topic:1:2', '2026-11-02')).toBeUndefined(); // the file changed
    expect(diskCacheGet('topic:1:3', '2026-11-01')).toBeUndefined();
  });

  it('never stores without a stamp, images or failures', () => {
    diskCachePut('k', undefined, entry);
    diskCachePut('k', 's', { ...entry, extracted: { kind: 'image', text: '', image: { data: 'x', mimeType: 'image/png' } } });
    diskCachePut('k2', 's', { ...entry, extracted: { kind: 'pdf', text: 'bad', failed: true } });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is off when D2L_CACHE=off', () => {
    process.env.D2L_CACHE = 'off';
    diskCachePut('k', 's', entry);
    expect(diskCacheGet('k', 's')).toBeUndefined();
  });

  it('prunes the least recently used entries first', () => {
    for (const [i, name] of ['old', 'mid', 'new'].entries()) {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, 'x'.repeat(100));
      utimesSync(p, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
    }
    expect(pruneCache(dir, 150)).toBe(200);
    expect(readdirSync(dir)).toEqual(['new.json']);
  });
});
