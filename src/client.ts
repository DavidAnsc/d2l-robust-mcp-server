/**
 * Read-only client for the Brightspace REST API.
 *
 * Only GET is implemented, on purpose: this server never submits, posts or changes
 * anything on the school's site.
 */
import { clearTokenCache, getToken, getTokenExpiry } from './auth.js';
import { API_VERSION, d2lBaseUrl } from './config.js';
import { markSessionExpired, markSessionValid, SessionExpiredError } from './session.js';

const le = (orgUnitId: number) => `/d2l/api/le/${API_VERSION.le}/${orgUnitId}`;
const lp = `/d2l/api/lp/${API_VERSION.lp}`;

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
    let response = await this.send(path);

    // 401 = the cached token went stale before its hour was up. Get a fresh one
    // from the browser session once; if that still fails, the session itself is gone.
    if (response.status === 401) {
      clearTokenCache();
      response = await this.send(path);
      if (response.status === 401) {
        markSessionExpired();
        throw new SessionExpiredError();
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`D2L API error ${response.status}: ${errorText}`);
    }

    markSessionValid(getTokenExpiry());
    return (await response.json()) as T;
  }

  private async send(path: string): Promise<Response> {
    const token = await getToken();
    return fetch(`${d2lBaseUrl()}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
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

  // Content
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
