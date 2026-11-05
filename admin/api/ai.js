'use strict';
// admin/api/ai.js（精簡版）— AI 用量統計
// 與正式版的差別：精簡版只有單一人格（handlers/ai/persona.js），沒有使用者人格、多人格範圍與人格編輯，
// 這裡只提供「AI 用量」頁；回應格式與正式版的 /api/ai/usage 相同。

const promptStore = require('../../handlers/ai/promptStore');
const tokenTracker = require('../../handlers/ai/tokenTracker');
const aiQuota = require('../../handlers/ai/aiQuota');
const { resolveUsers } = require('../discordInfo');

const MAX_USAGE_DAYS = 90;

function modeName(key) {
  return promptStore.getMode(key)?.name ?? null;
}

// 每個統計桶補上「計費 token」（total 扣掉搜尋取回的內容，見 tokenTracker）
function withBillable(group) {
  return Object.fromEntries(Object.entries(group).map(([k, b]) => [k, { ...b, billable: tokenTracker.billableTotal(b) }]));
}

module.exports = function registerAi(router, client) {
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
