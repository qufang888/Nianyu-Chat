/**
 * v3.0.19 闸门 2：全量清单齐备 / 排除项 0 命中 / 主密钥采纳 /
 * 错口令·篡改·结构缺失零写入 / 注入失败逆序回滚 / 成功清理安全备份。
 * 用法：node scripts/verify-portable-restore-atomic.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-portable-restore-'));
const outfile = path.join(work, 'portable.mjs');
await build({
  stdin: {
    contents:
      `export * from ${JSON.stringify(path.join(ROOT, 'electron/portableBackup.ts'))};\n` +
      `export * as S from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
    loader: 'ts',
    resolveDir: ROOT,
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  banner: { js: `import { createRequire as __nyCreateRequire } from 'node:module'; const require = __nyCreateRequire(import.meta.url);` },
  logLevel: 'silent',
});
const P = await import(pathToFileURL(outfile).href + '?v=' + Date.now());
const S = P.S;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }
function snap(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out[r] = sha(fs.readFileSync(p));
    }
  };
  walk(root);
  return out;
}
function sameTree(label, a, b) {
  const sa = JSON.stringify(snap(a));
  const sb = JSON.stringify(snap(b));
  ok(label, sa === sb, sa === sb ? '' : `\n A=${sa}\n B=${sb}`);
}
function leftovers(parent) {
  return fs.existsSync(parent)
    ? fs.readdirSync(parent).filter((n) => n.startsWith('_restore_old_') || n.startsWith('_restore_tmp_'))
    : [];
}
function throwsCode(fn, code) {
  try { fn(); return false; } catch (e) { return String(e.message).includes(code); }
}

// ===== A 机样本：dataDir 全量 + userData 五项 + 排除项 =====
const A = path.join(work, 'A');
const Ad = path.join(A, 'dataDir');
const Au = path.join(A, 'userData');
fs.mkdirSync(path.join(Ad, 'images'), { recursive: true });
fs.mkdirSync(path.join(Ad, 'tts-cache'), { recursive: true });
fs.mkdirSync(path.join(Au, 'custom-sounds'), { recursive: true });
fs.mkdirSync(path.join(Au, 'character-runtime'), { recursive: true });
fs.mkdirSync(path.join(Au, 'skills'), { recursive: true });
const settingsText = '{"lang":"zh","models":[{"id":"m1","apiKey":"sk-SECRET-A"}]}';
fs.writeFileSync(path.join(Ad, 'settings.json'), settingsText, 'utf-8');
fs.writeFileSync(path.join(Ad, 'store.json'), '{"roles":[{"id":"r1","name":"小雨"}],"messages":[{"id":1,"text":"你好"}]}', 'utf-8');
fs.writeFileSync(path.join(Ad, 'errors.json'), '[]', 'utf-8');
fs.writeFileSync(path.join(Ad, 'images', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
fs.writeFileSync(path.join(Ad, 'tts-cache', 'cache.bin'), 'DERIVED-CACHE', 'utf-8');
fs.writeFileSync(path.join(Ad, 'stale.nyenc.tmp'), 'HALF-WRITE', 'utf-8');
S.initSecureStore(path.join(Au, 'nianyu-master.key'));
const Akey = S.loadOrCreateKey(path.join(Au, 'nianyu-master.key'));
S.writeText(path.join(Ad, 'settings.json'), settingsText, Akey); // 真实场景：settings 用 A 机主密钥加密落盘
fs.writeFileSync(path.join(Au, 'skills.json'), '[{"id":"s1","name":"写作助手"}]', 'utf-8');
fs.writeFileSync(path.join(Au, 'skills', 'SKILL.md'), '# 写作助手', 'utf-8');
fs.writeFileSync(path.join(Au, 'proactive-nhpp.json'), '{"enabled":true,"lambda":0.2}', 'utf-8');
fs.writeFileSync(path.join(Au, 'custom-sounds', 'ding.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x64]));
fs.writeFileSync(path.join(Au, 'character-runtime', 'runtime.json'), '{"pose":"smile"}', 'utf-8');
fs.writeFileSync(path.join(Au, 'path-config.json'), '{"dataDir":"A机路径"}', 'utf-8');
fs.writeFileSync(path.join(Au, 'custom-data-path.txt'), 'A机路径\n', 'utf-8');
fs.writeFileSync(path.join(Au, 'nianyu-master.key'), JSON.stringify({ v: 1, alg: 'aes-256-gcm', key: Akey.toString('base64') }), 'utf-8');

const backupPath = path.join(work, 'full.ny');
const created = P.createPortableBackup({ dataDir: Ad, userData: Au, dest: backupPath, appVersion: '3.0.19', masterKey: Akey });
const container = fs.readFileSync(backupPath);
const plainZip = S.decryptBackup(container.subarray(112), Akey);
const zip = new AdmZip(plainZip);

section('A. 全量清单齐备 + 排除项 0 命中');
const names = zip.getEntries().map((e) => e.entryName);
const mustHave = [
  'data/store.json', 'data/settings.json', 'data/errors.json', 'data/images/a.png',
  'userdata/skills.json', 'userdata/skills/SKILL.md', 'userdata/proactive-nhpp.json',
  'userdata/custom-sounds/ding.mp3', 'userdata/character-runtime/runtime.json',
  '_backup_meta.json',
];
for (const n of mustHave) ok(`包内包含 ${n}`, names.includes(n));
for (const bad of ['path-config.json', 'custom-data-path.txt', 'nianyu-master.key']) {
  ok(`包内不含 ${bad}`, !names.some((n) => n.includes(bad)));
}
ok('包内不含 tts-cache/**', !names.some((n) => n.includes('tts-cache')));
ok('包内不含 .nyenc.tmp', !names.some((n) => n.endsWith('.nyenc.tmp')));
const meta = JSON.parse(zip.readAsText(zip.getEntry('_backup_meta.json')));
ok('meta.format = 2 且 sources 含 5 类 key', meta.format === 2 &&
  ['data', 'skills', 'proactive', 'sounds', 'runtime'].every((k) => meta.sources.some((s) => s.key === k)));
ok('meta 不含口令', !JSON.stringify(meta).includes(created.passphrase));

section('B. 跨机全量逐字节一致 + 主密钥采纳');
function makeB(label) {
  const root = path.join(work, label);
  const d = path.join(root, 'dataDir');
  const u = path.join(root, 'userData');
  fs.mkdirSync(path.join(d, 'images'), { recursive: true });
  fs.mkdirSync(u, { recursive: true });
  fs.writeFileSync(path.join(d, 'store.json'), 'B-OLD', 'utf-8');
  fs.writeFileSync(path.join(d, 'images', 'old.png'), 'B-OLD-IMG', 'utf-8');
  fs.writeFileSync(path.join(u, 'skills.json'), 'B-OLD-SKILL', 'utf-8');
  fs.writeFileSync(path.join(u, 'proactive-nhpp.json'), 'B-OLD-NHPP', 'utf-8');
  fs.mkdirSync(path.join(u, 'custom-sounds'), { recursive: true });
  fs.mkdirSync(path.join(u, 'character-runtime'), { recursive: true });
  fs.writeFileSync(path.join(u, 'custom-sounds', 'old.mp3'), 'B-OLD-SOUND', 'utf-8');
  fs.writeFileSync(path.join(u, 'character-runtime', 'old.json'), 'B-OLD-RT', 'utf-8');
  const bkey = S.loadOrCreateKey(path.join(u, 'nianyu-master.key'));
  fs.writeFileSync(path.join(u, 'path-config.json'), '{"dataDir":"B机路径"}', 'utf-8');
  return { root, d, u, bkey };
}
const B = makeB('B-success');
const beforeB = snap(B.root);
P.restorePortableBackup({ backupPath, passphrase: created.passphrase, dataDir: B.d, userData: B.u });
// 排除项（tts-cache / .nyenc.tmp）本就不进包，比对时从 A 快照剔除
const aDataFiltered = Object.fromEntries(
  Object.entries(snap(Ad)).filter(([rel]) => !rel.includes('tts-cache') && !rel.endsWith('.nyenc.tmp'))
);
const bData = snap(path.join(B.root, 'dataDir'));
ok('B 机 dataDir 与 A 机逐字节一致（排除项除外）', JSON.stringify(bData) === JSON.stringify(aDataFiltered),
  JSON.stringify(bData) === JSON.stringify(aDataFiltered) ? '' : `\n A=${JSON.stringify(aDataFiltered)}\n B=${JSON.stringify(bData)}`);
ok('B 机 skills.json 与 A 机逐字节一致', sha(fs.readFileSync(path.join(B.u, 'skills.json'))) === sha(fs.readFileSync(path.join(Au, 'skills.json'))));
ok('B 机 skills/ 与 A 机逐字节一致', sha(fs.readFileSync(path.join(B.u, 'skills', 'SKILL.md'))) === sha(fs.readFileSync(path.join(Au, 'skills', 'SKILL.md'))));
ok('B 机 proactive-nhpp.json 一致', sha(fs.readFileSync(path.join(B.u, 'proactive-nhpp.json'))) === sha(fs.readFileSync(path.join(Au, 'proactive-nhpp.json'))));
ok('B 机 custom-sounds/ 一致', sha(fs.readFileSync(path.join(B.u, 'custom-sounds', 'ding.mp3'))) === sha(fs.readFileSync(path.join(Au, 'custom-sounds', 'ding.mp3'))));
ok('B 机 character-runtime/ 一致', sha(fs.readFileSync(path.join(B.u, 'character-runtime', 'runtime.json'))) === sha(fs.readFileSync(path.join(Au, 'character-runtime', 'runtime.json'))));
const adopted = JSON.parse(fs.readFileSync(path.join(B.u, 'nianyu-master.key'), 'utf-8'));
ok('主密钥被采纳为新机 key（与 A 机一致）', adopted.key === Akey.toString('base64'));
ok('采纳后加密的 settings.json 可用 A 机密钥读出原文', S.readText(path.join(B.d, 'settings.json'), Akey) === settingsText);
ok('B 机本地 path-config.json 未被备份覆盖', fs.readFileSync(path.join(B.u, 'path-config.json'), 'utf-8') === '{"dataDir":"B机路径"}');
ok('成功后无 _restore_old_* / _restore_tmp_* 残留', leftovers(B.root).length === 0, leftovers(B.root).join(','));
ok('B 机旧数据已被替换（非原样保留）', JSON.stringify(snap(B.root)) !== JSON.stringify(beforeB));

section('C. 失败四类：替换前抛出、零写入、无安全备份残留');
const h = P.parseHeader(container.subarray(0, 112));
const salt = h.salt;
function rebuild(badZipBuf) {
  const p = S.encryptBackup(badZipBuf, Akey);
  const hdr = P.buildHeader('3.0.19', salt, { salt, iv: h.wrapIv, tag: h.wrapTag, ciphertext: h.wrappedKey }, p.length);
  const out = path.join(work, `crafted-${Date.now()}-${Math.random().toString(36).slice(2)}.ny`);
  fs.writeFileSync(out, Buffer.concat([hdr, p]));
  return out;
}
const zipNoStore = new AdmZip(plainZip);
zipNoStore.deleteFile('data/store.json');
zipNoStore.deleteFile('data/settings.json');
const noStoreBackup = rebuild(zipNoStore.toBuffer());
const badTag = Buffer.from(container); badTag[56] ^= 0xff;
const badTagPath = path.join(work, 'bad-tag.ny'); fs.writeFileSync(badTagPath, badTag);
const badPayload = Buffer.from(container); badPayload[112 + 36] ^= 0xff;
const badPayloadPath = path.join(work, 'bad-payload.ny'); fs.writeFileSync(badPayloadPath, badPayload);
const cases = [
  ['错口令', backupPath, 'WRONG-WRONG-WRONG-WRONG-WRONG-WRONG', 'E_BAD_PASSPHRASE'],
  ['篡改头 WRAP_TAG', badTagPath, created.passphrase, 'E_BAD_PASSPHRASE'],
  ['篡改载荷密文', badPayloadPath, created.passphrase, 'E_DECRYPT_FAILED'],
  ['结构缺失 store/settings', noStoreBackup, created.passphrase, 'E_ZIP_INVALID'],
];
for (const [label, bp, pp, code] of cases) {
  const Bx = makeB('B-fail-' + label.replace(/[^a-zA-Z0-9]/g, '') + '-' + Math.random().toString(36).slice(2, 5));
  const before = JSON.stringify(snap(Bx.root));
  const threw = throwsCode(() => P.restorePortableBackup({ backupPath: bp, passphrase: pp, dataDir: Bx.d, userData: Bx.u }), code);
  ok(`${label}：阶段 0 抛 ${code}`, threw);
  ok(`${label}：目标目录字节未变`, JSON.stringify(snap(Bx.root)) === before);
  ok(`${label}：无 _restore_old_* 残留`, leftovers(Bx.root).filter((n) => n.startsWith('_restore_old_')).length === 0);
  ok(`${label}：主密钥未被替换`, JSON.parse(fs.readFileSync(path.join(Bx.u, 'nianyu-master.key'), 'utf-8')).key === Bx.bkey.toString('base64'));
}

section('D. 注入第 1/3/5 步失败：逆序回滚到前态');
for (const at of [1, 3, 5]) {
  const Bx = makeB(`B-inject-${at}`);
  const before = JSON.stringify(snap(Bx.root));
  const threw = throwsCode(
    () => P.restorePortableBackup({ backupPath, passphrase: created.passphrase, dataDir: Bx.d, userData: Bx.u, failAt: at }),
    'E_RESTORE_FAILED'
  );
  ok(`注入第 ${at} 步抛 E_RESTORE_FAILED`, threw);
  ok(`注入第 ${at} 步：所有目标回滚到前态`, JSON.stringify(snap(Bx.root)) === before);
  ok(`注入第 ${at} 步：无安全备份 / 临时目录残留`, leftovers(Bx.root).length === 0);
  ok(`注入第 ${at} 步：主密钥未采纳`, JSON.parse(fs.readFileSync(path.join(Bx.u, 'nianyu-master.key'), 'utf-8')).key === Bx.bkey.toString('base64'));
}

section('E. 源码不变量');
const pbSrc = fs.readFileSync(path.join(ROOT, 'electron/portableBackup.ts'), 'utf-8');
const ssSrc = fs.readFileSync(path.join(ROOT, 'electron/secureStore.ts'), 'utf-8');
ok('内核不 import electron（纯 Node）', !/from\s+['"]electron['"]/.test(pbSrc));
ok('含两阶段 + 逆序回滚标识', /backupOlds\(\)/.test(pbSrc) && /replaceAll\(\)/.test(pbSrc) && /rollback\(\)/.test(pbSrc) && /commit\(\)/.test(pbSrc));
ok('采纳主密钥后 resetKeyCache', /resetKeyCache\(\)/.test(pbSrc) && /export function resetKeyCache/.test(ssSrc));
ok('内核不含 app.relaunch（重启由 main.ts 成功路径独占）', !/relaunch/.test(pbSrc));

console.log(`\n========== 原子还原闸门：${pass} 通过 / ${fail} 失败 ==========`);
process.exitCode = fail ? 1 : 0;
