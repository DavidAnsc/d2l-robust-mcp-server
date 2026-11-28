/**
 * Turning a downloaded file into something a model can read.
 *
 * Text comes out of PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), HTML and plain-text
 * files. Images come back as images. Anything else gets a short note saying what it is.
 * Nothing is written to disk.
 */
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { basename, extname } from 'path';
import { ocrMaxPages, ocrMode } from './config.js';
import { convertWithLibreOffice, findProgram, ocrPdf, pdfPagesToPng } from './convert.js';

export type FileKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'text' | 'image' | 'zip' | 'unsupported';

export interface Extracted {
  kind: FileKind;
  /** Readable text (for images and unsupported files, a one-line note). */
  text: string;
  /** For images: the bytes as base64, with their MIME type. */
  image?: { data: string; mimeType: string };
  /** Pages (PDF), slides (PPTX) or sheets (XLSX), when known. */
  parts?: number;
  /** A remark for the reader, e.g. that a PDF looks scanned. */
  note?: string;
  /** True when the file couldn't be parsed (the text then says why). */
  failed?: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.css', '.js', '.ts', '.py',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.r', '.m',
  '.ipynb', '.tex', '.bib', '.log', '.sh', '.ini', '.toml', '.srt', '.vtt',
]);

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Images larger than this are described, not returned, to keep responses a sane size. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Files LibreOffice can turn into one we read, and what into. */
const CONVERTIBLE: Record<string, 'docx' | 'pptx' | 'xlsx'> = {
  '.doc': 'docx', '.rtf': 'docx', '.odt': 'docx', '.wpd': 'docx', '.pages': 'docx',
  '.ppt': 'pptx', '.pps': 'pptx', '.odp': 'pptx',
  '.xls': 'xlsx', '.ods': 'xlsx',
};

const MEDIA = /\.(mp4|m4v|mov|webm|avi|mkv|wmv|mp3|m4a|wav|ogg|aac|flac)$/i;

/** Decide what a file is from its name, its Content-Type and its first bytes. */
export function detectKind(data: Buffer, filename: string, contentType = ''): FileKind {
  const ext = extname(filename).toLowerCase();
  const type = contentType.toLowerCase();
  const head = data.subarray(0, 5).toString('latin1');

  if (head.startsWith('%PDF') || ext === '.pdf' || type.includes('application/pdf')) return 'pdf';
  if (ext === '.docx' || type.includes('wordprocessingml')) return 'docx';
  if (ext === '.pptx' || type.includes('presentationml')) return 'pptx';
  if (ext === '.xlsx' || type.includes('spreadsheetml')) return 'xlsx';
  if (IMAGE_TYPES[ext] || /^image\/(png|jpeg|gif|webp)/.test(type)) return 'image';
  if (ext === '.html' || ext === '.htm' || type.includes('text/html')) return 'html';
  if (TEXT_EXTENSIONS.has(ext) || type.startsWith('text/') || type.includes('json')) return 'text';
  if (CONVERTIBLE[ext]) return 'unsupported';
  if (ext === '.zip' || head.startsWith('PK')) return 'zip';
  return 'unsupported';
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', copy: '©', deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to readable text: drops scripts and styles, keeps line structure (paragraphs,
 * headings, list items, table rows) and link targets.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]*>/g, '').trim();
        return !text || text === href ? href : `${text} (${href})`;
      })
      .replace(/<img\s[^>]*>/gi, (tag: string) => {
        const attr = (name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]?.trim();
        const alt = attr('alt');
        const src = attr('src');
        if (!alt && !src) return '';
        // Data URIs are the image itself; far too long to print.
        const where = src && !src.startsWith('data:') ? src : '';
        return `[Image${alt ? `: ${alt}` : ''}${where ? ` (${where})` : ''}]`;
      })
      .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|section|article|blockquote|pre)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pdfText(data: Buffer): Promise<Extracted> {
  // The "legacy" build carries its own polyfills, so it runs on Node 20 as well as 22+.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }
    const chars = pages.reduce((n, t) => n + t.length, 0);
    // Under ~20 characters a page usually means the pages are pictures (a scan).
    let note: string | undefined;
    if (chars < pdf.numPages * 20) {
      const max = ocrMaxPages();
      const ocr = ocrMode() === 'auto' ? await ocrPdf(data, pdf.numPages, max) : undefined;
      if (ocr && ocr.some((t) => t.length > 0)) {
        ocr.forEach((t, i) => (pages[i] = t));
        note =
          'This PDF is scanned; its text was recognized by OCR and may contain mistakes.' +
          (pdf.numPages > max ? ` Only the first ${max} of ${pdf.numPages} pages were recognized (D2L_OCR_MAX_PAGES).` : '');
      } else {
        note =
          'Little or no text found: this PDF is probably scanned images.' +
          (ocrMode() === 'auto' ? ' Install tesseract and poppler (pdftoppm) on the server to have it read by OCR,' : '') +
          ' or read pages as pictures with read_file asImages=true.';
      }
    }
    const body = pages.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n');
    return { kind: 'pdf', text: body, parts: pdf.numPages, note };
  } finally {
    await pdf.destroy();
  }
}

/** Number in a zip entry name like "ppt/slides/slide12.xml" (for sorting slides numerically). */
const entryNumber = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

/** The text of an OOXML part, one line per paragraph (<a:p>). */
function drawingText(xml: string): string {
  const paragraphs = xml.split(/<\/a:p>/);
  return paragraphs
    .map((p) => decodeEntities([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

async function pptxText(data: Buffer): Promise<Extracted> {
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => entryNumber(a) - entryNumber(b));

  const out: string[] = [];
  for (const [i, slide] of slides.entries()) {
    const xml = await zip.file(slide)!.async('string');
    let section = `--- Slide ${i + 1} ---\n${drawingText(xml)}`;

    // Speaker notes: the slide's relationships file points at its notes part.
    const rels = await zip.file(slide.replace('slides/', 'slides/_rels/') + '.rels')?.async('string');
    const notesTarget = rels?.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
    if (notesTarget) {
      const notesXml = await zip.file(`ppt/notesSlides/${notesTarget}`)?.async('string');
      // Notes parts also hold the slide number placeholder; drop bare numbers.
      const notes = notesXml ? drawingText(notesXml).split('\n').filter((l) => !/^\d+$/.test(l)).join('\n') : '';
      if (notes) section += `\n[Speaker notes]\n${notes}`;
    }
    out.push(section);
  }
  return { kind: 'pptx', text: out.join('\n\n'), parts: slides.length };
}

/** "B12" → column index 1. */
function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

async function xlsxText(data: Buffer): Promise<Extracted> {
  const zip = await JSZip.loadAsync(data);
  const shared: string[] = [];
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (sharedXml) {
    for (const si of sharedXml.split('</si>').slice(0, -1)) {
      shared.push(decodeEntities([...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join('')));
    }
  }

  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const names = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => entryNumber(a) - entryNumber(b));

  const out: string[] = [];
  for (const [i, sheet] of sheets.entries()) {
    const xml = await zip.file(sheet)!.async('string');
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? '';
        const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
        const type = attrs.match(/t="([^"]+)"/)?.[1];
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = decodeEntities(inner.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '');
        else if (v !== undefined) value = decodeEntities(v);
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = value.replace(/[\t\n]/g, ' ');
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'));
    }
    out.push(`--- Sheet: ${names[i] ?? `Sheet ${i + 1}`} ---\n${rows.join('\n')}`);
  }
  return { kind: 'xlsx', text: out.join('\n\n'), parts: sheets.length };
}

/** Inner files of a zip worth reading, and how much of them. */
const ZIP_MAX_FILES = 25;
const ZIP_MAX_CHARS = 300_000;
const ZIP_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const ZIP_SKIP = /\.(js|css|map|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|swf|xsd|dtd)$/i;

/**
 * A zip's file list, then the text of the readable files inside it (handouts bundled as a zip,
 * SCORM packages, starter code). Nested zips are only listed.
 */
async function zipContents(data: Buffer, depth: number): Promise<Extracted> {
  const zip = await JSZip.loadAsync(data);
  const files = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith('__MACOSX/'));
  const scorm = !!zip.file('imsmanifest.xml');
  const out = [`${scorm ? 'SCORM package' : 'Zip archive'} with ${files.length} files:\n${files.map((f) => f.name).join('\n')}`];
  if (depth > 0) return { kind: 'zip', text: out[0] };

  let chars = 0;
  let read = 0;
  const candidates = files.filter((f) => !ZIP_SKIP.test(f.name) && !/imsmanifest\.xml$|\.xml$/i.test(f.name) && detectKind(Buffer.alloc(0), f.name) !== 'unsupported');
  for (const f of candidates) {
    if (read >= ZIP_MAX_FILES || chars >= ZIP_MAX_CHARS) {
      out.push(`(Stopped after ${read} files; read the others separately.)`);
      break;
    }
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > ZIP_MAX_ENTRY_BYTES) continue;
    const inner = await extractFile(await f.async('nodebuffer'), basename(f.name), '', depth + 1);
    if (inner.image || inner.kind === 'unsupported' || !inner.text.trim()) continue;
    const body = inner.text.slice(0, ZIP_MAX_CHARS - chars);
    chars += body.length;
    read++;
    out.push(`=== ${f.name} ===\n${body}`);
  }
  return { kind: 'zip', text: out.join('\n\n'), note: scorm ? 'SCORM package: the readable pages inside it are shown below the file list.' : undefined };
}

/** Word, PowerPoint and Excel files are zips; without a name or type, look inside to tell which. */
async function sniffOfficeZip(data: Buffer): Promise<FileKind> {
  try {
    const zip = await JSZip.loadAsync(data);
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('ppt/presentation.xml')) return 'pptx';
    if (zip.file('xl/workbook.xml')) return 'xlsx';
  } catch {
    // Not a readable zip; leave it as is.
  }
  return 'zip';
}

/** Extract readable content from a file's bytes. Never throws for a bad file: it says so instead. */
export async function extractFile(data: Buffer, filename: string, contentType = '', depth = 0): Promise<Extracted> {
  const ext = extname(filename).toLowerCase();
  const target = CONVERTIBLE[ext];
  if (target && depth === 0) {
    const converted = await convertWithLibreOffice(data, filename, target);
    if (converted) {
      const result = await extractFile(converted, `${basename(filename, ext)}.${target}`, '', depth + 1);
      return { ...result, note: [`Converted from ${ext} with LibreOffice.`, result.note].filter(Boolean).join(' ') };
    }
  }
  if (MEDIA.test(filename)) {
    return {
      kind: 'unsupported',
      text: `${filename} is ${/\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(filename) ? 'audio' : 'a video'}: it has no text. Look for a transcript or captions file (.vtt or .srt) next to it in the course content.`,
    };
  }
  let kind = detectKind(data, filename, contentType);
  if (kind === 'zip') kind = await sniffOfficeZip(data);
  try {
    switch (kind) {
      case 'pdf':
        return await pdfText(data);
      case 'docx':
        return { kind, text: (await mammoth.extractRawText({ buffer: data })).value.trim() };
      case 'pptx':
        return await pptxText(data);
      case 'xlsx':
        return await xlsxText(data);
      case 'html':
        return { kind, text: htmlToText(data.toString('utf-8')) };
      case 'text':
        return { kind, text: data.toString('utf-8') };
      case 'zip':
        return await zipContents(data, depth);
      case 'image': {
        const mimeType = IMAGE_TYPES[extname(filename).toLowerCase()] || contentType.split(';')[0] || 'image/png';
        if (data.length > MAX_IMAGE_BYTES) {
          return { kind, text: `Image ${filename} is ${(data.length / 1048576).toFixed(1)} MB, too large to return.` };
        }
        return { kind, text: `Image: ${filename}`, image: { data: data.toString('base64'), mimeType } };
      }
      default: {
        const hint = CONVERTIBLE[ext]
          ? ` ${ext} files can be read when LibreOffice is installed on the server; otherwise ask the instructor for a ${CONVERTIBLE[ext]} or PDF version.`
          : '';
        return { kind: 'unsupported', text: `Can't extract text from ${filename} (${contentType || 'unknown type'}).${hint}` };
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind, text: `Could not read ${filename} as ${kind}: ${reason}`, failed: true };
  }
}

/**
 * One window of a long text, so a 300-page PDF can be read in parts.
 * Returns the slice and where the next one starts (null at the end).
 */
export function sliceText(text: string, offset: number, maxChars: number): { slice: string; next: number | null } {
  const start = Math.max(0, Math.min(offset, text.length));
  let end = Math.min(text.length, start + maxChars);
  // Prefer to cut at a line break near the end of the window.
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > start + maxChars * 0.8) end = nl + 1;
  }
  return { slice: text.slice(start, end), next: end < text.length ? end : null };
}

// ---------------------------------------------------------------------------------------------
// Pictures of pages and slides
// ---------------------------------------------------------------------------------------------

export interface PagePicture {
  /** 1-based page or slide number. */
  page: number;
  mimeType: string;
  data: Buffer;
}

/** "3", "2-5", "1,4,7-9" → sorted page numbers, at most `limit` of them. */
export function parsePageRange(spec: string | undefined, limit: number): number[] {
  if (!spec?.trim()) return Array.from({ length: limit }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`pages must look like "3", "2-5" or "1,4,7-9"; got "${spec}".`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let p = Math.min(a, b); p <= Math.max(a, b) && pages.size < 1000; p++) if (p > 0) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y).slice(0, limit);
}

/** The images embedded in each of the given slides (when slides can't be rendered). */
async function pptxSlideMedia(data: Buffer, pages: number[]): Promise<PagePicture[]> {
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => entryNumber(a) - entryNumber(b));
  const out: PagePicture[] = [];
  for (const page of pages) {
    const slide = slides[page - 1];
    if (!slide) continue;
    const rels = (await zip.file(slide.replace('slides/', 'slides/_rels/') + '.rels')?.async('string')) ?? '';
    for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+\.(png|jpe?g|gif|webp))"/gi)) {
      const file = zip.file(`ppt/media/${m[1]}`);
      if (!file) continue;
      const bytes = await file.async('nodebuffer');
      if (bytes.length > MAX_IMAGE_BYTES) continue;
      out.push({ page, mimeType: IMAGE_TYPES[extname(m[1]).toLowerCase()] ?? 'image/png', data: bytes });
    }
  }
  return out;
}

/**
 * Pictures of the given pages (PDF) or slides (PowerPoint; also Word and Excel pages):
 * rendered with pdftoppm, through LibreOffice for Office files. Without those programs,
 * PowerPoint falls back to the images embedded in each slide. Returns a note when nothing works.
 */
export async function pagePictures(data: Buffer, filename: string, contentType: string, pages: number[], dpi = 100): Promise<PagePicture[] | string> {
  let kind = detectKind(data, filename, contentType);
  if (kind === 'zip') kind = await sniffOfficeZip(data);
  const ext = extname(filename).toLowerCase();
  if (kind === 'image') return 'This file is already an image: read it without asImages.';

  let pdf: Buffer | undefined;
  if (kind === 'pdf') pdf = data;
  else if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx' || CONVERTIBLE[ext]) pdf = await convertWithLibreOffice(data, filename, 'pdf');

  if (pdf && findProgram('pdftoppm')) {
    const out: PagePicture[] = [];
    // Render runs of consecutive pages in one call each.
    for (let i = 0; i < pages.length; ) {
      let j = i;
      while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
      const pngs = (await pdfPagesToPng(pdf, pages[i], pages[j], dpi)) ?? [];
      pngs.forEach((png, k) => out.push({ page: pages[i] + k, mimeType: 'image/png', data: png }));
      i = j + 1;
    }
    if (out.length) return out;
    return 'Those pages are past the end of the file.';
  }
  if (kind === 'pptx') {
    const media = await pptxSlideMedia(data, pages);
    if (media.length) return media;
    return 'Rendering slides needs LibreOffice and poppler (pdftoppm) on the server, and these slides have no embedded pictures.';
  }
  return `Pictures of pages need ${kind === 'pdf' ? 'poppler (pdftoppm)' : 'LibreOffice and poppler (pdftoppm)'} installed on the server.`;
}
