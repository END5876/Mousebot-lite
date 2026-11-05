# Mousebot-lite

Mousebot 的精簡版，只保留這些功能：

- **autojoin**：Bot 常駐在指定語音頻道，斷線自動重連（`/autojoin`）
- **音樂**：本地音樂庫＋ YouTube / Bilibili 點歌、播放清單、循環／隨機連播、控制面板（`/play`、`/music`）
- **AI 聊天（選用）**：正式版的「單一人格」群聊模式（`/ai`、@ 提及、隨機插話）。沒有設定 `GEMINI_API_KEY` 時完全不啟用
- **管理 API（選用）**：給網頁管理面板 admin-panel 呼叫，和正式版在同一個面板上管理（見「管理面板」）。沒有設定 `ADMIN_AGENT_TOKEN` 時不啟動

`handlers/` 與 `utils/` 的程式碼源自正式版 [Mousebot](https://github.com/END5876/Mousebot)，
大部分檔案相同；少數檔案因為精簡版功能較少而刻意不同（見「從正式版同步」）。
`index.js`、`package.json`、`Dockerfile`、`docker-entrypoint.sh` 是精簡版自己的。

## 專案結構

```
├── index.js                          # 入口（autojoin + 音樂；有 GEMINI_API_KEY 時再載入 AI）
├── admin/                            # 管理 API，給 admin-panel 呼叫（設定 ADMIN_AGENT_TOKEN 才啟動）
├── handlers/
│   ├── autoJoinHandler.js            # /autojoin、斷線恢復
│   ├── audioManager.js               # 音訊層管理（靜音防踢 / 音樂）
│   ├── presenceHandler.js            # Bot 狀態文字（data/presence.json，管理面板可改）
│   ├── musicplayer/                  # 音樂播放（線上 / 本地 / 佇列 / 快取 / 響度正規化 / 重啟後接續播放）
│   └── ai/                           # AI 聊天（單一人格）：aiHandler 指令與訊息、aiCore 群組歷史與呼叫、persona 固定人格
├── utils/
│   ├── processGuards.js              # 全域錯誤處理、SIGTERM 正常關機（onShutdown 關閉前動作）
│   ├── config.js                     # 擁有者權限（OWNER_USER_ID）
│   ├── jsonStore.js                  # data/*.json 原子寫入、.bak 備份
│   ├── dataDir.js                    # 資料目錄（MOUSEBOT_DATA_DIR 可覆寫，測試用）
│   ├── commandSync.js                # Slash Commands 同步（hash 比對、DEV_GUILD_ID）
│   ├── health.js                     # /healthz 健康檢查端點
│   ├── logger.js                     # 統一 log 工具（LOG_LEVEL）
│   ├── bootSummary.js
│   ├── alert.js                      # Discord webhook 告警（AI 全體每日額度用完時）
│   └── rateLimiter.js                # AI 每人呼叫頻率限制
├── data/                             # 執行時產生：設定檔、播放快照、data/music 本地音樂庫與下載快取、data/prompts AI 人格
├── test/                             # node:test 單元測試（npm test）
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
| `GEMINI_API_KEY` | | 填了才啟用 AI 聊天；留空＝不啟用 |
| `AI_PERSONA` | | AI 人格代號（預設 `bigfish`），讀 `data/prompts/modes/<代號>.md`，見下方「人格」 |
| `ADMIN_AGENT_TOKEN` | | 填了才啟動管理 API（至少 32 字元，要和 admin-panel 的 `PANEL_TOKEN_<代號>` 相同），見「管理面板」 |

其他選填項目（`LOG_LEVEL`、`DEV_GUILD_ID`、`HEALTH_PORT`、`MUSIC_RESUME`、AI 用量限制…）見 `.env.example`。

Bot 需要在 Discord Developer Portal 開啟 **Server Members Intent**。
有設定 `GEMINI_API_KEY` 時還要開啟 **Message Content Intent**（群聊歷史與隨機插話要讀訊息內容）；
沒開的話 Bot 會登入失敗，log 會提示要開啟它或移除 `GEMINI_API_KEY`。不用 AI 就不需要這個 intent。

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
- `docker stop` 時把 SIGTERM 轉給 Bot，讓它寫出播放快照、關閉 Discord 連線、結束 yt-dlp 子程序後再退出

映像檔內建 `HEALTHCHECK`：每 30 秒查詢 `127.0.0.1:3939/healthz`，Discord 斷線超過 60 秒即標記為 unhealthy。
重啟後 15 分鐘內，若語音頻道裡還有人，會自動接續原本的歌單（目前這首從頭播放）。

## 本機執行

需要 Node.js 22+、ffmpeg、yt-dlp（都要在 PATH 上）。

```bash
npm ci
cp .env.example .env
npm start
```

本機沒有自動重啟機制，建議在 `.env` 加上 `EXIT_ON_UNCAUGHT=0`，
讓未捕捉的例外只記錄、不結束程序。

開發時：

```bash
npm run lint    # ESLint（禁止直接使用 console.*，請改用 utils/logger.js）
npm test        # node:test 單元測試（test/*.test.js）
npm run check   # 以上兩者（GitHub Actions 每次 push / PR 也會跑 lint 與測試）
```

建議設定 `DEV_GUILD_ID`，Slash Commands 只註冊到測試伺服器、改完立即生效。

## 本地音樂庫

把音檔（`.mp3` `.wav` `.ogg` `.flac` `.m4a` `.aac`，可放子資料夾）放進 `data/music/`，
`/music local list` 列出清單，`/play` 自動完成可以直接選歌。線上點歌下載的快取也存在這裡。

## AI 聊天（單一人格）

`.env` 填上 `GEMINI_API_KEY` 就會啟用；沒填時不註冊 `/ai`、不監聽訊息，也不載入相關模組。

行為與正式版的「單一人格」模式相同：每個頻道裡大家都跟同一個人格聊天，
AI 會看這個頻道最近 30 分鐘的群組對話（最多 24 則，`AI_GROUP_MSG_LIMIT` 可調）並分辨是誰說的。

- **@Bot**（或回覆 Bot 的訊息）：完整回覆，支援圖片、自訂 emoji、引用訊息
- **隨機插話**：預設 15% 機率短回覆；`/ai chance set` 調整本伺服器機率、`/ai chance toggle` 關閉本頻道（僅限管理員）
- **`/ai ask`**：以指令發問，可附圖片
- **`/ai clear`**：清除自己在這個頻道的對話記憶；`all:true` 清除整個頻道（僅限管理員）

正式版的多人格、`/ai mode`、`/ai scope`、`/ai prompt`、`/ai tts`、`/ai gugu`、工具呼叫（點歌、分帳等）都沒有。

### 人格

人格檔放在資料目錄 `data/prompts/`，**不跟程式碼一起部署**（`data/` 被 git 與 Docker 映像檔排除）。
部署時要自己把檔案放進伺服器上掛載給容器的 `data/` 目錄。
格式與正式版相同，可以直接把正式版的 `data/prompts/` 複製過來。檔案修改後會自動重新載入，不用重啟。

```
data/prompts/
├── modes/<AI_PERSONA>.md   # 人格本體（front matter 的 name、clearMemoryMessage 會用到）
├── _general.md             # 選填：所有回覆共用的規則
└── _group.md               # 選填：群聊規則；缺檔時用內建版本（與正式版內容相同）
```

`AI_PERSONA` 預設是 `bigfish`（大肥魚），也就是讀 `data/prompts/modes/bigfish.md`；換人格要改 `.env` 並重啟。
找不到人格檔時改用內建的通用人格，開機摘要會標成 ⚠️。

人格 prompt 要配合程式送給模型的格式：每則訊息開頭是 `【發言者：顯示名稱 (@帳號)】`，
沒有其他身分標記，模型無法分辨誰是擁有者。

## 管理面板

網頁管理面板是獨立的服務 admin-panel，一個網頁同時管理正式版與精簡版。精簡版在面板上提供：
總覽、語音與音樂（自動加入、點歌、播放控制、佇列、閒置自動停止）、狀態與訊息（Bot 狀態文字、以 Bot 身分發訊息）、
維護（指令同步、下載快取、設定備份與還原、重新啟動）、日誌；有設定 `GEMINI_API_KEY` 時另有 AI 人格（編輯 `AI_PERSONA` 的人格檔與 `_general`、`_group` 規則，含版本紀錄；沒有人格檔時可以從內建人格建立）、AI 設定（模型與額度、人格、隨機插話機率與頻道開關、清除頻道的對話記憶）與 AI 用量。
沒有手動加入／離開語音頻道（由 autojoin 管理）與喚醒詞，也沒有正式版的自訂回應、新增／刪除人格、使用者人格與範圍、TTS、通知。

- `.env` 設定 `ADMIN_AGENT_TOKEN`（至少 32 字元），容器裡再設 `ADMIN_HOST=0.0.0.0` 讓面板連進來；**不要讓這個 port 對外公開**。
- 面板的 `PANEL_BOTS` 加上 `lite=http://mousebot-lite:3940`，並設定 `PANEL_TOKEN_LITE`（= 這裡的 `ADMIN_AGENT_TOKEN`）。
- 容器以 `restart: unless-stopped` 執行時設 `RESTART_MANAGED=1`，面板的「重新啟動」按鈕才會顯示成重新啟動（而不是關閉）。
- `admin/agent.js`、`admin/backup.js`、`admin/http.js`、`admin/discordInfo.js`、`admin/voiceState.js`、`admin/cacheTools.js`、
  `admin/api/overview.js`、`admin/api/logs.js` 與正式版相同；`admin/api/` 其餘檔案是精簡版自己的版本。

## 從正式版同步

`handlers/`、`utils/` 與 `admin/` 多數檔案和正式版相同，但**下列檔案不能直接覆蓋**，因為正式版多了精簡版沒有的功能，
覆蓋會讓精簡版 `require` 到不存在的模組，或改掉精簡版刻意不同的行為：

| 檔案 | 與正式版的差異 |
|---|---|
| `handlers/presenceHandler.js` | 預設狀態文字是「正在聽 皮鼓」（`DEFAULT_PRESENCE`），其餘相同 |
| `handlers/ai/aiChance.js` | 隨機回覆區段預設 `1/2`（正式版 `0/2`） |
| `utils/heartbeat.js` | 精簡版沒有這個檔案 |
| `admin/api/index.js`、`voice.js`、`system.js`、`ai.js`、`prompts.js` | 精簡版自己的版本（路由較少、回報的 `features` 不同、備份的檔案清單不同、單一人格） |
| `handlers/ai/aiHandler.js` | 精簡版自己的版本：只有 ask / clear / chance，單一人格 |
| `handlers/ai/aiCore.js` | 由正式版精簡：只留群組歷史（單一人格），沒有多人格歷史、工具階段、語音；函式名稱與正式版一致，修正可對照同名函式手動套用 |
| `handlers/ai/aiUtils.js` | 拿掉 TTS（`isAITTSEnabled`、`setAITTSEnabled`、`speakWithTTS`） |
| `handlers/ai/persona.js` | 精簡版專用（取代正式版的 `aiScope.js`、`modeSelector.js`） |

`handlers/ai/` 其餘檔案（`aiSettings`、`geminiClient`、`aiQuota`、`aiChance`、`aiMemoryState`、`aiMessageLog`、
`chatSanitize`、`promptStore`、`searchGrounding`、`tokenTracker`）與 `utils/dataDir.js`、`utils/alert.js` 和正式版相同。

同步方式：先在兩個 repo 之間比對差異；表中列出的檔案以外，有差異就是落後，直接複製正式版的版本：

```bash
# 在 Mousebot-lite 目錄；../Mousebot 是正式版
for f in $(git ls-files handlers utils admin); do
  diff -q --strip-trailing-cr "../Mousebot/$f" "$f" >/dev/null || echo "不同：$f"
done
```

若正式版新增了這些模組會用到的 npm 套件，再同步更新 `package.json`。
正式版 `index.js` 的啟動流程有變動時（例如指令註冊、健康檢查、播放恢復），需手動套用到精簡版的 `index.js`。
同步後執行 `npm run check` 確認沒有缺漏。

## License

[ISC](LICENSE)
