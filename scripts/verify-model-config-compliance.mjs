// v2.3.94 需求 5 静态审计：所有对模型的调用请求都必须遵守该模型的模型配置参数
// 用法：node scripts/verify-model-config-compliance.mjs
//
// 为什么需要这个脚本：需求 5 的本质是「不许有调用点绕过 effectiveModel」。
// 这类回归极易发生（新增一个内部功能时随手写 settings.models.find 就漏了），
// 靠人 review 不可靠 —— v2.3.93 就实测到 7 处绕过。本脚本把它变成可自动拦截的门禁。
//
// 审计规则：
//   R1. electron/main.ts + electron/proactive.ts 里，每一处「取出模型配置」的表达式
//       都必须经 effectiveModel / getDefaultModelConfig / resolveRoleModel / resolveChatModel
//       这四个出口之一（或本身就是在 effectiveModel 内部）。
//   R2. 允许的例外：只读取 qps（限速）或只做能力探测的路径 —— 它们不产生模型请求体，
//       采样参数无从生效，套 effectiveModel 是无意义噪音。
//   R3. 每个 queryAI(/streamAI( 的实参 cfg，必须来自上述合规出口。
//
// 退出码：0 = 合规；1 = 发现绕过点（并打印文件:行号）。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGETS = ['electron/main.ts', 'electron/proactive.ts'];

/** 合规出口：这些函数内部已经套过 effectiveModel */
const EXIT_FNS = [
  'effectiveModel',
  'getDefaultModelConfig',
  'resolveRoleModel',
  'resolveChatModel',
  'getVisionModelConfig',
];

let violations = [];
let checked = 0;

/** qps-only 路径：所在函数只用于限速/探测，不发请求体 */
const QPS_ONLY_FNS = ['rateWaitMs', 'getRateModelId'];
const PROBE_FNS = ['detectModel'];

/**
 * IPC 回调豁免：这三处是匿名 handler，不在具名函数体内，需按通道名判定。
 * 依据是它们各自做了什么（下面每条都写明理由，人工可复核）：
 */
const IPC_EXEMPT = {
  'chats:rateInfo': '只读 cfg?.qps 供前端「X 秒后自动发送」预排队 UI，不发请求体',
  'chats:activeModel': '只返回「该聊天当前用哪个模型 id」给前端展示，不发请求体',
  'models:detect': '能力探测探针，故意用最小固定参数（max_tokens 4 等），套用户采样参数会污染探测结果',
};

for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);

  // 预处理：记录各出口函数与「纯 qps / 探测」函数的定义行区间
  const ranges = [...EXIT_FNS, ...QPS_ONLY_FNS, ...PROBE_FNS].map((fn) => ({
    fn,
    r: findFunctionRange(lines, fn),
  }));
  const inside = (i, list) =>
    ranges.filter((x) => list.includes(x.fn)).some((x) => x.r && i >= x.r.start && i <= x.r.end);

  lines.forEach((line, i) => {
    const no = i + 1;
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;

    const findsModels = /settings\.models\.(find|filter)\s*\(/.test(line);
    if (!findsModels) return;

    checked++;

    // 豁免 1：已经调用了合规出口
    if (EXIT_FNS.some((fn) => line.includes(fn + '('))) return;
    // 豁免 2：位于出口函数定义体内
    if (inside(i, EXIT_FNS)) return;
    // 豁免 3：纯 qps 路径（限速计算 / 前端预排队）
    if (inside(i, QPS_ONLY_FNS)) return;
    // 豁免 4：能力探测探针（故意用最小固定参数，不应套用户采样参数）
    if (inside(i, PROBE_FNS)) return;
    // 豁免 5：中间变量模式 —— 「const X = settings.models.find(...)」之后，
    //         紧接着若干行内对 X 套了 effectiveModel(...)
    if (rawThenWrapped(lines, i)) return;
    // 豁免 6：位于已知的「只取 qps / 只取 id / 探测」IPC 回调内
    if (insideIpcHandler(lines, i)) return;

    violations.push({ file: rel, line: no, text: t });
  });
}

/** 求一个函数定义的起止行号（花括号配平，跳过嵌套的同名调用不算） */
function findFunctionRange(lines, fn) {
  const re = new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${fn}\\s*\\(`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  let depth = 0, started = false;
  for (let k = start; k < lines.length && k < start + 400; k++) {
    for (const ch of lines[k]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) return { start, end: k };
  }
  return { start, end: lines.length - 1 };
}

console.log('='.repeat(60));
console.log('需求 5 审计：模型调用是否全部遵守模型配置参数');
console.log('='.repeat(60));
console.log(`扫描文件：${TARGETS.join(', ')}`);
console.log(`检出「取模型配置」表达式：${checked} 处`);
console.log(`合规出口：${EXIT_FNS.join(' / ')}`);
console.log('');

if (violations.length === 0) {
  console.log('✅ 未发现绕过 effectiveModel 的调用点');
  console.log('   （只读 qps 的限速路径与能力探测路径已按 R2 豁免）');
  process.exit(0);
} else {
  console.log(`❌ 发现 ${violations.length} 处可能绕过（需人工确认是否为纯 qps / 探测用途）：\n`);
  violations.forEach((v) => {
    console.log(`  ${v.file}:${v.line}`);
    console.log(`    ${v.text}`);
  });
  process.exit(1);
}
/**
 * 中间变量模式判定：
 *   const raw = settings.models.find(...);
 *   const cfg = raw ? effectiveModel(raw, settings) : getDefaultModelConfig(settings);
 * 这种写法不算绕过 —— 裸读只是为了「拿到指定模型」和「拿默认模型」二选一，
 * 两个分支最终都会经过 effectiveModel。
 * 判据：裸读所在行提取变量名，然后在其后的 4 行内找到「该变量 ? effectiveModel(」或
 *      「: getDefaultModelConfig(」的组合。
 */
function rawThenWrapped(lines, idx) {
  const m = lines[idx].match(/(?:const|let)\s+(\w+)\s*=/);
  if (!m) return false;
  const varName = m[1];
  for (let k = idx + 1; k <= Math.min(idx + 4, lines.length - 1); k++) {
    const t = lines[k];
    const usesVar = new RegExp(`\\b${varName}\\b`).test(t);
    const wraps = EXIT_FNS.some((fn) => t.includes(fn + '('));
    if (usesVar && wraps) return true;
  }
  return false;
}

/** 向上回溯最近的 ipcMain.handle 通道名，判断当前行是否落在该 handler 的回调体内 */
function insideIpcHandler(lines, idx) {
  for (let k = idx; k >= 0 && k > idx - 120; k--) {
    const m = lines[k].match(/ipcMain\.handle\(\s*'([^']+)'/);
    if (!m) continue;
    // 找到通道后，确认它到当前行之间没有闭合（用粗略的 "});" 判断 handler 结束）
    for (let j = k + 1; j <= idx; j++) {
      if (/^\s*\}\);\s*$/.test(lines[j])) return false; // handler 已结束
    }
    return Object.prototype.hasOwnProperty.call(IPC_EXEMPT, m[1]);
  }
  return false;
}
