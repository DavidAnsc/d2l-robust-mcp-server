/**
 * Turning a downloaded file into something a model can read.
 *
 * Text comes out of PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), HTML and plain-text
 * files. Images come back as images. Anything else gets a short note saying what it is.
 * Nothing is written to disk.
 */
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { extname } from 'path';

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

const LEGACY_OFFICE = new Set(['.doc', '.ppt', '.xls']);

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
  if (LEGACY_OFFICE.has(ext)) return 'unsupported';
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
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text as string[];
  const body = pages.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join('\n\n');
  const chars = pages.reduce((n, t) => n + t.trim().length, 0);
  return {
    kind: 'pdf',
    text: body,
    parts: totalPages,
    // Under ~20 characters a page usually means the pages are pictures (a scan).
    note: chars < totalPages * 20 ? 'Little or no text found: this PDF is probably scanned images.' : undefined,
  };
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

async function zipListing(data: Buffer): Promise<Extracted> {
  const zip = await JSZip.loadAsync(data);
  const files = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
  return { kind: 'zip', text: `Zip archive with ${files.length} files:\n${files.join('\n')}` };
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
export async function extractFile(data: Buffer, filename: string, contentType = ''): Promise<Extracted> {
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
        return await zipListing(data);
      case 'image': {
        const mimeType = IMAGE_TYPES[extname(filename).toLowerCase()] || contentType.split(';')[0] || 'image/png';
        if (data.length > MAX_IMAGE_BYTES) {
          return { kind, text: `Image ${filename} is ${(data.length / 1048576).toFixed(1)} MB, too large to return.` };
        }
        return { kind, text: `Image: ${filename}`, image: { data: data.toString('base64'), mimeType } };
      }
      default: {
        const ext = extname(filename).toLowerCase();
        const hint = LEGACY_OFFICE.has(ext)
          ? ` Old ${ext} Office files can't be read; ask the instructor for the ${ext}x version or a PDF.`
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
