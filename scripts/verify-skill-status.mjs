// v3.0.1-beta.2 验证：Skill 状态「串到所有历史气泡」缺陷 + 真实机制表述
// ============================================================================
// 用法：node scripts/verify-skill-status.mjs
//
// 缺陷背景（用户实测）：
//   「发送一条消息之后，整个页面上所有的气泡底下都有『正在调用 Skill』」
//   「以前已经回复过的消息，气泡底下还有『正在调用 Skill』的显示」
//
// 根因：skillCalls 状态**按 streamId 分桶**，而 streamId = `${chatId}:${roleId}`
//   **跨轮复用**（同一会话 + 同一角色的每一轮都是同一个字符串）。
//   于是一轮新回复把 skillCalls[streamId] 置为 'calling' 时，本会话**所有历史 AI 气泡**
//   都通过 streamMsgIdRef 解析到同一个 key → 全部一起显示状态条。
//
// 断言分组：
//   A. 结构性契约：状态改按「每轮唯一 replyKey」分桶（主窗 + 小窗同构）
//   B. 行为级：用与生产同构的纯逻辑复现「两轮回复」场景，验证历史气泡不再命中
//   C. 竞态：IPC 晚于本轮结束时不得复活条目、不得把终态打回 calling
//   D. 机制表述：文案不再宣称「调用」，且 10 处语言一致（占位符保持 {name}）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : ''));
  }
}
function section(t) {
  console.log('\n===== ' + t + ' =====');
}
const read = (p) => {
  try {
    return fs.readFileSync(path.join(ROOT, p), 'utf-8');
  } catch {
    return '';
  }
};

const cw = read('src/components/ChatWindow.tsx');
const mc = read('src/components/MiniChat.tsx');
const trans = read('src/i18n/translations.ts');
const mod = read('src/utils/skillStatus.ts');

// ===================================================================== A. 结构性契约
section('A. 状态改按每轮唯一 replyKey 分桶（主窗 + 小窗同构）');

check('存在共享生产模块 src/utils/skillStatus.ts', mod.length > 0);
for (const fn of ['nextReplyKey', 'resolveSkillCallForMessage', 'applySkillNames',
  'markSkillDone', 'markSkillFading', 'removeSkillCall', 'beginSkillCall']) {
  check(`skillStatus.ts 导出 ${fn}`, mod.includes(`export function ${fn}`));
}
check('skillStatus.ts 的 nextReplyKey 带轮次序号（streamId 跨轮复用 → 必须唯一）',
  /export function nextReplyKey\(streamId: string, seq: number\): string \{\s*\n\s*return `\$\{streamId\}#\$\{seq\}`;/.test(mod));
check('skillStatus.ts 的停留/渐隐时长为常量（便于登记硬编码清单）',
  mod.includes('export const SKILL_STATUS_LINGER_MS = 3000;') &&
  mod.includes('export const SKILL_STATUS_FADE_MS = 420;'));
check('skillStatus.ts 提供 FIFO 队列（push/take/clear）',
  mod.includes('export function pushReplyKey(') &&
  mod.includes('export function takeReplyKey(') &&
  mod.includes('export function clearReplyKeys('));

for (const [label, src] of [['ChatWindow', cw], ['MiniChat', mc]]) {
  check(`${label} 用 FIFO 队列管理待结束的 replyKey`,
    src.includes('pendingReplyKeysRef') &&
    src.includes('pushReplyKey(pendingReplyKeysRef.current, data.streamId, replyKey)') &&
    src.includes('takeReplyKey(pendingReplyKeysRef.current, data.streamId)'));

  check(`${label} 流式出错时清理待结束队列`,
    src.includes('clearReplyKeys(pendingReplyKeysRef.current, data.streamId)'));
}

for (const [label, src] of [['ChatWindow', cw], ['MiniChat', mc]]) {
  check(`${label} 引用共享模块 skillStatus`, src.includes("from '../utils/skillStatus'"));

  check(`${label} 定义 replySeqRef / pendingReplyKeysRef / msgReplyKeyRef`,
    src.includes('const replySeqRef = useRef(0);') &&
    src.includes('const pendingReplyKeysRef = useRef<Record<string, string[]>>({});') &&
    src.includes('const msgReplyKeyRef = useRef<Record<string, string>>({});'));

  check(`${label} onStart 为每轮分配唯一 replyKey（nextReplyKey + 轮次序号）`,
    src.includes('const replyKey = nextReplyKey(data.streamId, ++replySeqRef.current);'));

  check(`${label} 技能状态按 replyKey 分桶（不再是 streamId）`,
    src.includes('setSkillCalls((prev) => beginSkillCall(prev, replyKey));'));

  check(`${label} onDone 用本轮 key（doneKey）推进状态`,
    src.includes('const doneKey = takenKey || data.streamId;') &&
    src.includes('setSkillCalls((prev) => markSkillDone(prev, doneKey));') &&
    src.includes('setSkillCalls((prev) => markSkillFading(prev, doneKey));') &&
    src.includes('setSkillCalls((prev) => removeSkillCall(prev, doneKey));'));

  check(`${label} 落库消息 id -> replyKey 映射（历史气泡靠它定位）`,
    src.includes('msgReplyKeyRef.current[String(data.message.id)] = doneKey;'));

  check(`${label} 渲染用共享模块按本条消息定位状态`,
    src.includes('resolveSkillCallForMessage(skillCalls, m as any, msgReplyKeyRef.current)'));

  check(`${label} 切换对话时清空 replyKey 映射`,
    src.includes('msgReplyKeyRef.current = {};') &&
    src.includes('pendingReplyKeysRef.current = {};'));

  check(`${label} 占位气泡带上本轮 replyKey`,
    /streamId: data\.streamId,\s*\n\s*\n?\s*(\/\/[^\n]*\n\s*)?replyKey,/.test(src));
}

check('主窗与小窗的 Skill 状态实现同构（关键标识一致）',
  cw.includes("t('skill.callTip')") && mc.includes("t('skill.callTip')"));

// ===================================================================== B. 行为级复现
section('B. 行为级：两轮回复场景下历史气泡不再命中状态');

// ---------- 加载**真实生产模块** src/utils/skillStatus.ts ----------
// 用 esbuild 打成 CJS 后 require —— 断言跑的是线上真正在用的函数，
// 而不是脚本里另写一份「同构模型」（模型与实现漂移 = 假绿灯）。
let S = null;
{
  const { build } = await import('esbuild');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const tmp = mkdtempSync(join(tmpdir(), 'skillstatus-'));
  try {
    const out = await build({
      entryPoints: [join(ROOT, 'src/utils/skillStatus.ts')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2020',
      write: false,
      logLevel: 'silent',
    });
    const f = join(tmp, 'skillStatus.cjs');
    writeFileSync(f, out.outputFiles[0].text, 'utf-8');
    S = createRequire(join(tmp, 'h.cjs'))(f);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

check('真实生产模块 src/utils/skillStatus.ts 可加载', !!S && typeof S.resolveSkillCallForMessage === 'function');

if (S) {
  const {
    nextReplyKey,
    pushReplyKey,
    takeReplyKey,
    clearReplyKeys,
    resolveSkillCallForMessage,
    applySkillNames,
    markSkillDone,
    markSkillFading,
    removeSkillCall,
    beginSkillCall,
  } = S;

  {
    // 两轮回复，同一个 streamId（缺陷的关键：streamId 跨轮复用）
    let calls = {};
    const msgReplyKey = {};
    const streamId = 'chat1:roleA';

    // 第 1 轮
    const k1 = nextReplyKey(streamId, 1);
    calls = beginSkillCall(calls, k1);
    calls = applySkillNames(calls, k1, ['goutoujunshi']).map;
    calls = markSkillDone(calls, k1);
    msgReplyKey['100'] = k1;

    // 第 2 轮
    const k2 = nextReplyKey(streamId, 2);
    calls = beginSkillCall(calls, k2);
    calls = applySkillNames(calls, k2, ['goutoujunshi']).map;

    check('两轮的 replyKey 不同（每轮唯一）', k1 !== k2, `${k1} vs ${k2}`);

    const s1 = resolveSkillCallForMessage(calls, { id: 100 }, msgReplyKey);
    const s2 = resolveSkillCallForMessage(calls, { id: 200, replyKey: k2 }, msgReplyKey);

    check('第 2 轮进行中，第 1 轮的气泡**绝不**显示「正在调用」',
      !s1 || s1.status !== 'calling', `实际拿到 ${JSON.stringify(s1)}`);
    check('第 2 轮的气泡显示状态条（本轮唯一命中）',
      !!s2 && s2.status === 'calling', JSON.stringify(s2));

    // 缺陷复现对照：若按 streamId 分桶，历史气泡必然一起命中
    const legacyCalls = { [streamId]: { status: 'calling', names: ['goutoujunshi'] } };
    check('对照：旧实现（按 streamId 分桶）确实会让历史气泡一起命中（复现成立）',
      !!legacyCalls[streamId] && legacyCalls[streamId].status === 'calling');

    // 第 1 轮条目渐隐并移除后，历史气泡彻底干净
    calls = markSkillFading(calls, k1);
    calls = removeSkillCall(calls, k1);
    const s1c = resolveSkillCallForMessage(calls, { id: 100 }, msgReplyKey);
    check('第 1 轮条目移除后，历史气泡不再显示任何状态条',
      s1c === null, JSON.stringify(s1c));

    // 第 2 轮落库后 → 「已完成」
    calls = markSkillDone(calls, k2);
    msgReplyKey['200'] = k2;
    const s2b = resolveSkillCallForMessage(calls, { id: 200 }, msgReplyKey);
    check('第 2 轮落库后，该气泡显示「已完成」', !!s2b && s2b.status === 'done', JSON.stringify(s2b));

    // 无生效技能 → 不显示
    const callsNoSkill = beginSkillCall({}, nextReplyKey('c:r', 1));
    check('本轮无生效技能（names 为空）→ 不显示状态条',
      resolveSkillCallForMessage(callsNoSkill, { id: 1, replyKey: nextReplyKey('c:r', 1) }, {}) === null);
  }

  // ---------------------------------------------------------------- C. 竞态
  section('C. 竞态：IPC 晚于本轮结束不得复活条目 / 不得打回 calling');

  {
    // 场景 1：本轮已结束（done）后才收到 IPC
    let calls = beginSkillCall({}, 'k1');
    calls = markSkillDone(calls, 'k1');
    const r1 = applySkillNames(calls, 'k1', ['goutoujunshi']);
    check('IPC 晚到：条目仍在时只补 names，status 保持 done（不被打回 calling）',
      r1.applied && r1.map['k1'].status === 'done' && r1.map['k1'].names.length === 1,
      JSON.stringify(r1.map['k1']));

    // 场景 2：本轮已彻底移除（渐隐收尾）后才收到 IPC
    let calls2 = beginSkillCall({}, 'k2');
    calls2 = removeSkillCall(calls2, 'k2');
    const r2 = applySkillNames(calls2, 'k2', ['goutoujunshi']);
    check('IPC 晚到且条目已移除：不复活（否则永远卡在「正在调用 Skill」）',
      r2.applied === false && !r2.map['k2']);

    // 场景 3：同一 streamId 连开两轮，第 2 轮的 IPC 晚到也不能污染第 1 轮
    let calls3 = beginSkillCall(beginSkillCall({}, 's#1'), 's#2');
    calls3 = markSkillDone(calls3, 's#1');
    calls3 = applySkillNames(calls3, 's#2', ['b']).map;
    check('连开两轮：第 2 轮回填只影响自己的条目',
      calls3['s#1'].names.length === 0 && calls3['s#2'].names.join() === 'b',
      JSON.stringify(calls3));

    // 场景 4（打断竞态）：同一 streamId 连开两轮，第 1 轮被打断 → 其 done **晚于**第 2 轮 start 到达。
    //   若只记「最新 key」，迟到的第 1 轮 done 会把**第 2 轮**误标成「已完成」。
    {
      const streamId = 'chat1:roleA';
      let queue = {};
      let calls4 = {};

      const kA = nextReplyKey(streamId, 1);
      queue = pushReplyKey(queue, streamId, kA);
      calls4 = beginSkillCall(calls4, kA);
      calls4 = applySkillNames(calls4, kA, ['goutoujunshi']).map;

      // 第 2 轮开始
      const kB = nextReplyKey(streamId, 2);
      queue = pushReplyKey(queue, streamId, kB);
      calls4 = beginSkillCall(calls4, kB);
      calls4 = applySkillNames(calls4, kB, ['goutoujunshi']).map;

      // 第 1 轮被打断，其 done **迟到**（晚于第 2 轮 start）
      const [taken, q2] = takeReplyKey(queue, streamId);
      queue = q2;
      check('打断竞态：迟到的旧 done 配对到**第 1 轮**的 key（而非最新一轮）',
        taken === kA, `得到 ${taken}，期望 ${kA}`);
      calls4 = markSkillDone(calls4, taken);

      const stA = calls4[kA].status;
      const stB = calls4[kB].status;
      check('打断竞态：迟到 done 只把第 1 轮标成已完成，第 2 轮仍是「正在调用」',
        stA === 'done' && stB === 'calling', `A=${stA} B=${stB}`);

      // 第 2 轮正常结束
      const [taken2, q3] = takeReplyKey(queue, streamId);
      queue = q3;
      check('打断竞态：随后第 2 轮的 done 配对到第 2 轮的 key',
        taken2 === kB, `得到 ${taken2}，期望 ${kB}`);

      // 流式出错（无 done）时清队列，队首不卡住
      let queue5 = pushReplyKey(pushReplyKey({}, 's:x', 'e1'), 's:x', 'e2');
      queue5 = clearReplyKeys(queue5, 's:x');
      const [taken5] = takeReplyKey(queue5, 's:x');
      check('流式出错清队列后不再有残留队首（后续 done 不会配对到错误的 key）',
        taken5 === undefined, `得到 ${taken5}`);
    }
  }
}

// ===================================================================== D. 机制表述
section('D. 机制表述：文案不再宣称「调用」，10 处语言一致');

{
  const zhBlock = trans.slice(trans.indexOf('  zh: {'), trans.indexOf('  en: {'));
  const enBlock = trans.slice(trans.indexOf('  en: {'), trans.indexOf('  de: deDict'));

  const zhCalling = /'skill\.calling':\s*'([^']*)'/.exec(zhBlock)?.[1] || '';
  const zhCalled = /'skill\.called':\s*'([^']*)'/.exec(zhBlock)?.[1] || '';
  const zhTip = /'skill\.callTip':\s*'([^']*)'/.exec(zhBlock)?.[1] || '';
  const enCalling = /'skill\.calling':\s*'([^']*)'/.exec(enBlock)?.[1] || '';
  const enCalled = /'skill\.called':\s*'([^']*)'/.exec(enBlock)?.[1] || '';

  check('zh skill.calling 不再使用「调用」措辞', !!zhCalling && !zhCalling.includes('调用'), zhCalling);
  check('zh skill.called 不再使用「调用」措辞', !!zhCalled && !zhCalled.includes('调用'), zhCalled);
  check('zh skill.callTip 说明「不是运行时调用」', !!zhTip && zhTip.includes('不是运行时调用'), zhTip);
  check('en skill.calling 不再使用 "call" 措辞', !!enCalling && !/calling/i.test(enCalling), enCalling);
  check('en skill.called 不再使用 "call" 措辞', !!enCalled && !/call/i.test(enCalled), enCalled);
  check('zh skill.calling 保留 {name} 占位符', zhCalling.includes('{name}'), zhCalling);
  check('en skill.calling 保留 {name} 占位符', enCalling.includes('{name}'), enCalling);

  // 10 处语言：三个键齐全、非空、占位符一致
  const langs = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
  const phOf = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
  const wantCallingPh = phOf(zhCalling);
  let allOk = true;
  const miss = [];
  for (const l of langs) {
    let d = {};
    try {
      d = JSON.parse(read(path.join('src', 'i18n', 'locales', l + '.json')));
    } catch {}
    for (const k of ['skill.calling', 'skill.called', 'skill.callTip']) {
      if (typeof d[k] !== 'string' || !d[k].trim()) {
        allOk = false;
        miss.push(l + ':' + k + '(缺/空)');
      }
    }
    if (phOf(d['skill.calling']) !== wantCallingPh) {
      allOk = false;
      miss.push(l + ':占位符不一致');
    }
    // 非中英语言：同样不得出现「调用 / call」这类宣称运行时调用的措辞
    if (/\bcall(ed|ing)?\b/i.test(d['skill.calling'] || '') || /\bcall(ed|ing)?\b/i.test(d['skill.called'] || '')) {
      allOk = false;
      miss.push(l + ':仍用 call 措辞');
    }
  }
  check('8 个 locale：3 键齐全非空 + 占位符一致 + 无「call」措辞', allOk, miss.slice(0, 6).join(', '));

  // 主窗 / 小窗都用 callTip 作 title
  check('主窗与小窗的 title 均改用 skill.callTip',
    cw.includes("title={t('skill.callTip')}") && mc.includes("title={t('skill.callTip')}"));
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
