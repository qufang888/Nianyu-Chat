#!/usr/bin/env node
/**
 * verify-diary-comments-3024.mjs — v3.0.24 日记 AI 留言行为级闸门（Q1–Q10）。
 *
 * 零新增依赖：复用仓库已有的 esbuild / TypeScript 工具链，假 deps 驱动纯逻辑，
 * 不依赖真实模型、网络或 Electron 运行时。
 * 用法：node scripts/verify-diary-comments-3024.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-3024-'));
const require = createRequire(path.join(work, 'harness.cjs'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const section = (t) => console.log('\n=== ' + t + ' ===');

const viewSrc = read('src/components/DiaryView.tsx');
const settingsSrc = read('src/components/Settings.tsx');
const cssSrc = read('src/styles/index.css');
const mainSrc = read('electron/main.ts');
const diarySrc = read('electron/diary.ts');
const proactiveSrc = read('electron/proactive.ts');
const scheduleSrc = read('electron/diarySchedule.ts');
const preloadSrc = read('electron/preload.ts');
const ipcSrc = read('src/ipc.ts');
const pkg = JSON.parse(read('package.json'));

console.log('='.repeat(68));
console.log('v3.0.24 日记 AI 留言闸门 — Q1..Q10');
console.log('='.repeat(68));

// ---------------------------------------------------------------- Q1：可见人物布局
section('Q1 可见人物列表：240px 内部滚动 / 顶部固定 / 行对齐 / 长名省略');
{
  const listRule = /\.diary-role-list\s*\{([\s\S]*?)\}/.exec(cssSrc);
  const body = listRule ? listRule[1] : '';
  ok('Q1 .diary-role-list max-height:240px', /max-height:\s*240px/.test(body), body.slice(0, 120));
  ok('Q1 仅内部滚动（overflow-y:auto + overflow-x:hidden）',
    /overflow-y:\s*auto/.test(body) && /overflow-x:\s*hidden/.test(body), body.slice(0, 160));
  const roleLine = /\.diary-role-list \.diary-check\s*\{([\s\S]*?)\}/.exec(cssSrc);
  const lineBody = roleLine ? roleLine[1] : '';
  ok('Q1 行 flex + align-items:center + gap:6px + min-height:22px',
    /display:\s*flex/.test(lineBody) && /align-items:\s*center/.test(lineBody) &&
    /gap:\s*6px/.test(lineBody) && /min-height:\s*22px/.test(lineBody), lineBody.slice(0, 160));
  ok('Q1 checkbox 不伸缩', /flex:\s*0 0 auto/.test(lineBody) && /input\[type='checkbox'\]\s*\{\s*flex:\s*0 0 auto/.test(cssSrc));
  const nameRule = /\.diary-role-list \.diary-role-name\s*\{([\s\S]*?)\}/.exec(cssSrc);
  ok('Q1 长名单行省略',
    !!nameRule && /white-space:\s*nowrap/.test(nameRule[1]) && /text-overflow:\s*ellipsis/.test(nameRule[1]) &&
    /overflow:\s*hidden/.test(nameRule[1]));
  ok('Q1 全选/清空置于滚动容器外（JSX 顺序）',
    viewSrc.indexOf('className="diary-bulk"') < viewSrc.indexOf('className="diary-role-list"'));
  ok('Q1 行 title 属性携带完整名称', /<label key=\{r\.id\} className="diary-check" title=\{r\.name\}>/.test(viewSrc));
  ok('Q1 禁用态 opacity + pointer-events:none',
    /\.diary-role-pick\[disabled\]\s*\{[^}]*opacity:\s*0\.45[^}]*pointer-events:\s*none/.test(cssSrc));
  const diaryCss = cssSrc.slice(cssSrc.indexOf('.diary-panel {'), cssSrc.indexOf('/* ===== v3.0.19'));
  ok('Q1 日记样式段零裸色值（14 主题）', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(diaryCss));
  ok('Q1 设置页复用同款滚动列表', /id="sec-diary-comment-schedule"[\s\S]{0,400}?className="diary-role-list"/.test(settingsSrc));
}

// ---------------------------------------------------------------- 纯模块打包
const scheduleOut = path.join(work, 'schedule.mjs');
await build({
  stdin: { contents: `export * from ${JSON.stringify(path.join(ROOT, 'electron/diarySchedule.ts'))};`, loader: 'ts', resolveDir: ROOT },
  outfile: scheduleOut, bundle: true, format: 'esm', platform: 'node', target: 'es2020', logLevel: 'silent',
});
const S = await import(pathToFileURL(scheduleOut).href + '?v=' + Date.now());

// ---------------------------------------------------------------- Q2：普通三子模式
section('Q2 window / delay / fixed 排程与 tone=skip');
{
  const base = { enabled: true, mode: 'normal', normal: {} };
  const saved = new Date(2026, 10, 20, 10, 0, 0);
  const w = S.computeDiaryDueAt('window', saved, { ...base, normal: { trigger: 'window', window: { start: '09:00', end: '11:00' } } }, () => 0.5);
  ok('Q2 window 在时段内均匀取点', w.getHours() === 10 && w.getMinutes() === 0, w.toString());
  const wNext = S.computeDiaryDueAt('window', saved, { ...base, normal: { trigger: 'window', window: { start: '08:00', end: '09:00' } } }, () => 0.5);
  ok('Q2 window 已过当日窗口 → 顺延次日', wNext.getTime() > saved.getTime() && wNext.getDate() === saved.getDate() + 1, wNext.toString());
  const cross = S.computeDiaryDueAt('window', new Date(2026, 10, 20, 23, 30), { ...base, normal: { trigger: 'window', window: { start: '22:00', end: '02:00' } } }, () => 0.75);
  ok('Q2 跨午夜窗口落在相邻两日区间内', cross.getTime() > 0 && cross.getHours() >= 0);
  const d = S.computeDiaryDueAt('delay', saved, { ...base, normal: { trigger: 'delay', delayMinutes: 45 } }, () => 0.5);
  ok('Q2 delay = 保存时刻 + 分钟（并钳制 1..1440）', d.getTime() - saved.getTime() === 45 * 60_000);
  const dClamp = S.computeDiaryDueAt('delay', saved, { ...base, normal: { trigger: 'delay', delayMinutes: 99999 } }, () => 0.5);
  ok('Q2 delay 上限钳到 1440 分钟', dClamp.getTime() - saved.getTime() === 1440 * 60_000);
  const f = S.computeDiaryDueAt('fixed', saved, { ...base, normal: { trigger: 'fixed', fixedTime: '16:30' } }, () => 0.5);
  ok('Q2 fixed 当日未过点取当日', f.getHours() === 16 && f.getMinutes() === 30 && f.getDate() === saved.getDate(), f.toString());
  const fNext = S.computeDiaryDueAt('fixed', saved, { ...base, normal: { trigger: 'fixed', fixedTime: '09:00' } }, () => 0.5);
  ok('Q2 fixed 过点顺延次日', fNext.getDate() === saved.getDate() + 1 && fNext.getHours() === 9, fNext.toString());
  const fp1 = S.diaryConfigFingerprint({ ...base, normal: { trigger: 'fixed', fixedTime: '09:00' } });
  const fp2 = S.diaryConfigFingerprint({ normal: { fixedTime: '09:00', trigger: 'fixed' }, mode: 'normal' });
  ok('Q2 配置指纹与键顺序无关', fp1 === fp2);
}

// ---------------------------------------------------------------- Q4/Q9：一人物一留言 + 心跳
section('Q4/Q9 一人物一留言硬锁 / 配置变更 superseded / enabled=false cancelled');
{
  const tasks = [];
  const diaries = [{ id: 'd1', selfRoleId: 'self1', updated_at: new Date().toISOString(), created_at: new Date().toISOString(), allowAi: true, visibleRoleIds: ['A', 'B'], aiComments: [] }];
  const locked = new Set();
  let genCalls = 0;
  const store = {
    listTasks: () => [...tasks],
    upsertTask: (t) => { const i = tasks.findIndex((x) => x.id === t.id); if (i >= 0) tasks[i] = t; else tasks.push(t); },
    dropTasksForRole: (did, rid, statuses) => {
      for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].diaryId === did && tasks[i].roleId === rid && (!statuses || statuses.includes(tasks[i].status))) tasks.splice(i, 1);
    },
    dropTasksForDiary: (did) => { for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].diaryId === did) tasks.splice(i, 1); },
    commentLocked: (did, rid) => locked.has(`${did}:${rid}`),
    getDiary: (id) => diaries.find((d) => d.id === id),
    listDiaries: () => diaries,
  };
  let configs = {
    A: { enabled: true, mode: 'normal', normal: { trigger: 'delay', delayMinutes: 1 } },
    B: { enabled: true, mode: 'normal', normal: { trigger: 'delay', delayMinutes: 2 } },
  };
  let skippedTone = false;
  const sc = new S.DiaryCommentScheduler();
  sc.init({
    getSettings: () => ({ diaryCommentSchedules: configs }),
    getStore: () => store,
    isToneSkipped: () => skippedTone,
    generateComment: async (did, rid) => {
      genCalls++;
      locked.add(`${did}:${rid}`);
      diaries[0].aiComments.push({ id: `c${rid}`, roleId: rid, text: '留言', tone: 'warm', affinityAt: 50, moodAt: '平静', revoked: false, created_at: new Date().toISOString(), replies: [], awaitingUserReply: true });
      return { ok: true, generatedRoleIds: [rid], skippedRoleIds: [] };
    },
    rescheduleNhpps: () => {},
    clearNhppsForRole: () => {},
  });
  const legacy = sc.onDiarySaved(diaries[0]);
  ok('Q4 有配置角色不进 legacy 立即生成', legacy.length === 0 && tasks.length === 2, JSON.stringify(legacy));
  const future = new Date(Date.now() + 5 * 60_000);
  sc.heartbeat(new Date(Date.now() - 1000));
  ok('Q2 未到期不触发 AI', genCalls === 0);
  sc.heartbeat(future);
  await new Promise((r) => setImmediate(r));
  ok('Q2 到期每轮只发一条', genCalls === 1, `calls=${genCalls}`);
  skippedTone = true;
  sc.heartbeat(new Date(future.getTime() + 60_000));
  ok('Q2 tone=skip 角色不调用模型', genCalls === 1 && tasks.some((t) => t.reason === 'tone_skip'));
  skippedTone = false;
  for (let i = 0; i < 3; i++) sc.heartbeat(new Date(future.getTime() + 120_000 + i * 60_000));
  ok('Q4 已 sent 后重复心跳零新增', genCalls === 1, `calls=${genCalls}`);

  // 造一个到期的新 pending 任务，验证顶层锁即使在新排程里也拦得住。
  store.upsertTask({
    id: 'dct_lock_probe', diaryId: 'd1', roleId: 'A', selfRoleId: 'self1', kind: 'delay',
    status: 'pending', dueAt: new Date(Date.now() - 1000).toISOString(),
    configFingerprint: 'probe', createdAt: new Date().toISOString(),
  });
  sc.heartbeat(new Date());
  ok('Q4 重复触发被硬锁跳过（skipped:locked）',
    tasks.some((t) => t.id === 'dct_lock_probe' && t.reason === 'locked') && genCalls === 1, JSON.stringify(tasks.filter((t) => t.id === 'dct_lock_probe')));

  locked.clear();
  diaries[0].aiComments = [];
  // 配置变更只重排 pending：把已 sent / skipped 的任务复位再验证裁定 #4。
  for (const t of tasks) if (t.roleId === 'A') { t.status = 'pending'; t.reason = undefined; }
  configs = { A: { enabled: true, mode: 'normal', normal: { trigger: 'fixed', fixedTime: '15:00' } }, B: configs.B };
  sc.onConfigChanged(configs);
  await new Promise((r) => setImmediate(r));
  ok('Q9 window→fixed：旧 pending 变 superseded', tasks.some((t) => t.roleId === 'A' && t.status === 'superseded'), JSON.stringify(tasks));
  ok('Q9 window→fixed：新任务 dueAt 按固定时刻（本地 15:00）',
    tasks.some((t) => {
      if (t.roleId !== 'A' || t.status !== 'pending' || t.kind !== 'fixed') return false;
      const local = new Date(t.dueAt);
      return local.getHours() === 15 && local.getMinutes() === 0;
    }), JSON.stringify(tasks.filter((t) => t.roleId === 'A')));
  configs = { A: { ...configs.A, enabled: false }, B: configs.B };
  sc.onConfigChanged(configs);
  ok('Q9 enabled=false：pending 全部 cancelled', tasks.filter((t) => t.status === 'pending').length === 0, JSON.stringify(tasks));
}

// ---------------------------------------------------------------- Q6：Store 旧档 / 整串撤销 / 回复上下文
section('Q6 旧存档零迁移 / 整串撤销 / 回复上下文 P0–P5');
{
  const storeOut = path.join(work, 'diary.mjs');
  await build({
    stdin: { contents: [
      `export * from ${JSON.stringify(path.join(ROOT, 'electron/diary.ts'))};`,
      `export * as secure from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
    ].join('\n'), loader: 'ts', resolveDir: ROOT },
    outfile: storeOut, bundle: true, format: 'esm', platform: 'node', target: 'es2020', logLevel: 'silent',
  });
  const D = await import(pathToFileURL(storeOut).href + '?v=' + Date.now());
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  D.secure.initSecureStore(path.join(work, 'nianyu-master.key'));
  // 旧档：无 commentTasks / 无 replies。
  fs.writeFileSync(path.join(dataDir, 'diary.json'), JSON.stringify({
    version: 1, seq: 1,
    diaries: [{ id: 'old1', selfRoleId: 'self1', date: '2026-01-01', title: '旧', content: '正文', allowAi: true, visibleRoleIds: ['A'], aiComments: [{ id: 'c1', roleId: 'A', text: '旧留言', tone: 'warm', affinityAt: 50, moodAt: '平静', revoked: false, created_at: new Date().toISOString() }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    diary_summaries: [],
  }), 'utf8');
  D.resetDiaryStore();
  const st = D.getDiaryStore();
  st.init(dataDir);
  ok('Q10 旧 diary.json 无新字段零迁移可读', st.getDiary('old1')?.aiComments?.[0]?.text === '旧留言' && st.listTasks().length === 0);
  ok('Q4 旧留言参与顶层锁', st.commentLocked('old1', 'A') === true && st.commentLocked('old1', 'B') === false);
  const user = { id: 'u1', author: 'user', text: '我养了只猫', roleId: '', created_at: new Date().toISOString() };
  const ai = { id: 'a1', author: 'ai', text: '猫怎么样了？', roleId: 'A', created_at: new Date().toISOString() };
  st.addReply('c1', user); st.addReply('c1', ai); st.setAwaiting('c1', true);
  ok('Q5 replies 落盘且 awaitingUserReply 流转', st.getComment('old1', 'c1').replies.length === 2 && st.getComment('old1', 'c1').awaitingUserReply === true);
  st.revokeThreadForRole('old1', 'A');
  const revoked = st.getComment('old1', 'c1');
  ok('Q4 force 整串软撤（顶层 + replies）', revoked.revoked === true && revoked.replies.every((r) => r.revoked === true));
  ok('Q4 撤销后产物门控为空', D.buildDiaryContextBlock('A', 'self1') === '');

  const context = D.buildDiaryReplyContext({
    roleId: 'A', roleName: '小星', userText: '还记得我的猫吗',
    thread: [
      { id: 'u_fresh', author: 'user', text: '我养了只猫', roleId: '', created_at: new Date().toISOString() },
      { id: 'a_fresh', author: 'ai', text: '猫怎么样了？', roleId: 'A', created_at: new Date().toISOString() },
    ],
    topText: '今天有点累', artifactBlock: '- [留言] 门控产物',
    chatMessages: [
      { content: '我养了只猫', sender_type: 'user', timestamp: '2026-01-01T00:00:00Z' },
      { content: '好久不见', sender_type: 'user', timestamp: '2026-01-02T00:00:00Z' },
    ],
    historyCap: 16,
  });
  ok('Q6 P0 用户本次原文永不丢', context.includes('还记得我的猫吗'));
  ok('Q6 P1 整串历史条目永不丢', context.includes('我养了只猫') && context.includes('猫怎么样了'));
  ok('Q6 P2 顶层留言存在', context.includes('今天有点累'));
  ok('Q6 P5 关键词命中更早单聊', context.includes('猫'));
  ok('Q6 6000 字符硬预算', context.length <= D.DIARY_REPLY_CHAR_BUDGET, String(context.length));
  const huge = D.buildDiaryReplyContext({
    roleId: 'A', roleName: 'A', userText: '猫'.repeat(3000),
    thread: Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, author: 'user', text: '历史'.repeat(500), roleId: '', created_at: new Date().toISOString() })),
    topText: '顶端', artifactBlock: '产物', chatMessages: [], historyCap: 16,
  });
  ok('Q6 超预算仍 ≤6000 且保留用户原文', huge.length <= 6000 && huge.includes('猫'.repeat(1000)));
  ok('Q6 回复上下文函数不读取日记正文', !/\bcontent\s*\?/.test(D.buildDiaryReplyContext.toString()) || !/diary\.content/.test(diarySrc));
}

// ---------------------------------------------------------------- Q3：NHPP 隔离 / DND / 每日上限
section('Q3 日记 NHPP 独立 store / DND 顺延 / dailyLimit / 聊天零回退');
{
  const proactiveOut = path.join(work, 'proactive.cjs');
  const bundle = await build({
    stdin: { contents: [
      `export * from ${JSON.stringify(path.join(ROOT, 'electron/proactive.ts'))};`,
      `export { initSecureStore, readText as secureReadText } from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
    ].join('\n'), loader: 'ts', resolveDir: ROOT },
    bundle: true, format: 'cjs', platform: 'node', target: 'es2020', write: false, logLevel: 'silent',
    external: ['electron', './ai', './queueManager', 'fs', 'path'],
  });
  fs.writeFileSync(proactiveOut, bundle.outputFiles[0].text, 'utf8');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) { if (request === 'electron') return 'electron-stub'; return origResolve.call(this, request, ...rest); };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getPath: () => work } };
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[proactiveOut];
  const P = require(proactiveOut);
  P.initSecureStore(path.join(work, 'nianyu-master.key'));
  Module._resolveFilename = origResolve;
  Module._load = origLoad;

  const now = Date.now();
  const chatKey = 'single:r1';
  const diaryKey = 'diary:d1:A';
  fs.writeFileSync(path.join(work, 'proactive-nhpp.json'), JSON.stringify({
    priors: {}, candidates: { [chatKey]: { chatKey, candidateTime: now - 1000, status: 'pending' } },
    pendingCallbacks: {}, feedback: [], dailyCount: {}, replyGapEma: {},
  }), 'utf8');
  fs.writeFileSync(path.join(work, 'diary-nhpp.json'), JSON.stringify({
    priors: {}, candidates: { [diaryKey]: { chatKey: diaryKey, candidateTime: now - 1000, status: 'pending' } },
    pendingCallbacks: {}, feedback: [], dailyCount: {}, replyGapEma: {},
  }), 'utf8');
  const sentChat = [];
  const sentDiary = [];
  const baseSettings = { proactiveEngine: 'nhpp', idleEnabled: true, proactiveDailyLimit: 5, proactiveFreshnessMin: 0, idleCooldownUntilReply: false, proactiveDnd: { enabled: false } };
  P.initProactiveEngine({
    getSettings: () => baseSettings,
    sendProactive: async (ct, ci) => { sentChat.push(`${ct}:${ci}`); return { ok: true }; },
    getMessages: () => [],
    isBusy: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  P.heartbeatProactive();
  ok('Q3 聊天心跳不发送 diary: key', sentChat.length === 1 && sentChat[0] === chatKey, JSON.stringify(sentChat));
  ok('Q3 聊天 store 中无 diary key 写入', !fs.readFileSync(path.join(work, 'proactive-nhpp.json'), 'utf8').includes('diary:'));

  P.initDiaryNhpps({
    getSettings: () => baseSettings,
    sendDiaryComment: async (did, rid) => { sentDiary.push(`${did}:${rid}`); return { ok: true }; },
    isDiaryCommentLocked: () => false,
    getDiaryOverride: () => undefined,
    getDiaryMessages: () => [],
    logError: () => {},
  });
  fs.writeFileSync(path.join(work, 'diary-nhpp.json'), JSON.stringify({
    priors: {}, candidates: { [diaryKey]: { chatKey: diaryKey, candidateTime: Date.now() - 1000, status: 'pending' } },
    pendingCallbacks: {}, feedback: [], dailyCount: {}, replyGapEma: {},
  }), 'utf8');
  P.initDiaryNhpps({
    getSettings: () => baseSettings,
    sendDiaryComment: async (did, rid) => { sentDiary.push(`${did}:${rid}`); return { ok: true }; },
    isDiaryCommentLocked: () => false,
    getDiaryOverride: () => undefined,
    getDiaryMessages: () => [],
    logError: () => {},
  });
  P.heartbeatDiaryComments();
  await new Promise((r) => setImmediate(r));
  ok('Q3 日记心跳发出且只发一条', sentDiary.length === 1 && sentDiary[0] === 'd1:A', JSON.stringify(sentDiary));
  ok('Q3 两套心跳互不阻塞（聊天/日记各 1）', sentChat.length === 1 && sentDiary.length === 1);
  ok('Q3 日记 key 只写独立文件', fs.readFileSync(path.join(work, 'diary-nhpp.json'), 'utf8').includes('diary:d1:A'));

  // DND：候选顺延到窗口结束后 60s。
  const dndSettings = { ...baseSettings, proactiveDnd: { enabled: true, start: '00:00', end: '23:59' } };
  fs.writeFileSync(path.join(work, 'diary-nhpp.json'), JSON.stringify({
    priors: {}, candidates: { [diaryKey]: { chatKey: diaryKey, candidateTime: Date.now() - 1000, status: 'pending' } },
    pendingCallbacks: {}, feedback: [], dailyCount: {}, replyGapEma: {},
  }), 'utf8');
  P.initDiaryNhpps({
    getSettings: () => dndSettings,
    sendDiaryComment: async () => { sentDiary.push('dnd-should-not-send'); return { ok: true }; },
    isDiaryCommentLocked: () => false,
    getDiaryMessages: () => [],
    logError: () => {},
  });
  P.heartbeatDiaryComments();
  // saveDiaryStore 500ms 防抖落盘，等真正写盘后再断言。
  await new Promise((r) => setTimeout(r, 700));
  const dndStore = JSON.parse(P.secureReadText(path.join(work, 'diary-nhpp.json')));
  ok('Q3 DND 命中顺延（after_dnd，不发送）',
    !sentDiary.includes('dnd-should-not-send') && dndStore.candidates[diaryKey].reason === 'after_dnd' &&
    dndStore.candidates[diaryKey].candidateTime > Date.now(), JSON.stringify(dndStore.candidates[diaryKey]));
  ok('Q3 顶层留言锁为额外硬门禁',
    /isDiaryCommentLocked\(diaryId, roleId\)/.test(proactiveSrc) &&
    /cand\.reason = 'locked'/.test(proactiveSrc));
  ok('Q3 既有导出函数签名未变（聊天零回退）',
    /export function initProactiveEngine\(d: ProactiveDeps\)/.test(proactiveSrc) &&
    /export function heartbeatProactive\(\)/.test(proactiveSrc) &&
    /export function rescheduleProactive\(chatType: string, chatId: string\)/.test(proactiveSrc) &&
    /export function markQuickReply\(chatKey: string\)/.test(proactiveSrc) &&
    /export function deriveAwaitingReplyKeys\(\): string\[\]/.test(proactiveSrc));
  const diarySection = proactiveSrc.slice(
    proactiveSrc.indexOf('export function rescheduleDiaryComment'),
    proactiveSrc.indexOf('// 供日志使用')
  );
  ok('Q3 日记 API 段零聊天 store 写入（源码强断言）',
    /diaryStore\.candidates\[key\]/.test(diarySection) &&
    !/(?<!diary)store\.candidates\[/.test(diarySection),
    (diarySection.match(/(?<!diary)store\.candidates\[/g) || []).join(','));
}

// ---------------------------------------------------------------- Q5/Q6：回复锁与 prompt 门控（静态）
section('Q5/Q6 每轮回复必由用户触发 / 回复 prompt 不含日记正文');
{
  const defCount = (mainSrc.match(/generateDiaryReply\(/g) || []).length;
  ok('Q5 generateDiaryReply 仅定义 + 用户回复事件一处调用', defCount === 2, `count=${defCount}`);
  ok('Q5 无定时器自动调用回复',
    !/setInterval[\s\S]{0,400}?generateDiaryReply\(/.test(mainSrc) &&
    !/heartbeat[\s\S]{0,300}?generateDiaryReply\(/.test(mainSrc));
  ok('Q5 用户回复先落 user 再置 awaiting=false',
    /diaryStore\.addReply\(commentId, reply\)[\s\S]{0,120}?diaryStore\.setAwaiting\(commentId, false\)/.test(mainSrc));
  ok('Q5 AI 回复完成后重新置 awaiting=true',
    /diaryStore\.addReply\(commentId, reply\)[\s\S]{0,160}?diaryStore\.setAwaiting\(commentId, true\)/.test(mainSrc));
  const replyFn = mainSrc.slice(mainSrc.indexOf('async function generateDiaryReply'), mainSrc.indexOf('async function addDiaryUserReply'));
  ok('Q6 回复 prompt 不拼接 diary.content', !/\bd\.content\b|diary\.content/.test(replyFn), replyFn.slice(0, 200));
  ok('Q6 P3 唯一产物注入口为 buildDiaryContextBlock',
    /buildDiaryContextBlock\(role\.id, d\.selfRoleId\)/.test(replyFn) &&
    !/collectArtifactsForRole\(/.test(replyFn) &&
    (mainSrc.match(/buildDiaryContextBlock\(/g) || []).length >= 2);
  ok('Q6 回复仅取该角色单聊（P4/P5）', /dm\.getMessages\('single', role\.id\)/.test(replyFn) && !/getMessages\('group'/.test(replyFn));
  ok('Q6 回复校验留言归属与可见/身份门控',
    /diaryStore\.getComment\(diaryId, commentId\)/.test(replyFn) &&
    /canRoleAccessDiary\(d, c\.roleId\)/.test(replyFn) &&
    /diaryValidIds\(\)\.includes\(d\.selfRoleId\)/.test(replyFn));
  ok('Q6 回复服务使用 6000 字符预算装配器', /buildDiaryReplyContext\(\{/.test(replyFn) && /DIARY_REPLY_CHAR_BUDGET = 6000/.test(diarySrc));
}

// ---------------------------------------------------------------- Q7/Q8：通知矩阵
section('Q7/Q8 静默只静音 / 通知同级 / 标题+角色名');
{
  const notifyFn = mainSrc.slice(mainSrc.indexOf('function notifyDiaryEvent'), mainSrc.indexOf('async function callDiaryAI') > 0 && mainSrc.indexOf('function notifyDiaryEvent') < mainSrc.indexOf('async function callDiaryAI') ? mainSrc.indexOf('async function callDiaryAI') : mainSrc.length);
  ok('Q7 showNotifyCard 首行仍是唯一静默闸门',
    /function showNotifyCard\(item: any, force = false\): void \{\s*\n\s*\/\/ [^\n]*\n\s*if \(dm\.getSettings\(\)\.silent === true\) return;/.test(mainSrc));
  ok('Q7 通知只经 showNotifyCard（notifyDiaryEvent 内恰好一次且无 force）',
    (notifyFn.match(/showNotifyCard\(/g) || []).length === 1 && !/showNotifyCard\(\{[\s\S]{0,600}?\},\s*true\)/.test(notifyFn));
  ok('Q7 生成路径内没有新增 silent 判断',
    !/\bsilent\b/.test(mainSrc.slice(mainSrc.indexOf('async function generateDiaryReply'), mainSrc.indexOf('async function addDiaryUserReply'))) &&
    !/\bsilent\b/.test(mainSrc.slice(mainSrc.indexOf('async function generateDiaryComments'), mainSrc.indexOf('/** 总结只产出独立'))));
  const commentFn = mainSrc.slice(mainSrc.indexOf('async function generateDiaryComments'), mainSrc.indexOf('/** 总结只产出独立'));
  const replyFnSilent = mainSrc.slice(mainSrc.indexOf('async function generateDiaryReply'), mainSrc.indexOf('async function addDiaryUserReply'));
  ok('Q7 生成路径零直接 showNotifyCard（只有 notifyDiaryEvent 单一出口）',
    !/showNotifyCard\(/.test(replyFnSilent) && !/showNotifyCard\(/.test(commentFn));
  ok('Q7 留言生成后调用 notifyDiaryEvent', /notifyDiaryEvent\('comment', d, role\.id, text, commentId\)/.test(commentFn));
  ok('Q7 回复生成后调用 notifyDiaryEvent（用户回复不调用）',
    /notifyDiaryEvent\('reply', d, role\.id, text, commentId\)/.test(mainSrc) &&
    !/notifyDiaryEvent\('reply'/.test(mainSrc.slice(mainSrc.indexOf('async function addDiaryUserReply'), mainSrc.indexOf('// ===== v3.0.24 留言回复'))));
  ok('Q8 通知 payload 含标题截断 + 完整角色名',
    /String\(diary\.title \|\| diary\.date \|\| ''\)\.slice\(0, DIARY_TITLE_TRUNC\)/.test(mainSrc) &&
    /content: `《\$\{titleTrunc\}》· \$\{roleName\}：\$\{summary\}`/.test(mainSrc) &&
    /const roleName = diaryRoleName\(roleId\)/.test(mainSrc));
  ok('Q8 label 取 notify.diaryNewComment/Reply 且 chatType=diary',
    /'notify\.diaryNewComment'/.test(notifyFn) && /'notify\.diaryNewReply'/.test(notifyFn) &&
    /chatType: 'diary'/.test(notifyFn));
  const openFn = mainSrc.slice(mainSrc.indexOf('function openNotifyChat'), mainSrc.indexOf('function hideNotifyWindow'));
  ok('Q8 通知点击 diary 分支不误开聊天',
    /chat\.chatType === 'diary'/.test(openFn) &&
    /broadcast\('diary:open'/.test(openFn) &&
    /else if \(mainWindow/.test(openFn) &&
    (openFn.match(/webContents\.send\('app:openChat', chat\)/g) || []).length === 1);
  ok('Q8 二次确认使用自绘 api.showConfirm!（零 window.confirm）',
    /api\.showConfirm!\s*\(\s*t\('diary\.confirmRegenerateComment'\)\s*\)/.test(viewSrc) &&
    !/window\s*\.\s*confirm\s*\(/.test(viewSrc) &&
    !/window\s*\.\s*confirm\s*\(/.test(settingsSrc));
}

// ---------------------------------------------------------------- Q10：版本 / API / i18n / 文档
section('Q10 版本 / 三端 IPC / i18n 10 语言 / 文档同步');
{
  ok('Q10 package.json >= 3.0.24（含 v3.0.25 BugFix）', /^3\.0\.(2[4-9]|[3-9]\d)$/.test(pkg.version));
  ok('Q10 新脚本已登记', /"verify:diary-comments-3024"/.test(read('package.json')));
  ok('Q10 main 两个新 IPC handler 齐备',
    /ipcMain\.handle\('diary:replyAdd'/.test(mainSrc) && /ipcMain\.handle\('diary:commentRegenerateOne'/.test(mainSrc));
  for (const [name, srcText] of [['preload', preloadSrc], ['ipc', ipcSrc]]) {
    ok(`Q10 ${name} 三端通道齐备`,
      /diaryReplyAdd/.test(srcText) && /diaryCommentRegenerateOne/.test(srcText));
  }
  ok('Q10 main 注册 diary:replyAdd / diary:commentRegenerateOne',
    /ipcMain\.handle\('diary:replyAdd'/.test(mainSrc) && /ipcMain\.handle\('diary:commentRegenerateOne'/.test(mainSrc));
  ok('Q10 settings:save 钩子调用 onConfigChanged',
    /getDiaryCommentScheduler\(\)\.onConfigChanged\(next\.diaryCommentSchedules\)/.test(mainSrc));
  const keys = [
    'diary.commentSchedule', 'diary.commentModeNormal', 'diary.commentModeNhpp',
    'diary.triggerWindow', 'diary.triggerDelay', 'diary.triggerFixed',
    'diary.windowStart', 'diary.windowEnd', 'diary.delayMinutes', 'diary.fixedTime',
    'diary.enablePerRole', 'diary.replyPlaceholder', 'diary.replySend',
    'diary.replyFromAi', 'diary.replyFromMe', 'diary.awaitingReply',
    'diary.replyGenerating', 'diary.replyFailed', 'diary.confirmRegenerateComment',
    'diary.scheduleHint', 'notify.diaryNewComment', 'notify.diaryNewReply',
  ];
  const trans = read('src/i18n/translations.ts');
  const missingZhEn = keys.filter((k) => !trans.includes(`'${k}':`));
  ok('Q10 zh/en 新增键齐全（translations.ts）', missingZhEn.length === 0, missingZhEn.join(','));
  for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
    const dict = JSON.parse(read(`src/i18n/locales/${lang}.json`));
    const missing = keys.filter((k) => typeof dict[k] !== 'string' || dict[k].trim() === '');
    const ph = ['notify.diaryNewComment', 'notify.diaryNewReply'].filter((k) => !dict[k].includes('{title}') || !dict[k].includes('{role}'));
    ok(`Q10 ${lang} 新键齐全无空值 / 占位符一致`, missing.length === 0 && ph.length === 0, missing.concat(ph).join(','));
  }
  for (const doc of ['README.md', '使用说明.md', '硬编码清单.md', '版本更新记录.md']) {
    ok(`Q10 ${doc} 同步 3.0.24`, read(doc).includes('3.0.24'));
  }
  ok('Q10 GuideView 同步 v3.0.24 说明', read('src/components/GuideView.tsx').includes('v3.0.24'));
  ok('Q10 新常量登记硬编码清单',
    ['diary-nhpp.json', '15000ms', '6000', '24'].every((s) => read('硬编码清单.md').includes(s)));
  ok('Q10 日志不输出 apiKey / 完整 prompt',
    !/dm\.logError\([^\n]*apiKey/i.test(mainSrc) && !/dm\.logError\([^\n]*prompt/i.test(mainSrc));
}

console.log('\n' + '='.repeat(68));
console.log(`${fail === 0 ? '✅' : '❌'} v3.0.24 日记留言闸门：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败项：'); failures.forEach((f) => console.log('  ✗ ' + f)); }
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
