/**
 * MCP prompts and resources, for clients that use them instead of (or as well as) tools.
 *
 * Prompts are ready-made requests ("write a guide for this assignment") that tell the model
 * which tools to call and in what order. Resources expose the same documents the study tools
 * build, under d2l:// addresses that a client can attach to a conversation.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToc, mapLimit } from './content-tree.js';
import { client } from './client.js';
import { activeCourses } from './tools/across.js';
import { toJson } from './tools/common.js';
import { buildAssignmentBundle, buildUnitMaterials } from './tools/study.js';
import { loadFile } from './tools/read.js';
import { RawAssignment } from './utils/marshal.js';

const COURSE_HINT =
  'If I named the course rather than giving its id, find it with get_active_courses (or get_my_courses) first.';

function promptText(lines: string[]): { messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } {
  return { messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }] };
}

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'assignment-guide',
    'Write a guide for one assignment from what Brightspace has on it.',
    {
      course: z.string().describe('Course name, code or orgUnitId'),
      assignment: z.string().describe('Assignment name or id'),
    },
    ({ course, assignment }) =>
      promptText([
        `Write me a guide for the assignment "${assignment}" in my course "${course}".`,
        '',
        'Gather what you need, using your judgement about what is relevant:',
        `- ${COURSE_HINT} Find the assignment with get_assignments if I didn't give its id.`,
        '- get_assignment: instructions, rubric, weight, and the attached files (read them with read_files).',
        '- find_related: content that links to or names it, and announcements about it. Read the items that look',
        '  useful (handouts, templates, the lecture it builds on) with read_files; skip what clearly is not.',
        '- If the instructions leave something open, check announcements and discussions (find_related with',
        '  searchDiscussions=true, or search_course) before saying it is unclear.',
        '- If I have already submitted, get_assignment_submissions shows my feedback.',
        '',
        'Then write the guide. Cover what to hand in, how and when (exact date, time and zone); the task in steps;',
        'how it is graded (every rubric criterion, what earns full marks, its weight); format rules; which course',
        'material to use and where it is; clarifications from announcements; a checklist before submitting; and',
        'open questions to ask the instructor. Quote exact wording for requirements and dates, and say where each',
        'point comes from. Do not write the assignment itself.',
      ])
  );

  server.prompt(
    'study-guide',
    'Write a study guide for a test from the slides, documents and worksheets in the units it covers.',
    {
      course: z.string().describe('Course name, code or orgUnitId'),
      units: z.string().describe('The units, weeks or topics the test covers, e.g. "Units 3-5" or "Weeks 1 to 6"'),
      test: z.string().optional().describe('Which test, e.g. "Midterm 2" (optional)'),
    },
    ({ course, units, test }) =>
      promptText([
        `Make me a study guide${test ? ` for ${test}` : ''} in my course "${course}", covering ${units}.`,
        '',
        'Gather what you need, using your judgement:',
        `- ${COURSE_HINT}`,
        '- Find the modules with get_course_content (or list_unit_items with moduleTitle), then list_unit_items',
        '  for them. Module descriptions often state the learning outcomes: use them to decide what matters.',
        '- Read the substantive material with read_files in batches: lecture slides, notes, worksheets and their',
        '  solutions, practice tests. Skip administrative items. For slides whose meaning is in a diagram or an',
        '  equation, look at them with read_file asImages=true.',
        `- Check what the test covers and its format: get_quizzes, get_course_overview, and search_course${test ? ` for "${test}"` : ''} or get_announcements with a query.`,
        '',
        'Then write the guide: what the test covers and its format if known; for each unit the key ideas,',
        'definitions, every formula with what each symbol means, and a worked example of each method, in the',
        'order the course teaches them; links between units and common mistakes; practice questions with',
        'answers based on the worksheets; and a one-page summary. Name the file each point comes from, and',
        'list the items you could not read (videos, links, external tools).',
      ])
  );

  server.prompt(
    'catch-up',
    'What changed in all my courses, and what is due soon.',
    { since: z.string().optional().describe('How far back, e.g. "3d" or a date (default 7 days)') },
    ({ since }) =>
      promptText([
        `Catch me up on my courses since ${since ?? 'a week ago'}.`,
        `Start with whats_new${since ? ` (since="${since}")` : ''}; open anything that needs a closer look (an announcement's`,
        'attachment, a changed file, new feedback). Then summarize, most urgent first: deadlines in the next week,',
        'announcements that change something (dates, requirements, rooms), new grades and feedback, and new',
        'material to review. Keep it short and give exact dates.',
      ])
  );
}

/** A course's assignments and top-level modules, briefly cached: resource listing calls this often. */
const LIST_TTL_MS = 5 * 60 * 1000;
let listCache: { at: number; resources: Array<{ uri: string; name: string; description?: string; mimeType: string }> } | undefined;

async function listCourseResources() {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.resources;
  let courses: Awaited<ReturnType<typeof activeCourses>>;
  try {
    courses = await activeCourses();
  } catch {
    // An expired login (or Brightspace being down) must not break listing; tools will say why.
    return [];
  }
  const perCourse = await mapLimit(courses, 2, async (c) => {
    const out: Array<{ uri: string; name: string; description?: string; mimeType: string }> = [];
    try {
      for (const m of await getToc(c.id)) {
        out.push({ uri: `d2l://course/${c.id}/module/${m.ModuleId}`, name: `${c.code || c.name}: ${m.Title}`, description: `All material in "${m.Title}"`, mimeType: 'text/markdown' });
      }
    } catch {
      // A course whose content can't be listed just has no module resources.
    }
    try {
      for (const a of (await client.getDropboxFolders(c.id)) as RawAssignment[]) {
        out.push({ uri: `d2l://course/${c.id}/assignment/${a.Id}`, name: `${c.code || c.name}: ${a.Name}`, description: 'Assignment bundle', mimeType: 'text/markdown' });
      }
    } catch {
      // Same for assignments.
    }
    return out;
  });
  listCache = { at: Date.now(), resources: perCourse.flat() };
  return listCache.resources;
}

/** Resources return whole documents; cap them so one can't swamp a client. */
const MAX_RESOURCE_CHARS = 1_000_000;
const cap = (text: string) =>
  text.length > MAX_RESOURCE_CHARS ? `${text.slice(0, MAX_RESOURCE_CHARS)}\n\n(Cut at ${MAX_RESOURCE_CHARS} characters; use the matching tool with offset for the rest.)` : text;

const num = (v: string | string[]) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Not an id: ${v}`);
  return n;
};

export function registerResources(server: McpServer): void {
  server.resource('active-courses', 'd2l://courses', { description: 'Your current courses', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: toJson(await activeCourses()) }],
  }));

  server.resource(
    'assignment-bundle',
    new ResourceTemplate('d2l://course/{orgUnitId}/assignment/{assignmentId}', { list: async () => ({ resources: (await listCourseResources()).filter((r) => r.uri.includes('/assignment/')) }) }),
    { description: 'Everything about one assignment (instructions, rubric, files, related content, announcements, feedback)', mimeType: 'text/markdown' },
    async (uri, { orgUnitId, assignmentId }) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: cap(await buildAssignmentBundle({ orgUnitId: num(orgUnitId), assignmentId: num(assignmentId) })) }],
    })
  );

  server.resource(
    'unit-materials',
    new ResourceTemplate('d2l://course/{orgUnitId}/module/{moduleId}', { list: async () => ({ resources: (await listCourseResources()).filter((r) => r.uri.includes('/module/')) }) }),
    { description: 'The text of every file and page in a course module', mimeType: 'text/markdown' },
    async (uri, { orgUnitId, moduleId }) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: cap(await buildUnitMaterials({ orgUnitId: num(orgUnitId), moduleId: num(moduleId) })) }],
    })
  );

  server.resource(
    'topic-file',
    new ResourceTemplate('d2l://course/{orgUnitId}/topic/{topicId}', { list: undefined }),
    { description: 'The text of one content file or page', mimeType: 'text/plain' },
    async (uri, { orgUnitId, topicId }) => {
      const got = await loadFile({ source: 'topic', orgUnitId: num(orgUnitId), topicId: num(topicId) });
      const text = typeof got === 'string' ? got : `File: ${got.filename}\n\n${got.extracted.text}`;
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: cap(text) }] };
    }
  );
}
