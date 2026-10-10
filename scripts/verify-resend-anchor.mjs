#!/usr/bin/env node
/**
 * verify-resend-anchor.mjs — v2.3.102 需求 1「打断后重发」锚点判定的**可执行**验证。
 *
 * ── 本脚本防的是什么回归（存在的理由）──────────────────────────────────────────
 *   需求 1 在「末尾 AI 回复被打断」时于用户气泡下显示「重发」按钮，点击后删除未完成回复并重生成。
 *   关键不变式（任一破坏都会造成可见 bug）：
 *     · 锚点判定 computeInterruptedAnchorId 必须只认「尾部被打断的 AI 回复」，且其**唯一实现**被主窗/小窗共用
 *       （若两处各写一份 → 漂移；本门 R1c/R1d 断言小窗 import 复用）。
 *     · 重生成**不得**写入第二条用户消息（本门 R1e 断言 handleStream 的两处 addUserMessage 都在 skip 三元内）。
 *     · 新增的 keepAnchor 参数**不得**影响既有回滚路径（本门 R1f 断言 rollback / rollbackForEdit 仍只传 4 实参）。
 *   立场：不重打一份 computeInterruptedAnchorId（那是 shadow oracle）——**从真源码抽取函数体**后 eval 调用。
 *
 * 断言：
 *   R1a 从 ChatWindow.tsx 抽出的 computeInterruptedAnchorId 与源码形态一致（抽取器自检，抽错即失败）
 *   R1b 边界矩阵（≥8 条）逐条输出，对**语义明确**的条目断言
 *   R1c MiniChat **import 复用**主窗实现（不重复定义 → 无两份实现漂移）
 *   R1d handleStream 体内 addUserMessage(p) 恰 2 次且都落在 skipUserMessage 三元内（重生成不写第二条 user 消息）
 *   R1e messages:rollback / rollbackForEdit **未**传第 5 实参（keepAnchor 默认 false → 现有回滚零影响）
 *   R1f electron/db.ts keepAnchor 默认值 == false
 *   R1g `interrupted: true` 仅 1 处（非流式 catch 占位）；`interrupted: interrupted ? true : undefined` 仅 1 处（finalizeRole）
 *   R1h 正常完成路径（finalizeRole(false) 调用点）不写 interrupted
 *
 * 用法：node scripts/verify-resend-anchor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const BREAK = process.env.NY_QA_R1_BREAK === '1';
if (BREAK) console.log('⚠️  NY_QA_R1_BREAK=1（应让边界矩阵变红，证明矩阵不是空转）');
const CW = read('src/components/ChatWindow.tsx');
const MC = read('src/components/MiniChat.tsx');
const MAIN = read('electron/main.ts');
const DB = read('electron/db.ts');

let pass = 0, fail = 0;
const failures = [];
const warns = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};
const warn = (msg) => { warns.push(msg); console.log('  ⚠ ' + msg); };

const lineOf = (text, idx) => (idx < 0 ? -1 : text.slice(0, idx).split('\n').length);
function matchPair(text, openIdx, open, close) {
  let depth = 0, st = 0;
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
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
  return out;
}

// ---------- R1a 抽函数 ----------
console.log('=== R1a 从真源码抽取 computeInterruptedAnchorId ===');
const marker = 'export function computeInterruptedAnchorId(';
const start = CW.indexOf(marker);
let fn = null;
if (start >= 0) {
  const bodyOpen = CW.indexOf('{', start);
  const bodyClose = matchPair(CW, bodyOpen, '{', '}');
  const rawFn = CW.slice(start, bodyClose + 1);
  // 抽取器自检：形态必须与预期一致，否则立即失败（防止抽到别的东西而静默空转）
  const shapeOk = /tail\.some\(\(m\)\s*=>\s*m\.sender_type\s*!==\s*'user'\s*&&\s*m\.interrupted\)/.test(rawFn) &&
    /for\s*\(let i = msgs\.length - 1; i >= 0; i--\)/.test(rawFn) &&
    /sender_type === 'user'/.test(rawFn);
  check('R1a-1 抽取到函数且体内含预期判定（tail.some(...interrupted) + 倒序找 user）', shapeOk,
    shapeOk ? '' : rawFn.slice(0, 160));
  // 去 TS 类型标注后 eval（破坏模式下把判定改成恒 false，用于证明矩阵会变红）
  let jsFn = rawFn
    .replace(/^export function computeInterruptedAnchorId/, 'function computeInterruptedAnchorId')
    .replace(/msgs: ChatMessage\[\]/, 'msgs')
    .replace(/\): number \| null \{/, ') {');
  if (BREAK) jsFn = jsFn.replace("m.interrupted", 'false');
  check('R1a-2 TS 类型标注已剥离（得到可 eval 的 JS 函数表达式）',
    jsFn.includes('function computeInterruptedAnchorId(msgs) {') && !/ChatMessage/.test(jsFn), jsFn.slice(0, 80));
  fn = eval('(' + jsFn + ')');
  check('R1a-3 eval 得到可调用函数', typeof fn === 'function');
} else {
  check('R1a-1 找到 computeInterruptedAnchorId 定义', false, '未找到');
}

// ---------- R1b 边界矩阵 ----------
console.log('\n=== R1b 边界矩阵（stub ChatMessage[]）===');
const u = (id) => ({ id, sender_type: 'user' });
const ai = (id, interrupted) => (interrupted === undefined ? { id, sender_type: 'ai' } : { id, sender_type: 'ai', interrupted });
const sys = (id) => ({ id, sender_type: 'system' });

const matrix = [
  { name: '[u, ai{int}] → u.id', msgs: [u(1), ai(2, true)], expect: 1 },
  { name: '[u, ai{int}, u] → null（锚点非尾部）', msgs: [u(1), ai(2, true), u(3)], expect: null },
  { name: '[u, ai{}, u, ai{int}] → 第二个 u.id', msgs: [u(1), ai(2, false), u(3), ai(4, true)], expect: 3 },
  { name: '[u, ai{int}, ai{int}] → u.id（多个都标记）', msgs: [u(1), ai(2, true), ai(3, true)], expect: 1 },
  { name: '[ai{int}]（无 user）→ null（不崩、非 undefined）', msgs: [ai(1, true)], expect: null },
  { name: '[] → null', msgs: [], expect: null },
  { name: '[u, ai{}, sys] → null（无 interrupted）', msgs: [u(1), ai(2, false), sys(3)], expect: null },
  { name: '[u, ai{interrupted:false}] → null', msgs: [u(1), ai(2, false)], expect: null },
  { name: '[u, ai{interrupted:undefined}] → null', msgs: [u(1), ai(2)], expect: null },
  { name: '[u, ai{int}, sys] → ?（末尾 system 不阻断）', msgs: [u(1), ai(2, true), sys(3)], expect: 1 },
];
// 已知 spec 分歧探针（不设 expect，仅如实记录）
const probes = [
  { name: '[u, ai{int}, ai{}]（前一条被打断、后一条正常完成）', msgs: [u(1), ai(2, true), ai(3, false)] },
  { name: '[u, ai{}, u, ai{}]（末尾无 interrupted）', msgs: [u(1), ai(2, false), u(3), ai(4, false)] },
  { name: '[u, sys, ai{int}]（user 与被打断 AI 之间有 system）', msgs: [u(1), sys(2), ai(3, true)] },
];

if (typeof fn === 'function') {
  let okCount = 0;
  for (const t of matrix) {
    let got;
    let threw = null;
    try { got = fn(t.msgs); } catch (e) { threw = e; }
    const ok = !threw && got === t.expect;
    if (ok) okCount++;
    console.log(`  ${ok ? '✔' : '✗'} ${t.name}  → 实际 ${threw ? 'THREW ' + threw.message : JSON.stringify(got)}（期望 ${JSON.stringify(t.expect)}）`);
    if (!ok) failures.push(`R1b ${t.name} → 实际 ${threw ? 'THREW' : JSON.stringify(got)} 期望 ${JSON.stringify(t.expect)}`);
  }
  check(`R1b 边界矩阵 ${matrix.length} 条全部符合期望`, okCount === matrix.length, `${okCount}/${matrix.length} 通过`);

  console.log('\n  --- 探针（无期望值，记录实现行为）---');
  for (const p of probes) {
    let got; try { got = fn(p.msgs); } catch (e) { got = 'THREW ' + e.message; }
    console.log(`  · ${p.name}  → 实际 ${JSON.stringify(got)}`);
  }
  // 与 PRD §2.3.2「末条 AI 被打断才成立」的**有意偏离**（team-lead 裁定保留）：
  //   [u, ai{int}, ai{!int}] 实现返回 u.id（PRD 字面应为 null）。理由：群聊同轮任一成员被打断 =
  //   「该轮未走完」，显示重发更贴合用户意图；而该组合在真实流程里极难出现（打断会 abort 整轮串行流）。
  //   故此处**不作失败**，仅记录（若将来流程变更使该组合可达，需重新评估）。
  const div = fn([u(1), ai(2, true), ai(3, false)]);
  if (div !== null) {
    warn(`R1c 有意偏离（已裁定保留）：PRD §2.3.2 字面要求「末条 AI 被打断」才显示按钮，` +
      `实现用 tail.some(...)（任一非 user 被打断即命中），[u, ai{int}, ai{!int}] 返回 ${JSON.stringify(div)}。` +
      `team-lead 裁定：保留实现（群聊「任一成员被打断=整轮未走完」更贴合用户意图，且该组合在真实 abort 流程中极难出现）。`);
  }
} else {
  check('R1b 边界矩阵执行', false, 'fn 不可调用');
}

// ---------- R1d MiniChat 复用 ----------
console.log('\n=== R1d 主窗/小窗同构（单一实现）===');
check('R1d-1 MiniChat 从 ./ChatWindow import computeInterruptedAnchorId',
  /import\s*\{\s*computeInterruptedAnchorId\s*\}\s*from\s*'\.\/ChatWindow'/.test(MC));
check('R1d-2 MiniChat **未**自行定义 computeInterruptedAnchorId（无两份漂移）',
  !/function computeInterruptedAnchorId/.test(MC));

// ---------- R1e handleStream skipUserMessage ----------
console.log('\n=== R1e handleStream 不写第二条 user 消息 ===');
const mainC = stripComments(MAIN);
const hsStart = mainC.indexOf('async function handleStream(');
let hsBody = '';
if (hsStart >= 0) {
  const pOpen = mainC.indexOf('(', hsStart);
  const pClose = matchPair(mainC, pOpen, '(', ')');
  const tOpen = mainC.indexOf('{', pClose);
  const tClose = matchPair(mainC, tOpen, '{', '}');
  const bOpen = mainC.indexOf('{', tClose);
  const bClose = matchPair(mainC, bOpen, '{', '}');
  hsBody = mainC.slice(bOpen, bClose + 1);
}
const addCount = (hsBody.match(/addUserMessage\(/g) || []).length;
check(`R1e-1 handleStream 体内 addUserMessage( 恰 2 次（三元两分支）`, addCount === 2, `实际 ${addCount} 次`);
const ternStart = hsBody.indexOf('const userMsg = p.skipUserMessage');
const ternEnd = hsBody.indexOf('addUserMessage(p);', ternStart);
const ternRegion = ternStart >= 0 ? hsBody.slice(ternStart, ternEnd + 'addUserMessage(p);'.length) : '';
check('R1e-2 两处 addUserMessage 都落在 skipUserMessage 三元内（skip 支走回读、无新增写库点）',
  ternStart >= 0 && (ternRegion.match(/addUserMessage\(/g) || []).length === 2 && addCount === 2,
  `三元区命中 ${(ternRegion.match(/addUserMessage\(/g) || []).length}`);
check('R1e-3 三元 skip 分支为回读 getMessages(...).find(...)（非新增）',
  /const userMsg = p\.skipUserMessage[\s\S]{0,160}?dm\.getMessages\([^)]*\)\.find\(/.test(hsBody));

// ---------- R1f keepAnchor 默认 + 现有回滚未传 ----------
console.log('\n=== R1f keepAnchor ===');
check('R1f-1 db.ts keepAnchor 默认值 == false', /keepAnchor\s*=\s*false/.test(DB),
  (DB.match(/keepAnchor[^,)]*/) || []).join(' | '));
check('R1f-2 db.ts 过滤为三元 keepAnchor ? > : >=', /keepAnchor\s*\?\s*m\.id\s*>\s*fromMsgId\s*:\s*m\.id\s*>=\s*fromMsgId/.test(DB));
const rb = mainC.match(/ipcMain\.handle\('messages:rollback'[\s\S]*?\n\s*\}\);/);
const rbe = mainC.match(/ipcMain\.handle\('messages:rollbackForEdit'[\s\S]*?\n\s*\}\);/);
const rbCall = rb ? (rb[0].match(/rollbackMessages\([^)]*\)/) || [])[0] : null;
const rbeCall = rbe ? (rbe[0].match(/rollbackMessages\([^)]*\)/) || [])[0] : null;
check('R1f-3 messages:rollback 调 rollbackMessages(..., true) 仅 4 实参（不含 keepAnchor）',
  !!rbCall && rbCall.split(',').length === 4, `实际：${rbCall}`);
check('R1f-4 messages:rollbackForEdit 调 rollbackMessages(..., true) 仅 4 实参（不含 keepAnchor）',
  !!rbeCall && rbeCall.split(',').length === 4, `实际：${rbeCall}`);
check('R1f-5 唯一传 keepAnchor 的调用点在 regenerateReply handler（5 实参 + true）',
  /rollbackMessages\(p\.chatType,\s*p\.chatId,\s*p\.fromUserMsgId,\s*true,\s*true\)/.test(mainC));

// ---------- R1g/h interrupted 写入面 ----------
console.log('\n=== R1g/h interrupted 写入面 ===');
const c1 = (mainC.match(/interrupted\s*:\s*true\b/g) || []).length;
const c2 = (mainC.match(/interrupted\s*:\s*interrupted\s*\?\s*true\s*:\s*undefined/g) || []).length;
check('R1g-1 `interrupted: true` 恰 1 次（非流式 catch 零输出占位）', c1 === 1, `实际 ${c1}`);
check('R1g-2 `interrupted: interrupted ? true : undefined` 恰 1 次（finalizeRole）', c2 === 1, `实际 ${c2}`);
check('R1g-3 无第 3 处把 interrupted 置真（!0 / 1 / || true）',
  !/interrupted\s*:\s*(?:!0|1)\b/.test(mainC) && !/interrupted\s*\|\|\s*true/.test(mainC));
const frStart = mainC.indexOf('const finalizeRole =');
const frBody = frStart >= 0 ? mainC.slice(frStart, frStart + 1400) : '';
check('R1h-1 finalizeRole 的 addMessage 读形参 interrupted（正常完成传 false → 写 undefined）',
  /interrupted\s*:\s*interrupted\s*\?\s*true\s*:\s*undefined/.test(frBody));
const falseCalls = (mainC.match(/finalizeRole\([^)]*false/g) || []).length;
check('R1h-2 正常完成路径 finalizeRole(..., false, ...) 存在且不置 interrupted', falseCalls >= 2, `false 调用点 ${falseCalls}`);

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(64));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败；警告 ${warns.length} 条`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
process.exit(0);
