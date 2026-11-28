/**
 * Optional helpers that use programs installed on the machine, when they are there:
 *  - LibreOffice (`soffice`): old .doc/.ppt/.xls and OpenDocument files → modern Office files,
 *    and any Office file → PDF for page pictures;
 *  - Poppler (`pdftoppm`): PDF pages → PNG pictures;
 *  - Tesseract (`tesseract`): text from pictures of pages (OCR for scanned PDFs).
 *
 * Each returns undefined when its program is missing, so callers fall back to a note.
 * Work happens in a private temporary folder that is always deleted afterwards.
 */
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

const found = new Map<string, string | null>();

/** Full path of a program on PATH (or a known install location), or null. */
export function findProgram(name: string): string | null {
  if (found.has(name)) return found.get(name)!;
  const extra: Record<string, string[]> = {
    soffice: ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/lib/libreoffice/program/soffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'],
  };
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  let hit: string | null = null;
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, name + e);
      if (existsSync(p)) {
        hit = p;
        break;
      }
    }
    if (hit) break;
  }
  hit ??= (extra[name] ?? []).find((p) => existsSync(p)) ?? null;
  found.set(name, hit);
  return hit;
}

/** For tests: forget which programs were found. */
export function resetProgramCache(): void {
  found.clear();
}

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'd2l-mcp-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TIMEOUT_MS = 180_000;

/**
 * Convert a file with LibreOffice, e.g. ("lecture.ppt", "pptx") or ("notes.docx", "pdf").
 * Returns the converted bytes, or undefined when LibreOffice isn't installed or fails.
 */
export async function convertWithLibreOffice(data: Buffer, filename: string, target: string): Promise<Buffer | undefined> {
  const soffice = findProgram('soffice') ?? findProgram('libreoffice');
  if (!soffice) return undefined;
  return inTempDir(async (dir) => {
    const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';
    const input = join(dir, `input${ext}`);
    writeFileSync(input, data);
    try {
      await run(
        soffice,
        [`-env:UserInstallation=file://${join(dir, 'profile').replace(/\\/g, '/')}`, '--headless', '--norestore', '--convert-to', target, '--outdir', join(dir, 'out'), input],
        { timeout: TIMEOUT_MS }
      );
    } catch {
      return undefined;
    }
    const out = join(dir, 'out', `input.${target}`);
    return existsSync(out) ? readFileSync(out) : undefined;
  });
}

/** Render PDF pages first..last as PNGs at `dpi`. Undefined when pdftoppm isn't installed. */
export async function pdfPagesToPng(pdf: Buffer, first: number, last: number, dpi = 100, gray = false): Promise<Buffer[] | undefined> {
  const pdftoppm = findProgram('pdftoppm');
  if (!pdftoppm) return undefined;
  return inTempDir(async (dir) => {
    const input = join(dir, 'in.pdf');
    writeFileSync(input, pdf);
    const args = ['-png', '-r', String(dpi), '-f', String(first), '-l', String(last)];
    if (gray) args.push('-gray');
    try {
      await run(pdftoppm, [...args, input, join(dir, 'page')], { timeout: TIMEOUT_MS });
    } catch {
      return undefined;
    }
    // pdftoppm names files page-1.png or page-01.png depending on the page count.
    const pages = readdirSync(dir)
      .filter((n) => /^page-\d+\.png$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    return pages.map((n) => readFileSync(join(dir, n)));
  });
}

/** True when OCR can run here. */
export function canOcr(): boolean {
  return !!findProgram('tesseract') && !!findProgram('pdftoppm');
}

/** Text of the first `maxPages` pages of a scanned PDF, page by page. Undefined when OCR can't run. */
export async function ocrPdf(pdf: Buffer, pageCount: number, maxPages: number): Promise<string[] | undefined> {
  const tesseract = findProgram('tesseract');
  if (!tesseract || !findProgram('pdftoppm')) return undefined;
  const last = Math.min(pageCount, maxPages);
  const images = await pdfPagesToPng(pdf, 1, last, 200, true);
  if (!images) return undefined;
  return inTempDir(async (dir) => {
    const texts: string[] = [];
    for (const [i, png] of images.entries()) {
      const input = join(dir, `p${i}.png`);
      writeFileSync(input, png);
      try {
        const { stdout } = await run(tesseract, [input, 'stdout'], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        texts.push(stdout.trim());
      } catch {
        texts.push('');
      }
    }
    return texts;
  });
}
