#!/usr/bin/env node
/**
 * verify-diary-summary-comment-v3025.mjs — v3.0.25 BugFix 行为闸门。
 *
 * 覆盖三组回归：
 *   B1  摘要 / 留言产物集合正交（先留言后总结、先总结后留言、逐字不变、门控不回退）
 *   B2  回复草稿提交即清空（pending 空 / resolve 空 / reject 原文恢复）
 *   B3  编辑面板有限高度内滚动 + 保存取消吸底 + 240px 内部滚动保持
 *
 * 零新增依赖：复用仓库 esbuild / TypeScript 工具链；纯模块 + 真实源码函数抽取执行。
 * 用法：node scripts/verify-diary-summary-comment-v3025.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-3025-'));
void createRequire(path.join(work, 'harness.cjs'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const section = (t) => console.log('\n=== ' + t + ' ===');

const diarySrc = read('electron/diary.ts');
const mainSrc = read('electron/main.ts');
const viewSrc = read('src/components/DiaryView.tsx');
const cssSrc = read('src/styles/index.css');
const pkg = JSON.parse(read('package.json'));

console.log('='.repeat(70));
console.log('v3.0.25 日记 BugFix 闸门 — B1 正交 / B2 草稿 / B3 溢出');
console.log('='.repeat(70));

/** 从真实源码中按花括号配平抽取箭头函数体（与 v3023 闸门同口径）。 */
function extractArrow(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const ruleBody = (css, selector) => {
  const m = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}').exec(css);
  return m ? m[1] : '';
};

// ---------------------------------------------------------------- 纯模块打包
section('B1-0 纯模块装载（electron/diary.ts + secureStore）');
const storeOut = path.join(work, 'diary.mjs');
await build({
  stdin: {
    contents: [
      `export * from ${JSON.stringify(path.join(ROOT, 'electron/diary.ts'))};`,
      `export * as secure from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
    ].join('\n'),
    loader: 'ts', resolveDir: ROOT,
  },
  outfile: storeOut, bundle: true, format: 'esm', platform: 'node', target: 'es2020', logLevel: 'silent',
});
const D = await import(pathToFileURL(storeOut).href + '?v=' + Date.now());
const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });
D.secure.initSecureStore(path.join(work, 'nianyu-master.key'));
const stamp = new Date().toISOString();
const shape = {
  version: 1, seq: 1,
  diaries: [{
    id: 'd1', selfRoleId: 'self1', date: '2026-02-01', title: '正交测试', content: '正文永不入 prompt',
    allowAi: true, visibleRoleIds: ['A', 'B', 'C'],
    aiComments: [
      {
        id: 'cA', roleId: 'A', text: '留言A', tone: 'warm', affinityAt: 80, moodAt: '平静', revoked: false,
        created_at: stamp, awaitingUserReply: true,
        replies: [
          { id: 'uA', author: 'user', text: '我的回复A', roleId: '', created_at: stamp },
          { id: 'aA', author: 'ai', text: 'AI回复A', roleId: 'A', created_at: stamp },
        ],
      },
      {
        id: 'cB', roleId: 'B', text: '留言B', tone: 'warm', affinityAt: 60, moodAt: '平静', revoked: false,
        created_at: stamp, awaitingUserReply: true,
        replies: [{ id: 'uB', author: 'user', text: '我的回复B', roleId: '', created_at: stamp }],
      },
    ],
    created_at: stamp, updated_at: stamp,
  }],
  diary_summaries: [
    { id: 'sA', diaryId: 'd1', roleId: 'A', selfRoleId: 'self1', visibleRoleIdsSnapshot: ['A', 'B', 'C'], text: '摘要A', sourceUpdatedAt: stamp, revoked: false, created_at: stamp },
    { id: 'sB', diaryId: 'd1', roleId: 'B', selfRoleId: 'self1', visibleRoleIdsSnapshot: ['A', 'B', 'C'], text: '摘要B', sourceUpdatedAt: stamp, revoked: false, created_at: stamp },
  ],
  commentTasks: [],
};
fs.writeFileSync(path.join(dataDir, 'diary.json'), JSON.stringify(shape), 'utf8');
D.resetDiaryStore();
const st = D.getDiaryStore();
st.init(dataDir);
const snap = (x) => JSON.stringify(x);
const getC = (id) => st.getDiary('d1').aiComments.find((c) => c.id === id);
const getS = (id) => st.summaries.find((s) => s.id === id);
ok('B1-0 测试夹具装载成功', !!getC('cA') && !!getS('sA') && st.getDiary('d1').aiComments.length === 2);

// ---------------------------------------------------------------- B1：正交行为
section('B1 摘要 / 留言正交：先留言后总结 → 留言仍在且摘要存在');
{
  const commentsBefore = snap(st.getDiary('d1').aiComments);
  const summaryBBefore = snap(getS('sB'));
  st.revokeSummariesForRoles('d1', ['A']);
  ok('B1 重新总结只撤目标角色旧摘要', getS('sA').revoked === true && getS('sB').revoked === false);
  ok('B1 重新总结后整条留言串逐字不变（text/replies/revoked）',
    snap(st.getDiary('d1').aiComments) === commentsBefore);
  ok('B1 非目标角色摘要逐字不变', snap(getS('sB')) === summaryBBefore);
  ok('B1 摘要 text/sourceUpdatedAt 未被改写', getS('sA').text === '摘要A' && getS('sA').sourceUpdatedAt === stamp);

  st.addSummary({
    id: 'sA2', diaryId: 'd1', roleId: 'A', selfRoleId: 'self1', visibleRoleIdsSnapshot: ['A', 'B', 'C'],
    text: '新摘要A', sourceUpdatedAt: st.getDiary('d1').updated_at, revoked: false, created_at: new Date().toISOString(),
  });
  ok('B1 先留言后总结：留言未撤销且新摘要存在',
    getC('cA').revoked === false && getC('cA').replies.every((r) => !r.revoked) &&
    st.summaries.some((s) => s.roleId === 'A' && !s.revoked && s.text === '新摘要A'));
  const arts = D.collectArtifactsForRole(
    { diaries: st.diaries, summaries: st.summaries, roleId: 'A', selfRoleId: 'self1' }, true);
  ok('B1 门控同时产出 comment / reply / summary 三类产物',
    arts.filter((a) => a.kind === 'comment').length === 2 && arts.some((a) => a.kind === 'summary' && a.text === '新摘要A'),
    JSON.stringify(arts.map((a) => a.kind)));
}

section('B1 摘要 / 留言正交：先总结后留言（force / 定时 / NHPP）→ 摘要仍在');
{
  const summariesBefore = snap(st.summaries);
  const n = st.revokeThreadForRole('d1', 'B');
  ok('B1 force 重新留言只撤对应留言串（顶层 + replies）',
    n === 1 && getC('cB').revoked === true && getC('cB').replies.every((r) => r.revoked === true));
  ok('B1 重新留言后全部摘要逐字不变（text/revoked/sourceUpdatedAt）',
    snap(st.summaries) === summariesBefore);
  st.addComment('d1', {
    id: 'cB2', roleId: 'B', text: '新留言B', tone: 'warm', affinityAt: 60, moodAt: '平静', revoked: false,
    created_at: new Date().toISOString(), replies: [], scheduleKind: 'manual', awaitingUserReply: true,
  });
  ok('B1 先总结后留言：摘要未撤销且新留言存在',
    st.summaries.some((s) => s.roleId === 'B' && !s.revoked && s.text === '摘要B') &&
    getC('cB2').revoked === false);
  const artsB = D.collectArtifactsForRole(
    { diaries: st.diaries, summaries: st.summaries, roleId: 'B', selfRoleId: 'self1' }, true);
  ok('B1 角色 B 门控同时产出留言与摘要',
    artsB.some((a) => a.kind === 'comment' && a.text === '新留言B') &&
    artsB.some((a) => a.kind === 'summary' && a.text === '摘要B'));
}

section('B1 重复操作不互相侵蚀 + 既有门控不回退');
{
  const commentsBefore = snap(st.getDiary('d1').aiComments);
  st.revokeSummariesForRoles('d1', ['A', 'B']);
  ok('B1 再次总结旧留言逐字不变', snap(st.getDiary('d1').aiComments) === commentsBefore);
  const summariesBefore = snap(st.summaries);
  st.revokeThreadForRole('d1', 'A');
  ok('B1 再次留言旧摘要逐字不变', snap(st.summaries) === summariesBefore);

  const d = st.getDiary('d1');
  d.allowAi = false;
  ok('B1 allowAi=false 门控产物为空（总开关优先未回退）',
    D.collectArtifactsForRole({ diaries: [d], summaries: st.summaries, roleId: 'A', selfRoleId: 'self1' }).length === 0);
  d.allowAi = true;
  d.visibleRoleIds = ['A'];
  ok('B1 名单外角色零产物（串联与未回退）',
    D.collectArtifactsForRole({ diaries: [d], summaries: st.summaries, roleId: 'B', selfRoleId: 'self1' }).length === 0);
  d.visibleRoleIds = ['A', 'B', 'C'];

  const legacy = D.migrateLegacyDiaries([{ ...d, selfRoleId: 'ghost' }], [{ ...getS('sA'), selfRoleId: 'ghost' }], ['self1'], 'self1');
  ok('B1 兼容迁移只改 selfRoleId，不调用撤销 / 时间戳',
    legacy.migratedDiaries === 1 && legacy.migratedSummaries === 1);

  const probeDiary = JSON.parse(JSON.stringify(st.getDiary('d1')));
  probeDiary.aiComments.push({
    id: 'cC', roleId: 'C', text: 'C留言', revoked: false, replies: [{ id: 'rC', author: 'ai', text: '回复', roleId: 'C', revoked: false }],
  });
  const probeSummaries = [{ ...getS('sB'), id: 'sC', roleId: 'C', text: 'C摘要', revoked: false }];
  D.applyRevoke([probeDiary], probeSummaries, ['C'], false);
  ok('B1 既有 applyRevoke 双撤语义保留（整篇失效场景）',
    probeDiary.aiComments.find((c) => c.id === 'cC').revoked === true &&
    probeDiary.aiComments.find((c) => c.id === 'cC').replies[0].revoked === true &&
    probeSummaries[0].revoked === true);
}

section('B1 源码接线审计：每个调用点语义正确');
{
  const summarizeFn = extractArrow(mainSrc, 'async function summarizeDiary') || '';
  const summarizeSection = mainSrc.slice(mainSrc.indexOf('async function summarizeDiary'), mainSrc.indexOf('// ===== v3.0.24 留言回复'));
  ok('B1 summarizeDiary 改用 revokeSummariesForRoles', /revokeSummariesForRoles\(diaryId, targets\)/.test(summarizeSection));
  ok('B1 summarizeDiary 不再调用 revokeForRoles', !/revokeForRoles\(/.test(summarizeSection), String(summarizeFn).slice(0, 40));
  const commentsSection = mainSrc.slice(mainSrc.indexOf('async function generateDiaryComments'), mainSrc.indexOf('/** 总结只产出独立'));
  ok('B1 force 留言只调 revokeThreadForRole，不碰摘要撤销',
    /revokeThreadForRole\(diaryId, item\.roleId\)/.test(commentsSection) &&
    !/revokeForRoles\(|revokeSummariesForRoles\(/.test(commentsSection));
  ok('B1 revokeSummariesForRoles 传 [] 给 applyRevoke 的 diaries 参数',
    /revokeSummariesForRoles\(diaryId: string, roleIds: string\[\]\): void \{\s*applyRevoke\(\[\],/.test(diarySrc));
  const allRevokers = (mainSrc.match(/diaryStore\.revoke[A-Za-z]+\(/g) || []).sort();
  ok('B1 主进程撤销调用点逐个审计通过（含 D 失败重试去重）',
    JSON.stringify(allRevokers) === JSON.stringify([
      'diaryStore.revokePendingUserReply(', 'diaryStore.revokeSummariesForRoles(', 'diaryStore.revokeThreadForRole(',
    ].sort()),
    JSON.stringify(allRevokers));
}

// ---------------------------------------------------------------- B2：回复草稿
section('B2 回复草稿：从真实 DiaryView 源码抽取 sendReply 并执行');
{
  const arrow = extractArrow(viewSrc, 'const sendReply =');
  ok('B2 sendReply 可从真实源码抽取', !!arrow);
  if (arrow) {
    const clearIdx = arrow.indexOf('setReplyDrafts');
    const awaitIdx = arrow.indexOf('await api.diaryReplyAdd');
    ok('B2 清空语句位于 await 之前（提交即清）', clearIdx > 0 && awaitIdx > clearIdx,
      `clear=${clearIdx} await=${awaitIdx}`);
    const js = ts.transpileModule(`${arrow}\nreturn sendReply;`, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const factory = new Function(
      'replyDrafts', 'replyBusy', 'setReplyDrafts', 'setReplyBusy', 'setReplyErrors',
      'api', 't', 'loadEntries', 'effectiveRoleId', js
    );
    const ORIGINAL = '  我的回复原文  ';
    function runCase() {
      const state = { replyDrafts: { c1: ORIGINAL }, replyBusy: {}, replyErrors: {} };
      let resolveIpc = () => {};
      let rejectIpc = () => {};
      const pending = new Promise((res, rej) => { resolveIpc = res; rejectIpc = rej; });
      const api = { diaryReplyAdd: () => pending };
      const sendReply = factory(
        state.replyDrafts, state.replyBusy,
        (fn) => { state.replyDrafts = fn(state.replyDrafts); },
        (fn) => { state.replyBusy = fn(state.replyBusy); },
        (fn) => { state.replyErrors = fn(state.replyErrors); },
        api, (k) => k, async () => {}, 'self1'
      );
      const p = sendReply({ id: 'e1' }, { id: 'c1' });
      return { state, p, resolveIpc, rejectIpc };
    }

    const a = runCase();
    ok('B2 IPC pending 时 draft 已为空', a.state.replyDrafts.c1 === '', JSON.stringify(a.state.replyDrafts));
    ok('B2 pending 时 replyBusy=true（生成中徽标）', a.state.replyBusy.c1 === true);
    a.resolveIpc({ ok: true });
    await a.p;
    ok('B2 resolve 后 draft 仍为空', a.state.replyDrafts.c1 === '');
    ok('B2 resolve 后 busy 复位', a.state.replyBusy.c1 === false);

    const b = runCase();
    ok('B2 reject 前 draft 已为空', b.state.replyDrafts.c1 === '');
    b.rejectIpc(new Error('IPC 异常'));
    await b.p;
    ok('B2 reject 后草稿恢复原文（逐字）', b.state.replyDrafts.c1 === ORIGINAL, JSON.stringify(b.state.replyDrafts));
    ok('B2 reject 后错误提示保留且 busy 复位',
      /IPC 异常/.test(b.state.replyErrors.c1 || '') && b.state.replyBusy.c1 === false);

    const c = runCase();
    c.resolveIpc({ ok: false, error: '主进程拒绝' });
    await c.p;
    ok('B2 ok=false 草稿恢复原文（逐字）', c.state.replyDrafts.c1 === ORIGINAL);
    ok('B2 ok=false 错误提示保留供重试', c.state.replyErrors.c1 === '主进程拒绝');

    const d = runCase();
    d.rejectIpc(new Error('二次异常'));
    await d.p;
    ok('B2 失败恢复后可用原文重试（同一 draft）', d.state.replyDrafts.c1 === ORIGINAL);
  }
}

// ---------------------------------------------------------------- B3：编辑面板溢出
section('B3 编辑面板有限高度自适应 / 保存取消可达 / 240px 内部滚动保持');
{
  const editor = ruleBody(cssSrc, '.diary-editor');
  ok('B3 editor 去掉 460px 硬编码', !/min-height:\s*460px/.test(editor) && /min-height:\s*0/.test(editor));
  ok('B3 editor 自身可滚动且横向不溢出',
    /overflow-y:\s*auto/.test(editor) && /overflow-x:\s*hidden/.test(editor));
  ok('B3 editor 高度封顶 100% + border-box（不顶破父容器）',
    /max-height:\s*100%/.test(editor) && /box-sizing:\s*border-box/.test(editor));

  const contentField = ruleBody(cssSrc, '.diary-field--content');
  const contentInput = ruleBody(cssSrc, '.diary-content-input');
  ok('B3 正文容器 320px 改响应式 min(320px, …)', /min-height:\s*min\(320px,/.test(contentField));
  ok('B3 正文 textarea 320px 改响应式 min(320px, …)', /min-height:\s*min\(320px,/.test(contentInput));
  ok('B3 正文 textarea 不超宽', /max-width:\s*100%/.test(contentInput));

  const rolePick = ruleBody(cssSrc, '.diary-role-pick');
  ok('B3 fieldset min-width 归零（窄窗不顶破面板）', /min-width:\s*0/.test(rolePick));
  const roleList = ruleBody(cssSrc, '.diary-role-list');
  ok('B3 可见人物列表仍为 240px 内部滚动（v3.0.24 验收保留）',
    /max-height:\s*240px/.test(roleList) && /overflow-y:\s*auto/.test(roleList) &&
    /overflow-x:\s*hidden/.test(roleList) && /min-height:\s*0/.test(roleList));
  const bulkIdx = viewSrc.indexOf('className="diary-bulk"');
  const listIdx = viewSrc.indexOf('className="diary-role-list"');
  ok('B3 全选 / 清空仍固定在滚动容器外（JSX 顺序）', bulkIdx > 0 && listIdx > bulkIdx);

  const editorActions = ruleBody(cssSrc, '.diary-editor .diary-actions');
  ok('B3 保存 / 取消吸底可达（sticky bottom:0 + 主题底）',
    /position:\s*sticky/.test(editorActions) && /bottom:\s*0/.test(editorActions) &&
    /background:\s*var\(--color-panel\)/.test(editorActions));
  ok('B3 编辑态无 position:fixed/absolute（v3.0.23 验收保留）',
    !/position:\s*(fixed|absolute)/.test(editor));

  const panel = ruleBody(cssSrc, '.diary-panel');
  ok('B3 背景不透明 + 布局自适应（v3.0.23 验收保留）',
    /background:\s*var\(--color-bg\)/.test(panel) && /flex:\s*1 1 auto/.test(panel) && /min-height:\s*0/.test(panel));
  const diaryCss = cssSrc.slice(cssSrc.indexOf('.diary-panel {'), cssSrc.indexOf('/* ===== v3.0.19'));
  ok('B3 14 主题日记段零裸色值', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(diaryCss));
}

// ---------------------------------------------------------------- 版本 / 文档 / 全局约束
section('C 版本 / 文档同步 / 全局约束');
{
  ok('C package.json = 3.0.25', pkg.version === '3.0.25');
  ok('C 新闸门已登记 npm script', /"verify:diary-summary-comment-3025"/.test(read('package.json')));
  for (const f of ['README.md', '使用说明.md', '硬编码清单.md', '版本更新记录.md']) {
    ok(`C ${f} 同步 3.0.25`, read(f).includes('3.0.25'));
  }
  ok('C GuideView 同步 v3.0.25', read('src/components/GuideView.tsx').includes('v3.0.25'));
  ok('C 响应式硬编码已登记 硬编码清单.md',
    ['min(320px, 30vh)', '30vh'].every((s) => read('硬编码清单.md').includes(s)));
  ok('C 无原生对话框（no-native-dialog 不回退）',
    !/window\.(confirm|alert|prompt)\s*\(/.test(viewSrc));
  ok('C 留言回复失败文案复用 i18n（无新增裸中文 UI 文案）',
    /t\('diary\.replyFailed'\)/.test(viewSrc) && !/>\s*[^<{]*[\u4e00-\u9fff][^<{]*\s*</.test(
      viewSrc.slice(viewSrc.indexOf('const sendReply'), viewSrc.indexOf('const summarize'))));
}

// ---------------------------------------------------------------- A：聊天回忆（摘要优先）
section('A 聊天回忆日记：明确提及才触发 / 摘要优先 / 正文永不注入');
{
  st.addComment('d1', {
    id: 'cA2', roleId: 'A', text: '回忆留言A', tone: 'warm', affinityAt: 80, moodAt: '平静', revoked: false,
    created_at: new Date().toISOString(),
    replies: [{ id: 'ra2', author: 'ai', text: '回忆回复A', roleId: 'A', created_at: new Date().toISOString() }],
  });
  st.addSummary({
    id: 'sRecall', diaryId: 'd1', roleId: 'A', selfRoleId: 'self1', visibleRoleIdsSnapshot: ['A', 'B', 'C'],
    text: '回忆摘要A', sourceUpdatedAt: st.getDiary('d1').updated_at, revoked: false,
    created_at: new Date().toISOString(),
  });
  ok('A 标题命中解析到具体日记',
    D.resolveMentionedDiary('正交测试里写了什么', st.diaries, 'self1')?.id === 'd1');
  ok('A 无明确指代不触发（非每轮无差别注入）',
    D.resolveMentionedDiary('今天天气不错', st.diaries, 'self1') === null);
  ok('A 明确指代回落到最近一篇日记',
    D.resolveMentionedDiary('这篇日记里说了什么', st.diaries, 'self1')?.id === 'd1');
  ok('A 身份册不匹配不命中', D.resolveMentionedDiary('正交测试', st.diaries, 'self2') === null);
  const block = D.buildDiaryRecallBlock('正交测试里写了什么', 'A', 'self1');
  ok('A 回忆块摘要优先且含留言 / AI 回复',
    block.includes('[摘要] 回忆摘要A') && block.includes('回忆留言A') && block.includes('回忆回复A') &&
    block.indexOf('[摘要]') < block.indexOf('[留言]'));
  ok('A 回忆块绝不携带 diary.content 正文', !block.includes('正文永不入 prompt'));
  ok('A 未提及时回忆块为空串', D.buildDiaryRecallBlock('随便聊聊', 'A', 'self1') === '');
  ok('A 回忆函数源码不读取 diary.content', !/diary\.content/.test(D.buildDiaryRecallBlock.toString()));
  ok('A 单聊按提及注入且不再传第 4 参无条件注入',
    /buildDiaryRecallBlock\(content, role\.id, selfRole\?\.id \|\| 'none'\)/.test(mainSrc) &&
    /if \(diaryRecall\) parts\.push\(diaryRecall\)/.test(mainSrc) &&
    /buildSystemPrompt\(\{ \.\.\.role, affinity: affinityTotal \}, freezeMemory, chatId\)/.test(mainSrc));
}

// ---------------------------------------------------------------- B：自动总结默认开
section('B 设置自动总结：默认开 / 可关 / 未变更不重复总结');
{
  const typesSrc = read('src/types.ts');
  const settingsSrc = read('src/components/Settings.tsx');
  ok('B 默认配置 diaryAutoSummarize=true',
    /diaryAutoSummarize:\s*true,/.test(typesSrc));
  ok('B 主进程缺省视为开（!== false）',
    /diaryAutoSummarize !== false/.test(mainSrc));
  ok('B 设置 UI 勾选缺省视为开（!== false）',
    /diaryAutoSummarize !== false/.test(settingsSrc));
  ok('B 未变更日记跳过自动总结',
    /function scheduleDiaryAi\(d: DiaryEntry, contentUnchanged = false\)/.test(mainSrc) &&
    /!contentUnchanged && shouldSummarize\(/.test(mainSrc) &&
    /const unchanged = !!before && !!patch/.test(mainSrc));
  ok('B 自动总结不撤留言（沿用 v3.0.25 正交修复）',
    /diaryStore\.revokeSummariesForRoles\(diaryId, targets\)/.test(mainSrc));
  const transSrc = read('src/i18n/translations.ts');
  ok('B zh/en 新增文案已登记', transSrc.includes("'settings.diaryAutoSummarizeV3025':"));
  ok('B 8 个语言包新增文案已登记',
    ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'].every((lang) =>
      JSON.parse(read(`src/i18n/locales/${lang}.json`))['settings.diaryAutoSummarizeV3025']));
}

// ---------------------------------------------------------------- C：资格快照
section('C 取消回复资格：冻结最后状态 / 正常门控不复活 / 回忆可引用');
{
  const beforeText = st.getDiary('d1').aiComments.find((c) => c.id === 'cA2').text;
  st.updateDiary('d1', { visibleRoleIds: ['B', 'C'] });
  const frozenComment = st.getDiary('d1').aiComments.find((c) => c.id === 'cA2');
  ok('C 取消资格只冻结不撤销（含 replies）',
    frozenComment.frozen === true && frozenComment.revoked === false &&
    frozenComment.replies.every((r) => r.frozen === true && !r.revoked));
  ok('C 冻结项 text/replies/revoked 逐字不变',
    frozenComment.text === beforeText && frozenComment.replies.length === 1 &&
    frozenComment.replies[0].text === '回忆回复A' && !frozenComment.replies[0].revoked);
  ok('C 正常门控不产出冻结项',
    D.collectArtifactsForRole({ diaries: st.diaries, summaries: st.summaries, roleId: 'A', selfRoleId: 'self1' }).length === 0);
  const recall = D.buildDiaryRecallBlock('正交测试', 'A', 'self1');
  ok('C 回忆含该人物留言、AI 回复与摘要（摘要优先）',
    recall.includes('回忆留言A') && recall.includes('回忆回复A') && recall.includes('[摘要]'));
  st.updateDiary('d1', { visibleRoleIds: ['A', 'B', 'C'] });
  ok('C 重新勾选不自动恢复冻结项到正常门控',
    D.collectArtifactsForRole({ diaries: st.diaries, summaries: st.summaries, roleId: 'A', selfRoleId: 'self1' }).length === 0);
  st.updateDiary('d1', { content: '变化后的正文' });
  const afterContent = st.getDiary('d1').aiComments.find((c) => c.id === 'cA2');
  ok('C 正文变化不改写冻结快照', afterContent.text === beforeText && afterContent.revoked === false);
  ok('C 冻结逻辑落在 updateDiary 且 applyRevoke 不触碰 frozen',
    /this\.freezeArtifactsForRoles\(d, removed\)/.test(diarySrc) &&
    /!c\.frozen && \(all \|\| ids\.has\(c\.roleId\)\)/.test(diarySrc) &&
    /!s\.frozen && \(all \|\| ids\.has\(s\.roleId\)\)/.test(diarySrc));
}

// ---------------------------------------------------------------- D：重新生成替换旧串
section('D 重新生成回复：软撤旧串不 append');
{
  st.addComment('d1', {
    id: 'cD', roleId: 'B', text: '待重试留言', tone: 'neutral', affinityAt: 50, moodAt: '平静', revoked: false,
    created_at: new Date().toISOString(),
    replies: [
      { id: 'du1', author: 'user', text: '旧的用户回复', roleId: '', created_at: new Date().toISOString() },
      { id: 'da1', author: 'ai', text: '旧的AI回复', roleId: 'B', created_at: new Date().toISOString(), revoked: true },
    ],
  });
  ok('D 失败残留 user reply 被识别', st.revokePendingUserReply('cD') === true);
  st.addReply('cD', { id: 'du2', author: 'user', text: '新的用户回复', roleId: '', created_at: new Date().toISOString() });
  const activeUser = st.getComment('d1', 'cD').replies.filter((r) => r.author === 'user' && !r.revoked);
  ok('D 重试只保留一条有效用户回复（不叠加）', activeUser.length === 1 && activeUser[0].text === '新的用户回复');

  const summarySnapBefore = snap(st.summaries);
  const oldThread = st.getComment('d1', 'cD');
  st.revokeThreadForRole('d1', 'B');
  st.addComment('d1', {
    id: 'cD2', roleId: 'B', text: '重建后的留言', tone: 'neutral', affinityAt: 50, moodAt: '平静', revoked: false,
    created_at: new Date().toISOString(), replies: [],
  });
  ok('D 旧留言与整串 replies 软撤（审计痕迹保留）',
    st.getComment('d1', 'cD').revoked === true &&
    st.getComment('d1', 'cD').text === oldThread.text &&
    st.getComment('d1', 'cD').replies.every((r) => r.revoked === true));
  ok('D 新串 replies 为空（绝不 append）', st.getComment('d1', 'cD2').replies.length === 0);
  ok('D 摘要与其它角色产物不受影响', snap(st.summaries) === summarySnapBefore);
  ok('D 重试去重与主进程接线正确',
    /diaryStore\.revokePendingUserReply\(commentId\);/.test(mainSrc) &&
    /for \(const item of plan\) diaryStore\.revokeThreadForRole\(diaryId, item\.roleId\)/.test(mainSrc));
}

// ---------------------------------------------------------------- E：排程倒计时
section('E 卡片下方排程 / 实时倒计时 / 卸载清理 interval');
{
  const fStart = viewSrc.indexOf('function formatCountdown');
  let depth = 0;
  let fEnd = -1;
  for (let i = viewSrc.indexOf('{', fStart); i < viewSrc.length; i++) {
    if (viewSrc[i] === '{') depth++;
    else if (viewSrc[i] === '}') { depth--; if (depth === 0) { fEnd = i + 1; break; } }
  }
  const fSrc = viewSrc.slice(fStart, fEnd);
  const fmt = new Function(ts.transpileModule(`${fSrc}\nreturn formatCountdown;`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
  }).outputText)();
  ok('E 倒计时 65s → 1:05', fmt(65000) === '1:05', fmt(65000));
  ok('E 倒计时 3661000ms → 1:01:01', fmt(3661000) === '1:01:01', fmt(3661000));
  ok('E 负值钳到 0:00', fmt(-1000) === '0:00', fmt(-1000));
  const scheduleComp = viewSrc.slice(viewSrc.indexOf('const DiarySchedule'), viewSrc.indexOf('export const DiaryView'));
  ok('E 每秒刷新且卸载清理 interval',
    /window\.setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/.test(scheduleComp) &&
    /return \(\) => window\.clearInterval\(timer\)/.test(scheduleComp));
  ok('E 四种模式 + 已完成 / 等待 / 动态评估分支齐备',
    ['scheduleModeWindow', 'scheduleModeDelay', 'scheduleModeFixed', 'scheduleModeNhpp',
      'scheduleDone', 'scheduleWaiting', 'scheduleDynamic', 'scheduleCountdown']
      .every((k) => scheduleComp.includes(k)));
  ok('E NHPP 未采样到具体时间不瞎编固定时刻',
    /task\.kind === 'nhpp' && \(!task\.dueAt \|\| Date\.parse\(task\.dueAt\) - now > 7 \* 86400_000\)/.test(scheduleComp));
  ok('E 排程数据复用 diary:list 同通道（无新增无谓通道）',
    /scheduleTasks: tasks\.filter\(\(t\) => t\.diaryId === d\.id\)/.test(mainSrc) &&
    /<DiarySchedule tasks=\{entry\.scheduleTasks \|\| \[\]\}/.test(viewSrc));
  const i18nKeys = [
    'diary.scheduleTitle', 'diary.scheduleModeWindow', 'diary.scheduleModeDelay',
    'diary.scheduleModeFixed', 'diary.scheduleModeNhpp', 'diary.scheduleDynamic',
    'diary.scheduleDone', 'diary.scheduleWaiting', 'diary.scheduleCountdown', 'diary.scheduleEmpty',
  ];
  const transSrc = read('src/i18n/translations.ts');
  ok('E zh/en 10 个新键齐全',
    i18nKeys.every((k) => transSrc.includes(`'${k}':`)));
  ok('E 8 个语言包 10 个新键齐全且无空值',
    ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'].every((lang) => {
      const dict = JSON.parse(read(`src/i18n/locales/${lang}.json`));
      return i18nKeys.every((k) => typeof dict[k] === 'string' && dict[k].trim());
    }));
  const diaryCssNow = cssSrc.slice(cssSrc.indexOf('.diary-schedule {'), cssSrc.indexOf('.diary-entries {'));
  ok('E 排程样式仅用主题令牌，零裸色值',
    /var\(--color-text\)/.test(diaryCssNow) && /var\(--color-border\)/.test(diaryCssNow) &&
    !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(diaryCssNow));
}

console.log('\n' + '='.repeat(70));
console.log(`${fail === 0 ? '✅' : '❌'} v3.0.25 BugFix 闸门：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败项：'); failures.forEach((f) => console.log('  ✗ ' + f)); }
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
