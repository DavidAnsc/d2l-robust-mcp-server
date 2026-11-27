import { z } from 'zod';
import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalToc, marshalTopic, marshalContentModules, marshalContentModule, RawTocModule, RawTopic, RawContentModule } from '../utils/marshal.js';

export const contentTools = {
  get_course_content: {
    description: `Get the complete course syllabus/structure including all modules, topics, lectures, and learning materials. Returns module titles, descriptions, topic names with URLs, and linked assignments. Use to answer: "What's in this course?", "Show me the syllabus", "What topics are covered?", "What lectures are available?", "What reading materials do I have?"`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const toc = await client.getContentToc(resolveCourseId(orgUnitId)) as { Modules: RawTocModule[] };
      return toJson(marshalToc(toc));
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
    description: `Get the main sections/modules of a course. Returns module names, descriptions, and ModuleIds. Use for a high-level overview of course organization.`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const modules = await client.getContentModules(resolveCourseId(orgUnitId)) as RawContentModule[];
      return toJson(marshalContentModules(modules));
    },
  },

  get_course_module: {
    description: `Get all contents within a specific course module/section including child topics, sub-modules, and materials. Use to explore one section of the course in detail.`,
    schema: {
      orgUnitId: courseIdParam,
      moduleId: z.number().int().positive().describe('The ModuleId from get_course_modules or get_course_content. Example: 968296'),
    },
    handler: async ({ orgUnitId, moduleId }: { orgUnitId?: number; moduleId: number }): Promise<string> => {
      const structure = await client.getContentModule(resolveCourseId(orgUnitId), moduleId) as RawContentModule;
      return toJson(marshalContentModule(structure));
    },
  },
};
