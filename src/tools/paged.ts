/**
 * Long Markdown documents (an assignment bundle, a whole unit's materials) returned in parts.
 * The document is built once and kept in memory for a while, so asking for the next part with
 * `offset` doesn't download everything again.
 */
import { z } from 'zod';
import { sliceText } from '../extract.js';

export const DEFAULT_PAGE_CHARS = 40_000;

const TTL_MS = 30 * 60 * 1000;
const MAX_DOCS = 4;
const docs = new Map<string, { at: number; text: string }>();

export function clearPagedDocs(): void {
  docs.clear();
}

export const pageParams = {
  offset: z.number().int().min(0).optional().describe('Character to start from, to read the next part. Default 0 (builds the document fresh).'),
  maxChars: z
    .number()
    .int()
    .min(2000)
    .max(200_000)
    .optional()
    .describe(`Most characters to return in one reply. Default ${DEFAULT_PAGE_CHARS}.`),
};

/**
 * One part of a document. `key` names the document (tool + arguments, without offset);
 * `build` makes it. At offset 0 it is always rebuilt, so a fresh call sees changes.
 */
export async function pagedDocument(
  key: string,
  offset: number | undefined,
  maxChars: number | undefined,
  build: () => Promise<string>
): Promise<string> {
  const start = offset ?? 0;
  let hit = start > 0 ? docs.get(key) : undefined;
  if (hit && Date.now() - hit.at > TTL_MS) hit = undefined;
  if (!hit) {
    hit = { at: Date.now(), text: await build() };
    docs.delete(key);
    docs.set(key, hit);
    while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value as string);
  }
  const { text } = hit;
  const { slice, next } = sliceText(text, start, maxChars ?? DEFAULT_PAGE_CHARS);
  if (start === 0 && next === null) return text;
  const header =
    `[Part: characters ${start}–${start + slice.length} of ${text.length}. ` +
    (next !== null ? `Call again with the same arguments and offset=${next} for the next part.]` : 'This is the last part.]');
  return `${header}\n\n${slice}`;
}

/** A stable key for a tool call's arguments, ignoring paging. */
export function docKey(tool: string, args: Record<string, unknown>): string {
  const { offset: _o, maxChars: _m, ...rest } = args;
  return `${tool}:${JSON.stringify(rest, Object.keys(rest).sort())}`;
}
