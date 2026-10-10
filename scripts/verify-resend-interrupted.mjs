#!/usr/bin/env node
// scripts/verify-resend-interrupted.mjs —— v2.3.102 需求 1「打断后重发」的回归门
//
// 这个脚本防的是什么（都是"无红绿灯"时最难发现、上线才炸的回归）：
//   1) keepAnchor 参数被误删 / 默认值被改成 true → 普通回滚 / 修改重发不再删锚点消息（静默语义漂移）；
//   2) 有人"顺手"给现有 rollbackMessages 调用点补了第 5 个实参 → 既有回滚行为被改写；
//   3) interrupted 标记被写到非打断分支（正常消息也长出重发按钮）或漏写（打断后按钮不出现）；
//   4) regenerateReply handler 的执行顺序被改乱（先删后校验 → 锚点不存在时白删一堆消息）；
//   5) handleStream 的重生成通道被"优化"掉（skipUserMessage 失效 → 重发变成多发 / 不复用锚点）；
//   6) IPC 三处契约（preload / src/ipc.ts / main.ts）通道名漂移 → renderer 调用无响应；
//   7) chats:stream 不再透明透传 p → 前端重生成走不通。
//
// 断言读的是**真源码文本**（不是平行重写的影子实现）。用 stripComments 把注释替换成等长空格，
// 既对注释免疫，又保留列位，从而行号可精确回溯。
//
// 可证伪性（作用于读进内存的源码文本，**不改磁盘**）：
//   NY_RESEND_NO_KEEP=1  破坏 electron/db.ts 的 keepAnchor 三元        → 应红（G1.2）
//   NY_RESEND_NO_SKIP=1  破坏 electron/main.ts 的 skipUserMessage 三元 → 应红（G5.3 / G7.2）
//
// 用法：node scripts/verify-resend-interrupted.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const readRaw = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 把注释整行替换为空串（保留行数 → 行号不变）。
 *  采用**按行**处理（而非全文件状态机）：整行 `//` 与块注释 `/* *\/` 跨行跟踪；
 *  行尾 `//` 注释也剥掉（但保留 `://` 里的 `//`，避免误伤 URL 字符串）。
 *  选择按行的原因：本仓库 main.ts 含大量嵌套模板字面量（`` `${map(k=>`${k}`)}` ``）
 *  与 CRLF 行尾，全文件字符状态机极易失步，反而把「注释里的示例代码」当成真代码。 */
function stripComments(src) {
  const lines = src.split('\n');
  const out = [];
  let inBlock = false;
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) { out.push(''); continue; }
      inBlock = false;
      line = line.slice(end + 2);
      if (line.trim() === '') { out.push(''); continue; }
    }
    const t = line.trim();
    if (t.startsWith('//')) { out.push(''); continue; }
    if (t.startsWith('/*')) {
      const end = line.indexOf('*/', line.indexOf('/*'));
      if (end < 0) { inBlock = true; out.push(''); continue; }
      line = line.slice(end + 2);
      if (line.trim() === '') { out.push(''); continue; }
    }
    // 行尾 `//` 注释（保护 `://`）
    const m = line.match(/(^|[^:])\/\//);
    if (m) line = line.slice(0, line.indexOf('//', m.index));
    out.push(line);
  }
  return out.join('\n');
}
function lineOf(text, idx) { return idx < 0 ? -1 : text.slice(0, idx).split('\n').length; }
/** 从 openIdx（须指向 open 字符）做括号配平，返回匹配 close 的下标 */
function matchPair(text, openIdx, open, close) {
  let depth = 0;
  let st = 0;
  for (let i = openIdx; i >= 0 && i < text.length; i++) {
    const c = text[i];
    if (st) { if (c === '\\') { i++; continue; } if ((st === 1 && c === "'") || (st === 2 && c === '"') || (st === 3 && c === '`')) st = 0; continue; }
    if (c === "'") { st = 1; continue; }
    if (c === '"') { st = 2; continue; }
    if (c === '`') { st = 3; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/** 统计一段实参文本里的**顶层**逗号参数个数（跳过 () [] {} 与字符串） */
function countTopLevelArgs(inner) {
  let depth = 0;
  let args = 0;
  let hasToken = false;
  let st = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (st) { if (c === '\\') { i++; continue; } if ((st === 1 && c === "'") || (st === 2 && c === '"') || (st === 3 && c === '`')) st = 0; continue; }
    if (c === "'") { st = 1; hasToken = true; continue; }
    if (c === '"') { st = 2; hasToken = true; continue; }
    if (c === '`') { st = 3; hasToken = true; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; hasToken = true; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (c === ',' && depth === 0) { args++; continue; }
    if (!/\s/.test(c)) hasToken = true;
  }
  return hasToken ? args + 1 : 0;
}
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ──────────────────────────── 读真源码（含破坏开关） ────────────────────────────
const BREAK_KEEP = process.env.NY_RESEND_NO_KEEP === '1';
const BREAK_SKIP = process.env.NY_RESEND_NO_SKIP === '1';
if (BREAK_KEEP || BREAK_SKIP) {
  const on = [BREAK_KEEP && 'NY_RESEND_NO_KEEP', BREAK_SKIP && 'NY_RESEND_NO_SKIP'].filter(Boolean).join(', ');
  console.log(`⚠️  破坏开关已启用：${on}（脚本应当变红并 exit 1）`);
}

let dbRaw = readRaw('electron/db.ts');
let mainRaw = readRaw('electron/main.ts');
const preloadRaw = readRaw('electron/preload.ts');
const ipcRaw = readRaw('src/ipc.ts');

if (BREAK_KEEP) {
  const before = dbRaw;
  dbRaw = dbRaw.replace('keepAnchor ? m.id > fromMsgId : m.id >= fromMsgId', 'm.id >= fromMsgId');
  if (dbRaw === before) console.log('   （NY_RESEND_NO_KEEP 未命中任何文本，破坏可能无效）');
}
if (BREAK_SKIP) {
  const before = mainRaw;
  mainRaw = mainRaw.replace(
    /const userMsg = p\.skipUserMessage[\s\S]*?:\s*addUserMessage\(p\);/,
    'const userMsg = addUserMessage(p);'
  );
  if (mainRaw === before) console.log('   （NY_RESEND_NO_SKIP 未命中任何文本，破坏可能无效）');
}

const db = stripComments(dbRaw);
const main = stripComments(mainRaw);
const preload = stripComments(preloadRaw);
const ipc = stripComments(ipcRaw);

// 供跨段复用的解析结果
let streamArgs = '';
let hsBody = '';

// ──────────────────────────── G1 ────────────────────────────
section('G1 keepAnchor 语义与默认值（electron/db.ts）');
{
  const m1 = db.match(/rollbackMessages\([^)]*keepAnchor\s*=\s*false\s*\)/);
  check('G1.1 签名第 5 参 keepAnchor 默认值为 false（既有调用点行为不变的前提）', !!m1,
    m1 ? '' : '未找到 `keepAnchor = false`（默认值缺失或被改成 true）');
  const m2 = db.match(/keepAnchor\s*\?\s*m\.id\s*>\s*fromMsgId\s*:\s*m\.id\s*>=\s*fromMsgId/);
  check('G1.2 过滤条件为 keepAnchor 守护的三元（true→> 保留锚点 / false→>= 现有语义）', !!m2,
    m2 ? `位于 db.ts:${lineOf(db, db.indexOf('keepAnchor ?'))}` : '三元形态不符（期望 `keepAnchor ? m.id > fromMsgId : m.id >= fromMsgId`）');
}

// ──────────────────────────── G2 ────────────────────────────
section('G2 现有 rollbackMessages 调用点未被污染');
{
  const files = [...walk(path.join(ROOT, 'electron')), ...walk(path.join(ROOT, 'src'))];
  const sites = [];
  for (const abs of files) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const re = /rollbackMessages\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const idx = m.index;
      const lineStart = code.lastIndexOf('\n', idx) + 1;
      const prefix = code.slice(lineStart, idx);
      if (prefix.trim() === '') continue; // electron/db.ts 内的定义行（无接收者前缀）
      const openIdx = idx + 'rollbackMessages'.length;
      const closeIdx = matchPair(code, openIdx, '(', ')');
      const inner = closeIdx > openIdx ? code.slice(openIdx + 1, closeIdx) : '';
      sites.push({
        file: rel(abs),
        line: lineOf(code, idx),
        args: countTopLevelArgs(inner),
        text: code.slice(idx, closeIdx + 1).replace(/\s+/g, ' '),
      });
    }
  }
  for (const s of sites) console.log(`   · ${s.file}:${s.line}  args=${s.args}  ${s.text.slice(0, 76)}`);
  const over4 = sites.filter((s) => s.args > 4);
  check('G2.1 恰有 1 个调用点传了 keepAnchor（第 5 实参）', over4.length === 1,
    `实为 ${over4.length} 个：${over4.map((s) => s.file + ':' + s.line).join(', ')}`);
  check('G2.2 该调用点实参为 (..., fromUserMsgId, true, true)',
    over4.length === 1 && /fromUserMsgId\s*,\s*true\s*,\s*true/.test(over4[0].text),
    over4.length === 1 ? over4[0].text : '');
  const othersLe4 = sites.filter((s) => !over4.includes(s)).every((s) => s.args <= 4);
  check('G2.3 其余调用点实参数 ≤ 4（均未传 keepAnchor，普通回滚/修改重发行为不变）', othersLe4,
    sites.filter((s) => !over4.includes(s) && s.args > 4).map((s) => `${s.file}:${s.line}`).join(', '));
  check('G2.4 至少扫到 4 个调用点（防止正则失配导致 G2 空转假通过）', sites.length >= 4, `实为 ${sites.length} 个`);
}

// ──────────────────────────── G3 ────────────────────────────
section('G3 interrupted 只在打断分支置真（electron/main.ts）');
{
  const c1 = (main.match(/interrupted\s*:\s*true\b/g) || []).length;
  const c2 = (main.match(/interrupted\s*:\s*interrupted\s*\?\s*true\s*:\s*undefined/g) || []).length;
  const cBad = (main.match(/interrupted\s*:\s*(?:!0\b|1\b|true\s*\|\|)/g) || []).length +
    (main.match(/interrupted\s*\|\|\s*true/g) || []).length;
  check('G3.1 `interrupted: true` 恰出现 1 次（非流式 catch 分支）', c1 === 1, `实为 ${c1} 次`);
  check('G3.2 `interrupted: interrupted ? true : undefined` 恰出现 1 次（finalizeRole）', c2 === 1, `实为 ${c2} 次`);
  check('G3.3 不存在第 3 处把 interrupted 置真的写法（!0 / 1 / || true）', cBad === 0, `命中 ${cBad} 处`);
  const frIdx = main.indexOf('const finalizeRole =');
  check('G3.4 finalizeRole 的 addMessage 读形参 interrupted（非恒真）',
    frIdx >= 0 && /interrupted\s*:\s*interrupted\s*\?/.test(main.slice(frIdx, frIdx + 1400)),
    frIdx >= 0 ? `finalizeRole@main.ts:${lineOf(main, frIdx)}` : '未找到 finalizeRole');
}

// ──────────────────────────── G4 ────────────────────────────
section('G4 regenerateReply handler 执行顺序（electron/main.ts）');
{
  const hIdx = main.indexOf("'messages:regenerateReply'");
  check('G4.0 存在 messages:regenerateReply handler', hIdx >= 0,
    hIdx >= 0 ? `main.ts:${lineOf(main, hIdx)}` : '未找到');
  let iFind = -1, iMiss = -1, iAbort = -1, iRollback = -1, iStream = -1;
  if (hIdx >= 0) {
    const arrow = main.indexOf('=>', hIdx);
    const bodyOpen = arrow >= 0 ? main.indexOf('{', arrow) : -1;
    const bodyClose = bodyOpen >= 0 ? matchPair(main, bodyOpen, '{', '}') : -1;
    const body = bodyOpen >= 0 && bodyClose > bodyOpen ? main.slice(bodyOpen, bodyClose + 1) : '';
    iFind = body.indexOf('find(');
    iMiss = body.indexOf('anchor-missing');
    iAbort = body.indexOf('abortStreamsForChat(');
    iRollback = body.indexOf('rollbackMessages(');
    iStream = body.indexOf('handleStream(');
    if (iStream >= 0) {
      const so = body.indexOf('(', iStream);
      const sc = matchPair(body, so, '(', ')');
      streamArgs = sc > so ? body.slice(so + 1, sc) : '';
    }
    check('G4.1 顺序：find(校验) < abortStreamsForChat < rollbackMessages < handleStream',
      iFind >= 0 && iAbort >= 0 && iRollback >= 0 && iStream >= 0 &&
        iFind < iAbort && iAbort < iRollback && iRollback < iStream,
      `下标 find=${iFind} abort=${iAbort} rollback=${iRollback} stream=${iStream}`);
    check('G4.2 anchor-missing 早退出现在 rollbackMessages 之前（锚点不存在时不白删）',
      iMiss >= 0 && iMiss < iRollback, `anchor-missing@${iMiss} rollbackMessages@${iRollback}`);
    check('G4.3 handler 内 `await handleStream(...)` 且参数含 skipUserMessage: true',
      /await\s+handleStream\(/.test(body) && /skipUserMessage\s*:\s*true/.test(streamArgs));
  } else {
    check('G4.1 顺序：find(校验) < abortStreamsForChat < rollbackMessages < handleStream', false, 'handler 缺失');
    check('G4.2 anchor-missing 早退出现在 rollbackMessages 之前', false, 'handler 缺失');
    check('G4.3 handler 内 await handleStream(...) 参数含 skipUserMessage: true', false, 'handler 缺失');
  }
}

// ──────────────────────────── G5 ────────────────────────────
section('G5 handleStream 的重生成通道（electron/main.ts）');
{
  const hsOpen = main.indexOf('async function handleStream(');
  let sig = '';
  if (hsOpen >= 0) {
    const pOpen = main.indexOf('(', hsOpen);
    const pClose = matchPair(main, pOpen, '(', ')');
    sig = main.slice(pOpen, pClose + 1);
    const tOpen = main.indexOf('{', pClose);          // 返回类型 Promise<{...}> 的 {
    const tClose = matchPair(main, tOpen, '{', '}');
    const bOpen = main.indexOf('{', tClose);           // 函数体 {
    const bClose = matchPair(main, bOpen, '{', '}');
    hsBody = bOpen >= 0 && bClose > bOpen ? main.slice(bOpen, bClose + 1) : '';
  }
  check('G5.1 入参类型含 `skipUserMessage?: boolean`', /skipUserMessage\s*\?\s*:\s*boolean/.test(sig));
  check('G5.2 入参类型含 `anchorUserMsgId?: number`', /anchorUserMsgId\s*\?\s*:\s*number/.test(sig));
  check('G5.3 userMsg 为三元：skipUserMessage 分支走 getMessages(...).find(...)，否则 addUserMessage(p)',
    /const userMsg\s*=\s*p\.skipUserMessage/.test(hsBody) &&
      /dm\.getMessages\([^)]*\)\s*\.find\(/.test(hsBody) &&
      /addUserMessage\(p\)/.test(hsBody));
  check('G5.4 dm 上不存在 getMessage(msgId)（防后人"优化"成不存在的方法）', !/\bdm\.getMessage\(/.test(main), '发现了 dm.getMessage(');
}

// ──────────────────────────── G6 ────────────────────────────
section('G6 IPC 三处契约一致');
{
  check('G6.1 electron/preload.ts 声明区含 regenerateReply(fromUserMsgId)',
    /regenerateReply\s*:\s*\(p:\s*\{[^}]*fromUserMsgId[^}]*\}/.test(preload));
  check('G6.2 electron/preload.ts 转发指向 messages:regenerateReply',
    /regenerateReply\s*:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\(\s*'messages:regenerateReply'/.test(preload));
  check('G6.3 src/ipc.ts 声明区含 regenerateReply(fromUserMsgId)',
    /regenerateReply\s*:\s*\(p:\s*\{[^}]*fromUserMsgId[^}]*\}/.test(ipc));
  check('G6.4 src/ipc.ts 转发 raw.regenerateReply(p)',
    /regenerateReply\s*:\s*\(p\)\s*=>\s*raw\.regenerateReply\(p\)/.test(ipc));
  check('G6.5 electron/main.ts 有 ipcMain.handle(messages:regenerateReply)',
    /ipcMain\.handle\(\s*'messages:regenerateReply'/.test(main));
  const chans = new Set(
    [...`${preload}\n${main}\n${ipc}`.matchAll(/['"](messages:regenerate[A-Za-z]*)['"]/g)].map((x) => x[1])
  );
  check('G6.6 所有 messages:regenerate* 通道字符串完全一致且等于 messages:regenerateReply',
    chans.size === 1 && chans.has('messages:regenerateReply'), [...chans].join(', ') || '(未找到)');
}

// ──────────────────────────── G7 ────────────────────────────
section('G7 重生成上下文等价性');
{
  check('G7.1 handler 传给 handleStream 的锚点字段齐全（content / imagePath / imagePaths）',
    /content\s*:\s*anchor\.content/.test(streamArgs) &&
      /imagePath\s*:\s*anchor\.image_path/.test(streamArgs) &&
      /imagePaths\s*:\s*anchor\.images/.test(streamArgs),
    '缺字段或未取自 anchor');
  const addCount = (hsBody.match(/addUserMessage\(p\)/g) || []).length;
  check('G7.2 handleStream 体内 addUserMessage(p) 恰 2 次（三元两分支；原实现 1 次）',
    addCount === 2, `实为 ${addCount} 次`);
}

// ──────────────────────────── G8 ────────────────────────────
section('G8 chats:stream 透明透传 p（前端重生成链路）');
{
  check('G8.1 chats:stream 处理函数整体透传 p 给 handleStream',
    /ipcMain\.handle\(\s*'chats:stream'\s*,\s*async\s*\(_e,\s*p\)\s*=>\s*handleStream\(p\)\s*\)/.test(main));
}

// ──────────────────────────── 汇总 ────────────────────────────
console.log('\n' + '='.repeat(70));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
process.exit(0);
