import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/client.js')>();
  return {
    D2LApiError: real.D2LApiError,
    client: {
      getMyEnrollments: vi.fn(),
      getCourseOffering: vi.fn(),
      getContentToc: vi.fn(),
      getDropboxFolders: vi.fn(),
      getNews: vi.fn(),
      getQuizzes: vi.fn(),
      getMyGradeValues: vi.fn(),
      getMyCalendarEvents: vi.fn(),
      getMyUpdates: vi.fn(),
    },
  };
});
vi.mock('../../src/tools/files.js', () => ({ fetchWithSession: vi.fn() }));

import { client, D2LApiError } from '../../src/client.js';
import { clearTocCache } from '../../src/content-tree.js';
import { acrossTools, activeCourses, currentByDates, parseSince, queryTerms, scoreText, sections } from '../../src/tools/across.js';
import { clearPagedDocs } from '../../src/tools/paged.js';

const NOW = Date.parse('2026-11-28T12:00:00Z');
const enrollment = (Id: number, Name: string, access: Record<string, unknown>, Code = 'Course Offering') => ({
  OrgUnit: { Id, Name, Code: `C${Id}`, HomeUrl: '', Type: { Code, Name: Code } },
  Access: { IsActive: true, CanAccess: true, LastAccessed: null, ...access },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearTocCache();
  clearPagedDocs();
  delete process.env.D2L_ACTIVE_COURSES;
  process.env.D2L_COURSE_ID = '100';
});

describe('currentByDates', () => {
  it('uses a two-week grace after the end and a month before the start', () => {
    expect(currentByDates('2026-09-01', '2026-12-20', NOW)).toBe(true);
    expect(currentByDates('2026-01-01', '2026-11-20', NOW)).toBe(true);
    expect(currentByDates('2026-01-01', '2026-11-01', NOW)).toBe(false);
    expect(currentByDates('2027-01-10', null, NOW)).toBe(false);
    expect(currentByDates(null, null, NOW)).toBeUndefined();
  });
});

describe('activeCourses', () => {
  it('keeps current courses, drops past ones and non-courses, and says why', async () => {
    vi.mocked(client.getMyEnrollments).mockResolvedValue({
      Items: [
        enrollment(1, 'Now', { StartDate: '2026-09-01T00:00:00Z', EndDate: '2026-12-20T00:00:00Z' }),
        enrollment(2, 'Old', { StartDate: '2025-09-01T00:00:00Z', EndDate: '2025-12-20T00:00:00Z' }),
        enrollment(3, 'Dept', {}, 'Department'),
        enrollment(4, 'Undated, recent', { LastAccessed: '2026-11-20T00:00:00Z' }),
        enrollment(5, 'Undated, stale', { LastAccessed: '2025-01-01T00:00:00Z' }),
        enrollment(6, 'Inactive', { IsActive: false }),
      ],
    });
    vi.mocked(client.getCourseOffering).mockRejectedValue(new D2LApiError(403, 'no'));
    const out = await activeCourses(NOW);
    expect(out.map((c) => c.id)).toEqual([1, 4]);
    expect(out[0].basis).toBe('course dates include today');
    expect(out[1].basis).toMatch(/opened in the last 5 months/);
  });

  it('uses the course offering dates when the enrollment has none', async () => {
    vi.mocked(client.getMyEnrollments).mockResolvedValue({ Items: [enrollment(7, 'Offering dated', { LastAccessed: '2020-01-01T00:00:00Z' })] });
    vi.mocked(client.getCourseOffering).mockResolvedValue({ StartDate: '2026-09-01T00:00:00Z', EndDate: '2026-12-31T00:00:00Z', IsActive: true, Semester: { Name: 'Fall 2026' } });
    const [c] = await activeCourses(NOW);
    expect(c).toMatchObject({ id: 7, semester: 'Fall 2026', basis: 'course dates include today' });
  });

  it('honours D2L_ACTIVE_COURSES', async () => {
    process.env.D2L_ACTIVE_COURSES = '2';
    vi.mocked(client.getMyEnrollments).mockResolvedValue({ Items: [enrollment(1, 'Now', {}), enrollment(2, 'Old', { EndDate: '2020-01-01' })] });
    expect((await activeCourses(NOW)).map((c) => c.id)).toEqual([2]);
  });
});

describe('parseSince', () => {
  it('reads relative and absolute times', () => {
    expect(parseSince('48h', NOW).toISOString()).toBe('2026-11-26T12:00:00.000Z');
    expect(parseSince('2w', NOW).toISOString()).toBe('2026-11-14T12:00:00.000Z');
    expect(parseSince(undefined, NOW).toISOString()).toBe('2026-11-21T12:00:00.000Z');
    expect(parseSince('2026-11-01', NOW).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(() => parseSince('soon', NOW)).toThrow(/since must be like/);
  });
});

describe('search helpers', () => {
  it('keeps quoted phrases together', () => {
    expect(queryTerms('Bayes "conditional probability"')).toEqual(['bayes', 'conditional probability']);
  });
  it('needs every term and counts occurrences', () => {
    expect(scoreText('Eigen values; eigenvalue', ['eigen'])).toEqual({ score: 2, at: 0 });
    expect(scoreText('only one', ['only', 'two'])).toBeNull();
  });
  it('splits extracted text at page and slide markers', () => {
    expect(sections('--- Slide 1 ---\nA\n\n--- Slide 2 ---\nB').map((s) => s.label)).toEqual(['slide 1', 'slide 2']);
  });
});

describe('search_course', () => {
  it('finds a term in content titles, assignment instructions and announcements', async () => {
    vi.mocked(client.getContentToc).mockResolvedValue({ Modules: [{ ModuleId: 1, Title: 'Week 4', Topics: [{ TopicId: 8, Title: 'Eigenvalues lecture', Url: '/content/x/e.pdf' }] }] });
    vi.mocked(client.getDropboxFolders).mockResolvedValue([{ Id: 3, Name: 'HW4', CustomInstructions: { Text: 'Compute the eigenvalues of A.', Html: '' } }]);
    vi.mocked(client.getNews).mockResolvedValue([{ Id: 9, Title: 'Office hours', Body: { Text: 'No eigenvalues on the quiz.', Html: '' }, CreatedDate: '2026-11-01T00:00:00Z' }]);
    vi.mocked(client.getQuizzes).mockRejectedValue(new D2LApiError(403, 'no'));
    const md = await acrossTools.search_course.handler({ query: 'eigenvalues' });
    expect(md).toContain('3 matches');
    expect(md).toContain('{"topicId":8,"read":{"source":"topic","orgUnitId":100,"topicId":8}}');
    expect(md).toContain('{"assignmentId":3}');
    expect(md).toContain('{"announcementId":9}');
    expect(md).toContain('Set includeFiles=true');
  });
});

describe('whats_new', () => {
  it('reports only what changed since the given time', async () => {
    vi.mocked(client.getNews).mockResolvedValue([
      { Id: 1, Title: 'Room change', Body: { Text: 'Now in B12.' }, CreatedDate: new Date(Date.now() - 864e5).toISOString() },
      { Id: 2, Title: 'Ancient', Body: { Text: '' }, CreatedDate: '2020-01-01T00:00:00Z' },
    ]);
    vi.mocked(client.getContentToc).mockResolvedValue({ Modules: [] });
    vi.mocked(client.getMyGradeValues).mockResolvedValue([]);
    vi.mocked(client.getMyCalendarEvents).mockResolvedValue({ Objects: [] });
    vi.mocked(client.getMyUpdates).mockResolvedValue({ UnreadDiscussions: 3, UnattemptedQuizzes: 0 });
    const md = await acrossTools.whats_new.handler({ since: '3d', orgUnitIds: [100] });
    expect(md).toContain('Room change');
    expect(md).not.toContain('Ancient');
    expect(md).toContain('unread discussions: 3');
    expect(md).not.toContain('quizzes: 0');
  });
});
