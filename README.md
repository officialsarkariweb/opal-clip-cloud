# Opal Clip Cloud ✂️

Lightweight self-hosted **video clipper** (YouTube + 1000+ sites) built to run **24x7 on Render's free tier** — 512MB RAM, no sleep, **always original quality up to 4K** (pure stream copy, never re-encoded, never downgraded to a lower stream), with **video thumbnails**, a **real embedded preview player (accurate real timestamps)** and **3-layer caching** so repeat traffic costs almost nothing.

Built for: lowest resource use, zero paid services, mobile-first **Opal Clipper** UI.

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
6. Open the URL — paste a YouTube link, **Analyze** (real title/channel/duration load, **thumbnail shows in the video box**), type timestamps like `1:00 - 1:30` (one clip per line), **Cut clips** (live real progress), then **Download** individual clips or all as **ZIP** — always at the video's original quality. When clips are ready, each card shows a **real embedded video preview** (native player, true timeline + the clip's real probed duration and resolution).

Verify health: `GET /healthz` → `{"ok":true,"warp":{"active":true},...}`

> **Already deployed?** After pushing new code: Render dashboard → your service → **Manual Deploy → Deploy latest commit** (autoDeploy is off in `render.yaml`), then **hard-refresh** the page (Ctrl+Shift+R) to bust the 5-minute HTML cache.

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
| `QUEUE_CAP` | `24` | Waiting queue depth. |
| `JOB_TTL_MIN` | `20` | Minutes before finished files are auto-deleted (refreshed while a download is active). |
| `SELF_PING` | `on` | Keep-alive self-ping every 9 min (uses `RENDER_EXTERNAL_URL`). |
| `YT_SELF_UPDATE` | `on` | Daily yt-dlp binary self-update. |
| `WARP_ENDPOINT` | rotation list | WARP peer endpoints (IP:PORT, comma-separated, tried in rotation). |
| `ANALYZE_TTL_MIN` | `720` | How long analysis results (title/duration/formats/thumbnail) stay cached — repeat Analyze of the same video is instant. |
| `CLIP_TTL_MIN` | `360` | How long finished clip files stay cached for instant replay. |
| `CLIP_CACHE_MB` | `300` | Total disk budget for cached clips (LRU eviction when exceeded). |

## API

```
GET  /healthz               → {"ok":true,"ramMB":...,"warp":{...},"caches":{...},"version":"2.3.0"}
GET  /api/capabilities      → {"maxClipSeconds":600,"authRequired":false}
GET  /api/thumb/:videoId    → YouTube thumbnail JPEG (proxied, cached 24h in the browser)
POST /api/analyze {url}                      → {"jobId":"…"}
     result: {title,duration,uploader,height,tbr,heights[],max4k,thumbnail,id}
     id = YouTube video id (use it for /api/thumb/:id); repeat calls hit the cache instantly
POST /api/clip {url,start,end,title,quality} → {"jobId":"…"}
     start/end: seconds ("90") or "1:30" / "1:02:03"
     quality: omit (or "auto") = ALWAYS ORIGINAL best video+audio (recommended)
     result: {file:{name,size,mime,url},video:{height,width,codec,ext,duration},clipped:{start,end},cached?}
     video.duration is the REAL probed length of the produced clip (keyframe-aligned)
POST /api/zip {ids:[clipJobId,…]}           → {"jobId":"…"}  (store-mode ZIP, ≤24 clips)
GET  /api/job/:id           → {status,progress,phase,result|error}
DELETE /api/job/:id         → cancel running job
GET  /file/:id              → the clip/zip (Range supported — powers the preview scrubbing)
HEAD /file/:id              → existence + size check
GET  /file/:id?dl=1         → force download (Content-Disposition: attachment)
```

All POST + `/file` routes require `X-Api-Key` when `API_KEY` env is set. `/api/thumb/:id` stays public (it only fronts the public i.ytimg.com CDN with a strict id pattern).

## Resource profile (512MB Render instance)

- Node server idle: **~45MB**
- wireproxy (WARP): **~35MB**
- yt-dlp mid-download: **~40MB**
- ffmpeg stream-copy merge: **~50MB**
- **Peak total: ~170MB** — comfortable 3x headroom.

Disk: files live in `/tmp/opal` (ephemeral); finished jobs auto-delete after 20 min, while the **cache tree** (`/tmp/opal/cache`) holds thumbnails, analysis results and up to `CLIP_CACHE_MB` of popular clips for up to their TTLs. Nothing sensitive persists.

## Files

```
server.js          — the entire backend (zero dependencies)
public/index.html  — the entire frontend (vanilla JS, mobile-first)
Dockerfile         — node:24-slim + python3 + ffmpeg + yt-dlp + wireproxy + wgcf
render.yaml        — Render blueprint
```

## Notes & limits

- **Always original quality:** the format chain ranks purely by quality (`bestvideo*+bestaudio`) and merges with a stream-copy remux — the clip is the exact original stream (e.g. 4K VP9/AV1 + Opus lands as `.webm`, H.264+AAC lands as `.mp4`). The quality chips in the UI only drive the **size estimate**; downloads never drop to a lower stream. The chip matching the video's real quality is auto-selected after Analyze, and its size estimate uses the video's **real bitrate**.
- Clips are **keyframe-aligned** (fast, no re-encode): the real length of a clip can differ slightly from the requested range — the UI therefore shows the clip's **real probed duration** (`real 0:13`) next to the requested range, and the embedded preview's timeline is the true file timeline.
- 10-min 4K clips can be 1–3GB; download time depends on YouTube throughput — the job runs asynchronously with live progress, so long jobs are fine.
- Files auto-delete after 20 idle minutes; an active download keeps its file alive.
- Use responsibly and respect content creators' rights and site terms.

## License

MIT

## Troubleshooting

**Analyze shows an error / bot-check message**
- If the host blocks outbound UDP, the built-in WARP tunnel can't come up (check `/healthz` → `warp.active: false`). Fix: set the **`COOKIES` env var** in the Render dashboard to your YouTube `cookies.txt` content (export with the *Get cookies.txt LOCALLY* browser extension while logged in to youtube.com), or set `PROXY_URL`. Then redeploy.
- `WARP_ENDPOINT` env accepts a comma-separated list of `IP:PORT` endpoints (tried in rotation; default list included).
- After redeploying, **hard-refresh** the browser (Ctrl+Shift+R) — the old HTML can be cached for up to 5 minutes.

**Version history**
- **2.3** — **video thumbnails** in the info box (cached `/api/thumb/:id` proxy, 24h browser cache), **real embedded preview player** with native controls + accurate real timestamps (appears when clips are ready, not before), and **3-layer caching** (analyze metadata, clip files with instant replay + LRU/size caps, thumbnails) to keep server load flat. `video.duration` now returned with 0.1s precision.
- **2.2** — exact **Opal Clipper** UI wired to the real backend (real analyze/cut/progress/download), always-original-quality format chain, `/api/zip` (store-mode), real-bitrate size estimates, HEAD + TTL-refresh, WARP stale-account boot fix.
- **2.1** — frontend syntax fix (dead Analyze button), WARP endpoint rotation, cookies API.
- **2.0** — initial release.
