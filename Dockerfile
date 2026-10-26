# Opal Clip Cloud — Render free tier image (512MB RAM target)
FROM node:24-slim

# python3 (yt-dlp zipapp runtime) + ffmpeg (merge/probe) + curl (health checks)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-minimal ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp (self-updates daily at runtime) + WARP tunnel binaries for bot-wall bypass
ARG WIREPROXY_VERSION=1.1.3
ARG WGCF_VERSION=2.2.22
RUN curl -fsSL https://github.com/pufferffish/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_linux_amd64.tar.gz \
      | tar -xz -C /usr/local/bin wireproxy \
 && curl -fsSL -o /usr/local/bin/wgcf \
      "https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_amd64" \
 && chmod +x /usr/local/bin/wgcf \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && mkdir -p /tmp/opal /tmp/warp

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=10000 \
    WORK_DIR=/tmp/opal \
    WARP_DIR=/tmp/warp \
    WARP_BIN_DIR=/usr/local/bin \
    YTDLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 10000
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:10000/healthz || exit 1

CMD ["node", "server.js"]
