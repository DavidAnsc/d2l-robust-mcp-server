import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import mammoth from 'mammoth';
import { getAuthenticatedContext } from '../auth.js';
import { d2lHost, downloadRoot } from '../config.js';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.css',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

/** Text of a downloaded file, for the types we can read; null for anything else. */
export async function extractContent(data: Buffer, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase();
  if (TEXT_EXTENSIONS.has(lowerExt)) return data.toString('utf-8');
  if (lowerExt === '.docx') {
    try {
      return (await mammoth.extractRawText({ buffer: data })).value;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Only fetch from the configured Brightspace host (or its subdomains). The request runs
 * with the logged-in browser's cookies, so an arbitrary URL would let a caller make this
 * machine fetch other sites or local-network addresses.
 */
export function resolveD2LUrl(url: string, host: string = d2lHost()): URL {
  const full = new URL(url.startsWith('http') ? url : `https://${host}${url.startsWith('/') ? '' : '/'}${url}`);
  const h = full.hostname.toLowerCase();
  const allowed = host.toLowerCase();
  if (full.protocol !== 'https:' || (h !== allowed && !h.endsWith(`.${allowed}`))) {
    throw new Error(`Refusing to download from ${full.origin}: only https://${host} URLs are allowed.`);
  }
  return full;
}

/**
 * When D2L_DOWNLOAD_DIR is set, every file lands inside it and savePath must stay inside it too.
 * Returns the directory (and file, if savePath named one) to use, or {} for no restriction.
 */
export function resolveDownloadDir(
  savePath: string | undefined,
  root: string | undefined = downloadRoot()
): { dir?: string; file?: string } {
  if (!root) return {};
  const base = path.resolve(root);
  if (!savePath) return { dir: base };
  const target = path.resolve(base, savePath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`savePath must be inside ${base}`);
  }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return { dir: target };
  return { dir: path.dirname(target), file: target };
}

/** The server's suggested filename, reduced to a bare name so it can't point elsewhere. */
export function filenameFromHeaders(contentDisposition: string, fallback: string): string {
  const star = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  const plain = contentDisposition.match(/filename\s*=\s*("([^"]*)"|[^;]+)/);
  let name = fallback;
  try {
    if (star) name = decodeURIComponent(star[1].trim());
    else if (plain) name = (plain[2] ?? plain[1]).trim();
  } catch {
    // Malformed encoding: keep the fallback.
  }
  return path.basename(name) || fallback;
}

function isDirectory(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/** Where to write: honours D2L_DOWNLOAD_DIR, else savePath (dir or file), else ~/Downloads. */
function chooseTarget(savePath: string | undefined, filename: string): string {
  const restricted = resolveDownloadDir(savePath);
  if (restricted.dir) {
    fs.mkdirSync(restricted.dir, { recursive: true });
    return restricted.file ?? path.join(restricted.dir, filename);
  }
  if (savePath && isDirectory(savePath)) return path.join(savePath, filename);
  if (savePath && fs.existsSync(savePath)) return savePath;
  return path.join(os.homedir(), 'Downloads', filename);
}

/** Add " (1)", " (2)", … before the extension until the name is free. */
function uniquePath(target: string): string {
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  const dir = path.dirname(target);
  let candidate = target;
  for (let n = 1; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

export async function downloadFile(url: string, savePath?: string) {
  const target = resolveD2LUrl(url);
  resolveDownloadDir(savePath); // fail before opening a browser if savePath is out of bounds
  const urlFilename = decodeURIComponent(target.pathname.split('/').pop() || 'download');

  const browser = await getAuthenticatedContext();
  try {
    const page = await browser.newPage();
    const response = await page.request.get(target.toString());
    if (!response.ok()) {
      throw new Error(`Failed to download file: ${response.status()} ${response.statusText()}`);
    }

    const data = await response.body();
    const headers = response.headers();
    const filename = filenameFromHeaders(headers['content-disposition'] || '', path.basename(urlFilename));
    const finalPath = uniquePath(chooseTarget(savePath, filename));
    fs.writeFileSync(finalPath, data);

    const ext = path.extname(finalPath);
    const contentType = headers['content-type'] || 'application/octet-stream';
    return {
      path: finalPath,
      filename: path.basename(finalPath),
      size: data.length,
      contentType: contentType.includes('octet-stream')
        ? MIME_BY_EXTENSION[ext.toLowerCase()] || contentType
        : contentType,
      content: await extractContent(data, ext),
    };
  } finally {
    await browser.close();
  }
}

export const fileTools = {
  download_file: {
    description: `Download a file from D2L Brightspace. Provide a D2L content URL (e.g., https://<your-host>/content/enforced/<course>/file.docx or /content/enforced/...). Saved to the Downloads folder by default, or to a custom path. Returns the local file path, filename, size and content type, plus the text of .docx and plain-text files. Use this to read lecture slides, assignment files and other course materials linked in course content.`,
    schema: {
      url: z.string().describe('The D2L URL or path of the file, e.g. /content/enforced/12345-CS101/notes.docx'),
      savePath: z.string().optional().describe('Optional: directory or full file path to save to. Defaults to ~/Downloads (or D2L_DOWNLOAD_DIR)'),
    },
    handler: async ({ url, savePath }: { url: string; savePath?: string }): Promise<string> => {
      const result = await downloadFile(url, savePath);
      const sizeKB = (result.size / 1024).toFixed(1);
      let text = `Downloaded: ${result.filename}\nPath: ${result.path}\nSize: ${sizeKB} KB\nType: ${result.contentType}`;
      if (result.content) text += `\n\n--- File Content ---\n${result.content}`;
      return text;
    },
  },
};
