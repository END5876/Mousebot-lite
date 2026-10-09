# bgutil PO Token Provider：伺服器與 yt-dlp plugin 版本需一致
ARG BGUTIL_VERSION=2.0.2

# ── 建置 bgutil PO Token Provider HTTP 伺服器（git / devDependencies 只留在這個 stage）──
FROM node:22-slim AS bgutil-build
ARG BGUTIL_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --single-branch --branch ${BGUTIL_VERSION} \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /tmp/bgutil && \
    cd /tmp/bgutil/server && \
    npm ci --no-audit --no-fund && \
    npx tsc && \
    npm prune --omit=dev && \
    mkdir -p /opt/bgutil && cp -r build node_modules package.json /opt/bgutil/

FROM node:22-slim
ARG BGUTIL_VERSION

# ── 系統依賴：ffmpeg（音訊轉檔/正規化）＋ python3/pip（安裝 yt-dlp 用）──
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    libopus-dev \
    make \
    g++ \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── 安裝 yt-dlp（獨立虛擬環境，避免 break-system-packages 問題）──
# yt-dlp[default] 內含 yt-dlp-ejs（YouTube JS challenge 解題腳本）；
# bgutil-ytdlp-pot-provider 是 PO Token plugin，會向下方啟動的 HTTP 伺服器索取 token。
RUN python3 -m venv /opt/yt-dlp-env && \
    /opt/yt-dlp-env/bin/pip install --no-cache-dir "yt-dlp[default]" "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}"
ENV PATH="/opt/yt-dlp-env/bin:$PATH"

# ── bgutil PO Token Provider 伺服器（預設只監聽 127.0.0.1:4416，不對外開放）──
COPY --from=bgutil-build /opt/bgutil /opt/bgutil

WORKDIR /app

# ── 安裝 Node 套件 ──────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── 移除編譯工具（省空間） ──────────────────────────────
RUN apt-get purge -y make g++ && apt-get autoremove -y

# ── 複製專案檔案 ────────────────────────────────────────
COPY . .

# ── 啟動 ────────────────────────────────────────────────
# 沒有 supervisord：bgutil 伺服器放背景跑，掛掉就 5 秒後自動重啟；Bot 本身用 exec 當主程序。
RUN printf '#!/bin/sh\n\
(while true; do node /opt/bgutil/build/main.js; echo "[bgutil] 伺服器結束，5 秒後重啟" >&2; sleep 5; done) &\n\
exec node index.js\n\
' > /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]
