# Opal Clip Cloud ✂️

Lightweight self-hosted **video clipper** (YouTube + 1000+ sites) built to run **24x7 on Render's free tier** — 512MB RAM, no sleep, **speed-first renders**, with **video thumbnails**, a **360p YouTube preview embedded on every clip card (starting at your exact timestamp)** and **3-layer caching** so repeat traffic costs almost nothing. **Cutting is instant** — nothing is rendered until you actually click Download, and then the clip is produced **from your exact frame at the chosen quality** as a **frame-exact H.264 render**: frame #1 is a clean keyframe, so the downloaded clip **plays immediately with no frozen video at the start**.

Built for: lowest resource use, zero paid services, mobile-first **Opal Clipper** UI.

## Why it stays awake and cheap

| Problem on free hosting | How this repo solves it |
|---|---|
| Services sleep after 15 min idle | Built-in **self-ping**: the server pings its own `/healthz` every 9 minutes (inbound traffic resets the sleep timer). Optional: add a free UptimeRobot monitor as backup. |
| 512MB RAM limit | **Zero npm dependencies** — one plain Node.js file (~45MB RSS). Downloads fetch **only the seconds you selected**; the final render is a single ffmpeg x264 **`ultrafast`** pass (CRF 23) with a **resolution cap** and **cgroup-aware thread count**, plus a timeline-candidate retry ladder so a render can never come back empty or truncated. RAM stays well inside the budget, and everything is tunable via env vars. |
| Cut clips freeze at the start (video stuck, audio keeps playing) | That was the classic mid-GOP stream-copy problem — v2.6 **re-encodes every video clip at download time** so frame #1 is a fresh IDR keyframe at your exact timestamp (audio re-encoded to AAC too, `+faststart` MP4). Audio-only clips stay as the original remuxed track. |
| YouTube blocks datacenter IPs ("Sign in to confirm you're not a bot") | On boot the server auto-registers a **free Cloudflare WARP account** (via `wgcf`) and routes yt-dlp through a userspace **WireGuard tunnel** (`wireproxy`, SOCKS5 on localhost). Watchdog re-registers if the tunnel dies. You can instead supply `PROXY_URL` or `COOKIES`. |
| yt-dlp breakages over time | Built-in **daily self-update**: the server checks GitHub releases and swaps the yt-dlp binary at runtime. |
| HTTP request timeouts on slow 4K downloads | Fully **async job API**: `POST` → `jobId` → poll progress → download with HTTP Range support (resumable, scrub-able preview). |

## Deploy on Render (free)

1. Push this repo to your GitHub.
2. Render dashboard → **New +** → **Web Service** → connect the repo.
3. Runtime: **Docker** (auto-detected from `Dockerfile`). Plan: **Free**.
4. (Optional) `render.yaml` blueprint import does the same.
5. Deploy. First boot takes ~1 min (image pull + WARP registration).
6. Open the URL — paste a YouTube link, **Analyze** (real title/channel/duration load, **thumbnail shows in the video box**), type timestamps like `1:00 - 1:30` (one clip per line), **Cut clips** — the clip cards appear **instantly** (nothing is rendered yet), each with a **360p YouTube preview embedded right at your start timestamp**. When you click **Download** (single clip, or ZIP for all/selected), the clip is rendered **at that moment** from your exact frame at the **chosen quality** — a live progress bar runs inside the card, then the file downloads as a frame-exact H.264 MP4 that **plays instantly with no frozen start**.

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
| `PREROLL_SEC` | `4` | Extra seconds downloaded *before* your start timestamp — gives the encoder reference frames so the first rendered frame is exactly yours. |
| `MAX_RENDER_H` | `1080` | Height cap for renders. Above 1080p the free tier's 0.1 CPU makes re-encodes hopeless-slow and 512MB makes them OOM, so pixels above the cap are never even fetched. Raise it (e.g. `2160`) on a paid instance. |
| `YT_TIMEOUT_MIN` | `15` | Hard cap on one yt-dlp section download — a hung download must not jam the 1-slot queue. |
| `ENCODE_PRESET` | `ultrafast` | Override the x264 preset (`superfast`, `veryfast`, …). `ultrafast` is 3-5x faster than `veryfast` on the throttled CPU. |
| `ENCODE_CRF` | `23` | Override the quality. Lower = better/bigger. 23 is visually clean on a phone. |
| `ENCODE_THREADS` | auto | Cap encoder threads (auto: the **real cgroup CPU quota**, 1-4 — prevents thread thrash on the shared CPU). |
| `ENCODE_TIMEOUT_MIN` | `16` | Hard cap on a single render (matches the UI's 15-min wait). |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary path. |

## API

```
GET  /healthz               → {"ok":true,"ramMB":...,"warp":{...},"caches":{...},"version":"2.7.0"}
GET  /api/capabilities      → {"maxClipSeconds":600,"authRequired":false}
GET  /api/thumb/:videoId    → YouTube thumbnail JPEG (proxied, cached 24h in the browser)
POST /api/analyze {url}                      → {"jobId":"…"}
     result: {title,duration,uploader,height,tbr,heights[],max4k,thumbnail,id}
     id = YouTube video id (use it for /api/thumb/:id); repeat calls hit the cache instantly
POST /api/clip {url,start,end,title,quality} → {"jobId":"…"}
     start/end: seconds ("90") or "1:30" / "1:02:03"
     quality: omit (or "auto") = best video+audio (recommended), or a height like 480/1080/2160, or "audio"
     result: {file:{name,size,mime,url},video:{height,width,codec,ext,duration},clipped:{start,end},render:{mode,timeline,trimStart,want,preset,crf},cached?}
     video.duration is the REAL probed length of the produced clip (frame-exact ≈ your requested range)
POST /api/zip {ids:[clipJobId,…]}           → {"jobId":"…"}  (store-mode ZIP, ≤24 clips)
GET  /api/job/:id           → {status,progress,phase,result|error}
DELETE /api/job/:id         → cancel running job (kills yt-dlp / ffmpeg)
GET  /file/:id              → the clip/zip (Range supported — powers the preview scrubbing)
HEAD /file/:id              → existence + size check
GET  /file/:id?dl=1         → force download (Content-Disposition: attachment)
```

All POST + `/file` routes require `X-Api-Key` when `API_KEY` env is set. `/api/thumb/:id` stays public (it only fronts the public i.ytimg.com CDN with a strict id pattern).

## Resource profile (512MB Render instance)

- Node server idle: **~45MB**
- wireproxy (WARP): **~35MB**
- yt-dlp mid-download: **~40MB**
- ffmpeg render: **`ultrafast` + 1-4 threads + ≤1080p cap** keeps the encode around ~150-250MB peak — comfortably inside 512MB with the section download and tunnel also resident. A retry at 1 thread fires automatically if a pass still dies.

> **Free-tier CPU note:** Render free instances are CPU-throttled, so renders are slower there than on a full machine — v2.7's speed-first settings (`ultrafast`, cgroup-aware threads, 4s preroll, ≤1080p fetch cap, H.264-preferred source) cut the wall time several-fold vs v2.6; a ~30s clip at 360-1080p typically lands well under a couple of minutes even on the throttled CPU, and shorter/lower-quality clips are faster still. Job progress is live in the UI the whole time, clips are cached afterwards, and short clips are the sweet spot.

Disk: files live in `/tmp/opal` (ephemeral); finished jobs auto-delete after 20 min, while the **cache tree** (`/tmp/opal/cache`) holds thumbnails, analysis results and up to `CLIP_CACHE_MB` of popular clips for up to their TTLs. Nothing sensitive persists.

## Files

```
server.js          — the entire backend (zero dependencies)
public/index.html  — the entire frontend (vanilla JS, mobile-first)
Dockerfile         — node:24-slim + python3 + ffmpeg + yt-dlp + wireproxy + wgcf
render.yaml        — Render blueprint
```

## Notes & limits

- **Frame-exact renders (no more frozen starts):** every video clip is **re-encoded at download time** — H.264 + AAC in an MP4 with `+faststart`. Frame #1 is a clean IDR keyframe at your exact timestamp (a ~4s preroll is downloaded just to give the encoder reference frames), the duration matches your requested range to ~0.1s, and playback starts instantly. Output size depends on CRF (default 23).
- **Audio-only (`MP3` chip):** the **original audio track** is served remuxed (`.m4a`/`.opus`) — no video frames means no keyframe problem, so no re-encode is wasted on it.
- **Instant cut, lazy render:** the **Cut clips** step does no work at all — cards appear immediately with a **360p YouTube embed starting at your exact timestamp** (`start`/`end` pinned to your range). The actual download/render happens **only when you click Download**: the clip is fetched from the same timestamp at the chosen quality, with a live progress bar inside the card. Leaving the clips view cancels pending renders; the ZIP button renders all needed clips first ("Rendering 2/5…"), then streams them as one store-mode ZIP. Repeat downloads of the same range+quality replay instantly from the clip cache.
- Very long clips (near the 10-min cap) still take real time to render on the free tier — the job runs asynchronously with live progress, so long jobs are fine, but short clips are the sweet spot.
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
- **2.7** — **speed-first renders + empty-file-proof pipeline** (fixes "render is very slow" and "render produced an empty file" on Render's free tier): encoder switched to **`ultrafast` + CRF 23** for every resolution (veryfast measured minutes per short clip on the 0.1 shared CPU; ultrafast is 3-5x faster and its near-zero lookahead keeps RAM far from the OOM line), **threads now follow the real cgroup CPU quota** (1-4 — x264 no longer spawns a thread per visible host core and thrashes the quota), **preroll cut 15s → 4s** (less to download and decode before your first frame), **`MAX_RENDER_H` (default 1080) cap** — >1080p re-encodes were hopeless-slow and an OOM risk on 512MB, so pixels above the cap are never fetched and H.264 source formats are preferred over VP9/AV1 for 2-4x faster decode; the clip card honestly shows the real rendered height. The section→output **timeline mapping became a candidate ladder with a hard validation gate** (real duration + video stream + ≥25KB) — a wrong guess falls through to the next candidate (content → rebased → raw-offset → from-zero safe), so a render can never again exit 0 with a header-only MP4 (the "empty file" bug) or serve a truncated clip; video-less downloads now fail loudly instead of falling back to a frozen stream-copy remux; `/file` refuses <1KB outputs; yt-dlp/ffmpeg hard timeouts tightened (15/16 min) so one hung job can't jam the single worker slot; cache keys versioned `re2`.
- **2.6** — **no more frozen video at the start of downloaded clips** (the "video stuck 5–10s while audio plays" bug): clips are now **re-encoded at download time** instead of stream-copied — a stream-copy cut started mid-GOP, so the first frames referenced frames that were never downloaded and players froze until the next keyframe. The render is **frame-exact**: a preroll (`PREROLL_SEC`) is downloaded for reference frames, the section's timeline is probed (content-timestamps vs rebased), ffmpeg seeks to your exact frame and emits a fresh IDR keyframe + AAC audio + `+faststart` MP4. Preset ladder for the 512MB free tier (`ENCODE_PRESET`/`ENCODE_CRF`/`ENCODE_THREADS` to retune), OOM-safe retry, cancel kills the encoder, cache keys versioned so old stream-copy files never replay, UI render timeout raised to 15 min. E2E-verified: first packet is a keyframe, zero decoder errors, exact durations, PSNR 44.9 dB frame alignment vs source.
- **2.5** — **instant cut + preview on the download cards**: the cut step does zero work (cards appear immediately), every clip card embeds the 360p YouTube preview at the exact timestamp, and downloads render lazily per-card at click-time with in-card progress.
- **2.4** — **fastest analyze & cut**: paste auto-triggers analyze, the thumbnail shows instantly from the CDN while metadata loads, and repeat analyses/clips are served from cache in ~0s. **360p embedded preview during render** (accurate `start`/`end` timestamps, muted autoplay, live timestamp via the YouTube postMessage API, loops the range, follows the clip being cut). **Chosen-quality downloads render at download time**: quality chips now pick the real output height (lazy re-render on download, instant on cache replay); `MP3` chip maps to the original audio track (`quality:"audio"` in `/api/clip`). Audio-only clips get an inline audio player preview.
- **2.3** — **video thumbnails** in the info box (cached `/api/thumb/:id` proxy, 24h browser cache), **real embedded preview player** with native controls + accurate real timestamps (appears when clips are ready, not before), and **3-layer caching** (analyze metadata, clip files with instant replay + LRU/size caps, thumbnails) to keep server load flat. `video.duration` now returned with 0.1s precision.
- **2.2** — exact **Opal Clipper** UI wired to the real backend (real analyze/cut/progress/download), always-original-quality format chain, `/api/zip` (store-mode), real-bitrate size estimates, HEAD + TTL-refresh, WARP stale-account boot fix.
- **2.1** — frontend syntax fix (dead Analyze button), WARP endpoint rotation, cookies API.
- **2.0** — initial release.
