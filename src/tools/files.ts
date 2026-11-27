import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAuthenticatedContext } from '../auth.js';
import mammoth from 'mammoth';

const D2L_HOST = process.env.D2L_HOST || 'learn.ul.ie';

// Extract text content from various file types
async function extractContent(data: Buffer, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase();
  
  // Text-based files - return as string
  if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h'].includes(lowerExt)) {
    return data.toString('utf-8');
  }
  
  // Word documents - extract text with mammoth
  if (lowerExt === '.docx') {
    try {
      const result = await mammoth.extractRawText({ buffer: data });
      return result.value;
    } catch {
      return null;
    }
  }
  
  // For binary files, return null (could add base64 option later)
  return null;
}

/**
 * Only fetch from the configured Brightspace host (or its subdomains). The request runs
 * with the logged-in browser's cookies, so an arbitrary URL would let a caller make this
 * machine fetch other sites or local-network addresses.
 */
export function resolveD2LUrl(url: string, host: string = D2L_HOST): URL {
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
 * Returns the directory to use, or undefined for the old behaviour (savePath, else ~/Downloads).
 */
export function resolveDownloadDir(savePath: string | undefined, root: string | undefined = process.env.D2L_DOWNLOAD_DIR): { dir?: string; file?: string } {
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

export async function downloadFile(url: string, savePath?: string) {
  const parsedUrl = resolveD2LUrl(url);
  const fullUrl = parsedUrl.toString();
  const restricted = resolveDownloadDir(savePath);

  // Extract filename from URL
  const urlPath = parsedUrl.pathname;
  const pathParts = urlPath.split('/');
  const urlFilename = decodeURIComponent(pathParts[pathParts.length - 1] || 'download');

  // Get authenticated browser context (handles SSO login if needed)
  const browser = await getAuthenticatedContext();

  try {
    const page = await browser.newPage();
    
    // Use the page's request API to fetch with cookies
    const response = await page.request.get(fullUrl);
    
    if (!response.ok()) {
      throw new Error(`Failed to download file: ${response.status()} ${response.statusText()}`);
    }
    
    // Get response body as buffer
    const data = await response.body();
    
    // Get content type and disposition from headers
    const contentType = response.headers()['content-type'] || 'application/octet-stream';
    const contentDisposition = response.headers()['content-disposition'] || '';
    
    // Extract filename from content-disposition or use URL filename
    let filename = urlFilename;
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch) {
      filename = filenameMatch[1].replace(/['"]/g, '');
    }
    
    // Determine where to save
    if (restricted.dir) fs.mkdirSync(restricted.dir, { recursive: true });
    const downloadsDir = restricted.dir ? restricted.dir : savePath && fs.existsSync(savePath) && fs.statSync(savePath).isDirectory()
      ? savePath
      : path.join(os.homedir(), 'Downloads');
    
    let finalPath = restricted.dir
      ? (restricted.file ?? path.join(restricted.dir, path.basename(filename)))
      : savePath && fs.existsSync(savePath) && !fs.statSync(savePath).isDirectory()
      ? savePath
      : path.join(downloadsDir, filename);

    // Handle filename collisions
    let counter = 1;
    const ext = path.extname(finalPath);
    const base = path.basename(finalPath, ext);
    const dirPath = path.dirname(finalPath);
    
    while (fs.existsSync(finalPath)) {
      finalPath = path.join(dirPath, `${base} (${counter})${ext}`);
      counter++;
    }

    // Write file
    fs.writeFileSync(finalPath, data);
    
    // Determine mime type from extension if content-type is generic
    const extToMime: Record<string, string> = {
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
    
    const finalContentType = contentType.includes('octet-stream') 
      ? (extToMime[ext.toLowerCase()] || contentType)
      : contentType;

    // Extract text content for supported file types
    const textContent = await extractContent(data, ext);

    return {
      path: finalPath,
      filename: path.basename(finalPath),
      size: data.length,
      contentType: finalContentType,
      content: textContent,
    };
  } finally {
    await browser.close();
  }
}
