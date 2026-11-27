/**
 * Read-only client for the Brightspace REST API.
 *
 * Only GET is implemented, on purpose: this server never submits, posts or changes
 * anything on the school's site.
 */
import { clearTokenCache, getToken, getTokenExpiry } from './auth.js';
import { API_VERSION, d2lBaseUrl, maxFileBytes } from './config.js';
import { markSessionExpired, markSessionValid, SessionExpiredError } from './session.js';

const le = (orgUnitId: number) => `/d2l/api/le/${API_VERSION.le}/${orgUnitId}`;
const lp = `/d2l/api/lp/${API_VERSION.lp}`;

export interface DownloadedFile {
  data: Buffer;
  contentType: string;
  /** From Content-Disposition; empty if the server didn't name it. */
  filename: string;
}

/** A non-401 error response from the API; `status` lets callers react to 404 and 403. */
export class D2LApiError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`D2L API error ${status}: ${body}`);
    this.name = 'D2LApiError';
  }
}

/** The file name the server suggests, reduced to a bare name. */
export function filenameFromDisposition(header: string): string {
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  const plain = header.match(/filename\s*=\s*("([^"]*)"|[^;]+)/);
  let name = '';
  try {
    if (star) name = decodeURIComponent(star[1].trim());
    else if (plain) name = (plain[2] ?? plain[1]).trim();
  } catch {
    // Malformed encoding: no name.
  }
  return name.split(/[\\/]/).pop() ?? '';
}

/** Safety stop for paged endpoints. */
const MAX_PAGES = 50;

/** A `Next` link may be absolute; keep only the path so it always goes to the configured host. */
function toApiPath(next: string): string {
  const url = new URL(next, d2lBaseUrl());
  return url.pathname + url.search;
}

export class D2LClient {
  /** GET a Brightspace API path and parse the JSON body. */
  async get<T = unknown>(path: string): Promise<T> {
    const response = await this.request(path, 'application/json');
    return (await response.json()) as T;
  }

  /**
   * GET a file from the API. Refuses files over D2L_MAX_FILE_MB (default 50) before
   * reading the body, so a huge video can't fill the Pi's memory.
   */
  async getFile(path: string): Promise<DownloadedFile> {
    const response = await this.request(path, '*/*');
    const limit = maxFileBytes();
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > limit) {
      await response.body?.cancel();
      throw new Error(`File is ${(declared / 1048576).toFixed(1)} MB, over the ${limit / 1048576} MB limit (D2L_MAX_FILE_MB).`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > limit) {
      throw new Error(`File is over the ${limit / 1048576} MB limit (D2L_MAX_FILE_MB).`);
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const filename = filenameFromDisposition(response.headers.get('content-disposition') || '');
    return { data, contentType, filename };
  }

  /** Send a GET, retrying once with a fresh token on 401; throws on any other failure. */
  private async request(path: string, accept: string): Promise<Response> {
    let response = await this.send(path, accept);

    // 401 = the cached token went stale before its hour was up. Get a fresh one
    // from the browser session once; if that still fails, the session itself is gone.
    if (response.status === 401) {
      clearTokenCache();
      response = await this.send(path, accept);
      if (response.status === 401) {
        markSessionExpired();
        throw new SessionExpiredError();
      }
    }

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 500);
      throw new D2LApiError(response.status, errorText);
    }

    markSessionValid(getTokenExpiry());
    return response;
  }

  private async send(path: string, accept: string): Promise<Response> {
    const token = await getToken();
    return fetch(`${d2lBaseUrl()}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
    });
  }

  // Assignments (dropbox)
  getDropboxFolders(orgUnitId: number) {
    return this.get(`${le(orgUnitId)}/dropbox/folders/`);
  }

  getDropboxFolder(orgUnitId: number, folderId: number) {
    return this.get(`${le(orgUnitId)}/dropbox/folders/${folderId}`);
  }

  getDropboxSubmissions(orgUnitId: number, folderId: number) {
    return this.get(`${le(orgUnitId)}/dropbox/folders/${folderId}/submissions/`);
  }

  /** A file the instructor attached to an assignment. */
  getDropboxAttachment(orgUnitId: number, folderId: number, fileId: number) {
    return this.getFile(`${le(orgUnitId)}/dropbox/folders/${folderId}/attachments/${fileId}`);
  }

  /** A file you submitted to an assignment. */
  getSubmissionFile(orgUnitId: number, folderId: number, submissionId: number, fileId: number) {
    return this.getFile(`${le(orgUnitId)}/dropbox/folders/${folderId}/submissions/${submissionId}/files/${fileId}`);
  }

  /** A file the instructor attached to your feedback. `entityId` is your user (or group) id. */
  getFeedbackFile(orgUnitId: number, folderId: number, entityType: 'user' | 'group', entityId: number, fileId: number) {
    return this.getFile(
      `${le(orgUnitId)}/dropbox/folders/${folderId}/feedback/${entityType}/${entityId}/attachments/${fileId}`
    );
  }

  // Content
  /** The file behind a content topic (a File or HTML topic; Link topics have none). */
  getTopicFile(orgUnitId: number, topicId: number) {
    return this.getFile(`${le(orgUnitId)}/content/topics/${topicId}/file`);
  }

  getContentToc(orgUnitId: number) {
    return this.get(`${le(orgUnitId)}/content/toc`);
  }

  getContentTopic(orgUnitId: number, topicId: number) {
    return this.get(`${le(orgUnitId)}/content/topics/${topicId}`);
  }

  getContentModules(orgUnitId: number) {
    return this.get(`${le(orgUnitId)}/content/root/`);
  }

  getContentModule(orgUnitId: number, moduleId: number) {
    return this.get(`${le(orgUnitId)}/content/modules/${moduleId}/structure/`);
  }

  // Grades
  getMyGradeValues(orgUnitId: number) {
    return this.get(`${le(orgUnitId)}/grades/values/myGradeValues/`);
  }

  getGradeObjects(orgUnitId: number) {
    return this.get(`${le(orgUnitId)}/grades/`);
  }

  // Calendar (an ObjectListPage: follow `Next` until it is empty)
  async getMyCalendarEvents(orgUnitId: number, startDateTime: string, endDateTime: string) {
    const params = new URLSearchParams({ startDateTime, endDateTime });
    let path: string | null = `${le(orgUnitId)}/calendar/events/myEvents/?${params}`;
    const objects: unknown[] = [];
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const res: { Objects?: unknown[]; Next?: string | null } = await this.get(path);
      objects.push(...(res.Objects ?? []));
      path = res.Next ? toApiPath(res.Next) : null;
    }
    return { Objects: objects };
  }

  // Announcements
  getNews(orgUnitId: number) {
    return this.get(`${le(orgUnitId)}/news/`);
  }

  /** A file attached to an announcement. */
  getNewsAttachment(orgUnitId: number, newsItemId: number, fileId: number) {
    return this.getFile(`${le(orgUnitId)}/news/${newsItemId}/attachments/${fileId}`);
  }

  // User and enrollments
  whoami() {
    return this.get(`${lp}/users/whoami`);
  }

  /** All enrollments (a PagedResultSet: follow the bookmark while HasMoreItems). */
  async getMyEnrollments() {
    const items: unknown[] = [];
    let bookmark: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : '';
      const res: { Items?: unknown[]; PagingInfo?: { Bookmark?: string; HasMoreItems?: boolean } } =
        await this.get(`${lp}/enrollments/myenrollments/${query}`);
      items.push(...(res.Items ?? []));
      if (!res.PagingInfo?.HasMoreItems || !res.PagingInfo.Bookmark) break;
      bookmark = res.PagingInfo.Bookmark;
    }
    return { Items: items };
  }
}

export const client = new D2LClient();
