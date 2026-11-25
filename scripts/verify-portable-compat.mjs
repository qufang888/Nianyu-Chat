/**
 * v3.0.19 闸门 3：四态兼容矩阵（v2 / v1 同机 / v1 跨机无密钥 / 旧 zip / 转换器产 v1）
 * + IPC 落地 + 双窗拖拽门控 + 原生弹窗为 0 + 文档口径同步。
 * 用法：node scripts/verify-portable-compat.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-portable-compat-'));
const keyDir = path.join(work, 'userData');
fs.mkdirSync(keyDir, { recursive: true });
process.env.NY_KEYDIR = keyDir;
const stub = path.join(work, 'electron-stub.mjs');
fs.writeFileSync(stub, 'export const app = { getPath: () => process.env.NY_KEYDIR, getVersion: () => "3.0.19" };\n', 'utf-8');

const outfile = path.join(work, 'backup.mjs');
await build({
  stdin: {
    contents:
      `export * from ${JSON.stringify(path.join(ROOT, 'electron/backup.ts'))};\n` +
      `export * as P from ${JSON.stringify(path.join(ROOT, 'electron/portableBackup.ts'))};\n` +
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
  plugins: [{ name: 'electron-stub', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: stub })); } }],
  logLevel: 'silent',
});
const B = await import(pathToFileURL(outfile).href + '?v=' + Date.now());
const P = B.P;
const S = B.S;
const keyPath = path.join(keyDir, 'nianyu-master.key');
S.initSecureStore(keyPath);
const masterKey = S.loadOrCreateKey(keyPath);

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function sha(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function throwsCode(fn, code) {
  try { fn(); return false; } catch (e) { return String(e.message).includes(code); }
}
function makeData(root) {
  const d = path.join(root, 'dataDir');
  fs.mkdirSync(path.join(d, 'images'), { recursive: true });
  fs.writeFileSync(path.join(d, 'store.json'), '{"roles":["兼容测试"]}', 'utf-8');
  fs.writeFileSync(path.join(d, 'settings.json'), '{"lang":"zh"}', 'utf-8');
  fs.writeFileSync(path.join(d, 'images', 'a.png'), Buffer.from([1, 2, 3]));
  return d;
}

const src = makeData(path.join(work, 'A'));
const target = path.join(work, 'target');
fs.mkdirSync(target, { recursive: true });

section('A. v2 容器：魔数 / peek / 口令门控');
fs.mkdirSync(path.join(keyDir, 'custom-sounds'), { recursive: true });
fs.writeFileSync(path.join(keyDir, 'skills.json'), '[{"id":"s1"}]', 'utf-8');
const v2 = B.createPortableBackup(src, path.join(work, 'v2.ny'), '3.0.19');
ok('v2 create 返回非空一次性口令', !!v2.passphrase && v2.passphrase.split('-').length === 6);
ok('v2 产物识别为 v2', P.detectBackupKind(fs.readFileSync(v2.path)) === 'v2');
const peek2 = B.peekBackupInfo(v2.path);
ok('v2 peek 免口令返回 appVersion=3.0.19', peek2.kind === 'v2' && peek2.appVersion === '3.0.19');
ok('v2 需要口令，v1/zip/unknown 不需要', P.needsPassphrase('v2') && !P.needsPassphrase('v1') && !P.needsPassphrase('zip') && !P.needsPassphrase('unknown'));
ok('isPortableBackupFile 仅认 .ny 且大小写不敏感',
  P.isPortableBackupFile('a.ny') && P.isPortableBackupFile('A.NY') && !P.isPortableBackupFile('a.zip') && !P.isPortableBackupFile('a.vrm'));

section('B. v1 同机旧路径零回退');
const v1 = path.join(work, 'v1.ny');
B.createBackup(src, v1, '3.0.18');
ok('v1 产物魔数 NYENC001', fs.readFileSync(v1).subarray(0, 8).toString('ascii') === 'NYENC001');
ok('v1 peekVersion 返回 3.0.18', B.peekBackupVersion(v1) === '3.0.18');
B.restoreBackup(v1, target);
ok('v1 同机还原成功且 dataDir 内容一致',
  fs.readFileSync(path.join(target, 'store.json'), 'utf-8') === fs.readFileSync(path.join(src, 'store.json'), 'utf-8'));

section('C. v1 跨机无密钥：E_KEY_MISSING 且零写入');
const crossTarget = path.join(work, 'cross-target');
fs.mkdirSync(crossTarget, { recursive: true });
fs.writeFileSync(path.join(crossTarget, 'store.json'), 'KEEP-ME', 'utf-8');
const beforeCross = sha(path.join(crossTarget, 'store.json'));
S.resetKeyCache();
S.initSecureStore(path.join(work, 'no-key-dir', 'nianyu-master.key'));
const crossThrew = throwsCode(() => B.restoreBackup(v1, crossTarget), 'E_KEY_MISSING');
ok('v1 跨机无密钥抛 E_KEY_MISSING', crossThrew);
ok('v1 跨机失败时旧数据零写入', sha(path.join(crossTarget, 'store.json')) === beforeCross);
S.resetKeyCache();
S.initSecureStore(keyPath); // 恢复后续测试的密钥上下文

section('D. 旧明文 zip 直接还原');
const oldZip = path.join(work, 'old.zip');
const oz = new AdmZip();
oz.addFile('data/store.json', Buffer.from('{"legacy":true}'));
oz.addFile('data/settings.json', Buffer.from('{"lang":"en"}'));
oz.addFile('_backup_meta.json', Buffer.from(JSON.stringify({ appVersion: '3.0.17' })));
oz.writeZip(oldZip);
const zipTarget = path.join(work, 'zip-target');
fs.mkdirSync(zipTarget, { recursive: true });
B.restoreBackup(oldZip, zipTarget);
ok('旧明文 zip 直还原成功', fs.readFileSync(path.join(zipTarget, 'store.json'), 'utf-8') === '{"legacy":true}');

section('E. 转换器仍产 v1（跨机仍需密钥）');
const beforeSha = sha(oldZip);
const beforeMtime = fs.statSync(oldZip).mtimeMs;
const converted = B.convertLegacyBackup(oldZip);
ok('转换器产物首字节 N（NYENC001，非 v2）', fs.readFileSync(converted).subarray(0, 8).toString('ascii') === 'NYENC001');
ok('转换产物检测为 v1', P.detectBackupKind(fs.readFileSync(converted)) === 'v1');
ok('转换产物 peekVersion 返回源版本 3.0.17', B.peekBackupVersion(converted) === '3.0.17');
const convTarget = path.join(work, 'conv-target');
fs.mkdirSync(convTarget, { recursive: true });
B.restoreBackup(converted, convTarget);
ok('转换产物可被还原', fs.readFileSync(path.join(convTarget, 'store.json'), 'utf-8') === '{"legacy":true}');
ok('源 zip sha256 未变', sha(oldZip) === beforeSha);
ok('源 zip mtime 未变', fs.statSync(oldZip).mtimeMs === beforeMtime);
ok('重复转换抛 E_ALREADY_CONVERTED', throwsCode(() => B.convertLegacyBackup(converted), 'E_ALREADY_CONVERTED'));

section('F. 四通道 IPC + 双窗拖拽 + 自绘弹窗落地（源码断言）');
function srcOf(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const mainSrc = srcOf('electron/main.ts');
for (const ch of ['backup:createPortable', 'backup:exportPortable', 'backup:restorePortable', 'backup:peekInfo']) {
  ok(`main.ts 注册 ${ch}`, mainSrc.includes(`ipcMain.handle('${ch}'`));
}
for (const rel of ['electron/preload.ts', 'src/ipc.ts']) {
  const s = srcOf(rel);
  for (const fn of ['createPortableBackup', 'exportPortable', 'restorePortableBackup', 'peekBackupInfo']) {
    ok(`${rel} 追加 ${fn}`, s.includes(fn));
  }
}
const mainTsxRaw = srcOf('src/main.tsx');
const mainTsx = mainTsxRaw.replace(/\r/g, '');
ok('main.tsx 挂载 BackupRestoreHost', mainTsx.includes('<BackupRestoreHost />'));
ok('main.tsx 四处 document 监听均为捕获阶段 true',
  (mainTsx.match(/document\.addEventListener\(/g) || []).length >= 4 &&
  (mainTsx.match(/\n\s*true\s*\n\s*\);/g) || []).length >= 4);
ok('main.tsx 拖放门控使用 isPortableBackupFile', mainTsx.includes('isPortableBackupFile'));
ok('drop 使用 stopImmediatePropagation 阻止 App 快速导入', mainTsx.includes('stopImmediatePropagation'));
const busSrc = srcOf('src/utils/backupBus.ts');
ok('backupBus 三事件齐全', ['showCreated', 'onShowCreated', 'requestRestore', 'onRequestRestore', 'setDragActive', 'onDragActive'].every((k) => busSrc.includes(k)));
const dlgSrc = srcOf('src/components/PassphraseDialog.tsx')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
ok('口令弹窗自绘：portal + modal-mask + useRetract(theme)', dlgSrc.includes('createPortal') && dlgSrc.includes('modal-mask') && dlgSrc.includes("'theme'"));
ok('口令弹窗无原生弹窗', !/window\.(alert|confirm|prompt)/.test(dlgSrc));

section('G. 冻结文件零改动（git diff 断言）');
const frozen = [
  'src/components/MiniChat.tsx',
  'src/components/ChatWindow.tsx',
  'electron/cursorCoverState.ts',
  'electron/cursorHotspotMigration.ts',
];
let diffClean = true;
try {
  execFileSync('git', ['diff', '--quiet', '--', ...frozen], { cwd: ROOT, stdio: 'ignore' });
} catch {
  diffClean = false;
}
ok('cursor / MiniChat / ChatWindow 冻结文件 diff 为空', diffClean);

section('H. 文档口径同步（v2 口令 / v1 跨机仍需密钥）');
const manual = srcOf('使用说明.md');
const guide = srcOf('src/components/GuideView.tsx');
const sec21 = manual.slice(manual.indexOf('## 21. 备份与还原'), manual.indexOf('## 21.1'));
ok('使用说明 §21 写明 v2 一次性口令', sec21.includes('口令') && sec21.includes('v2'));
ok('使用说明 §21 写明 v1 跨机仍需密钥', sec21.includes('nianyu-master.key'));
ok('使用说明 §21 写明排除本地路径配置', sec21.includes('path-config'));
ok('GuideView 同步口令机制且无 markdown 符号', guide.includes('一次性口令') && !/\*\*|```/.test(guide.slice(guide.indexOf("id: 'guide-backup'"), guide.indexOf("id: 'guide-backup'") + 2000)));
ok('GuideView 不再宣称「跨设备须拷密钥」为通用口径', !guide.includes('跨设备恢复须同时拷贝'));

console.log(`\n========== 四态兼容闸门：${pass} 通过 / ${fail} 失败 ==========`);
process.exitCode = fail ? 1 : 0;
