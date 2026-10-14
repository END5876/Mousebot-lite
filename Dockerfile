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

# ── 安裝 Node 套件（@discordjs/opus 沒有 prebuild 時需要的 make / g++ 只留在這個 stage）──
# 在獨立 stage 建置：編譯工具不會留在最終映像檔的任何一層裡。
FROM node:22-slim AS node-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
ARG BGUTIL_VERSION

# ── 系統依賴：ffmpeg（播放轉碼 / 響度正規化）＋ python3-venv（安裝 yt-dlp 用）──
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── 非 root 執行帳號（Bot 與 bgutil 都不需要 root 權限）─────
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin bot

# ── 安裝 yt-dlp（獨立虛擬環境，避免 break-system-packages 問題）──
# ADD 會檢查 PyPI JSON 是否變動；yt-dlp 發新版時下面的 RUN 快取就會失效，重新建置時拿到最新版。
# yt-dlp[default] 內含 yt-dlp-ejs（YouTube JS challenge 解題腳本）；
# bgutil-ytdlp-pot-provider 是 PO Token plugin，會向 entrypoint 啟動的 HTTP 伺服器索取 token。
RUN python3 -m venv /opt/yt-dlp-env
ENV PATH="/opt/yt-dlp-env/bin:$PATH"
ADD https://pypi.org/pypi/yt-dlp/json /tmp/yt-dlp-latest.json
RUN pip install --no-cache-dir -U "yt-dlp[default]" "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}" && \
    echo "yt-dlp version: $(yt-dlp --version)" && \
    rm -f /tmp/yt-dlp-latest.json

# ── bgutil PO Token Provider 伺服器（預設只監聽 127.0.0.1:4416，不對外開放）──
COPY --from=bgutil-build /opt/bgutil /opt/bgutil

WORKDIR /app

COPY --from=node-deps /app/node_modules ./node_modules
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ── 健康檢查 ────────────────────────────────────────────
# utils/health.js 在 127.0.0.1:${HEALTH_PORT:-3939}/healthz 回報 Discord 連線狀態（503 = 斷線超過寬限期）。
# start-period 涵蓋 yt-dlp / bgutil 檢查與 Discord 登入的時間。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3939)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/usr/local/bin/docker-entrypoint.sh"]
