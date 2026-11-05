'use strict';
// admin/api/prompts.js（精簡版）— AI 人格 prompt（data/prompts/），存檔後由 promptStore 立即生效
// 與正式版的差別：
//   - 只用一個人格（AI_PERSONA，見 handlers/ai/persona.js）：清單只列出它；不能新增、刪除人格
//   - 共用規則只有 _general、_group（精簡版沒有語音對話，不用 _voice）
//   - 人格檔或 _group.md 不存在時，persona.js 用內建內容：回傳 builtin，網頁可以從內建內容建立檔案
// 回應格式沿用正式版的 /api/prompts，多了 singlePersona、builtin 等欄位（管理面板依欄位調整畫面）。

const promptStore = require('../../handlers/ai/promptStore');
const persona = require('../../handlers/ai/persona');
const { HttpError, str, oneOf } = require('../http');

const MAX_PROMPT = 30000;
const SHARED_KEYS = ['_general', '_group'];
const HISTORY_KINDS = ['modes', 'shared'];

const personaKey = () => persona.getPersonaKey();

// 只接受目前的人格：其他代號在精簡版不會被用到
function modeKey(params) {
  const key = params.key;
  if (!promptStore.MODE_KEY_RE.test(key)) throw new HttpError(400, '模式代號只能使用英數、底線、連字號（1~32 字）');
  if (key !== personaKey()) throw new HttpError(400, `這隻 Bot 只使用人格「${personaKey()}」（環境變數 AI_PERSONA）`);
  return key;
}

function sharedKey(params) {
  if (!SHARED_KEYS.includes(params.key)) throw new HttpError(404, '找不到這個共用規則');
  return params.key;
}

function historyTarget(params) {
  const kind = oneOf(params.kind, HISTORY_KINDS, '版本類型');
  const key = kind === 'modes' ? modeKey(params) : sharedKey(params);
  return { kind, key };
}

// 內建內容（檔案不存在時 persona.js 實際使用的）；檔案存在時是 null
function builtinPersona() {
  if (persona.hasPersonaFile()) return null;
  return {
    key: personaKey(),
    name: persona.getPersonaName(),
    clearMemoryMessage: persona.getClearMessage(),
    prompt: persona.getPersonaPrompt(),
  };
}

const builtinShared = (key) => (key === '_group' && !promptStore.getShared('_group') ? persona.getGroupRules() : null);

module.exports = function registerPrompts(router) {
  router.get('/api/prompts', () => {
    const key = personaKey();
    const mode = promptStore.getMode(key);
    return {
      singlePersona: true,
      defaultMode: key,
      modes: mode ? [{
        key,
        name: mode.name,
        shortDescription: mode.shortDescription ?? '',
        length: mode.prompt.length,
        users: 0,
      }] : [],
      builtin: builtinPersona(),
      shared: SHARED_KEYS.map((k) => ({ key: k, length: promptStore.getShared(k).length, builtin: !!builtinShared(k) })),
      // 只有目前的人格被刪掉過才列出來（可以還原）
      deleted: !mode && promptStore.listDeletedModes().includes(key) ? [key] : [],
    };
  });

  router.get('/api/prompts/modes/:key', ({ params }) => {
    const key = modeKey(params);
    const mode = promptStore.getMode(key);
    if (!mode) throw new HttpError(404, '還沒有人格檔，目前用的是內建的通用人格');
    return {
      key,
      name: mode.name,
      shortDescription: mode.shortDescription ?? '',
      clearMemoryMessage: mode.clearMemoryMessage,
      prompt: mode.prompt,
    };
  });

  // body：{ name, shortDescription, clearMemoryMessage, prompt, create? }
  // singleScope 在精簡版沒有意義：不改檔案裡原本的值
  router.put('/api/prompts/modes/:key', ({ params, body, audit }) => {
    const key = modeKey(params);
    const existed = !!promptStore.getMode(key);
    if (body.create && existed) throw new HttpError(409, `已經有「${key}」這個人格檔`);
    promptStore.saveMode(key, {
      name: str(body.name, '顯示名稱', { max: 100, allowEmpty: true }),
      shortDescription: str(body.shortDescription, '簡短說明', { max: 200, allowEmpty: true }),
      clearMemoryMessage: str(body.clearMemoryMessage, '清除記憶訊息', { max: 500, allowEmpty: true }),
      singleScope: undefined,
      prompt: str(body.prompt, 'Prompt 本文', { max: MAX_PROMPT }),
    });
    audit(`${existed ? '修改' : '建立'} AI 人格「${promptStore.getMode(key)?.name ?? key}」（${key}）`);
    return { created: !existed };
  });

  router.delete('/api/prompts/modes/:key', () => {
    throw new HttpError(400, '這隻 Bot 只有一個人格，不能刪除（要換人格請改環境變數 AI_PERSONA）');
  });

  router.get('/api/prompts/shared/:key', ({ params }) => {
    const key = sharedKey(params);
    return { key, text: promptStore.getShared(key), builtinText: builtinShared(key) };
  });

  router.put('/api/prompts/shared/:key', ({ params, body, audit }) => {
    const key = sharedKey(params);
    promptStore.saveShared(key, str(body.text, '規則內容', { max: MAX_PROMPT, allowEmpty: true }));
    audit(`修改共用規則 ${key}.md`);
  });

  // ── 版本紀錄（每次覆寫或刪除前自動保留，最近 20 版）────────
  router.get('/api/prompts/history/:kind/:key', ({ params }) => {
    const { kind, key } = historyTarget(params);
    return { versions: promptStore.listHistory(kind, key) };
  });

  router.get('/api/prompts/history/:kind/:key/:id', ({ params }) => {
    const { kind, key } = historyTarget(params);
    const version = promptStore.getHistoryVersion(kind, key, params.id);
    if (!version) throw new HttpError(404, '找不到這個版本');
    return version;
  });
};
