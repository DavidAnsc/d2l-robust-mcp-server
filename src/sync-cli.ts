#!/usr/bin/env node
/**
 * d2l-mcp-sync: keep a Markdown copy of every active course on disk.
 *
 * For each course it writes an index, the overview/syllabus, the announcements, one bundle per
 * assignment and one file per top-level module with the text of all its material. Run it on a
 * timer (see deploy/systemd/d2l-mcp-sync.timer): files read before come from the text cache,
 * so later runs only download what changed. Agents can then read or search the folder even
 * while the Brightspace login has expired.
 *
 * Exit codes: 0 done, 1 error, 2 the saved login has expired (run d2l-mcp-auth).
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { client } from './client.js';
import { syncDir } from './config.js';
import { getToc } from './content-tree.js';
import { SessionExpiredError } from './session.js';
import { activeCourses } from './tools/across.js';
import { buildOverview } from './tools/coursework.js';
import { buildAssignmentBundle, buildUnitMaterials } from './tools/study.js';
import { formatDate, RawAnnouncement, RawAssignment, stripHtml } from './utils/marshal.js';

const USAGE = `Usage: d2l-mcp-sync [--dir <folder>] [--course <orgUnitId>]... [--skip units,assignments,overview,announcements]

Writes a Markdown copy of each active course to <folder> (default D2L_SYNC_DIR or ~/d2l-courses).`;

export function slug(s: string): string {
  return s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'untitled';
}

/** Write via a temporary file and rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Remove files a previous run wrote that this run didn't (a deleted assignment, a renamed unit). */
function prune(dir: string, keep: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (name.endsWith('.md') && !keep.has(name)) rmSync(join(dir, name));
}

function parseArgs(argv: string[]) {
  const opts = { dir: syncDir(), courses: [] as number[], skip: new Set<string>() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--course') opts.courses.push(Number(argv[++i]));
    else if (a === '--skip') for (const s of (argv[++i] ?? '').split(',')) opts.skip.add(s.trim());
    else throw new Error(`Unknown option ${a}\n${USAGE}`);
  }
  if (!opts.dir) throw new Error('--dir needs a folder.');
  if (opts.courses.some((c) => !Number.isInteger(c) || c <= 0)) throw new Error('--course needs a course id (orgUnitId).');
  return opts;
}

async function syncCourse(base: string, course: { id: number; name: string; code: string }, skip: Set<string>): Promise<void> {
  const dir = join(base, `${slug(course.code || course.name)}-${course.id}`);
  mkdirSync(join(dir, 'assignments'), { recursive: true });
  mkdirSync(join(dir, 'units'), { recursive: true });
  const index = [`# ${course.name}`, '', `Course ${course.id}. Synced ${formatDate(new Date().toISOString())}.`, ''];
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      if (error instanceof SessionExpiredError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ${what}: ${msg}`);
      index.push(`- ${what}: failed (${msg})`);
    }
  };

  if (!skip.has('overview')) {
    await step('overview', async () => {
      writeAtomic(join(dir, 'overview.md'), await buildOverview(course.id, true));
      index.push('- [Overview and syllabus](overview.md)');
    });
  }
  if (!skip.has('announcements')) {
    await step('announcements', async () => {
      const news = (await client.getNews(course.id)) as RawAnnouncement[];
      const md = [`# Announcements: ${course.name}`, ''];
      for (const n of news) md.push(`## ${n.Title}`, `${formatDate(n.CreatedDate)} (id ${n.Id})`, '', stripHtml(n.Body?.Text || n.Body?.Html), '');
      writeAtomic(join(dir, 'announcements.md'), md.join('\n'));
      index.push(`- [Announcements](announcements.md) (${news.length})`);
    });
  }
  if (!skip.has('assignments')) {
    await step('assignments', async () => {
      const keep = new Set<string>();
      index.push('', '## Assignments', '');
      for (const a of (await client.getDropboxFolders(course.id)) as RawAssignment[]) {
        const name = `${slug(a.Name)}-${a.Id}.md`;
        await step(`assignment "${a.Name}"`, async () => {
          writeAtomic(join(dir, 'assignments', name), await buildAssignmentBundle({ orgUnitId: course.id, assignmentId: a.Id }));
          keep.add(name);
          index.push(`- [${a.Name}](assignments/${encodeURI(name)})${a.DueDate ? `, due ${formatDate(a.DueDate)}` : ''}`);
        });
      }
      prune(join(dir, 'assignments'), keep);
    });
  }
  if (!skip.has('units')) {
    await step('units', async () => {
      const keep = new Set<string>();
      index.push('', '## Units', '');
      for (const [i, m] of (await getToc(course.id)).entries()) {
        const name = `${String(i + 1).padStart(2, '0')}-${slug(m.Title)}-${m.ModuleId}.md`;
        await step(`unit "${m.Title}"`, async () => {
          writeAtomic(join(dir, 'units', name), await buildUnitMaterials({ orgUnitId: course.id, moduleId: m.ModuleId }));
          keep.add(name);
          index.push(`- [${m.Title}](units/${encodeURI(name)})`);
        });
      }
      prune(join(dir, 'units'), keep);
    });
  }
  writeAtomic(join(dir, 'README.md'), index.join('\n') + '\n');
}

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  process.env.D2L_HEADLESS ??= 'true';
  const all = await activeCourses();
  const courses = opts.courses.length ? opts.courses.map((id) => all.find((c) => c.id === id) ?? { id, name: `Course ${id}`, code: '' }) : all;
  mkdirSync(opts.dir, { recursive: true });
  for (const c of courses) {
    console.error(`Syncing ${c.name} (${c.id})…`);
    await syncCourse(opts.dir, c, opts.skip);
  }
  console.error(`Done: ${courses.length} course(s) in ${opts.dir}`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error) => {
    if (error instanceof SessionExpiredError) {
      console.error(`SESSION_EXPIRED: ${error.message}`);
      process.exit(2);
    }
    console.error('Sync failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
