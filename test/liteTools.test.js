'use strict';

// 精簡版的 AI 工具：只有音樂（music_*）與禁言辱罵者（timeout_insulter）。
// 分帳、免費遊戲、語音工具的檔案不在精簡版（sync.json 的 mbOnly），對應模組也不存在，不能被宣告。
// MB 的 test/aiTools.test.js 會用到那些檔案，所以精簡版另外用這份測試。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MOUSEBOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-tools-'));
process.env.GEMINI_API_KEY ||= 'x';
process.env.LOG_LEVEL = 'error';
delete process.env.FEATURES;
delete process.env.AI_TOOLS;
delete process.env.AI_TIMEOUT_USERS;

const generateCalls = [];
let nextResponse = {};
function stub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../handlers/ai/geminiClient', {
  generate: async (opts) => { generateCalls.push(opts); return nextResponse; },
  MODEL_NAME: 'test-model',
});
stub('../handlers/ai/tokenTracker', { recordUsage: () => {} });

const { PermissionFlagsBits } = require('discord.js');
const features = require('../utils/features');
const tools = require('../handlers/ai/tools');

const guild = (canModerate) => ({
  id: 'g1',
  members: { me: { voice: { channelId: null }, permissions: { has: (p) => canModerate && p === PermissionFlagsBits.ModerateMembers } }, cache: new Map() },
});
const member = (id = '100000000000000001') => {
  const m = { id, displayName: 'tester', voice: { channel: null, channelId: null }, moderatable: true, timeouts: [],
    isCommunicationDisabled: () => false, timeout: async (ms) => { m.timeouts.push(ms); } };
  return m;
};
const ctxOf = (m, g = guild(true)) => ({ guild: g, member: m, textChannel: null, userId: m.id, source: 'text' });
const parts = (t) => [{ text: `【發言者：tester】\n${t}` }];
const declared = () => generateCalls[0].config.tools[0].functionDeclarations.map(d => d.name);

test.beforeEach(() => {
  generateCalls.length = 0;
  nextResponse = {};
  delete process.env.AI_TIMEOUT_USERS;
});

test('精簡版有 AI 工具模組；分帳、免費遊戲、語音模組不存在', () => {
  assert.equal(features.isEnabled('aiTools'), true);
  for (const name of ['splitbill', 'notice', 'voice', 'tts']) assert.equal(features.status(name).state, 'absent', name);
});

test('只宣告音樂工具；分帳、遊戲、語音的關鍵字不命中預篩', async () => {
  assert.equal(tools.needsTools('放周杰倫的晴天'), true);
  for (const s of ['幫我記帳 晚餐 900', '現在 Epic 送什麼', '進來語音陪我']) assert.equal(tools.needsTools(s), false, s);
  await tools.runToolStage({ history: [], parts: parts('放晴天'), text: '放晴天', ctx: ctxOf(member()) });
  assert.deepEqual(declared(), ['music_play', 'music_random', 'music_control', 'music_status']);
  assert.equal(generateCalls[0].systemInstruction, tools._ROUTER_PROMPT);
  assert.ok(tools._noActionRule().startsWith('【注意】這次沒有替使用者播放音樂。'));
});

test('禁言：名單空時關閉；名單上的人辱罵 Bot 時禁言 1 分鐘', async () => {
  assert.equal(tools.needsTools('你這垃圾'), false, '名單空時罵人的字眼不命中預篩');

  const m = member();
  process.env.AI_TIMEOUT_USERS = m.id;
  nextResponse = { functionCalls: [{ name: 'timeout_insulter', args: { reason: '罵 Bot 垃圾' } }] };
  const { text } = await tools.runToolStage({ history: [], parts: parts('你這垃圾'), text: '你這垃圾', ctx: ctxOf(m) });
  assert.deepEqual(declared(), ['music_play', 'music_random', 'music_control', 'music_status', 'timeout_insulter']);
  assert.deepEqual(m.timeouts, [60_000]);
  assert.match(text, /嗆回去/);
});

test('禁言：面板名單（timeoutList）也有效，名單外的人不宣告', async () => {
  const listed = member('100000000000000002');
  assert.equal(tools.timeoutList.add(listed.id), true);
  try {
    await tools.runToolStage({ history: [], parts: parts('你這垃圾'), text: '你這垃圾', ctx: ctxOf(listed) });
    assert.ok(declared().includes('timeout_insulter'));

    generateCalls.length = 0;
    await tools.runToolStage({ history: [], parts: parts('你這垃圾 放晴天'), text: '你這垃圾 放晴天', ctx: ctxOf(member('100000000000000003')) });
    assert.ok(!declared().includes('timeout_insulter'));
  } finally {
    tools.timeoutList.remove(listed.id);
  }
});
