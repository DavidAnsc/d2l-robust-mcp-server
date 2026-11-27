import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalAnnouncements, RawAnnouncement } from '../utils/marshal.js';

export const newsTools = {
  get_announcements: {
    description: `Get course announcements/news items from instructors. Returns: title, body (text and HTML), created date, author, attachments, whether it's pinned. Use to answer: "Any new announcements?", "What did the professor post?", "Are there any updates?", "What's the latest news?"`,
    schema: {
      orgUnitId: courseIdParam,
    },
    handler: async (args: { orgUnitId?: number }): Promise<string> => {
      const orgUnitId = resolveCourseId(args.orgUnitId);
      const news = await client.getNews(orgUnitId) as RawAnnouncement[];
      return toJson(marshalAnnouncements(news));
    },
  },
};
