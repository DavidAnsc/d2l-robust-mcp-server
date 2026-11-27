import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { extractContent, filenameFromHeaders, resolveD2LUrl, resolveDownloadDir } from '../../src/tools/files.js';

describe('resolveD2LUrl', () => {
  const host = 'school.brightspace.com';

  it('expands a path to the D2L host', () => {
    expect(resolveD2LUrl('/content/enforced/1/a.pdf', host).toString()).toBe(
      'https://school.brightspace.com/content/enforced/1/a.pdf'
    );
  });

  it('allows the host and its subdomains', () => {
    expect(() => resolveD2LUrl('https://school.brightspace.com/x', host)).not.toThrow();
    expect(() => resolveD2LUrl('https://cdn.school.brightspace.com/x', host)).not.toThrow();
  });

  it('refuses other hosts, look-alikes and plain http', () => {
    expect(() => resolveD2LUrl('https://example.com/x', host)).toThrow(/Refusing/);
    expect(() => resolveD2LUrl('https://evilschool.brightspace.com/x', host)).toThrow(/Refusing/);
    expect(() => resolveD2LUrl('http://school.brightspace.com/x', host)).toThrow(/Refusing/);
    expect(() => resolveD2LUrl('https://192.168.1.1/x', host)).toThrow(/Refusing/);
  });
});

describe('resolveDownloadDir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd2l-dl-'));

  it('keeps the old behaviour when no root is set', () => {
    expect(resolveDownloadDir('/anywhere', undefined)).toEqual({});
  });

  it('defaults to the root', () => {
    expect(resolveDownloadDir(undefined, root)).toEqual({ dir: root });
  });

  it('allows a file or subdirectory inside the root', () => {
    expect(resolveDownloadDir('notes/a.pdf', root)).toEqual({
      dir: path.join(root, 'notes'),
      file: path.join(root, 'notes', 'a.pdf'),
    });
    expect(resolveDownloadDir('.', root)).toEqual({ dir: root });
  });

  it('refuses paths that escape the root', () => {
    expect(() => resolveDownloadDir('../x', root)).toThrow(/inside/);
    expect(() => resolveDownloadDir('/etc/passwd', root)).toThrow(/inside/);
    expect(() => resolveDownloadDir(root + '-sibling/x', root)).toThrow(/inside/);
  });
});

describe('filenameFromHeaders', () => {
  it('reads quoted and bare filenames', () => {
    expect(filenameFromHeaders('attachment; filename="Week 1.pdf"', 'x')).toBe('Week 1.pdf');
    expect(filenameFromHeaders('attachment; filename=notes.docx', 'x')).toBe('notes.docx');
  });

  it('prefers the UTF-8 filename* form', () => {
    expect(filenameFromHeaders(`attachment; filename="a.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`, 'x')).toBe('résumé.pdf');
  });

  it('strips directories so a server cannot choose where the file goes', () => {
    expect(filenameFromHeaders('attachment; filename="../../.bashrc"', 'x')).toBe('.bashrc');
  });

  it('falls back when there is no header', () => {
    expect(filenameFromHeaders('', 'fallback.pdf')).toBe('fallback.pdf');
  });
});

describe('extractContent', () => {
  it('returns text for text files and null for binaries', async () => {
    expect(await extractContent(Buffer.from('hello'), '.TXT')).toBe('hello');
    expect(await extractContent(Buffer.from([0, 1, 2]), '.pdf')).toBeNull();
  });
});
