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
    'Write a complete guide for one assignment from everything Brightspace has on it.',
    {
      course: z.string().describe('Course name, code or orgUnitId'),
      assignment: z.string().describe('Assignment name or id'),
    },
    ({ course, assignment }) =>
      promptText([
        `Write me a guide for the assignment "${assignment}" in my course "${course}".`,
        '',
        `1. ${COURSE_HINT} If I named the assignment, find its id with get_assignments.`,
        '2. Call get_assignment_bundle for it, reading every part (follow the offset hints until the last part).',
        '3. If the instructions point to other material (a reading, a lecture, a template), open it with read_file, or',
        '   get_unit_materials for a whole module. If something is unclear, call get_assignment_bundle again with searchDiscussions=true.',
        '4. Write the guide with these sections:',
        '   - What to hand in, how, and when (date, time and time zone; late policy if stated; individual or group).',
        '   - The task, in plain words, broken into steps.',
        '   - How it is graded: every rubric criterion and what earns full marks; its weight in the final grade.',
        '   - Required format and constraints (length, file type, citation style, templates).',
        '   - Material from the course to use, with where it is (module and file names).',
        '   - Clarifications from announcements or discussions.',
        '   - A checklist to tick off before submitting.',
        "   - Open questions: anything the sources don't settle, to ask the instructor.",
        'Quote the exact wording for requirements and dates. Cite the source of each point (instructions, rubric, a file, an announcement).',
        'Do not write the assignment itself.',
      ])
  );

  server.prompt(
    'study-guide',
    'Write a study guide for a test from every slide, document and worksheet in the units it covers.',
    {
      course: z.string().describe('Course name, code or orgUnitId'),
      units: z.string().describe('The units, weeks or topics the test covers, e.g. "Units 3-5" or "Weeks 1 to 6"'),
      test: z.string().optional().describe('Which test, e.g. "Midterm 2" (optional)'),
    },
    ({ course, units, test }) =>
      promptText([
        `Make me a study guide${test ? ` for ${test}` : ''} in my course "${course}", covering ${units}.`,
        '',
        `1. ${COURSE_HINT}`,
        '2. Call get_course_content to find the modules for those units; then get_unit_materials with their moduleIds',
        '   (manifestOnly=true first if there are many), and read every part (follow the offset hints to the end).',
        '3. For slides whose meaning is in a diagram or equation, look at them with read_file asImages=true.',
        `4. Check get_quizzes and get_course_overview for what the test covers, its format and length${test ? `, and search_course for "${test}"` : ''}.`,
        '5. Write the guide:',
        '   - What the test covers and its format, if known (date, length, question types, allowed aids).',
        '   - For each unit: the key ideas and definitions, every formula with what each symbol means,',
        '     and a worked example for each method, in the order the course teaches them.',
        '   - Connections between units, and common mistakes the slides warn about.',
        '   - Practice questions with answers, based on the worksheets and examples in the materials.',
        '   - A one-page summary sheet at the end.',
        'Name the file each point comes from, and say which items could not be read (videos, links, external tools).',
      ])
  );

  server.prompt(
    'catch-up',
    'What changed in all my courses, and what is due soon.',
    { since: z.string().optional().describe('How far back, e.g. "3d" or a date (default 7 days)') },
    ({ since }) =>
      promptText([
        `Catch me up on my courses since ${since ?? 'a week ago'}.`,
        `Call whats_new${since ? ` with since="${since}"` : ''} and read every part. Then summarize, most urgent first:`,
        'deadlines in the next week, new announcements that change something (dates, requirements, rooms),',
        'new grades and feedback, and new material to review. Keep it short and give exact dates.',
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
