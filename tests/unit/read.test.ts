import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../src/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/client.js')>();
  return {
    D2LApiError: real.D2LApiError,
    client: {
      whoami: vi.fn(),
      getTopicFile: vi.fn(),
      getContentTopic: vi.fn(),
      getDropboxAttachment: vi.fn(),
      getSubmissionFile: vi.fn(),
      getFeedbackFile: vi.fn(),
      getNewsAttachment: vi.fn(),
    },
  };
});
vi.mock('../../src/tools/files.js', () => ({ fetchWithSession: vi.fn() }));

import { client, D2LApiError } from '../../src/client.js';
import { fetchWithSession } from '../../src/tools/files.js';
import { clearReadCache, readFile } from '../../src/tools/read.js';

const pdf = readFileSync(join(__dirname, '../fixtures/files/notes.pdf'));
const file = (data: Buffer, filename = '', contentType = 'application/octet-stream') => ({ data, filename, contentType });
const text = (r: { type: string; text?: string }[]) => r[0].text!;

describe('read_file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReadCache();
    process.env.D2L_COURSE_ID = '100';
  });

  it('reads a topic file, naming it from the topic when the server does not', async () => {
    vi.mocked(client.getTopicFile).mockResolvedValue(file(pdf));
    vi.mocked(client.getContentTopic).mockResolvedValue({ TopicId: 5, Title: 'Week 1', Url: '/content/enforced/100-X/Week%201%20notes.pdf' });
    const out = await readFile({ source: 'topic', topicId: 5 });
    expect(client.getTopicFile).toHaveBeenCalledWith(100, 5);
    expect(text(out)).toMatch(/^File: Week 1 notes\.pdf \(pdf, 2\.2 KB, 3 pages\)/);
    expect(text(out)).toContain("Page 1: Ohm's law");
  });

  it('describes a Link topic instead of failing', async () => {
    vi.mocked(client.getTopicFile).mockRejectedValue(new D2LApiError(404, 'Not Found'));
    vi.mocked(client.getContentTopic).mockResolvedValue({ TopicId: 6, Title: 'Textbook', Url: 'https://publisher.example/book' });
    expect(text(await readFile({ source: 'topic', topicId: 6 }))).toBe(
      'Topic "Textbook" is a link, not a file: https://publisher.example/book'
    );
  });

  it('falls back to the browser session for /content/ files the API will not serve', async () => {
    vi.mocked(client.getTopicFile).mockRejectedValue(new D2LApiError(404, 'Not Found'));
    vi.mocked(client.getContentTopic).mockResolvedValue({ TopicId: 7, Title: 'Page', Url: '/content/enforced/100-X/page.html' });
    vi.mocked(fetchWithSession).mockResolvedValue(file(Buffer.from('<h1>Hi</h1>'), 'page.html', 'text/html'));
    expect(text(await readFile({ source: 'topic', topicId: 7 }))).toContain('# Hi');
    expect(fetchWithSession).toHaveBeenCalledWith('/content/enforced/100-X/page.html');
  });

  it('reads feedback files for the current user without being told the user id', async () => {
    vi.mocked(client.whoami).mockResolvedValue({ Identifier: '45760' });
    vi.mocked(client.getFeedbackFile).mockResolvedValue(file(Buffer.from('well done'), 'fb.txt', 'text/plain'));
    await readFile({ source: 'feedback_file', assignmentId: 9, fileId: 3 });
    expect(client.getFeedbackFile).toHaveBeenCalledWith(100, 9, 'user', 45760, 3);
  });

  it('asks for the IDs a source needs', async () => {
    await expect(readFile({ source: 'submission_file', assignmentId: 9, fileId: 3 })).rejects.toThrow(
      'source "submission_file" needs submissionId.'
    );
  });

  it('pages a long file, downloading it only once', async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n');
    vi.mocked(client.getNewsAttachment).mockResolvedValue(file(Buffer.from(long), 'big.txt', 'text/plain'));
    const first = text(await readFile({ source: 'announcement_attachment', announcementId: 1, fileId: 2, maxChars: 5000 }));
    const next = Number(first.match(/offset=(\d+)/)![1]);
    const second = text(await readFile({ source: 'announcement_attachment', announcementId: 1, fileId: 2, maxChars: 5000, offset: next }));
    expect(second).toContain(`Showing characters ${next}–`);
    expect(client.getNewsAttachment).toHaveBeenCalledTimes(1);
  });

  it('returns images as an image block', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    vi.mocked(client.getDropboxAttachment).mockResolvedValue(file(png, 'circuit.png', 'image/png'));
    const out = await readFile({ source: 'assignment_attachment', assignmentId: 9, fileId: 4 });
    expect(out[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  });
});
