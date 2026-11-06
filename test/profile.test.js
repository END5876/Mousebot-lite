'use strict';
// profile.js（mousebot-lite 精簡版的預設值）：presence、隨機回覆區段、AI 範圍鎖定與預設人格、
// 備份檔案清單、Bot 代號、管理面板回報的頁面。這個檔案只在精簡版（sync.json 的 liteOwned）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-lite-profile-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
// 預設值的測試：會影響結果的設定一律清掉
for (const key of ['AI_RANDOM_SLOT', 'AI_SCOPE_LOCK', 'AI_PERSONA', 'AI_DEFAULT_MODE', 'FEATURES']) delete process.env[key];

const profile = require('../profile');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('profile：Bot 代號與管理 API 回報的 app 相同', () => {
  assert.equal(profile.app, 'mousebot-lite');
  assert.ok(Object.isFrozen(profile));
  assert.equal(require('../admin/api').app, 'mousebot-lite');
});

test('profile：沒有 presence.json 時用預設的「皮鼓」', () => {
  assert.deepEqual(profile.presenceDefault, { status: 'online', type: 'listening', text: '皮鼓' });
  const presence = require('../handlers/presenceHandler');
  assert.deepEqual(presence.getPresenceConfig(), { status: 'online', type: 'listening', text: '皮鼓' });
});

test('profile：隨機回覆區段預設從 0.5 開始（1/2），和正式版（0/2）錯開', () => {
  assert.equal(profile.defaultRandomSlot, '1/2');
  const aiChance = require('../handlers/ai/aiChance');
  assert.equal(aiChance.parseSlot(profile.defaultRandomSlot), 0.5);
});

test('profile：AI 範圍預設鎖定單一人格；沒設 AI_PERSONA 時人格是 default', () => {
  assert.equal(profile.aiScopeLock, 'single');
  const persona = require('../handlers/ai/persona');
  persona._reset();
  assert.deepEqual(persona.getLock(), { kind: 'single', persona: 'default', source: 'AI_PERSONA' });
  assert.equal(persona.isLocked(), true);
  assert.equal(persona.defaultMode(), 'default');
  assert.equal(persona.scopeFor('123').scopeKey, 'g:123:default');
});

test('profile：隨機回覆不過濾前綴（精簡版沒有 !m、!gugu、!stt 指令）', () => {
  assert.deepEqual([...profile.randomReplySkipPrefixes], []);
});

test('profile：備份的檔案清單、共用規則與檔名開頭', () => {
  assert.equal(profile.backup.app, 'mousebot-lite');
  assert.equal(profile.backup.filePrefix, 'mousebot-lite');
  assert.deepEqual([...profile.backup.settingsFiles], [
    'autojoin.json', 'voiceMonitorEnabled.json', 'presence.json', 'replyChance.json', 'replyChanceDisabled.json',
  ]);
  assert.deepEqual([...profile.backup.statsFiles], ['tokenUsage.json', 'musicPlayCount.json']);
  assert.deepEqual([...profile.backup.sharedPrompts], ['_general', '_group']);
});

test('profile：管理面板回報的頁面（有 GEMINI_API_KEY 時含 AI 三頁）', () => {
  const api = require('../admin/api');
  const saved = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'x';
    assert.deepEqual([...api.features()].sort(),
      ['ai', 'logs', 'maintenance', 'maintenance:backup', 'overview', 'prompts', 'status', 'usage', 'voice']);
    delete process.env.GEMINI_API_KEY;
    assert.deepEqual([...api.features()].sort(),
      ['logs', 'maintenance', 'maintenance:backup', 'overview', 'status', 'voice']);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});
