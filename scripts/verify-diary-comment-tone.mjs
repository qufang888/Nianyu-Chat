/**
 * v3.0.18 留言语气闸门（行为级）：高好感正情绪 warm / 低好感或负情绪 snarky|skip /
 * 中性 neutral / 后缀贴合人设且不出戏 / 名单外角色留言数 0。
 * 用法：node scripts/verify-diary-comment-tone.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-tone-'));
const outfile = path.join(work, 'tone.mjs');
await build({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(ROOT, 'electron/diaryTone.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'electron/diary.ts'))};
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
const T = await import(pathToFileURL(outfile).href + '?v=' + Date.now());
T.secure.initSecureStore(path.join(work, 'nianyu-master.key'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

section('A. 语气分类真值表');
ok('(82, 开心) → warm', T.classifyDiaryCommentTone(82, '开心') === 'warm');
ok('(75, 心动) → warm', T.classifyDiaryCommentTone(75, '心动') === 'warm');
ok('(25, 生气) → snarky 或 skip', ['snarky', 'skip'].includes(T.classifyDiaryCommentTone(25, '生气')));
ok('(80, 难过) → snarky', T.classifyDiaryCommentTone(80, '难过') === 'snarky');
ok('(35, 平静) → neutral', T.classifyDiaryCommentTone(35, '平静') === 'neutral');
ok('(50, 平静) → neutral', T.classifyDiaryCommentTone(50, '平静') === 'neutral');

section('B. 人设后缀');
const warm = T.buildDiaryCommentSuffix('warm');
const snarky = T.buildDiaryCommentSuffix('snarky');
const neutral = T.buildDiaryCommentSuffix('neutral');
ok('后缀要求以该角色身份', [warm, snarky, neutral].every((s) => s.includes('以该角色身份')));
ok('warm 后缀含温暖', warm.includes('温暖'));
ok('snarky 后缀含带刺或允许空行', snarky.includes('带刺') || snarky.includes('空行'));
const outOfCharacter = ['AI', '语言模型', '系统指令'];
ok('后缀不出戏（无 AI / 模型 / 系统指令）',
  [warm, snarky, neutral].every((s) => !outOfCharacter.some((w) => s.includes(w))));

section('C. 名单外角色留言数 0');
const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });
T.resetDiaryStore();
const store = T.getDiaryStore();
store.init(dataDir);
const d = store.createDiary({ selfRoleId: 'none', date: '2026-11-20', content: '今天很开心' });
store.updateDiary(d.id, { allowAi: true, visibleRoleIds: ['A'] });
const plan = T.planDiaryAiWork(store.getDiary(d.id), [
  { id: 'A', affinity: 82, mood: '开心' },
  { id: 'B', affinity: 82, mood: '开心' },
]);
ok('仅可见角色进入生成计划', plan.length === 1 && plan[0].roleId === 'A' && plan[0].tone === 'warm', JSON.stringify(plan));
ok('名单外角色生成数为 0', plan.filter((p) => p.roleId === 'B').length === 0);

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} 留言语气闸门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
