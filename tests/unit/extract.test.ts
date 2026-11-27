import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectKind, extractFile, htmlToText, sliceText } from '../../src/extract.js';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/files', name));

describe('extractFile', () => {
  it('reads PDF text page by page', async () => {
    const r = await extractFile(fixture('notes.pdf'), 'notes.pdf');
    expect(r.kind).toBe('pdf');
    expect(r.parts).toBe(3);
    expect(r.text).toContain('--- Page 2 ---');
    expect(r.text).toContain("Page 3: Ohm's law V = IR");
    expect(r.note).toBeUndefined();
  });

  it('reads PowerPoint slides in order, with speaker notes', async () => {
    const r = await extractFile(fixture('lec.pptx'), 'lec.pptx');
    expect(r.kind).toBe('pptx');
    expect(r.parts).toBe(3);
    expect(r.text.indexOf('Slide 1')).toBeLessThan(r.text.indexOf('Slide 3'));
    expect(r.text).toContain("Kirchhoff's law & point 2");
    expect(r.text).toContain('[Speaker notes]\nRemember to explain example 2');
  });

  it('reads Word documents', async () => {
    const r = await extractFile(fixture('a2.docx'), 'a2.docx');
    expect(r.kind).toBe('docx');
    expect(r.text).toContain('Write 500 words on <circuits> & "loops".');
  });

  it('reads every Excel sheet, keeping column positions', async () => {
    const r = await extractFile(fixture('g.xlsx'), 'g.xlsx');
    expect(r.kind).toBe('xlsx');
    expect(r.parts).toBe(2);
    expect(r.text).toContain('--- Sheet: Marks ---\nName\tScore\nQuiz 1\t8.5');
    expect(r.text).toContain('\t\t\tfar cell'); // column D
    expect(r.text).toContain('--- Sheet: Other ---');
  });

  it('recognises an Office file with no name or type by looking inside the zip', async () => {
    const r = await extractFile(fixture('lec.pptx'), 'file', 'application/octet-stream');
    expect(r.kind).toBe('pptx');
  });

  it('returns images as images', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const r = await extractFile(png, 'diagram.png', 'image/png');
    expect(r.kind).toBe('image');
    expect(r.image).toEqual({ data: png.toString('base64'), mimeType: 'image/png' });
  });

  it('explains instead of throwing on a broken file', async () => {
    const r = await extractFile(Buffer.from('%PDF-1.4 garbage'), 'bad.pdf');
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/^Could not read bad\.pdf as pdf/);
  });

  it('says old Office formats are not readable', async () => {
    const r = await extractFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'old.ppt');
    expect(r.kind).toBe('unsupported');
    expect(r.text).toContain('.pptx');
  });
});

describe('detectKind', () => {
  it('trusts PDF magic bytes over the name', () => {
    expect(detectKind(Buffer.from('%PDF-1.7'), 'download', 'application/octet-stream')).toBe('pdf');
  });
  it('uses the Content-Type when the name says nothing', () => {
    expect(detectKind(Buffer.from('<p>'), 'x', 'text/html; charset=utf-8')).toBe('html');
    expect(detectKind(Buffer.from('a,b'), 'marks.csv')).toBe('text');
  });
});

describe('htmlToText', () => {
  it('keeps structure and links, drops scripts', () => {
    const html =
      '<html><head><title>t</title></head><body><script>x()</script><h2>Week 3</h2>' +
      '<p>Read <a href="https://ex.com/ch3">chapter 3</a>&nbsp;&amp; notes&#8217;</p><ul><li>one</li><li>two</li></ul></body></html>';
    expect(htmlToText(html)).toBe('## Week 3\nRead chapter 3 (https://ex.com/ch3) & notes’\n\n- one\n- two');
  });
});

describe('sliceText', () => {
  it('returns windows that join back into the whole text', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    let offset = 0;
    let joined = '';
    for (let guard = 0; guard < 100; guard++) {
      const { slice, next } = sliceText(text, offset, 300);
      joined += slice;
      if (next === null) break;
      expect(slice.endsWith('\n')).toBe(true); // cut at a line break
      offset = next;
    }
    expect(joined).toBe(text);
  });
});
