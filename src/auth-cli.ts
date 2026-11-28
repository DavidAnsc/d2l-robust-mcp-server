#!/usr/bin/env node
/**
 * CLI tool to manage the saved D2L login session.
 *
 *   d2l-mcp-auth                  Log in (opens a browser window) and save the session.
 *   d2l-mcp-auth --export <file>  Write the session's cookies to a JSON file.
 *   d2l-mcp-auth --import <file>  Load cookies from such a file into this machine's session.
 *   d2l-mcp-auth --status         Check headlessly whether the saved session still works.
 *   d2l-mcp-auth --push [url]     Log in here if needed, then send the login to a server
 *                                 running `d2l-mcp --http` (e.g. a Raspberry Pi at home).
 *
 * Export/import exists for machines without a screen (e.g. a Raspberry Pi): log in on a
 * laptop, export, copy the file over, import. Copying the ~/.d2l-session folder itself is
 * not reliable across operating systems because the browser encrypts its cookie store
 * with an OS-specific key.
 */
import { chromium } from 'playwright';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { clearTokenCache, getToken, getTokenExpiry, importCookies } from './auth.js';
import { browserLaunchOptions, d2lHost, isHeadlessOnly, sessionPath } from './config.js';
import { ExportFile, parseExportFile, SessionExpiredError, sessionEndpoint } from './session.js';

const USAGE = `Usage:
  d2l-mcp-auth                  Log in and save the session
  d2l-mcp-auth --export <file>  Export session cookies to <file>
  d2l-mcp-auth --import <file>  Import session cookies from <file>
  d2l-mcp-auth --status         Check whether the saved session still works
  d2l-mcp-auth --push [url]     Send this machine's login to a d2l-mcp --http server
                                (url defaults to D2L_PUSH_URL; token from D2L_HTTP_TOKEN)`;


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
  console.log(`Your session for ${d2lHost()} has been saved. The MCP server will use it automatically.`);
  console.log('Token (first 50 chars):', token.substring(0, 50) + '...');
}

/** The saved session's cookies, in the export-file format. */
async function readSession(): Promise<ExportFile> {
  const profile = sessionPath();
  if (!existsSync(profile)) {
    throw new Error(`No saved session at ${profile}. Run d2l-mcp-auth first.`);
  }
  const context = await chromium.launchPersistentContext(profile, { ...browserLaunchOptions(), headless: true });
  try {
    const { cookies } = await context.storageState();
    return { format: 'd2l-mcp-session', version: 1, host: d2lHost(), exportedAt: new Date().toISOString(), cookies };
  } finally {
    await context.close();
  }
}

async function exportSession(file: string): Promise<void> {
  const out = await readSession();
  // The file is as good as your password while the session lasts: owner-only permissions.
  writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Exported ${out.cookies.length} cookies to ${file} (permissions 600).`);
  console.log('Copy it to the other machine (e.g. with scp), run --import there, then delete both copies.');
}

async function pushSession(serverUrl: string | undefined): Promise<void> {
  const target = serverUrl || process.env.D2L_PUSH_URL;
  const token = process.env.D2L_PUSH_TOKEN || process.env.D2L_HTTP_TOKEN;
  if (!target) throw new Error('Give the server URL (d2l-mcp-auth --push https://your-pi.example.com) or set D2L_PUSH_URL.');
  if (!token) throw new Error("Set D2L_HTTP_TOKEN (or D2L_PUSH_TOKEN) to the server's token.");
  const endpoint = sessionEndpoint(target);
  if (!endpoint.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(endpoint)) {
    throw new Error(`Refusing to send your login over plain HTTP to ${endpoint}. Use the https:// address.`);
  }

  // Make sure the login here works first; opens a window if it has expired.
  console.log('Checking the login on this machine...');
  await getToken();
  const session = await readSession();

  console.log(`Sending ${session.cookies.length} cookies to ${endpoint}...`);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; tokenExpiresAt?: string };
  if (!res.ok) throw new Error(`Server said ${res.status}: ${body.error ?? res.statusText}`);
  console.log(`Done: the server is logged in (API token good until ${new Date(body.tokenExpiresAt!).toLocaleString()}).`);
}

async function importSession(file: string): Promise<void> {
  const data = parseExportFile(readFileSync(file, 'utf-8'));
  const currentHost = d2lHost();
  if (data.host !== currentHost) {
    console.warn(`Warning: file was exported for ${data.host}, but D2L_HOST here is ${currentHost}.`);
  }
  process.env.D2L_HEADLESS = 'true';
  try {
    const expiry = await importCookies(data.cookies);
    console.log(`Imported ${data.cookies.length} cookies into ${sessionPath()}.`);
    console.log(`Session is valid. Token cached until ${new Date(expiry).toLocaleString()}.`);
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      console.error(`Imported ${data.cookies.length} cookies, but they don't log in: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

async function status(): Promise<void> {
  process.env.D2L_HEADLESS = 'true';
  clearTokenCache();
  console.log(`Checking the saved login for ${d2lHost()} (profile ${sessionPath()})...`);
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
    if (cmd === '--push') return await pushSession(arg);
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
