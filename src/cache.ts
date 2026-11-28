/**
 * A disk cache of extracted file text, so reading the same slides for a second study guide
 * (or after a restart) doesn't download and parse them again.
 *
 * Entries are keyed by what the file is (course, topic, file id…) plus a "stamp" that changes
 * when the file does, such as the topic's last-modified date. A caller with no stamp should not
 * use this cache: a changed file would then never be noticed.
 *
 * Images are never cached here; only text. Least recently used entries are removed once the
 * folder grows past D2L_CACHE_MAX_MB.
 */
import { createHash } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cacheDir, cacheMaxBytes } from './config.js';
import type { Extracted } from './extract.js';

/** Bump when extraction changes, so old text is re-extracted. */
export const EXTRACT_VERSION = 2;

export interface CachedFile {
  filename: string;
  size: number;
  extracted: Extracted;
}

function entryPath(dir: string, key: string, stamp: string): string {
  const hash = createHash('sha256').update(`${EXTRACT_VERSION}|${key}|${stamp}`).digest('hex');
  return join(dir, `${hash.slice(0, 40)}.json`);
}

export function diskCacheGet(key: string, stamp: string | undefined): CachedFile | undefined {
  const dir = cacheDir();
  if (!dir || !stamp) return undefined;
  const file = entryPath(dir, key, stamp);
  try {
    const value = JSON.parse(readFileSync(file, 'utf-8')) as CachedFile;
    const now = new Date();
    utimesSync(file, now, now); // mark as recently used
    return value;
  } catch {
    return undefined;
  }
}

let writesSincePrune = 0;

export function diskCachePut(key: string, stamp: string | undefined, value: CachedFile): void {
  const dir = cacheDir();
  if (!dir || !stamp || value.extracted.image || value.extracted.failed) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(entryPath(dir, key, stamp), JSON.stringify(value), { mode: 0o600 });
    if (++writesSincePrune >= 20) {
      writesSincePrune = 0;
      pruneCache(dir, cacheMaxBytes());
    }
  } catch (error) {
    // A full or read-only disk must not break reading the file itself.
    console.error('Text cache write failed:', error instanceof Error ? error.message : error);
  }
}

/** Delete least recently used entries until the folder is under `maxBytes`. Returns bytes freed. */
export function pruneCache(dir: string, maxBytes: number): number {
  let entries: { path: string; size: number; used: number }[];
  try {
    entries = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const path = join(dir, n);
        const st = statSync(path);
        return { path, size: st.size, used: st.mtimeMs };
      });
  } catch {
    return 0;
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  let freed = 0;
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(e.path);
      total -= e.size;
      freed += e.size;
    } catch {
      // Already gone.
    }
  }
  return freed;
}
