#!/usr/bin/env node
/**
 * postinstall: download Playwright's Chromium, but never let that block the install.
 *
 * - Skipped when D2L_BROWSER_PATH is set, when Google Chrome is at its default macOS
 *   location (the server uses it; see browserPath in src/config.ts), or when
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set. `playwright install` itself ignores the
 *   latter, which is why this script exists instead of calling it directly.
 * - A failed download only prints a warning, so `npm ci` still goes on to build.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const truthy = (v) => !!v && !['0', 'false', ''].includes(v.toLowerCase());

// Keep in step with SYSTEM_CHROME in src/config.ts (this runs before the build).
const SYSTEM_CHROME = { darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };

const configured = process.env.D2L_BROWSER_PATH;
if (configured && configured.toLowerCase() !== 'playwright') {
  console.log(`d2l-mcp: using D2L_BROWSER_PATH=${configured}; not downloading Chromium.`);
  process.exit(0);
}
const chrome = SYSTEM_CHROME[process.platform];
if (!configured && chrome && existsSync(chrome)) {
  console.log(`d2l-mcp: found Google Chrome at ${chrome}; using it, not downloading Chromium.`);
  console.log("d2l-mcp: to use Playwright's Chromium instead, set D2L_BROWSER_PATH=playwright when installing and running.");
  process.exit(0);
}
if (truthy(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) {
  console.log('d2l-mcp: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set; not downloading Chromium.');
  console.log('d2l-mcp: later, run `npx playwright install chromium`, or set D2L_BROWSER_PATH to a Chrome you have.');
  process.exit(0);
}

let cli;
try {
  const require = createRequire(import.meta.url);
  cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
} catch {
  console.warn('d2l-mcp: playwright is not installed yet; skipping the Chromium download.');
  process.exit(0);
}

console.log('d2l-mcp: downloading Chromium for logging in to Brightspace (about 250 MB, two parts).');
console.log('d2l-mcp: after each "100%" it unpacks with no progress shown; that can take a few minutes.');

const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });

if (result.status !== 0) {
  console.warn('');
  console.warn('d2l-mcp: WARNING: the Chromium download failed. Everything else is installed.');
  console.warn('d2l-mcp: fix it with one of:');
  console.warn('d2l-mcp:   npx playwright install chromium            (try the download again)');
  console.warn('d2l-mcp:   export D2L_BROWSER_PATH=<path to Chrome>   (use a browser you already have)');
}
process.exit(0);
