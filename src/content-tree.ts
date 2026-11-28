/**
 * Working with a course's content outline (the table of contents): finding modules, walking
 * them, and telling what each topic is (a file, a web page, a link, a quiz, an external tool…).
 */
import { client } from './client.js';
import { stripHtml } from './utils/marshal.js';

export interface RawTocTopic {
  TopicId: number;
  Title: string;
  Url?: string;
  TypeIdentifier?: string;
  /** Brightspace's activity kind: 1 file, 2 link, 3 assignment, 4 quiz, 5–6 discussion, 7 LTI, 10 checklist, 12 survey, 20–23 SCORM. */
  ActivityType?: number;
  /** For topics that point at a tool (an assignment, a quiz…): that item's id. */
  ToolItemId?: number | null;
  GradeItemId?: number | null;
  LastModifiedDate?: string | null;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  IsHidden?: boolean;
  IsBroken?: boolean;
  Unread?: boolean;
  Description?: { Text?: string; Html?: string } | null;
}

export interface RawTocModule {
  ModuleId: number;
  Title: string;
  Description?: { Text?: string; Html?: string } | null;
  Topics?: RawTocTopic[];
  Modules?: RawTocModule[];
  LastModifiedDate?: string | null;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
}

export type TopicKind =
  | 'file'
  | 'page'
  | 'link'
  | 'video'
  | 'audio'
  | 'assignment'
  | 'quiz'
  | 'discussion'
  | 'checklist'
  | 'survey'
  | 'external_tool'
  | 'scorm'
  | 'other';

/** Kinds whose text read_file can usually get. */
export const READABLE_KINDS: ReadonlySet<TopicKind> = new Set(['file', 'page', 'scorm']);

const VIDEO = /\.(mp4|m4v|mov|webm|avi|mkv|wmv)$/i;
const AUDIO = /\.(mp3|m4a|wav|ogg|aac|flac)$/i;
const PAGE = /\.(html?|xhtml)$/i;

/** What a topic is, from its URL first (most reliable across schools), then its activity type. */
export function classifyTopic(t: RawTocTopic): TopicKind {
  const url = (t.Url || '').toLowerCase();
  const path = url.split('?')[0];
  if (/\/dropbox\/|type=dropbox/.test(url)) return 'assignment';
  if (/\/quizzing\/|type=quiz/.test(url)) return 'quiz';
  if (/\/survey\/|type=survey/.test(url)) return 'survey';
  if (/\/discussions?\/|type=discuss/.test(url)) return 'discussion';
  if (/\/checklist\/|type=checklist/.test(url)) return 'checklist';
  if (/\/lti\/|type=lti|\/le\/ltilink/.test(url)) return 'external_tool';
  if (/scorm|contentservice/.test(url)) return 'scorm';
  if (path.startsWith('/content/')) {
    if (PAGE.test(path)) return 'page';
    if (VIDEO.test(path)) return 'video';
    if (AUDIO.test(path)) return 'audio';
    return 'file';
  }
  switch (t.ActivityType) {
    case 1:
      return 'file';
    case 2:
      return 'link';
    case 3:
      return 'assignment';
    case 4:
    case 11:
      return 'quiz';
    case 5:
    case 6:
      return 'discussion';
    case 7:
      return 'external_tool';
    case 10:
      return 'checklist';
    case 12:
      return 'survey';
    case 20:
    case 21:
    case 22:
    case 23:
      return 'scorm';
  }
  if (t.TypeIdentifier?.toLowerCase() === 'file') return 'file';
  if (/^https?:\/\//.test(url)) return VIDEO.test(path) || /youtube\.com|youtu\.be|vimeo\.com|kaltura|yuja|panopto/.test(url) ? 'video' : 'link';
  if (t.TypeIdentifier?.toLowerCase() === 'link') return 'link';
  return 'other';
}

export interface FlatTopic {
  topic: RawTocTopic;
  kind: TopicKind;
  /** Module titles from the top of the walk down to the topic's module. */
  path: string[];
  moduleId: number;
}

/** Every topic under `module`, in course order, with the path of module titles leading to it. */
export function walkModule(module: RawTocModule, parents: string[] = []): FlatTopic[] {
  const path = [...parents, module.Title];
  const out: FlatTopic[] = [];
  for (const topic of module.Topics ?? []) out.push({ topic, kind: classifyTopic(topic), path, moduleId: module.ModuleId });
  for (const child of module.Modules ?? []) out.push(...walkModule(child, path));
  return out;
}

/** Every topic in the course. */
export function walkToc(toc: RawTocModule[]): FlatTopic[] {
  return toc.flatMap((m) => walkModule(m));
}

export interface FoundModule {
  module: RawTocModule;
  /** Titles of the modules above it. */
  parents: string[];
}

function eachModule(mods: RawTocModule[], parents: string[], visit: (f: FoundModule) => void): void {
  for (const m of mods) {
    visit({ module: m, parents });
    eachModule(m.Modules ?? [], [...parents, m.Title], visit);
  }
}

export function findModuleById(toc: RawTocModule[], id: number): FoundModule | undefined {
  let found: FoundModule | undefined;
  eachModule(toc, [], (f) => {
    if (!found && f.module.ModuleId === id) found = f;
  });
  return found;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Modules whose title matches `query`: exact (ignoring case and punctuation) matches win;
 * otherwise every module whose title contains it. "Unit 3" matches "Unit 3: Thermodynamics"
 * but not "Unit 30".
 */
export function findModulesByTitle(toc: RawTocModule[], query: string): FoundModule[] {
  const q = norm(query);
  const exact: FoundModule[] = [];
  const partial: FoundModule[] = [];
  eachModule(toc, [], (f) => {
    const t = norm(f.module.Title);
    if (t === q) exact.push(f);
    else if (new RegExp(`(^| )${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(t)) partial.push(f);
  });
  return exact.length ? exact : partial;
}

/** A module's description as plain text, or ''. */
export function moduleDescription(m: { Description?: { Text?: string; Html?: string } | null }): string {
  return stripHtml(m.Description?.Text || m.Description?.Html);
}

/**
 * The course outline, cached briefly: the bundle, unit and search tools all need it, and on
 * a big course it is one of the slower calls.
 */
const TOC_TTL_MS = 5 * 60 * 1000;
const tocCache = new Map<number, { at: number; toc: RawTocModule[] }>();

export async function getToc(orgUnitId: number): Promise<RawTocModule[]> {
  const hit = tocCache.get(orgUnitId);
  if (hit && Date.now() - hit.at < TOC_TTL_MS) return hit.toc;
  const res = (await client.getContentToc(orgUnitId)) as { Modules?: RawTocModule[] };
  const toc = res.Modules ?? [];
  tocCache.set(orgUnitId, { at: Date.now(), toc });
  if (tocCache.size > 20) tocCache.delete(tocCache.keys().next().value as number);
  return toc;
}

export function clearTocCache(): void {
  tocCache.clear();
}

/** Run `fn` over `items` with at most `limit` running at once (a Pi has little to spare). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
