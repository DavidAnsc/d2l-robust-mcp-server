import { z } from 'zod';
import { client, D2LApiError, DownloadedFile } from '../client.js';
import { extractFile, Extracted, pagePictures, parsePageRange, sliceText } from '../extract.js';
import { formatFileSize, RawTopic } from '../utils/marshal.js';
import { fetchWithSession } from './files.js';
import { courseIdParam, resolveCourseId } from './common.js';
import { cacheDir } from '../config.js';
import { diskCacheGet, diskCachePut } from '../cache.js';
import { mapLimit } from '../content-tree.js';
import { SessionExpiredError } from '../session.js';
import { readRefSchema } from './refs.js';

/** Text or image blocks, as an MCP tool result carries them. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

const DEFAULT_MAX_CHARS = 40_000;
/** Most page pictures in one reply; each is roughly 100–300 KB. */
const MAX_PICTURES = 10;

const SOURCES = [
  'topic',
  'assignment_attachment',
  'submission_file',
  'feedback_file',
  'announcement_attachment',
  'overview_attachment',
  'url',
] as const;
type Source = (typeof SOURCES)[number];

export interface ReadArgs {
  source: Source;
  orgUnitId?: number;
  topicId?: number;
  assignmentId?: number;
  submissionId?: number;
  fileId?: number;
  entityId?: number;
  entityType?: 'user' | 'group';
  announcementId?: number;
  url?: string;
  offset?: number;
  maxChars?: number;
  asImages?: boolean;
  pages?: string;
}

export interface ReadFile {
  filename: string;
  size: number;
  extracted: Extracted;
}

/**
 * Recently read files, so reading a long PDF in parts downloads and parses it once.
 * Small on purpose: a Raspberry Pi has little memory.
 */
const CACHE_SIZE = 6;
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; file: ReadFile }>();

function cacheGet(key: string): ReadFile | undefined {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key); // re-insert: most recent last
  cache.set(key, hit);
  return hit.file;
}

function cachePut(key: string, file: ReadFile): void {
  cache.set(key, { at: Date.now(), file });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

export function clearReadCache(): void {
  cache.clear();
}

function need<T>(value: T | undefined, name: string, source: Source): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`source "${source}" needs ${name}.`);
  }
  return value;
}

/** A content topic's file; for Link topics (no file), says where the link goes instead. */
async function topicFile(orgUnitId: number, topicId: number): Promise<DownloadedFile | string> {
  try {
    const file = await client.getTopicFile(orgUnitId, topicId);
    if (!file.filename) {
      const topic = (await client.getContentTopic(orgUnitId, topicId)) as RawTopic;
      const fromUrl = topic.Url ? decodeURIComponent(topic.Url.split('?')[0].split('/').pop() || '') : '';
      file.filename = fromUrl || topic.Title;
    }
    return file;
  } catch (error) {
    if (!(error instanceof D2LApiError) || ![400, 404].includes(error.status)) throw error;
    const topic = (await client.getContentTopic(orgUnitId, topicId)) as RawTopic;
    if (!topic.Url) throw new Error(`Topic ${topicId} ("${topic.Title}") has no file or link.`);
    // A file kept on D2L but not served by the topic endpoint: fetch it with the browser session.
    if (topic.Url.startsWith('/content/')) return fetchWithSession(topic.Url);
    return `Topic "${topic.Title}" is a link, not a file: ${topic.Url}`;
  }
}

let myUserId: number | undefined;
async function currentUserId(): Promise<number> {
  if (myUserId === undefined) {
    const me = (await client.whoami()) as { Identifier: string };
    myUserId = Number(me.Identifier);
  }
  return myUserId;
}

async function download(args: ReadArgs): Promise<DownloadedFile | string> {
  const { source } = args;
  if (source === 'url') return fetchWithSession(need(args.url, 'url', source));

  const course = resolveCourseId(args.orgUnitId);
  switch (source) {
    case 'topic':
      return topicFile(course, need(args.topicId, 'topicId', source));
    case 'assignment_attachment':
      return client.getDropboxAttachment(course, need(args.assignmentId, 'assignmentId', source), need(args.fileId, 'fileId', source));
    case 'submission_file':
      return client.getSubmissionFile(
        course,
        need(args.assignmentId, 'assignmentId', source),
        need(args.submissionId, 'submissionId', source),
        need(args.fileId, 'fileId', source)
      );
    case 'feedback_file': {
      const a = need(args.assignmentId, 'assignmentId', source);
      const f = need(args.fileId, 'fileId', source);
      const type = args.entityType ?? 'user';
      if (args.entityId === undefined && type === 'group') need(args.entityId, 'entityId', source);
      const entity = args.entityId ?? (await currentUserId());
      return client.getFeedbackFile(course, a, type, entity, f);
    }
    case 'announcement_attachment':
      return client.getNewsAttachment(course, need(args.announcementId, 'announcementId', source), need(args.fileId, 'fileId', source));
    case 'overview_attachment':
      return client.getOverviewAttachment(course);
  }
}

/**
 * A stamp that changes when the file does, for the disk cache. Files with a fileId are
 * replaced, not edited, in Brightspace, so the id is enough; a topic needs its modified date.
 * Undefined means "don't use the disk cache".
 */
async function stampFor(args: ReadArgs, known?: string): Promise<string | undefined> {
  if (known) return known;
  if (!cacheDir()) return undefined;
  switch (args.source) {
    case 'assignment_attachment':
    case 'submission_file':
    case 'feedback_file':
    case 'announcement_attachment':
      return 'by-file-id';
    case 'topic': {
      if (!args.topicId) return undefined;
      try {
        const t = (await client.getContentTopic(resolveCourseId(args.orgUnitId), args.topicId!)) as RawTopic & { LastModifiedDate?: string };
        return t.LastModifiedDate || undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

export interface LoadOptions {
  /** Something that changes when the file does (e.g. a topic's LastModifiedDate). */
  stamp?: string;
  /** Reuse a recent in-memory copy even at offset 0. */
  preferCache?: boolean;
}

/**
 * Download and extract a file, using the memory cache (recent reads) and the disk cache
 * (text kept between runs). Returns a string when there is no file (e.g. a Link topic).
 */
export async function loadFile(args: ReadArgs, options: LoadOptions = {}): Promise<ReadFile | string> {
  const key = await keyFor(args);
  if (key && options.preferCache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const stamp = key ? await stampFor(args, options.stamp) : undefined;
  if (key && stamp) {
    const hit = diskCacheGet(key, stamp);
    if (hit) {
      cachePut(key, hit);
      return hit;
    }
  }
  const got = await download(args);
  if (typeof got === 'string') return got;
  const filename = got.filename || 'file';
  const file: ReadFile = { filename, size: got.data.length, extracted: await extractFile(got.data, filename, got.contentType) };
  if (key) {
    cachePut(key, file);
    diskCachePut(key, stamp, file);
  }
  return file;
}

function describe(file: ReadFile): string {
  const { kind, parts } = file.extracted;
  const unit = kind === 'pdf' ? 'pages' : kind === 'pptx' ? 'slides' : kind === 'xlsx' ? 'sheets' : '';
  const extra = parts !== undefined && unit ? `, ${parts} ${unit}` : '';
  return `File: ${file.filename} (${kind}, ${formatFileSize(file.size)}${extra})`;
}

/** Pictures of pages or slides, for diagrams, equations and scanned pages that text loses. */
async function readAsImages(args: ReadArgs): Promise<ToolContent[]> {
  const got = await download(args);
  if (typeof got === 'string') return [{ type: 'text', text: got }];
  const filename = got.filename || 'file';
  const pages = parsePageRange(args.pages, MAX_PICTURES);
  const pictures = await pagePictures(got.data, filename, got.contentType, pages);
  if (typeof pictures === 'string') return [{ type: 'text', text: `File: ${filename}\n${pictures}` }];
  const shown = [...new Set(pictures.map((p) => p.page))];
  const content: ToolContent[] = [
    { type: 'text', text: `File: ${filename}: pictures of page/slide ${shown.join(', ')}. Ask for others with pages="…" (up to ${MAX_PICTURES} at a time).` },
  ];
  for (const p of pictures.slice(0, 3 * MAX_PICTURES)) {
    content.push({ type: 'text', text: `Page/slide ${p.page}:` }, { type: 'image', data: p.data.toString('base64'), mimeType: p.mimeType });
  }
  return content;
}

export async function readFile(args: ReadArgs): Promise<ToolContent[]> {
  if (args.asImages) return readAsImages(args);
  const offset = args.offset ?? 0;
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;

  // A continuation (offset > 0) reuses the copy in memory; a fresh read checks for changes.
  const got = await loadFile(args, { preferCache: offset > 0 });
  if (typeof got === 'string') return [{ type: 'text', text: got }];
  const file = got;

  const { extracted } = file;
  const lines = [describe(file)];
  if (extracted.note) lines.push(`Note: ${extracted.note}`);

  if (extracted.image) {
    return [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', data: extracted.image.data, mimeType: extracted.image.mimeType },
    ];
  }

  const total = extracted.text.length;
  const { slice, next } = sliceText(extracted.text, offset, maxChars);
  if (offset > 0 || next !== null) {
    lines.push(
      `Showing characters ${offset}–${offset + slice.length} of ${total}.` +
        (next !== null ? ` Call read_file again with the same arguments and offset=${next} to continue.` : ' This is the end.')
    );
  }
  lines.push('', slice || '(no text)');
  return [{ type: 'text', text: lines.join('\n') }];
}

/** The cache key for args, without downloading anything (null if args are incomplete). */
async function keyFor(args: ReadArgs): Promise<string | null> {
  try {
    if (args.source === 'url') return args.url ? `url:${args.url}` : null;
    const c = resolveCourseId(args.orgUnitId);
    switch (args.source) {
      case 'topic':
        return `topic:${c}:${args.topicId}`;
      case 'assignment_attachment':
        return `att:${c}:${args.assignmentId}:${args.fileId}`;
      case 'submission_file':
        return `sub:${c}:${args.assignmentId}:${args.submissionId}:${args.fileId}`;
      case 'feedback_file': {
        const type = args.entityType ?? 'user';
        const entity = args.entityId ?? (type === 'user' ? myUserId : undefined);
        return entity === undefined ? null : `fb:${c}:${args.assignmentId}:${type}:${entity}:${args.fileId}`;
      }
      case 'announcement_attachment':
        return `news:${c}:${args.announcementId}:${args.fileId}`;
      case 'overview_attachment':
        return `overview:${c}`;
    }
  } catch {
    return null;
  }
}

/** Default characters per file in read_files, and the most in one reply overall. */
const BATCH_PER_FILE = 15_000;
const BATCH_TOTAL = 150_000;

interface BatchArgs {
  files: ReadArgs[];
  maxCharsPerFile?: number;
}

/**
 * Several files in one reply, each under its own header. A file longer than its share is cut,
 * and its header says exactly which read_file call gets the rest, so the agent decides what to
 * read in full. A file that fails says why without stopping the others.
 */
export async function readFiles(args: BatchArgs): Promise<ToolContent[]> {
  const per = Math.min(args.maxCharsPerFile ?? BATCH_PER_FILE, BATCH_TOTAL);
  const share = Math.max(2000, Math.min(per, Math.floor(BATCH_TOTAL / Math.max(1, args.files.length))));
  const parts = await mapLimit(args.files, 2, async (ref, i) => {
    const label = `[${i + 1}] ${JSON.stringify(ref)}`;
    try {
      const got = await loadFile(ref, { preferCache: true });
      if (typeof got === 'string') return `=== ${label}\n${got}`;
      const { extracted } = got;
      const lines = [`=== ${label}`, describe(got)];
      if (extracted.note) lines.push(`Note: ${extracted.note}`);
      if (extracted.image) {
        lines.push('(An image: read it with read_file to see it.)');
        return lines.join('\n');
      }
      const { slice, next } = sliceText(extracted.text, 0, share);
      if (next !== null) {
        lines.push(
          `Showing characters 0–${slice.length} of ${extracted.text.length}. ` +
            `For the rest: read_file ${JSON.stringify({ ...ref, offset: next })}`
        );
      }
      lines.push('', slice || '(no text)');
      return lines.join('\n');
    } catch (error) {
      if (error instanceof SessionExpiredError) throw error;
      return `=== ${label}\nCould not read: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  return [{ type: 'text', text: parts.join('\n\n') }];
}

const id = (what: string) => z.number().int().positive().optional().describe(what);

export const readTools = {
  read_file: {
    description:
      `Read a file from Brightspace and return its contents: text from PDF, Word (.docx), PowerPoint (.pptx, with speaker notes), ` +
      `Excel (.xlsx), HTML and plain-text/code files, or the image itself for PNG/JPEG/GIF/WebP. The file itself is never saved (only its extracted text, in the server's cache). ` +
      `Pick "source" and pass the IDs other tools return:\n` +
      `- topic: topicId (a lecture/reading file from get_course_content or get_course_module)\n` +
      `- assignment_attachment: assignmentId + fileId (from get_assignment attachments)\n` +
      `- submission_file: assignmentId + submissionId + fileId (what you submitted, from get_assignment_submissions)\n` +
      `- feedback_file: assignmentId + fileId (from feedbackFiles in get_assignment_submissions; entityId/entityType only for group assignments)\n` +
      `- announcement_attachment: announcementId + fileId (from get_announcements attachments)\n` +
      `- overview_attachment: the course overview/syllabus file (see get_course_overview)\n` +
      `- url: a /content/enforced/... path or https URL on the school's Brightspace host\n` +
      `Long files come in parts: the reply says which offset to pass to continue. ` +
      `Set asImages=true (with pages) to see slides or pages as pictures, which keeps diagrams and equations.`,
    schema: {
      source: z.enum(SOURCES).describe('Where the file comes from; decides which IDs are needed.'),
      orgUnitId: courseIdParam,
      topicId: id('For source "topic": the topic id.'),
      assignmentId: id('For assignment, submission and feedback files: the assignment id.'),
      submissionId: id('For source "submission_file": the submissionId.'),
      fileId: id('The fileId of the attachment, submitted file or feedback file.'),
      entityId: id('For "feedback_file" on a group assignment: the entityId from get_assignment_submissions.'),
      entityType: z.enum(['user', 'group']).optional().describe('For "feedback_file": defaults to "user".'),
      announcementId: id('For source "announcement_attachment": the announcement id.'),
      url: z.string().optional().describe('For source "url": a D2L path such as /content/enforced/12345-CS101/notes.pdf'),
      offset: z.number().int().min(0).optional().describe('Character to start from, for reading a long file in parts. Default 0.'),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(200_000)
        .optional()
        .describe(`Most characters to return in one reply. Default ${DEFAULT_MAX_CHARS}.`),
      asImages: z
        .boolean()
        .optional()
        .describe('Return pictures of pages/slides instead of text: for diagrams, equations, charts and scanned pages. PDF, PowerPoint, Word.'),
      pages: z.string().optional().describe(`With asImages: which pages or slides, e.g. "3", "2-5", "1,4,7-9". Default the first ${MAX_PICTURES}.`),
    },
    handler: readFile,
  },

  read_files: {
    description:
      `Read several files in one call (up to 20): pass the "read" references that other tools list ` +
      `(list_unit_items, get_course_content, get_assignment, find_related, search_course, get_announcements, ` +
      `get_assignment_submissions). Each file comes under its own header. A file longer than its share ` +
      `(maxCharsPerFile, default ${BATCH_PER_FILE}; ${BATCH_TOTAL} in total) is cut, and its header gives the exact read_file ` +
      `call for the rest. Use it to read the files that matter in batches rather than one at a time.`,
    schema: {
      files: z.array(readRefSchema).min(1).max(20).describe('File references to read, in the order you want them.'),
      maxCharsPerFile: z.number().int().min(2000).max(BATCH_TOTAL).optional().describe(`Most characters per file (default ${BATCH_PER_FILE}).`),
    },
    handler: readFiles,
  },
};
