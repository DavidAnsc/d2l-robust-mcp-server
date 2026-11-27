#!/usr/bin/env node
/**
 * CLI tool to manage the saved D2L login session.
 *
 *   d2l-mcp-auth                  Log in (opens a browser window) and save the session.
 *   d2l-mcp-auth --export <file>  Write the session's cookies to a JSON file.
 *   d2l-mcp-auth --import <file>  Load cookies from such a file into this machine's session.
 *   d2l-mcp-auth --status         Check headlessly whether the saved session still works.
 *
 * Export/import exists for machines without a screen (e.g. a Raspberry Pi): log in on a
 * laptop, export, copy the file over, import. Copying the ~/.d2l-session folder itself is
 * not reliable across operating systems because the browser encrypts its cookie store
 * with an OS-specific key.
 */
import { chromium } from 'playwright';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { clearTokenCache, getToken, getTokenExpiry } from './auth.js';
import { ExportFile, getSessionPath, isHeadlessOnly, parseExportFile, SessionExpiredError } from './session.js';

const USAGE = `Usage:
  d2l-mcp-auth                  Log in and save the session
  d2l-mcp-auth --export <file>  Export session cookies to <file>
  d2l-mcp-auth --import <file>  Import session cookies from <file>
  d2l-mcp-auth --status         Check whether the saved session still works`;


async function login(): Promise<void> {
  if (isHeadlessOnly()) {
    console.error('No display available, so a login window cannot open here.');
    console.error('Log in on a machine with a screen, then:');
    console.error('  there:  d2l-mcp-auth --export d2l-session.json');
    console.error('  here:   d2l-mcp-auth --import d2l-session.json');
    console.error('(Or set D2L_HEADLESS=false if you have a display, e.g. over VNC.)');
    process.exit(1);
  }
  console.log('Starting D2L authentication...');
  console.log('A browser window will open. Please log in to Brightspace.');
  console.log('');

  const token = await getToken();
  const expiry = new Date(getTokenExpiry());

  console.log('');
  console.log('Authentication successful!');
  console.log(`Token expires at: ${expiry.toLocaleString()}`);
  console.log('');
  console.log('Your session has been saved. The MCP server will use it automatically.');
  console.log('Token (first 50 chars):', token.substring(0, 50) + '...');
}

async function exportSession(file: string): Promise<void> {
  const sessionPath = getSessionPath();
  if (!existsSync(sessionPath)) {
    throw new Error(`No saved session at ${sessionPath}. Run d2l-mcp-auth first.`);
  }
  const context = await chromium.launchPersistentContext(sessionPath, { headless: true });
  try {
    const { cookies } = await context.storageState();
    const out: ExportFile = {
      format: 'd2l-mcp-session',
      version: 1,
      host: process.env.D2L_HOST || 'learn.ul.ie',
      exportedAt: new Date().toISOString(),
      cookies,
    };
    // The file is as good as your password while the session lasts: owner-only permissions.
    writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`Exported ${cookies.length} cookies to ${file} (permissions 600).`);
    console.log('Copy it to the other machine (e.g. with scp), run --import there, then delete both copies.');
  } finally {
    await context.close();
  }
}

async function importSession(file: string): Promise<void> {
  const data = parseExportFile(readFileSync(file, 'utf-8'));
  const currentHost = process.env.D2L_HOST || 'learn.ul.ie';
  if (data.host !== currentHost) {
    console.warn(`Warning: file was exported for ${data.host}, but D2L_HOST here is ${currentHost}.`);
  }
  const sessionPath = getSessionPath();
  mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  chmodSync(sessionPath, 0o700);
  const context = await chromium.launchPersistentContext(sessionPath, { headless: true });
  try {
    await context.clearCookies();
    await context.addCookies(data.cookies);
  } finally {
    await context.close();
  }
  console.log(`Imported ${data.cookies.length} cookies into ${sessionPath}.`);
  console.log('Checking the session...');
  await status();
}

async function status(): Promise<void> {
  process.env.D2L_HEADLESS = 'true';
  clearTokenCache();
  try {
    await getToken();
    console.log(`Session is valid. Token cached until ${new Date(getTokenExpiry()).toLocaleString()}.`);
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (!cmd) return await login();
    if (cmd === '--status') return await status();
    if ((cmd === '--export' || cmd === '--import') && arg) {
      return cmd === '--export' ? await exportSession(arg) : await importSession(arg);
    }
    console.error(USAGE);
    process.exit(cmd === '--help' || cmd === '-h' ? 0 : 1);
  } catch (error) {
    console.error('Authentication failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
