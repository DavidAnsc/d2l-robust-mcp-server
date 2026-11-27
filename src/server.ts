import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodRawShape } from 'zod';
import { assignmentTools } from './tools/dropbox.js';
import { contentTools } from './tools/content.js';
import { gradeTools } from './tools/grades.js';
import { calendarTools } from './tools/calendar.js';
import { newsTools } from './tools/news.js';
import { enrollmentTools } from './tools/enrollments.js';
import { downloadFile } from './tools/files.js';
import { client } from './client.js';
import { getSessionStatus, SessionExpiredError } from './session.js';

export interface ServerOptions {
  /** Register the download_file tool (it writes files to this machine's disk). Default true. */
  enableDownload?: boolean;
}

interface ToolDef {
  description: string;
  schema: ZodRawShape;
  // Each tool module types its own args; the SDK validates them against `schema` first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<string>;
}

const readTools: Record<string, ToolDef> = {
  get_assignments: assignmentTools.get_assignments,
  get_assignment: assignmentTools.get_assignment,
  get_assignment_submissions: assignmentTools.get_assignment_submissions,
  get_course_content: contentTools.get_course_content,
  get_course_topic: contentTools.get_course_topic,
  get_course_modules: contentTools.get_course_modules,
  get_course_module: contentTools.get_course_module,
  get_my_grades: gradeTools.get_my_grades,
  get_upcoming_due_dates: calendarTools.get_upcoming_due_dates,
  get_announcements: newsTools.get_announcements,
  get_my_courses: enrollmentTools.get_my_courses,
};

/**
 * Turn a thrown error into a tool result the model can read and relay.
 * An expired session gets its own wording so a scheduled task can pass it on.
 */
export function errorResult(error: unknown): CallToolResult {
  if (error instanceof SessionExpiredError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `SESSION_EXPIRED: ${error.message}` }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (error) {
    return errorResult(error);
  }
}

export async function sessionStatusText(check: boolean): Promise<string> {
  if (check) {
    try {
      await client.whoami();
    } catch (error) {
      // SessionExpiredError already updated the status; other errors are reported alongside it.
      if (!(error instanceof SessionExpiredError)) {
        const status = getSessionStatus();
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ ...status, checkError: message }, null, 2);
      }
    }
  }
  return JSON.stringify(getSessionStatus(), null, 2);
}

export function createServer(options: ServerOptions = {}): McpServer {
  const enableDownload = options.enableDownload ?? true;

  const server = new McpServer({
    name: 'd2l-brightspace',
    version: '1.0.0',
  });

  for (const [name, tool] of Object.entries(readTools)) {
    server.tool(name, tool.description, tool.schema, async (args: unknown) => run(() => tool.handler(args)));
  }

  server.tool(
    'get_session_status',
    'Check whether the saved D2L login session still works. Returns state ("valid", "expired" or "unknown"), when it last worked, and what to do if it has expired. Set check=true to test it now with a lightweight API call; otherwise reports what the server last saw. Use when other tools fail with SESSION_EXPIRED, or before a scheduled summary.',
    {
      check: z.boolean().optional().describe('Make a live API call to verify the session (default: false)'),
    },
    async (args) => run(() => sessionStatusText(args.check ?? false))
  );

  if (enableDownload) {
    server.tool(
      'download_file',
      'Download a file from D2L Brightspace. Provide a D2L content URL (e.g., https://learn.ul.ie/content/enforced/68929-CS4444.../file.docx or /content/enforced/...). The file will be saved to your Downloads folder by default, or to a custom path if specified. Returns the local file path, filename, size, and content type. Use this to download lecture slides, assignment files, course materials, or any file linked in course content.',
      {
        url: z.string().describe('The D2L URL or path to the file to download (e.g., https://learn.ul.ie/content/enforced/68929-CS4444_SEM1_2025_6/file.docx)'),
        savePath: z.string().optional().describe('Optional: Custom path to save the file (directory or full file path). Defaults to ~/Downloads'),
      },
      async (args) =>
        run(async () => {
          const result = await downloadFile(args.url, args.savePath);
          const sizeKB = (result.size / 1024).toFixed(1);
          let text = `Downloaded: ${result.filename}\nPath: ${result.path}\nSize: ${sizeKB} KB\nType: ${result.contentType}`;
          if (result.content) {
            text += `\n\n--- File Content ---\n${result.content}`;
          }
          return text;
        })
    );
  }

  return server;
}
