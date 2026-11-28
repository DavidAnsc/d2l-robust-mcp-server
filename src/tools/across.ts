/**
 * Tools that look across courses or across a whole course:
 *  - get_active_courses: only this term's courses, not every enrollment you ever had;
 *  - whats_new: what changed since a date, in every active course at once;
 *  - search_course: where something is mentioned in a course (titles, instructions,
 *    announcements and, optionally, the text of every file).
 */
import { z } from 'zod';
import { client } from '../client.js';
import { activeCourseOverride } from '../config.js';
import { FlatTopic, getToc, mapLimit, READABLE_KINDS, walkToc } from '../content-tree.js';
import {
  formatDate,
  formatRelativeDate,
  marshalCalendarEvents,
  RawAnnouncement,
  RawAssignment,
  RawCalendarEvent,
  RawEnrollment,
  stripHtml,
} from '../utils/marshal.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { docKey, pagedDocument, pageParams } from './paged.js';
import { loadFile } from './read.js';
import { topicRef } from './refs.js';
import { tolerant } from './tolerant.js';

const DAY = 864e5;

// ---------------------------------------------------------------------------------------------
// Active courses
// ---------------------------------------------------------------------------------------------

export interface ActiveCourse {
  id: number;
  name: string;
  code: string;
  startDate?: string | null;
  endDate?: string | null;
  lastAccessed?: string | null;
  /** Why it counts as active. */
  basis: string;
}

interface RawOffering {
  StartDate?: string | null;
  EndDate?: string | null;
  IsActive?: boolean;
  Semester?: { Name?: string } | null;
}

/**
 * Decide from dates whether a course is current. Ended more than two weeks ago: past.
 * Starting more than a month from now: not yet. Returns undefined when there are no dates.
 */
export function currentByDates(start: string | null | undefined, end: string | null | undefined, now = Date.now()): boolean | undefined {
  if (!start && !end) return undefined;
  if (end && new Date(end).getTime() < now - 14 * DAY) return false;
  if (start && new Date(start).getTime() > now + 30 * DAY) return false;
  return true;
}

export async function activeCourses(now = Date.now()): Promise<ActiveCourse[]> {
  const res = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
  const courses = res.Items.filter((e) => e.OrgUnit.Type.Code === 'Course Offering');
  const override = activeCourseOverride();

  const decided = await mapLimit(courses, 4, async (e): Promise<ActiveCourse | null> => {
    const base = {
      id: e.OrgUnit.Id,
      name: e.OrgUnit.Name,
      code: e.OrgUnit.Code,
      lastAccessed: formatDate(e.Access.LastAccessed),
    };
    if (override) return override.includes(e.OrgUnit.Id) ? { ...base, basis: 'listed in D2L_ACTIVE_COURSES' } : null;
    if (e.Access.CanAccess === false || e.Access.IsActive === false) return null;

    let start = e.Access.StartDate;
    let end = e.Access.EndDate;
    let semester: string | undefined;
    if (!start && !end) {
      // The enrollment has no dates; the course offering itself may.
      const offering = await tolerant(async () => (await client.getCourseOffering(e.OrgUnit.Id)) as RawOffering);
      if (offering.value?.IsActive === false) return null;
      start = offering.value?.StartDate;
      end = offering.value?.EndDate;
      semester = offering.value?.Semester?.Name;
    }
    const withDates = { ...base, startDate: formatDate(start), endDate: formatDate(end), ...(semester ? { semester } : {}) };
    const byDates = currentByDates(start, end, now);
    if (byDates === true) return { ...withDates, basis: 'course dates include today' };
    if (byDates === false) return null;

    // No dates anywhere: use whether you've opened it recently (or never, for a brand-new course).
    const last = e.Access.LastAccessed ? new Date(e.Access.LastAccessed).getTime() : undefined;
    if (last === undefined) return { ...withDates, basis: 'no course dates and never opened; may be new (set D2L_ACTIVE_COURSES to be exact)' };
    if (last > now - 150 * DAY) return { ...withDates, basis: 'no course dates; opened in the last 5 months' };
    return null;
  });
  return decided.filter((c): c is ActiveCourse => c !== null);
}

// ---------------------------------------------------------------------------------------------
// What's new
// ---------------------------------------------------------------------------------------------

interface RawGradeValue {
  GradeObjectName: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  DisplayedGrade: string | null;
  LastModified?: string | null;
  Comments?: { Text?: string; Html?: string };
}

/** "7d", "2w", "24h" or an ISO date → a Date. */
export function parseSince(since: string | undefined, now = Date.now()): Date {
  if (!since) return new Date(now - 7 * DAY);
  const rel = since.trim().match(/^(\d+)\s*(h|d|w)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { h: 36e5, d: DAY, w: 7 * DAY }[rel[2].toLowerCase() as 'h' | 'd' | 'w'];
    return new Date(now - n * unit);
  }
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) throw new Error(`since must be like "7d", "48h", "2w" or a date such as 2026-11-01; got "${since}".`);
  return d;
}

async function courseNews(course: number, name: string, since: Date, now: number): Promise<string> {
  const after = (iso?: string | null) => !!iso && new Date(iso).getTime() >= since.getTime();
  const [news, toc, grades, cal, updates] = await Promise.all([
    tolerant(async () => (await client.getNews(course)) as RawAnnouncement[]),
    tolerant(() => getToc(course)),
    tolerant(async () => (await client.getMyGradeValues(course)) as RawGradeValue[]),
    tolerant(async () => (await client.getMyCalendarEvents(course, new Date(now).toISOString(), new Date(now + 14 * DAY).toISOString())) as { Objects: RawCalendarEvent[] }),
    tolerant(async () => (await client.getMyUpdates(course)) as Record<string, unknown>),
  ]);

  const out: string[] = [`## ${name} (course ${course})`, ''];
  const newNews = (news.value ?? []).filter((n) => after(n.CreatedDate) || after(n.StartDate));
  if (newNews.length) {
    out.push('**Announcements**', '');
    for (const n of newNews) out.push(`- ${n.Title} (${formatDate(n.CreatedDate)}, id ${n.Id}): ${stripHtml(n.Body?.Text || n.Body?.Html).slice(0, 400)}`);
    out.push('');
  }
  const changed = walkToc(toc.value ?? []).filter((f) => after(f.topic.LastModifiedDate));
  if (changed.length) {
    out.push('**New or changed content**', '');
    for (const f of changed.slice(0, 30)) out.push(`- [${f.kind}] ${f.path.join(' > ')} > ${f.topic.Title} (topicId ${f.topic.TopicId}, ${formatRelativeDate(f.topic.LastModifiedDate)})`);
    if (changed.length > 30) out.push(`- …and ${changed.length - 30} more`);
    out.push('');
  }
  const newGrades = (grades.value ?? []).filter((g) => after(g.LastModified));
  if (newGrades.length) {
    out.push('**Grades released or changed**', '');
    for (const g of newGrades) {
      const score = g.PointsNumerator !== null ? `${g.PointsNumerator}/${g.PointsDenominator}` : '';
      const fb = stripHtml(g.Comments?.Text || g.Comments?.Html);
      out.push(`- ${g.GradeObjectName}: ${[score, g.DisplayedGrade?.trim()].filter(Boolean).join(' ')}${fb ? ` — feedback: ${fb.slice(0, 300)}` : ''}`);
    }
    out.push('');
  }
  const due = cal.value ? marshalCalendarEvents(cal.value) : [];
  if (due.length) {
    out.push('**Due in the next 14 days**', '');
    for (const e of due) out.push(`- ${e.title} — ${e.dueDate} (${e.dueDateRelative})${e.type ? ` [${e.type}]` : ''}`);
    out.push('');
  }
  const counts = Object.entries(updates.value ?? {}).filter(([, v]) => typeof v === 'number' && v > 0);
  if (counts.length) out.push(`**Unread in Brightspace:** ${counts.map(([k, v]) => `${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${v}`).join(', ')}`, '');
  if (out.length === 2) out.push('_Nothing new._', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/** Words and "quoted phrases" of a query, lower-cased. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).toLowerCase().trim();
    if (t) terms.push(t);
  }
  return terms;
}

export interface Hit {
  where: string;
  /** The ids to open it with. */
  ids: Record<string, unknown>;
  score: number;
  snippet: string;
}

/** Score a piece of text: every term must appear; the score is how often they do. */
export function scoreText(text: string, terms: string[]): { score: number; at: number } | null {
  const lower = text.toLowerCase();
  let score = 0;
  let at = -1;
  for (const t of terms) {
    let i = lower.indexOf(t);
    if (i < 0) return null;
    if (at < 0 || i < at) at = i;
    for (; i >= 0; i = lower.indexOf(t, i + t.length)) score++;
  }
  return { score, at };
}

export function snippet(text: string, at: number, width = 240): string {
  const start = Math.max(0, at - width / 2);
  const s = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${s}${start + width < text.length ? '…' : ''}`;
}

/** Split extracted text at its page/slide/sheet markers, so a hit can say "slide 12". */
export function sections(text: string): Array<{ label: string; text: string }> {
  const parts = text.split(/^--- ((?:Page|Slide) \d+|Sheet: [^\n]*?) ---$/m);
  if (parts.length === 1) return [{ label: '', text }];
  const out: Array<{ label: string; text: string }> = [];
  if (parts[0].trim()) out.push({ label: '', text: parts[0] });
  for (let i = 1; i < parts.length; i += 2) out.push({ label: parts[i].toLowerCase(), text: parts[i + 1] ?? '' });
  return out;
}

interface SearchArgs {
  orgUnitId?: number;
  query: string;
  includeFiles?: boolean;
  maxResults?: number;
  offset?: number;
  maxChars?: number;
}

async function buildSearch(args: SearchArgs): Promise<string> {
  const course = resolveCourseId(args.orgUnitId);
  const terms = queryTerms(args.query);
  if (!terms.length) throw new Error('query is empty.');
  const hits: Hit[] = [];
  const consider = (where: string, ids: Record<string, unknown>, text: string) => {
    const s = scoreText(text, terms);
    if (s) hits.push({ where, ids, score: s.score, snippet: snippet(text, s.at) });
  };
  const topicIds = (f: FlatTopic) => ({ topicId: f.topic.TopicId, ...(READABLE_KINDS.has(f.kind) ? { read: topicRef(course, f.topic.TopicId) } : {}) });

  const [toc, assignments, news, quizzes] = await Promise.all([
    tolerant(() => getToc(course)),
    tolerant(async () => (await client.getDropboxFolders(course)) as RawAssignment[]),
    tolerant(async () => (await client.getNews(course)) as RawAnnouncement[]),
    tolerant(async () => (await client.getQuizzes(course)) as Array<{ QuizId: number; Name: string; Description?: { Text?: { Text?: string; Html?: string } } }>),
  ]);
  const topics = walkToc(toc.value ?? []);
  for (const f of topics) {
    const desc = stripHtml(f.topic.Description?.Text || f.topic.Description?.Html);
    consider(`Content: ${f.path.join(' > ')} > ${f.topic.Title} [${f.kind}]`, topicIds(f), `${f.topic.Title}\n${f.path.join(' ')}\n${desc}`);
  }
  for (const a of assignments.value ?? []) {
    consider(`Assignment: ${a.Name}`, { assignmentId: a.Id }, `${a.Name}\n${stripHtml(a.CustomInstructions?.Text || a.CustomInstructions?.Html)}`);
  }
  for (const n of news.value ?? []) {
    consider(`Announcement: ${n.Title} (${formatDate(n.CreatedDate)})`, { announcementId: n.Id }, `${n.Title}\n${stripHtml(n.Body?.Text || n.Body?.Html)}`);
  }
  for (const q of quizzes.value ?? []) consider(`Quiz: ${q.Name}`, { quizId: q.QuizId }, `${q.Name}\n${stripHtml(q.Description?.Text?.Text || q.Description?.Text?.Html)}`);

  let filesRead = 0;
  if (args.includeFiles) {
    const readable = topics.filter((f) => READABLE_KINDS.has(f.kind));
    await mapLimit(readable, 2, async (f: FlatTopic) => {
      const got = await tolerant(() => loadFile({ source: 'topic', orgUnitId: course, topicId: f.topic.TopicId }, { stamp: f.topic.LastModifiedDate ?? undefined, preferCache: true }));
      if (!got.value || typeof got.value === 'string') return;
      filesRead++;
      for (const s of sections(got.value.extracted.text)) {
        consider(`File: ${f.path.join(' > ')} > ${f.topic.Title}${s.label ? `, ${s.label}` : ''}`, topicIds(f), s.text);
      }
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const max = args.maxResults ?? 30;
  const out = [`# Search "${args.query}" in course ${course}`, ''];
  out.push(
    `${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > max ? `, best ${max} shown` : ''}. Searched content titles and descriptions, assignment instructions, announcements and quizzes` +
      (args.includeFiles ? `, and the text of ${filesRead} files.` : '. Set includeFiles=true to search inside slides, PDFs and documents too (slower the first time).'),
    ''
  );
  for (const h of hits.slice(0, max)) out.push(`- **${h.where}** ${JSON.stringify(h.ids)}`, `  ${h.snippet}`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------

export const acrossTools = {
  get_active_courses: {
    description:
      `Your current courses only: excludes past terms, courses not yet started, and non-course units. Decided by course ` +
      `dates when Brightspace has them, otherwise by whether you've opened the course recently; each course says why it ` +
      `counts. D2L_ACTIVE_COURSES (comma-separated ids) overrides this. Start here for "my courses this term".`,
    schema: {},
    handler: async (): Promise<string> => toJson(await activeCourses()),
  },

  whats_new: {
    description:
      `What's new across all your active courses (or the ones given) since a time: new announcements, new or changed ` +
      `content, grades released or changed, what's due in the next 14 days, and unread counts. Use for "what did I miss?", ` +
      `"catch me up", or a daily or weekly summary.`,
    schema: {
      since: z.string().optional().describe('How far back: "24h", "7d" (default), "2w", or a date like 2026-11-01.'),
      orgUnitIds: z.array(z.number().int().positive()).max(30).optional().describe('Only these courses (default: every active course).'),
      ...pageParams,
    },
    handler: (args: { since?: string; orgUnitIds?: number[]; offset?: number; maxChars?: number }) =>
      pagedDocument(docKey('whatsnew', args), args.offset, args.maxChars, async () => {
        const now = Date.now();
        const since = parseSince(args.since, now);
        const courses = args.orgUnitIds?.length
          ? args.orgUnitIds.map((id) => ({ id, name: `Course ${id}` }))
          : (await activeCourses(now)).map((c) => ({ id: c.id, name: c.name }));
        const parts = await mapLimit(courses, 2, (c) => courseNews(c.id, c.name, since, now));
        return [`# What's new since ${formatDate(since.toISOString())}`, '', ...parts].join('\n');
      }),
  },

  search_course: {
    description:
      `Find where something is mentioned in a course: content titles and descriptions, assignment instructions, ` +
      `announcements and quizzes, and with includeFiles=true the text of every slide deck, PDF, document and page ` +
      `(results name the slide or page). All words must appear; use "quotes" for a phrase. Each match carries its ` +
      `ids, and a "read" ref for files: pass those to read_files.`,
    schema: {
      orgUnitId: courseIdParam,
      query: z.string().min(1).describe('Words to find, e.g. eigenvalue or "Bayes theorem".'),
      includeFiles: z.boolean().optional().describe('Also search inside every file (reads them all the first time; cached after). Default false.'),
      maxResults: z.number().int().min(1).max(200).optional().describe('Most matches to list (default 30).'),
      ...pageParams,
    },
    handler: (args: SearchArgs) =>
      pagedDocument(docKey('search', { ...args, orgUnitId: resolveCourseId(args.orgUnitId) }), args.offset, args.maxChars, () => buildSearch(args)),
  },
};
