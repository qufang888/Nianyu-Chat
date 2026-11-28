#!/usr/bin/env node
/**
 * verify-diary-migration-v3022.mjs — v3.0.22 日记归属兼容迁移行为闸门
 *
 * 用 esbuild 真实加载 electron/diary.ts，构造「历史哨兵 + 已删身份 + 有效身份」三类日记
 * 与配套留言/摘要，验证：只改 selfRoleId / 幂等 / 不 revoke / 不改时间戳 / 摘要游标自洽 /
 * 产物逐字保留。另对 main.ts 的 diary:create 严格门控与三个迁移触发时机做源码强断言。
 *
 * 运行：node scripts/verify-diary-migration-v3022.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-migrate-'));
const outfile = path.join(work, 'diary.mjs');
await build({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(ROOT, 'electron/diary.ts'))};
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
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? `  <<< ${extra}` : ''));
  }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const clone = (v) => JSON.parse(JSON.stringify(v));
const stamp = '2026-01-02T03:04:05.000Z';
const diaries = [
  {
    id: 'd_legacy', selfRoleId: 'none', date: '2026-01-01', title: '历史哨兵', content: '历史正文',
    allowAi: true, visibleRoleIds: ['A'], aiComments: [
      { id: 'c1', roleId: 'A', text: '留言一', tone: 'warm', affinityAt: 80, moodAt: '开心', revoked: false, created_at: stamp },
    ],
    created_at: stamp, updated_at: stamp,
  },
  {
    id: 'd_orphan', selfRoleId: 'deleted_role', date: '2026-01-02', title: '已删身份', content: '孤儿正文',
    allowAi: true, visibleRoleIds: ['A'], aiComments: [
      { id: 'c2', roleId: 'A', text: '留言二', tone: 'neutral', affinityAt: 50, moodAt: '平静', revoked: true, created_at: stamp },
    ],
    created_at: stamp, updated_at: stamp,
  },
  {
    id: 'd_valid', selfRoleId: 'self_2', date: '2026-01-03', title: '有效身份', content: '有效正文',
    allowAi: true, visibleRoleIds: ['A'], aiComments: [],
    created_at: stamp, updated_at: stamp,
  },
];
const summaries = diaries.map((d, i) => ({
  id: `s_${i}`, diaryId: d.id, roleId: 'A', selfRoleId: d.selfRoleId,
  visibleRoleIdsSnapshot: ['A'], text: `摘要${i}`, sourceUpdatedAt: d.updated_at,
  revoked: i === 1, created_at: stamp,
}));
const beforeDiaries = clone(diaries);
const beforeSummaries = clone(summaries);

section('A. 专用迁移：只改两个 selfRoleId，正文/留言/摘要/时间戳逐字保留');
const artifactsBefore = diaries.map((d) =>
  D.collectArtifactsForRole({ diaries: [d], summaries, roleId: 'A', selfRoleId: d.selfRoleId })
);
const result = D.migrateLegacyDiaries(diaries, summaries, ['self_1', 'self_2'], 'self_2');
ok('迁移计数 = 2 篇日记 + 2 条摘要', result.migratedDiaries === 2 && result.migratedSummaries === 2,
  JSON.stringify(result));
ok('目标身份 = 有效的 currentSelfRoleId', result.targetSelfRoleId === 'self_2');
ok('三类日记全部归入目标身份', diaries.every((d) => d.selfRoleId === 'self_2'));
ok('摘要同步归入目标身份', summaries.every((s) => s.selfRoleId === 'self_2'));
for (let i = 0; i < beforeDiaries.length; i++) {
  const a = beforeDiaries[i];
  const b = diaries[i];
  ok(`日记 ${a.id} 仅 selfRoleId 变化`,
    b.content === a.content && b.date === a.date && b.title === a.title &&
    b.created_at === a.created_at && b.updated_at === a.updated_at &&
    b.allowAi === a.allowAi && JSON.stringify(b.visibleRoleIds) === JSON.stringify(a.visibleRoleIds) &&
    JSON.stringify(b.aiComments) === JSON.stringify(a.aiComments));
  const sa = beforeSummaries[i];
  const sb = summaries[i];
  ok(`摘要 ${sa.id} 仅 selfRoleId 变化`,
    sb.text === sa.text && sb.revoked === sa.revoked &&
    sb.sourceUpdatedAt === sa.sourceUpdatedAt &&
    JSON.stringify(sb.visibleRoleIdsSnapshot) === JSON.stringify(sa.visibleRoleIdsSnapshot));
}
const artifactsAfter = diaries.map((d) =>
  D.collectArtifactsForRole({ diaries: [d], summaries, roleId: 'A', selfRoleId: d.selfRoleId })
);
ok('迁移前后按各自身份查询的产物逐字一致',
  JSON.stringify(artifactsBefore) === JSON.stringify(artifactsAfter),
  JSON.stringify(artifactsAfter));

section('B. 幂等 / 无身份保留 / 无效偏好回落第一个身份');
const beforeSecondDiaries = clone(diaries);
const beforeSecondSummaries = clone(summaries);
const second = D.migrateLegacyDiaries(diaries, summaries, ['self_1', 'self_2'], 'self_2');
ok('第二次迁移两个计数均为 0', second.migratedDiaries === 0 && second.migratedSummaries === 0);
ok('第二次数据逐字不变',
  JSON.stringify(diaries) === JSON.stringify(beforeSecondDiaries) &&
  JSON.stringify(summaries) === JSON.stringify(beforeSecondSummaries));
const none = D.migrateLegacyDiaries(clone(beforeDiaries), clone(beforeSummaries), [], null);
ok('无身份时 target=null 且零迁移', none.targetSelfRoleId === null &&
  none.migratedDiaries === 0 && none.migratedSummaries === 0);
const fallback = D.migrateLegacyDiaries(clone(beforeDiaries), clone(beforeSummaries), ['self_1', 'self_2'], 'deleted_role');
ok('偏好无效时回落第一个有效身份', fallback.targetSelfRoleId === 'self_1' && fallback.migratedDiaries === 2);

section('C. DiaryStore 薄封装：有变更才落盘，字节幂等');
const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });
D.resetDiaryStore();
const store = D.getDiaryStore();
store.init(dataDir);
store.save();
const file = path.join(dataDir, D.DIARY_FILE);
const bytesBefore = fs.readFileSync(file);
const r1 = store.migrateLegacySelfRoles(['self_2'], 'self_2');
ok('空库迁移零计数', r1.migratedDiaries === 0 && r1.migratedSummaries === 0);
ok('零变更时不写盘（字节不变）', Buffer.compare(bytesBefore, fs.readFileSync(file)) === 0);
const legacy = store.createDiary({ selfRoleId: 'none', date: '2026-02-01', content: '待迁移正文' });
store.addComment(legacy.id, {
  id: 'c_store', roleId: 'A', text: '待保留留言', tone: 'warm', affinityAt: 80, moodAt: '开心', revoked: false, created_at: stamp,
});
store.addSummary({
  id: 's_store', diaryId: legacy.id, roleId: 'A', selfRoleId: 'none', visibleRoleIdsSnapshot: [],
  text: '待保留摘要', sourceUpdatedAt: legacy.updated_at, revoked: false, created_at: stamp,
});
const r2 = store.migrateLegacySelfRoles(['self_2'], 'self_2');
ok('Store 迁移写入 1 篇 + 1 条摘要', r2.migratedDiaries === 1 && r2.migratedSummaries === 1);
ok('Store 迁移后留言/摘要保留',
  store.getDiary(legacy.id).aiComments[0].text === '待保留留言' &&
  store.summaries[0].text === '待保留摘要' && store.summaries[0].selfRoleId === 'self_2');
const bytesAfter = fs.readFileSync(file);
const r3 = store.migrateLegacySelfRoles(['self_2'], 'self_2');
ok('Store 二次迁移零计数且磁盘字节不变',
  r3.migratedDiaries === 0 && r3.migratedSummaries === 0 &&
  Buffer.compare(bytesAfter, fs.readFileSync(file)) === 0);

section('D. 主进程源码：严格门控 + 三个迁移时机 + 通道三端');
const main = read('electron/main.ts');
const createIdx = main.indexOf("ipcMain.handle('diary:create'");
const createSection = createIdx >= 0 ? main.slice(createIdx, createIdx + 700) : '';
ok('diary:create 调用 assertDiaryCreateSelfRole', /assertDiaryCreateSelfRole\(p\?\.selfRoleId\)/.test(createSection));
ok('diary:create 无 current?.id / || none 回退',
  !/current\?\.id/.test(createSection) && !/\|\|\s*'none'/.test(createSection));
const assertSection = main.slice(main.indexOf('function assertDiaryCreateSelfRole'), main.indexOf('function assertDiaryCreateSelfRole') + 700);
ok('断言函数抛 E_DIARY_NO_SELF_ROLE 且不回退',
  /DIARY_ERROR_NO_SELF_ROLE/.test(assertSection) && /throw e/.test(assertSection) &&
  /DIARY_LEGACY_SENTINEL/.test(assertSection));
const settingsIdx = main.indexOf("ipcMain.handle('settings:save'");
const settingsSection = main.slice(settingsIdx, settingsIdx + 900);
ok('设置变更触发迁移且只在身份字段变化时执行',
  /patch\.selfRoles !== undefined \|\| patch\.currentSelfRoleId !== undefined/.test(settingsSection) &&
  /migrateDiarySelfRoles\(true\)/.test(settingsSection));
ok('启动触发迁移（不广播）',
  /diaryStore\.init\(dm\.dataDirectory\);[\s\S]{0,300}?migrateDiarySelfRoles\(false\)/.test(main));
ok('diary:ensureMigrated handler 存在',
  /ipcMain\.handle\('diary:ensureMigrated',\s*\(\)\s*=>\s*migrateDiarySelfRoles\(true\)\)/.test(main));
ok('preload / 渲染层契约三端打通',
  /diaryEnsureMigrated: \(\) => ipcRenderer\.invoke\('diary:ensureMigrated'\)/.test(read('electron/preload.ts')) &&
  /diaryEnsureMigrated: \(\) => raw\.diaryEnsureMigrated\(\)/.test(read('src/ipc.ts')));
const diarySrc = read('electron/diary.ts');
const fnIdx = diarySrc.indexOf('export function migrateLegacyDiaries');
const fnSection = diarySrc.slice(fnIdx, diarySrc.indexOf('export class DiaryStore'));
ok('迁移函数体未调用 applyRevoke / nextTimestamp',
  fnIdx >= 0 && !/applyRevoke\s*\(/.test(fnSection) && !/nextTimestamp\s*\(/.test(fnSection));
ok('package.json 版本 >= 3.0.24（含 v3.0.25）且两个新闸门已登记',
  /"version": "3\.0\.(2[4-9]|[3-9]\d)"/.test(read('package.json')) &&
  /"verify:diary-migrate-3022"/.test(read('package.json')) &&
  /"verify:diary-ui-3022"/.test(read('package.json')));

console.log('\n' + '='.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
