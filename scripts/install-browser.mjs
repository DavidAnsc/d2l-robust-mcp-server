#!/usr/bin/env node
/**
 * postinstall: download Playwright's Chromium, but never let that block the install.
 *
 * - Skipped when D2L_BROWSER_PATH is set (you'll use your own Chrome/Chromium) or
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set. `playwright install` itself ignores the
 *   latter, which is why this script exists instead of calling it directly.
 * - A failed download only prints a warning, so `npm ci` still goes on to build.
 */
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const truthy = (v) => !!v && !['0', 'false', ''].includes(v.toLowerCase());

if (process.env.D2L_BROWSER_PATH) {
  console.log(`d2l-mcp: using D2L_BROWSER_PATH=${process.env.D2L_BROWSER_PATH}; not downloading Chromium.`);
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
