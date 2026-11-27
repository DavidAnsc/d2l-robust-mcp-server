import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getToken: vi.fn().mockResolvedValue('tok'),
  clearTokenCache: vi.fn(),
  getTokenExpiry: vi.fn().mockReturnValue(0),
}));

import { client } from '../../src/client.js';
import { clearTokenCache, getToken } from '../../src/auth.js';
import { getSessionStatus, resetSessionStatus, SessionExpiredError } from '../../src/session.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const unauthorized = () => new Response('nope', { status: 401 });

describe('D2LClient auth handling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionStatus();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the session valid after a successful call', async () => {
    fetchMock.mockResolvedValueOnce(ok({ Identifier: '1' }));
    await client.whoami();
    expect(getSessionStatus().state).toBe('valid');
  });

  it('retries once with a fresh token after a 401', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok({ Identifier: '1' }));
    await expect(client.whoami()).resolves.toEqual({ Identifier: '1' });
    expect(clearTokenCache).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getSessionStatus().state).toBe('valid');
  });

  it('throws SessionExpiredError when the retry is also 401', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized());
    await expect(client.whoami()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(getSessionStatus().state).toBe('expired');
  });

  it('follows enrollment bookmarks across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ Items: [{ id: 1 }], PagingInfo: { Bookmark: 'b1', HasMoreItems: true } }))
      .mockResolvedValueOnce(ok({ Items: [{ id: 2 }], PagingInfo: { Bookmark: 'b2', HasMoreItems: false } }));
    await expect(client.getMyEnrollments()).resolves.toEqual({ Items: [{ id: 1 }, { id: 2 }] });
    expect(fetchMock.mock.calls[1][0]).toContain('?bookmark=b1');
  });

  it('follows calendar Next links, keeping them on the configured host', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ Objects: [{ id: 1 }], Next: 'https://elsewhere.example/d2l/api/le/1.57/1/calendar/events/myEvents/?page=2' }))
      .mockResolvedValueOnce(ok({ Objects: [{ id: 2 }], Next: null }));
    await expect(client.getMyCalendarEvents(1, 'a', 'b')).resolves.toEqual({ Objects: [{ id: 1 }, { id: 2 }] });
    const second = new URL(fetchMock.mock.calls[1][0] as string);
    expect(second.hostname).not.toBe('elsewhere.example');
    expect(second.search).toBe('?page=2');
  });

  it('only ever sends GET', async () => {
    fetchMock.mockImplementation(async () => ok({}));
    await client.whoami();
    await client.getNews(1);
    for (const call of fetchMock.mock.calls) expect((call[1] as RequestInit).method).toBe('GET');
  });

  it('does not treat 403 as an expired session', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(client.whoami()).rejects.toThrow('D2L API error 403');
    expect(clearTokenCache).not.toHaveBeenCalled();
    expect(getSessionStatus().state).toBe('unknown');
  });
});

describe('D2LClient.getFile', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.D2L_MAX_FILE_MB;
  });

  it('returns the bytes, type and served file name', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('hello', {
        headers: { 'content-type': 'text/plain', 'content-disposition': "attachment; filename*=UTF-8''Week%203%20notes.txt" },
      })
    );
    const f = await client.getTopicFile(100, 5);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/d2l\/api\/le\/[\d.]+\/100\/content\/topics\/5\/file$/);
    expect(f).toEqual({ data: Buffer.from('hello'), contentType: 'text/plain', filename: 'Week 3 notes.txt' });
  });

  it('refuses files over D2L_MAX_FILE_MB without reading them', async () => {
    process.env.D2L_MAX_FILE_MB = '1';
    fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }));
    await expect(client.getNewsAttachment(1, 2, 3)).rejects.toThrow(/over the 1 MB limit/);
  });

  it('uses the right paths for submission and feedback files', async () => {
    fetchMock.mockImplementation(async () => new Response('x'));
    await client.getSubmissionFile(1, 2, 3, 4);
    await client.getFeedbackFile(1, 2, 'user', 9, 4);
    await client.getDropboxAttachment(1, 2, 4);
    const paths = fetchMock.mock.calls.map((c) => new URL(c[0]).pathname.replace(/^\/d2l\/api\/le\/[\d.]+/, ''));
    expect(paths).toEqual([
      '/1/dropbox/folders/2/submissions/3/files/4',
      '/1/dropbox/folders/2/feedback/user/9/attachments/4',
      '/1/dropbox/folders/2/attachments/4',
    ]);
  });
});
