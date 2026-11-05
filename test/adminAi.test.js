'use strict';

// 精簡版管理 API 的 AI 設定（admin/api/ai.js）：設定總覽、插話機率、頻道開關、清除頻道記憶。
// 用假的 Discord client，直接呼叫路由的處理函式；資料檔寫到暫存資料夾。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-admin-ai-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'; // 讓 admin/api/index.js 註冊 AI 路由
process.env.LOG_LEVEL = 'error';

const { Router, HttpError } = require('../admin/http');
const aiChance = require('../handlers/ai/aiChance');
const aiMemoryState = require('../handlers/ai/aiMemoryState');
const { ChannelType } = require('discord.js');

const GUILD = '111111111111111111';
const TEXT = '222222222222222222';
const VOICE = '333333333333333333';

function fakeChannel(id, name, type, rawPosition) {
  return { id, name, type, rawPosition, parent: null, guild: null, guildId: GUILD, viewable: true, permissionsFor: () => ({ has: () => true }) };
}

const channels = new Map([
  [TEXT, fakeChannel(TEXT, '聊天', ChannelType.GuildText, 0)],
  [VOICE, fakeChannel(VOICE, '語音', ChannelType.GuildVoice, 1)],
]);
const guild = {
  id: GUILD, name: '測試伺服器', memberCount: 3,
  iconURL: () => null,
  channels: { cache: channels },
  members: { me: { id: 'me' } },
};
for (const c of channels.values()) c.guild = guild;
const client = {
  isReady: () => true,
  user: null,
  ws: { status: 0, ping: 10 },
  guilds: { cache: new Map([[GUILD, guild]]) },
  channels: { cache: channels },
  users: { cache: new Map() },
};

const api = require('../admin/api');
const router = new Router();
api.register(router, client);

async function call(method, p, body = {}) {
  const url = new URL(p, 'http://x');
  const m = router.match(method, url.pathname);
  assert.ok(m && !m.methodNotAllowed, `${method} ${p} 沒有路由`);
  const actions = [];
  const result = await m.handler({ params: m.params, query: url.searchParams, body, audit: (t) => actions.push(t) });
  return { result, actions };
}

test('lite AI：有 GEMINI_API_KEY 時回報 ai 與 usage 頁', () => {
  const features = api.features(client);
  assert.ok(features.includes('ai'));
  assert.ok(features.includes('usage'));
});

test('lite AI：設定總覽是單一人格的格式（沒有使用者人格、範圍、特殊身分）', async () => {
  const { result } = await call('GET', '/api/ai/settings');
  assert.equal(typeof result.model, 'string');
  assert.equal(result.memoryScope, 'channel');
  assert.equal(typeof result.persona.key, 'string');
  assert.equal(typeof result.persona.fromFile, 'boolean');
  assert.equal(result.userModes, undefined);
  assert.equal(result.modes, undefined);
  assert.equal(result.specialUsers, undefined);
  assert.equal(result.replyChance.default, aiChance.DEFAULT_CHANCE);
  const [g] = result.replyChance.guilds;
  assert.equal(g.id, GUILD);
  assert.equal(g.chance, null);
  assert.deepEqual(g.channels.map((c) => [c.id, c.disabled]), [[TEXT, false], [VOICE, false]]);
});

test('lite AI：插話機率設定、恢復預設、頻道開關都寫進操作紀錄', async () => {
  let r = await call('PUT', `/api/ai/chance/${GUILD}`, { chance: 0.25 });
  assert.equal(r.result.chance, 0.25);
  assert.match(r.actions[0], /測試伺服器.*25%/);
  assert.equal(aiChance.listReplyChances()[GUILD], 0.25);

  r = await call('DELETE', `/api/ai/chance/${GUILD}`);
  assert.equal(aiChance.listReplyChances()[GUILD], undefined);
  assert.match(r.actions[0], /恢復預設/);

  r = await call('PUT', `/api/ai/channels/${TEXT}`, { disabled: true });
  assert.equal(r.result.disabled, true);
  assert.ok(aiChance.listDisabledChannels().includes(TEXT));
  const { result } = await call('GET', '/api/ai/settings');
  assert.equal(result.replyChance.guilds[0].channels.find((c) => c.id === TEXT).disabled, true);
  await call('PUT', `/api/ai/channels/${TEXT}`, { disabled: false });

  await assert.rejects(call('PUT', `/api/ai/chance/${GUILD}`, { chance: 5 }), HttpError);
});

test('lite AI：清除頻道記憶（等同 /ai clear all:true）', async () => {
  const before = aiMemoryState.getChannelClearTime(TEXT);
  const { actions } = await call('POST', `/api/ai/memory/channel/${TEXT}`);
  assert.ok(aiMemoryState.getChannelClearTime(TEXT) > before);
  assert.match(actions[0], /測試伺服器 › #聊天/);
  await assert.rejects(call('POST', '/api/ai/memory/channel/999999999999999999'), (err) => err.status === 404);
});
