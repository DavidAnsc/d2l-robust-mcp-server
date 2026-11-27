import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { assignmentTools } from './tools/dropbox.js';
import { contentTools } from './tools/content.js';
import { gradeTools } from './tools/grades.js';
import { calendarTools } from './tools/calendar.js';
import { newsTools } from './tools/news.js';
import { enrollmentTools } from './tools/enrollments.js';
import { fileTools } from './tools/files.js';
import { sessionTools } from './tools/session.js';
import { readTools, ToolContent } from './tools/read.js';
import { SessionExpiredError } from './session.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
export const VERSION = pkg.version;

export interface ServerOptions {
  /** Register download_file (it writes files to this machine's disk). Default true. */
  enableDownload?: boolean;
}

interface ToolDef {
  description: string;
  schema: ZodRawShape;
  // Each module types its own args; the SDK validates them against `schema` before the call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<string | ToolContent[]>;
}

/** Every tool that only reads from Brightspace. */
const readOnlyTools: Record<string, ToolDef> = {
  ...assignmentTools,
  ...contentTools,
  ...gradeTools,
  ...calendarTools,
  ...newsTools,
  ...enrollmentTools,
  ...sessionTools,
  ...readTools,
};

/** First line of an error, without terminal colour codes (Playwright adds a call log and ANSI codes). */
export function cleanMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\nCall log:')[0].trim();
}

/**
 * Turn a thrown error into a tool result the model can read and relay.
 * An expired session gets a fixed prefix so a scheduled task can detect it.
 */
export function errorResult(error: unknown): CallToolResult {
  if (error instanceof SessionExpiredError) {
    return { isError: true, content: [{ type: 'text', text: `SESSION_EXPIRED: ${error.message}` }] };
  }
  const message = cleanMessage(error instanceof Error ? error.message : String(error));
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

function register(server: McpServer, name: string, tool: ToolDef): void {
  server.tool(name, tool.description, tool.schema, async (args: unknown): Promise<CallToolResult> => {
    try {
      const out = await tool.handler(args);
      return { content: typeof out === 'string' ? [{ type: 'text', text: out }] : out };
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'd2l-brightspace', version: VERSION });
  for (const [name, tool] of Object.entries(readOnlyTools)) register(server, name, tool);
  if (options.enableDownload ?? true) register(server, 'download_file', fileTools.download_file);
  return server;
}
