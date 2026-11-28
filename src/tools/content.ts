import { z } from 'zod';
import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalTopic, RawTopic, removeEmpty, formatDate } from '../utils/marshal.js';
import { classifyTopic, findModuleById, getToc, moduleDescription, RawTocModule, RawTocTopic, walkModule } from '../content-tree.js';

/** A topic as the content tools show it: what it is, and when it last changed. */
function topicSummary(t: RawTocTopic) {
  return removeEmpty({
    id: t.TopicId,
    title: t.Title,
    kind: classifyTopic(t),
    url: t.Url || null,
    lastModified: formatDate(t.LastModifiedDate),
    assignmentId: classifyTopic(t) === 'assignment' ? t.ToolItemId ?? null : null,
  });
}

function moduleTree(m: RawTocModule): Record<string, unknown> {
  return removeEmpty({
    id: m.ModuleId,
    title: m.Title,
    description: moduleDescription(m) || null,
    topics: (m.Topics ?? []).map(topicSummary),
    modules: (m.Modules ?? []).map(moduleTree),
  });
}

export const contentTools = {
  get_course_content: {
    description: `Get the complete course outline: every module (unit/week) and topic, with each topic's kind (file, page, link, video, assignment, quiz, discussion, external_tool, scorm…), URL and last-modified date. Returns ModuleIds (for get_unit_materials) and TopicIds (for read_file). Use to answer: "What's in this course?", "Show me the syllabus structure", "What lectures are available?"`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const toc = await getToc(resolveCourseId(orgUnitId));
      return toJson(toc.map(moduleTree));
    },
  },

  get_course_topic: {
    description: `Get details about a specific course topic/lecture/reading including title, description, URL, and linked assignments. Use after get_course_content to get more info about a specific item.`,
    schema: {
      orgUnitId: courseIdParam,
      topicId: z.number().int().positive().describe('The TopicId from get_course_content. Example: 968299'),
    },
    handler: async ({ orgUnitId, topicId }: { orgUnitId?: number; topicId: number }): Promise<string> => {
      const topic = await client.getContentTopic(resolveCourseId(orgUnitId), topicId) as RawTopic;
      return toJson(marshalTopic(topic));
    },
  },

  get_course_modules: {
    description: `Get the top-level sections/modules of a course: ModuleId, title, description, and how many topics each holds (including sub-modules). Use for a quick overview of how the course is organized.`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const toc = await getToc(resolveCourseId(orgUnitId));
      return toJson(toc.map((m) => removeEmpty({
        id: m.ModuleId,
        title: m.Title,
        description: moduleDescription(m) || null,
        subModules: (m.Modules ?? []).map((c) => ({ id: c.ModuleId, title: c.Title })),
        topicCount: walkModule(m).length,
      })));
    },
  },

  get_course_module: {
    description: `Get everything inside one course module/section: its topics (with kinds and TopicIds) and sub-modules. To get the text of every file in it at once, use get_unit_materials.`,
    schema: {
      orgUnitId: courseIdParam,
      moduleId: z.number().int().positive().describe('The ModuleId from get_course_modules or get_course_content. Example: 968296'),
    },
    handler: async ({ orgUnitId, moduleId }: { orgUnitId?: number; moduleId: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const found = findModuleById(await getToc(course), moduleId);
      if (!found) throw new Error(`Module ${moduleId} is not in course ${course}'s content. get_course_content lists the modules.`);
      return toJson({ path: [...found.parents, found.module.Title].join(' > '), ...moduleTree(found.module) });
    },
  },
};
