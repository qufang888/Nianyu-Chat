// v2.3.101 需求 6 验证：消息总结「无新消息就不再重复总结」
// 用法：node scripts/verify-memory-cursor.mjs
//
// 可证伪性对照（每条都必须能失败）：
//   NY_DROP_CURSOR=1   node scripts/verify-memory-cursor.mjs   应当失败（模拟删掉游标判重）
//   NY_LATE_CURSOR=1   node scripts/verify-memory-cursor.mjs   应当失败（把游标判定挪到模型判定之后）
//
// 需求原文：「消息总结时，如果没有新的消息可以总结，会如实提示，并不会再次重新总结消息。」
// 判定依据：源文件为真实逻辑的静态门禁（doExtractMemories 依赖 electron/db 无法在 node 里直接跑，故做源码级断言）。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FORCE = {
  dropCursor: process.env.NY_DROP_CURSOR === '1',
  lateCursor: process.env.NY_LATE_CURSOR === '1',
};

let pass = 0,
  fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

let main = read('electron/main.ts');
if (FORCE.dropCursor) {
  // 删掉游标判重那一行
  main = main.replace(/if \(lastMsgId !== undefined && lastMsgId <= cursor\) return -1;/, '');
  console.log('  (NY_DROP_CURSOR=1 → 已删掉「无新消息返回 -1」的游标判重)');
}

section('1. 游标字段与来源');
check('main.ts 使用 settings.lastSummarizedMsgId', /lastSummarizedMsgId/.test(main));
check('按 chatType:chatId 归档游标（chatKey）', /const chatKey = chatKeyOf\(chatType, chatId\);/.test(main));
check(
  '游标取最新一条消息的 id',
  /const lastMsgId = history\.length > 0 \? history\[history\.length - 1\]\.id : undefined;/.test(main)
);

section('2. 无新消息 → 返回 -1（且优先于模型/角色判定）');
{
  const idxCursor = main.indexOf('lastMsgId <= cursor');
  const idxCfg = main.indexOf("if (!cfg) return -3;");
  const idxRole = main.indexOf("if (!roleId) return -3;");
  check('存在 lastMsgId <= cursor 的判重', idxCursor >= 0);
  if (FORCE.lateCursor) {
    console.log('  (NY_LATE_CURSOR=1 → 视为「游标判定晚于模型判定」，本条将失败)');
  }
  const cursorBeforeCfg = !FORCE.lateCursor && idxCursor >= 0 && idxCfg >= 0 && idxCursor < idxCfg;
  const cursorBeforeRole = !FORCE.lateCursor && idxCursor >= 0 && idxRole >= 0 && idxCursor < idxRole;
  check('游标判定在「无可用模型」判定之前（无新消息优先如实回「没有新的可总结内容」）', cursorBeforeCfg);
  check('游标判定在「角色缺失」判定之前', cursorBeforeRole);
}

section('3. 返回码语义完整性（-1 / -2 / -3）');
check('无新消息返回 -1', /return -1;/.test(main));
check('调用/异常失败返回 -2', /return -2;/.test(main));
check('无法总结（未配模型/角色缺失）返回 -3', /return -3;/.test(main));
check('成功总结后推进游标（写 lastSummarizedMsgId）', /lastSummarizedMsgId: cursors/.test(main));

section('4. 手动总结 IPC 三/四态分派与话术');
check("IPC 对 -1 回「没有新的可总结内容」", /count === -1[\s\S]{0,160}?没有新的可总结内容/.test(main));
check("IPC 对 -2 回「总结失败，请稍后重试」", /count === -2[\s\S]{0,160}?总结失败，请稍后重试/.test(main));
check("IPC 对 -3 给出「无法总结」提示（与「无新消息」区分）", /count === -3[\s\S]{0,200}?无法总结/.test(main));
check('游标推进发生在成功路径（try 内、addMemory 之后）', /dm\.addMemory\([\s\S]{0,600}?lastSummarizedMsgId/.test(main));

section('5. types.ts 字段与默认值');
{
  const types = read('src/types.ts');
  check('types.ts 定义 lastSummarizedMsgId?: Record<string, number>', /lastSummarizedMsgId\?:\s*Record<string,\s*number>/.test(types));
  check('DEFAULT_SETTINGS 中 lastSummarizedMsgId: {}', /lastSummarizedMsgId:\s*\{\s*\}/.test(types));
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
