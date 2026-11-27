import { z } from 'zod';
import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalAssignments, marshalAssignment, marshalSubmissions, RawAssignment, RawSubmission } from '../utils/marshal.js';

export const assignmentTools = {
  get_assignments: {
    description: `List all assignments for a course with their due dates and instructions. Returns: Name, DueDate (ISO 8601 format - compare with current date to find upcoming/overdue), instructions (in CustomInstructions.Text), point value (Assessment.ScoreDenominator), and Id (needed for get_assignment_submissions). Use this to answer: "What assignments do I have?", "What's due this week?", "What are my upcoming deadlines?", "Show me assignment instructions", "What homework is due soon?"`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async ({ orgUnitId }: { orgUnitId?: number }): Promise<string> => {
      const folders = await client.getDropboxFolders(resolveCourseId(orgUnitId)) as RawAssignment[];
      return toJson(marshalAssignments(folders));
    },
  },

  get_assignment: {
    description: `Get full details about a specific assignment including complete instructions, due date, point value, allowed file types, and grading rubrics. Use after get_assignments when you need more detail about one assignment.`,
    schema: {
      orgUnitId: courseIdParam,
      assignmentId: z.number().int().positive().describe('The assignment Id from get_assignments. Example: 37812'),
    },
    handler: async ({ orgUnitId, assignmentId }: { orgUnitId?: number; assignmentId: number }): Promise<string> => {
      const folder = await client.getDropboxFolder(resolveCourseId(orgUnitId), assignmentId) as RawAssignment;
      return toJson(marshalAssignment(folder));
    },
  },

  get_assignment_submissions: {
    description: `Get the user's submissions for an assignment. Shows submitted files, submission timestamps, feedback comments, and grades received. Use to answer: "Did I submit this assignment?", "What grade did I get?", "When did I submit?", "What feedback did I receive?"`,
    schema: {
      orgUnitId: courseIdParam,
      assignmentId: z.number().int().positive().describe('The assignment Id from get_assignments. Example: 37812'),
    },
    handler: async ({ orgUnitId, assignmentId }: { orgUnitId?: number; assignmentId: number }): Promise<string> => {
      const submissions = await client.getDropboxSubmissions(resolveCourseId(orgUnitId), assignmentId) as RawSubmission[];
      return toJson(marshalSubmissions(submissions));
    },
  },
};
