# d2l-robust-mcp-server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
D2L Brightspace. It lets an AI assistant look up your courses, assignments, due dates, grades,
announcements, quizzes, discussions and course content, and read the files in them: lecture
slides, PDFs, assignment handouts, your own submissions and your instructors' feedback.

The tools are small and chain together, so the agent decides what to look at. Listing tools
return items with a `"read"` reference. The agent passes those references to `read_files` and
reads only what's relevant. For example:

- **A guide for one assignment:** `get_assignment` (instructions, rubric, weight,
  attachments), then `find_related` (content and announcements about it), then `read_files`
  on the handouts that matter.
- **A study guide for a test:** `list_unit_items` for the units, then `read_files` on the
  slides, notes and worksheets, plus `read_file asImages=true` for diagram-heavy slides.

The server sends this map of the tools to every client when it connects, and the
`assignment-guide` and `study-guide` prompts walk through it.

It runs either as a local program (stdio, for Claude Desktop and similar apps) or as an HTTP
server on an always-on machine such as a Raspberry Pi. In HTTP mode, remote clients and
scheduled tasks can use it without a browser on your side.

This is a fork of [bencered/d2l-mcp-server](https://github.com/bencered/d2l-mcp-server). It adds
the HTTP transport, login on machines without a screen, and clear errors when the login expires.
It also fixes several bugs (see [What changed from upstream](#what-changed-from-upstream)).

> [!WARNING]
> Don't use this to engage in academic misconduct. It is meant to help you keep track of your
> coursework and learn the material, not to gain an unfair advantage. Check that automated
> access is allowed by your school's acceptable-use policy.

## How it works

Brightspace's web pages call its REST API with a short-lived bearer token. This server opens
Brightspace in a saved, logged-in browser profile (Playwright + Chromium), captures that token
and calls the same API. It only ever sends `GET` requests: it never submits, posts or changes
anything.

```
MCP client ──► d2l-mcp ──► Brightspace REST API (GET only)
                  │
                  └── ~/.d2l-session  (saved browser login; tokens refreshed from it hourly)
```

## Install

Requires Node.js 20 or newer.

```bash
git clone https://github.com/DavidAnsc/d2l-robust-mcp-server.git
cd d2l-robust-mcp-server
npm ci          # installs, builds, and downloads Chromium
npm link        # puts d2l-mcp and d2l-mcp-auth on your PATH
```

On a Mac with Google Chrome in `/Applications`, the server uses that Chrome and `npm ci`
downloads no browser. Everywhere else, `npm ci` downloads Playwright's Chromium (about
250 MB in two parts). After each part reaches 100% it unpacks with no progress shown, which
can take a few minutes. If the download fails, the rest of the install still finishes and
prints how to fix it. To use another browser, set `D2L_BROWSER_PATH` (see
[Configuration](#configuration)) both when installing and when running.

## Quick start (Claude Desktop)

1. Log in once. A browser window opens; sign in to Brightspace as usual.

   ```bash
   D2L_HOST=learn.example.edu d2l-mcp-auth
   ```

2. Add the server to Claude Desktop's config. On macOS that is
   `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows,
   `%APPDATA%\Claude\claude_desktop_config.json`.

   ```json
   {
     "mcpServers": {
       "d2l": {
         "command": "d2l-mcp",
         "env": { "D2L_HOST": "learn.example.edu" }
       }
     }
   }
   ```

3. Restart Claude Desktop and ask "What's due this week?"

`D2L_HOST` is the address you see in the browser when you use Brightspace, without
`https://`. Once you have logged in, later commands without `D2L_HOST` use the host of that
login; with no login and no `D2L_HOST`, it defaults to `learn.ul.ie` (the original project's school).

## Remote use (HTTP)

```bash
D2L_HOST=learn.example.edu D2L_HTTP_TOKEN=$(openssl rand -hex 32) d2l-mcp --http
```

This serves MCP over streamable HTTP at `http://127.0.0.1:3000/mcp`. Every request must
carry the token, either as `Authorization: Bearer <token>` or, for clients that only take a
URL, as the last part of the path (`/mcp/<token>`). The server refuses to start without a
token. In HTTP mode:

- it never opens a login window: an expired login becomes a `SESSION_EXPIRED` error;
- `read_file` works as usual (it never saves the file, only its extracted text in the
  [text cache](#text-cache)); `download_file` is off unless
  `D2L_HTTP_ENABLE_DOWNLOAD=true`, because it writes to the server's disk;
- `POST /session` accepts a fresh login from `d2l-mcp-auth --push`, so a laptop can re-log the
  server in from anywhere;
- `GET /health` returns `{"state": "valid" | "expired" | "unknown"}` (HTTP 503 when expired),
  and `GET /health?check=true` with the token checks the login live.

### OAuth sign-in (claude.ai connectors and other OAuth-only clients)

Some clients won't take a token and want to sign in with OAuth instead. claude.ai custom
connectors are one example. For those, turn on the built-in OAuth server:

```bash
D2L_OAUTH=true D2L_PUBLIC_URL=https://your-server.example D2L_HTTP_TOKEN=... d2l-mcp --http
```

Add `https://your-server.example/mcp` as the connector URL. When the client connects, it
registers itself and opens a sign-in page on this server. That page names the app and
where it will send you back, and asks for `D2L_HTTP_TOKEN`. Approve it, and the app gets its
own token. That token lasts a day and renews itself for up to 90 days.
`Authorization: Bearer <D2L_HTTP_TOKEN>` keeps working alongside it. `D2L_PUBLIC_URL` must be
the HTTPS address the client reaches, e.g. a Tailscale Funnel or Cloudflare Tunnel address.
Issued tokens are stored hashed in `oauth.json` in the session folder (`D2L_OAUTH_STATE`).
To revoke them all, delete that file and restart.

To run it on a Raspberry Pi at home and use it from your laptop anywhere (Tailscale, systemd
units, hourly keep-alive, expiry notifications, re-login with `--push`), see
**[docs/raspberry-pi.md](docs/raspberry-pi.md)**.

## Tools

**Find, then read**

| Tool | What it returns |
| --- | --- |
| `list_unit_items` | Everything in one or more modules (by id or title, e.g. `"Unit 3"`, sub-modules included): each item's kind, place, last change and description, module descriptions (often the learning outcomes), and `read` refs for the readable ones. `kinds` and `extensions` narrow it |
| `find_related` | What points at one assignment: content that links to or names it (matching short forms like "HW3"), the items next to that link, announcements that mention it and, optionally, discussion posts. References, not file contents |
| `search_course` | Where a word or "phrase" appears: content titles, assignment instructions, announcements, quizzes, and with `includeFiles` inside every slide and PDF page. Each match carries its ids and `read` ref |
| `read_files` | Up to 20 files in one call from their `read` refs, each under its own header. Long files are cut to a share, with the exact `read_file` call for the rest |
| `read_file` | One file, long ones in parts; `asImages` returns pictures of pages or slides instead |

**Across courses**

| Tool | What it returns |
| --- | --- |
| `get_active_courses` | This term's courses only, each with why it counts as current |
| `whats_new` | Since a time (`"7d"`, `"48h"`, a date): new announcements, new or changed content, grades released, what's due in 14 days, unread counts, for every active course |
| `get_my_courses` | Every enrollment and its `orgUnitId`, including past terms |
| `get_upcoming_due_dates` | Calendar events and deadlines, by default 7 days back to 30 ahead |

**One course**

| Tool | What it returns |
| --- | --- |
| `get_course_content` | The full outline: modules and topics, with each topic's kind (file, page, link, video, assignment, quiz, discussion, external tool, SCORM…), last change and `read` ref |
| `get_course_modules` / `get_course_module` | Top-level sections; everything inside one section |
| `get_course_topic` | One topic or lecture item |
| `get_course_overview` | The Course Overview page, its file (often the syllabus) and items titled like a syllabus, outline or schedule, with `read` refs (`includeText` reads them too) |
| `get_assignments` | Assignments with due dates, points and instructions; `status` (upcoming/past) and `dueWithinDays` filter them |
| `get_assignment` | One assignment: instructions, dates, the **rubric**, its grade item and weight, links, and attachments with `read` refs |
| `get_assignment_submissions` | Your submissions (every attempt), feedback and grade, with `read` refs for submitted and feedback files |
| `get_quizzes` / `get_quiz` | Quizzes with dates, time limit, attempts allowed and instructions; your attempts where shown |
| `get_discussions` / `get_discussion_posts` | Forums and topics; the posts of one topic as threads |
| `get_checklists` | Checklists with their categories and items |
| `get_my_grades` | Your grade items, scores and feedback |
| `get_grade_breakdown` | Categories and items with weights and max points, your score on each, your final grade if released |
| `get_announcements` | Course announcements with attachment `read` refs; `since` and `query` filter them |

**Files and the login**

| Tool | What it returns |
| --- | --- |
| `download_file` | Saves a course file to disk (stdio only by default) and returns its text |
| `get_session_status` | Whether the saved login still works |

A `read` ref is exactly the arguments `read_file` and `read_files` take, e.g.
`{"source":"topic","orgUnitId":12345,"topicId":678}`, so the agent can copy it from any
listing. Long results (files, searches, posts, what's new) come in parts: each reply says which
`offset` to ask for next.

`read_file` returns text from PDF (page by page), PowerPoint `.pptx` (slide by slide, with
speaker notes), Word `.docx`, Excel `.xlsx` (every sheet), HTML (with images noted by their alt
text), plain-text/code files and zip files (the text of the readable files inside, including
SCORM packages), and returns PNG, JPEG, GIF and WebP images as images. Some files need
[optional programs](#optional-programs-for-more-file-types) on the server.

Some schools don't let students reach parts of the API (rubrics, the quiz list, the course
overview). Tools then say "not available to students at this school" for that part and carry
on with the rest; `get_quizzes`, for example, falls back to the quizzes in the content and calendar.

### Optional programs for more file types

Install these on the machine running the server and they are used automatically:

| Program | Debian / Raspberry Pi OS | macOS (Homebrew) | Adds |
| --- | --- | --- | --- |
| LibreOffice | `sudo apt-get install -y libreoffice-core libreoffice-writer libreoffice-impress libreoffice-calc` | `brew install --cask libreoffice` | Old `.doc`, `.ppt`, `.xls`, and `.rtf`, `.odt`, `.odp`, `.ods`; pictures of PowerPoint and Word pages |
| Poppler | `sudo apt-get install -y poppler-utils` | `brew install poppler` | Pictures of PDF pages (`read_file asImages=true`), needed for OCR |
| Tesseract | `sudo apt-get install -y tesseract-ocr` | `brew install tesseract` | Text from scanned PDFs (OCR), up to `D2L_OCR_MAX_PAGES` pages |

Without them, those files get a note saying what to install. Pictures of PowerPoint slides then
fall back to the images embedded in each slide. Videos and audio have no text through the API;
the tools say so and point to any captions file.

### Prompts and resources

For clients that use them, the server also offers:

- **Prompts:** `assignment-guide` (course, assignment), `study-guide` (course, units, test) and
  `catch-up` (since). Each one is a ready-made request: it suggests which tools to use and how
  to lay out the result, and leaves what to read to the model.
- **Resources**, for attaching a whole document to a conversation yourself:
  `d2l://courses`, `d2l://course/{orgUnitId}/assignment/{assignmentId}` (the assignment with
  its rubric, files, related content and feedback), `d2l://course/{orgUnitId}/module/{moduleId}`
  (the text of everything in a module) and
  `d2l://course/{orgUnitId}/topic/{topicId}` (one file's text). Assignments and modules of
  your active courses are listed.

### Text cache

Extracted text is kept in `~/.d2l-mcp-cache` (`D2L_CACHE_DIR`), keyed by the file and its
last-modified date. A second study guide for the same unit, or one after a restart, doesn't
download and parse every file again, and a changed file is read again. The cache holds text
only, never the files themselves. The least recently used entries are removed past
`D2L_CACHE_MAX_MB` (200 MB). `D2L_CACHE=off` turns it off.

### A Markdown copy of your courses: `d2l-mcp-sync`

```bash
d2l-mcp-sync                      # every active course, into ~/d2l-courses (D2L_SYNC_DIR)
d2l-mcp-sync --course 12345 --skip units
```

For each course this writes `README.md` (an index), `overview.md`, `announcements.md`,
`assignments/<name>.md` (each assignment with its rubric, files, related content and feedback) and `units/<nn>-<module>.md` (the text of each
top-level module). Later runs reuse the text cache, so they only download what changed. An agent
can read or search the folder even while the Brightspace login has expired. On a Pi,
`deploy/systemd/d2l-mcp-sync.timer` runs it every 6 hours. It exits with code 2 when the login
has expired.

Course-scoped tools take an optional `orgUnitId`. Set `D2L_COURSE_ID` to use one course by
default.

Dates are shown with their time zone, in `D2L_TIMEZONE` if set, else the machine's own zone.
Relative dates ("today", "tomorrow", "in 3 days") count calendar days in that zone.

## Managing the login

| Command | Does |
| --- | --- |
| `d2l-mcp-auth` | Opens a browser to log in and saves the session to `~/.d2l-session` |
| `d2l-mcp-auth --status` | Checks the saved session without a window (exit code 0 valid, 2 expired) |
| `d2l-mcp-auth --export <file>` | Writes the session's cookies to a file (permissions 600) |
| `d2l-mcp-auth --import <file>` | Loads such a file into this machine's session |
| `d2l-mcp-auth --push [url]` | Sends this machine's login to a `d2l-mcp --http` server (URL from `D2L_PUSH_URL`, token from `D2L_HTTP_TOKEN`) |

API tokens last about an hour and are refreshed from the saved session automatically. The
session itself ends after a period of inactivity that your school sets (often around a day).
When it has ended:

- with a screen (stdio on a desktop), a login window opens;
- without one, tools fail with a message starting `SESSION_EXPIRED:` that says to run
  `d2l-mcp-auth`.

To log a machine without a screen in, run `d2l-mcp-auth --push https://that-server` on a
laptop. Or, without HTTP: log in on a laptop, `--export`, copy the file over, `--import`, then
delete both copies. The file is as good as your password until the session
ends. Export and import move cookies, not the browser folder, because the browser encrypts its
cookie store with a key tied to the operating system.

### Automatic login

If your school signs students in with Microsoft (a "Login" image or button on the D2L login
page that leads to `login.microsoftonline.com`), the server can sign in again by itself when
the session ends. Set:

```bash
D2L_USERNAME=12345abc@yourboard.ca
D2L_PASSWORD=your-password          # or D2L_PASSWORD_FILE=/path/to/file-with-just-the-password
```

It follows the Microsoft link on the login page, enters the email and password, answers
"Stay signed in?" with Yes, and carries on. It stops with a `SESSION_EXPIRED:` message instead
when Microsoft:

- rejects the email or password. It then won't try them again until the server restarts, so it
  can't lock your account by retrying;
- asks for two-step verification (a code, or approving on your phone). Run `d2l-mcp-auth` and
  do that step yourself;
- shows a page it doesn't recognise.

Your password sits in plain text wherever you put it, and it unlocks your whole school
account, not just Brightspace. Keep that file owner-only (`chmod 600`), and check your
school allows automated sign-in.

### Cookies kept between runs

Brightspace's login cookies are often *session cookies*, which the browser deletes when it
closes. So the login also keeps a copy of its cookies in `~/.d2l-session/d2l-mcp-cookies.json`
(permissions 600, same sensitivity as the folder) and puts back any the browser dropped.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `D2L_HOST` | host of the saved login, else `learn.ul.ie` | Your Brightspace host |
| `D2L_COURSE_ID` | none | Default course for tools called without `orgUnitId` |
| `D2L_TIMEZONE` | machine's zone | IANA time zone for dates, e.g. `America/Toronto` |
| `D2L_SESSION_PATH` | `~/.d2l-session` | Where the browser login is stored |
| `D2L_USERNAME` | none | School (Microsoft) account for [automatic login](#automatic-login) |
| `D2L_PASSWORD` / `D2L_PASSWORD_FILE` | none | Its password, or a file holding only the password |
| `D2L_HEADLESS` | `true` on Linux without a display and in HTTP mode | Never open a login window |
| `D2L_DOWNLOAD_DIR` | none | If set, `download_file` only writes inside this folder |
| `D2L_TRANSPORT` | `stdio` | `http` is the same as `--http` |
| `D2L_HTTP_HOST` | `127.0.0.1` | Address to listen on |
| `D2L_HTTP_PORT` | `3000` | Port to listen on |
| `D2L_HTTP_TOKEN` | none, required | Shared secret for `/mcp` |
| `D2L_HTTP_ALLOW_NO_AUTH` | `false` | Start without a token (only behind something that authenticates) |
| `D2L_HTTP_ENABLE_DOWNLOAD` | `false` | Offer `download_file` over HTTP |
| `D2L_HTTP_ALLOW_SESSION_PUSH` | `true` | Accept `d2l-mcp-auth --push` at `POST /session` |
| `D2L_NOTIFY_URL` | none | POST a message here when the login expires (e.g. `https://ntfy.sh/<topic>`) |
| `D2L_MAX_FILE_MB` | `50` | Largest file `read_file` will fetch |
| `D2L_BROWSER_PATH` | Google Chrome in `/Applications` on macOS if installed, else Playwright's Chromium | Another Chrome or Chromium to use, e.g. `/usr/bin/chromium`; `playwright` forces Playwright's Chromium |
| `D2L_PUSH_URL` | none | Default server for `d2l-mcp-auth --push` |
| `D2L_ACTIVE_COURSES` | none | Comma-separated `orgUnitId`s that count as active, overriding the date rules |
| `D2L_CACHE` | on | `off` turns off the [text cache](#text-cache) |
| `D2L_CACHE_DIR` | `~/.d2l-mcp-cache` | Where extracted text is kept |
| `D2L_CACHE_MAX_MB` | `200` | Most disk the text cache may use |
| `D2L_OCR` | `auto` | `off` never runs OCR on scanned PDFs |
| `D2L_OCR_MAX_PAGES` | `40` | Most pages OCR reads from one PDF |
| `D2L_SYNC_DIR` | `~/d2l-courses` | Where `d2l-mcp-sync` writes |
| `D2L_OAUTH` | `false` | Offer [OAuth sign-in](#oauth-sign-in-claudeai-connectors-and-other-oauth-only-clients) in HTTP mode |
| `D2L_PUBLIC_URL` | none | The HTTPS address clients reach the server at (needed for OAuth) |
| `D2L_OAUTH_STATE` | `oauth.json` in the session folder | Where OAuth clients and hashed tokens are kept |

`read_file` (with `source: "url"`) and `download_file` only fetch `https://` URLs on `D2L_HOST`
or its subdomains.

## Development

```bash
npm run typecheck
npm test                    # unit tests, no network or browser needed
npm run build
D2L_COURSE_ID=12345 npm run test:integration   # against your real account; log in first
```

```
src/
  index.ts         entry point: stdio or --http
  auth-cli.ts      d2l-mcp-auth
  sync-cli.ts      d2l-mcp-sync: Markdown copy of each course
  config.ts        every environment setting
  auth.ts          saved browser session → API token
  session.ts       session state, SessionExpiredError, export-file format
  client.ts        read-only Brightspace API client (JSON and files)
  extract.ts       file bytes → text (PDF via pdfjs legacy build, PPTX, DOCX, XLSX, HTML, zip, text) or image;
                   pictures of pages
  convert.ts       optional LibreOffice, pdftoppm and tesseract helpers
  cache.ts         disk cache of extracted text
  content-tree.ts  the course outline: finding, walking and classifying modules and topics
  server.ts        builds the MCP server from the tool modules
  prompts.ts       MCP prompts and d2l:// resources
  http.ts          streamable HTTP transport, token check, /health
  oauth.ts         single-user OAuth 2.1 server for HTTP mode
  tools/           one module per area; each tool is { description, schema, handler }
                   (refs.ts: the shared "read" ref; study.ts: list_unit_items, find_related, and
                   the whole-document builders used by sync and resources; across.ts: active
                   courses, what's new, search; coursework.ts: quizzes, discussions, grades,
                   overview, checklists)
  utils/marshal.ts trims API responses into compact, model-friendly JSON
```

To add a tool, add a `{ description, schema, handler }` entry to a module in `src/tools/`,
add the client call it needs, and spread the module into `readOnlyTools` in `src/server.ts`.

## What changed from upstream

- **Added:**
  - composable tools for guides: `list_unit_items`, `find_related`, `search_course` and
    `read_files`, with a `read` ref on every readable item; server instructions, the
    `assignment-guide`, `study-guide` and `catch-up` prompts, and `d2l://` resources
  - rubrics on assignments; quizzes, discussions, checklists, grade weights, the course overview
  - `get_active_courses` and `whats_new` across courses
  - a disk cache of extracted text, and `d2l-mcp-sync` for a Markdown copy of each course
  - OCR for scanned PDFs, old Office and OpenDocument files, pictures of pages and slides, the
    text inside zip files and SCORM packages, and image alt text in pages (some need
    [optional programs](#optional-programs-for-more-file-types))
  - OAuth sign-in for clients that need it
  - `read_file`: contents of course files, attachments, your submissions and feedback files
  - every submission attempt, with the file IDs needed to open them
  - `d2l-mcp-auth --push` and `POST /session`: re-log a server in from a laptop
  - `D2L_NOTIFY_URL`: a notification when the login expires
  - HTTP transport, token auth and `/health`
  - headless-only mode with `SESSION_EXPIRED` errors
  - the `get_session_status` tool
  - session export, import and status commands
  - `D2L_SESSION_PATH`, `D2L_TIMEZONE` and `D2L_DOWNLOAD_DIR`
  - systemd units and the Raspberry Pi guide
  - CI on Node 20 and 22
- **Fixed:**
  - `get_course_modules` and `get_course_module` read an API shape that has no `ModuleId`, so
    their ids came out empty. They now come from the course outline.
  - Dates were printed in the server's time zone without naming it.
  - Relative dates rounded hours, so something due tonight could show as "tomorrow".
  - Enrollments and calendar events beyond the first page were silently dropped.
  - `download_file` could fetch any URL with your logged-in browser, and could write outside
    the chosen folder through a crafted file name.
  - A stale token now gets one retry before the login is reported as expired.
  - Several tool calls at once each launched their own browser.
  - The file-download login path could hand back a browser that was not logged in.
  - `D2L_COURSE_ID` was read once at startup, and a malformed value was silently accepted.
- **Changed:**
  - The API client is GET-only.
  - Configuration lives in one module, tool registration is table-driven, and
    `dist/` is no longer committed (it is built on install).

## License

MIT. See [LICENSE](LICENSE). Original work © 2025 Bence Redmond.
