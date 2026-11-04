'use strict';

// 精簡版 AI 的啟用條件、固定人格（persona.js）與 system instruction 的組法。
// 不打 Gemini；資料目錄指到暫存資料夾，不碰正式的 data/（prompts 也從那裡讀）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-lite-ai-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
process.env.AI_PERSONA = 'chat';
delete process.env.GEMINI_API_KEY;

const { Collection } = require('discord.js');
const promptStore = require('../handlers/ai/promptStore');
const persona = require('../handlers/ai/persona');
const { buildSystemInstruction } = require('../handlers/ai/aiCore');
const { setupAICommands, isAIEnabled } = require('../handlers/ai/aiHandler');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  // aiUtils 有常駐的圖片快取清理計時器，等測試框架寫完結果後主動結束
  setTimeout(() => process.exit(), 500).unref();
});

function fakeClient() {
  const events = [];
  return { commands: new Collection(), on: (name) => events.push(name), events };
}

test('沒有 GEMINI_API_KEY（或只有空白）：不註冊 /ai、不監聽訊息', () => {
  for (const key of [undefined, '', '   ']) {
    if (key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = key;
    assert.equal(isAIEnabled(), false);
    const client = fakeClient();
    assert.equal(setupAICommands(client), false);
    assert.equal(client.commands.size, 0);
    assert.deepEqual(client.events, []);
  }
});

test('有 GEMINI_API_KEY：註冊 /ai（只有 ask / clear / chance，限伺服器內）並監聽 messageCreate', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const client = fakeClient();
    assert.equal(setupAICommands(client), true);
    const cmd = client.commands.get('ai');
    assert.ok(cmd);
    const json = cmd.data.toJSON();
    assert.deepEqual(json.options.map(o => o.name).sort(), ['ask', 'chance', 'clear']);
    assert.deepEqual(json.contexts, [0]); // InteractionContextType.Guild
    assert.deepEqual(client.events, ['messageCreate']);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('範圍：一律單一人格，scopeKey 依伺服器並帶上人格代號', () => {
  const s = persona.scopeFor('123');
  assert.equal(s.kind, 'single');
  assert.equal(s.persona, 'chat');
  assert.equal(s.scopeKey, 'g:123:chat');
  assert.equal(s.changedAt, 0);
  assert.ok(Object.isFrozen(s));
  assert.notEqual(persona.scopeFor('456').scopeKey, s.scopeKey);
});

test('預設人格代號是 bigfish（人格檔放在 data/，不在程式碼裡）', () => {
  assert.equal(persona.DEFAULT_PERSONA, 'bigfish');
});

test('沒有人格檔與 _group.md：用內建的通用人格與內建群聊規則', () => {
  assert.equal(persona.hasPersonaFile(), false);
  assert.equal(persona.getPersonaName(), '預設人格');
  const si = buildSystemInstruction({ roster: '【目前這段對話中的成員】\n- A' });
  assert.equal(si, [persona.BUILTIN_PERSONA_PROMPT, persona.BUILTIN_GROUP_RULES, '【目前這段對話中的成員】\n- A'].join('\n\n'));
});

test('有人格檔時：順序 persona → _general → _group → 名冊；clearMemoryMessage 取自人格檔', () => {
  promptStore.saveMode('chat', { name: '聊天鼠', clearMemoryMessage: '忘光光了', prompt: '你是聊天鼠。' });
  promptStore.saveShared('_general', '一律用繁體中文。');
  promptStore.saveShared('_group', '群聊規則。');

  assert.equal(persona.hasPersonaFile(), true);
  assert.equal(persona.getPersonaName(), '聊天鼠');
  assert.equal(persona.getClearMessage(), '忘光光了');
  assert.equal(buildSystemInstruction({ roster: 'R' }), '你是聊天鼠。\n\n一律用繁體中文。\n\n群聊規則。\n\nR');
  assert.equal(buildSystemInstruction(), '你是聊天鼠。\n\n一律用繁體中文。\n\n群聊規則。');
});
