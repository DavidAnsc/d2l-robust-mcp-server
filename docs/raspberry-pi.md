# Running on a Raspberry Pi (or any headless Linux box)

This runs the server over HTTP on an always-on machine, so a remote MCP client (for example a
Claude custom connector or a scheduled task) can use it without a browser on your side.

```
remote MCP client
      │  HTTPS
      ▼
tunnel (Cloudflare Tunnel or Tailscale Funnel)       ← public URL, no router ports opened
      │  http://127.0.0.1:3000/mcp
      ▼
d2l-mcp --http   (systemd, on the Pi)                ← checks D2L_HTTP_TOKEN
      │  saved login in ~/.d2l-session
      ▼
your school's Brightspace API
```

Tested here: the HTTP transport, token checks, `/health`, session-expired errors and
`--export` / `--import` (unit tests plus a local run). Not yet tested on real Pi hardware or
against a live Brightspace login: please report what you find.

## 1. Install

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
user without a browser. Playwright ships a Linux ARM64 Chromium, so no separate browser
install is needed.

Below, `d2l-mcp-auth` means `node ~/d2l-robust-mcp-server/dist/auth-cli.js` (or run
`npm link` once in the clone to get both commands on your PATH).

## 2. Get a login onto the Pi

The Pi has no screen, so `d2l-mcp-auth` cannot open a login window there. Log in on a laptop
and move the session over:

```bash
# On the laptop (with this project installed and D2L_HOST set to your school's host)
d2l-mcp-auth
d2l-mcp-auth --export d2l-session.json
scp d2l-session.json pi@raspberrypi.local:
rm d2l-session.json
```

```bash
# On the Pi
export D2L_HOST=your-school.brightspace.com
d2l-mcp-auth --import d2l-session.json
rm d2l-session.json
d2l-mcp-auth --status        # exit code 0 = valid, 2 = expired
```

Why export/import instead of copying `~/.d2l-session/`: the browser encrypts its cookie store
with a key tied to the operating system (on macOS, the login keychain), so a copied folder may
not work on Linux. The export file is plain JSON cookies.

The export file is as good as your password until the session ends. It is written with
owner-only permissions; delete both copies after importing.

Alternative: if you can reach the Pi's desktop over VNC, run `D2L_HEADLESS=false d2l-mcp-auth`
there.

## 3. Run it as a service

```bash
cd ~/d2l-robust-mcp-server
sudo cp deploy/systemd/d2l-mcp.service deploy/systemd/d2l-mcp-keepalive.* /etc/systemd/system/
sudo cp deploy/systemd/d2l-mcp.env.example /etc/d2l-mcp.env
sudo chmod 600 /etc/d2l-mcp.env
sudo nano /etc/d2l-mcp.env                 # set D2L_HOST and D2L_HTTP_TOKEN (openssl rand -hex 32)
sudo systemctl edit d2l-mcp.service        # only if your user is not "pi": set User= and the ExecStart= path
sudo systemctl daemon-reload
sudo systemctl enable --now d2l-mcp.service d2l-mcp-keepalive.timer
journalctl -u d2l-mcp -f
```

- `d2l-mcp.service` runs the server with `--http` on `127.0.0.1:3000` and restarts it on failure.
- Set `D2L_TIMEZONE` (for example `America/Toronto`) in `/etc/d2l-mcp.env`. A Pi is often set
  to UTC, and dates in tool output use the server's zone unless you set this.
- `d2l-mcp-keepalive.timer` calls `/health?check=true` every 3 hours. Once the cached API token
  is over an hour old, that check opens the saved browser session headlessly, which keeps the
  session in use. Whether this stretches your school's sign-in beyond its own limits depends on
  the school's single sign-on settings; watch `journalctl -u d2l-mcp-keepalive` for a few days.

## 4. Put a public HTTPS URL in front

Either of these works without opening router ports. Both point at `http://127.0.0.1:3000`.

- **Cloudflare Tunnel**: create a tunnel in the Cloudflare dashboard with a public hostname
  pointing at `http://localhost:3000`, then run the `cloudflared service install <token>`
  command it gives you (it installs its own systemd unit). Optionally add Cloudflare Access in
  front.
- **Tailscale Funnel**: `sudo tailscale funnel --bg 3000`.

## 5. Authentication

Every `/mcp` request must carry `D2L_HTTP_TOKEN`, in one of two forms:

| Form | Example | Use when |
| --- | --- | --- |
| Header | `Authorization: Bearer <token>` | The client lets you set headers. Preferred. |
| URL path | `https://your-host/mcp/<token>` | The client only takes a URL. |

The URL form is weaker: the token appears anywhere URLs are logged (tunnel logs, client
history). Use a long token and rotate it if the URL leaks.

The server refuses to start in HTTP mode without a token. If something in front already
authenticates every request (for example Cloudflare Access), you can set
`D2L_HTTP_ALLOW_NO_AUTH=true`.

`GET /health` needs no token and returns only `{"state": "valid" | "expired" | "unknown"}`
(HTTP 503 when expired). `GET /health?check=true` needs the token, because it may launch a
browser.

## 6. When the session expires

Tools return an error starting with `SESSION_EXPIRED:` that says to run `d2l-mcp-auth`. A
scheduled task can look for that prefix and tell you. The `get_session_status` tool reports the
same state on demand. To fix it, repeat step 2.

## Settings for HTTP mode

| Variable | Default | Meaning |
| --- | --- | --- |
| `D2L_TRANSPORT` | `stdio` | `http` does the same as `--http` |
| `D2L_HTTP_HOST` | `127.0.0.1` | Address to bind. Keep loopback when using a tunnel. |
| `D2L_HTTP_PORT` | `3000` | Port |
| `D2L_HTTP_TOKEN` | none (required) | Shared secret for `/mcp` |
| `D2L_HTTP_ALLOW_NO_AUTH` | `false` | Allow starting without a token |
| `D2L_HTTP_ENABLE_DOWNLOAD` | `false` | Expose `download_file`, which writes files on the Pi |
| `D2L_DOWNLOAD_DIR` | none | When set, `download_file` only writes inside this folder |
| `D2L_HEADLESS` | `true` in HTTP mode | Never open a visible browser window |
| `D2L_SESSION_PATH` | `~/.d2l-session` | Where the browser session is stored |
| `D2L_TIMEZONE` | the machine's zone | Time zone for dates in tool output |
