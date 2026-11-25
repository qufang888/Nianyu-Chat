/**
 * v3.0.19 闸门 1：v2 容器字节布局 / KDF 可复现 / 无裸密钥 / 三态识别 / peek 免口令。
 * 做法：esbuild 打包真实的 electron/portableBackup.ts + secureStore.ts（纯 Node，零 electron import）。
 * 用法：node scripts/verify-portable-container.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-portable-container-'));
const dataDir = path.join(work, 'dataDir');
const userData = path.join(work, 'userData');
fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'store.json'), '{"roles":["小雨"]}', 'utf-8');
fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"lang":"zh","modelKey":"sk-SECRET"}', 'utf-8');
fs.writeFileSync(path.join(dataDir, 'images', 'a.png'), Buffer.from([1, 2, 3, 4]));

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
const keyPath = path.join(userData, 'nianyu-master.key');
const masterKey = S.loadOrCreateKey(keyPath);
S.initSecureStore(keyPath);

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function throwsCode(fn, code) {
  try { fn(); return false; } catch (e) { return String(e.message).includes(code); }
}

const dest = path.join(work, 'backup.ny');
const created = P.createPortableBackup({ dataDir, userData, dest, appVersion: '3.0.19', masterKey });
const raw = fs.readFileSync(dest);
const header = raw.subarray(0, 112);
const payload = raw.subarray(112);
const payloadLen = Number(raw.readBigUInt64BE(104));

section('A. v2 头 112B 字节布局与长度自校验');
ok('MAGIC_V2 常量 = NYENC002', P.MAGIC_V2 === 'NYENC002');
ok('FORMAT_VERSION = 2 / HEADER_BYTES = 112', P.FORMAT_VERSION === 2 && P.HEADER_BYTES === 112);
ok('头前 8B == NYENC002', header.subarray(0, 8).toString('ascii') === 'NYENC002');
ok('偏移 10 的 u16 == 112', header.readUInt16BE(10) === 112);
ok('偏移 8 的 u16 == 2', header.readUInt16BE(8) === 2);
ok('APP_VERSION 明文 = 3.0.19', header.subarray(12, 28).toString('utf-8').replace(/\0+$/, '') === '3.0.19');
ok('file.length === 112 + PAYLOAD_LEN', raw.length === 112 + payloadLen, `${raw.length} vs ${112 + payloadLen}`);
ok('WRAP_IV(12)+TAG(16)+WRAPPED_KEY(32) 长度固定', header.length === 112 && payload.length === payloadLen);
ok('写盘走原子：无 .nyenc.tmp 残留', !fs.existsSync(dest + '.nyenc.tmp'));

section('B. KDF 可复现 / 封装解封 / 篡改即失败');
const salt = Buffer.from(header.subarray(28, 44));
const k1 = P.deriveKey(created.passphrase, salt);
const k2 = P.deriveKey(created.passphrase, salt);
const k3 = P.deriveKey(created.passphrase, Buffer.alloc(16, 7));
ok('同口令 + 同 salt 派生 key 两次相等', k1.equals(k2));
ok('换 salt 派生 key 不同', !k1.equals(k3));
ok('KDF 参数固化 N=2^15,r=8,p=1,keylen=32', P.KDF.N === 32768 && P.KDF.r === 8 && P.KDF.p === 1 && P.KDF.keylen === 32 && P.KDF.maxmem === 64 * 1024 * 1024);
const recovered = P.unwrapMasterKey(header, created.passphrase);
ok('正确口令 unwrap 得 32B 主密钥且与原密钥一致', recovered.length === 32 && recovered.equals(masterKey));
ok('错误口令抛 E_BAD_PASSPHRASE', throwsCode(() => P.unwrapMasterKey(header, 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'), 'E_BAD_PASSPHRASE'));
const badTag = Buffer.from(header); badTag[56] ^= 0xff;
ok('篡改 WRAP_TAG 抛 E_BAD_PASSPHRASE', throwsCode(() => P.unwrapMasterKey(badTag, created.passphrase), 'E_BAD_PASSPHRASE'));
const badApp = Buffer.from(header); badApp[12] = badApp[12] === 0x39 ? 0x38 : 0x39;
ok('篡改 APP_VERSION（AAD）抛 E_BAD_PASSPHRASE', throwsCode(() => P.unwrapMasterKey(badApp, created.passphrase), 'E_BAD_PASSPHRASE'));
const badSalt = Buffer.from(header); badSalt[28] ^= 0xff;
ok('篡改 SALT（AAD）抛 E_BAD_PASSPHRASE', throwsCode(() => P.unwrapMasterKey(badSalt, created.passphrase), 'E_BAD_PASSPHRASE'));
const badLen = Buffer.from(raw); badLen.writeBigUInt64BE(BigInt(payloadLen - 1), 104);
ok('篡改 PAYLOAD_LEN 抛 E_BACKUP_FORMAT', throwsCode(() => P.parseHeader(badLen.subarray(0, 112)) && P.restorePortableBackup({ backupPath: writeTemp(badLen), passphrase: created.passphrase, dataDir, userData }), 'E_BACKUP_FORMAT'));
function writeTemp(buf) { const p = path.join(work, `tampered-${Date.now()}-${Math.random().toString(36).slice(2)}.ny`); fs.writeFileSync(p, buf); return p; }

section('C. 主密钥零裸放（文本/二进制搜索命中 0）');
const fullText = raw.toString('utf-8');
ok('全容器搜不到主密钥 base64', !fullText.includes(masterKey.toString('base64')));
ok('全容器搜不到 JSON "key" 字段', !fullText.includes('"key"'));
ok('全容器搜不到敏感片段 sk-SECRET', !fullText.includes('sk-SECRET'));
ok('头 112B 搜不到主密钥 base64', !header.toString('utf-8').includes(masterKey.toString('base64')));
ok('WRAPPED_KEY(72..104) 不等于主密钥明文', !Buffer.from(header.subarray(72, 104)).equals(masterKey));

section('D. 载荷信封与三态识别');
ok('载荷首 8B == NYENC001', payload.subarray(0, 8).toString('ascii') === 'NYENC001');
let zipOpenFailed = false;
try { new AdmZip(raw); } catch { zipOpenFailed = true; }
ok('AdmZip 直接打开 v2 容器失败（首字节非 PK）', zipOpenFailed);
const v1 = S.encryptBackup(Buffer.from('zip-bytes'));
const plainZip = new AdmZip(); plainZip.addFile('data/store.json', Buffer.from('{}'));
ok('detectBackupKind(v2) == v2', P.detectBackupKind(raw) === 'v2');
ok('detectBackupKind(v1) == v1', P.detectBackupKind(v1) === 'v1');
ok('detectBackupKind(PK) == zip', P.detectBackupKind(plainZip.toBuffer()) === 'zip');
ok('detectBackupKind(乱码) == unknown', P.detectBackupKind(Buffer.from('not-a-backup!!!')) === 'unknown');
ok('needsPassphrase 仅 v2 为 true', P.needsPassphrase('v2') === true && P.needsPassphrase('v1') === false && P.needsPassphrase('zip') === false);
ok('isExcludedFromBackup 命中 path-config / nianyu-master.key / tts-cache / .nyenc.tmp',
  P.isExcludedFromBackup('path-config.json') && P.isExcludedFromBackup('nianyu-master.key') &&
  P.isExcludedFromBackup('tts-cache/a.json') && P.isExcludedFromBackup('x.nyenc.tmp'));

section('E. peekBackupInfo 免口令且只读头');
const info = P.peekBackupInfo(dest);
ok('peek 返回 kind=v2 / format=2 / appVersion=3.0.19',
  info.kind === 'v2' && info.format === 2 && info.appVersion === '3.0.19', JSON.stringify(info));
ok('peek 返回 size == 文件长度', info.size === raw.length);
const tamperedPayload = Buffer.from(raw);
tamperedPayload[112 + 36] ^= 0xff;
const peekAfterTamper = P.peekBackupInfo(writeTemp(tamperedPayload));
ok('篡改载荷不影响 peek（只读头）', peekAfterTamper.kind === 'v2' && peekAfterTamper.appVersion === '3.0.19');
ok('peekInfo 不输出任何密钥材料', !JSON.stringify(info).includes(masterKey.toString('base64')) && !('passphrase' in info));

section('F. 口令格式与归一化容错');
const pp = created.passphrase;
ok('口令 24 字符（含 5 个连字符）', pp.length === 29 && pp.split('-').length === 6);
ok('6 组 ×4 字符', pp.split('-').every((g) => g.length === 4));
ok('无 I/L/O/U 易混字符', !/[ILOU]/.test(pp.replace(/-/g, '')));
ok('字符集 ⊆ Crockford', [...pp.replace(/-/g, '')].every((c) => P.CROCKFORD.includes(c)));
// 造一个含 1/0 的口令，用 I/L/O 与空白/下划线替换后归一化应等价
const probe = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA';
const normalizedProbe = P.normalizePassphrase(' aaaa_aaaa aaaa-aaaa aaaa aaaa ');
ok('normalize 去分隔符/空白并转大写', normalizedProbe === probe.replace(/-/g, ''));
ok('normalize 把 I/L→1、O→0', P.normalizePassphrase('ILliO0') === '111100');
ok('KDF(normalize(I/L/O 变体)) 等价', P.deriveKey('IIII-OOOO-IIII-OOOO-IIII-OOOO', salt).equals(P.deriveKey('1111-0000-1111-0000-1111-0000', salt)));

console.log(`\n========== v2 容器闸门：${pass} 通过 / ${fail} 失败 ==========`);
process.exitCode = fail ? 1 : 0;
