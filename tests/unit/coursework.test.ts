import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/client.js')>();
  return {
    D2LApiError: real.D2LApiError,
    client: {
      getQuizzes: vi.fn(),
      getQuiz: vi.fn(),
      getQuizAttempts: vi.fn(),
      getContentToc: vi.fn(),
      getMyCalendarEvents: vi.fn(),
      getForums: vi.fn(),
      getForumTopics: vi.fn(),
      getTopicPosts: vi.fn(),
      getGradeObjects: vi.fn(),
      getGradeCategories: vi.fn(),
      getMyGradeValues: vi.fn(),
      getMyFinalGrade: vi.fn(),
      getOverview: vi.fn(),
      getChecklists: vi.fn(),
      getChecklistCategories: vi.fn(),
      getChecklistItems: vi.fn(),
    },
  };
});
vi.mock('../../src/tools/files.js', () => ({ fetchWithSession: vi.fn() }));

import { client, D2LApiError } from '../../src/client.js';
import { clearTocCache } from '../../src/content-tree.js';
import { courseworkTools, gradeBreakdown, postsToMarkdown } from '../../src/tools/coursework.js';
import { clearPagedDocs } from '../../src/tools/paged.js';

beforeEach(() => {
  vi.clearAllMocks();
  clearTocCache();
  clearPagedDocs();
  process.env.D2L_COURSE_ID = '100';
});

describe('get_quizzes', () => {
  it('lists quizzes, never showing a password', async () => {
    vi.mocked(client.getQuizzes).mockResolvedValue([
      {
        QuizId: 5,
        Name: 'Midterm',
        DueDate: '2026-12-01T15:00:00Z',
        SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 90 },
        AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
        Password: 'secret',
        Description: { Text: { Text: 'Chapters 1-4' } },
      },
    ]);
    const out = await courseworkTools.get_quizzes.handler({});
    const [q] = JSON.parse(out);
    expect(q).toMatchObject({ id: 5, name: 'Midterm', timeLimit: '90 minutes', attemptsAllowed: 1, passwordProtected: true, description: 'Chapters 1-4' });
    expect(out).not.toContain('secret');
  });

  it('falls back to content and calendar when the list is blocked', async () => {
    vi.mocked(client.getQuizzes).mockRejectedValue(new D2LApiError(403, 'Forbidden'));
    vi.mocked(client.getContentToc).mockResolvedValue({ Modules: [{ ModuleId: 1, Title: 'Week 3', Topics: [{ TopicId: 9, Title: 'Quiz 3', ActivityType: 4, ToolItemId: 44 }] }] });
    vi.mocked(client.getMyCalendarEvents).mockResolvedValue({ Objects: [] });
    const out = JSON.parse(await courseworkTools.get_quizzes.handler({}));
    expect(out.note).toContain('not available to students');
    expect(out.fromContent).toEqual([{ name: 'Quiz 3', quizId: 44, where: 'Week 3', topicId: 9 }]);
  });
});

describe('postsToMarkdown', () => {
  it('nests replies under their post, oldest first, and skips deleted posts', () => {
    const md = postsToMarkdown(
      [
        { PostId: 2, ParentPostId: 1, Subject: 'Re: due date', Message: { Text: 'Friday.' }, PostingUserDisplayName: 'Prof', DatePosted: '2026-11-02T00:00:00Z' },
        { PostId: 1, Subject: 'due date?', Message: { Text: 'When?' }, PostingUserDisplayName: 'Sam', DatePosted: '2026-11-01T00:00:00Z' },
        { PostId: 3, Subject: 'gone', IsDeleted: true },
      ],
      10
    );
    expect(md.indexOf('due date?')).toBeLessThan(md.indexOf('Re: due date'));
    expect(md).toMatch(/\n  - \*\*Re: due date\*\* — Prof/);
    expect(md).not.toContain('gone');
  });
});

describe('gradeBreakdown', () => {
  it('groups items under weighted categories with your scores', () => {
    const out = gradeBreakdown(
      [
        { Id: 1, Name: 'Final exam', CategoryId: 10, Weight: 100, MaxPoints: 100 },
        { Id: 2, Name: 'Participation', Weight: 5, MaxPoints: 5 },
      ],
      [{ Id: 10, Name: 'Exams', Weight: 60 }],
      [{ GradeObjectIdentifier: '2', GradeObjectName: 'Participation', PointsNumerator: 4, PointsDenominator: 5, DisplayedGrade: '80 %' }]
    );
    expect(out.scheme).toMatch(/^weighted/);
    expect(out.categories[0]).toMatchObject({ category: 'Exams', weight: 60, items: [{ name: 'Final exam', weight: 100 }] });
    expect(out.uncategorized[0]).toMatchObject({ name: 'Participation', yourScore: '4/5', yourGrade: '80 %' });
  });
});

describe('get_course_overview', () => {
  it('combines the overview page with syllabus-like content', async () => {
    vi.mocked(client.getOverview).mockResolvedValue({ Description: { Text: 'Welcome to EE101.' }, HasAttachment: false });
    vi.mocked(client.getContentToc).mockResolvedValue({ Modules: [{ ModuleId: 1, Title: 'Start here', Topics: [{ TopicId: 3, Title: 'Course Syllabus', Url: 'https://x.example/s' }] }] });
    const md = await courseworkTools.get_course_overview.handler({ includeText: false });
    expect(md).toContain('Welcome to EE101.');
    expect(md).toContain('[link] Start here > Course Syllabus (topicId 3)');
  });
});

describe('get_checklists', () => {
  it('walks checklists, categories and items', async () => {
    vi.mocked(client.getChecklists).mockResolvedValue([{ ChecklistId: 1, Name: 'Week 1 to-do' }]);
    vi.mocked(client.getChecklistCategories).mockResolvedValue([{ CategoryId: 2, Name: 'Readings' }]);
    vi.mocked(client.getChecklistItems).mockResolvedValue([{ ChecklistItemId: 3, Name: 'Read ch. 1', DueDate: null }]);
    expect(JSON.parse(await courseworkTools.get_checklists.handler({}))).toEqual([
      { checklistId: 1, name: 'Week 1 to-do', categories: [{ name: 'Readings', items: [{ name: 'Read ch. 1' }] }] },
    ]);
  });
});
