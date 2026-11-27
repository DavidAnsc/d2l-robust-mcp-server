import { z } from 'zod';
import { client, D2LApiError, DownloadedFile } from '../client.js';
import { extractFile, Extracted, sliceText } from '../extract.js';
import { formatFileSize, RawTopic } from '../utils/marshal.js';
import { fetchWithSession } from './files.js';
import { courseIdParam, resolveCourseId } from './common.js';

/** Text or image blocks, as an MCP tool result carries them. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

const DEFAULT_MAX_CHARS = 40_000;

const SOURCES = [
  'topic',
  'assignment_attachment',
  'submission_file',
  'feedback_file',
  'announcement_attachment',
  'url',
] as const;
type Source = (typeof SOURCES)[number];

interface ReadArgs {
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
}

interface ReadFile {
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

async function download(args: ReadArgs): Promise<{ key: string; file: DownloadedFile | string }> {
  const { source } = args;
  if (source === 'url') {
    const url = need(args.url, 'url', source);
    return { key: `url:${url}`, file: await fetchWithSession(url) };
  }

  const course = resolveCourseId(args.orgUnitId);
  switch (source) {
    case 'topic': {
      const topicId = need(args.topicId, 'topicId', source);
      return { key: `topic:${course}:${topicId}`, file: await topicFile(course, topicId) };
    }
    case 'assignment_attachment': {
      const a = need(args.assignmentId, 'assignmentId', source);
      const f = need(args.fileId, 'fileId', source);
      return { key: `att:${course}:${a}:${f}`, file: await client.getDropboxAttachment(course, a, f) };
    }
    case 'submission_file': {
      const a = need(args.assignmentId, 'assignmentId', source);
      const s = need(args.submissionId, 'submissionId', source);
      const f = need(args.fileId, 'fileId', source);
      return { key: `sub:${course}:${a}:${s}:${f}`, file: await client.getSubmissionFile(course, a, s, f) };
    }
    case 'feedback_file': {
      const a = need(args.assignmentId, 'assignmentId', source);
      const f = need(args.fileId, 'fileId', source);
      const type = args.entityType ?? 'user';
      if (args.entityId === undefined && type === 'group') need(args.entityId, 'entityId', source);
      const entity = args.entityId ?? (await currentUserId());
      return {
        key: `fb:${course}:${a}:${type}:${entity}:${f}`,
        file: await client.getFeedbackFile(course, a, type, entity, f),
      };
    }
    case 'announcement_attachment': {
      const n = need(args.announcementId, 'announcementId', source);
      const f = need(args.fileId, 'fileId', source);
      return { key: `news:${course}:${n}:${f}`, file: await client.getNewsAttachment(course, n, f) };
    }
  }
}

function describe(file: ReadFile): string {
  const { kind, parts } = file.extracted;
  const unit = kind === 'pdf' ? 'pages' : kind === 'pptx' ? 'slides' : kind === 'xlsx' ? 'sheets' : '';
  const extra = parts !== undefined && unit ? `, ${parts} ${unit}` : '';
  return `File: ${file.filename} (${kind}, ${formatFileSize(file.size)}${extra})`;
}

export async function readFile(args: ReadArgs): Promise<ToolContent[]> {
  const offset = args.offset ?? 0;
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;

  // Only reuse the cache on a continuation (offset > 0), so a fresh read sees a changed file.
  const cacheKey = await keyFor(args);
  let file = offset > 0 && cacheKey ? cacheGet(cacheKey) : undefined;
  if (!file) {
    const { key, file: got } = await download(args);
    if (typeof got === 'string') return [{ type: 'text', text: got }];
    const filename = got.filename || 'file';
    file = { filename, size: got.data.length, extracted: await extractFile(got.data, filename, got.contentType) };
    cachePut(key, file);
  }

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
    }
  } catch {
    return null;
  }
}

const id = (what: string) => z.number().int().positive().optional().describe(what);

export const readTools = {
  read_file: {
    description:
      `Read a file from Brightspace and return its contents: text from PDF, Word (.docx), PowerPoint (.pptx, with speaker notes), ` +
      `Excel (.xlsx), HTML and plain-text/code files, or the image itself for PNG/JPEG/GIF/WebP. Nothing is saved anywhere. ` +
      `Pick "source" and pass the IDs other tools return:\n` +
      `- topic: topicId (a lecture/reading file from get_course_content or get_course_module)\n` +
      `- assignment_attachment: assignmentId + fileId (from get_assignment attachments)\n` +
      `- submission_file: assignmentId + submissionId + fileId (what you submitted, from get_assignment_submissions)\n` +
      `- feedback_file: assignmentId + fileId (from feedbackFiles in get_assignment_submissions; entityId/entityType only for group assignments)\n` +
      `- announcement_attachment: announcementId + fileId (from get_announcements attachments)\n` +
      `- url: a /content/enforced/... path or https URL on the school's Brightspace host\n` +
      `Long files come in parts: the reply says which offset to pass to continue.`,
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
    },
    handler: readFile,
  },
};
