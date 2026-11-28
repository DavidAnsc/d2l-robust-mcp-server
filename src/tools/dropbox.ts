import { z } from 'zod';
import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalAssignments, marshalAssignment, marshalSubmissions, marshalRubric, RawAssignment, RawRubric, RawSubmission } from '../utils/marshal.js';
import { skipped, tolerant } from './tolerant.js';

interface RawGradeObject {
  Id: number;
  Name: string;
  CategoryId?: number | null;
  Weight?: number | null;
  MaxPoints?: number | null;
}

const DAY = 864e5;

export const assignmentTools = {
  get_assignments: {
    description: `List a course's assignments with due dates, points, instructions and ids. Filter with status ("upcoming", "past" or "all", default all) and dueWithinDays. Use get_assignment for one assignment's rubric, weight and files. Use to answer: "What assignments do I have?", "What's due this week?"`,
    schema: {
      orgUnitId: courseIdParam,
      status: z.enum(['upcoming', 'past', 'all']).optional().describe('upcoming: due date in the future or none; past: due date gone by.'),
      dueWithinDays: z.number().int().min(0).max(365).optional().describe('Only assignments due within this many days from now.'),
    },
    handler: async ({ orgUnitId, status, dueWithinDays }: { orgUnitId?: number; status?: 'upcoming' | 'past' | 'all'; dueWithinDays?: number }): Promise<string> => {
      const now = Date.now();
      let folders = await client.getDropboxFolders(resolveCourseId(orgUnitId)) as RawAssignment[];
      const due = (a: RawAssignment) => (a.DueDate ? new Date(a.DueDate).getTime() : undefined);
      if (status === 'upcoming') folders = folders.filter((a) => due(a) === undefined || due(a)! >= now);
      if (status === 'past') folders = folders.filter((a) => due(a) !== undefined && due(a)! < now);
      if (dueWithinDays !== undefined) folders = folders.filter((a) => due(a) !== undefined && due(a)! >= now && due(a)! <= now + dueWithinDays * DAY);
      return toJson(marshalAssignments(folders));
    },
  },

  get_assignment: {
    description: `One assignment in full: instructions, due and availability dates, points, the rubric (every criterion and level), its grade item and weight, allowed file types, links, and attachments with "read" refs (read them with read_files). Next: find_related for course content and announcements about it, get_assignment_submissions for your feedback.`,
    schema: {
      orgUnitId: courseIdParam,
      assignmentId: z.number().int().positive().describe('The assignment Id from get_assignments. Example: 37812'),
    },
    handler: async ({ orgUnitId, assignmentId }: { orgUnitId?: number; assignmentId: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const folder = await client.getDropboxFolder(course, assignmentId) as RawAssignment;
      const a = marshalAssignment(folder);
      const [rubrics, grades, categories] = await Promise.all([
        a.rubrics ? skipped<RawRubric[]>() : tolerant(async () => (await client.getRubrics(course, 'Dropbox', assignmentId)) as RawRubric[]),
        folder.GradeItemId ? tolerant(async () => (await client.getGradeObjects(course)) as RawGradeObject[]) : skipped<RawGradeObject[]>(),
        folder.GradeItemId ? tolerant(async () => (await client.getGradeCategories(course)) as Array<{ Id: number; Name: string; Weight?: number | null }>) : skipped<Array<{ Id: number; Name: string; Weight?: number | null }>>(),
      ]);
      const g = grades.value?.find((x) => x.Id === folder.GradeItemId);
      const cat = g && categories.value?.find((c) => c.Id === g.CategoryId);
      return toJson({
        ...a,
        rubrics: a.rubrics ?? (rubrics.value?.length ? rubrics.value.map(marshalRubric) : undefined),
        rubricNote: !a.rubrics && !rubrics.value?.length ? `No rubric found${rubrics.error ? ` (${rubrics.error})` : ''}.` : undefined,
        gradeItem: g ? { name: g.Name, maxPoints: g.MaxPoints ?? null, weight: g.Weight || null, category: cat ? { name: cat.Name, weight: cat.Weight || null } : null } : undefined,
        attachments: a.attachments?.map((f) => ({ ...f, read: { source: 'assignment_attachment', orgUnitId: course, assignmentId, fileId: f.fileId } })),
      });
    },
  },

  get_assignment_submissions: {
    description: `Your submissions for an assignment (every attempt), with timestamps, comments, the grade and feedback. Submitted files and feedback files carry "read" refs for read_files. Use to answer: "Did I submit this?", "What feedback did I get?"`,
    schema: {
      orgUnitId: courseIdParam,
      assignmentId: z.number().int().positive().describe('The assignment Id from get_assignments. Example: 37812'),
    },
    handler: async ({ orgUnitId, assignmentId }: { orgUnitId?: number; assignmentId: number }): Promise<string> => {
      const course = resolveCourseId(orgUnitId);
      const submissions = await client.getDropboxSubmissions(course, assignmentId) as RawSubmission[];
      const withRefs = marshalSubmissions(submissions).map((s) => {
        const fileRef = (submissionId: number | undefined) => (f: { fileId?: number }) =>
          submissionId && f.fileId ? { ...f, read: { source: 'submission_file', orgUnitId: course, assignmentId, submissionId, fileId: f.fileId } } : f;
        const group = s.entityType === 'group' ? { entityType: 'group', entityId: s.entityId } : {};
        return {
          ...s,
          files: s.files.map(fileRef(s.submissionId)),
          feedbackFiles: s.feedbackFiles?.map((f) => ({ ...f, read: { source: 'feedback_file', orgUnitId: course, assignmentId, fileId: f.fileId, ...group } })),
          earlierAttempts: s.earlierAttempts?.map((x) => ({ ...x, files: x.files.map(fileRef(x.submissionId)) })),
        };
      });
      return toJson(withRefs);
    },
  },
};
