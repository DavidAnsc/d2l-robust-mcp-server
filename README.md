# D2L Brightspace MCP Server

An MCP (Model Context Protocol) server that provides AI assistants with tools to interact with D2L Brightspace LMS.

## ⚠️ WARNING! ⚠️

This server should **not** be used in any way to engage in academic misconduct.
Do not use this MCP server to cheat on any assignments, or to gain an unfair advantage
over other students. This server is only intended for use to enable agents to
better understand your assignment scheduling and to help with your _learning_ of the
course material.

**I do not condone the use of this server in any activities that would violate the user's university's Academic Code of Conduct.**

## Features

- **Automated SSO authentication** via Playwright (handles Microsoft/institutional login)
- **Persistent session storage** - login once, use for hours
- **12 tools** for accessing assignments, grades, calendar, announcements, course content
- **File downloads** with automatic text extraction (docx, txt, etc.)
- **LLM-optimized responses** - clean, token-efficient output

## Installation

```bash
npm install -g d2l-mcp-server
```

This will automatically install Chromium for browser automation.

## Setup

### 1. First-time authentication

```bash
d2l-mcp-auth
```

This opens a browser window where you log in to Brightspace. Your session is saved to `~/.d2l-session/`.

### 2. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "d2l": {
      "command": "d2l-mcp",
      "env": {
        "D2L_HOST": "learn.ul.ie",
        "D2L_COURSE_ID": "68929"
      }
    }
  }
}
```

## Available Tools

### Assignments
| Tool | Description |
|------|-------------|
| `get_assignments` | List all assignments with due dates and instructions |
| `get_assignment` | Get full details for a specific assignment |
| `get_assignment_submissions` | Get your submissions, grades, and feedback |

### Course Content
| Tool | Description |
|------|-------------|
| `get_course_content` | Get complete course syllabus/structure |
| `get_course_topic` | Get details for a specific topic/lecture |
| `get_course_modules` | Get main sections/modules of a course |
| `get_course_module` | Get contents within a specific module |

### Grades & Calendar
| Tool | Description |
|------|-------------|
| `get_my_grades` | Get all your grades with scores and feedback |
| `get_upcoming_due_dates` | Get calendar events and deadlines |

### Other
| Tool | Description |
|------|-------------|
| `get_announcements` | Get course announcements from instructors |
| `get_my_courses` | List all your enrolled courses |
| `download_file` | Download and extract content from course files (off by default in HTTP mode) |
| `get_session_status` | Check whether the saved login still works |

## Example Prompts

Once connected to Claude, you can ask things like:

- "What assignments are due this week?"
- "Show me my grades"
- "What announcements have been posted?"
- "Download the weekly report template"
- "What's the syllabus for this course?"

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `D2L_HOST` | Your Brightspace hostname | `learn.ul.ie` |
| `D2L_COURSE_ID` | Default course ID (optional) | none |

| `D2L_SESSION_PATH` | Where the browser session is stored | `~/.d2l-session` |
| `D2L_HEADLESS` | `true` never opens a login window; tools report `SESSION_EXPIRED` instead | `true` on Linux with no display and in HTTP mode, else `false` |
| `D2L_DOWNLOAD_DIR` | If set, `download_file` only writes inside this folder | none |

Setting `D2L_COURSE_ID` allows you to omit the course ID from tool calls.

`download_file` only fetches `https://` URLs on `D2L_HOST` (or its subdomains).

## Remote use (HTTP transport)

```bash
D2L_HTTP_TOKEN=$(openssl rand -hex 32) d2l-mcp --http
```

This serves MCP over streamable HTTP at `http://127.0.0.1:3000/mcp` (stateless, JSON
responses). Clients send the token as `Authorization: Bearer <token>`, or as the last part of the
URL (`/mcp/<token>`) when they can only take a URL. `GET /health` reports whether the session is
valid. See [docs/raspberry-pi.md](docs/raspberry-pi.md) for running it on a headless machine
behind a tunnel, with systemd units in [deploy/systemd](deploy/systemd).

## Session Management

- **Token expiry**: Auth tokens expire after ~1 hour but auto-refresh using the saved browser session
- **Session expiry**: Browser sessions expire after ~24h of inactivity
- **Re-authenticate**: Run `d2l-mcp-auth` if your session expires
- **Expired-session errors**: when no login window can open, tools fail with a message starting `SESSION_EXPIRED:`
- **Check the session**: `d2l-mcp-auth --status` (exit code 0 valid, 2 expired), or the `get_session_status` tool
- **Move a session between machines**: `d2l-mcp-auth --export session.json` on one, `d2l-mcp-auth --import session.json` on the other (the file holds your login cookies: delete it afterwards)

## Development

```bash
# Run tests
npm test

# Run integration tests (requires auth)
npm run test:integration

# Watch mode
npm run test:watch
```

## License

MIT
