import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../src/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/client.js')>();
  return {
    D2LApiError: real.D2LApiError,
    client: {
      whoami: vi.fn(),
      getDropboxFolder: vi.fn(),
      getDropboxSubmissions: vi.fn(),
      getDropboxAttachment: vi.fn(),
      getNews: vi.fn(),
      getContentToc: vi.fn(),
      getContentTopic: vi.fn(),
      getTopicFile: vi.fn(),
      getGradeObjects: vi.fn(),
      getGradeCategories: vi.fn(),
      getMyGradeValues: vi.fn(),
      getRubrics: vi.fn(),
      getForums: vi.fn(),
      getDropboxFolders: vi.fn(),
      getForumTopics: vi.fn(),
      getTopicPosts: vi.fn(),
    },
  };
});
vi.mock('../../src/tools/files.js', () => ({ fetchWithSession: vi.fn() }));

import { client, D2LApiError } from '../../src/client.js';
import { clearTocCache } from '../../src/content-tree.js';
import { clearPagedDocs } from '../../src/tools/paged.js';
import { clearReadCache } from '../../src/tools/read.js';
import { buildAssignmentBundle, buildUnitMaterials, findRelated, linksToAssignment, listUnitItems, mentionPatterns, mentions } from '../../src/tools/study.js';
import { readFiles } from '../../src/tools/read.js';
import { assignmentTools } from '../../src/tools/dropbox.js';
import { newsTools } from '../../src/tools/news.js';
import { contentTools } from '../../src/tools/content.js';

const fixture = (n: string) => readFileSync(join(__dirname, '../fixtures/files', n));
const file = (data: Buffer, filename: string) => ({ data, filename, contentType: 'application/octet-stream' });

const TOC = {
  Modules: [
    {
      ModuleId: 10,
      Title: 'Unit 1: Circuits',
      Description: { Text: 'Learning outcomes: Ohm and Kirchhoff.' },
      Topics: [{ TopicId: 101, Title: 'Lecture 1', Url: '/content/enforced/100-X/lec.pptx', LastModifiedDate: '2026-11-01T00:00:00Z' }],
      Modules: [
        {
          ModuleId: 11,
          Title: 'Week 2',
          Topics: [
            { TopicId: 111, Title: 'Notes', Url: '/content/enforced/100-X/notes.pdf' },
            { TopicId: 112, Title: 'Textbook chapter', Url: 'https://publisher.example/ch2', ActivityType: 2 },
            { TopicId: 113, Title: 'Quiz 1', Url: '/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5', ActivityType: 4 },
            { TopicId: 114, Title: 'Submit Homework 3', Url: '/d2l/lms/dropbox/user/folder_submit_files.d2l?db=77&ou=100', ActivityType: 3, ToolItemId: 77 },
            { TopicId: 115, Title: 'HW3 starter handout', Url: '/content/enforced/100-X/a2.docx' },
          ],
        },
      ],
    },
    { ModuleId: 20, Title: 'Unit 10: Waves', Topics: [] },
  ],
};

const ASSIGNMENT = {
  Id: 77,
  Name: 'Homework 3',
  DueDate: '2026-12-05T04:59:00Z',
  GradeItemId: 900,
  DropboxType: 2,
  CustomInstructions: { Text: 'Solve problems 1-5.', Html: '' },
  Assessment: {
    ScoreDenominator: 20,
    Rubrics: [
      {
        Name: 'HW rubric',
        CriteriaGroups: [
          {
            Levels: [{ Id: 1, Name: 'Excellent', Points: 4 }, { Id: 2, Name: 'Weak', Points: 1 }],
            Criteria: [{ Id: 1, Name: 'Correctness', Cells: [{ Description: { Text: 'All right' }, Points: 4 }, { Description: { Text: 'Mostly wrong' }, Points: 1 }] }],
          },
        ],
      },
    ],
  },
  Attachments: [{ FileId: 5, FileName: 'hw3.docx', Size: 1000 }],
  LinkAttachments: [],
  AllowableFileType: 0,
  CustomAllowableFileTypes: null,
};

function happyPath() {
  vi.mocked(client.getContentToc).mockResolvedValue(TOC);
  vi.mocked(client.getDropboxFolder).mockResolvedValue(ASSIGNMENT);
  vi.mocked(client.getDropboxSubmissions).mockResolvedValue([]);
  vi.mocked(client.getDropboxAttachment).mockResolvedValue(file(fixture('a2.docx'), 'hw3.docx'));
  vi.mocked(client.getNews).mockResolvedValue([
    { Id: 1, Title: 'HW 3 deadline moved', Body: { Text: 'Now due Friday.', Html: '' }, CreatedDate: '2026-11-20T00:00:00Z', StartDate: null, Attachments: [], IsPublished: true },
    { Id: 2, Title: 'HW 30 is a typo', Body: { Text: 'ignore', Html: '' }, CreatedDate: '2026-11-21T00:00:00Z', StartDate: null, Attachments: [], IsPublished: true },
  ]);
  vi.mocked(client.getGradeObjects).mockResolvedValue([{ Id: 900, Name: 'Homework 3', CategoryId: 3, Weight: 25, MaxPoints: 20 }]);
  vi.mocked(client.getGradeCategories).mockResolvedValue([{ Id: 3, Name: 'Homework', Weight: 30 }]);
  vi.mocked(client.getMyGradeValues).mockResolvedValue([]);
  vi.mocked(client.getTopicFile).mockImplementation(async (_c: number, topicId: number) => {
    if (topicId === 115) return file(fixture('a2.docx'), 'a2.docx');
    if (topicId === 111) return file(fixture('notes.pdf'), 'notes.pdf');
    if (topicId === 101) return file(fixture('lec.pptx'), 'lec.pptx');
    throw new D2LApiError(404, 'no file');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTocCache();
  clearReadCache();
  clearPagedDocs();
  process.env.D2L_COURSE_ID = '100';
});

describe('mentionPatterns', () => {
  it('matches short forms of the same number, and not other numbers', () => {
    const p = mentionPatterns('Homework 3');
    expect(mentions('HW3 is posted', p)).toBe(true);
    expect(mentions('Reminder: homework #3 due', p)).toBe(true);
    expect(mentions('HW 30 is posted', p)).toBe(false);
    expect(mentions('Homework 2', p)).toBe(false);
  });

  it('matches the full name across punctuation', () => {
    const p = mentionPatterns('Lab Report - Circuits');
    expect(mentions('About the lab report: circuits section', p)).toBe(true);
  });
});

describe('linksToAssignment', () => {
  it('uses ToolItemId or the db= parameter', () => {
    expect(linksToAssignment({ TopicId: 1, Title: 'x', ActivityType: 3, ToolItemId: 77 }, 77)).toBe(true);
    expect(linksToAssignment({ TopicId: 1, Title: 'x', Url: '/d2l/lms/dropbox/user/folder_submit_files.d2l?db=77&ou=1' }, 77)).toBe(true);
    expect(linksToAssignment({ TopicId: 1, Title: 'x', Url: '/d2l/lms/dropbox/user/folder_submit_files.d2l?db=770' }, 77)).toBe(false);
  });
});

describe('buildAssignmentBundle', () => {
  it('gathers instructions, rubric, weight, files, related content and announcements', async () => {
    happyPath();
    const md = await buildAssignmentBundle({ assignmentId: 77 });
    expect(md).toContain('# Assignment: Homework 3');
    expect(md).toContain('Solve problems 1-5.');
    expect(md).toContain('**Correctness**');
    expect(md).toContain('- Excellent (4 pts): All right');
    expect(md).toContain('weight 25 within category "Homework" (category weight 30% of the final grade)');
    expect(md).toContain('Write 500 words on <circuits>'); // attached hw3.docx text
    expect(md).toContain('the link to this assignment');
    expect(md).toContain('HW3 starter handout');
    expect(md).toContain('HW 3 deadline moved');
    expect(md).not.toContain('HW 30 is a typo');
    expect(md).toContain('Nothing submitted yet');
    // The rubric came with the assignment, so the rubric endpoint isn't needed.
    expect(client.getRubrics).not.toHaveBeenCalled();
  });

  it('carries on when parts are hidden from students', async () => {
    happyPath();
    vi.mocked(client.getDropboxFolder).mockResolvedValue({ ...ASSIGNMENT, Assessment: { ScoreDenominator: 20 } });
    vi.mocked(client.getRubrics).mockRejectedValue(new D2LApiError(403, 'Forbidden'));
    vi.mocked(client.getNews).mockRejectedValue(new D2LApiError(403, 'Forbidden'));
    const md = await buildAssignmentBundle({ assignmentId: 77 });
    expect(md).toContain('No rubric attached');
    expect(md).toContain('Announcements: not available to students at this school');
  });
});

describe('buildUnitMaterials', () => {
  it('lists every item and includes the text of files, under their module path', async () => {
    happyPath();
    const md = await buildUnitMaterials({ moduleTitle: 'Unit 1' });
    expect(md).toContain('# Unit materials: Unit 1: Circuits (moduleId 10)');
    expect(md).toMatch(/1\. \[file\] Unit 1: Circuits > Lecture 1/);
    expect(md).toContain('[link] Unit 1: Circuits > Week 2 > Textbook chapter');
    expect(md).toContain('Learning outcomes: Ohm and Kirchhoff.');
    expect(md).toContain('## Unit 1: Circuits > Week 2');
    expect(md).toContain('--- Page 1 ---'); // notes.pdf text
    expect(md).toContain('a link to another site');
    expect(md).toContain('a quiz: use get_quizzes');
  });

  it('"Unit 1" does not match "Unit 10"', async () => {
    happyPath();
    const md = await buildUnitMaterials({ moduleTitle: 'Unit 1', manifestOnly: true });
    expect(md).not.toContain('Waves');
    expect(client.getTopicFile).not.toHaveBeenCalled();
  });

  it('filters by kind and extension', async () => {
    happyPath();
    const md = await buildUnitMaterials({ moduleId: 10, extensions: ['pdf'] });
    expect(md).toContain('1 file');
    expect(md).toContain('Notes');
    expect(md).not.toContain('Lecture 1');
  });

  it('explains an unknown module', async () => {
    happyPath();
    await expect(buildUnitMaterials({ moduleTitle: 'Unit 99' })).rejects.toThrow(/No module's title matches "Unit 99". Top-level modules: "Unit 1: Circuits" \(10\)/);
  });

});

describe('content tools from the outline', () => {
  it('get_course_module returns the subtree with kinds and the assignment link', async () => {
    happyPath();
    const out = JSON.parse(await contentTools.get_course_module.handler({ moduleId: 11 }));
    expect(out.path).toBe('Unit 1: Circuits > Week 2');
    expect(out.topics.map((t: { kind: string }) => t.kind)).toEqual(['file', 'link', 'quiz', 'assignment', 'file']);
    expect(out.topics[3].assignmentId).toBe(77);
  });

  it('get_course_modules counts topics including sub-modules', async () => {
    happyPath();
    const out = JSON.parse(await contentTools.get_course_modules.handler({}));
    expect(out[0]).toMatchObject({ id: 10, topicCount: 6, subModules: [{ id: 11, title: 'Week 2' }] });
  });
});

describe('list_unit_items', () => {
  it('lists items with read refs only on readable ones, and module descriptions', async () => {
    happyPath();
    const out = await listUnitItems({ moduleTitle: 'Unit 1' });
    expect(out.modules).toEqual([
      { moduleId: 10, path: 'Unit 1: Circuits', description: 'Learning outcomes: Ohm and Kirchhoff.' },
      { moduleId: 11, path: 'Unit 1: Circuits > Week 2' },
    ]);
    expect(out.counts).toEqual({ file: 3, link: 1, quiz: 1, assignment: 1 });
    const notes = out.items.find((i) => i.title === 'Notes')!;
    expect(notes.read).toEqual({ source: 'topic', orgUnitId: 100, topicId: 111 });
    const link = out.items.find((i) => i.kind === 'link')!;
    expect(link.read).toBeUndefined();
    expect(link.url).toBe('https://publisher.example/ch2');
    expect(out.items.find((i) => i.kind === 'assignment')!.assignmentId).toBe(77);
    expect(client.getTopicFile).not.toHaveBeenCalled(); // listing reads nothing
  });
});

describe('find_related', () => {
  it('returns references and announcement text, without reading files', async () => {
    happyPath();
    const out = await findRelated({ assignmentId: 77 });
    expect(out.content!.map((c) => [c.title, c.why])).toEqual([
      ['Submit Homework 3', 'the link to this assignment'],
      ['HW3 starter handout', 'its title names this assignment'],
      ['Notes', 'in the same module as the assignment link'],
      ['Textbook chapter', 'in the same module as the assignment link'],
      ['Quiz 1', 'in the same module as the assignment link'],
    ]);
    expect(out.content![1].read).toEqual({ source: 'topic', orgUnitId: 100, topicId: 115 });
    expect(out.announcements!.map((a) => a.title)).toEqual(['HW 3 deadline moved']);
    expect(out.discussionsNote).toMatch(/searchDiscussions=true/);
    expect(client.getTopicFile).not.toHaveBeenCalled();
  });
});

describe('get_assignment', () => {
  it('adds the grade weight and read refs for attachments', async () => {
    happyPath();
    const out = JSON.parse(await assignmentTools.get_assignment.handler({ assignmentId: 77 }));
    expect(out.gradeItem).toEqual({ name: 'Homework 3', maxPoints: 20, weight: 25, category: { name: 'Homework', weight: 30 } });
    expect(out.attachments[0].read).toEqual({ source: 'assignment_attachment', orgUnitId: 100, assignmentId: 77, fileId: 5 });
    expect(out.rubrics[0].criteria[0].name).toBe('Correctness');
  });

  it('filters the assignment list by status', async () => {
    vi.mocked(client.getDropboxFolders).mockResolvedValue([
      { ...ASSIGNMENT, Id: 1, Name: 'Past', DueDate: '2020-01-01T00:00:00Z' },
      { ...ASSIGNMENT, Id: 2, Name: 'Future', DueDate: '2099-01-01T00:00:00Z' },
      { ...ASSIGNMENT, Id: 3, Name: 'Undated', DueDate: null },
    ]);
    const names = async (status: 'upcoming' | 'past') => JSON.parse(await assignmentTools.get_assignments.handler({ status })).map((a: { name: string }) => a.name);
    expect(await names('upcoming')).toEqual(['Future', 'Undated']);
    expect(await names('past')).toEqual(['Past']);
  });
});

describe('get_announcements filters', () => {
  it('keeps announcements matching every query word, with attachment refs', async () => {
    happyPath();
    vi.mocked(client.getNews).mockResolvedValue([
      { Id: 1, Title: 'Midterm room', Body: { Text: 'The midterm is in B12.', Html: '' }, CreatedDate: '2026-11-20T00:00:00Z', StartDate: null, Attachments: [{ FileId: 4, FileName: 'map.pdf', Size: 10 }], IsPublished: true },
      { Id: 2, Title: 'Lab', Body: { Text: 'Lab is cancelled.', Html: '' }, CreatedDate: '2026-11-21T00:00:00Z', StartDate: null, Attachments: [], IsPublished: true },
    ]);
    const out = JSON.parse(await newsTools.get_announcements.handler({ query: 'midterm b12' }));
    expect(out.map((a: { id: number }) => a.id)).toEqual([1]);
    expect(out[0].attachments[0].read).toEqual({ source: 'announcement_attachment', orgUnitId: 100, announcementId: 1, fileId: 4 });
  });
});

describe('read_files', () => {
  it('reads several files, cuts long ones with the exact call for the rest, and isolates failures', async () => {
    happyPath();
    const [out] = await readFiles({
      files: [
        { source: 'topic', orgUnitId: 100, topicId: 111 },
        { source: 'topic', orgUnitId: 100, topicId: 999 },
        { source: 'topic', orgUnitId: 100, topicId: 115 },
      ],
      maxCharsPerFile: 2000,
    });
    const text = (out as { text: string }).text;
    expect(text).toContain('=== [1] {"source":"topic","orgUnitId":100,"topicId":111}');
    expect(text).toContain('--- Page 1 ---');
    expect(text).toMatch(/=== \[2\][^\n]*\n(Could not read|Topic)/);
    expect(text).toContain('Write 500 words'); // the third file still came through
  });

  it('says how to get the rest of a long file', async () => {
    happyPath();
    vi.mocked(client.getTopicFile).mockResolvedValue(file(Buffer.from('x'.repeat(5000)), 'long.txt'));
    const [out] = await readFiles({ files: [{ source: 'topic', orgUnitId: 100, topicId: 1 }], maxCharsPerFile: 2000 });
    expect((out as { text: string }).text).toContain('For the rest: read_file {"source":"topic","orgUnitId":100,"topicId":1,"offset":2000}');
  });
});
