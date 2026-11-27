import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalGrades, RawGrade } from '../utils/marshal.js';

export const gradeTools = {
  get_my_grades: {
    description: `Get your grades for a course. Returns all grade items with your scores, including: grade item name, points earned, points possible, percentage (DisplayedGrade), and any feedback comments. Use to answer: "What are my grades?", "What's my score on the quiz?", "How did I do on the assignment?", "What grade did I get?"`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async (args: { orgUnitId?: number }): Promise<string> => {
      const orgUnitId = resolveCourseId(args.orgUnitId);
      const grades = await client.getMyGradeValues(orgUnitId) as RawGrade[];
      return toJson(marshalGrades(grades));
    },
  },
};
