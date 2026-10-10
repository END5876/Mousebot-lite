# Mousebot-lite

Mousebot 的精簡版，只保留兩個功能：

- **autojoin**：Bot 常駐在指定語音頻道，斷線自動重連（`/autojoin`）
- **音樂**：本地音樂庫＋ YouTube / Bilibili 點歌、播放清單、循環／隨機連播、控制面板（`/play`、`/music`）

`handlers/` 與 `utils/` 底下的檔案與正式版 [Mousebot](https://github.com/END5876/Mousebot) **逐字相同**，
只有 `index.js`、`package.json`、`Dockerfile`、`docker-entrypoint.sh` 是精簡版自己的。

## 專案結構

```
├── index.js                          # 入口（只載入 autojoin + 音樂）
├── handlers/
│   ├── autoJoinHandler.js            # /autojoin、斷線恢復
│   ├── audioManager.js               # 音訊層管理（靜音防踢 / 音樂）
│   └── musicplayer/                  # 音樂播放（線上 / 本地 / 佇列 / 快取 / 響度正規化）
├── utils/
│   ├── processGuards.js              # 全域錯誤處理、SIGTERM 正常關機
│   ├── config.js                     # 擁有者權限（OWNER_USER_ID）
│   ├── bootSummary.js / logger.js
├── data/                             # 執行時產生：設定檔、data/music 本地音樂庫與下載快取
├── Dockerfile
├── docker-entrypoint.sh              # 降權為 bot 帳號、自動重啟
└── .env.example
```

## 環境變數

複製 `.env.example` 成 `.env` 後填入，完整說明見該檔案。

| 變數 | 必填 | 說明 |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Discord Bot Token |
| `CLIENT_ID` | ✅ | Discord Application ID |
| `OWNER_USER_ID` | 建議 | 擁有者使用者 ID（逗號分隔多個）。未設定時沒有人能用 `/autojoin` 變更目標頻道 |
| `TARGET_VOICE_CHANNEL_ID` | | 第一次啟動時的 autojoin 目標頻道；之後以 `/autojoin` 設定（存在 `data/autojoin.json`）為準 |

Bot 需要在 Discord Developer Portal 開啟 **Server Members Intent**（不需要 Message Content Intent）。

## 用 Docker 跑（建議）

```bash
docker build -t mousebot-lite .
docker run -d --name mousebot-lite --env-file .env -v "$(pwd)/data:/app/data" mousebot-lite
```

映像檔已內建 ffmpeg、yt-dlp（每次建置都會抓最新版）與 bgutil PO Token Provider。

`docker-entrypoint.sh` 會：
- 把掛載的 `data/` 交給非 root 的 `bot` 帳號，Bot 與 bgutil 都以 `bot` 執行
- Bot 結束時 5 秒後自動重啟（`processGuards` 遇到未捕捉例外會主動結束，由這裡重新拉起）
- 啟動後 8 秒內就結束的情況連續 5 次，視為設定錯誤（例如 Token 無效），停止重試並讓容器結束
- `docker stop` 時把 SIGTERM 轉給 Bot，讓它關閉 Discord 連線、結束 yt-dlp 子程序後再退出

## 本機執行

需要 Node.js 22+、ffmpeg、yt-dlp（都要在 PATH 上）。

```bash
npm ci
cp .env.example .env
npm start
```

本機沒有自動重啟機制，建議在 `.env` 加上 `EXIT_ON_UNCAUGHT=0`，
讓未捕捉的例外只記錄、不結束程序。

## 本地音樂庫

把音檔（`.mp3` `.wav` `.ogg` `.flac` `.m4a` `.aac`，可放子資料夾）放進 `data/music/`，
`/music local list` 列出清單，`/play` 自動完成可以直接選歌。線上點歌下載的快取也存在這裡。

## 從正式版同步

`handlers/` 與 `utils/` 和正式版逐字相同，正式版更新後直接覆蓋即可。在正式版 repo 執行：

```bash
git archive HEAD handlers/musicplayer handlers/autoJoinHandler.js handlers/audioManager.js utils \
  | tar -x -C /path/to/Mousebot-lite
```

若正式版新增了這些模組會用到的 npm 套件，再同步更新 `package.json`。
