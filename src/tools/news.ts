import { z } from 'zod';
import { client } from '../client.js';
import { courseIdParam, resolveCourseId, toJson } from './common.js';
import { marshalAnnouncements, RawAnnouncement, stripHtml } from '../utils/marshal.js';
import { parseSince } from './across.js';

export const newsTools = {
  get_announcements: {
    description: `Get course announcements from instructors: title, body, date, and attachments with "read" refs for read_files. Narrow with since ("7d", "2w", a date) and query (words that must all appear). Use to answer: "Any new announcements?", "Did the professor say anything about the midterm?"`,
    schema: {
      orgUnitId: courseIdParam,
      since: z.string().optional().describe('Only announcements from this recent: "48h", "7d", "2w" or a date such as 2026-11-01.'),
      query: z.string().optional().describe('Only announcements whose title or body contain all these words.'),
    },
    handler: async (args: { orgUnitId?: number; since?: string; query?: string }): Promise<string> => {
      const orgUnitId = resolveCourseId(args.orgUnitId);
      let news = await client.getNews(orgUnitId) as RawAnnouncement[];
      if (args.since) {
        const from = parseSince(args.since).getTime();
        news = news.filter((n) => new Date(n.StartDate || n.CreatedDate).getTime() >= from);
      }
      if (args.query) {
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        news = news.filter((n) => {
          const text = `${n.Title}\n${stripHtml(n.Body?.Text || n.Body?.Html)}`.toLowerCase();
          return words.every((w) => text.includes(w));
        });
      }
      return toJson(marshalAnnouncements(news).map((a) => ({
        ...a,
        attachments: a.attachments?.map((f) => ({ ...f, read: { source: 'announcement_attachment', orgUnitId, announcementId: a.id, fileId: f.fileId } })),
      })));
    },
  },
};
