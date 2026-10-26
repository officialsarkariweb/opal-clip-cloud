# Opal Clip Cloud ✂️

Lightweight self-hosted **video clipper** (YouTube + 1000+ sites) built to run **24x7 on Render's free tier** — 512MB RAM, no sleep, up to **4K original quality**.

Built for: lowest resource use, zero paid services, mobile-friendly UI.

## Why it stays awake and cheap

| Problem on free hosting | How this repo solves it |
|---|---|
| Services sleep after 15 min idle | Built-in **self-ping**: the server pings its own `/healthz` every 9 minutes (inbound traffic resets the sleep timer). Optional: add a free UptimeRobot monitor as backup. |
| 512MB RAM limit | **Zero npm dependencies** — one plain Node.js file (~45MB RSS). Clipping is **stream-copy only** (no re-encode): `yt-dlp --download-sections` downloads **only the seconds you selected**, then remuxes. Peak RAM during a 4K clip ≈ 170MB. |
| YouTube blocks datacenter IPs ("Sign in to confirm you're not a bot") | On boot the server auto-registers a **free Cloudflare WARP account** (via `wgcf`) and routes yt-dlp through a userspace **WireGuard tunnel** (`wireproxy`, SOCKS5 on localhost). Watchdog re-registers if the tunnel dies. You can instead supply `PROXY_URL` or `COOKIES`. |
| yt-dlp breakages over time | Built-in **daily self-update**: the server checks GitHub releases and swaps the yt-dlp binary at runtime. |
| HTTP request timeouts on slow 4K downloads | Fully **async job API**: `POST` → `jobId` → poll progress → download with HTTP Range support (resumable, scrub-able preview). |

## Deploy on Render (free)

1. Push this repo to your GitHub.
2. Render dashboard → **New +** → **Web Service** → connect the repo.
3. Runtime: **Docker** (auto-detected from `Dockerfile`). Plan: **Free**.
4. (Optional) `render.yaml` blueprint import does the same.
5. Deploy. First boot takes ~1 min (image pull + WARP registration).
6. Open the URL — paste a YouTube link, Analyze, pick quality (Auto = original best), set start/end, clip, download.

Verify health: `GET /healthz` → `{"ok":true,"warp":{"active":true},...}`

> **Free-hours math:** Render gives 750 instance-hours/month; a 31-day month is 744h — so a single 24x7 keep-alive service fits inside the free quota (barely). If you ever exceed it, the service pauses until the next month.

## Configuration (env vars)

| Env | Default | Purpose |
|---|---|---|
| `WARP` | `on` | Auto-register Cloudflare WARP + route yt-dlp through it. `off` = direct connections. |
| `PROXY_URL` | – | Your own `http://` or `socks5://` proxy. Takes priority over WARP. |
| `COOKIES` | – | Netscape `cookies.txt` content for age/member videos (WARP stays on). |
| `API_KEY` | – | If set, all POST + file endpoints require `X-Api-Key` header (recommended for public URLs). |
| `MAX_CLIP_SECONDS` | `600` | Max clip duration (10 min). |
| `MAX_CONCURRENT` | `1` | Parallel jobs. 1 is safest for 512MB. |
| `QUEUE_CAP` | `8` | Waiting queue depth. |
| `JOB_TTL_MIN` | `20` | Minutes before finished files are auto-deleted. |
| `SELF_PING` | `on` | Keep-alive self-ping every 9 min (uses `RENDER_EXTERNAL_URL`). |
| `YT_SELF_UPDATE` | `on` | Daily yt-dlp binary self-update. |
| `WARP_ENDPOINT` | `162.159.192.1:2408` | WARP peer endpoint (IP:port). |

## API

```
GET  /healthz               → {"ok":true,"ramMB":...,"warp":{...}}
GET  /api/capabilities      → {"maxClipSeconds":600,"authRequired":false}
POST /api/analyze {url}                      → {"jobId":"…"}
POST /api/clip {url,start,end,quality,title} → {"jobId":"…"}
     start/end: seconds ("90") or "1:30" / "1:02:03" — quality: "auto" or 2160|1440|1080|…
GET  /api/job/:id           → {status,progress,phase,result|error}
DELETE /api/job/:id         → cancel running job
GET  /file/:id              → the clip (Range supported)
GET  /file/:id?dl=1         → force download
```

All POST + `/file` routes require `X-Api-Key` when `API_KEY` env is set.

## Resource profile (512MB Render instance)

- Node server idle: **~45MB**
- wireproxy (WARP): **~35MB**
- yt-dlp mid-download: **~40MB**
- ffmpeg stream-copy merge: **~50MB**
- **Peak total: ~170MB** — comfortable 3x headroom.

Disk: files live in `/tmp/opal` (ephemeral), auto-deleted after 20 min. Nothing sensitive persists.

## Files

```
server.js          — the entire backend (zero dependencies)
public/index.html  — the entire frontend (vanilla JS, mobile-first)
Dockerfile         — node:24-slim + python3 + ffmpeg + yt-dlp + wireproxy + wgcf
render.yaml        — Render blueprint
```

## Notes & limits

- Clips are **keyframe-aligned** (fast, no re-encode): cut points may be off by up to ~2s.
- Formats are constrained to mp4/webm families so the merge is a pure **stream copy** — 4K VP9 clips land as `.webm` (plays everywhere on Android/Chrome; 1080p H.264 lands as `.mp4`).
- 10-min 4K clips can be 1–3GB; download time depends on YouTube throughput — the job runs asynchronously with live progress, so long jobs are fine.
- Use responsibly and respect content creators' rights and site terms.

## License

MIT
