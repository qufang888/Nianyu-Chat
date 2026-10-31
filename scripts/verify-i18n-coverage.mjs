#!/usr/bin/env node
/**
 * verify-i18n-coverage.mjs — v3.0.1-beta.4「功能 UI 全量 i18n 覆盖」常驻闸门。
 *
 * ── 这个闸门防的是什么回归（用户反馈）────────────────────────────────────────
 *   「调用 Skill 的那个显示似乎没有做 I18N 覆盖，要把软件所有地方的 I18N 全部覆盖全。」
 *
 * ── 判定口径 ─────────────────────────────────────────────────────────────────
 *   扫描 src 下的 tsx / ts，剔除注释与字符串字面量后，找出**用户可见**的中文硬编码：
 *     ① JSX 文本节点里的中文          → 必报（直接显示给用户）
 *     ② JSX 属性值（title/placeholder/aria-label/alt/label）里的中文 → 必报
 *   已包在 t('...') 里的不算硬编码。
 *
 *   **白名单（有意为之，非遗漏）**：
 *     · src/components/GuideView.tsx —— 软件内「使用指南」是根目录《使用说明.md》的
 *       **中文原版内嵌**（文件头明确写着「同步约定：本文件内容必须与根目录《使用说明.md》
 *       保持一致（文档为权威源）」）。该手册只有中文版，故此处刻意不译；
 *       改译会破坏「文档为权威源」的同步约定。
 *     · Settings.tsx 的 `kw: [...]` —— 设置搜索的**中文关键词表**（用于模糊匹配用户输入的
 *       中文），属功能性数据而非可见文案，保留中文是必需的。
 *
 *   另：i18n 键本身的**键集一致 / 非空 / 占位符一致**由 verify-i18n.mjs 负责，
 *      本脚本只管「有没有漏 t() 的硬编码文案」。
 *
 * 用法：node scripts/verify-i18n-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** 白名单：相对 src 的路径（路径分隔符统一为 /） */
const WHITELIST = new Set(['components/GuideView.tsx']);

const CJK = /[\u4e00-\u9fff]/;

/** 逐行扫描一个文件，返回用户可见的中文硬编码 */
function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const hits = [];
  let inBlockComment = false;
  let inJsxBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    // 多行 JSX 注释块的中段（{/* ... */} 内部）：以 * 开头或仍在块内 → 跳过
    if (inJsxBlockComment) {
      if (trimmed.includes('*/')) inJsxBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) inJsxBlockComment = true;
      continue;
    }

    // 去掉行尾注释（排除 URL 里的 // 与字符串内的 //）
    let code = line;
    const ci = code.indexOf('//');
    if (ci >= 0) {
      const before = code.slice(0, ci);
      if (!/['"`]\s*$/.test(before) || /https?:\/\//.test(before)) code = before;
    }
    if (!CJK.test(code)) continue;
    // 已在 t(...) 调用里的中文（字典内容）不算硬编码
    if (/\bt\(\s*['"`]/.test(code)) continue;

    // JSX 文本节点：> 中文 <
    const jsxText = />\s*([^<>{}]*[\u4e00-\u9fff][^<>{}]*)\s*</.exec(code);
    // JSX 属性：title="中文" 等
    const jsxAttr = /(?:title|placeholder|aria-label|alt|label)\s*=\s*"([^"]*[\u4e00-\u9fff][^"]*)"/.exec(code);
    if (jsxText || jsxAttr) {
      hits.push({ line: i + 1, text: trimmed.slice(0, 140) });
      continue;
    }
    // 其余（字符串字面量等）→ 人工确认类，单独计数
  }
  return hits;
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) files.push(p);
  }
})(SRC);

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};

console.log(`扫描 ${files.length} 个源文件（src/**/*.tsx|ts）\n`);

const offenders = [];
for (const f of files) {
  const rel = path.relative(SRC, f).replace(/\\/g, '/');
  if (WHITELIST.has(rel)) continue;
  const hits = scanFile(f);
  if (hits.length) offenders.push({ rel, hits });
}

console.log('=== 用户可见文案硬编码（须走 t()）===');
if (offenders.length === 0) {
  check('功能 UI 无硬编码中文文案（JSX 文本 / title / placeholder / aria-label）', true);
} else {
  for (const o of offenders) {
    console.log(`\n${o.rel}`);
    o.hits.forEach((h) => console.log(`  ${h.line}: ${h.text}`));
  }
  check(
    '功能 UI 无硬编码中文文案（JSX 文本 / title / placeholder / aria-label）',
    false,
    `${offenders.length} 个文件共 ${offenders.reduce((n, o) => n + o.hits.length, 0)} 处`,
  );
}

// 白名单说明必须显式存在（防止有人误把 GuideView 加白名单而不自知）
check(
  `白名单仅含「使用指南内嵌中文手册」：${[...WHITELIST].join(', ')}`,
  WHITELIST.size === 1 && WHITELIST.has('components/GuideView.tsx'),
);

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
process.exit(0);
