/**
 * v3.0.18 备份双兼容闸门（行为级）：旧明文 zip 可恢复 / 新容器不可解压且不含密钥 /
 * 新容器可恢复 / peekVersion 双读 / 无密钥拒绝且不清空数据。
 * 做法：esbuild 打包**真实的** electron/backup.ts（electron 只打一个 app 桩），直接执行真函数。
 * 用法：node scripts/verify-diary-backup-compat.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-backup-'));
const keyDir = path.join(work, 'userData');
fs.mkdirSync(keyDir, { recursive: true });
process.env.NY_KEYDIR = keyDir;
const stub = path.join(work, 'electron-stub.mjs');
fs.writeFileSync(stub, 'export const app = { getPath: () => process.env.NY_KEYDIR, getVersion: () => "3.0.18" };\n', 'utf-8');

const outfile = path.join(work, 'backup.mjs');
await build({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(ROOT, 'electron/backup.ts'))};
export * as secure from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
    loader: 'ts',
    resolveDir: ROOT,
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  // adm-zip 是 CJS 且内部 dynamic require('fs')：给打包产物提供 Node 的 require 桥。
  banner: {
    js: `import { createRequire as __nyCreateRequire } from 'node:module'; const require = __nyCreateRequire(import.meta.url);`,
  },
  plugins: [{
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: stub }));
    },
  }],
  logLevel: 'silent',
});
const B = await import(pathToFileURL(outfile).href + '?v=' + Date.now());
const S = B.secure;
S.initSecureStore(path.join(keyDir, 'nianyu-master.key'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const srcDir = path.join(work, 'src-data');
fs.mkdirSync(path.join(srcDir, 'images'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'store.json'), JSON.stringify({ roles: [{ id: 'a', name: '小雨' }], messages: [{ id: 1, content: '你好' }] }, null, 2), 'utf-8');
fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({ lang: 'zh' }, null, 2), 'utf-8');
fs.writeFileSync(path.join(srcDir, 'images', 'a.png'), Buffer.from([1, 2, 3, 4]));

section('0. 需求落地全链路（防「只改 backup.ts 漏掉调用链」）');
const fullChain = [
  ['electron/backup.ts', [/BACKUP_EXTENSION\s*=\s*'\.ny'/, /export function convertLegacyBackup/]],
  ['electron/main.ts', [/NianyuBackup_v[\s\S]{0,260}\$\{BACKUP_EXTENSION\}/, /ipcMain\.handle\('backup:convertLegacy'/]],
  ['electron/dialogBridge.ts', [/extensions:\s*\[[^\]]*'ny'[^\]]*'zip'/, /nianyu-backup\.ny/]],
  ['electron/preload.ts', [/convertLegacyBackup:\s*\(zipPath\)/]],
  ['src/ipc.ts', [/convertLegacyBackup:\s*\(zipPath\)/]],
  ['src/components/Settings.tsx', [/api\.convertLegacyBackup\(zip\)/]],
  ['electron/secureStore.ts', [/export function readBinary/, /export function writeBinary/]],
  ['src/i18n/translations.ts', [/settings\.backupConvertBtn/]],
];
for (const [file, patterns] of fullChain) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const missing = patterns.filter((re) => !re.test(src));
  ok(`${file} 含全部必需落地`, missing.length === 0, missing.map(String).join(' | '));
}

section('A. 旧明文 zip 仍可恢复');
const oldZip = path.join(work, 'old.zip');
const zip = new AdmZip();
zip.addFile('data/store.json', fs.readFileSync(path.join(srcDir, 'store.json')));
zip.addFile('data/settings.json', fs.readFileSync(path.join(srcDir, 'settings.json')));
zip.addFile('_backup_meta.json', Buffer.from(JSON.stringify({ appVersion: '3.0.17' })));
zip.writeZip(oldZip);
const restoredOld = path.join(work, 'restored-old');
fs.mkdirSync(restoredOld, { recursive: true });
B.restoreBackup(oldZip, restoredOld);
ok('旧 zip 还原 store.json 逐字节一致', fs.readFileSync(path.join(restoredOld, 'store.json')).equals(fs.readFileSync(path.join(srcDir, 'store.json'))));
ok('旧 zip 还原 settings.json 逐字节一致', fs.readFileSync(path.join(restoredOld, 'settings.json')).equals(fs.readFileSync(path.join(srcDir, 'settings.json'))));
ok('旧 zip 版本号可读', B.peekBackupVersion(oldZip) === '3.0.17');

section('B. 新容器：.ny 后缀 / 首字节非 PK / 通用解压失败 / 不含密钥');
const newPack = path.join(work, `new${B.BACKUP_EXTENSION}`);
ok('BACKUP_EXTENSION 为 .ny', B.BACKUP_EXTENSION === '.ny');
ok('新备份路径以 .ny 结尾', newPack.endsWith('.ny'));
B.createBackup(srcDir, newPack, '3.0.18');
const packed = fs.readFileSync(newPack);
ok('新备份首字节为 N（NYENC001 魔数）', packed[0] === 0x4e && packed.subarray(0, 8).toString('ascii') === 'NYENC001');
ok('新备份首字节不是 PK', !(packed[0] === 0x50 && packed[1] === 0x4b));
let admErr = '';
try { new AdmZip(newPack).getEntries(); } catch (e) { admErr = e.message || String(e); }
ok('AdmZip 直接打开新备份失败', !!admErr, admErr);
const payload = S.decryptBackup(packed);
const inner = new AdmZip(payload);
const names = inner.getEntries().map((e) => e.entryName);
ok('解密后 zip 可读且含 _backup_meta.json', names.includes('_backup_meta.json'), names.join(','));
ok('解密后 zip 含 data/store.json', names.includes('data/store.json'), names.join(','));
ok('包内绝不含 nianyu-master.key', !names.some((n) => n.includes('nianyu-master.key')), names.join(','));
ok('新容器版本号可读', B.peekBackupVersion(newPack) === '3.0.18');

section('C. 旧 ZIP 转换器');
const oldSha = createHash('sha256').update(fs.readFileSync(oldZip)).digest('hex');
const converted = B.convertLegacyBackup(oldZip);
ok('转换产物后缀为 .ny 且带 _converted', converted.endsWith('_converted.ny') && fs.existsSync(converted));
const convertedBuf = fs.readFileSync(converted);
ok('转换产物首字节 N 而非 PK', convertedBuf[0] === 0x4e && !(convertedBuf[0] === 0x50 && convertedBuf[1] === 0x4b));
ok('原 ZIP 字节未被修改', createHash('sha256').update(fs.readFileSync(oldZip)).digest('hex') === oldSha);
let convertedAdmErr = '';
try { new AdmZip(converted).getEntries(); } catch (e) { convertedAdmErr = e.message || String(e); }
ok('转换产物通用解压打不开', !!convertedAdmErr);
ok('转换产物版本可预览', B.peekBackupVersion(converted) === '3.0.17');
const restoredConverted = path.join(work, 'restored-converted');
fs.mkdirSync(restoredConverted, { recursive: true });
B.restoreBackup(converted, restoredConverted);
ok('转换产物可还原且数据一致',
  fs.readFileSync(path.join(restoredConverted, 'store.json')).equals(fs.readFileSync(path.join(restoredOld, 'store.json'))));
let alreadyErr = '';
try { B.convertLegacyBackup(converted); } catch (e) { alreadyErr = e.message || String(e); }
ok('已转换的 .ny 再次转换被拒绝', alreadyErr.includes('E_ALREADY_CONVERTED'));
const bridge = fs.readFileSync(path.join(ROOT, 'electron/dialogBridge.ts'), 'utf-8');
const pickTarget = bridge.slice(bridge.indexOf("ipcMain.handle('backup:pickTarget'"), bridge.indexOf("ipcMain.handle('backup:pickDir'"));
const pickFile = bridge.slice(bridge.indexOf("ipcMain.handle('backup:pickFile'"), bridge.indexOf("ipcMain.handle('data:pickDir'"));
ok('保存对话框过滤器含 ny', /extensions:\s*\[[^\]]*'ny'/.test(pickTarget));
ok('恢复/预览对话框过滤器同时含 ny 与 zip',
  /extensions:\s*\[[^\]]*'ny'[^\]]*'zip'/.test(pickFile));
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf-8');
ok('一键导出默认名使用 .ny', /NianyuBackup_v\$\{app\.getVersion\(\)\}[\s\S]{0,260}\$\{BACKUP_EXTENSION\}/.test(mainSrc));
ok('backup:convertLegacy 已注册', /ipcMain\.handle\('backup:convertLegacy'/.test(mainSrc));

section('D. 新容器可恢复 / 无密钥拒绝');
const restoredNew = path.join(work, 'restored-new');
fs.mkdirSync(restoredNew, { recursive: true });
B.restoreBackup(newPack, restoredNew);
ok('新容器还原后文件树逐字节一致',
  fs.readFileSync(path.join(restoredNew, 'store.json')).equals(fs.readFileSync(path.join(srcDir, 'store.json'))) &&
  fs.readFileSync(path.join(restoredNew, 'images/a.png')).equals(fs.readFileSync(path.join(srcDir, 'images/a.png'))));
const noKeyTarget = path.join(work, 'no-key-target');
fs.mkdirSync(noKeyTarget, { recursive: true });
fs.writeFileSync(path.join(noKeyTarget, 'sentinel.txt'), 'keep-me', 'utf-8');
S.initSecureStore(path.join(work, 'missing-userdata', 'nianyu-master.key'));
let keyErr = '';
try { B.restoreBackup(newPack, noKeyTarget); } catch (e) { keyErr = e.message || String(e); }
ok('无密钥恢复新包抛 E_KEY_MISSING', keyErr.includes('E_KEY_MISSING'), keyErr);
ok('无密钥时目标 dataDir 未被清空', fs.existsSync(path.join(noKeyTarget, 'sentinel.txt')) &&
  fs.readFileSync(path.join(noKeyTarget, 'sentinel.txt'), 'utf-8') === 'keep-me');
ok('无密钥时 peekBackupVersion 返回 null', B.peekBackupVersion(newPack) === null);

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} 备份兼容闸门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
