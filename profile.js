'use strict';
// profile.js — 這隻 Bot 自己的預設值（mousebot-lite 精簡版）
//
// Mousebot 正式版也有一份同名檔案，內容不同、不同步（sync.json 的 liteOwned）；
// 共用的程式碼一律從這裡讀各 Bot 不同的預設值。
// 只放：app、backup、presenceDefault、defaultRandomSlot、aiScopeLock、randomReplySkipPrefixes。

module.exports = Object.freeze({
  // 管理面板顯示的 Bot 代號（admin/api/index.js）
  app: 'mousebot-lite',

  // 設定備份（admin/api/system.js、admin/backup.js）
  // 不含任何金鑰（admin-session-secret、cookies），也不含暫存或可重建的檔案。
  // AI 對話狀態（aiMemoryState.json 清除時間、aiMessageLog.json 回覆紀錄）涉及使用者隱私，刻意不放進備份
  // 與正式版的差別：只有精簡版有的設定檔（自動加入、閒置自動停止、Bot 狀態、AI 插話機率）
  backup: Object.freeze({
    app: 'mousebot-lite',
    filePrefix: 'mousebot-lite',
    settingsFiles: Object.freeze([
      'autojoin.json', 'voiceMonitorEnabled.json', 'presence.json', 'replyChance.json', 'replyChanceDisabled.json',
    ]),
    statsFiles: Object.freeze(['tokenUsage.json', 'musicPlayCount.json']),
    // data/prompts/ 的共用規則（modes/*.md 一律備份）
    sharedPrompts: Object.freeze(['_general', '_group']),
  }),

  // 沒有 data/presence.json 時的 Bot 狀態（handlers/presenceHandler.js）
  presenceDefault: Object.freeze({ status: 'online', type: 'listening', text: '皮鼓' }),

  // 沒設 AI_RANDOM_SLOT 時的隨機回覆區段（handlers/ai/aiChance.js）；和 MouseBot（0/2）錯開
  defaultRandomSlot: '1/2',

  // 沒設 AI_SCOPE_LOCK 時的 AI 範圍鎖定：一律單一人格（人格 = AI_PERSONA，未設定時用 AI_DEFAULT_MODE／default）
  aiScopeLock: 'single',

  // 精簡版沒有 !m、!gugu、!stt 等前綴指令，任何訊息都可能被隨機回覆
  randomReplySkipPrefixes: Object.freeze([]),
});
