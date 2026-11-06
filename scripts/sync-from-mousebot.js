#!/usr/bin/env node
'use strict';

// 從正式版 Mousebot（上游）同步共用檔到精簡版。只用 node 內建模組，CI 不必先 npm ci。
//
//   node scripts/sync-from-mousebot.js            複製 sync.json 列的共用檔，完成後把 upstream.ref 更新成上游的 HEAD
//   node scripts/sync-from-mousebot.js --check    只比對不寫入，有差異就以非 0 結束
//   node scripts/sync-from-mousebot.js --init     依上游 roots 底下的檔案重新產生 files 清單
//
// 其他參數：
//   --from <dir>     上游目錄（預設 sync.json 的 upstream.path，相對於精簡版根目錄）
//   --to <dir>       精簡版目錄（預設本腳本所在 repo 的根目錄；sync.json 從這裡讀）
//   --allow-dirty    上游清單內的檔案有還沒 commit 的修改時照樣複製（ref 之後要再補）
//
// 規則：
//   - 比對和寫入前一律把 CRLF 轉成 LF（含 NUL 位元組的檔案視為二進位，原樣比對）。
//   - files：兩邊逐位元組相同的共用檔。mbOnly：只在上游。liteOwned：精簡版自己擁有，不同步。
//   - mbOnly／liteOwned 可用 glob（* 不跨目錄、** 可跨目錄）。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { builtinModules } = require('module');

const SKIP_DIRS = new Set(['node_modules', '.git']);

function parseArgs(argv) {
  const opts = { from: null, to: null, check: false, init: false, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--init') opts.init = true;
    else if (a === '--allow-dirty') opts.allowDirty = true;
    else if (a === '--from' || a === '--to') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} 後面要接目錄`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--from=')) opts.from = a.slice(7);
    else if (a.startsWith('--to=')) opts.to = a.slice(5);
    else throw new Error(`不認得的參數：${a}`);
  }
  if (opts.check && opts.init) throw new Error('--check 和 --init 不能同時使用');
  return opts;
}

// ── 路徑與 glob ──────────────────────────────────────────

const toPosix = (p) => p.split(path.sep).join('/');

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matcher(patterns) {
  const exact = new Set();
  const globs = [];
  for (const p of patterns || []) {
    if (/[*?]/.test(p)) globs.push(globToRegExp(p));
    else exact.add(p);
  }
  return (rel) => exact.has(rel) || globs.some((re) => re.test(rel));
}

// roots 底下所有檔案（相對路徑、POSIX 斜線），略過 node_modules／.git
function walkRoots(base, roots) {
  const out = [];
  const visit = (absDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.isFile()) out.push(toPosix(path.relative(base, abs)));
    }
  };
  for (const root of roots) visit(path.join(base, root));
  return [...new Set(out)].sort();
}

const underRoots = (rel, roots) => roots.some((r) => rel.startsWith(r.endsWith('/') ? r : `${r}/`));

// ── 內容 ────────────────────────────────────────────────

function readNormalized(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (buf.includes(0)) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

const exists = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };

// 共用檔 require／import 的外部套件名稱
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
function packagesOf(source) {
  const names = new Set();
  const re = /\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bfrom\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    const spec = m[1] || m[2] || m[3];
    if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec) || spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!BUILTINS.has(name)) names.add(name);
  }
  return names;
}

// ── sync.json ───────────────────────────────────────────

function loadConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['roots', 'files', 'mbOnly', 'liteOwned']) {
    if (!Array.isArray(cfg[key])) throw new Error(`sync.json 缺少陣列 ${key}`);
  }
  if (!cfg.upstream || typeof cfg.upstream !== 'object') throw new Error('sync.json 缺少 upstream');
  return cfg;
}

function saveConfig(file, cfg) {
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

// ── 比對 ────────────────────────────────────────────────

function collectProblems(cfg, from, to) {
  const isMbOnly = matcher(cfg.mbOnly);
  const isLiteOwned = matcher(cfg.liteOwned);
  const shared = new Set(cfg.files);
  const problems = { config: [], differ: [], missing: [], mbUnlisted: [], liteUnlisted: [], packages: [] };

  for (const rel of cfg.files) {
    if (isMbOnly(rel)) problems.config.push(`${rel} 同時列在 files 和 mbOnly`);
    if (isLiteOwned(rel)) problems.config.push(`${rel} 同時列在 files 和 liteOwned`);
  }

  // (a)(b) 共用檔
  for (const rel of cfg.files) {
    const a = readNormalized(path.join(from, rel));
    const b = readNormalized(path.join(to, rel));
    if (a === null) problems.missing.push(`${rel}（上游沒有）`);
    if (b === null) problems.missing.push(`${rel}（精簡版沒有）`);
    if (a !== null && b !== null && !a.equals(b)) problems.differ.push(rel);
  }
  // (b) liteOwned 的明確檔名要存在於精簡版
  for (const rel of cfg.liteOwned) {
    if (!/[*?]/.test(rel) && !exists(path.join(to, rel))) problems.missing.push(`${rel}（liteOwned，精簡版沒有）`);
  }

  // (c) 上游 roots 底下沒歸類的檔案
  for (const rel of walkRoots(from, cfg.roots)) {
    if (!shared.has(rel) && !isMbOnly(rel)) problems.mbUnlisted.push(rel);
  }
  // (d) 精簡版 roots 底下沒歸類的檔案
  for (const rel of walkRoots(to, cfg.roots)) {
    if (!shared.has(rel) && !isLiteOwned(rel)) problems.liteUnlisted.push(rel);
  }

  // (e) 共用檔用到、精簡版 package.json 沒列的套件（以上游內容為準，因為同步後就是它）
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(to, 'package.json'), 'utf8')); } catch {}
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const users = new Map();
  for (const rel of cfg.files) {
    if (!/\.(c|m)?js$/.test(rel)) continue;
    const content = readNormalized(path.join(from, rel)) ?? readNormalized(path.join(to, rel));
    if (!content) continue;
    for (const name of packagesOf(content.toString('utf8'))) {
      if (declared.has(name)) continue;
      if (!users.has(name)) users.set(name, []);
      users.get(name).push(rel);
    }
  }
  for (const [name, files] of [...users].sort()) problems.packages.push(`${name}（${files.join('、')}）`);

  return problems;
}

const SECTIONS = [
  ['config', 'sync.json 設定矛盾'],
  ['differ', '(a) 共用檔內容不同'],
  ['missing', '(b) 清單裡的檔案不存在'],
  ['mbUnlisted', '(c) 上游 roots 底下沒歸類到 files 或 mbOnly'],
  ['liteUnlisted', '(d) 精簡版 roots 底下沒歸類到 files 或 liteOwned'],
  ['packages', '(e) 共用檔用到、精簡版 package.json 沒列的套件'],
];

function report(problems) {
  let total = 0;
  for (const [key, title] of SECTIONS) {
    const list = problems[key];
    if (!list.length) continue;
    total += list.length;
    process.stdout.write(`\n${title}（${list.length}）：\n${list.map((x) => `  - ${x}`).join('\n')}\n`);
  }
  return total;
}

// ── git ─────────────────────────────────────────────────

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function dirtyFiles(from, files) {
  const out = [];
  // 分批，避免 Windows 命令列過長
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    const text = git(from, ['status', '--porcelain', '--untracked-files=all', '--', ...chunk]);
    for (const line of text.split('\n')) if (line.trim()) out.push(line.trim());
  }
  return out;
}

// ── 主程式 ──────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const to = path.resolve(opts.to ?? path.join(__dirname, '..'));
  const configFile = path.join(to, 'sync.json');
  const cfg = loadConfig(configFile);
  const from = opts.from ? path.resolve(opts.from) : path.resolve(to, cfg.upstream.path || '../Mousebot');
  if (!fs.existsSync(from)) throw new Error(`找不到上游目錄：${from}`);

  if (opts.init) {
    const isMbOnly = matcher(cfg.mbOnly);
    const isLiteOwned = matcher(cfg.liteOwned);
    // roots 外的共用檔（eslint.config.js 等）沿用原本清單
    const extras = cfg.files.filter((rel) => !underRoots(rel, cfg.roots));
    const scanned = walkRoots(from, cfg.roots).filter((rel) => !isMbOnly(rel) && !isLiteOwned(rel));
    const before = new Set(cfg.files);
    cfg.files = [...new Set([...scanned, ...extras])].sort();
    saveConfig(configFile, cfg);
    const added = cfg.files.filter((f) => !before.has(f));
    const removed = [...before].filter((f) => !cfg.files.includes(f));
    process.stdout.write(`已產生 files：${cfg.files.length} 個（新增 ${added.length}、移除 ${removed.length}）\n`);
    for (const f of added) process.stdout.write(`  + ${f}\n`);
    for (const f of removed) process.stdout.write(`  - ${f}\n`);
    return 0;
  }

  if (opts.check) {
    const total = report(collectProblems(cfg, from, to));
    if (total) {
      process.stdout.write(`\n同步檢查失敗：${total} 項（上游 ${from}）\n`);
      return 1;
    }
    process.stdout.write(`同步檢查通過：${cfg.files.length} 個共用檔與上游一致\n`);
    return 0;
  }

  // 複製模式
  let head = null;
  let dirty = [];
  try { head = git(from, ['rev-parse', 'HEAD']).trim(); } catch {}
  if (head) {
    dirty = dirtyFiles(from, cfg.files);
    if (dirty.length && !opts.allowDirty) {
      process.stdout.write(`上游有 ${dirty.length} 個清單內的檔案還沒 commit，ref 不會指向這些內容：\n`);
      process.stdout.write(`${dirty.map((x) => `  ${x}`).join('\n')}\n先在上游 commit，或加 --allow-dirty。\n`);
      return 1;
    }
    if (dirty.length) process.stdout.write(`注意：上游有 ${dirty.length} 個清單內的檔案還沒 commit（--allow-dirty），upstream.ref 維持不變；上游 commit 後要再跑一次 npm run sync 更新 ref\n`);
  } else {
    process.stdout.write('注意：上游不是 git repo 或讀不到 HEAD，upstream.ref 不更新\n');
  }

  let written = 0;
  for (const rel of cfg.files) {
    const src = readNormalized(path.join(from, rel));
    if (src === null) continue; // 交給下面的檢查列出
    const dest = path.join(to, rel);
    const cur = readNormalized(dest);
    if (cur !== null && cur.equals(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
    written++;
    process.stdout.write(`  更新 ${rel}\n`);
  }
  process.stdout.write(`已複製 ${written} 個檔案（共 ${cfg.files.length} 個共用檔）\n`);

  // 上游還有沒 commit 的共用檔時不更新 ref：ref 必須指向「真的含有這些內容」的 commit，CI 才比對得過
  if (head && !dirty.length && head !== cfg.upstream.ref) {
    cfg.upstream.ref = head;
    saveConfig(configFile, cfg);
    process.stdout.write(`upstream.ref → ${head}\n`);
  }

  const total = report(collectProblems(cfg, from, to));
  if (total) {
    process.stdout.write(`\n複製完成，但還有 ${total} 項要手動處理（見上方）\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`sync-from-mousebot：${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, globToRegExp, matcher, packagesOf, collectProblems, walkRoots };
