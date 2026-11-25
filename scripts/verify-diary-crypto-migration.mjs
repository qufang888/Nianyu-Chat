/**
 * v3.0.18 加密迁移闸门（行为级）：明文→密文、幂等、篡改/错密钥失败、失败保留原文、写入口收敛。
 * 做法：用 esbuild 把**真实的** electron/secureStore.ts 转译执行（纯模块，零 electron import）。
 * 用法：node scripts/verify-diary-crypto-migration.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-crypto-'));
const outfile = path.join(work, 'secureStore.mjs');
await build({
  entryPoints: [path.join(ROOT, 'electron/secureStore.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  logLevel: 'silent',
});
const S = await import(pathToFileURL(outfile).href + '?v=' + Date.now());

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const keyPath = path.join(work, 'userData', 'nianyu-master.key');
S.initSecureStore(keyPath);
const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });

section('A. 明文 → 密文与幂等');
const storeFile = path.join(dataDir, 'store.json');
fs.writeFileSync(storeFile, JSON.stringify({ roles: [{ id: 'r1', name: '小雨' }], messages: [] }, null, 2), 'utf-8');
const before = fs.readFileSync(storeFile);
const r1 = S.migratePlaintextFiles([storeFile]);
const after = fs.readFileSync(storeFile);
ok('迁移返回 encrypted 含该文件', r1.encrypted.includes(storeFile), JSON.stringify(r1));
ok('密文首 8 字节为 NYENC001', after.subarray(0, 8).toString('ascii') === 'NYENC001');
let parseFailed = false;
try { JSON.parse(after.toString('utf-8')); } catch { parseFailed = true; }
ok('密文不能用 JSON.parse 直接读取', parseFailed);
ok('迁移后字节已变化', !before.equals(after));
const r2 = S.migratePlaintextFiles([storeFile]);
ok('第二次迁移 skipped（幂等）', r2.skipped.includes(storeFile) && r2.encrypted.length === 0, JSON.stringify(r2));
ok('幂等后字节不变', fs.readFileSync(storeFile).equals(after));

section('B. 篡改 / 错密钥 / IV 随机');
let tamperErr = '';
try {
  const bad = Buffer.from(after);
  bad[bad.length - 1] ^= 0x01;
  S.decryptBuffer(bad);
} catch (e) { tamperErr = e.message || String(e); }
ok('篡改密文抛 E_DECRYPT_FAILED', tamperErr.includes('E_DECRYPT_FAILED'), tamperErr);
let wrongErr = '';
try { S.decryptBuffer(after, Buffer.alloc(32, 7)); } catch (e) { wrongErr = e.message || String(e); }
ok('错密钥抛 E_DECRYPT_FAILED', wrongErr.includes('E_DECRYPT_FAILED'), wrongErr);
const key = S.loadOrCreateKey(keyPath);
const c1 = S.encryptBuffer(Buffer.from('同一明文'), key);
const c2 = S.encryptBuffer(Buffer.from('同一明文'), key);
ok('同明文两次加密字节不同（IV 随机）', !c1.equals(c2));
ok('两次密文均可正确解密', S.decryptBuffer(c1, key).toString('utf-8') === '同一明文' && S.decryptBuffer(c2, key).toString('utf-8') === '同一明文');

section('C. 注入失败：保留原文 / 密钥损坏');
const broken = path.join(dataDir, 'broken.json');
fs.mkdirSync(broken, { recursive: true }); // 目录冒充 .json：读取必失败，原对象不变
const beforeBroken = createHash('sha256').update(fs.readdirSync(broken).join('|')).digest('hex');
const r3 = S.migratePlaintextFiles([storeFile, broken], key);
ok('失败文件进 failed[] 且不影响成功项', r3.failed.includes(broken) && r3.encrypted.length === 0, JSON.stringify(r3));
ok('失败对象保持原样（未清空/未改写）', fs.existsSync(broken) &&
  createHash('sha256').update(fs.readdirSync(broken).join('|')).digest('hex') === beforeBroken);
const badKeyPath = path.join(work, 'bad-key', 'nianyu-master.key');
fs.mkdirSync(path.dirname(badKeyPath), { recursive: true });
fs.writeFileSync(badKeyPath, '{"v":1,"alg":"aes-256-gcm","key":"broken"}', 'utf-8');
S.initSecureStore(badKeyPath);
const r4 = S.migratePlaintextFiles([storeFile]);
ok('密钥损坏 → failed 且不改密文', r4.failed.includes(storeFile) && fs.readFileSync(storeFile).equals(after), JSON.stringify(r4));
ok('密钥损坏 → status=failed', S.getEncryptionStatus().status === 'failed');

section('D. 写入口收敛（源码强断言）');
const dbSrc = fs.readFileSync(path.join(ROOT, 'electron/db.ts'), 'utf-8');
const directWrites = dbSrc.match(/writeFileSync\([^;)]*(storePath|settingsPath|errorLogPath)[^;)]*JSON\.stringify/g) || [];
ok('db.ts 直接 writeFileSync JSON 计数 0', directWrites.length === 0, String(directWrites.length));
ok('db.ts 已收敛到 secureStore.writeText/readText',
  /writeText\(this\.(storePath|settingsPath|errorLogPath)/.test(dbSrc) && /readText\(this\.(storePath|settingsPath|errorLogPath)/.test(dbSrc));

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} 加密迁移闸门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
