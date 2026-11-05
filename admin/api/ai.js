'use strict';
// admin/api/ai.js（精簡版）— AI 設定（模型與額度、人格、隨機插話、清除頻道記憶）與用量統計
// 與正式版的差別：精簡版只有單一人格（handlers/ai/persona.js），沒有使用者人格、多人格範圍與特殊身分；
// 對話記憶以頻道為單位（群聊），所以清除記憶是清整個頻道（等同 /ai clear all:true）。
// 回應格式沿用正式版：管理面板依回傳的欄位決定顯示哪些區塊（沒有 userModes、modes、specialUsers；多了 persona、memoryScope）。

const aiChance = require('../../handlers/ai/aiChance');
const aiMemoryState = require('../../handlers/ai/aiMemoryState');
const persona = require('../../handlers/ai/persona');
const promptStore = require('../../handlers/ai/promptStore');
const tokenTracker = require('../../handlers/ai/tokenTracker');
const aiQuota = require('../../handlers/ai/aiQuota');
const { MODEL_NAME } = require('../../handlers/ai/geminiClient');
const { ENABLED_GUILD_IDS } = require('../../handlers/ai/searchGrounding');
const {
  TEXT_TYPES, VOICE_TYPES, guildSummary, guildChannels, describeChannel, resolveUsers,
} = require('../discordInfo');
const { HttpError, bool, snowflake, requireReady } = require('../http');

const MAX_USAGE_DAYS = 90;

function modeName(key) {
  return promptStore.getMode(key)?.name ?? null;
}

// 每個統計桶補上「計費 token」（total 扣掉搜尋取回的內容，見 tokenTracker）
function withBillable(group) {
  return Object.fromEntries(Object.entries(group).map(([k, b]) => [k, { ...b, billable: tokenTracker.billableTotal(b) }]));
}

module.exports = function registerAi(router, client) {
  router.get('/api/ai/settings', () => {
    requireReady(client);
    const chances = aiChance.listReplyChances();
    const disabled = new Set(aiChance.listDisabledChannels());

    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((guild) => {
        const channels = guildChannels(guild, [...TEXT_TYPES, ...VOICE_TYPES]);
        const listed = new Set(channels.map((c) => c.id));
        // 討論串等不在清單裡、但被停用過的頻道也要列出來，才能重新開啟
        const extra = [...disabled]
          .map((id) => describeChannel(client, id))
          .filter((c) => c.guildId === guild.id && !listed.has(c.id))
          .map((c) => ({ id: c.id, name: c.name, kind: 'thread', category: null }));
        return {
          ...guildSummary(guild),
          chance: chances[guild.id] ?? null,
          channels: [...channels, ...extra].map((c) => ({ ...c, disabled: disabled.has(c.id) })),
        };
      });

    const key = persona.getPersonaKey();
    return {
      model: MODEL_NAME,
      limits: aiQuota.getLimits(),
      searchGuilds: [...ENABLED_GUILD_IDS].map((id) => ({ id, name: client.guilds.cache.get(id)?.name ?? null })),
      persona: {
        key,
        name: persona.getPersonaName(),
        // false：找不到 data/prompts/modes/<key>.md，用內建的通用人格
        fromFile: persona.hasPersonaFile(),
      },
      memoryScope: 'channel',
      replyChance: { default: aiChance.DEFAULT_CHANCE, guilds },
    };
  });

  const guildName = (id) => client.guilds.cache.get(id)?.name ?? id;

  // ── 隨機插話機率 ─────────────────────────────────────────
  router.put('/api/ai/chance/:guildId', ({ params, body, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const result = aiChance.setReplyChance(guildId, body.chance);
    if (!result.success) throw new HttpError(400, result.error);
    audit(`把「${guildName(guildId)}」的隨機插話機率設為 ${Math.round(result.chance * 100)}%`);
    return { chance: result.chance };
  });

  router.delete('/api/ai/chance/:guildId', ({ params, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const chance = aiChance.resetReplyChance(guildId);
    audit(`把「${guildName(guildId)}」的隨機插話機率恢復預設`);
    return { chance };
  });

  router.put('/api/ai/channels/:channelId', ({ params, body, audit }) => {
    const channelId = snowflake(params.channelId, '頻道');
    const result = aiChance.setChannelDisabled(channelId, bool(body.disabled, '插話開關'));
    const ch = describeChannel(client, channelId);
    audit(`${result.disabled ? '關閉' : '開啟'}「${ch.guildName ?? '?'} › #${ch.name ?? channelId}」的隨機插話`);
    return result;
  });

  // ── 清除頻道的對話記憶（等同 /ai clear all:true）─────────
  router.post('/api/ai/memory/channel/:channelId', ({ params, audit }) => {
    const channelId = snowflake(params.channelId, '頻道');
    const ch = describeChannel(client, channelId);
    if (!ch.guildId) throw new HttpError(404, '找不到這個頻道');
    aiMemoryState.clearChannelMemory(channelId);
    audit(`清除「${ch.guildName ?? '?'} › #${ch.name ?? channelId}」的 AI 對話記憶`);
  });

  // ── 用量統計 ─────────────────────────────────────────────
  router.get('/api/ai/usage', async ({ query }) => {
    const days = Math.min(MAX_USAGE_DAYS, Math.max(1, Number.parseInt(query.get('days') ?? '30', 10) || 30));
    const history = tokenTracker.getUsageHistory(days).map((day) => ({
      date: day.date,
      total: { ...day.total, billable: tokenTracker.billableTotal(day.total) },
      bySource: withBillable(day.bySource),
      byMode: withBillable(day.byMode),
      byUser: withBillable(day.byUser),
    }));

    const userIds = new Set(history.flatMap((d) => Object.keys(d.byUser)));
    const modeKeys = new Set(history.flatMap((d) => Object.keys(d.byMode)));
    return {
      days: history,
      users: client.isReady() ? await resolveUsers(client, [...userIds]) : {},
      modeNames: Object.fromEntries([...modeKeys].map((k) => [k, modeName(k)])),
      limits: aiQuota.getLimits(),
    };
  });
};
