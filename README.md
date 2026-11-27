# d2l-robust-mcp-server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
D2L Brightspace. It lets an AI assistant look up your courses, assignments, due dates, grades,
announcements and course content.

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
`https://`. If you leave it unset, it defaults to `learn.ul.ie` (the original project's school).

## Remote use (HTTP)

```bash
D2L_HOST=learn.example.edu D2L_HTTP_TOKEN=$(openssl rand -hex 32) d2l-mcp --http
```

This serves MCP over streamable HTTP at `http://127.0.0.1:3000/mcp`. Every request must
carry the token, either as `Authorization: Bearer <token>` or, for clients that only take a
URL, as the last part of the path (`/mcp/<token>`). The server refuses to start without a
token. In HTTP mode:

- it never opens a login window: an expired login becomes a `SESSION_EXPIRED` error;
- `download_file` is off unless `D2L_HTTP_ENABLE_DOWNLOAD=true`, because it writes to the
  server's disk;
- `GET /health` returns `{"state": "valid" | "expired" | "unknown"}` (HTTP 503 when expired),
  and `GET /health?check=true` with the token checks the login live.

To run it on a Raspberry Pi behind Cloudflare Tunnel or Tailscale Funnel, with systemd units
and a keep-alive timer, see **[docs/raspberry-pi.md](docs/raspberry-pi.md)**.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_my_courses` | Your enrolled courses and their IDs (`orgUnitId`) |
| `get_upcoming_due_dates` | Calendar events and deadlines, by default 7 days back to 30 ahead |
| `get_assignments` | Assignments with due dates and instructions |
| `get_assignment` | Full details of one assignment |
| `get_assignment_submissions` | Your submissions, feedback and grades for one assignment |
| `get_my_grades` | Your grade items, scores and feedback |
| `get_announcements` | Course announcements |
| `get_course_content` | The full course outline: modules and topics |
| `get_course_modules` | Top-level course sections |
| `get_course_module` | Everything inside one section |
| `get_course_topic` | One topic or lecture item |
| `download_file` | Downloads a course file, returning the text of `.docx` and plain-text files |
| `get_session_status` | Whether the saved login still works |

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

API tokens last about an hour and are refreshed from the saved session automatically. The
session itself ends after a period of inactivity that your school sets (often around a day).
When it has ended:

- with a screen (stdio on a desktop), a login window opens;
- without one, tools fail with a message starting `SESSION_EXPIRED:` that says to run
  `d2l-mcp-auth`.

To log a machine without a screen in, log in on a laptop, `--export`, copy the file over,
`--import`, then delete both copies. The file is as good as your password until the session
ends. Export and import move cookies, not the browser folder, because the browser encrypts its
cookie store with a key tied to the operating system.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `D2L_HOST` | `learn.ul.ie` | Your Brightspace host |
| `D2L_COURSE_ID` | none | Default course for tools called without `orgUnitId` |
| `D2L_TIMEZONE` | machine's zone | IANA time zone for dates, e.g. `America/Toronto` |
| `D2L_SESSION_PATH` | `~/.d2l-session` | Where the browser login is stored |
| `D2L_HEADLESS` | `true` on Linux without a display and in HTTP mode | Never open a login window |
| `D2L_DOWNLOAD_DIR` | none | If set, `download_file` only writes inside this folder |
| `D2L_TRANSPORT` | `stdio` | `http` is the same as `--http` |
| `D2L_HTTP_HOST` | `127.0.0.1` | Address to listen on |
| `D2L_HTTP_PORT` | `3000` | Port to listen on |
| `D2L_HTTP_TOKEN` | none, required | Shared secret for `/mcp` |
| `D2L_HTTP_ALLOW_NO_AUTH` | `false` | Start without a token (only behind something that authenticates) |
| `D2L_HTTP_ENABLE_DOWNLOAD` | `false` | Offer `download_file` over HTTP |

`download_file` only fetches `https://` URLs on `D2L_HOST` or its subdomains.

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
  config.ts        every environment setting
  auth.ts          saved browser session → API token
  session.ts       session state, SessionExpiredError, export-file format
  client.ts        read-only Brightspace API client
  server.ts        builds the MCP server from the tool modules
  http.ts          streamable HTTP transport, token check, /health
  tools/           one module per area; each tool is { description, schema, handler }
  utils/marshal.ts trims API responses into compact, model-friendly JSON
```

To add a tool, add a `{ description, schema, handler }` entry to a module in `src/tools/`,
add the client call it needs, and spread the module into `readOnlyTools` in `src/server.ts`.

## What changed from upstream

- **Added:**
  - HTTP transport, token auth and `/health`
  - headless-only mode with `SESSION_EXPIRED` errors
  - the `get_session_status` tool
  - session export, import and status commands
  - `D2L_SESSION_PATH`, `D2L_TIMEZONE` and `D2L_DOWNLOAD_DIR`
  - systemd units and the Raspberry Pi guide
  - CI on Node 20 and 22
- **Fixed:**
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
