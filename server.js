#!/usr/bin/env node
'use strict';
/* ============================================================================
   Opal Clip Cloud — zero-dependency YouTube clipper built for Render free tier
   Target: 512MB RAM | 24x7 (self-ping) | up to 4K | stream-copy (NO re-encode)
   ============================================================================ */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const dnsPromises = require('dns').promises;

const startedAt = Date.now();

// ---------------------------- configuration ---------------------------------
const CFG = {
  port: Math.max(1, +(process.env.PORT || 10000)),
  ytdlpPath: process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  workDir: process.env.WORK_DIR || '/tmp/opal',
  warpDir: process.env.WARP_DIR || '/tmp/warp',
  warpBinDir: process.env.WARP_BIN_DIR || '/usr/local/bin',
  warp: (process.env.WARP || 'on') !== 'off',
  // Cloudflare WARP endpoint health varies over time — probe them in order
  // until one completes the WireGuard handshake and passes traffic.
  warpEndpoints: (process.env.WARP_ENDPOINT || '188.114.97.1:2408,162.159.192.1:2408,162.159.192.1:4500,162.159.193.10:2408,162.159.195.1:2408,188.114.96.1:2408,162.159.193.10:894,162.159.193.10:928,162.159.192.1:1701,162.159.195.2:2408')
    .split(',').map((s) => s.trim()).filter(Boolean),
  proxyUrl: process.env.PROXY_URL || '',        // user-supplied http/socks5 proxy
  cookies: (process.env.COOKIES || '').trim(), // raw Netscape cookies.txt content
  apiKey: (process.env.API_KEY || '').trim(),
  maxClipSeconds: Math.max(10, +(process.env.MAX_CLIP_SECONDS || 600)),
  maxQueue: Math.max(1, +(process.env.QUEUE_CAP || 24)),
  maxConcurrent: Math.max(1, +(process.env.MAX_CONCURRENT || 1)),
  jobTtlMs: Math.max(2, +(process.env.JOB_TTL_MIN || 20)) * 60 * 1000,
  selfPing: (process.env.SELF_PING || 'on') !== 'off',
  externalUrl: (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  selfUpdate: (process.env.YT_SELF_UPDATE || 'on') !== 'off',
  httpTimeoutMs: 25 * 1000,
};

const state = {
  internalProxy: '',          // socks5://127.0.0.1:1080 when WARP tunnel is up
  connectProxyUrl: '',        // http://127.0.0.1:8085 (in-process CONNECT proxy)
  cookiesFile: '',            // '/tmp/opal-cookies.txt' when cookies are active
  warpProc: null,
  warpLastReg: 0,
  warpError: '',              // last WARP boot failure reason (surfaced in /healthz)
  warpEndpointIndex: 0,       // rotate across candidate endpoints
  ytdlpVersion: '',
  bootReady: false,
};

// ---------------------------- small utilities -------------------------------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const logErr = (...a) => console.error(new Date().toISOString(), 'ERR', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isB64 = /^[A-Za-z0-9+/=]{20,}$/;

function parseTimeToSeconds(input) {
  if (typeof input === 'number' && isFinite(input)) return Math.max(0, input);
  const s = String(input || '').trim();
  if (!s) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.max(0, parseFloat(s));
  const parts = s.split(':').map((p) => parseFloat(p));
  if (parts.some((p) => isNaN(p))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function sanitizeFilename(name, fallback = 'clip') {
  let out = String(name || fallback)
    .normalize('NFKD').replace(/[^\w\s .()-]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 70);
  return out || fallback;
}

function humanRange(a, b) {
  const fmt = (sec) => {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  };
  return `${fmt(a)}-${fmt(b)}`;
}

// SSRF guard: reject private/loopback targets
async function assertSafeUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw httpErr(400, 'Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw httpErr(400, 'Only http(s) URLs are allowed');
  if (u.href.length > 2048) throw httpErr(400, 'URL too long');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blockedHost = /^(localhost|.*\.local|.*\.internal)$/i.test(host);
  if (blockedHost) throw httpErr(400, 'Hostname not allowed');
  const ipCache = {};
  const looksIp = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(host);
  let ips = [];
  if (looksIp) ips = [host];
  else {
    try {
      const res = await dnsPromises.lookup(host, { all: true, verbatim: true });
      ips = res.map((r) => r.address);
    } catch { /* DNS failure -> let yt-dlp report it */ }
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw httpErr(400, 'Target IP not allowed');
  }
  return u.href;
}

function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => isNaN(n))) return true;
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
  if (o[0] >= 224) return true;
  return false;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function safeJsonStr(obj) { return JSON.stringify(obj); }

// ---------------------------- job store + queue ------------------------------
const jobs = new Map();      // id -> job record
const queue = [];            // ids waiting
let runningCount = 0;
const childByJob = new Map();

function newJob(type, input) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const job = {
    id, type, status: 'queued', progress: 0, phase: 'queued',
    error: '', result: null, url: '', title: '', createdAt: Date.now(),
    startedAt: 0, doneAt: 0, logs: [], _input: input, _dir: '', _file: '',
  };
  jobs.set(id, job);
  queue.push(id);
  pumpQueue();
  return job;
}

function pumpQueue() {
  while (runningCount < CFG.maxConcurrent && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status === 'cancelled') continue;
    runningCount++;
    job.status = 'running';
    job.startedAt = Date.now();
    runJob(job).catch((err) => {
      if (job.status === 'running') {
        job.status = 'error';
        job.error = err && err.message ? err.message : String(err);
        job.doneAt = Date.now();
      }
    }).finally(() => {
      runningCount--;
      job.doneAt = job.doneAt || Date.now();
      if (job.status === 'running') { job.status = 'error'; job.error = 'Job ended unexpectedly'; }
      pumpQueue();
    });
  }
}

function jobLog(job, line) {
  job.logs.push(String(line).slice(0, 300));
  if (job.logs.length > 25) job.logs.shift();
}

function jobPublic(job) {
  const out = {
    id: job.id, type: job.type, status: job.status, progress: job.progress,
    phase: job.phase, error: job.error, createdAt: job.createdAt,
    startedAt: job.startedAt, doneAt: job.doneAt,
  };
  if (job.type === 'analyze' && job.status === 'done') out.result = job.result;
  if (job.type === 'clip' && job.status === 'done') {
    out.result = job.result; // includes {file:{name,size,mime,url}, video:{height,codec,duration}}
  }
  if (job.type === 'zip' && job.status === 'done') out.result = job.result;
  if (job.status === 'error' && job.logs.length) out.detail = job.logs.slice(-3);
  return out;
}

function cancelJob(job) {
  if (job.status === 'queued') { job.status = 'cancelled'; job.doneAt = Date.now(); return true; }
  if (job.status === 'running') {
    const child = childByJob.get(job.id);
    if (child) { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000); }
    job.status = 'cancelled'; job.doneAt = Date.now();
    return true;
  }
  return false;
}

async function cleanupJobFiles(job) {
  if (!job._dir) return;
  try { await fsp.rm(job._dir, { recursive: true, force: true }); } catch {}
}

// sweeper: TTL cleanup of files + stale jobs
setInterval(async () => {
  const now = Date.now();
  for (const job of jobs.values()) {
    const age = now - (job.lastAccess || job.doneAt || job.createdAt);
    if ((job.status === 'done' || job.status === 'error' || job.status === 'cancelled') && age > CFG.jobTtlMs) {
      await cleanupJobFiles(job);
      jobs.delete(job.id);
    }
  }
  // prune long-gone records (keep memory flat)
  if (jobs.size > 200) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, jobs.size - 200);
    for (const j of oldest) { await cleanupJobFiles(j); jobs.delete(j.id); }
  }
  // orphan dir cleanup
  try {
    const entries = await fsp.readdir(CFG.workDir);
    for (const e of entries) {
      const p = path.join(CFG.workDir, e);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > CFG.jobTtlMs + 5 * 60 * 1000) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  } catch {}
}, 60 * 1000).unref();

// ---------------------------- static asset (index.html) ---------------------
let assetHtml = Buffer.alloc(0);
let assetHtmlGz = Buffer.alloc(0);
let assetEtag = '';

async function loadAsset() {
  const p = path.join(__dirname, 'public', 'index.html');
  assetHtml = await fsp.readFile(p);
  assetHtmlGz = zlib.gzipSync(assetHtml, { level: 9 });
  assetEtag = '"' + crypto.createHash('sha1').update(assetHtml).digest('hex').slice(0, 16) + '"';
  log(`asset loaded: ${assetHtml.length}B (gzip ${assetHtmlGz.length}B)`);
}

function serveAsset(req, res) {
  if (req.headers['if-none-match'] === assetEtag) { res.writeHead(304); return res.end(); }
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = gz ? assetHtmlGz : assetHtml;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=300',
    'ETag': assetEtag,
    ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(body);
}

// ---------------------------- yt-dlp invocation ------------------------------
// Proxy strategy (env-based so BOTH yt-dlp AND ffmpeg route through the tunnel —
// googlevideo URLs are IP-locked, so the media fetch must use the same egress
// IP as the page extraction, otherwise ffmpeg gets 403):
//   WARP mode:  yt-dlp+ffmpeg -> http://127.0.0.1:8085 (in-process CONNECT proxy)
//               -> SOCKS5 127.0.0.1:1080 (wireproxy) -> Cloudflare WARP
//   PROXY_URL:  used directly as http_proxy env (http(s) proxies only)
function activeProxyEnv() {
  if (CFG.proxyUrl) {
    if (/^https?:\/\//i.test(CFG.proxyUrl)) {
      return { http_proxy: CFG.proxyUrl, https_proxy: CFG.proxyUrl, HTTP_PROXY: CFG.proxyUrl, HTTPS_PROXY: CFG.proxyUrl };
    }
    return {}; // socks proxies: passed via --proxy below (ffmpeg not covered)
  }
  if (state.connectProxyUrl) {
    return { http_proxy: state.connectProxyUrl, https_proxy: state.connectProxyUrl, HTTP_PROXY: state.connectProxyUrl, HTTPS_PROXY: state.connectProxyUrl };
  }
  return null;
}

// minimal SOCKS5 client (no-auth, remote DNS) -> tunnels through wireproxy
function socks5Connect(host, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: 1080, timeout: timeoutMs });
    const fail = (e) => { try { sock.destroy(); } catch {} reject(e); };
    sock.on('error', fail);
    sock.on('timeout', () => fail(new Error('socks5 connect timeout')));
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: no-auth
    });
    let stage = 0;
    sock.on('data', (d) => {
      if (stage === 0) {
        if (d.length < 2 || d[0] !== 0x05 || d[1] !== 0x00) return fail(new Error('socks5 auth rejected'));
        stage = 1;
        const hb = Buffer.from(host, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb,
          Buffer.from([Math.floor(port / 256), port % 256]),
        ]);
        sock.write(req);
      } else if (stage === 1) {
        if (d.length < 4 || d[0] !== 0x05 || d[1] !== 0x00) return fail(new Error('socks5 connect failed'));
        sock.removeAllListeners('data');
        sock.removeAllListeners('timeout');
        sock.setTimeout(0);
        resolve(sock); // raw tunnel socket
      }
    });
  });
}

// in-process HTTP CONNECT proxy: ffmpeg/yt-dlp -> (CONNECT) -> socks5 -> WARP
function startConnectProxy(listenPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((client) => {
      let headerBuf = Buffer.alloc(0);
      client.on('error', () => {});
      client.on('data', function onData(chunk) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (headerBuf.length > 8192) client.destroy();
          return;
        }
        client.removeListener('data', onData);
        const head = headerBuf.slice(0, idx).toString('latin1');
        const m = head.match(/^CONNECT\s+(\S+):(\d+)\s/i);
        if (!m) { client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n'); return; }
        const host = m[1], port = parseInt(m[2], 10);
        if (port !== 443 && port !== 80) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
        socks5Connect(host, port)
          .then((tun) => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            // any bytes received after the CONNECT head belong to the tunnel
            const rest = headerBuf.slice(idx + 4);
            if (rest.length) tun.write(rest);
            tun.pipe(client);
            client.pipe(tun);
            tun.on('error', () => { try { client.destroy(); } catch {} });
            client.on('close', () => { try { tun.destroy(); } catch {} });
            tun.on('close', () => { try { client.destroy(); } catch {} });
          })
          .catch(() => {
            try { client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch {}
          });
      });
    });
    srv.on('error', reject);
    srv.listen(listenPort, '127.0.0.1', () => resolve(srv));
  });
}

// yt-dlp --proxy flag. IMPORTANT: use the HTTP CONNECT proxy URL (not raw socks5)
// because yt-dlp forwards http(s) proxies to its ffmpeg subprocess (socks it
// does not) — and ffmpeg must fetch googlevideo via the same egress IP.
function activeProxy() {
  if (CFG.proxyUrl) return CFG.proxyUrl; // user proxy (http/socks; http covers ffmpeg)
  return state.connectProxyUrl || '';
}

function ytBaseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--newline', '--retries', '5',
    '--fragment-retries', '5', '--socket-timeout', '20'];
  const proxy = activeProxy();
  if (proxy) args.push('--proxy', proxy);
  if (state.cookiesFile) args.push('--cookies', state.cookiesFile);
  return args;
}

// format chain: ALWAYS the ORIGINAL quality — best video + best audio ranked
// purely by quality. The old container-first chain could silently cap quality
// (e.g. 4K VP9-only videos falling back to a 1080p MP4). yt-dlp merges with a
// pure stream-copy remux; --merge-output-format lets it pick the first container
// that can hold both streams (webm for vp9/av01+opus, mp4 for h264/aac) — never
// a re-encode, so the clip is byte-for-byte original quality (up to 4K).
function formatArgsFor(height) {
  const H = Math.min(2160, Math.max(144, height));
  const f = [
    `bestvideo*[height<=${H}]+bestaudio`,
    `best[height<=${H}]`,
    `bestvideo*+bestaudio`,
    `best`,
  ].join('/');
  return ['-f', f, '--merge-output-format', 'webm/mp4/mkv', '--concurrent-fragments', '4'];
}

function botWallHit(text) {
  return /sign in to confirm|not a bot|cookies for the authentication|http error 429/i.test(text);
}

function friendlyYtError(text) {
  if (botWallHit(text)) return 'YouTube blocked this server (bot check). Set the COOKIES env var (paste your cookies.txt content) or PROXY_URL, then redeploy.';;
  if (/video unavailable|private video|removed by the uploader/i.test(text)) return 'Video unavailable, private, or removed.';
  if (/members[- ]only|join this channel/i.test(text)) return 'Members-only video.';
  if (/age|sign in to confirm your age/i.test(text) && /confirm your age/i.test(text)) return 'Age-restricted video (needs cookies).';
  if (/geo|not available in your country/i.test(text)) return 'Geo-restricted video.';
  if (/unsupported url/i.test(text)) return 'Unsupported website. Paste a direct video page URL.';
  if (/is not a valid url/i.test(text)) return 'Invalid URL.';
  if (/timed out|temporary failure|connection reset|network/i.test(text)) return 'Network error while contacting the video site.';
  const line = text.split('\n').filter((l) => /error/i.test(l)).pop() || 'Download failed';
  return line.replace(/^ERROR:\s*/, '').slice(0, 200);
}

// run yt-dlp with retry ladder against bot-wall; resolves {code, stdout, stderr}
async function runYt(args, job, progressTo) {
  // first job waits for WARP boot (max ~45s) instead of failing on bot-wall
  if (state.warpBootPromise) {
    const p = state.warpBootPromise;
    state.warpBootPromise = null;
    if (job) { job.phase = 'warming up (proxy)'; }
    await p.catch(() => {});
  }
  const attempts = [
    args,
    [...args, '--extractor-args', 'youtube:player_client=tv'],
    [...args, '--extractor-args', 'youtube:player_client=android_vr'],
  ];
  let last = { code: 1, stdout: '', stderr: '' };
  for (let i = 0; i < attempts.length; i++) {
    if (job && job.status === 'cancelled') return { code: 130, stdout: '', stderr: 'cancelled' };
    if (i > 0 && job) { job.phase = `retry ${i}`; jobLog(job, `retrying with alternate player client (${i})`); }
    last = await execYt(attempts[i], job, i > 0 ? null : progressTo);
    const combined = last.stdout + last.stderr;
    if (last.code === 0) return last;
    if (!botWallHit(combined)) return last;
    if (job && job.progress > 5) return last; // already downloading — don't restart
  }
  return last;
}

function execYt(args, job, progressTo) {
  return new Promise((resolve) => {
    // env-based proxy: covers BOTH yt-dlp native downloads AND ffmpeg
    // (ffmpeg honors http_proxy env for https via HTTP CONNECT tunneling)
    const env = { ...process.env };
    const penv = activeProxyEnv();
    if (penv) Object.assign(env, penv);
    const child = spawn(CFG.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const chunksOut = [], chunksErr = [];
    child.stdout.on('data', (d) => {
      chunksOut.push(d); if (chunksOut.length > 400) chunksOut.shift();
      const text = d.toString();
      if (job && progressTo) {
        const m = text.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const pct = Math.min(90, (parseFloat(m[1]) / 100) * progressTo);
          if (pct > job.progress) { job.progress = pct; job.phase = 'downloading'; }
        }
        if (/Merging formats|Extracting audio|Postprocess/i.test(text)) {
          job.progress = Math.max(job.progress, progressTo * 0.97); job.phase = 'merging';
        }
      }
      if (job) { for (const line of text.split('\n')) if (line.trim()) jobLog(job, line); }
    });
    child.stderr.on('data', (d) => {
      chunksErr.push(d); if (chunksErr.length > 200) chunksErr.shift();
      if (job) { const t = d.toString(); for (const line of t.split('\n')) if (/error|warning/i.test(line)) jobLog(job, line); }
    });
    child.on('error', (e) => resolve({ code: 1, stdout: '', stderr: String(e.message) }));
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunksOut).toString(), stderr = Buffer.concat(chunksErr).toString();
      resolve({ code: code === null ? 1 : code, stdout, stderr });
    });
    if (job) childByJob.set(job.id, child);
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 55 * 60 * 1000);
    child.on('close', () => { clearTimeout(t); if (job) childByJob.delete(job.id); });
  });
}

// ---------------------------- analyze job ------------------------------------
async function jobAnalyze(job) {
  job.phase = 'analyzing';
  const { url } = job._input;
  const res = await runYt([...ytBaseArgs(), '-J', url], job, 0);
  const combined = res.stdout + res.stderr;
  if (res.code !== 0) throw httpErr(422, friendlyYtError(combined || `yt-dlp exited ${res.code}`));
  let info;
  try { info = JSON.parse(res.stdout); } catch { throw httpErr(422, 'Could not read video info (unexpected site response)'); }
  if (info.is_live) throw httpErr(422, 'Live streams cannot be clipped.');
  const heights = [...new Set((info.formats || [])
    .map((f) => f.height).filter((h) => h && h >= 100))].sort((a, b) => b - a);
  // best combined bitrate (top video + top audio) so the UI can show real sizes
  const bestV = (info.formats || [])
    .filter((f) => f.height && f.height >= 100 && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)))[0] || null;
  const bestA = (info.formats || [])
    .filter((f) => !f.height && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0] || null;
  const tbr = Math.round(((bestV && bestV.tbr) || 0) + ((bestA && bestA.tbr) || 0));
  job.result = {
    title: info.title || 'video',
    duration: info.duration || 0,
    uploader: info.uploader || info.channel || '',
    thumbnail: (info.thumbnails || []).length ? info.thumbnails[info.thumbnails.length - 1].url : '',
    heights: heights.slice(0, 12),
    max4k: heights.includes(2160),
    height: heights[0] || 0,
    tbr,
  };
  job.progress = 100; job.status = 'done';
}

// ---------------------------- clip job ---------------------------------------
async function jobClip(job) {
  const { url, start, end, height } = job._input;
  const dir = path.join(CFG.workDir, job.id);
  await fsp.mkdir(dir, { recursive: true });
  job._dir = dir;
  job.phase = 'downloading'; job.progress = 1;

  const outTpl = path.join(dir, 'clip.%(ext)s');
  const args = [
    ...ytBaseArgs(),
    '--download-sections', `*${start}-${end}`,
    // NOTE: no --force-keyframes-at-cuts — cuts stay keyframe-aligned so the
    // section download + merge are a pure stream-copy (fast, ~0 RAM overhead)
    ...formatArgsFor(height === 'auto' ? 2160 : height),
    '-o', outTpl,
    url,
  ];
  const res = await runYt(args, job, 90);
  const combined = res.stdout + res.stderr;
  if (res.code !== 0) throw httpErr(422, friendlyYtError(combined || `yt-dlp exited ${res.code}`));

  job.progress = 92; job.phase = 'finalizing';
  const files = (await fsp.readdir(dir)).filter((f) => f.startsWith('clip.'));
  if (!files.length) throw httpErr(422, 'Download finished but no output file was produced.');
  const file = path.join(dir, files[0]);
  const st = await fsp.stat(file);
  if (st.size < 1024) throw httpErr(422, 'Output file is empty.');
  job._file = file;
  job._dir = dir;

  job.progress = 96; job.phase = 'probing';
  const meta = await probeVideo(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'webm' ? 'video/webm' : (ext === 'mkv' ? 'video/x-matroska' : 'video/mp4');
  const name = `${sanitizeFilename(job.title || 'clip')} ${meta.height ? meta.height + 'p ' : ''}${humanRange(start, end)}.${ext === 'mkv' ? 'mkv' : ext}`;

  job.result = {
    file: { name, size: st.size, mime, url: `/file/${job.id}` },
    video: { height: meta.height, width: meta.width, codec: meta.codec, duration: meta.duration, ext },
    clipped: { start, end },
  };
  job.progress = 100; job.status = 'done';
}

function probeVideo(file) {
  return new Promise((resolve) => {
    const p = spawn(CFG.ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve({}));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
        resolve({
          height: v.height || 0, width: v.width || 0,
          codec: v.codec_name || '',
          duration: Math.round(parseFloat((j.format || {}).duration || v.duration || 0)),
        });
      } catch { resolve({}); }
    });
  });
}

// ---------------------------- zip job (store-only, zero deps) ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32Update(crc, buf) {
  let c = (crc ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function zipWrite(ws, buf) {
  return new Promise((resolve, reject) => ws.write(buf, (err) => (err ? reject(err) : resolve())));
}
const dosTime = (d) => ({
  time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31),
  date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
});

// store-only ZIP (method 0, no compression): clips are already compressed, so
// this costs ~zero CPU and streams chunk-by-chunk — RAM stays flat on 512MB.
async function zipStore(outPath, entries, onProgress) {
  const sizes = await Promise.all(entries.map((e) => fsp.stat(e.path).then((s) => s.size)));
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const ws = fs.createWriteStream(outPath);
  ws.on('error', () => {}); // surfaced via write/end callbacks
  const central = [];
  let offset = 0;
  let written = 0;
  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const size = sizes[i];
      const nameBuf = Buffer.from(e.name, 'utf8');
      const { time, date } = dosTime(new Date());
      let crc = 0;
      for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) crc = crc32Update(crc, chunk);
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);            // version needed
      lfh.writeUInt16LE(0x0800, 6);        // flags: UTF-8 filename
      lfh.writeUInt16LE(0, 8);             // method: store
      lfh.writeUInt16LE(time, 10);
      lfh.writeUInt16LE(date, 12);
      lfh.writeUInt32LE(crc >>> 0, 14);
      lfh.writeUInt32LE(size, 18);
      lfh.writeUInt32LE(size, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28);
      await zipWrite(ws, Buffer.concat([lfh, nameBuf]));
      for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) {
        written += chunk.length;
        if (onProgress) onProgress(Math.min(0.999, written / total));
        await zipWrite(ws, chunk);
      }
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4);            // version made by
      cdh.writeUInt16LE(20, 6);            // version needed
      cdh.writeUInt16LE(0x0800, 8);
      cdh.writeUInt16LE(0, 10);            // method: store
      cdh.writeUInt16LE(time, 12);
      cdh.writeUInt16LE(date, 14);
      cdh.writeUInt32LE(crc >>> 0, 16);
      cdh.writeUInt32LE(size, 20);
      cdh.writeUInt32LE(size, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt16LE(0, 30);            // extra len
      cdh.writeUInt16LE(0, 32);            // comment len
      cdh.writeUInt16LE(0, 34);            // disk number
      cdh.writeUInt16LE(0, 36);            // internal attrs
      cdh.writeUInt32LE(0, 38);            // external attrs
      cdh.writeUInt32LE(offset, 42);       // local header offset
      central.push(Buffer.concat([cdh, nameBuf]));
      offset += 30 + nameBuf.length + size;
    }
    const cdBuf = Buffer.concat(central);
    await zipWrite(ws, cdBuf);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);        // central dir offset
    eocd.writeUInt16LE(0, 20);
    await zipWrite(ws, eocd);
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    try { ws.destroy(); } catch {}
    throw e;
  }
}

async function jobZip(job) {
  const ids = [...new Set((Array.isArray(job._input.ids) ? job._input.ids : []).map(String))].slice(0, 24);
  if (!ids.length) throw httpErr(400, 'Missing "ids" (clip job ids) in body');
  const entries = [];
  let total = 0;
  for (const id of ids) {
    const j = jobs.get(id);
    if (!j || j.type !== 'clip' || j.status !== 'done' || !j.result || !j.result.file) {
      throw httpErr(404, 'A clip is not ready or has expired — cut the clips again');
    }
    const st = await fsp.stat(j._file).catch(() => null);
    if (!st || !st.isFile()) throw httpErr(404, 'A clip file has expired — cut the clips again');
    total += st.size;
    entries.push({ path: j._file, name: j.result.file.name });
  }
  if (total > 400 * 1024 * 1024) throw httpErr(413, 'Clips too large for one ZIP — download them individually');
  const dir = path.join(CFG.workDir, job.id);
  await fsp.mkdir(dir, { recursive: true });
  job._dir = dir;
  job.phase = 'zipping'; job.progress = 10;
  const out = path.join(dir, 'clips.zip');
  await zipStore(out, entries, (p) => { job.progress = 10 + Math.round(p * 85); });
  const st = await fsp.stat(out);
  job._file = out;
  job.result = {
    file: { name: 'opal-clips.zip', size: st.size, mime: 'application/zip', url: `/file/${job.id}` },
    clips: entries.length,
  };
  job.progress = 100; job.status = 'done';
}

async function runJob(job) {
  if (job.type === 'analyze') return jobAnalyze(job);
  if (job.type === 'clip') return jobClip(job);
  if (job.type === 'zip') return jobZip(job);
  throw httpErr(400, 'Unknown job type');
}

// ---------------------------- WARP tunnel (bot-wall bypass) -------------------
async function warpBoot() {
  if (!CFG.warp) { log('WARP disabled via env'); return; }
  if (CFG.proxyUrl) { log('PROXY_URL set — skipping WARP'); return; }
  try {
    await fsp.mkdir(CFG.warpDir, { recursive: true });
    await startWarpTunnel(true);
    state.internalProxy = 'socks5://127.0.0.1:1080';
    // CONNECT proxy lets ffmpeg (no socks support) use the tunnel via env vars
    await startConnectProxy(8085);
    state.connectProxyUrl = 'http://127.0.0.1:8085';
    state.warpError = '';
    log('WARP tunnel ACTIVE — yt-dlp + ffmpeg route through it');
  } catch (e) {
    logErr('WARP boot failed (continuing direct):', e.message);
    state.internalProxy = '';
    state.connectProxyUrl = '';
    state.warpError = e.message;
  }
}

async function startWarpTunnel(fresh) {
  const confPath = path.join(CFG.warpDir, 'wireproxy.conf');
  const accountPath = path.join(CFG.warpDir, 'wgcf-account.toml');
  const profilePath = path.join(CFG.warpDir, 'wgcf-profile.conf');

  if (fresh) {
    // wgcf register aborts if an account file already exists (happens after an
    // in-place restart leaves /tmp behind) — clear stale state first
    await fsp.rm(accountPath, { force: true }).catch(() => {});
    await fsp.rm(profilePath, { force: true }).catch(() => {});
  }
  if (fresh || !(await fsp.stat(accountPath).catch(() => null))) {
    // register a brand-new WARP identity (free, no signup)
    await run('wgcf', ['register', '--accept-tos'], CFG.warpDir, 40 * 1000);
    await run('wgcf', ['generate'], CFG.warpDir, 30 * 1000);
    state.warpLastReg = Date.now();
  }
  const profile = await fsp.readFile(profilePath, 'utf8');
  const priv = profile.match(/^PrivateKey\s*=\s*(\S+)/m);
  const addrs = [...profile.matchAll(/^Address\s*=\s*(\S+)/gm)].map((m) => m[1]);
  if (!priv || !addrs.length) throw new Error('could not parse wgcf profile');

  // probe candidate endpoints in rotation until one passes traffic
  // (endpoint health varies over time — a single hardcode is not reliable)
  const eps = CFG.warpEndpoints;
  const first = state.warpEndpointIndex % eps.length;
  let lastErr = '';
  for (let k = 0; k < Math.min(eps.length, 4); k++) {
    const endpoint = eps[(first + k) % eps.length];
    state.warpEndpointIndex = (first + k + 1) % eps.length;
    const conf = [
      '# auto-generated by opal-clip-cloud',
      '[Interface]',
      `PrivateKey = ${priv[1]}`,
      ...addrs.map((a) => `Address = ${a}`),
      'DNS = 1.1.1.1',
      'MTU = 1280',
      '[Socks5]',
      'BindAddress = 127.0.0.1:1080',
      '[Peer]',
      'PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
      'AllowedIPs = 0.0.0.0/0',
      'AllowedIPs = ::/0',
      `Endpoint = ${endpoint}`,
      'PersistentKeepalive = 25',
      '',
    ].join('\n');
    await fsp.writeFile(confPath, conf);
    await spawnWireproxy(confPath);
    // deadline-based health wait: SOCKS port + real traffic check (fail fast)
    const deadline = Date.now() + 20 * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (await portOpen(1080)) {
        const code = await curlSocksCheck();
        if (code >= 200 && code < 400) {
          log(`WARP endpoint OK: ${endpoint}`);
          return true;
        }
      }
    }
    lastErr = `endpoint ${endpoint} failed handshake`;
    log(`WARP endpoint failed, rotating: ${endpoint}`);
    try { if (state.warpProc) state.warpProc.kill('SIGKILL'); } catch {}
  }
  throw new Error(`no working WARP endpoint (tried ${Math.min(eps.length, 4)}; host may block UDP) — ${lastErr}`);
}

function curlSocksCheck() {
  return new Promise((resolve) => {
    const p = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12',
      '--proxy', 'socks5h://127.0.0.1:1080', 'https://www.youtube.com/generate_204']);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(parseInt(out.trim(), 10) || 0));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 15 * 1000);
  });
}

async function spawnWireproxy(confPath) {
  if (state.warpProc) { try { state.warpProc.kill('SIGKILL'); } catch {} }
  const bin = path.join(CFG.warpBinDir, 'wireproxy');
  const child = spawn(bin, ['-c', confPath], { stdio: 'ignore', detached: false });
  state.warpProc = child;
  child.unref();
  child.on('exit', () => { if (state.warpProc === child) state.warpProc = null; });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1', timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

function run(bin, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(CFG.warpBinDir, bin), args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${bin} timed out`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.slice(-200)}`)); });
  });
}

// WARP watchdog: keep tunnel alive; re-register when unhealthy;
// also RETRY failed boots (endpoints recover over time / transient network)
let warpFailStreak = 0;
setInterval(async () => {
  if (CFG.proxyUrl) return;
  // boot-time failure retry path (every ~7 min)
  if (!state.internalProxy) {
    if (!CFG.warp || state.warpRetryBusy) return;
    state.warpRetryBusy = true;
    try {
      await startWarpTunnel(false);
      await startConnectProxy(8085);
      state.internalProxy = 'socks5://127.0.0.1:1080';
      state.connectProxyUrl = 'http://127.0.0.1:8085';
      state.warpError = '';
      log('WARP retry: tunnel ACTIVE');
    } catch (e) {
      state.warpError = e.message;
    } finally { state.warpRetryBusy = false; }
    return;
  }
  const ok = await portOpen(1080);
  if (ok) { warpFailStreak = 0; return; }
  warpFailStreak++;
  log(`WARP watchdog: tunnel down (streak ${warpFailStreak})`);
  if (warpFailStreak >= 2) {
    try {
      if (Date.now() - state.warpLastReg < 5 * 60 * 1000) {
        await spawnWireproxy(path.join(CFG.warpDir, 'wireproxy.conf'));
        await sleep(3000);
        if (await portOpen(1080)) { log('WARP watchdog: respawned'); warpFailStreak = 0; return; }
      }
      await startWarpTunnel(true);
      log('WARP watchdog: tunnel restored (fresh registration)');
      warpFailStreak = 0;
    } catch (e) { logErr('WARP watchdog restore failed:', e.message); state.warpError = e.message; }
  }
}, 7 * 60 * 1000).unref();

// ---------------------------- fetch helper (self-checks) ---------------------
function fetchWithTimeout(url, { timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(url, { signal: ctl.signal, redirect: 'manual' }).finally(() => clearTimeout(t));
}

// ---------------------------- anti-sleep self-ping ---------------------------
if (CFG.selfPing && CFG.externalUrl) {
  setInterval(async () => {
    try {
      const r = await fetchWithTimeout(`${CFG.externalUrl}/healthz?t=selfping`, { timeoutMs: 20000 });
      log(`self-ping -> ${r.status}`);
    } catch (e) { logErr('self-ping failed:', e.message); }
  }, 9 * 60 * 1000).unref();
  setTimeout(async () => {
    try { await fetchWithTimeout(`${CFG.externalUrl}/healthz?t=bootping`, { timeoutMs: 20000 }); } catch {}
  }, 60 * 1000).unref();
}

// ---------------------------- yt-dlp daily self-update -----------------------
async function ytdlpSelfUpdate() {
  if (!CFG.selfUpdate) return;
  try {
    const cur = await ytdlpVersion();
    const rel = await (await fetchWithTimeout('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { timeoutMs: 15000 })).json();
    const latest = String(rel.tag_name || '').trim();
    if (latest && cur && latest !== cur) {
      log(`yt-dlp self-update: ${cur} -> ${latest}`);
      const tmp = CFG.ytdlpPath + '.new';
      const r = await fetchWithTimeout('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', { timeoutMs: 120000 });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 1000000 && buf[0] === 0x50 && buf[1] === 0x4b) { // valid zipapp
        await fsp.writeFile(tmp, buf, { mode: 0o755 });
        await fsp.rename(tmp, CFG.ytdlpPath);
        state.ytdlpVersion = latest;
        log('yt-dlp updated');
      } else { logErr('yt-dlp update rejected (invalid payload)'); }
    }
  } catch (e) { logErr('yt-dlp self-update check failed:', e.message); }
}

function ytdlpVersion() {
  return new Promise((resolve) => {
    const p = spawn(CFG.ytdlpPath, ['--version']);
    let v = '';
    p.stdout.on('data', (d) => { v += d.toString(); });
    p.on('error', () => resolve(''));
    p.on('close', () => { state.ytdlpVersion = v.trim(); resolve(v.trim()); });
  });
}
if (CFG.selfUpdate) {
  setTimeout(ytdlpSelfUpdate, 5 * 60 * 1000).unref();
  setInterval(ytdlpSelfUpdate, 24 * 60 * 60 * 1000).unref();
}

// ---------------------------- HTTP layer -------------------------------------
const MAX_BODY = 16 * 1024;

function readJsonBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) { reject(httpErr(413, 'Body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(httpErr(400, 'Invalid JSON body')); }
    });
    req.on('error', () => reject(httpErr(400, 'Body read error')));
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function authOk(req) {
  if (!CFG.apiKey) return true;
  return req.headers['x-api-key'] === CFG.apiKey;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // health: never fails (Render health check + self-ping target)
    if (p === '/healthz') {
      return sendJson(res, 200, {
        ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        ramMB: Math.round(process.memoryUsage().rss / 1048576),
        jobs: { running: runningCount, queued: queue.length },
        warp: { enabled: CFG.warp, active: !!state.connectProxyUrl, error: state.warpError.slice(0, 140) },
        cookies: !!state.cookiesFile,
        ytdlp: state.ytdlpVersion || '', version: '2.2.0',
      });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveAsset(req, res);

    if (p === '/api/capabilities' && req.method === 'GET') {
      return sendJson(res, 200, {
        maxClipSeconds: CFG.maxClipSeconds,
        authRequired: !!CFG.apiKey,
        version: '2.2.0',
      });
    }

    if (p.startsWith('/api/')) {
      if (!authOk(req)) throw httpErr(401, 'Invalid or missing X-Api-Key header');

      // cookies management (fixes bot-wall on hosts where the WARP UDP tunnel
      // can't come up — e.g. platforms that block outbound UDP)
      if (p === '/api/cookies') {
        const file = '/tmp/opal-cookies.txt';
        if (req.method === 'POST') {
          const body = await readJsonBody(req, 512 * 1024);
          const raw = String(body.cookies || '').replace(/\\n/g, '\n').trim();
          const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
          const looksNetscape = lines.length >= 3 && lines.every((l) => (l.match(/\t/g) || []).length >= 6);
          if (!looksNetscape) throw httpErr(400, 'That does not look like Netscape cookies.txt content (need 3+ lines with 7 tab-separated fields). Re-export from the browser extension.');
          await fsp.writeFile(file, raw + '\n', { mode: 0o600 });
          state.cookiesFile = file;
          log(`cookies installed (${lines.length} lines)`);
          return sendJson(res, 200, { ok: true, lines: lines.length });
        }
        if (req.method === 'DELETE') {
          state.cookiesFile = '';
          await fsp.rm(file, { force: true }).catch(() => {});
          log('cookies removed');
          return sendJson(res, 200, { ok: true, lines: 0 });
        }
        throw httpErr(405, 'Method not allowed');
      }

      if (p === '/api/analyze' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.url) throw httpErr(400, 'Missing "url" in body');
        const safeUrl = await assertSafeUrl(body.url);
        if (queue.length + runningCount >= CFG.maxQueue) throw httpErr(429, 'Server busy — try again shortly');
        const job = newJob('analyze', { url: safeUrl });
        return sendJson(res, 202, { jobId: job.id, status: job.status });
      }

      if (p === '/api/clip' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.url) throw httpErr(400, 'Missing "url" in body');
        const safeUrl = await assertSafeUrl(body.url);
        const start = parseTimeToSeconds(body.start ?? 0);
        const end = parseTimeToSeconds(body.end ?? 0);
        if (isNaN(start) || isNaN(end)) throw httpErr(400, 'Invalid start/end time (use seconds or MM:SS)');
        if (end <= start) throw httpErr(400, 'End time must be after start time');
        if (end - start > CFG.maxClipSeconds) throw httpErr(400, `Clip too long — max ${Math.round(CFG.maxClipSeconds / 60)} minutes`);
        if (end - start < 1) throw httpErr(400, 'Clip must be at least 1 second');
        let height = 'auto';
        if (body.quality && body.quality !== 'auto') {
          height = parseInt(body.quality, 10);
          if (!(height >= 144 && height <= 2160)) throw httpErr(400, 'quality must be "auto" or a height like 2160');
        }
        if (queue.length + runningCount >= CFG.maxQueue) throw httpErr(429, 'Server busy — try again shortly');
        const job = newJob('clip', { url: safeUrl, start, end, height });
        job.title = sanitizeFilename(body.title || '', 'clip');
        return sendJson(res, 202, { jobId: job.id, status: job.status });
      }

      if (p === '/api/zip' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.ids) || !body.ids.length) throw httpErr(400, 'Missing "ids" array (clip job ids) in body');
        if (body.ids.length > 24) throw httpErr(400, 'Too many clips for one ZIP (max 24)');
        if (queue.length + runningCount >= CFG.maxQueue) throw httpErr(429, 'Server busy — try again shortly');
        const job = newJob('zip', { ids: body.ids.map((x) => String(x)) });
        return sendJson(res, 202, { jobId: job.id, status: job.status });
      }

      const mJob = p.match(/^\/api\/job\/([a-z0-9]+)$/i);
      if (mJob) {
        const job = jobs.get(mJob[1]);
        if (!job) throw httpErr(404, 'Job not found (it may have expired)');
        if (req.method === 'GET') return sendJson(res, 200, jobPublic(job));
        if (req.method === 'DELETE') { cancelJob(job); return sendJson(res, 200, { cancelled: true, status: job.status }); }
        throw httpErr(405, 'Method not allowed');
      }

      throw httpErr(404, 'Not found');
    }

    const mFile = p.match(/^\/file\/([a-z0-9]+)$/i);
    if (mFile && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!authOk(req)) throw httpErr(401, 'Invalid or missing X-Api-Key header');
      const job = jobs.get(mFile[1]);
      if (!job || (job.type !== 'clip' && job.type !== 'zip')) throw httpErr(404, 'File not found (job may have expired)');
      if (job.status !== 'done' || !job.result || !job.result.file) throw httpErr(409, `Job is ${job.status} — file not ready`);
      return serveFile(req, res, job);
    }

    throw httpErr(404, 'Not found');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logErr('REQ FAIL', req.method, p, e.message);
    sendJson(res, status, { error: e.message || 'Internal error' });
  }
});

// Range-aware file serving (video preview scrubbing + resumable downloads)
function serveFile(req, res, job) {
  const f = job.result.file;
  const filePath = job._file;
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'File missing (expired)' });
    const size = st.size;
    // keep the file alive while it is actively downloaded / previewed
    job.lastAccess = Date.now();
    fsp.utimes(filePath, new Date(), new Date()).catch(() => {});
    const range = String(req.headers.range || '');
    const headersBase = {
      'Content-Type': f.mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${(req.url || '').includes('dl=1') ? 'attachment' : 'inline'}; filename="${f.name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, max-age=600',
    };
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] === '' ? undefined : parseInt(m[1], 10);
      let end = m[2] === '' ? undefined : parseInt(m[2], 10);
      if (start === undefined && end !== undefined) { start = Math.max(0, size - end); end = size - 1; } // suffix
      if (start === undefined) start = 0;
      if (end === undefined || end >= size) end = size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headersBase,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      stream.on('error', () => { try { res.destroy(); } catch {} });
    } else {
      res.writeHead(200, { ...headersBase, 'Content-Length': size });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', () => { try { res.destroy(); } catch {} });
    }
  });
}

// ---------------------------- boot -------------------------------------------
(async () => {
  await fsp.mkdir(CFG.workDir, { recursive: true });
  if (CFG.cookies) {
    await fsp.writeFile('/tmp/opal-cookies.txt', CFG.cookies.replace(/\\n/g, '\n'), { mode: 0o600 });
    state.cookiesFile = '/tmp/opal-cookies.txt';
    log('cookies file written');
  }
  await loadAsset();
  await ytdlpVersion();
  log(`yt-dlp ${state.ytdlpVersion} at ${CFG.ytdlpPath}`);

  server.listen(CFG.port, '0.0.0.0', () => {
    log(`opal-clip-cloud listening on :${CFG.port} (ram ${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
    state.bootReady = true;
  });

  // WARP in background so listen() is never delayed (Render health check!)
  state.warpBootPromise = warpBoot();
  state.warpBootPromise.catch((e) => logErr('warpBoot crashed:', e.message));
})();

process.on('SIGTERM', () => { log('SIGTERM — shutting down'); if (state.warpProc) try { state.warpProc.kill(); } catch {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
process.on('unhandledRejection', (e) => logErr('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => logErr('uncaughtException:', e && e.message));
