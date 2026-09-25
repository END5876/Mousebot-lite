# Mousebot Lite（縮減版）

從 [END5876/Mousebot](https://github.com/END5876/Mousebot) 抽取出來的縮減版，
**只保留兩個功能**：

- 🔊 **autojoin**：Bot 開機後自動加入並常駐指定語音頻道，掉線自動重連，閒置過久自動停止播放（`/autojoin` 指令可開關）
- 🎵 **music**：`/music` 點歌指令（YouTube / Bilibili 線上音源 + 本機音樂庫），播放佇列、循環、控制面板都保留

移除的部分：分帳系統（splitbill + webUI）、AI 聊天、TTS/STT、語音喚醒詞（openwakeword）伺服器、公告系統等，
所以不需要 Python OWW 環境、Express 網頁介面、Gemini/Groq API 金鑰。

## 目錄結構

```
mousebot-lite/
├── index.js                          # 進入點（只註冊 autojoin + music）
├── handlers/
│   ├── autoJoinHandler.js            # /autojoin 指令 + 自動加入/重連邏輯
│   ├── audioManager.js               # 音訊層級仲裁（避免多來源搶 connection）
│   └── musicplayer/
│       ├── unifiedQueue/             # /music 指令、播放佇列、搜尋
│       ├── onlineMusicHandler.js     # yt-dlp 線上音源引擎
│       ├── localMusicHandler.js      # 本機音樂庫引擎
│       ├── musicCache.js             # 已下載音檔快取
│       ├── musicNormalizer.js        # ffmpeg 響度正規化
│       ├── musicAntiBot.js           # yt-dlp cookies 反機器人偵測
│       └── voiceActivityMonitor.js   # 頻道閒置偵測（autojoin 常駐監控共用）
├── utils/
│   ├── logger.js
│   └── bootSummary.js
├── data/music/                       # 本機音樂庫 + 下載快取存放處
├── package.json
├── Dockerfile
└── .env.example
```

## 需要的環境變數（`.env`）

複製 `.env.example` 成 `.env` 並填入：

| 變數 | 說明 |
|---|---|
| `DISCORD_TOKEN` | Discord Bot Token |
| `CLIENT_ID` | Discord Application ID |
| `TARGET_VOICE_CHANNEL_ID` | autojoin 要常駐的語音頻道 ID（不設定的話 autojoin 功能會停用，但 music 仍可用） |

## 系統依賴

- Node.js 22+
- **ffmpeg**（音樂播放轉碼 + 響度正規化必要）
- **yt-dlp**（線上音源必要；`pip install yt-dlp` 或系統套件皆可，只要 `yt-dlp` 在 PATH 上）

本機安裝範例（Debian/Ubuntu）：
```bash
sudo apt install -y ffmpeg python3-pip
pip install --user yt-dlp
```

## 安裝與啟動

```bash
npm install
cp .env.example .env   # 填好 DISCORD_TOKEN / CLIENT_ID / TARGET_VOICE_CHANNEL_ID
npm start
```

> `@discordjs/opus` 是原生模組，`npm install` 時會抓 prebuild 二進位檔；
> 若你的平台沒有現成 prebuild，需要本機有 `make`/`g++`/Python 才能 fallback 編譯
> （這點跟原始 Mousebot 專案一致）。

## 用 Docker 跑

```bash
docker build -t mousebot-lite .
docker run --env-file .env -v $(pwd)/data:/app/data mousebot-lite
```

Dockerfile 已經內建 ffmpeg 與 yt-dlp（裝在獨立 venv，不影響系統 Python），
比原本 Mousebot 的 Dockerfile 輕量很多 —— 拿掉了 OWW 喚醒詞模型下載與 supervisord。

## 本機音樂庫

把音檔放進 `data/music/`（支援的格式跟原本 `localMusicHandler.js` 邏輯一致），
`/music local list` 即可列出、`/music` 搜尋可切換本機/線上音源。

## 與原專案的差異

- `index.js` 只 `require` autojoin + music 三個模組，其餘（splitbill、ai、notice、voiceHandler、webui）完全沒有複製過來
- `package.json` 依賴從原本 16 個套件砍到 6 個（拿掉 express、axios、sharp、groq-sdk、@google/generative-ai、form-data、ws、fluent-ffmpeg、ffmpeg-static、ytdl-core、play-dl —— 這些都是其他模組才用得到，music 播放實際上是直接 `spawn` 系統的 `yt-dlp` / `ffmpeg` 執行檔，不透過這些 npm 套件）
- 所有複製過來的檔案內部 `require()` 路徑經確認沒有任何指向 splitbill / ai / notice / voiceHandler.js 的耦合，是可以獨立抽出的一組模組
- 已用 `node --check` 對每個檔案做語法驗證，並實際 `npm install` + `require()` 全部模組驗證可載入（無法在本沙盒完整跑登入流程，因為缺真實 Discord Token）
