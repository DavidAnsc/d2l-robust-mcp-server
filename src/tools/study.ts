/**
 * Tools that gather everything for one job in one call:
 *  - get_assignment_bundle: all there is to know about one assignment, to write a guide for it;
 *  - get_unit_materials: the text of every file and page in a unit, to write a study guide.
 *
 * Both return Markdown in parts (see paged.ts), because a whole unit easily runs to
 * hundreds of thousands of characters.
 */
import { z } from 'zod';
import { client } from '../client.js';
import {
  classifyTopic,
  FlatTopic,
  findModuleById,
  findModulesByTitle,
  FoundModule,
  getToc,
  mapLimit,
  moduleDescription,
  READABLE_KINDS,
  RawTocModule,
  RawTocTopic,
  TopicKind,
  walkModule,
  walkToc,
} from '../content-tree.js';
import { skipped, tolerant as optional } from './tolerant.js';
import {
  formatDate,
  formatFileSize,
  formatRelativeDate,
  marshalAssignment,
  marshalRubric,
  marshalSubmissions,
  RawAnnouncement,
  RawAssignment,
  RawRubric,
  RawSubmission,
  rubricToMarkdown,
  stripHtml,
} from '../utils/marshal.js';
import { courseIdParam, resolveCourseId } from './common.js';
import { docKey, pagedDocument, pageParams } from './paged.js';
import { loadFile, ReadArgs, ReadFile } from './read.js';

/** Files fetched at once. Low on purpose: the Pi, and the school's servers. */
const CONCURRENCY = 2;

/** A file's text for a document, or a one-line reason it has none. */
async function fileSection(args: ReadArgs, stamp: string | undefined, maxChars: number | undefined): Promise<{ title: string; body: string }> {
  const got = await optional(() => loadFile(args, { stamp, preferCache: true }));
  if (got.error) return { title: '', body: `_(Could not read: ${got.error})_` };
  const file = got.value as ReadFile | string;
  if (typeof file === 'string') return { title: '', body: `_${file}_` };
  const { extracted } = file;
  const unit = extracted.kind === 'pdf' ? 'pages' : extracted.kind === 'pptx' ? 'slides' : extracted.kind === 'xlsx' ? 'sheets' : '';
  const meta = [extracted.kind, formatFileSize(file.size), extracted.parts !== undefined && unit ? `${extracted.parts} ${unit}` : '']
    .filter(Boolean)
    .join(', ');
  let body = extracted.image ? `_(Image file: open it with read_file to see it.)_` : extracted.text.trim() || '_(no text)_';
  if (maxChars && body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n\n_(Cut at ${maxChars} characters of ${extracted.text.length}; read_file has the rest.)_`;
  }
  if (extracted.note) body = `_Note: ${extracted.note}_\n\n${body}`;
  return { title: `${file.filename} (${meta})`, body };
}

// ---------------------------------------------------------------------------------------------
// Matching things that mention an assignment by name
// ---------------------------------------------------------------------------------------------

const KEYWORD_GROUPS = [
  ['assignment', 'assign', 'asst', 'asg'],
  ['homework', 'hw'],
  ['lab', 'laboratory'],
  ['project', 'proj'],
  ['problem set', 'pset', 'ps'],
  ['quiz'],
  ['essay'],
  ['report'],
  ['exercise', 'ex'],
  ['tutorial', 'tut'],
  ['milestone', 'ms'],
  ['deliverable'],
  ['worksheet'],
  ['case study'],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Patterns that say "this text is about that assignment": its full name, and short forms such
 * as "HW 3" for "Homework 3" or "Lab #2" for "Lab 2 - Circuits".
 */
export function mentionPatterns(name: string): RegExp[] {
  const patterns: RegExp[] = [];
  const full = squash(name);
  if (full.length >= 4) patterns.push(new RegExp(`\\b${full.split(' ').map(escape).join('[^a-z0-9]+')}\\b`, 'i'));
  const lower = name.toLowerCase();
  for (const group of KEYWORD_GROUPS) {
    for (const word of group) {
      const m = lower.match(new RegExp(`\\b${escape(word)}\\s*#?\\s*(\\d+[a-z]?)\\b`));
      if (m) {
        const alts = group.map(escape).join('|');
        patterns.push(new RegExp(`\\b(?:${alts})\\s*#?\\s*0*${escape(m[1])}\\b`, 'i'));
        return patterns;
      }
    }
  }
  return patterns;
}

export const mentions = (text: string, patterns: RegExp[]): boolean => patterns.some((p) => p.test(text));

/** True when a content topic is the course's link to this assignment. */
export function linksToAssignment(t: RawTocTopic, assignmentId: number): boolean {
  if (classifyTopic(t) !== 'assignment') return false;
  if (t.ToolItemId === assignmentId) return true;
  return new RegExp(`(?:[?&](?:db|folderId|id)=|/folders?/)${assignmentId}(?:\\D|$)`).test(t.Url || '');
}

// ---------------------------------------------------------------------------------------------
// get_assignment_bundle
// ---------------------------------------------------------------------------------------------

interface RawGradeObject {
  Id: number;
  Name: string;
  CategoryId?: number | null;
  Weight?: number | null;
  MaxPoints?: number | null;
  IsBonus?: boolean;
  ExcludeFromFinalGradeCalculation?: boolean;
  Description?: { Text?: string; Html?: string } | null;
}

interface RawGradeCategory {
  Id: number;
  Name: string;
  Weight?: number | null;
  MaxPoints?: number | null;
}

interface RawGradeValue {
  GradeObjectIdentifier?: string;
  GradeObjectName: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  DisplayedGrade: string | null;
  Comments?: { Text?: string; Html?: string };
}

interface RawPost {
  PostId: number;
  ThreadId?: number;
  Subject?: string;
  Message?: { Text?: string; Html?: string };
  PostingUserDisplayName?: string;
  DatePosted?: string;
  IsDeleted?: boolean;
}

interface BundleArgs {
  orgUnitId?: number;
  assignmentId: number;
  includeFileText?: boolean;
  includeRelatedContent?: boolean;
  relatedFileChars?: number;
  searchDiscussions?: boolean;
  offset?: number;
  maxChars?: number;
}

export async function buildAssignmentBundle(args: BundleArgs): Promise<string> {
  const course = resolveCourseId(args.orgUnitId);
  const id = args.assignmentId;
  const includeFiles = args.includeFileText ?? true;
  const includeRelated = args.includeRelatedContent ?? true;
  const relatedChars = args.relatedFileChars ?? 20_000;

  const raw = (await client.getDropboxFolder(course, id)) as RawAssignment;
  const a = marshalAssignment(raw);
  const patterns = mentionPatterns(raw.Name);

  // Independent lookups, in parallel; any of them may be off for students at a given school.
  const [subs, news, toc, gradeObjects, categories, myGrades, rubricsApi] = await Promise.all([
    optional(async () => (await client.getDropboxSubmissions(course, id)) as RawSubmission[]),
    optional(async () => (await client.getNews(course)) as RawAnnouncement[]),
    includeRelated ? optional(() => getToc(course)) : skipped<RawTocModule[]>(),
    raw.GradeItemId ? optional(async () => (await client.getGradeObjects(course)) as RawGradeObject[]) : skipped<RawGradeObject[]>(),
    raw.GradeItemId ? optional(async () => (await client.getGradeCategories(course)) as RawGradeCategory[]) : skipped<RawGradeCategory[]>(),
    raw.GradeItemId ? optional(async () => (await client.getMyGradeValues(course)) as RawGradeValue[]) : skipped<RawGradeValue[]>(),
    raw.Assessment?.Rubrics?.length ? skipped<RawRubric[]>() : optional(async () => (await client.getRubrics(course, 'Dropbox', id)) as RawRubric[]),
  ]);

  const out: string[] = [`# Assignment: ${raw.Name}`, ''];
  const facts: string[] = [`- Assignment id: ${id} (course ${course})`];
  if (a.dueDate) facts.push(`- Due: ${a.dueDate} (${a.dueDateRelative})`);
  else facts.push('- Due: no due date set');
  if (a.availableFrom || a.availableUntil) facts.push(`- Open: ${a.availableFrom ?? 'now'} until ${a.availableUntil ?? 'no end date'}`);
  if (a.points) facts.push(`- Points: ${a.points}`);
  facts.push(`- Submission: ${a.groupAssignment ? 'group' : 'individual'}${a.allowedFileTypes ? `; file types: ${a.allowedFileTypes}` : ''}`);

  // Grade weight.
  const gradeObj = gradeObjects.value?.find((g) => g.Id === raw.GradeItemId);
  if (gradeObj) {
    const cat = categories.value?.find((c) => c.Id === gradeObj.CategoryId);
    const weight = gradeObj.Weight ? `weight ${gradeObj.Weight}` : '';
    const where = cat ? ` within category "${cat.Name}"${cat.Weight ? ` (category weight ${cat.Weight}% of the final grade)` : ''}` : weight ? '% of the final grade' : '';
    const max = gradeObj.MaxPoints ? `out of ${gradeObj.MaxPoints} points` : '';
    const extra = [gradeObj.IsBonus ? 'bonus' : '', gradeObj.ExcludeFromFinalGradeCalculation ? 'not counted in the final grade' : '']
      .filter(Boolean)
      .join(', ');
    facts.push(`- Grade item: "${gradeObj.Name}" ${[max, weight + where].filter(Boolean).join(', ')}${extra ? ` (${extra})` : ''}`);
    const mine = myGrades.value?.find((g) => Number(g.GradeObjectIdentifier) === gradeObj.Id);
    if (mine && mine.PointsNumerator !== null) {
      facts.push(`- Your grade: ${mine.PointsNumerator}/${mine.PointsDenominator}${mine.DisplayedGrade ? ` (${mine.DisplayedGrade.trim()})` : ''}`);
    }
  }
  out.push(...facts, '');

  out.push('## Instructions', '', a.instructions || '_(No instructions written on the assignment page; check the attached files and related content below.)_', '');

  // Rubrics.
  const rubrics = a.rubrics ?? (rubricsApi.value?.length ? rubricsApi.value.map(marshalRubric) : []);
  out.push('## Rubric', '');
  if (rubrics.length) out.push(...rubrics.map(rubricToMarkdown), '');
  else out.push('_(No rubric attached, or the school does not show rubrics to students through the API.)_', '');

  // Attached files.
  if (raw.Attachments?.length) {
    out.push('## Attached files', '');
    const sections = await mapLimit(raw.Attachments, CONCURRENCY, async (f) => {
      if (!includeFiles || f.FileId === undefined) return `### ${f.FileName} (fileId ${f.FileId})\n\n_(Read with read_file source=assignment_attachment.)_`;
      const s = await fileSection({ source: 'assignment_attachment', orgUnitId: course, assignmentId: id, fileId: f.FileId }, 'by-file-id', undefined);
      return `### ${s.title || f.FileName} (fileId ${f.FileId})\n\n${s.body}`;
    });
    out.push(...sections.flatMap((s) => [s, '']));
  }
  if (a.links?.length) {
    out.push('## Links on the assignment', '', ...a.links.map((l) => `- ${l.name}: ${l.url}`), '');
  }

  // Related course content.
  if (includeRelated && toc.value) {
    const all = walkToc(toc.value);
    const linked = all.filter((f) => linksToAssignment(f.topic, id));
    const linkedModules = new Set(linked.map((f) => f.moduleId));
    const named = all.filter((f) => !linked.includes(f) && mentions(f.topic.Title, patterns));
    const siblings = all.filter(
      (f) => linkedModules.has(f.moduleId) && !linked.includes(f) && !named.includes(f) && READABLE_KINDS.has(f.kind)
    );
    const related = [...named, ...siblings].filter((f) => READABLE_KINDS.has(f.kind)).slice(0, 8);

    out.push('## Related course content', '');
    if (!linked.length && !named.length && !siblings.length) out.push('_(Nothing in the course content links to or names this assignment.)_', '');
    const line = (f: FlatTopic, why: string) =>
      `- [${f.kind}] ${f.path.join(' > ')} > ${f.topic.Title} (topicId ${f.topic.TopicId}) — ${why}`;
    out.push(
      ...linked.map((f) => line(f, 'the link to this assignment')),
      ...named.map((f) => line(f, 'title names this assignment')),
      ...siblings.map((f) => line(f, 'in the same module as the assignment link')),
      ''
    );
    if (includeFiles && related.length) {
      const sections = await mapLimit(related, CONCURRENCY, async (f) => {
        const s = await fileSection(
          { source: 'topic', orgUnitId: course, topicId: f.topic.TopicId },
          f.topic.LastModifiedDate ?? undefined,
          relatedChars
        );
        return `### ${f.topic.Title}${s.title ? ` — ${s.title}` : ''} (topicId ${f.topic.TopicId})\n\n${s.body}`;
      });
      out.push(...sections.flatMap((s) => [s, '']));
    }
  }

  // Announcements.
  const relevantNews = (news.value ?? []).filter((n) => mentions(`${n.Title}\n${n.Body?.Text || stripHtml(n.Body?.Html)}`, patterns));
  out.push('## Announcements that mention it', '');
  if (news.error) out.push(`_(Announcements: ${news.error}.)_`, '');
  else if (!relevantNews.length) out.push('_(None found.)_', '');
  for (const n of relevantNews) {
    out.push(`### ${n.Title} (${formatDate(n.CreatedDate)}, id ${n.Id})`, '', stripHtml(n.Body?.Text || n.Body?.Html), '');
    if (n.Attachments?.length) out.push(`Attachments: ${n.Attachments.map((f) => `${f.FileName} (fileId ${f.FileId})`).join(', ')}`, '');
  }

  // Discussions (opt-in: it reads every topic's posts).
  if (args.searchDiscussions) {
    out.push('## Discussion posts that mention it', '');
    const found = await discussionMentions(course, patterns);
    if (typeof found === 'string') out.push(`_(${found})_`, '');
    else if (!found.length) out.push('_(None found.)_', '');
    else out.push(...found, '');
  }

  // Submissions and feedback.
  out.push('## Your submissions and feedback', '');
  if (subs.error) out.push(`_(Submissions: ${subs.error}.)_`, '');
  else {
    const s = marshalSubmissions(subs.value ?? []);
    if (!s.length || !s.some((x) => x.submitted)) out.push('_(Nothing submitted yet.)_', '');
    for (const x of s) {
      if (!x.submitted) continue;
      out.push(`- Last submitted: ${x.submissionDate} (${x.submissionDateRelative}); files: ${x.files.map((f) => `${f.name} (fileId ${f.fileId})`).join(', ') || 'none'}`);
      if (x.earlierAttempts?.length) out.push(`- Earlier attempts: ${x.earlierAttempts.length}`);
      if (x.grade !== null && x.grade !== undefined) out.push(`- Score: ${x.grade}`);
      if (x.feedback) out.push(`- Feedback: ${x.feedback}`);
      if (x.feedbackFiles?.length) out.push(`- Feedback files: ${x.feedbackFiles.map((f) => `${f.name} (fileId ${f.fileId})`).join(', ')}`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Posts that mention an assignment, across every discussion topic; or why that failed. */
async function discussionMentions(course: number, patterns: RegExp[]): Promise<string[] | string> {
  const forums = await optional(async () => (await client.getForums(course)) as Array<{ ForumId: number; Name: string }>);
  if (forums.error) return `Discussions: ${forums.error}`;
  const topics: Array<{ forum: { ForumId: number; Name: string }; topic: { TopicId: number; Name: string } }> = [];
  for (const forum of forums.value ?? []) {
    const t = await optional(async () => (await client.getForumTopics(course, forum.ForumId)) as Array<{ TopicId: number; Name: string }>);
    for (const topic of t.value ?? []) topics.push({ forum, topic });
  }
  const lists = await mapLimit(topics.slice(0, 40), CONCURRENCY, async ({ forum, topic }) => {
    const posts = await optional(async () => (await client.getTopicPosts(course, forum.ForumId, topic.TopicId)) as RawPost[]);
    return (posts.value ?? [])
      .filter((p) => !p.IsDeleted && mentions(`${p.Subject ?? ''}\n${p.Message?.Text || stripHtml(p.Message?.Html)}`, patterns))
      .map(
        (p) =>
          `### ${forum.Name} > ${topic.Name}: ${p.Subject || '(no subject)'}\n${p.PostingUserDisplayName ?? 'Someone'}, ${formatDate(p.DatePosted)}\n\n${(
            p.Message?.Text || stripHtml(p.Message?.Html)
          ).trim()}`
      );
  });
  return lists.flat();
}

// ---------------------------------------------------------------------------------------------
// get_unit_materials
// ---------------------------------------------------------------------------------------------

const KINDS = [
  'file', 'page', 'link', 'video', 'audio', 'assignment', 'quiz', 'discussion', 'checklist', 'survey', 'external_tool', 'scorm', 'other',
] as const satisfies readonly TopicKind[];

interface UnitArgs {
  orgUnitId?: number;
  moduleId?: number;
  moduleIds?: number[];
  moduleTitle?: string;
  kinds?: TopicKind[];
  extensions?: string[];
  manifestOnly?: boolean;
  offset?: number;
  maxChars?: number;
}

const NOT_READABLE: Partial<Record<TopicKind, string>> = {
  link: 'a link to another site; its content is not in Brightspace',
  video: 'a video; the API gives no transcript (captions may be on the video player)',
  audio: 'an audio file; there is no transcript',
  assignment: 'an assignment: use get_assignment_bundle',
  quiz: 'a quiz: use get_quizzes for its details',
  discussion: 'a discussion: use get_discussions and get_discussion_posts',
  checklist: 'a checklist: use get_checklists',
  survey: 'a survey',
  external_tool: 'an external tool (LTI): it runs on another service, so its content cannot be read here',
  other: 'an item this server cannot read',
};

async function resolveUnits(course: number, args: UnitArgs): Promise<{ toc: RawTocModule[]; units: FoundModule[] }> {
  const toc = await getToc(course);
  const units: FoundModule[] = [];
  const ids = [...(args.moduleId ? [args.moduleId] : []), ...(args.moduleIds ?? [])];
  for (const mid of ids) {
    const found = findModuleById(toc, mid);
    if (!found) throw new Error(`Module ${mid} is not in course ${course}'s content. get_course_content lists the modules.`);
    units.push(found);
  }
  if (args.moduleTitle) {
    const matches = findModulesByTitle(toc, args.moduleTitle);
    if (!matches.length) {
      const top = toc.map((m) => `"${m.Title}" (${m.ModuleId})`).join(', ');
      throw new Error(`No module's title matches "${args.moduleTitle}". Top-level modules: ${top}`);
    }
    // Drop matches nested inside another match: walking the outer one covers them.
    const inside = (f: FoundModule) =>
      matches.some((o) => o !== f && findModuleById([o.module], f.module.ModuleId) !== undefined);
    units.push(...matches.filter((m) => !inside(m)));
  }
  if (!units.length) throw new Error('Pass moduleId, moduleIds or moduleTitle (get_course_content lists the modules).');
  return { toc, units };
}

function wanted(f: FlatTopic, args: UnitArgs): boolean {
  if (args.kinds?.length && !args.kinds.includes(f.kind)) return false;
  if (args.extensions?.length) {
    const path = (f.topic.Url || f.topic.Title).split('?')[0].toLowerCase();
    if (!args.extensions.some((e) => path.endsWith(e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))) return false;
  }
  return true;
}

export async function buildUnitMaterials(args: UnitArgs): Promise<string> {
  const course = resolveCourseId(args.orgUnitId);
  const { units } = await resolveUnits(course, args);

  const items: FlatTopic[] = units.flatMap((u) => walkModule(u.module, u.parents)).filter((f) => wanted(f, args));
  const counts = new Map<TopicKind, number>();
  for (const f of items) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);

  const title = units.map((u) => `${u.module.Title} (moduleId ${u.module.ModuleId})`).join('; ');
  const out: string[] = [`# Unit materials: ${title}`, '', `Course ${course}. ${items.length} items: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}.`, ''];

  out.push('## Contents', '');
  items.forEach((f, i) => {
    const modified = f.topic.LastModifiedDate ? `, updated ${formatRelativeDate(f.topic.LastModifiedDate)}` : '';
    out.push(`${i + 1}. [${f.kind}] ${f.path.join(' > ')} > ${f.topic.Title} (topicId ${f.topic.TopicId}${modified})`);
  });
  out.push('');
  if (args.manifestOnly) return out.join('\n');

  // Module descriptions often hold the week's learning outcomes: keep them.
  const describedModules = new Map<string, string>();
  for (const u of units) {
    const visit = (m: RawTocModule, parents: string[]) => {
      const d = moduleDescription(m);
      if (d) describedModules.set([...parents, m.Title].join(' > '), d);
      for (const c of m.Modules ?? []) visit(c, [...parents, m.Title]);
    };
    visit(u.module, u.parents);
  }

  const sections = await mapLimit(items, CONCURRENCY, async (f) => {
    const heading = `### ${f.topic.Title} (${f.kind}, topicId ${f.topic.TopicId})`;
    const description = stripHtml(f.topic.Description?.Text || f.topic.Description?.Html);
    const desc = description ? `${description}\n\n` : '';
    if (!READABLE_KINDS.has(f.kind)) {
      const where = f.topic.Url ? ` Address: ${f.topic.Url}` : '';
      return `${heading}\n\n${desc}_This is ${NOT_READABLE[f.kind] ?? 'not readable here'}.${where}_`;
    }
    const s = await fileSection({ source: 'topic', orgUnitId: course, topicId: f.topic.TopicId }, f.topic.LastModifiedDate ?? undefined, undefined);
    return `${heading}${s.title ? `\nFile: ${s.title}` : ''}\n\n${desc}${s.body}`;
  });

  let lastPath = '';
  items.forEach((f, i) => {
    const p = f.path.join(' > ');
    if (p !== lastPath) {
      out.push(`## ${p}`, '');
      const d = describedModules.get(p);
      if (d) out.push(d, '');
      lastPath = p;
    }
    out.push(sections[i], '');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------------------------------------------------------------------------------------------

const assignmentIdParam = z.number().int().positive().describe('The assignment Id from get_assignments.');

export const studyTools = {
  get_assignment_bundle: {
    description:
      `Everything about one assignment in a single Markdown document, for writing a guide to it: due and availability dates, ` +
      `points and grade weight, full instructions, the rubric (every criterion and level), the text of every attached file, ` +
      `course content that links to or names the assignment (with the text of those files), announcements that mention it, ` +
      `optionally discussion posts that mention it, and your submissions, feedback and grade. ` +
      `Long results come in parts: the reply says which offset to pass next.`,
    schema: {
      orgUnitId: courseIdParam,
      assignmentId: assignmentIdParam,
      includeFileText: z.boolean().optional().describe('Include the text of attached and related files (default true).'),
      includeRelatedContent: z.boolean().optional().describe('Look for related course content (default true).'),
      relatedFileChars: z.number().int().min(1000).max(200_000).optional().describe('Most characters kept from each related content file (default 20000). Attachments are never cut.'),
      searchDiscussions: z.boolean().optional().describe('Also search every discussion topic for posts that mention the assignment (slower; default false).'),
      ...pageParams,
    },
    handler: (args: BundleArgs) =>
      pagedDocument(docKey('bundle', { ...args, orgUnitId: resolveCourseId(args.orgUnitId) }), args.offset, args.maxChars, () => buildAssignmentBundle(args)),
  },

  get_unit_materials: {
    description:
      `All the material in one or more course modules (a unit, a week, a topic) as one Markdown document, for writing a ` +
      `study guide: a numbered list of every item, then the extracted text of every file (slides with speaker notes, PDFs ` +
      `page by page, Word, Excel) and web page, in course order, under its module path. Items that can't be read here ` +
      `(links, videos, quizzes, external tools) are listed with what they are. Choose the unit with moduleId, moduleIds, ` +
      `or moduleTitle (e.g. "Unit 3" or "Week 7"; sub-modules are included). Use manifestOnly=true to see the list first, ` +
      `and kinds/extensions to keep only some items. Long results come in parts: the reply says which offset to pass next.`,
    schema: {
      orgUnitId: courseIdParam,
      moduleId: z.number().int().positive().optional().describe('A ModuleId from get_course_content.'),
      moduleIds: z.array(z.number().int().positive()).max(30).optional().describe('Several modules at once, e.g. every week before a midterm.'),
      moduleTitle: z.string().min(1).optional().describe('Find modules by title, e.g. "Unit 3". Exact matches win; otherwise every title containing it.'),
      kinds: z.array(z.enum(KINDS)).optional().describe('Keep only these kinds of item, e.g. ["file","page"].'),
      extensions: z.array(z.string()).optional().describe('Keep only files with these extensions, e.g. ["pptx","pdf"].'),
      manifestOnly: z.boolean().optional().describe('Only list the items; read nothing (fast).'),
      ...pageParams,
    },
    handler: (args: UnitArgs) =>
      pagedDocument(docKey('unit', { ...args, orgUnitId: resolveCourseId(args.orgUnitId) }), args.offset, args.maxChars, () => buildUnitMaterials(args)),
  },
};
