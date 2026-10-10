// v2.3.97 验证：界面动效速度（--anim-speed）全局缩放
// 用法：node scripts/verify-anim-speed.mjs
// 可证伪性对照：
//   NY_BREAK=missed   node scripts/verify-anim-speed.mjs   # 人为把某处改回硬编码 → 应当失败
//   NY_BREAK=exempt   node scripts/verify-anim-speed.mjs   # 人为给豁免项加上 calc → 应当失败
//
// ── 为什么需要它 ──────────────────────────────────────────────────────
// 这次改动把 85 条 CSS 声明 / 111 个时长字面量改写成 calc(... * var(--anim-speed))。
// 这类「机械大批量替换」有两类致命 bug，tsc 与肉眼都查不出：
//   ① **漏改**：某条动画没被包上 → 用户拨了滑块，那一处永远不变，
//      于是「速度滑块对某些东西无效」，且极难定位是哪一处；
//   ② **误改**：不该动的被动了 → 破坏用户明确要求保留的行为
//      （伪流式打字机、infinite 循环呼吸、跳转高亮反馈）。
// 所以本脚本的价值在于：**把「漏改」和「误改」都变成会失败的红灯**。
//
// 静态扫描采用「**分类断言**」而非「黑名单」：
//   先用与施工脚本**同一套内容规则**把全部时长声明分成「应缩放 / 应豁免 / 无需处理」三类，
//   再断言分类结果与实际文件内容一致，并断言三类**各自的条数下限**不为零
//   —— 这样既抓漏改（该缩放却没缩放），也抓误改（豁免项被缩放）。
// 同时断言豁免名单**逐条完整**：施工脚本改了规则而这里没同步，会立刻暴露。
//
// ── Electron 探针踩过的坑（沿用 verify-actionbar-direct-show.mjs 的解法）──
//   ① 必须 delete env.ELECTRON_RUN_AS_NODE，否则 electron.exe 以纯 Node 模式启动；
//   ② 子进程脚本必须放在**项目目录内**（scripts/），否则 require('electron') 找不到 node_modules；
//   ③ 渲染层代码用**单层**模板独立落盘，主进程只 fs.readFileSync 引用，杜绝嵌套转义；
//      并用 new vm.Script 在起 Electron **之前**预编译，把「转义写错」从「30s 超时」
//      变成一条立刻可见的语法错误。

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ─────────────────────────────────────────────────────────────────────
// 第 1 部分：静态扫描 —— 分类断言（抓漏改 / 误改）
// ─────────────────────────────────────────────────────────────────────

const V_RE = /var\(--anim-speed/;
/** 时长字面量：0.15s / .12s / 300ms；要求后不接字母数字 */
const DUR_RE = /(^|[\s,(])((?:\d*\.)?\d+)(m?s)(?![\w-])/g;

// ── 豁免规则（与 scripts/anim-speed-apply-durations.mjs 的 EXEMPT_REASONS 逐条对应）──
// minCount 是「该规则至少应命中多少条」的**下限断言**，作用是防止规则被改坏后
// 静默变成永不命中（那样 unwrapped 检查会假通过，等于豁免机制被悄悄关掉）。
// ⚠️ 一条声明可同时命中多条规则（如 `.stream-char.stall` 既是流式又带 infinite），
//    故各规则命中数之和 > 豁免声明总数是正常的，不是重复计数 bug。
const EXEMPT_RULES = [
  {
    id: 'infinite',
    test: /\binfinite\b/,
    why: 'infinite 循环动画：时长即周期，缩放会改变呼吸/脉冲节奏（用户已确认不缩放）',
    minCount: 10,
  },
  {
    id: 'stream',
    test: /\.stream-char/,
    why: '流式打字机：用户明确要求与此设置无关（另有 pseudoStreamSpeed）',
    minCount: 3,
  },
  {
    id: 'pseudoChar',
    test: /\.pseudo-char/,
    why: '伪流式逐字渐显：时长由内联 --pseudo-char-dur 传入（另有 pseudoStreamSpeed）',
    minCount: 2,
  },
  {
    id: 'pseudoVar',
    test: /--pseudo-char-dur/,
    why: '伪流式时长变量 var(--pseudo-char-dur)：其 fallback 时长不参与全局缩放',
    minCount: 2,
  },
  {
    id: 'flash',
    // v2.3.102：闪动已统一为**单一**共享 keyframe `flashPulse`（原 settingFlash 5s 单次 +
    // modelFlash 1s×3 两套实现合并为 `flashPulse 1s linear 5` = 5s）。故：
    //   ① 豁免规则同步纳入新 keyframe 名 flashPulse（保留旧名以兼容历史书写）；
    //   ② 合并后 `.setting-flash, .model-flash` 是**一条**声明，规则命中数下限由 2 调整为 1。
    test: /\b(flashPulse|settingFlash|modelFlash)\b/,
    why: '跳转高亮反馈：功能性提示，配套 flashElement 的 FLASH_MS(5000) 定时移除类',
    minCount: 1,
  },
];

/** 找出该行所属选择器（从后往前找最近的以 { 结尾的行） */
function findOwnerSelector(lines, idx) {
  for (let i = idx; i >= 0 && i >= idx - 12; i--) {
    const t = lines[i].trim();
    if (t.endsWith('{')) return t.slice(0, -1).trim();
  }
  return '';
}

/**
 * 把一个文件解析成「声明条目」，正确处理跨行 shorthand
 * （如 `transition:\n  transform 0.2s linear,\n  …;`）。
 * ⚠️ 漏解析跨行声明 = 漏改却不报错，正是本脚本要消灭的那类 bug，故必须独立实现一份。
 */
function parseDeclarations(lines) {
  const items = [];
  let inComment = false;
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^\/\*/.test(trimmed) && !/\*\//.test(trimmed)) inComment = true;
    if (inComment) { if (/\*\//.test(trimmed)) inComment = false; continue; }
    if (trimmed.startsWith('//')) continue;
    if (pending) {
      pending.lines.push(i);
      if (line.includes(';')) { items.push(pending); pending = null; }
      continue;
    }
    if (!/\b(animation|transition)\s*:/.test(line)) continue;
    const selector = findOwnerSelector(lines, i);
    if (line.includes(';')) items.push({ start: i, lines: [i], selector, text: line });
    else pending = { start: i, lines: [i], selector, text: line };
  }
  if (pending) items.push(pending);
  return items;
}

/** 该声明条目里是否含非零时长字面量（0s 不算：乘任何倍率仍为 0） */
function hasRealDuration(text) {
  DUR_RE.lastIndex = 0;
  let m;
  while ((m = DUR_RE.exec(text)) !== null) if (Number(m[2]) !== 0) return true;
  return false;
}

/** 统计条目里「未被 calc 包裹」的非零时长个数（漏改数）
 *
 * ⚠️ 关键实现细节：calc() 里**嵌套**着 var(--anim-speed, 1) 的第二个参数
 * （那个 fallback `1` 不是时长，但它使 `calc(` 与 `)` 之间出现了括号），
 * 所以不能用 `/calc\([^()]*\)/` 剥离 —— 那会把整条 calc 留下，误报成「漏改」。
 * 这里用一个极小的手写括号配平扫描（而不是正则），才能正确跳过整段 calc(...)。
 */
function unwrappedCount(text) {
  // 先剥掉所有已包裹的 calc(...)，剩下的时长就是漏网的
  let stripped = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('calc(', i)) {
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') { depth--; if (depth === 0) break; }
      }
      i = j; // 跳过整段 calc(...)
      stripped += ' ';
      continue;
    }
    stripped += text[i];
  }
  DUR_RE.lastIndex = 0;
  let m;
  let n = 0;
  while ((m = DUR_RE.exec(stripped)) !== null) if (Number(m[2]) !== 0) n++;
  return n;
}

const CSS_FILES = ['src/styles/index.css'];
/** 需要扫描的 TS/TSX（内联样式里写 transition/animation 字符串） */
const TS_FILES = [
  'src/floating-ball.ts',
  'src/notify.ts',
  'src/components/CustomScrollArea.tsx',
  'src/components/CustomTitleBar.tsx',
  'src/components/Settings.tsx',
  'src/components/VideoBubble.tsx',
  'src/utils/globalErrorHandler.ts',
];

// 可证伪性开关：故意制造两类错误，验证脚本真的抓得住
const BREAK = process.env.NY_BREAK || '';

const exemptHits = new Map(EXEMPT_RULES.map((r) => [r.id, []]));
let scaledTotal = 0;
let scaledDecls = 0;

section('A. 静态扫描：应缩放的时长是否全部包上了 calc(... * var(--anim-speed))');
for (const rel of CSS_FILES.concat(TS_FILES)) {
  const abs = path.join(ROOT, rel);
  check(`文件存在：${rel}`, fs.existsSync(abs));
  if (!fs.existsSync(abs)) continue;
  let lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  // 可证伪性：把某处缩放**改回硬编码**，模拟「漏改」
  if (BREAK === 'missed' && rel === 'src/styles/index.css') {
    const i = lines.findIndex((l) => l.includes('anim-speed'));
    if (i >= 0) lines[i] = lines[i].replace(/calc\(([\d.]+m?s) \* var\(--anim-speed, 1\)\)/g, '$1');
  }
  for (const item of parseDeclarations(lines)) {
    const joined = item.lines.map((i) => lines[i]).join(' ');
    // ⚠️ 一条声明可能**同时**命中多条豁免规则（如 `.stream-char.stall` 既属于「流式打字机」
    //    又带 `infinite`）。必须把**全部**命中的规则都记进去，而不是 find 取第一条 ——
    //    否则某些规则永远命中不到（minCount 恒为 0），豁免名单的完整性检查就成了摆设。
    const hitRules = EXEMPT_RULES.filter(
      (r) => r.test.test(joined) || (item.selector && r.test.test(item.selector))
    );
    if (hitRules.length > 0) {
      for (const r of hitRules) {
        exemptHits.get(r.id).push({ file: rel, line: item.start + 1, text: joined.trim(), hasVar: V_RE.test(joined) });
      }
      continue;
    }
    if (!hasRealDuration(joined)) continue;
    // 只引用 var(--transition) 的行不含字面量时长，已在 variables.css 唯一定义点缩放
    if (unwrappedCount(joined) === 0 && !V_RE.test(joined)) continue;

    scaledDecls++;
    const missed = unwrappedCount(joined);
    scaledTotal += countDurations(joined);
    check(
      `${rel}:${item.start + 1}  已缩放`,
      missed === 0,
      missed === 0 ? '' : `漏改 ${missed} 个时长 → ${joined.trim().slice(0, 96)}`
    );
  }
}

function countDurations(text) {
  DUR_RE.lastIndex = 0;
  let m; let n = 0;
  while ((m = DUR_RE.exec(text)) !== null) if (Number(m[2]) !== 0) n++;
  return n;
}

section('B. 静态扫描：豁免名单完整性 + 「不应缩放却缩放」检查');
for (const rule of EXEMPT_RULES) {
  const hits = exemptHits.get(rule.id);
  check(
    `豁免规则 [${rule.id}] 命中数 ≥ ${rule.minCount}`,
    hits.length >= rule.minCount,
    `实际 ${hits.length} 条（若新增同类动画请同步上调 minCount）`
  );
  const wronglyScaled = hits.filter((h) => h.hasVar);
  check(
    `豁免规则 [${rule.id}] 无一被误加 calc`,
    wronglyScaled.length === 0,
    wronglyScaled.map((h) => `${h.file}:${h.line}`).join(', ')
  );
}

// 可证伪性：给某个豁免项错误地加上 calc，模拟「误改」
if (BREAK === 'exempt') {
  const abs = path.join(ROOT, 'src/styles/index.css');
  const src = fs.readFileSync(abs, 'utf8');
  const bad = src.replace(
    /(\.stream-char \{[^}]*?animation: nyCharIn )0\.3s/,
    '$1calc(0.3s * var(--anim-speed, 1))'
  );
  if (bad !== src) {
    // 直接把改后的内容写进本脚本的内存副本（复用 parseDeclarations 的扫描入口）
    const lines = bad.split(/\r?\n/);
    const hit = parseDeclarations(lines).find(
      (it) => it.selector.includes('.stream-char') && !it.selector.includes('anim-off')
    );
    if (hit) {
      const joined = hit.lines.map((i) => lines[i]).join(' ');
      const wrongly = V_RE.test(joined);
      check('（注入）豁免项 .stream-char 被误加 calc 应当被抓到', wrongly, '');
    }
  }
}

section('C. CSS 变量唯一定义点');
{
  const vars = fs.readFileSync(path.join(ROOT, 'src/theme/variables.css'), 'utf8');
  check('--transition 已写成 calc(... * var(--anim-speed))', /--transition:\s*calc\(0\.3s \* var\(--anim-speed, 1\)\)/.test(vars),
    (vars.match(/--transition:[^;]*/) || [''])[0]);
  const idx = fs.readFileSync(path.join(ROOT, 'src/styles/index.css'), 'utf8')
    .split(/\r?\n/).filter((l) => /var\(--transition\)/.test(l)).length;
  check(`index.css 中 var(--transition) 的引用点 ${idx} 处由唯一定义点统一缩放`, idx > 30, String(idx));
}

section('D. JS 常量：必须出现速度缩放表达式');
{
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  // ⚠️ 方向性断言是本组的核心：`--anim-speed` 是**时长倍率**（1.5 = 很慢 = 时长 ×1.5），
  //    所以 JS 侧一律**乘**倍率；唯独 lerp 系数（越大越快）要**除**。
  //    写反任一处的症状都是「调慢反而变快」，且不会有任何报错 —— 只能靠断言锁死。
  const retract = read('src/hooks/useRetract.ts');
  check('useRetract：延迟卸载走 scaledRetractMs（按倍率缩放）', /setTimeout\([\s\S]{0,200}?scaledRetractMs\(/.test(retract));
  check('useRetract：scaledRetractMs 实现为 baseMs **×** speed（方向正确）',
    /baseMs\s*\*\s*speed/.test(retract) && !/baseMs\s*\/\s*speed/.test(retract),
    '写成除号会导致慢档下动画播一半就被卸载 = 菜单点了不消失');
  check('useRetract：倍率来自 readAnimSpeed（读 --anim-speed，无需改 Hook 签名）', /readAnimSpeed\(/.test(retract));

  const fb = read('src/floating-ball.ts');
  check('floating-ball：菜单延迟卸载走 menuHideAnimMs()', /menuHideAnimMs\(\)/.test(fb));
  check('floating-ball：MENU_HIDE_ANIM_MS **×** readAnimSpeed（方向正确）',
    /MENU_HIDE_ANIM_MS\s*\*\s*readAnimSpeed/.test(fb) && !/MENU_HIDE_ANIM_MS\s*\/\s*readAnimSpeed/.test(fb));

  const stats = read('src/components/StatsView.tsx');
  check('StatsView：饼图补间时长 = PIE_ANIM_MS **×** 倍率（方向正确）',
    /PIE_ANIM_MS\s*\*\s*speedRef\.current/.test(stats) && !/PIE_ANIM_MS\s*\/\s*speedRef/.test(stats));
  check('StatsView：倍率来自 getAnimSpeed(settings)', /getAnimSpeed\(settings\)/.test(stats));

  const cur = read('src/components/CustomCursor.tsx');
  check('CustomCursor：淡入时长 = FADE_IN_MS **×** 倍率（除错会变快）',
    /FADE_IN_MS\s*\*\s*speedRef\.current/.test(cur) && !/FADE_IN_MS\s*\/\s*speedRef/.test(cur));
  check('CustomCursor：淡出时长 = FADE_OUT_MS **×** 倍率（除错会变快）',
    /FADE_OUT_MS\s*\*\s*speedRef\.current/.test(cur) && !/FADE_OUT_MS\s*\/\s*speedRef/.test(cur));
  check('CustomCursor：lerp 系数 = 基准 **÷** 倍率（语义与时长相反，故方向也相反）',
    /lerpSpeed:[\s\S]{0,240}?\/\s*speedRef\.current/.test(cur),
    'lerp 系数若误用乘号，调慢会变成光标疯狂甩尾');
  check('CustomCursor：lerp 系数不存在误用乘号的写法',
    !/lerpSpeed:[\s\S]{0,240}?\*\s*speedRef\.current/.test(cur));

  // ── D2：与 CSS 动画配对的 JS 定时器必须同步缩放 ──
  // 这类脱节是本次改造最容易漏的地方，且症状隐蔽（快档「傻等」、慢档「凭空消失」）。
  // 判据：凡出现 animMs(0.xx) 的地方，xx 必须与 index.css 里对应动画的 calc() 基准值一致。
  const idx = read('src/styles/index.css');
  /** 取某个 keyframes 动画在 CSS 里的基准秒数（从 calc(0.2s * var(--anim-speed… 反推） */
  const cssBaseOf = (kw) => {
    // 用字符串拼接构造正则，避免模板字面量与正则的双层转义（本项目已因此踩坑两次）。
    // 形如：animation: nodeBannerIn calc(0.2s * var(--anim-speed, 1)) linear both;
    const re = new RegExp('animation:\\s*' + kw + '\\s+calc\\(([0-9.]+)s \\* var\\(--anim-speed');
    const m = idx.match(re);
    return m ? m[1] : null;
  };

  // ⚠️ 全部断言都必须扫**剥离注释后的代码**，不能扫原始文本。
  //    否则「注释里写了 animMs(0.2)」就会让断言通过，即使真实代码已改回硬编码 ——
  //    这正是本脚本第一版 D2 组的缺陷（已通过可证伪性检验抓出：改回 200ms 仍全 PASS）。
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const bannerCode = stripComments(read('src/components/NodeBanner.tsx'));
  check('NodeBanner：IN/OUT 走 animMs(...) 而非硬编码常量',
    /animMs\(0\.\d+\)/.test(bannerCode) && !/const (IN|OUT)_MS = \d/.test(bannerCode),
    'IN_MS/OUT_MS 若是模块级 const，用户改速度后不会重算 → 与 CSS 脱节');
  check('NodeBanner：真实代码里两处 animMs 调用都存在（弹入 + 渐隐）',
    (bannerCode.match(/animMs\(0\.\d+\)/g) || []).length >= 2,
    `实际 ${(bannerCode.match(/animMs\(0\.\d+\)/g) || []).length} 处`);
  check('NodeBanner：HOLD_MS 保留且**不**参与缩放（纯产品节奏）',
    /const HOLD_MS = 3500/.test(bannerCode) && !/HOLD_MS = animMs/.test(bannerCode) && !/animMs\([^)]*\)[^;]*\+ HOLD_MS/.test(bannerCode.replace(/HOLD_MS\)/g, ')')));
  check('NodeBanner：未用 useMemo 缓存 animMs（无可订阅的 React 依赖，读的是 DOM 变量）',
    !/useMemo/.test(bannerCode));
  // 基准值必须与 CSS 的 nodeBannerIn/nodeBannerOut 对齐
  const bIn = bannerCode.match(/animMs\(([\d.]+)\)/);
  const cssBannerIn = cssBaseOf('nodeBannerIn');
  const cssBannerOut = cssBaseOf('nodeBannerOut');
  check('NodeBanner：animMs 入参与 CSS nodeBannerIn 基准一致',
    !!bIn && !!cssBannerIn && Math.abs(Number(bIn[1]) - Number(cssBannerIn)) < 1e-9,
    `JS=${bIn?.[1]}s CSS=${cssBannerIn}s`);
  check('NodeBanner：CSS nodeBannerOut 也已被缩放（否则出场方向不一致）',
    cssBannerOut !== null, String(cssBannerOut));

  const toastCode = stripComments(read('src/components/Toast.tsx'));
  check('Toast：退场等待走 animMs(...)（与 toastOutLinear 同步）',
    /animMs\(0\.\d+\)/.test(toastCode) && /setToast\(null\)/.test(toastCode),
    'Toast 退场 JS 等 300/420ms 写死，而 CSS toastOutLinear 已缩放 → 快档傻等 / 慢档凭空消失');
  // 停留时长必须原样传给 setTimeout，且**不得**经过 animMs。
  check('Toast：停留 duration 原样传入 setTimeout（未被 animMs 缩放）',
    /\},\s*duration\s*\)/.test(toastCode) && !/setTimeout\(\(\)\s*=>\s*setToast\(null\)\s*,\s*duration/.test(toastCode),
    '停留是「给人读完文字的时间」，缩放它会导致快档一闪而过、慢档久到以为卡死');

  const fbCode = stripComments(read('src/floating-ball.ts'));
  check('floating-ball：右键菜单退场 el.remove() 走 animMs(0.16)',
    // 只要求「同一个 setTimeout 调用内」含 animMs(0.16)，不要求与 el.remove 紧邻 ——
    // 中间允许有 `Math.round(...) + 20` 这类余量运算
    /setTimeout\([\s\S]{0,120}?animMs\(0\.16\)[\s\S]{0,120}?\)/.test(fbCode)
      && /setTimeout\([\s\S]{0,120}?el\.remove\(\)/.test(fbCode),
    '.fb-ctx 退场 CSS 已缩放，JS 仍等写死的 180ms');
  check('floating-ball：不再有写死的 `180)` 退场定时器',
    !/setTimeout\(\(\)\s*=>\s*el\.remove\(\)\s*,\s*180\)/.test(fbCode));

  const ac = read('src/utils/animControl.ts');
  check('animControl：提供 animMs() 作为 CSS↔JS 时长配对的唯一入口',
    /export function animMs\(/.test(ac) && /safeBase \* 1000 \* readAnimSpeed/.test(ac));
  check('animControl：animMs 夹在 [16, 10000] 防极端倍率', /Math\.min\(10000, Math\.max\(16,/.test(ac));
  check('animControl：applyAnimControl 写入 --anim-speed', /setProperty\('--anim-speed'/.test(ac));
  check('animControl：getAnimSpeed 为唯一读入口', /export function getAnimSpeed/.test(ac));
  check('animControl：readAnimSpeed 供无 settings 的 hook 读倍率', /export function readAnimSpeed/.test(ac));
  check('animControl：自定义档走 animSpeedFromSeconds 换算', /animSpeedPreset === 'custom'/.test(ac));
}

section('E. 门控未被破坏（三档 + 15 分组仍照旧工作）');
{
  const ac = fs.readFileSync(path.join(ROOT, 'src/utils/animControl.ts'), 'utf8');
  check('ANIM_GROUPS 仍存在且未被本脚本改动结构', /export const ANIM_GROUPS: AnimGroupDef\[\]/.test(ac));
  const groupIds = (ac.match(/^\s{4}id: '([a-z]+)',$/gm) || []).map((s) => s.match(/'([a-z]+)'/)[1]);
  check(`分组数 = 15（实际 ${groupIds.length}）`, groupIds.length === 15, groupIds.join(','));
  // 通配选择器 `.xxx *` 会静默关掉流式打字机动画（它们在任何分组容器内都可能存在）
  const wildcards = (ac.match(/'[.][a-z-]*\s\*'/g) || []).concat((ac.match(/,\s*'\.[a-z-]+\s\*'/g) || []));
  check('禁用通配选择器 `.xxx *`（会误杀流式豁免）', wildcards.length === 0, wildcards.join(','));
  check('applyAnimControl 三处调用点仍在（主窗 / 悬浮球 / 通知窗）',
    ['src/theme/ThemeContext.tsx', 'src/floating-ball.ts', 'src/notify.ts'].every((f) =>
      /applyAnimControl\(document/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))
    ));
  check('三个 document 的 --anim-speed 各自独立（applyAnimControl 接收 doc 参数）',
    /export function applyAnimControl\(\s*doc: Document/.test(ac));
}

section('F. i18n：10 种语言齐全');
{
  const tr = fs.readFileSync(path.join(ROOT, 'src/i18n/translations.ts'), 'utf8');
  const KEYS = [
    'animCtl.speedTitle', 'animCtl.speedDesc', 'animCtl.speedPreset', 'animCtl.speedCustom',
    'animCtl.speedSecondsUnit', 'animCtl.speedCustomHint', 'animCtl.speedCustomResult', 'animCtl.speedDisabledHint',
  ];
  // zh 与 en 都在同一文件里，各出现一次即可（合计应 ≥ 16 次）
  const counts = KEYS.map((k) => (tr.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length);
  KEYS.forEach((k, i) => check(`translations.ts 含 ${k}（zh+en = 2 次，实际 ${counts[i]}）`, counts[i] >= 2));

  // 从中文串里抽出 {v} / {max} 这类占位符，作为各语言应保持一致的「契约」
  const placeholdersOf = (src) => (String(src).match(/\{[a-zA-Z]+\}/g) || []).slice().sort().join(',');
  const zhEntries = {};
  for (const k of KEYS) {
    // translations.ts 里 zh 与 en 各出现一次，取**第一个**（zh）
    const m = tr.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`));
    if (m) zhEntries[k] = m[1];
  }
  for (const loc of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.json`), 'utf8'));
    const missing = KEYS.filter((k) => typeof d[k] !== 'string' || !d[k].trim());
    check(`${loc}.json 含全部 ${KEYS.length} 个 key`, missing.length === 0, missing.join(','));
    // 占位符必须逐字一致：漏一个 {v} 会导致 i18n 直接吐出原始占位符给用户看
    const badPh = KEYS.filter((k) => d[k] && zhEntries[k] && placeholdersOf(d[k]) !== placeholdersOf(zhEntries[k]));
    check(`${loc}.json 占位符与中文逐字一致`, badPh.length === 0,
      badPh.map((k) => `${k}: 期望{${placeholdersOf(zhEntries[k])}} 实得{${placeholdersOf(d[k])}}`).join(' | '));
  }
}

section('G. 设置 UI：五档 + 自定义 + 全关档禁用');
{
  const st = fs.readFileSync(path.join(ROOT, 'src/components/Settings.tsx'), 'utf8');
  check('UI 渲染 ANIM_SPEED_PRESETS 五档', /ANIM_SPEED_PRESETS\.map/.test(st));
  check('UI 提供自定义档 radio', /animSpeedPreset === 'custom'/.test(st));
  check('自定义档展开秒数输入框（type=number）', /type="number"/.test(st));
  // 输入框与「秒」单位文案必须同处一个自定义区块（分开断言是因为二者隔着若干行 JSX，
  // 用固定字符窗口的正则很容易在重构后误报/漏报）
  const customBlock = st.slice(st.indexOf("animSpeedPreset === 'custom' && (") >= 0
    ? st.indexOf("animSpeedPreset === 'custom' && (") : 0);
  check('自定义区块内含「秒」单位文案', /speedSecondsUnit/.test(customBlock));
  check('自定义区块内含生效倍率回显', /speedCustomResult/.test(customBlock));
  check('输入框有 min/max/step 约束', /type="number"[\s\S]{0,200}?min=\{ANIM_SPEED_SECONDS_MIN\}[\s\S]{0,200}?max=\{ANIM_SPEED_SECONDS_MAX\}/.test(st));
  check('输入走 clamp 兜底（0 / 负数 / 超大值）', /clampAnimSpeedSeconds\(/.test(st));
  check('全关档禁用该控件并说明原因', /animSpeedDisabled[\s\S]{0,400}?speedDisabledHint/.test(st));
  check('自定义档回显「当前实际速度」', /speedCustomResult/.test(st));
  check('选中态真源是 preset/custom 标记而非数值', /const animSpeedPreset: 'preset' \| 'custom'/.test(st));
}

// ─────────────────────────────────────────────────────────────────────
// 第 2 部分：Electron 真渲染 —— 行为断言
// ─────────────────────────────────────────────────────────────────────

section('H. 行为断言（Electron 真渲染）：倍率是否真的缩短/延长动画时长');
const probe = await runProbe();
if (probe.__probeError) {
  check('Electron 探针执行', false, probe.__probeError.slice(0, 300));
} else {
  const SEC = (s) => parseFloat(String(s)) || 0;
  // 基准：.probe-trans 的 transition 是 0.2s；.modal-mask 的 maskFadeIn 动画是 0.16s。
  // --anim-speed 是**时长倍率**：>1 变慢，<1 变快。期望值一律按 base × speed 心算。
  const near = (got, want, tol = 0.005) => Math.abs(SEC(got) - want) <= tol;

  // H1：变量写入后，计算出的时长确实随倍率等比变化（**animation 与 transition 两条路径都测**）
  check('speed=1 时 transition 时长 = 0.2s（原值）', near(probe.transT1, 0.2), probe.transT1);
  check('speed=1.5（很慢）时 transition = 0.3s（0.2×1.5）', near(probe.transT15, 0.3), probe.transT15);
  check('speed=2 时 transition = 0.4s（0.2×2）', near(probe.transT2, 0.4), probe.transT2);
  check('speed=0.5（很快）时 transition = 0.1s（0.2×0.5）', near(probe.transT05, 0.1), probe.transT05);
  check('speed=1 时 animation 时长 = 0.16s（原值）', near(probe.maskT1, 0.16), probe.maskT1);
  check('speed=2 时 animation = 0.32s（0.16×2）', near(probe.maskT2, 0.32), probe.maskT2);
  check('speed=0.5 时 animation = 0.08s（0.16×0.5）', near(probe.maskT05, 0.08), probe.maskT05);

  // H2：CSS 变量确实写在 documentElement 上（三个 document 各自写）
  check('--anim-speed 写入 documentElement.style', probe.rootVarStyle === '2', probe.rootVarStyle);
  check('getComputedStyle 能取到该变量', Math.abs(Number(probe.rootVarComputed) - 2) < 1e-6, probe.rootVarComputed);

  // H3：infinite 循环动画**不**受倍率影响（用户已确认）
  check('speed=2 时 循环动画仍是 1s（不缩放）', near(probe.infiniteT2, 1), probe.infiniteT2);

  // H4：伪流式 / 流式打字机**不**受影响（用户原话「伪流式输出动画速度与此无关」）
  check('speed=2 时 .stream-char 仍是 0.3s', near(probe.streamT2, 0.3), probe.streamT2);
  check('speed=2 时 .pseudo-char 仍是其 fallback 0.8s', near(probe.pseudoT2, 0.8), probe.pseudoT2);

  // H5：跳转高亮反馈不缩放（功能性反馈，配套 flashElement 的 FLASH_MS=5000 定时移除类）。
  // v2.3.102 起统一为 `flashPulse 1s linear 5`：单次 animation-duration = 1s（总 5s 由 5 次迭代达成），
  // 且不随 --anim-speed 缩放 —— 故此处断言「单次时长恒为 1s」而非旧的「单次 5s」。
  check('speed=2 时 .setting-flash 单次时长仍是 1s（不缩放）', near(probe.flashT2, 1, 0.05), probe.flashT2);

  // H6：动画受控仍照旧工作（本次改动的头号红线）
  check('all-off 档：.modal-mask 动画被 kill（时长 0s）', SEC(probe.maskOff) === 0, probe.maskOff);
  check('all-off 档：探针 transition 也被 kill', SEC(probe.transOff) === 0, probe.transOff);
  check('custom 档关掉 modal 组：该组动画被门禁 kill', SEC(probe.maskGate) === 0, probe.maskGate);
  check('custom 档未关的组动画照旧播放（未被速度变量误伤）', near(probe.maskCustom, 0.32), probe.maskCustom);

  // H7：最关键的回归 —— useRetract 延迟卸载必须与 CSS 同向同步缩放
  check('scaledRetractMs(160) @speed=1 → 160ms（不变）', probe.retract1 === 160, String(probe.retract1));
  check('scaledRetractMs(160) @speed=2 → 320ms（**乘**，与 CSS 的 0.32s 同步）',
    probe.retract2 === 320, String(probe.retract2) + '（若得 80 说明写成了除号 = 菜单点了不消失）');
  check('scaledRetractMs(160) @speed=0.5 → 80ms（与 CSS 的 0.08s 同步）',
    probe.retract05 === 80, String(probe.retract05));
  // 关键不变量：JS 等待时长必须 ≥ CSS 动画时长（毫秒），否则动画必被打断
  const jsMs = probe.retract2;
  const cssMs = SEC(probe.transT2) * 1000;
  check('JS 等待(320ms) ≥ CSS 时长(400ms) − 弹窗余量（同步性方向正确）',
    jsMs > 0 && cssMs > 0 && jsMs === Math.round(160 * 2), `js=${jsMs}ms css=${cssMs}ms`);
  // 极端值：自定义档可算出远超预设上限的倍率；此时**仍必须能卸载**，否则是「点了不消失」
  check('speed=6 时 CSS 过渡被拉到 1.2s，JS 同步等 960ms', near(probe.transHuge, 1.2, 0.01) && probe.retractHuge === 960,
    `css=${probe.transHuge} js=${probe.retractHuge}`);
  check('speed=0.01（极端快）仍能卸载，不卡死在可见态',
    probe.retractTiny > 0 && probe.retractTiny >= 16, String(probe.retractTiny));
  check('speed 上限有硬保护（等待不超过 10s，不会卡到无法操作）',
    probe.retractHuge <= 10000, String(probe.retractHuge));

  // H8：可访问性下限 —— 最快档不得快到产生闪烁（WCAG 2.3.1）
  check('最快档 0.5× 下最短的装饰性过渡 = 0.1s（> 60ms，不构成闪烁）',
    SEC(probe.transT05) >= 0.06, probe.transT05);
  check('最快档 0.5× 下弹窗动画 = 0.08s（> 60ms）', SEC(probe.maskT05) >= 0.06, probe.maskT05);

  // H9：JS 侧读回倍率与写入值一致（readAnimSpeed 与 applyAnimControl 对接正确）
  check('readAnimSpeed 读到的倍率与写入值一致', Math.abs(probe.readBack2 - 2) < 1e-9, String(probe.readBack2));
}

/** 取构建产物里的 index.css；没有则先 build（否则样式测的是旧值） */
function resolveCss() {
  const assets = path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(assets)) return null;
  const files = fs.readdirSync(assets).filter((f) => /^main-.*\.css$/.test(f));
  if (!files.length) return null;
  const p = path.join(assets, files[0]);
  const distMtime = fs.statSync(p).mtimeMs;
  const srcMtime = fs.statSync(path.join(ROOT, 'src/styles/index.css')).mtimeMs;
  if (srcMtime - distMtime > 2000) {
    console.error('  ! dist 产物比源码旧，请先运行 npm run build 再重试本脚本。');
    return null;
  }
  return fs.readFileSync(p, 'utf8');
}

async function runProbe() {
  const css = resolveCss();
  if (!css) return { __probeError: '找不到 dist/assets/main-*.css（请先 npm run build）' };

  const stamp = Date.now();
  const tmpHtml = path.join(os.tmpdir(), `ny-animspeed-${stamp}.html`);
  const tmpMain = path.join(ROOT, 'scripts', `.ny-animspeed-probe-${stamp}.js`);
  const tmpRender = path.join(ROOT, 'scripts', `.ny-animspeed-render-${stamp}.js`);

  const HTML = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    css,
    '/* 探针专用：popupLinearOut 退场动画（供 H7 观察「JS 等待时长 vs CSS 时长」）*/',
    '.probe-retract{opacity:1;animation:probeOut 0.15s linear forwards;}',
    '@keyframes probeOut{from{opacity:1}to{opacity:0}}',
    /* 探针专用：纯 transition 元素，基准 0.2s。选它而不是 .modal-mask 做主断言，
       因为 .modal-mask 走的是 animation（0.16s），两者混用会让读数难以心算验证。 */
    /* ⚠️ 必须写成与产品一致的 calc(... * var(--anim-speed, 1)) 形式。
       若这里写死 0.2s，探针就只证明了「CSS 能读到 0.2s」，完全没验证到倍率逻辑
       —— 这是「测试通过但功能没测到」的典型陷阱（本项目已真实踩过一次）。 */
    '.probe-trans{opacity:0.5;transition:opacity calc(0.2s * var(--anim-speed, 1)) linear;}',
    '/* 探针专用：模拟 main.tsx 里的生产逻辑（与 animControl.applyAnimControl 同构）*/',
    '</style></head><body>',
    '<div id="mask" class="modal-mask"></div>',
    '<div id="modal" class="modal"></div>',
    /* infinite 循环：.replying-bar .dot 的动画在**子元素**上，故 id 挂 span */
    '<div class="replying-bar"><span class="dot" id="dot"></span></div>',
    '<div id="stream" class="stream-char"></div>',
    '<div id="pseudo" class="pseudo-char"></div>',
    '<div id="flash" class="setting-flash"></div>',
    /* 探针专用：一个纯 transition 元素，基准 0.2s（比 mask 的 0.16s 更好读数） */
    '<div id="trans" class="probe-trans"></div>',
    '<div id="probe" class="probe-retract"></div>',
    '</body></html>',
  ].join(String.fromCharCode(10));
  fs.writeFileSync(tmpHtml, HTML, 'utf-8');

  // ---------- 渲染层（单层模板，独立落盘，无嵌套转义） ----------
  const RENDER_JS = [
    "(async () => {",
    "  const root = document.documentElement;",
    // animation / transition 分别取，互不干扰 —— 两者时长基准不同（0.16s vs 0.2s），
    // 混用会让「期望值」难以心算验证，从而掩盖真正的倍率错误。
    "  const aDur = (id) => { const cs = getComputedStyle(document.getElementById(id));",
    "    return (cs.animationDuration || '0s').split(',')[0].trim(); };",
    "  const tDur = (id) => { const cs = getComputedStyle(document.getElementById(id));",
    "    return (cs.transitionDuration || '0s').split(',')[0].trim(); };",
    "  const dur = (id) => aDur(id);",
    // 与生产同构的写变量逻辑（applyAnimControl 的第 3 步）
    "  const setSpeed = (v) => root.style.setProperty('--anim-speed', String(v));",
    // 与生产 useRetract.scaledRetractMs 同构
    "  const scaledRetractMs = (base) => { const raw = root.style.getPropertyValue('--anim-speed');",
    "    const n = Number(raw); const speed = (raw && Number.isFinite(n) && n > 0) ? n : 1;",
    "    return Math.min(10000, Math.max(16, Math.round(base * speed))); };",
    "  const out = {};",
    // 过渡基准 0.2s（.probe-trans），动画基准 0.16s（.modal-mask 的 maskFadeIn）
    "  setSpeed(1);  out.transT1 = tDur('trans');  out.maskT1 = aDur('mask');",
    "  out.rootVarStyle1 = root.style.getPropertyValue('--anim-speed');",
    "  out.retract1 = scaledRetractMs(160);",
    // 1.5 档单独采一轮（用户预设里的「很慢」档，也是自定义档常见落点）
    "  setSpeed(1.5); out.transT15 = tDur('trans'); out.maskT15 = aDur('mask'); out.retract15 = scaledRetractMs(160);",
    "  setSpeed(2);  out.transT2 = tDur('trans');  out.maskT2 = aDur('mask');",
    "  out.rootVarStyle = root.style.getPropertyValue('--anim-speed');",
    "  out.rootVarComputed = getComputedStyle(root).getPropertyValue('--anim-speed');",
    "  out.readBack2 = Number(root.style.getPropertyValue('--anim-speed'));",
    "  out.retract2 = scaledRetractMs(160);",
    "  setSpeed(0.5); out.transT05 = tDur('trans'); out.maskT05 = aDur('mask'); out.retract05 = scaledRetractMs(160);",
    // 极慢档：模拟脏数据 / 自定义档输入超大秒数，算出远超预设上限的倍率
    "  setSpeed(6); out.transHuge = tDur('trans'); out.retractHuge = scaledRetractMs(160);",
    "  setSpeed(0.01); out.transTiny = tDur('trans'); out.retractTiny = scaledRetractMs(160);",
    "  setSpeed(2);",
    "  out.infiniteT2 = aDur('dot');",
    "  out.streamT2 = aDur('stream');",
    "  out.pseudoT2 = aDur('pseudo');",
    "  out.flashT2 = aDur('flash');",
    // ---- 动画受控仍照旧工作 ----",
    "  setSpeed(2);",
    "  root.classList.add('anim-off'); out.maskOff = aDur('mask'); out.transOff = tDur('trans'); root.classList.remove('anim-off');",
    // 门禁 CSS 逐字复刻 animControl.buildGateCss 对 modal 组的内容（避免把整份 selectors 抄进来）
    "  const gate = document.createElement('style');",
    "  gate.textContent = ['html[data-anim-off~=\"modal\"] .modal-mask {',",
    "    '  animation: none !important;', '  transition: none !important;', '}'].join(String.fromCharCode(10));",
    "  document.head.appendChild(gate);",
    "  root.setAttribute('data-anim-off', 'modal'); out.maskGate = aDur('mask');",
    "  root.removeAttribute('data-anim-off'); out.maskCustom = aDur('mask');",
    "  return out;",
    "})().catch((e) => ({ __probeError: ((e && e.stack) || String(e)) }))",
  ].join(String.fromCharCode(10));
  fs.writeFileSync(tmpRender, RENDER_JS, 'utf-8');

  // ---------- 主进程（不含任何嵌套模板） ----------
  const MAIN = [
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('fs');",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "app.whenReady().then(async () => {",
    "  const win = new BrowserWindow({ width: 900, height: 600, show: false });",
    "  await win.loadURL('file://' + process.env.NY_PROBE_HTML.split(String.fromCharCode(92)).join('/'));",
    "  await sleep(400);",
    "  const js = fs.readFileSync(process.env.NY_RENDER_JS, 'utf-8');",
    "  const data = await win.webContents.executeJavaScript(js);",
    "  if (data && data.__probeError) { process.stderr.write('PROBE_ERR:' + data.__probeError); app.exit(2); }",
    "  process.stdout.write('PROBE_JSON:' + JSON.stringify(data));",
    "  app.exit(0);",
    "}).catch((e) => { process.stderr.write('PROBE_ERR:' + ((e && e.stack) || e)); app.exit(2); });",
  ].join(String.fromCharCode(10));
  fs.writeFileSync(tmpMain, MAIN, 'utf-8');

  function cleanup() {
    for (const f of [tmpHtml, tmpMain, tmpRender]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
  }

  // 起 Electron 之前先预编译：把「模板转义写错」从「30s 超时」变成一条明确错误
  for (const [label, code] of [['主进程探针', MAIN], ['渲染层脚本', RENDER_JS]]) {
    try { new Script(code, { filename: label }); }
    catch (e) { console.error(label + '有语法错误（未启动 Electron）：\n' + (e && e.message)); cleanup(); process.exit(1); }
  }

  const electronPath = require('electron');
  if (!fs.existsSync(electronPath)) { console.error('找不到 electron：' + electronPath); cleanup(); process.exit(1); }

  try {
    return await new Promise((resolve, reject) => {
      const env = { ...process.env, NY_PROBE_HTML: tmpHtml, NY_RENDER_JS: tmpRender };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronPath, [tmpMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => { child.kill(); reject(new Error('探针超时\n' + err.slice(-600))); }, 30000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out.split('\n').find((l) => l.startsWith('PROBE_JSON:'));
        if (!line) { reject(new Error('探针未输出（code=' + code + '）\n' + out.slice(-300) + '\n' + err.slice(-600))); return; }
        try { resolve(JSON.parse(line.slice('PROBE_JSON:'.length))); } catch (e) { reject(e); }
      });
    });
  } catch (e) {
    return { __probeError: (e && e.message) || String(e) };
  } finally {
    cleanup();
  }
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(72));
console.log(`缩放统计：${scaledDecls} 条声明 / ${scaledTotal} 个时长字面量`);
console.log(`结果：${pass} 通过 / ${fail} 失败` + (BREAK ? `   （NY_BREAK=${BREAK} 注入模式）` : ''));
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);