'use strict';

// 精簡版管理 API 的 AI 人格（admin/api/prompts.js）：只有 AI_PERSONA 一個人格、從內建人格建立人格檔、
// 共用規則只有 _general、_group。資料目錄指到暫存資料夾（一開始沒有任何人格檔）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-admin-prompts-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.AI_PERSONA = 'testfish';
process.env.LOG_LEVEL = 'error';

const { Router } = require('../admin/http');
const registerPrompts = require('../admin/api/prompts');
const promptStore = require('../handlers/ai/promptStore');
const persona = require('../handlers/ai/persona');

const router = new Router();
registerPrompts(router);

async function call(method, p, body = {}) {
  const url = new URL(p, 'http://x');
  const m = router.match(method, url.pathname);
  assert.ok(m && !m.methodNotAllowed, `${method} ${p} 沒有路由`);
  const actions = [];
  const result = await m.handler({ params: m.params, query: url.searchParams, body, audit: (t) => actions.push(t) });
  return { result, actions };
}

test('lite 人格：沒有人格檔時回傳內建人格（Bot 實際在用的內容）', async () => {
  const { result } = await call('GET', '/api/prompts');
  assert.equal(result.singlePersona, true);
  assert.equal(result.defaultMode, 'testfish');
  assert.deepEqual(result.modes, []);
  assert.equal(result.builtin.key, 'testfish');
  assert.equal(result.builtin.prompt, persona.getPersonaPrompt());
  assert.deepEqual(result.shared.map((s) => s.key), ['_general', '_group']);
  assert.equal(result.shared.find((s) => s.key === '_group').builtin, true);
  await assert.rejects(call('GET', '/api/prompts/modes/testfish'), (err) => err.status === 404);
});

test('lite 人格：從內建內容建立人格檔後立即生效，清單改列人格檔', async () => {
  const { actions } = await call('PUT', '/api/prompts/modes/testfish', {
    name: '測試魚', shortDescription: '', clearMemoryMessage: '🐟 忘光了', prompt: '你是一條魚。', create: true, singleScope: 'off',
  });
  assert.match(actions[0], /建立 AI 人格「測試魚」/);
  promptStore.refresh?.(true);
  assert.equal(persona.getPersonaName(), '測試魚');
  assert.equal(persona.getPersonaPrompt(), '你是一條魚。');
  assert.equal(promptStore.getMode('testfish').singleScope, undefined); // 精簡版不寫 singleScope

  const { result } = await call('GET', '/api/prompts');
  assert.equal(result.builtin, null);
  assert.deepEqual(result.modes.map((m) => m.key), ['testfish']);
  await assert.rejects(call('PUT', '/api/prompts/modes/testfish', { name: 'x', prompt: 'y', create: true }), (err) => err.status === 409);
});

test('lite 人格：只能編輯 AI_PERSONA 那個人格，不能刪除', async () => {
  await assert.rejects(call('PUT', '/api/prompts/modes/other', { name: 'x', prompt: 'y' }), (err) => err.status === 400);
  await assert.rejects(call('GET', '/api/prompts/history/modes/other'), (err) => err.status === 400);
  await assert.rejects(call('DELETE', '/api/prompts/modes/testfish'), (err) => err.status === 400);
});

test('lite 人格：共用規則只有 _general、_group；_group 空白時附上內建規則', async () => {
  let { result } = await call('GET', '/api/prompts/shared/_group');
  assert.equal(result.text, '');
  assert.equal(result.builtinText, persona.getGroupRules());
  await assert.rejects(call('GET', '/api/prompts/shared/_voice'), (err) => err.status === 404);

  await call('PUT', '/api/prompts/shared/_group', { text: '大家好好聊' });
  promptStore.refresh?.(true);
  ({ result } = await call('GET', '/api/prompts/shared/_group'));
  assert.equal(result.text, '大家好好聊');
  assert.equal(result.builtinText, null);

  // 修改前的版本留在版本紀錄
  const { result: hist } = await call('GET', '/api/prompts/history/modes/testfish');
  assert.ok(Array.isArray(hist.versions));
});
