'use strict';

// 人格表情包（memeStore.js）：讀圖庫、組 prompt、解析 [表情:關鍵詞]、還原歷史裡的表情包附件。
// 資料目錄指到暫存資料夾，不碰正式的 data/；不打網路（套組只測解析，不測下載）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-lite-meme-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
process.env.AI_PERSONA = 'bigfish';

const memeStore = require('../handlers/ai/memeStore');
const { buildSystemInstruction, _internal } = require('../handlers/ai/aiCore');

const DIR = path.join(TMP, 'memes', 'bigfish');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
});

function reset(files = {}) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(DIR, name), content);
  memeStore._internal.resetCache();
}

function kit(stickers) {
  return JSON.stringify({ stickers });
}

const KIT = [
  { id: 'p/1N01_摸鱼', name: '摸鱼', emotion: '开心', tags: ['偷懒', '摸鱼'], use: '上班偷懒时', url: 'https://example.com/a.gif', hash: 'aaaaaaaaaaaa' },
  { id: 'p/1N02_吃瓜', name: '吃瓜', emotion: '其他', tags: ['围观'], use: '看热闹', url: 'https://example.com/b.gif', hash: 'bbbbbbbbbbbb' },
  { id: 'p/1N03_生气', name: '我要咬他', emotion: '生气', tags: ['别惹我'], use: '', url: 'https://example.com/c.gif', hash: 'cccccccccccc' },
  { id: 'p/bad', name: '沒有網址', emotion: '开心', tags: [] },
  { id: 'p/http', name: '不是https', url: 'http://example.com/d.gif' },
];

test('沒有圖庫：prompt 不加東西，標記照樣被移除', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  memeStore._internal.resetCache();
  assert.equal(memeStore.getMemePrompt(), '');
  assert.ok(!buildSystemInstruction().includes('【表情包】'));
  assert.deepEqual(memeStore.extractMemes('哈哈\n[表情:嘴饞]'), { text: '哈哈', memes: [] });
});

test('直接放圖：只收圖片檔，張數少時 prompt 逐張列出', () => {
  reset({ '嘴饞.png': 'x', '得意.gif': 'x', 'notes.txt': 'x', 'memes.json': JSON.stringify({ 嘴饞: '看到吃的' }) });
  assert.deepEqual(memeStore.listMemes().map(m => m.name).sort(), ['嘴饞', '得意'].sort());
  const prompt = memeStore.getMemePrompt();
  assert.match(prompt, /- 嘴饞：看到吃的/);
  assert.match(prompt, /- 得意$/m);
  assert.ok(buildSystemInstruction().includes('【表情包】'));
});

test('extractMemes＋toFiles：本機圖直接當附件、最多一張、全形括號也接受', async () => {
  reset({ '嘴饞.png': 'x', '得意.gif': 'x' });
  const r = memeStore.extractMemes('好餓\n［表情：嘴饞］\n[表情:得意]\n[表情:不存在]');
  assert.equal(r.text, '好餓');
  assert.deepEqual(r.memes.map(m => m.name), ['嘴饞']);
  const files = await memeStore.toFiles(r.memes);
  assert.equal(files[0].attachment, path.join(DIR, '嘴饞.png'));
  assert.match(files[0].name, /^meme-[0-9a-f]{10}\.png$/);

  const only = memeStore.extractMemes('[表情:得意]');
  assert.equal(only.text, '');
  assert.equal(only.memes.length, 1);
});

test('套組清單：略過沒網址／非 https 的項目，依名字 → 情緒 → 標籤 → 包含 解析', () => {
  reset({ 'memes.json': kit(KIT) });
  assert.deepEqual(memeStore.listMemes().map(m => m.name), ['摸鱼', '吃瓜', '我要咬他']);
  assert.equal(memeStore.resolveMeme('吃瓜').name, '吃瓜');          // 名字
  assert.equal(memeStore.resolveMeme('生气').name, '我要咬他');      // 情緒
  assert.equal(memeStore.resolveMeme('围观').name, '吃瓜');          // 標籤
  assert.equal(memeStore.resolveMeme('偷懒时').name, '摸鱼');        // 用途包含
  assert.equal(memeStore.resolveMeme('完全沒有'), null);
});

test('繁體關鍵詞先轉簡體再比對；英文不分大小寫', () => {
  assert.equal(memeStore._internal.normalize(' 摸魚 開心 生氣 ABC '), '摸鱼 开心 生气 abc');
  reset({ 'memes.json': kit(KIT) });
  assert.equal(memeStore.resolveMeme('摸魚').name, '摸鱼');          // 名字
  assert.equal(memeStore.resolveMeme('生氣').name, '我要咬他');      // 情緒
  assert.equal(memeStore.resolveMeme('圍觀').name, '吃瓜');          // 標籤
  assert.equal(memeStore.resolveMeme('偷懶時').name, '摸鱼');        // 用途包含
  const r = memeStore.extractMemes('笑死\n[表情:摸魚]');
  assert.deepEqual(r.memes.map(m => m.name), ['摸鱼']);
});

test('圖庫網站連不上：改送同情緒、已快取的圖；之後一段時間不再連線', async () => {
  const down = 'https://127.0.0.1:1/x.gif';          // 連不上的位址，不打外部網路
  reset({
    'memes.json': kit([
      { id: 'p/a', name: '没下载过', emotion: '开心', url: down, hash: '111111111111' },
      { id: 'p/b', name: '已快取', emotion: '开心', url: down, hash: '222222222222' },
      { id: 'p/c', name: '别的情绪', emotion: '生气', url: down, hash: '333333333333' },
    ]),
  });
  fs.mkdirSync(path.join(DIR, '.cache'));
  fs.writeFileSync(path.join(DIR, '.cache', '222222222222.gif'), 'gif');

  const [file] = await memeStore.toFiles([memeStore.resolveMeme('没下载过')]);
  assert.equal(file.attachment, path.join(DIR, '.cache', '222222222222.gif'));

  // 同情緒沒有快取 → 不送圖；而且退避期間不再嘗試下載（立刻回來）
  const t0 = Date.now();
  assert.deepEqual(await memeStore.toFiles([memeStore.resolveMeme('别的情绪')]), []);
  assert.ok(Date.now() - t0 < 1000);
});

test('套組很多張時 prompt 只列情緒與常用關鍵詞', () => {
  const many = Array.from({ length: memeStore._internal.INDEX_MODE_MAX + 1 }, (_, i) => ({
    id: `p/${i}`, name: `图${i}`, emotion: i % 2 ? '开心' : '生气', tags: ['摸鱼'], url: `https://example.com/${i}.gif`,
  }));
  reset({ 'memes.json': kit(many) });
  const prompt = memeStore.getMemePrompt();
  assert.match(prompt, /情绪：.*开心/);
  assert.match(prompt, /常用关键词：摸鱼/);
  assert.ok(!prompt.includes('图0'));
});

test('buildPayloads：附件跟在最後一塊，沒文字就單獨送圖', () => {
  const files = [{ attachment: 'a', name: 'meme-x.png' }];
  assert.deepEqual(memeStore.buildPayloads(['一', '二'], files), [{ content: '一' }, { content: '二', files }]);
  assert.deepEqual(memeStore.buildPayloads([], files), [{ files }]);
  assert.deepEqual(memeStore.buildPayloads(['一']), [{ content: '一' }]);
});

test('歷史：Bot 的表情包附件還原成名字，其他附件照舊', () => {
  reset({ 'memes.json': kit(KIT) });
  const hash = memeStore._internal.hashId('p/1N01_摸鱼');
  const attachments = new Map([
    ['1', { name: `meme-${hash}.gif` }],
    ['2', { name: 'meme-ffffffffff.png' }],
    ['3', { name: 'photo.png' }],
  ]);
  const bot = _internal.splitMemeAttachments({ author: { id: 'BOT' }, attachments }, 'BOT');
  assert.deepEqual(bot.memeTags, ['[表情:摸鱼]', '[表情包]']);
  assert.deepEqual([...bot.attachments.keys()], ['3']);

  const human = _internal.splitMemeAttachments({ author: { id: 'U' }, attachments }, 'BOT');
  assert.equal(human.attachments, attachments);
  assert.deepEqual(human.memeTags, []);
});
