// 扫描 src/ 下所有用户可见文案里的**硬编码中文**（漏做 i18n 的文案）。
// 用法：node scripts/scan-hardcoded-i18n.mjs [--fix-report]
//
// 判定口径（宁可多报也不漏报）：
//   ① JSX 文本节点 / JSX 属性值里的中文 → 必报（这些直接显示给用户）
//   ② 字符串字面量里的中文 → 报，但标注「需人工确认是否用户可见」
//      （大量中文是注释/内部标识/日志，不该进 i18n 字典）
//   ③ 已包在 t('...') 里的中文 → 不报
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const CJK = /[\u4e00-\u9fff]/;

/** 逐文件扫描：剔除注释与字符串字面量后，报告剩余的中文 */
function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const out = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();
    // 跳过整行注释
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // 行内注释：去掉 // 之后的内容（粗略，忽略 URL 里的 //）
    let code = line;
    const ci = code.indexOf('//');
    if (ci >= 0) {
      const before = code.slice(0, ci);
      // 排除 "http://" 之类
      if (!/['"`]\s*$/.test(before) || /https?:\/\//.test(before)) {
        const q = before.match(/(['"`])[^'"`]*$/);
        if (!q || !/:\/\//.test(before)) code = before;
      }
    }
    if (!CJK.test(code)) continue;

    // 该行是否含 t('...') 调用（说明这段中文在字典里，不算硬编码）
    const hasT = /\bt\(\s*['"`]/.test(code);

    // 分类
    let kind = 'literal';
    // JSX 文本节点：> 后面直接是中文（前面没有 { 表达式）
    const jsxText = />\s*([^<>{}]*[\u4e00-\u9fff][^<>{}]*)\s*</.exec(code);
    // JSX 属性：title="中文" / placeholder="中文" / aria-label="中文"
    const jsxAttr = /(?:title|placeholder|aria-label|alt|label)\s*=\s*"([^"]*[\u4e00-\u9fff][^"]*)"/.exec(code);
    if (jsxText || jsxAttr) kind = 'jsx';

    if (hasT && kind !== 'jsx') {
      // 中文出现在 t(...) 附近 → 多半是 t 的参数（字典里），跳过
      continue;
    }
    out.push({ line: i + 1, kind, text: trimmed.slice(0, 160) });
  }
  return out;
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) files.push(p);
  }
})(SRC);

let jsxTotal = 0;
let literalTotal = 0;
const report = [];
for (const f of files) {
  const hits = scanFile(f);
  if (!hits.length) continue;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const jsx = hits.filter((h) => h.kind === 'jsx');
  const lit = hits.filter((h) => h.kind === 'literal');
  if (jsx.length || lit.length) {
    report.push({ rel, jsx, lit });
    jsxTotal += jsx.length;
    literalTotal += lit.length;
  }
}

console.log(`扫描文件：${files.length} 个（src/**/*.tsx|ts）`);
console.log(`JSX 可见文案硬编码：${jsxTotal} 处`);
console.log(`字符串字面量含中文（需人工确认）：${literalTotal} 处`);
console.log('\n================ JSX 可见文案（必须修） ================');
for (const r of report) {
  if (!r.jsx.length) continue;
  console.log(`\n${r.rel}`);
  r.jsx.forEach((h) => console.log(`  ${h.line}: ${h.text}`));
}
console.log('\n================ 字符串字面量（人工确认） ================');
for (const r of report) {
  if (!r.lit.length) continue;
  console.log(`\n${r.rel}`);
  r.lit.forEach((h) => console.log(`  ${h.line}: ${h.text}`));
}

process.exit(jsxTotal > 0 ? 1 : 0);
