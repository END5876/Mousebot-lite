// handlers/ai/memeStore.js（精簡版專用）
// 人格專屬的表情包：AI 在回覆裡寫 [表情:關鍵詞]，送出時換成圖片附件。
//
// 圖庫放在資料目錄（跟 prompts 一樣不隨程式碼部署）：data/memes/<AI_PERSONA>/，兩種寫法可以並用：
//
//   1. 直接放圖：<名字>.png|jpg|jpeg|gif|webp，檔名（不含副檔名）就是名字；
//      memes.json 可以寫成 { "名字": "什麼時候用" } 補說明。
//   2. 套組清單：memes.json 寫成 { "stickers": [ { id, name, emotion, tags, use, url, hash } ] }，
//      圖片用到時才從 url 下載，快取在 .cache/<hash>.<副檔名>。
//      大肥魚表情包用 `node tools/importNekowhale.js` 產生（見 README）。
//
// 解析 [表情:關鍵詞]（兩邊先繁轉簡、英文轉小寫再比）：名字完全相同 → 情緒 → 標籤 → 名字／標籤／用途包含關鍵詞，同分的隨機挑，
// 最近送過的盡量避開。張數少（≤ INDEX_MODE_MAX）時 prompt 列出每一張；多的時候只列情緒與常用關鍵詞。
// 資料夾不存在或沒有圖時整個功能關閉。增刪檔案不用重啟（每 RELOAD_CHECK_MS 重新掃描）。
//
// 送出的附件檔名用 meme-<雜湊>.<副檔名>（Discord 會改掉非 ASCII 檔名），
// 讀歷史時再用雜湊查回名字，把 Bot 自己發過的表情包還原成 [表情:名字] 文字，不重新下載圖片。

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const { dataPath } = require('../../utils/dataDir');
const persona = require('./persona');
const T2S_PAIRS = require('./t2sTable');

const RELOAD_CHECK_MS  = 5000;
const IMAGE_EXTS       = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_PER_REPLY    = 1;                         // 一則回覆最多送幾張表情包
const MAX_FILE_BYTES   = 9.5 * 1024 * 1024;         // Discord 一般伺服器上傳上限 10MB
const INDEX_MODE_MAX   = 60;                        // 張數不超過這個數就在 prompt 列出每一張
const HINT_TAG_COUNT   = 40;                        // 張數多時 prompt 列出的常用關鍵詞數
const RECENT_AVOID     = 20;                        // 隨機挑選時避開最近送過的幾張
const DOWNLOAD_TIMEOUT_MS = 20_000;
const TAG_RE           = /[[［]\s*表情\s*[:：]\s*([^\]］\n]+?)\s*[\]］]/g;
const ATTACHMENT_RE    = /^meme-([0-9a-f]{10})\.[a-z0-9]+$/i;

/**
 * @typedef {object} Meme
 * @property {string} id       唯一鍵（附件雜湊用它算）
 * @property {string} name     給 AI 看的名字
 * @property {string} emotion
 * @property {string[]} tags
 * @property {string} use      什麼時候用
 * @property {string|null} file 本機圖檔（直接放圖）
 * @property {string|null} url  遠端圖檔（套組清單）
 * @property {string} ext
 * @property {string} hash     附件檔名用的 10 碼雜湊
 * @property {string} cacheKey 快取檔名
 */

const emptyCache = () => ({ dir: null, checkedAt: 0, list: [], index: [], byHash: new Map(), byName: new Map(), prompt: '' });
let cache = emptyCache();
const recent = [];
const inflight = new Map();

function memeDir() {
    return dataPath('memes', persona.getPersonaKey());
}

function hashId(id) {
    return crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
}

const clean = s => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

// 繁 → 簡單字對照（OpenCC TSCharacters）。表情包資料是簡體，模型跟著群組講繁體時會寫 [表情:摸魚]，
// 比對前兩邊都轉成簡體＋英文小寫，字形不同也對得到
const T2S = (() => {
    const chars = Array.from(T2S_PAIRS);
    const map = new Map();
    for (let i = 0; i + 1 < chars.length; i += 2) map.set(chars[i], chars[i + 1]);
    return map;
})();

/** 比對用的正規化：繁轉簡、英文轉小寫、去掉多餘空白 */
function normalize(s) {
    let out = '';
    for (const ch of clean(s)) out += T2S.get(ch) ?? ch;
    return out.toLowerCase();
}

function readManifest(dir) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'memes.json'), 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn('Meme', `memes.json 解析失敗：${err.message}`);
        return {};
    }
}

function fromKitEntry(s) {
    const name = clean(s?.name);
    const url  = typeof s?.url === 'string' && /^https:\/\//i.test(s.url) ? s.url : null;
    if (!name || !url) return null;
    const id  = clean(s.id) || name;
    const ext = (path.extname(new URL(url).pathname) || '.gif').toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return null;
    return {
        id, name, emotion: clean(s.emotion),
        tags: Array.isArray(s.tags) ? s.tags.map(clean).filter(Boolean) : [],
        use: clean(s.use), file: null, url, ext, hash: hashId(id),
        cacheKey: (/^[0-9a-f]{6,40}$/i.test(s.hash ?? '') ? s.hash : hashId(id)).toLowerCase(),
    };
}

function scan(dir) {
    const manifest = readManifest(dir);
    /** @type {Meme[]} */
    const list = [];
    const seenIds = new Set();
    const add = (m) => {
        if (!m || seenIds.has(m.id)) return;
        seenIds.add(m.id);
        list.push(m);
    };

    // 1. 直接放的圖片
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return list; }
    const descs = Array.isArray(manifest.stickers) ? {} : manifest;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        const name = path.basename(entry.name, path.extname(entry.name)).trim();
        if (!name) continue;
        const file = path.join(dir, entry.name);
        try {
            if (fs.statSync(file).size > MAX_FILE_BYTES) { logger.warn('Meme', `略過過大的表情包：${entry.name}`); continue; }
        } catch { continue; }
        add({ id: name, name, emotion: '', tags: [], use: clean(descs[name]), file, url: null, ext, hash: hashId(name), cacheKey: '' });
    }

    // 2. 套組清單
    if (Array.isArray(manifest.stickers)) {
        for (const s of manifest.stickers) add(fromKitEntry(s));
    }
    return list;
}

function buildPrompt(list) {
    if (list.length === 0) return '';
    const head = [
        '【表情包】你有一套自己的表情包。想配图时，在回复最后单独一行写 [表情:关键词]，系统会换成图片送出。',
        `- 你是群里爱斗图的那个，表情包要常用：闲聊、吐槽、得意、装傻、嘴馋、被夸、被怼都可以配一张，也可以只回一张表情包不打字。一则回复最多 ${MAX_PER_REPLY} 张。`,
        '- 只有认真讲解、写代码这种正经回答时才不配图。',
        '- 不要把 [表情:…] 的格式解释给别人听，也不要用文字描述图片内容。',
    ];
    if (list.length <= INDEX_MODE_MAX) {
        return [...head, '可用的表情包（关键词照抄名字）：', ...list.map(m => (m.use ? `- ${m.name}：${m.use}` : `- ${m.name}`))].join('\n');
    }
    const emotions = [...new Set(list.map(m => m.emotion).filter(e => e && e !== '其他'))];
    const tagCount = new Map();
    for (const m of list) for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const topTags = [...tagCount.entries()]
        .filter(([t]) => !emotions.includes(t))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, HINT_TAG_COUNT).map(([t]) => t);
    return [
        ...head,
        `- 共 ${list.length} 张，关键词写情绪或动作／场景，系统会挑一张最贴切的。`,
        emotions.length ? `情绪：${emotions.join('、')}` : '',
        topTags.length ? `常用关键词：${topTags.join('、')}` : '',
    ].filter(Boolean).join('\n');
}

function load() {
    const dir = memeDir();
    const now = Date.now();
    if (cache.dir === dir && now - cache.checkedAt < RELOAD_CHECK_MS) return cache;
    const prevSize = cache.dir === dir ? cache.list.length : -1;
    const list = scan(dir);
    cache = {
        dir, checkedAt: now, list,
        byHash: new Map(list.map(m => [m.hash, m])),
        // 比對用的正規化欄位（繁轉簡、小寫），掃描時算一次
        index: list.map(m => ({
            meme: m, name: normalize(m.name), emotion: normalize(m.emotion),
            tags: m.tags.map(normalize), use: normalize(m.use),
        })),
        byName: new Map(list.map(m => [normalize(m.name), m])),
        prompt: buildPrompt(list),
    };
    if (list.length !== prevSize && list.length > 0) logger.info('Meme', `已載入 ${list.length} 張表情包（${dir}）`);
    return cache;
}

function listMemes() {
    return load().list;
}

/** 放進 system instruction 的表情包說明；沒有圖庫時回傳空字串 */
function getMemePrompt() {
    return load().prompt;
}

function pickRandom(candidates) {
    if (candidates.length === 0) return null;
    const fresh = candidates.filter(m => !recent.includes(m.id));
    const pool = fresh.length ? fresh : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
}

/** 關鍵詞 → 一張表情包；找不到回傳 null */
function resolveMeme(keyword) {
    const q = normalize(keyword);
    if (!q) return null;
    const { index, byName } = load();
    if (byName.has(q)) return byName.get(q);
    const tiers = [
        e => e.emotion === q,
        e => e.tags.includes(q),
        e => e.name.includes(q) || e.tags.some(t => t.includes(q) || (t.length >= 2 && q.includes(t))) || e.use.includes(q),
    ];
    for (const match of tiers) {
        const hit = pickRandom(index.filter(match).map(e => e.meme));
        if (hit) return hit;
    }
    return null;
}

function remember(meme) {
    recent.push(meme.id);
    while (recent.length > RECENT_AVOID) recent.shift();
}

/**
 * 從 AI 回覆抽出 [表情:關鍵詞]：標記一律從文字移除，認得的前 MAX_PER_REPLY 張留下。
 * @param {string} text
 * @returns {{ text: string, memes: Meme[] }}
 */
function extractMemes(text) {
    if (typeof text !== 'string' || !text) return { text: text ?? '', memes: [] };
    const memes = [];
    const unknown = [];
    const cleaned = text.replace(TAG_RE, (_, keyword) => {
        if (memes.length < MAX_PER_REPLY) {
            const meme = resolveMeme(keyword);
            if (meme && !memes.includes(meme)) { memes.push(meme); remember(meme); }
            else if (!meme) unknown.push(keyword.trim());
        }
        return '';
    });
    if (unknown.length) logger.info('Meme', `找不到表情包：${unknown.join('、')}`);
    const tidy = cleaned
        .split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text: tidy, memes };
}

async function download(meme) {
    const target = path.join(memeDir(), '.cache', `${meme.cacheKey}${meme.ext}`);
    try {
        if (fs.statSync(target).size > 0) return target;
    } catch { /* 還沒快取 */ }
    if (inflight.has(target)) return inflight.get(target);

    const job = (async () => {
        const res = await fetch(meme.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_FILE_BYTES) throw new Error(`大小不合（${buf.length} bytes）`);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, target);
        logger.debug('Meme', `已下載：${meme.name}`);
        return target;
    })().finally(() => inflight.delete(target));
    inflight.set(target, job);
    return job;
}

/**
 * 表情包 → Discord 附件；遠端的先下載（失敗就略過那張，不影響文字回覆）
 * @param {Meme[]} memes
 * @returns {Promise<{ attachment: string, name: string }[]>}
 */
async function toFiles(memes) {
    const files = await Promise.all(memes.map(async (meme) => {
        try {
            const file = meme.file ?? await download(meme);
            return { attachment: file, name: `meme-${meme.hash}${meme.ext}` };
        } catch (err) {
            logger.warn('Meme', `表情包「${meme.name}」下載失敗：${err.message}`);
            return null;
        }
    }));
    return files.filter(Boolean);
}

/** Bot 自己發的附件是不是表情包：不是回傳 undefined；是的話回傳名字（雜湊對不到時回傳 null） */
function memeTagOfAttachment(attachment) {
    const m = ATTACHMENT_RE.exec(attachment?.name ?? '');
    if (!m) return undefined;
    return load().byHash.get(m[1].toLowerCase())?.name ?? null;
}

/**
 * 把回覆切塊與表情包附件組成要依序送出的 payload：附件跟在最後一塊文字上，沒有文字就單獨送圖。
 * @param {string[]} chunks
 * @param {{ attachment: string, name: string }[]} [files]
 */
function buildPayloads(chunks, files = []) {
    const payloads = chunks.filter(c => c && c.trim()).map(content => ({ content }));
    if (files.length > 0) {
        if (payloads.length > 0) payloads[payloads.length - 1].files = files;
        else payloads.push({ files });
    }
    return payloads;
}

module.exports = {
    listMemes,
    getMemePrompt,
    resolveMeme,
    extractMemes,
    toFiles,
    memeTagOfAttachment,
    buildPayloads,
    MAX_PER_REPLY,
    _internal: {
        hashId,
        normalize,
        resetCache: () => { cache = emptyCache(); recent.length = 0; },
        INDEX_MODE_MAX,
    },
};
