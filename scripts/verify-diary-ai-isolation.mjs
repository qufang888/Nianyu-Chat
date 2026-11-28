/**
 * v3.0.18 AI 隔离闸门（行为级）：总开关零出站 / 逐角色可见 / 撤销即遗忘 / 群聊逐角色 / 双窗同源。
 * 做法：esbuild 执行**真实的** electron/diary.ts + diaryTone.ts（纯模块），并对主进程做源码强断言。
 * 用法：node scripts/verify-diary-ai-isolation.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-ai-'));
const outfile = path.join(work, 'diary.mjs');
await build({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(ROOT, 'electron/diary.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'electron/diaryTone.ts'))};
export * as secure from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
    loader: 'ts',
    resolveDir: ROOT,
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  logLevel: 'silent',
});
const D = await import(pathToFileURL(outfile).href + '?v=' + Date.now());
D.secure.initSecureStore(path.join(work, 'nianyu-master.key'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });
D.resetDiaryStore();
const store = D.getDiaryStore();
store.init(dataDir);
const book = 'self_1';
const roles = [
  { id: 'A', affinity: 82, mood: '开心' },
  { id: 'B', affinity: 50, mood: '平静' },
  { id: 'C', affinity: 30, mood: '生气' },
];
const secret = '海边散步的秘密地点是灯塔后面';

section('A. allowAi=false：零产物 / 零出站');
const d1 = store.createDiary({ selfRoleId: book, date: '2026-11-20', title: '私人日记', content: secret });
let stubCalls = 0;
function queryAIStub(plan) { for (const _item of plan) stubCalls += 1; }
let plan = D.planDiaryAiWork(d1, roles);
queryAIStub(plan);
ok('shouldGenerateComments=false', D.shouldGenerateComments(d1) === false);
ok('planDiaryAiWork 为空', plan.length === 0);
ok('queryAI stub 调用计数 0', stubCalls === 0);
ok('collectArtifactsForRole 返回 []', D.collectArtifactsForRole({ diaries: [d1], summaries: [], roleId: 'A', selfRoleId: book }).length === 0);

section('B. 名单为空 / 身份册不匹配');
store.updateDiary(d1.id, { allowAi: true });
const dOpenNoVisible = store.getDiary(d1.id);
ok('首次开启时名单仍为空', dOpenNoVisible.visibleRoleIds.length === 0);
plan = D.planDiaryAiWork(dOpenNoVisible, roles);
ok('名单空 → plan 为空', plan.length === 0);
const dOtherBook = store.createDiary({ selfRoleId: 'self_2', date: '2026-11-21', content: secret });
store.updateDiary(dOtherBook.id, { allowAi: true, visibleRoleIds: ['A'] });
store.addComment(dOtherBook.id, {
  id: 'c_other', roleId: 'A', text: '另一册的留言', tone: 'neutral',
  affinityAt: 50, moodAt: '平静', revoked: false, created_at: new Date().toISOString(),
});
ok('身份册不匹配 → 不注入', D.buildDiaryContextBlock('A', book) === '' &&
  D.buildDiaryContextBlock('A', 'self_2').includes('另一册的留言'));

section('C. 逐角色门控：只有 A 可见');
const d2 = store.createDiary({ selfRoleId: book, date: '2026-11-22', title: '海边', content: secret });
store.updateDiary(d2.id, { allowAi: true, visibleRoleIds: ['A'] });
const entry = store.getDiary(d2.id);
const aWork = D.planDiaryAiWork(entry, roles);
ok('plan 只含 A', aWork.length === 1 && aWork[0].roleId === 'A', JSON.stringify(aWork));
store.addComment(d2.id, {
  id: 'c_a', roleId: 'A', text: '去海边啦，我也想去呢', tone: 'warm',
  affinityAt: 82, moodAt: '开心', revoked: false, created_at: new Date().toISOString(),
});
store.addSummary({
  id: 's_a', diaryId: d2.id, roleId: 'A', selfRoleId: book,
  visibleRoleIdsSnapshot: ['A'], text: '主人去了海边散步',
  sourceUpdatedAt: entry.updated_at, revoked: false, created_at: new Date().toISOString(),
});
const aArtifacts = D.collectArtifactsForRole({ diaries: store.diaries, summaries: store.summaries, roleId: 'A', selfRoleId: book });
const bArtifacts = D.collectArtifactsForRole({ diaries: store.diaries, summaries: store.summaries, roleId: 'B', selfRoleId: book });
ok('A 有 2 条产物', aArtifacts.length === 2, JSON.stringify(aArtifacts));
ok('B 产物数 0', bArtifacts.length === 0);
const blockA = D.buildDiaryContextBlock('A', book);
const blockB = D.buildDiaryContextBlock('B', book);
ok('B 的 prompt 块为空串', blockB === '', JSON.stringify(blockB));
ok('A 的 prompt 块非空且只含产物', blockA.includes('去海边啦') && blockA.includes('主人去了海边'));
ok('注入文本不含日记正文', !blockA.includes(secret) && !blockA.includes(secret.slice(0, 12)));

section('D. v3.0.25 取消资格冻结快照 / 重加不自动恢复 / 正文变更失效');
const updatedBeforeRevoke = String(store.getDiary(d2.id).updated_at);
const textBeforeFreeze = store.getDiary(d2.id).aiComments.find((c) => c.id === 'c_a').text;
store.updateDiary(d2.id, { visibleRoleIds: [] });
const afterRemove = D.buildDiaryContextBlock('A', book);
ok('移除 A 后 A 的正常门控块为空', afterRemove === '', JSON.stringify(afterRemove));
const revokedComment = store.getDiary(d2.id).aiComments.find((c) => c.id === 'c_a');
ok('A 的留言冻结为最后状态（frozen=true / revoked=false / 文本不变）',
  revokedComment.frozen === true && revokedComment.revoked === false && revokedComment.text === textBeforeFreeze);
ok('冻结快照仍可在聊天回忆中被引用（含摘要优先）',
  D.buildDiaryRecallBlock('海边的日记', 'A', book).includes('去海边啦'));
ok('冻结快照不携带日记正文', !D.buildDiaryRecallBlock('海边的日记', 'A', book).includes(secret));
store.updateDiary(d2.id, { visibleRoleIds: ['A'] });
ok('重新勾选后旧产物不自动恢复（冻结项不进正常门控）', D.buildDiaryContextBlock('A', book) === '');
// 冻结快照不随正文变化改写；新生成的正常摘要仍按既有游标语义失效。
store.addSummary({
  id: 's_live', diaryId: d2.id, roleId: 'A', selfRoleId: book,
  visibleRoleIdsSnapshot: ['A'], text: '新摘要', sourceUpdatedAt: store.getDiary(d2.id).updated_at,
  revoked: false, created_at: new Date().toISOString(),
});
store.updateDiary(d2.id, { content: secret + '，还看了夕阳' });
const d3 = store.getDiary(d2.id);
ok('正文变更 updated_at 推进', d3.updated_at !== updatedBeforeRevoke);
const frozenSummary = store.summaries.find((s) => s.id === 's_a');
const staleSummary = store.summaries.find((s) => s.id === 's_live');
ok('正文变更后冻结摘要不改写（frozen 快照不可变）',
  frozenSummary.frozen === true && frozenSummary.revoked === false && frozenSummary.text === '主人去了海边散步');
ok('正文变更后正常摘要 revoked=true', staleSummary.revoked === true);

section('E. 主进程 / 双窗源码强断言');
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf-8');
const chatSrc = fs.readFileSync(path.join(ROOT, 'src/components/ChatWindow.tsx'), 'utf-8');
const miniSrc = fs.readFileSync(path.join(ROOT, 'src/components/MiniChat.tsx'), 'utf-8');
ok('buildSystemPrompt 调用 buildDiaryContextBlock', /buildDiaryContextBlock\(role\.id, diarySelfRoleId\)/.test(mainSrc));
ok('buildSystemPrompt 有第 4 参 diarySelfRoleId', /diarySelfRoleId\?: string/.test(mainSrc));
ok('单聊与群聊均传 selfRole?.id || none', (mainSrc.match(/selfRole\?\.id \|\| 'none'/g) || []).length >= 2);
ok('留言循环严格按 plan 驱动', /for \(const item of plan\)/.test(mainSrc) && /planDiaryAiWork\(/.test(mainSrc));
ok('buildGroupMessages 逐角色构建 system prompt', /function buildGroupMessages[\s\S]*?buildSystemPrompt\(/.test(mainSrc));
ok('ChatWindow 主窗走 sendUserMessage + sendAIMessages', chatSrc.includes('sendUserMessage') && chatSrc.includes('sendAIMessages'));
ok('MiniChat 小窗走 sendUserMessage + sendAIMessages', miniSrc.includes('sendUserMessage') && miniSrc.includes('sendAIMessages'));
ok('两窗均不自行构建 system prompt', !chatSrc.includes('buildSystemPrompt') && !miniSrc.includes('buildSystemPrompt'));

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} AI 隔离闸门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
