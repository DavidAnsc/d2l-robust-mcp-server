/**
 * File references: the one shape every listing tool uses to point at something readable.
 *
 * A ref is exactly the arguments read_file and read_files take, so an agent can copy it from
 * any listing (course content, a unit, an assignment's attachments, an announcement, a
 * search hit, a submission) straight into a read call, without working out which ids go where.
 */
import { z } from 'zod';

export type ReadRef =
  | { source: 'topic'; orgUnitId: number; topicId: number }
  | { source: 'assignment_attachment'; orgUnitId: number; assignmentId: number; fileId: number }
  | { source: 'submission_file'; orgUnitId: number; assignmentId: number; submissionId: number; fileId: number }
  | { source: 'feedback_file'; orgUnitId: number; assignmentId: number; fileId: number; entityType?: 'user' | 'group'; entityId?: number }
  | { source: 'announcement_attachment'; orgUnitId: number; announcementId: number; fileId: number }
  | { source: 'overview_attachment'; orgUnitId: number }
  | { source: 'url'; url: string };

export const topicRef = (orgUnitId: number, topicId: number): ReadRef => ({ source: 'topic', orgUnitId, topicId });

const id = z.number().int().positive();

/** The zod shape of a ref, for tools that take one or many. */
export const readRefSchema = z
  .object({
    source: z.enum(['topic', 'assignment_attachment', 'submission_file', 'feedback_file', 'announcement_attachment', 'overview_attachment', 'url']),
    orgUnitId: id.optional(),
    topicId: id.optional(),
    assignmentId: id.optional(),
    submissionId: id.optional(),
    fileId: id.optional(),
    entityId: id.optional(),
    entityType: z.enum(['user', 'group']).optional(),
    announcementId: id.optional(),
    url: z.string().optional(),
  })
  .describe('A file reference, copied from the "read" field of any listing tool.');
