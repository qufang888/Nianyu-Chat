#!/usr/bin/env node
/**
 * verify-time-label-width.mjs — v2.3.102 需求 2「时间移到头像正下方」的**宽度契约 + 溢出**常驻闸门。
 *
 * ── 本脚本防的是什么回归（存在的理由）──────────────────────────────────────────
 *   需求 2 把时间塞进 `.msg-avatar-col{flex:0 0 44px}`（与 `.avatar` 对齐），并给 `.msg-time-above`
 *   加了 `width:44px; white-space:nowrap`。**只要时间文本宽于 44px，就会左右对称串出列、压到气泡**。
 *   本闸门守两件事：
 *     (1) 主窗/小窗的时间文本**必须与 locale 无关且紧凑**（HH:MM）；一旦有人把任何**本地化文案**
 *         （如曾经的「刚刚」→ 西语「Hace un momento」≈82px）加回时间标签，本门变红；
 *     (2) 会渲染进该列的文本，在 --font-scale=1 下**不超 44px**。
 *
 *   真实历史（本门固化）：v2.3.102 初版 ①小窗用 `toLocaleString` 的「月/日+12h」（最宽 ~66px）；
 *   ②两窗都用本地化「刚刚」（10 locale 里 de/es/fr/pt/ru 超 44px，西语最甚 ~82px）。
 *   最终统一改为 locale 无关的 `HH:MM`，同时隐式解决了①②。
 *
 * ── 方法（不猜）───────────────────────────────────────────────────────────────
 *   · 时间格式、locale 文案（`msg.justNow`）**从真源码 / 真 locale 文件读取**，不手写。
 *   · 文本宽度用**逐字符 advance 下界/近似表**求和。下界列取「常见比例字体里该字符可能出现的最小
 *     advance」，故「下界宽 > 44px」= **任何字体都溢出**（强结论）。临界 font-scale = 44 / Σadv。
 *
 * ── 判定门 ────────────────────────────────────────────────────────────────────
 *   W1  .avatar / .msg-avatar-col / .msg-time-above 的 44px 契约（含「无 overflow:hidden 兜底」）
 *   W2  主窗 + 小窗时间文本均为 locale 无关的「同分钟隐藏 / 否则 HH:MM」（无 t(...) / toLocaleString）
 *   W3  「HH:MM」在 font-scale=1 下 ≤44px（locale 无关，应恒成立）
 *   W4  防回归哨兵：本地化「刚刚」文案一旦回流即会溢出（列出各 locale 宽度）；检查器须能判它溢出
 *
 * ── 可证伪性 ──────────────────────────────────────────────────────────────────
 *   NY_QA_R2_BREAK=1 → 把「已知必然溢出的本地化 justNow / 旧 locale 月日格式」喂给宽度检查器，断言判红。
 *
 * 用法：node scripts/verify-time-label-width.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BREAK = process.env.NY_QA_R2_BREAK === '1';
if (BREAK) console.log('⚠️  NY_QA_R2_BREAK=1（把本地化长串喂给宽度检查器 → 必须判红）');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const CW = read('src/components/ChatWindow.tsx');
const MC = read('src/components/MiniChat.tsx');
const CSS = read('src/styles/index.css');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};

// 抽出某个 `const timeAbove = (() => { ... })();` 的实体（用于「时间串是否含本地化调用」判定）
function timeAboveBody(src, marker = 'const timeAbove =') {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const j = src.indexOf('})();', i);
  return src.slice(i, j > i ? j + 5 : Math.min(src.length, i + 700));
}

// ---------- W1 契约 ----------
console.log('=== W1 宽度契约（源码读取）===');
const avatarBlock = CSS.match(/\.avatar\s*\{([^}]*)\}/);
check('.avatar 主尺寸为 44px×44px', !!avatarBlock && /width:\s*44px/.test(avatarBlock[1]) && /height:\s*44px/.test(avatarBlock[1]),
  avatarBlock ? avatarBlock[1].replace(/\s+/g, ' ').slice(0, 80) : '未找到 .avatar 规则');
const colBlock = CSS.match(/\.msg-avatar-col\s*\{([^}]*)\}/);
check('.msg-avatar-col 为 flex: 0 0 44px（列宽恒定）', !!colBlock && /flex:\s*0\s+0\s+44px/.test(colBlock[1]),
  colBlock ? colBlock[1].replace(/\s+/g, ' ').slice(0, 90) : '未找到');
const timeBlock = CSS.match(/\.msg-time-above\s*\{([^}]*)\}/);
const tb = timeBlock ? timeBlock[1] : '';
check('.msg-time-above 为 width:44px + white-space:nowrap（溢出的直接成因）',
  /width:\s*44px/.test(tb) && /white-space:\s*nowrap/.test(tb), tb.replace(/\s+/g, ' ').slice(0, 90));
check('.msg-time-above **没有** overflow:hidden（超宽文本会串出 44px 列；有则为裁剪）',
  !/overflow\s*:\s*hidden/.test(tb));
check('.msg-avatar-col 为 align-items:center（超宽文本左右对称串出列）', !!colBlock && /align-items:\s*center/.test(colBlock[1]));

// ---------- W2 时间串与 locale 无关 ----------
console.log('\n=== W2 时间格式（主窗 / 小窗，locale 无关）===');
const cwC = stripComments(CW);
const mcC = stripComments(MC);
let cwT = timeAboveBody(cwC);
const mcT = timeAboveBody(mcC);
// 破坏：模拟「有人把本地化的『刚刚』加回时间标签」→ 分析体里注入 t('msg.justNow') → W2 必红
if (BREAK) cwT = cwT + " if (oldBehavior) return t('msg.justNow');";
const SAME_MIN = /Math\.floor\(\s*d\s*\/\s*60000\s*\)\s*===\s*Math\.floor\(\s*pd\s*\/\s*60000\s*\)/;
const HHMM = /`\$\{hh\}:\$\{mm\}`/;
const cwSame = SAME_MIN.test(cwT), cwHHMM = HHMM.test(cwT);
const mcSame = SAME_MIN.test(mcT), mcHHMM = HHMM.test(mcT);
check('主窗时间 = 同分钟隐藏 / 否则 HH:MM', cwSame && cwHHMM, `sameMinute=${cwSame} hhmm=${cwHHMM}`);
check('小窗时间 = 同分钟隐藏 / 否则 HH:MM（与主窗同构）', mcSame && mcHHMM, `sameMinute=${mcSame} hhmm=${mcHHMM}`);
check('主窗时间串体内**无**本地化调用（无 t(...) / toLocaleString）',
  cwT.length > 0 && !/\bt\s*\(/.test(cwT) && !/toLocaleString/.test(cwT), cwT.replace(/\s+/g, ' ').slice(0, 90));
check('小窗时间串体内**无**本地化调用（无 t(...) / toLocaleString）',
  mcT.length > 0 && !/\bt\s*\(/.test(mcT) && !/toLocaleString/.test(mcT), mcT.replace(/\s+/g, ' ').slice(0, 90));

// ---------- 宽度表 ----------
const ADV_LOWER = { digit: 0.5, upper: 0.5, lower: 0.4, latin: 0.4, latinup: 0.5, cjk: 0.95, colon: 0.2, space: 0.2, other: 0.2 };
const ADV_NEAR  = { digit: 0.556, upper: 0.63, lower: 0.5, latin: 0.5, latinup: 0.6, cjk: 1.0, colon: 0.3, space: 0.25, other: 0.3 };
function classify(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 48 && cp <= 57) return 'digit';
  if (cp >= 65 && cp <= 90) return 'upper';
  if (cp >= 97 && cp <= 122) return 'lower';
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'cjk';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'cjk';
  if (cp >= 0xac00 && cp <= 0xd7a3) return 'cjk';
  if (ch === ':') return 'colon';
  if (ch === ' ' || cp === 0x00a0 || cp === 0x202f) return 'space';
  if (cp >= 0x0400 && cp <= 0x04ff) return (cp <= 0x042f ? 'latinup' : 'latin');
  if (cp > 127) return (cp >= 0xc0 && cp <= 0xde) ? 'latinup' : 'latin';
  return 'other';
}
const sumAdv = (s, table) => { let sum = 0; for (const ch of s) sum += table[classify(ch)] ?? table.other; return sum; };
const BASE_PX = 11;
const LIMIT = 44;
const widthLower = (s) => BASE_PX * sumAdv(s, ADV_LOWER);
const widthNear = (s) => BASE_PX * sumAdv(s, ADV_NEAR);
const critScale = (s) => LIMIT / (BASE_PX * sumAdv(s, ADV_NEAR));

// ---------- W3 当前时间格式宽度 ----------
console.log('\n=== W3 「HH:MM」宽度（font-scale=1, 11px）===');
{
  const s = '23:59';
  console.log(`  「${s}」 下界=${widthLower(s).toFixed(1)}px 近似=${widthNear(s).toFixed(1)}px 临界fontScale=${critScale(s).toFixed(2)}`);
}
check('W3 「HH:MM」在 font-scale=1 下 ≤44px（locale 无关 → 恒定）', widthNear('23:59') <= LIMIT, `${widthNear('23:59').toFixed(1)}px`);

// ---------- W4 本地化「刚刚」溢出哨兵（防回流）----------
console.log('\n=== W4 本地化「刚刚」(msg.justNow) 溢出哨兵 vs 44px（font-scale=1）===');
const LOCALES = ['zh', 'en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
const justNow = {};
{
  const tr = stripComments(read('src/i18n/translations.ts'));
  const pairs = [...tr.matchAll(/'msg\.justNow'\s*:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  justNow.zh = pairs[0] ?? null;
  justNow.en = pairs[1] ?? null;
}
for (const loc of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  try { justNow[loc] = JSON.parse(read(`src/i18n/locales/${loc}.json`))['msg.justNow'] ?? null; }
  catch { justNow[loc] = null; }
}
console.log('  ' + 'locale'.padEnd(10) + 'justNow'.padEnd(22) + 'lower'.padEnd(8) + 'near'.padEnd(8) + 'critScale');
const overflow = [];
for (const loc of LOCALES) {
  const s = justNow[loc];
  if (s == null) { console.log('  ' + loc.padEnd(10) + '(缺失)'); continue; }
  const lo = widthLower(s), ne = widthNear(s);
  if (lo > LIMIT) overflow.push(loc);
  console.log('  ' + loc.padEnd(10) + JSON.stringify(s).padEnd(22) + lo.toFixed(1).padEnd(8) + ne.toFixed(1).padEnd(8) + critScale(s).toFixed(2));
}
console.log(`  · 若把本地化「刚刚」加回时间标签，以下 locale 连**下界**都超 44px（任何字体都溢出）：${overflow.join(', ')}`);
console.log('  · 当前实现已统一为 locale 无关的 HH:MM，故上述文案**不会**进入该列（W2 已断言时间串无本地化调用）。');
// 自证活性：宽度检查器必须能把「已知必然溢出」的本地化串判红（否则本门空转）
check('W4 自证活性：宽度检查器判「Hace un momento」(es justNow) 溢出 44px',
  widthNear('Hace un momento') > LIMIT, `${widthNear('Hace un momento').toFixed(1)}px`);

// ---------- 可证伪性 ----------
if (BREAK) {
  const sample = new Date('2024-03-29T14:30:00');
  const reverted = sample.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  check(`NY_QA_R2_BREAK 探针①：旧 locale 月/日格式("${reverted}")被宽度检查器判溢出（${widthNear(reverted).toFixed(1)}px）`,
    widthNear(reverted) > LIMIT);
  check(`NY_QA_R2_BREAK 探针②：本地化 justNow("Hace un momento") 被宽度检查器判溢出（${widthNear('Hace un momento').toFixed(1)}px）`,
    widthNear('Hace un momento') > LIMIT);
}

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(64));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
process.exit(0);
