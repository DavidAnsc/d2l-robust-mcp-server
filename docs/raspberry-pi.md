# Running on a Raspberry Pi at home, used from your laptop anywhere

The Pi stays at home, always on and logged in to Brightspace. Your laptop (a MacBook here)
reaches it from anywhere over HTTPS, and Claude on the laptop uses its tools.

```
MacBook (anywhere)                           Raspberry Pi (home)
┌──────────────────────────┐                 ┌───────────────────────────────────┐
│ Claude Code / Claude     │  HTTPS + token  │ d2l-mcp --http  (127.0.0.1:3000)   │
│ Desktop ──────────────────┼────────────────►│   ▲ tailscale serve (HTTPS)        │
│                          │   Tailscale     │   │                                │
│ d2l-mcp-auth --push ─────┼────────────────►│ POST /session: replaces the login │
│ (re-login, no SSH)       │                 │ ~/.d2l-session  (saved login)      │
└──────────────────────────┘                 │   │ GET only                       │
                                             │   ▼                                │
                                             │ your school's Brightspace API      │
                                             └───────────────────────────────────┘
```

What has been tested: the HTTP transport, token checks, `/health`, `read_file` on PDF, PPTX,
DOCX and XLSX files, session push, and cookie import/export through a real Chromium. Not
yet tested on real Pi hardware or against a live Brightspace login: please report what you
find.

## 1. Install on the Pi

Raspberry Pi 4 or 5, 2 GB RAM or more, 64-bit Raspberry Pi OS Lite (Bookworm or later).

```bash
# Node.js LTS (NodeSource, or your preferred method)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# As the user the service will run as (here: pi), not root
git clone https://github.com/DavidAnsc/d2l-robust-mcp-server.git ~/d2l-robust-mcp-server
cd ~/d2l-robust-mcp-server
npm ci                                       # also builds, and downloads Chromium for this user
sudo npx playwright install-deps chromium    # system libraries Chromium needs
```

Install as the service user, not with `sudo npm install -g`: Playwright downloads Chromium into
the installing user's home (`~/.cache/ms-playwright`), so a root install leaves the service
user without a browser. If Playwright's Chromium won't run on your Pi, install the system one
(`sudo apt-get install -y chromium`) and set `D2L_BROWSER_PATH=/usr/bin/chromium`.

## 2. Run it as a service

```bash
cd ~/d2l-robust-mcp-server
sudo cp deploy/systemd/d2l-mcp.service deploy/systemd/d2l-mcp-keepalive.* /etc/systemd/system/
sudo cp deploy/systemd/d2l-mcp.env.example /etc/d2l-mcp.env
sudo chmod 600 /etc/d2l-mcp.env
openssl rand -hex 32                       # copy this: it is your D2L_HTTP_TOKEN
sudo nano /etc/d2l-mcp.env                 # set D2L_HOST, D2L_HTTP_TOKEN, D2L_TIMEZONE
sudo systemctl edit d2l-mcp.service        # only if your user is not "pi": set User= and the ExecStart= path
sudo systemctl daemon-reload
sudo systemctl enable --now d2l-mcp.service d2l-mcp-keepalive.timer
journalctl -u d2l-mcp -f
```

- `d2l-mcp.service` runs the server on `127.0.0.1:3000` and restarts it if it fails.
- Set `D2L_TIMEZONE` (for example `America/Toronto`): a Pi is often on UTC, and due dates are
  shown in the server's zone otherwise.
- `d2l-mcp-keepalive.timer` checks the login every hour. The API token lasts an hour, so each
  check re-opens the saved browser session, which keeps your school's login in use.
- Optional, recommended: set `D2L_NOTIFY_URL=https://ntfy.sh/<long-random-topic>` and subscribe
  to that topic in the [ntfy](https://ntfy.sh) phone app. You then get a notification the moment
  the login expires, instead of finding out when a tool fails.

## 3. Reach the Pi from anywhere: Tailscale

[Tailscale](https://tailscale.com) puts the Pi and the MacBook on one private network that
works from any Wi-Fi, without opening router ports. Install it on both and sign in to the same
account. Then, on the Pi:

```bash
sudo tailscale serve --bg 3000
tailscale serve status        # shows the address, e.g. https://raspberrypi.tail1234.ts.net
```

`tailscale serve` gives the Pi an HTTPS address that **only your own devices** can reach.
That address, plus the token, is all the laptop needs. Below it is written
`https://raspberrypi.tail1234.ts.net`; use yours.

Check from the Mac:

```bash
curl https://raspberrypi.tail1234.ts.net/health
```

Expect `{"state":"unknown"}` (or `"expired"`) until the next step logs the Pi in.

> **`serve` or `funnel`?** `tailscale serve` is private to your devices. `tailscale funnel`
> puts the server on the public internet. You only need Funnel (or Cloudflare Tunnel) for
> clients that connect from **Anthropic's servers** rather than from your laptop: custom
> connectors added at claude.ai, or used from the Claude phone app. Everything in step 5
> connects from the Mac itself, so `serve` is enough and safer.

## 4. Log the Pi in from the Mac

The Pi has no screen, so you log in on the Mac and push the login to the Pi. On the Mac,
install the project (as in the README), then put these in `~/.zshrc`:

```bash
export D2L_HOST=learn.example.edu                       # your school
export D2L_PUSH_URL=https://raspberrypi.tail1234.ts.net # the Pi
export D2L_HTTP_TOKEN=<the token from /etc/d2l-mcp.env>
```

Then, whenever the Pi needs a login (first time, or after an expiry notification):

```bash
d2l-mcp-auth --push
```

It checks the Mac's own saved login, opens a browser window only if that has expired too, and
sends the cookies to the Pi over HTTPS. The Pi saves them, checks them against Brightspace and
answers `Done: the server is logged in`. No SSH and no files to copy or delete.

When you log in, tick **"Stay signed in"** (or "Keep me signed in") on your school's sign-in
page if it offers one. That cookie travels to the Pi as well, and it is what lets the Pi sign
itself back in when only the Brightspace session has lapsed.

## 5. Connect Claude on the Mac

**Claude Code:**

```bash
claude mcp add --transport http --scope user d2l https://raspberrypi.tail1234.ts.net/mcp \
  --header "Authorization: Bearer $D2L_HTTP_TOKEN"
```

**Claude Desktop:** edit `~/Library/Application Support/Claude/claude_desktop_config.json`.
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) runs on the Mac and forwards to the Pi,
so this works with the private `tailscale serve` address:

```json
{
  "mcpServers": {
    "d2l": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://raspberrypi.tail1234.ts.net/mcp",
        "--header", "Authorization:${D2L_AUTH_HEADER}"
      ],
      "env": { "D2L_AUTH_HEADER": "Bearer <the token>" }
    }
  }
}
```

(The header value goes in `env`, with no space inside the `args` entry, because some apps split
arguments at spaces.)

Restart Claude Desktop and ask "What's due this week?", or "Read the week 3 slides in my
circuits course".

## 6. When the login expires

How long a login lasts is set by your school; the hourly keep-alive and "Stay signed in" stretch
it as far as the school allows. When it does run out:

- tools answer with an error starting `SESSION_EXPIRED:`;
- `GET /health` returns `{"state":"expired"}` with HTTP 503;
- with `D2L_NOTIFY_URL` set, your phone gets a notification.

Fix: run `d2l-mcp-auth --push` on the Mac.

Without the Mac at hand, the older route still works: `d2l-mcp-auth --export file` on any
machine with a browser, copy the file to the Pi, `d2l-mcp-auth --import file` there, delete
both copies.

## Security notes

- The token is the only key to your Brightspace data and to replacing the Pi's login. Keep it
  long (`openssl rand -hex 32`) and out of shared files. To rotate it, change it in
  `/etc/d2l-mcp.env`, `sudo systemctl restart d2l-mcp`, and update the Mac.
- Prefer the `Authorization` header over the `/mcp/<token>` URL form: URLs end up in logs.
  `/session` (login push) accepts the header form only.
- `d2l-mcp-auth --push` refuses plain `http://` addresses other than localhost.
- The server only ever sends `GET` requests to Brightspace. `read_file` keeps files in memory
  and returns their contents; it writes nothing to the Pi's disk. (`download_file`, which does
  write, stays off over HTTP unless `D2L_HTTP_ENABLE_DOWNLOAD=true`.)
- To turn off login push, set `D2L_HTTP_ALLOW_SESSION_PUSH=false`.

## Settings for HTTP mode

| Variable | Default | Meaning |
| --- | --- | --- |
| `D2L_TRANSPORT` | `stdio` | `http` does the same as `--http` |
| `D2L_HTTP_HOST` | `127.0.0.1` | Address to bind. Keep loopback when using Tailscale or a tunnel. |
| `D2L_HTTP_PORT` | `3000` | Port |
| `D2L_HTTP_TOKEN` | none (required) | Shared secret for `/mcp` and `/session` |
| `D2L_HTTP_ALLOW_NO_AUTH` | `false` | Allow starting without a token |
| `D2L_HTTP_ALLOW_SESSION_PUSH` | `true` | Accept `d2l-mcp-auth --push` at `POST /session` |
| `D2L_HTTP_ENABLE_DOWNLOAD` | `false` | Expose `download_file`, which writes files on the Pi |
| `D2L_NOTIFY_URL` | none | POST a message here when the login expires (e.g. an ntfy.sh topic) |
| `D2L_MAX_FILE_MB` | `50` | Largest file `read_file` will fetch |
| `D2L_BROWSER_PATH` | Playwright's Chromium | Another Chromium to use, e.g. `/usr/bin/chromium` |
| `D2L_DOWNLOAD_DIR` | none | When set, `download_file` only writes inside this folder |
| `D2L_HEADLESS` | `true` in HTTP mode | Never open a visible browser window |
| `D2L_SESSION_PATH` | `~/.d2l-session` | Where the browser session is stored |
| `D2L_TIMEZONE` | the machine's zone | Time zone for dates in tool output |
