FROM node:22-slim

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
RUN python3 -m venv /opt/yt-dlp-env && \
    /opt/yt-dlp-env/bin/pip install --no-cache-dir yt-dlp
ENV PATH="/opt/yt-dlp-env/bin:$PATH"

WORKDIR /app

# ── 安裝 Node 套件 ──────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── 移除編譯工具（省空間） ──────────────────────────────
RUN apt-get purge -y make g++ && apt-get autoremove -y

# ── 複製專案檔案 ────────────────────────────────────────
COPY . .

CMD ["node", "index.js"]
