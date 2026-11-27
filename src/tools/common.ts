import { z } from 'zod';

export { resolveCourseId } from '../config.js';

/** The optional course parameter every course-scoped tool takes. */
export const courseIdParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('The course ID (orgUnitId from get_my_courses). Optional if D2L_COURSE_ID is set.');

/** Pretty JSON for tool output. */
export const toJson = (value: unknown): string => JSON.stringify(value, null, 2);
