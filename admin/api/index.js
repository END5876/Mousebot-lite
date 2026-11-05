'use strict';
// admin/api/index.js（精簡版）— 這隻 Bot 的管理 API：註冊路由，以及告訴管理面板支援哪些功能（features）
//
// features 是管理面板的頁面代號（overview、voice…）與頁面內的選用功能（voice:join…），
// 面板只顯示 Bot 有回報的部分；協定見 admin/agent.js。
// 與正式版的差別：沒有自訂回應、TTS、通知；AI 設定與 AI 人格是單一人格的版本（見 ./ai.js、./prompts.js）；語音頁沒有手動加入／離開與喚醒詞；
// AI 人格、AI 設定（插話機率、頻道開關、清除頻道記憶）與 AI 用量頁只在有設定 GEMINI_API_KEY（AI 聊天啟用）時提供。

const registerOverview = require('./overview');
const registerVoice = require('./voice');
const registerSystem = require('./system');
const registerLogs = require('./logs');

const AI_ENABLED = !!process.env.GEMINI_API_KEY?.trim();

const FEATURES = [
  'overview', 'voice', 'status', 'maintenance', 'logs', 'maintenance:backup',
  ...(AI_ENABLED ? ['prompts', 'ai', 'usage'] : []),
];

/**
 * @param {import('../http').Router} router
 * @param {import('discord.js').Client} client
 */
function register(router, client) {
  for (const fn of [registerOverview, registerVoice, registerSystem, registerLogs]) fn(router, client);
  // AI 沒啟用時不載入 AI 模組（與 index.js 一致）
  if (AI_ENABLED) {
    require('./prompts')(router, client);
    require('./ai')(router, client);
  }
}

module.exports = { app: 'mousebot-lite', register, features: () => FEATURES };
