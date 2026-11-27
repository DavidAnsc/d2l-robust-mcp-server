#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { httpOptionsFromEnv, startHttpServer } from './http.js';

function wantsHttp(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes('--http') || env.D2L_TRANSPORT?.toLowerCase() === 'http';
}

async function main() {
  if (wantsHttp(process.argv.slice(2), process.env)) {
    // A remote client can't click through a login window on this machine.
    if (process.env.D2L_HEADLESS === undefined) process.env.D2L_HEADLESS = 'true';
    await startHttpServer(httpOptionsFromEnv());
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('D2L Brightspace MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
