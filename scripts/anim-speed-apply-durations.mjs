/**
 * v2.3.97 界面动效速度 —— 时长批量替换器（一次性施工脚本）
 * ============================================================================
 * 目标：把 CSS / 内联样式里的**装饰性**动画时长从硬编码 `<值>s` 改写为
 *      `calc(<值>s * var(--anim-speed, 1))`，由 `applyAnimControl` 写入的
 *      `--anim-speed` 变量统一缩放。
 *
 * 用法：
 *   node scripts/.tmp-apply-anim-speed.mjs          # 只做 dry-run，打印计划
 *   node scripts/.tmp-apply-anim-speed.mjs --write  # 真正写盘
 *
 * 设计要点：
 *   1. **只改时长子串**，不重排文件、不动任何其它内容（多人并行改同一份 index.css）。
 *   2. 豁免判定全部基于**内容规则**（而不是行号），因此重复运行结果一致、幂等。
 *   3. 产出「缩放 / 豁免」逐条对照表，供交付报告与 verify 脚本交叉核对。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');

/** CSS 时长字面量：`0.15s` / `.12s` / `300ms`；要求后面不是字母数字，避免吃掉 `0.15sans` */
const DUR_RE = /(^|[\s,(])((?:\d*\.)?\d+)(m?s)(?![\w-])/g;

/** 变量表达式：所有改写统一用带兜底的形式，保证 JS 尚未写入变量时按 1× 播放 */
const V = 'var(--anim-speed, 1)';

/** 循环动画：时长即周期，缩放会改变呼吸节奏（1s→2s 显呆滞、1s→0.5s 显急促），故一律不动 */
const INFINITE_RE = /\binfinite\b/;
/** 功能性跳转高亮反馈：告诉用户「跳到哪了」，配套 setTimeout 在 Settings.tsx 里写死毫秒数 */
const FLASH_RE = /\b(settingFlash|modelFlash)\b/;
/** 伪流式输出的时长变量（其值由调用方内联传入，有独立的 pseudoStreamSpeed 设置） */
const PSEUDO_VAR_RE = /--pseudo-char-dur/;
/** 伪流式 / 流式打字机的选择器（用户明确要求与本设置无关） */
const STREAM_SEL_RE = /(\.stream-char|\.pseudo-char)/;

// ===== 豁免名单的「可读理由」，报告与 verify 脚本共用 =====
const EXEMPT_REASONS = [
  { test: INFINITE_RE, reason: 'infinite 循环动画：时长即周期，缩放会改变呼吸/脉冲节奏（用户已确认不缩放）' },
  { test: STREAM_SEL_RE, reason: '伪流式/流式打字机：用户明确要求与此设置无关（有单独设置 pseudoStreamSpeed）' },
  { test: PSEUDO_VAR_RE, reason: '伪流式时长变量 var(--pseudo-char-dur)：值由伪流式设置内联传入' },
  { test: FLASH_RE, reason: '跳转高亮反馈：功能性提示（告诉你跳到哪了），配套 setTimeout 写死毫秒数' },
];

// ============================================================================
// index.css：按行处理 + 选择器栈追踪（判定某条声明属于哪个选择器）
// ============================================================================

/** 找出该行所属的选择器文本：从后往前找最近一个「以 { 结尾」的选择器行 */
function findOwnerSelector(lines, idx) {
  for (let i = idx; i >= 0 && i >= idx - 12; i--) {
    const t = lines[i].trim();
    if (t.endsWith('{')) return t.slice(0, -1).trim();
  }
  return '';
}

function classify(line, selector) {
  for (const r of EXEMPT_REASONS) {
    if (r.test.test(line) || (selector && r.test.test(selector))) return r.reason;
  }
  return null;
}

/**
 * 把文件解析成「声明条目」：每条 = { line, text, selector, inDecl }。
 *
 * 为什么要状态机而不是逐行独立判断：`index.css` 里存在**跨行**的 transition 声明，例如
 * ```
 *   transition:
 *     transform 0.2s linear,
 *     opacity 0.2s linear,
 *     visibility 0s linear 0.2s;
 * ```
 * 时长写在第 2~4 行上，那几行本身**不含 `transition:` 关键字**，逐行独立判断会整条漏掉
 * （实测 `.queue-dock-panel` 的收起/展开过渡共 4 个时长会被漏改 —— 这正是「漏改」类 bug 的
 * 最隐蔽形态：脚本报告「无改动」，看上去一切正常）。
 * 故这里以「`animation:`/`transition:` 开头且本行未以 `;` 结束」作为续行起点，
 * 一直吃到出现 `;` 为止，把整条声明纳入同一个条目。
 */
function parseDeclarations(lines) {
  const items = [];
  let inComment = false;
  let pending = null; // 正在续行中的声明

  const isDeclStart = (t) => /\b(animation|transition)\s*:/.test(t);
  const isDeclEnd = (t) => t.includes(';');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\/\*/.test(trimmed) && !/\*\//.test(trimmed)) inComment = true;
    if (inComment) {
      if (/\*\//.test(trimmed)) inComment = false;
      continue;
    }
    if (trimmed.startsWith('//')) continue;

    // 续行：属于上一条未闭合的声明
    if (pending) {
      pending.lines.push(i);
      if (isDeclEnd(line)) {
        items.push(pending);
        pending = null;
      }
      continue;
    }

    if (!isDeclStart(line)) continue;
    const selector = findOwnerSelector(lines, i);
    if (isDeclEnd(line)) {
      items.push({ start: i, lines: [i], selector, text: line });
    } else {
      pending = { start: i, lines: [i], selector, text: line };
    }
  }
  // 文件末尾仍有未闭合（语法错误），也纳入处理，避免静默漏改
  if (pending) items.push(pending);
  return items;
}

function transformCss(rel) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const plan = [];

  for (const item of parseDeclarations(lines)) {
    // 幂等：已含变量则跳过
    if (item.lines.some((i) => lines[i].includes('--anim-speed'))) continue;

    // 豁免判定看**整条声明**（含续行）+ 所属选择器
    const joined = item.lines.map((i) => lines[i]).join(' ');
    const reason = classify(joined, item.selector);

    const touched = [];
    for (const i of item.lines) {
      // 命中豁免规则 → 该条整体跳过替换（这是「豁免必须真的没被改」的强制点）
      if (reason) break;
      const before = lines[i];
      const after = before.replace(DUR_RE, (m, pre, num, unit) => {
        const val = Number(num);
        // 0 时长的语义是「立即切换」（配合 visibility/pointer-events 的延时技巧），
        // 乘任何倍率仍是 0，保持字面量更易读、也避免 calc(0s * var(...)) 这种无意义写法
        if (val === 0) return m;
        touched.push(`${num}${unit}`);
        return `${pre}calc(${num}${unit} * ${V})`;
      });
      lines[i] = after;
    }

    plan.push({
      file: rel,
      line: item.start + 1,
      selector: item.selector,
      before: item.lines.map((i) => lines[i].trim()).join(' ').replace(new RegExp(`${V}`, 'g'), '<原值>'),
      scaled: touched.length > 0,
      scaleCount: touched.length,
      reason:
        reason ||
        (touched.length > 0
          ? `装饰性动画/过渡：随速度档位等比缩放（${touched.length} 个时长 → ${touched.join(', ')}）`
          : /:\s*none\s*!important/.test(joined)
            ? '门禁 kill 规则（animation:none / transition:none）：无时长，本就不需缩放'
            : /var\(--transition\)/.test(joined)
              ? '引用变量 var(--transition)：已在 variables.css 的唯一定义点缩放，此处不重复改'
              : '无可缩放时长（0 时长字面量，乘任何倍率仍为 0）'),
    });
  }

  if (WRITE) fs.writeFileSync(abs, lines.join(eol), 'utf8');
  return plan;
}

// ============================================================================
// TS / TSX：显式精确替换（数量少，逐条列出便于审计，避免正则误伤）
// ============================================================================

/**
 * 每条 = [文件, 原文片段, 替换后片段, 是否允许替换全部出现]
 * 第 4 项为 true 时用于「同一段 CSS 在两个选择器里逐字重复」的情形（如 .fb-panel 与 .fb-ctx
 * 共用同一条 transition），两处都要缩放，故按 replace-all 处理并记录命中次数。
 * 缺省（false）要求原文片段**恰好出现一次**，否则脚本报错 —— 防止误伤同名但不同语义的代码。
 *
 * ⚠️ 替换文本里若要出现 CSS 变量，必须**写成字面量** `var(--anim-speed, 1)`；
 * 若图省事写 `${V}`，因为本文件里 V 是 JS 常量，最终产物会是字面的 `${V}` 文本，
 * tsc 会报 `Cannot find name 'V'`（本项目已真实踩过一次，见交付记录）。
 */
const LITERAL_V = 'var(--anim-speed, 1)';
const TS_EDITS = [
  // ---- 悬浮球（三窗渲染端，独立 document，靠 applyAnimControl 写入 --anim-speed）----
  ['src/floating-ball.ts', 'transition:transform .12s ease;', `transition:transform calc(.12s * ${LITERAL_V}) ease;`],
  ['src/floating-ball.ts', 'transition:stroke-dashoffset .25s linear;', `transition:stroke-dashoffset calc(.25s * ${LITERAL_V}) linear;`],
  ['src/floating-ball.ts', 'transition:opacity .16s linear, transform .16s linear;', `transition:opacity calc(.16s * ${LITERAL_V}) linear, transform calc(.16s * ${LITERAL_V}) linear;`, true],
  ['src/floating-ball.ts', 'transition:background .12s;', `transition:background calc(.12s * ${LITERAL_V});`],
  // ---- 通知窗（独立 document）----
  ['src/notify.ts', 'transition:transform .42s cubic-bezier(.22,.61,.36,1),opacity .42s linear;', `transition:transform calc(.42s * ${LITERAL_V}) cubic-bezier(.22,.61,.36,1),opacity calc(.42s * ${LITERAL_V}) linear;`, true],
  ['src/notify.ts', 'transition:background .15s;', `transition:background calc(.15s * ${LITERAL_V});`, true],
  // ---- 内联 TSX 样式（transition 字符串，改成模板字符串以插入 calc 表达式）----
  ['src/components/CustomScrollArea.tsx', "transition: !animOn || dragging.current ? 'none' : 'opacity 0.15s ease',", "transition: !animOn || dragging.current ? 'none' : `opacity calc(0.15s * ${LITERAL_V}) ease`,"],
  ['src/components/CustomTitleBar.tsx', "transition: animOn ? 'all 0.15s' : 'none',", "transition: animOn ? `all calc(0.15s * ${LITERAL_V})` : 'none',", true],
  ['src/components/Settings.tsx', "transition: animOn ? 'width 0.2s linear' : 'none',", "transition: animOn ? `width calc(0.2s * ${LITERAL_V}) linear` : 'none',"],
  ['src/components/VideoBubble.tsx', "transition: animOn ? 'width .3s ease' : 'none',", "transition: animOn ? `width calc(.3s * ${LITERAL_V}) ease` : 'none',"],
  // ---- 全局错误弹窗（内联 style 属性，挂在主 document 上）----
  ['src/utils/globalErrorHandler.ts', 'animation: nianyuErrorFadeIn 0.25s ease;', `animation: nianyuErrorFadeIn calc(0.25s * ${LITERAL_V}) ease;`],
];

function applyTsEdits() {
  const plan = [];
  // 按文件聚合，同一文件只读写一次
  const byFile = new Map();
  for (const [file, from, to, all] of TS_EDITS) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([from, to, !!all]);
  }
  for (const [file, edits] of byFile) {
    const abs = path.join(ROOT, file);
    let src = fs.readFileSync(abs, 'utf8');
    for (const [from, to, all] of edits) {
      const count = src.split(from).length - 1;
      const lineNo = src.slice(0, src.indexOf(from)).split(/\r?\n/).length;
      if (count === 0) {
        plan.push({ file, line: lineNo, scaled: false, reason: `!! 未找到片段（可能已被他人改动）：${from}` });
        continue;
      }
      if (count > 1 && !all) {
        plan.push({ file, line: lineNo, scaled: false, reason: `!! 片段出现 ${count} 次，无法唯一定位：${from}` });
        continue;
      }
      if (all) src = src.split(from).join(to);
      else src = src.replace(from, to);
      plan.push({
        file,
        line: lineNo,
        scaled: true,
        reason:
          count > 1
            ? `内联样式 / 独立文档 CSS：随速度档位等比缩放（同一段 CSS 在 ${count} 个选择器中重复，逐字一致故一并替换）`
            : '内联样式 / 独立文档 CSS：随速度档位等比缩放',
        before: from,
        after: to,
      });
    }
    if (WRITE) fs.writeFileSync(abs, src, 'utf8');
  }
  return plan;
}

// ============================================================================
// variables.css：唯一一处 CSS 变量时长，被 index.css 引用 37 次 —— 改一处即覆盖 37 处
// ============================================================================
function transformVariables() {
  const rel = 'src/theme/variables.css';
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const from = '  --transition: 0.3s ease;';
  const to = `  /* v2.3.97：跟随全局动画速度倍率（--anim-speed 由 animControl.applyAnimControl 写入各 document） */\n  --transition: calc(0.3s * ${V}) ease;`;
  const count = src.split(from).length - 1;
  if (WRITE && count === 1) fs.writeFileSync(abs, src.replace(from, to), 'utf8');
  return [{
    file: rel,
    line: src.slice(0, src.indexOf(from)).split(/\r?\n/).length,
    scaled: count === 1,
    reason: '唯一定义点，被 index.css 引用 37 次；改这一处即等比缩放全部 37 处',
    before: from.trim(),
    after: to.split('\n')[1].trim(),
  }];
}

// ============================================================================

const plan = [
  ...transformCss('src/styles/index.css'),
  ...transformVariables(),
  ...applyTsEdits(),
];

const scaled = plan.filter((p) => p.scaled);
const exempt = plan.filter((p) => !p.scaled);
const durCount = plan.reduce((n, p) => n + (p.scaleCount || (p.scaled ? 1 : 0)), 0);

console.log('='.repeat(96));
console.log(`v2.3.97 动画速度 · 时长替换${WRITE ? '（已写盘）' : '（DRY-RUN，未写盘）'}`);
console.log('='.repeat(96));
console.log(`\n【缩放】${scaled.length} 条声明 / 共 ${durCount} 个时长字面量：`);
for (const p of scaled) console.log(`  ${p.file}:${p.line}\t${(p.selector || '').slice(0, 40).padEnd(40)}\t${p.before.slice(0, 72)}`);
console.log(`\n【豁免 / 无需改动】共 ${exempt.length} 条：`);
for (const p of exempt) console.log(`  ${p.file}:${p.line}\t${(p.selector || '').slice(0, 40).padEnd(40)}\t${p.reason}\n      原文：${p.before || ''}`);

const errors = plan.filter((p) => p.reason.startsWith('!!'));
if (errors.length) {
  console.error(`\n!! ${errors.length} 处替换失败，请人工处理：`);
  process.exitCode = 1;
}