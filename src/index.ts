#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { httpConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createServer, VERSION } from './server.js';

const HELP = `d2l-mcp ${VERSION}: MCP server for D2L Brightspace (read-only)

Usage:
  d2l-mcp            Serve over stdio (for Claude Desktop and other local clients)
  d2l-mcp --http     Serve over streamable HTTP (see D2L_HTTP_* settings)
  d2l-mcp --version
  d2l-mcp --help

Log in first with: d2l-mcp-auth`;

async function main(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) return console.log(HELP);
  if (argv.includes('--version') || argv.includes('-v')) return console.log(VERSION);

  if (argv.includes('--http') || process.env.D2L_TRANSPORT?.toLowerCase() === 'http') {
    // A remote client can't click through a login window on this machine.
    process.env.D2L_HEADLESS ??= 'true';
    await startHttpServer(httpConfig());
    return;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('D2L Brightspace MCP server running on stdio');
}

main(process.argv.slice(2)).catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
