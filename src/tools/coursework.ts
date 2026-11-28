/**
 * Quizzes, discussions, the grade breakdown, the course overview (syllabus) and checklists.
 *
 * Schools differ in which of these the API shows to students. Each tool says plainly when a
 * part is off ("not available to students at this school") and falls back to what it can see.
 */
import { z } from 'zod';
import { client } from '../client.js';
import { getToc, walkToc } from '../content-tree.js';
import { formatDate, formatRelativeDate, marshalCalendarEvents, RawCalendarEvent, removeEmpty, stripHtml } from '../utils/marshal.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { docKey, pagedDocument, pageParams } from './paged.js';
import { loadFile } from './read.js';
import { tolerant } from './tolerant.js';

type RichText = { Text?: string; Html?: string } | null | undefined;
const text = (t: RichText) => stripHtml(t?.Text || t?.Html);

// ---------------------------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------------------------

interface RawQuiz {
  QuizId: number;
  Name: string;
  IsActive?: boolean;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  GradeItemId?: number | null;
  Instructions?: { Text?: RichText; IsDisplayed?: boolean } | null;
  Description?: { Text?: RichText; IsDisplayed?: boolean } | null;
  AttemptsAllowed?: { IsUnlimited?: boolean; NumberOfAttemptsAllowed?: number | null } | null;
  SubmissionTimeLimit?: { IsEnforced?: boolean; TimeLimitValue?: number | null } | null;
  Password?: string | null;
}

interface RawAttempt {
  AttemptId: number;
  AttemptNumber?: number;
  Started?: string | null;
  Completed?: string | null;
  Score?: number | null;
  IsGraded?: boolean;
  Feedback?: RichText;
}

export function marshalQuiz(q: RawQuiz) {
  const limit = q.SubmissionTimeLimit?.IsEnforced && q.SubmissionTimeLimit.TimeLimitValue ? `${q.SubmissionTimeLimit.TimeLimitValue} minutes` : null;
  const attempts = q.AttemptsAllowed?.IsUnlimited ? 'unlimited' : q.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null;
  // Password is deliberately left out: it's never the student's to see, even if the API sends it.
  return removeEmpty({
    id: q.QuizId,
    name: q.Name,
    active: q.IsActive,
    opens: formatDate(q.StartDate),
    closes: formatDate(q.EndDate),
    due: formatDate(q.DueDate),
    dueRelative: formatRelativeDate(q.DueDate ?? q.EndDate),
    timeLimit: limit,
    attemptsAllowed: attempts,
    passwordProtected: q.Password ? true : undefined,
    gradeItemId: q.GradeItemId ?? null,
    description: text(q.Description?.Text) || null,
    instructions: text(q.Instructions?.Text) || null,
  });
}

/** Quizzes seen in the content outline and calendar, for schools that block the quiz list. */
async function quizzesFromElsewhere(course: number) {
  const toc = await tolerant(() => getToc(course));
  const now = Date.now();
  const cal = await tolerant(
    async () =>
      (await client.getMyCalendarEvents(course, new Date(now - 180 * 864e5).toISOString(), new Date(now + 180 * 864e5).toISOString())) as {
        Objects: RawCalendarEvent[];
      }
  );
  const fromContent = walkToc(toc.value ?? [])
    .filter((f) => f.kind === 'quiz')
    .map((f) => removeEmpty({ name: f.topic.Title, quizId: f.topic.ToolItemId ?? null, where: f.path.join(' > '), topicId: f.topic.TopicId }));
  const fromCalendar = cal.value ? marshalCalendarEvents(cal.value).filter((e) => e.type === 'quiz') : [];
  return { fromContent, fromCalendar };
}

// ---------------------------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------------------------

interface RawForum {
  ForumId: number;
  Name: string;
  Description?: RichText;
  IsHidden?: boolean;
  IsLocked?: boolean;
}

interface RawDiscussionTopic {
  TopicId: number;
  ForumId?: number;
  Name: string;
  Description?: RichText;
  StartDate?: string | null;
  EndDate?: string | null;
  IsHidden?: boolean;
  IsLocked?: boolean;
}

interface RawPost {
  PostId: number;
  ThreadId?: number | null;
  ParentPostId?: number | null;
  Subject?: string;
  Message?: RichText;
  PostingUserDisplayName?: string;
  IsAnonymous?: boolean;
  DatePosted?: string;
  IsDeleted?: boolean;
  AttachmentCount?: number;
}

/** Posts as threads: each starting post, then its replies indented under it, oldest first. */
export function postsToMarkdown(posts: RawPost[], maxPosts: number): string {
  const live = posts.filter((p) => !p.IsDeleted);
  const byParent = new Map<number | null, RawPost[]>();
  for (const p of live) {
    const parent = p.ParentPostId && live.some((q) => q.PostId === p.ParentPostId) ? p.ParentPostId : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(p);
  }
  const time = (p: RawPost) => new Date(p.DatePosted ?? 0).getTime();
  for (const list of byParent.values()) list.sort((a, b) => time(a) - time(b));

  const lines: string[] = [];
  let shown = 0;
  const visit = (p: RawPost, depth: number) => {
    if (shown >= maxPosts) return;
    shown++;
    const indent = '  '.repeat(depth);
    const who = p.IsAnonymous ? 'Anonymous' : p.PostingUserDisplayName || 'Someone';
    const files = p.AttachmentCount ? ` [${p.AttachmentCount} attachment(s)]` : '';
    const body = text(p.Message).split('\n').map((l) => `${indent}  ${l}`).join('\n');
    lines.push(`${indent}- **${p.Subject || '(no subject)'}** — ${who}, ${formatDate(p.DatePosted)}${files}`, body, '');
    for (const r of byParent.get(p.PostId) ?? []) visit(r, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) visit(root, 0);
  if (shown < live.length) lines.push(`_(${live.length - shown} more posts not shown; raise maxPosts to see them.)_`);
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------------------------

interface RawGradeObject {
  Id: number;
  Name: string;
  CategoryId?: number | null;
  Weight?: number | null;
  MaxPoints?: number | null;
  IsBonus?: boolean;
  ExcludeFromFinalGradeCalculation?: boolean;
  GradeType?: string;
}

interface RawGradeCategory {
  Id: number;
  Name: string;
  Weight?: number | null;
  MaxPoints?: number | null;
  ExcludeFromFinalGrade?: boolean;
}

interface RawGradeValue {
  GradeObjectIdentifier?: string;
  GradeObjectName: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator?: number | null;
  WeightedDenominator?: number | null;
  DisplayedGrade: string | null;
}

export function gradeBreakdown(objects: RawGradeObject[], categories: RawGradeCategory[], values: RawGradeValue[]) {
  const valueFor = (id: number) => values.find((v) => Number(v.GradeObjectIdentifier) === id);
  const item = (g: RawGradeObject) => {
    const v = valueFor(g.Id);
    return removeEmpty({
      id: g.Id,
      name: g.Name,
      weight: g.Weight || null,
      maxPoints: g.MaxPoints ?? null,
      yourScore: v && v.PointsNumerator !== null ? `${v.PointsNumerator}/${v.PointsDenominator}` : null,
      yourGrade: v?.DisplayedGrade?.trim() || null,
      weightedContribution:
        v?.WeightedNumerator !== undefined && v?.WeightedNumerator !== null ? `${v.WeightedNumerator}/${v.WeightedDenominator}` : null,
      bonus: g.IsBonus || undefined,
      notCounted: g.ExcludeFromFinalGradeCalculation || undefined,
    });
  };
  const items = objects.filter((g) => g.GradeType !== 'Category' && g.GradeType !== 'Text');
  const grouped = categories.map((c) =>
    removeEmpty({
      category: c.Name,
      weight: c.Weight || null,
      maxPoints: c.MaxPoints ?? null,
      notCounted: c.ExcludeFromFinalGrade || undefined,
      items: items.filter((g) => g.CategoryId === c.Id).map(item),
    })
  );
  const loose = items.filter((g) => !g.CategoryId || !categories.some((c) => c.Id === g.CategoryId)).map(item);
  const anyWeights = objects.some((g) => g.Weight) || categories.some((c) => c.Weight);
  return {
    scheme: anyWeights ? 'weighted (weights are % of the final grade; an item inside a category counts toward that category)' : 'points (each item counts by its max points)',
    categories: grouped,
    uncategorized: loose,
  };
}

// ---------------------------------------------------------------------------------------------
// Course overview / syllabus
// ---------------------------------------------------------------------------------------------

const SYLLABUS = /syllab|course (outline|information|info|overview|schedule|policies)|outline|calendar of|schedule/i;

export async function buildOverview(course: number, includeText: boolean): Promise<string> {
  const out: string[] = [`# Course overview (course ${course})`, ''];
  const overview = await tolerant(async () => (await client.getOverview(course)) as { Description?: RichText; HasAttachment?: boolean });
  out.push('## Course overview page', '');
  if (overview.error) out.push(`_(Overview page: ${overview.error}.)_`, '');
  else {
    out.push(text(overview.value?.Description) || '_(Empty.)_', '');
    if (overview.value?.HasAttachment) {
      if (includeText) {
        const f = await tolerant(() => loadFile({ source: 'overview_attachment', orgUnitId: course }));
        if (f.value && typeof f.value !== 'string') out.push(`### Attached file: ${f.value.filename}`, '', f.value.extracted.text, '');
        else out.push(`_(Overview attachment: ${f.error ?? f.value}.)_`, '');
      } else out.push(`_(Has an attached file, read: ${JSON.stringify({ source: 'overview_attachment', orgUnitId: course })})_`, '');
    }
  }

  const toc = await tolerant(() => getToc(course));
  const candidates = walkToc(toc.value ?? []).filter((f) => SYLLABUS.test(f.topic.Title) || f.path.some((p) => /^(syllabus|course (information|info|outline))/i.test(p)));
  out.push('## Syllabus-like items in the content', '');
  if (!candidates.length) out.push('_(No content items are titled like a syllabus or outline.)_', '');
  for (const f of candidates) {
    const ref = f.kind === 'file' || f.kind === 'page' ? ` read: ${JSON.stringify({ source: 'topic', orgUnitId: course, topicId: f.topic.TopicId })}` : '';
    out.push(`- [${f.kind}] ${f.path.join(' > ')} > ${f.topic.Title} (topicId ${f.topic.TopicId})${ref}`);
  }
  out.push('');
  if (includeText) {
    for (const f of candidates.filter((c) => c.kind === 'file' || c.kind === 'page').slice(0, 3)) {
      const got = await tolerant(() => loadFile({ source: 'topic', orgUnitId: course, topicId: f.topic.TopicId }, { stamp: f.topic.LastModifiedDate ?? undefined }));
      const body = got.value && typeof got.value !== 'string' ? got.value.extracted.text : `_(${got.error ?? got.value})_`;
      out.push(`### ${f.topic.Title} (topicId ${f.topic.TopicId})`, '', body, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const id = (what: string) => z.number().int().positive().describe(what);

export const courseworkTools = {
  get_quizzes: {
    description:
      `List a course's quizzes and tests: name, open/close/due dates, time limit, attempts allowed, description and instructions. ` +
      `If the school hides the quiz list from students, returns the quizzes found in the course content and calendar instead. ` +
      `Use to answer: "When is the midterm?", "How long is quiz 3?", "How many attempts do I get?"`,
    schema: { orgUnitId: courseIdParam },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const list = await tolerant(async () => (await client.getQuizzes(course)) as RawQuiz[]);
      if (list.value) return toJson(list.value.map(marshalQuiz));
      return toJson({ note: `The quiz list is ${list.error}; these are the quizzes found elsewhere in the course.`, ...(await quizzesFromElsewhere(course)) });
    },
  },

  get_quiz: {
    description: `Details of one quiz, plus your attempts and scores when the school shows them. (Quiz questions are not available through the API to students.)`,
    schema: { orgUnitId: courseIdParam, quizId: id('The quiz id from get_quizzes.') },
    handler: async ({ orgUnitId, quizId }: { orgUnitId?: number; quizId: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const quiz = marshalQuiz((await client.getQuiz(course, quizId)) as RawQuiz);
      const attempts = await tolerant(async () => (await client.getQuizAttempts(course, quizId)) as RawAttempt[]);
      return toJson({
        ...quiz,
        attempts: attempts.value?.map((a) =>
          removeEmpty({
            attempt: a.AttemptNumber ?? a.AttemptId,
            started: formatDate(a.Started),
            completed: formatDate(a.Completed),
            score: a.Score ?? null,
            graded: a.IsGraded,
            feedback: text(a.Feedback) || null,
          })
        ),
        attemptsNote: attempts.error ? `Attempts: ${attempts.error}.` : undefined,
      });
    },
  },

  get_discussions: {
    description: `List a course's discussion forums and their topics (forumId, topicId, name, description, open dates). Read the posts of one topic with get_discussion_posts. Instructors often answer assignment questions here.`,
    schema: { orgUnitId: courseIdParam },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const forums = (await client.getForums(course)) as RawForum[];
      const out = [];
      for (const f of forums) {
        const topics = await tolerant(async () => (await client.getForumTopics(course, f.ForumId)) as RawDiscussionTopic[]);
        out.push(
          removeEmpty({
            forumId: f.ForumId,
            name: f.Name,
            description: text(f.Description) || null,
            locked: f.IsLocked || undefined,
            topics: (topics.value ?? []).map((t) =>
              removeEmpty({
                topicId: t.TopicId,
                name: t.Name,
                description: text(t.Description) || null,
                opens: formatDate(t.StartDate),
                closes: formatDate(t.EndDate),
                locked: t.IsLocked || undefined,
              })
            ),
            topicsNote: topics.error ? `Topics: ${topics.error}.` : undefined,
          })
        );
      }
      return toJson(out);
    },
  },

  get_discussion_posts: {
    description: `The posts in one discussion topic, as threads (each post with its replies indented under it): subject, author, date and text.`,
    schema: {
      orgUnitId: courseIdParam,
      forumId: id('The forumId from get_discussions.'),
      topicId: id('The topicId from get_discussions.'),
      maxPosts: z.number().int().min(1).max(1000).optional().describe('Most posts to show (default 200).'),
      ...pageParams,
    },
    handler: (args: { orgUnitId?: number; forumId: number; topicId: number; maxPosts?: number; offset?: number; maxChars?: number }) => {
      const course = resolveCourseId(args.orgUnitId);
      return pagedDocument(docKey('posts', { ...args, orgUnitId: course }), args.offset, args.maxChars, async () => {
        const posts = (await client.getTopicPosts(course, args.forumId, args.topicId)) as RawPost[];
        return postsToMarkdown(posts, args.maxPosts ?? 200) || '_(No posts.)_';
      });
    },
  },

  get_grade_breakdown: {
    description:
      `How the course is graded and where you stand: every grade category and item with its weight and max points, your score ` +
      `on each, and your final grade if released. Use to answer: "How much is the final worth?", "What matters most?", ` +
      `"What do I need on the exam?"`,
    schema: { orgUnitId: courseIdParam },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const [objects, categories, values, final] = await Promise.all([
        tolerant(async () => (await client.getGradeObjects(course)) as RawGradeObject[]),
        tolerant(async () => (await client.getGradeCategories(course)) as RawGradeCategory[]),
        tolerant(async () => (await client.getMyGradeValues(course)) as RawGradeValue[]),
        tolerant(async () => (await client.getMyFinalGrade(course)) as RawGradeValue),
      ]);
      if (objects.error && values.error) throw new Error(`Grades are ${objects.error}.`);
      const breakdown = gradeBreakdown(objects.value ?? [], categories.value ?? [], values.value ?? []);
      return toJson({
        ...breakdown,
        finalGrade: final.value?.DisplayedGrade?.trim() || (final.value?.PointsNumerator != null ? `${final.value.PointsNumerator}/${final.value.PointsDenominator}` : null),
        note: objects.error ? `Weights are ${objects.error}; only your scores are shown.` : undefined,
      });
    },
  },

  get_course_overview: {
    description:
      `The course's overview/syllabus: the Course Overview page, its attached file (often the syllabus PDF) and every ` +
      `content item titled like a syllabus, course outline or schedule, each with a "read" ref. Set includeText=true to ` +
      `also get the text of the file and up to three items. Use for course policies, late penalties, exam dates, what each unit covers.`,
    schema: {
      orgUnitId: courseIdParam,
      includeText: z.boolean().optional().describe('Also include the text of the overview file and up to three syllabus items (default false).'),
      ...pageParams,
    },
    handler: (args: { orgUnitId?: number; includeText?: boolean; offset?: number; maxChars?: number }) => {
      const course = resolveCourseId(args.orgUnitId);
      return pagedDocument(docKey('overview', { ...args, orgUnitId: course }), args.offset, args.maxChars, () => buildOverview(course, args.includeText ?? false));
    },
  },

  get_checklists: {
    description: `A course's checklists (instructor to-do lists for a unit or week), with their categories, items, descriptions and due dates.`,
    schema: { orgUnitId: courseIdParam },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      type Raw = { ChecklistId?: number; CategoryId?: number; ChecklistItemId?: number; Name: string; Description?: RichText; DueDate?: string | null };
      const lists = (await client.getChecklists(course)) as Raw[];
      const out = [];
      for (const c of lists) {
        const cats = await tolerant(async () => (await client.getChecklistCategories(course, c.ChecklistId!)) as Raw[]);
        const categories = [];
        for (const cat of cats.value ?? []) {
          const items = await tolerant(async () => (await client.getChecklistItems(course, c.ChecklistId!, cat.CategoryId!)) as Raw[]);
          categories.push(
            removeEmpty({
              name: cat.Name,
              description: text(cat.Description) || null,
              items: (items.value ?? []).map((i) => removeEmpty({ name: i.Name, description: text(i.Description) || null, due: formatDate(i.DueDate) })),
            })
          );
        }
        out.push(removeEmpty({ checklistId: c.ChecklistId, name: c.Name, description: text(c.Description) || null, categories }));
      }
      return toJson(out);
    },
  },
};
