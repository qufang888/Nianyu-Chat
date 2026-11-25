/**
 * v3.0.18 全量本地资料不可直读闸门：JSON + 二进制媒体都必须是密文，且软件内仍可无感读取。
 * 做法：esbuild 执行真实 secureStore.ts / backup.ts；配合源码强断言覆盖协议与双窗链路。
 * 用法：node scripts/verify-diary-storage-unreadable.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';

const ROOT = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-diary-storage-'));
const keyDir = path.join(work, 'userData');
fs.mkdirSync(keyDir, { recursive: true });
process.env.NY_KEYDIR = keyDir;

async function bundle(contents, outName, stubPath) {
  const outfile = path.join(work, outName);
  await build({
    stdin: { contents, loader: 'ts', resolveDir: ROOT },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2020',
    banner: { js: `import { createRequire as __nyCreateRequire } from 'node:module'; const require = __nyCreateRequire(import.meta.url);` },
    plugins: stubPath ? [{
      name: 'electron-stub',
      setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: stubPath })); },
    }] : [],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href + '?v=' + Date.now());
}

const S = await bundle(
  `export * from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
  'secure.mjs'
);
const stub = path.join(work, 'electron-stub.mjs');
fs.writeFileSync(stub, 'export const app = { getPath: () => process.env.NY_KEYDIR, getVersion: () => "3.0.18" };\n', 'utf-8');
const B = await bundle(
  `export * from ${JSON.stringify(path.join(ROOT, 'electron/backup.ts'))};
export * as secure from ${JSON.stringify(path.join(ROOT, 'electron/secureStore.ts'))};`,
  'backup.mjs',
  stub
);

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

S.initSecureStore(path.join(keyDir, 'nianyu-master.key'));
B.secure.initSecureStore(path.join(keyDir, 'nianyu-master.key'));
const dataDir = path.join(work, 'data');
const images = path.join(dataDir, 'images');
fs.mkdirSync(images, { recursive: true });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
const pngPath = path.join(images, 'chat.png');
const jpgPath = path.join(images, 'avatar.jpg');
fs.writeFileSync(pngPath, png);
fs.writeFileSync(jpgPath, jpg);
fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify({ roles: [{ name: '小雨' }], messages: [{ content: '私密聊天' }] }));

section('A. 落盘不可直读 / 软件内可读');
const r = S.migratePlaintextFiles(S.collectEncryptableFiles(dataDir));
const encPng = fs.readFileSync(pngPath);
const encJpg = fs.readFileSync(jpgPath);
ok('迁移覆盖图片', r.encrypted.includes(pngPath) && r.encrypted.includes(jpgPath));
ok('PNG 魔数已消失', !encPng.subarray(0, 8).equals(png.subarray(0, 8)));
ok('JPEG 魔数已消失', !(encJpg[0] === 0xff && encJpg[1] === 0xd8));
ok('所有媒体落盘均为 NYENC001 信封',
  encPng.subarray(0, 8).toString('ascii') === 'NYENC001' && encJpg.subarray(0, 8).toString('ascii') === 'NYENC001');
ok('图片查看器无法识别（首字节 N 而非二进制图片头）', encPng[0] === 0x4e);
ok('readBinary 解密回原 PNG 字节', S.readBinary(pngPath).equals(png));
ok('readBinary 解密回原 JPEG 字节', S.readBinary(jpgPath).equals(jpg));
ok('readText 仍可读 JSON', JSON.parse(S.readText(path.join(dataDir, 'store.json'))).messages[0].content === '私密聊天');
const dataUrl = `data:image/png;base64,${S.readBinary(pngPath).toString('base64')}`;
ok('image:get 等价的 data URL 合法', dataUrl.startsWith('data:image/png;base64,') && Buffer.from(dataUrl.split(',')[1], 'base64').equals(png));
const rawBefore = fs.readFileSync(pngPath);
S.writeBinary(pngPath, png);
ok('writeBinary 幂等更新且仍为密文', !fs.readFileSync(pngPath).equals(rawBefore) &&
  fs.readFileSync(pngPath).subarray(0, 8).toString('ascii') === 'NYENC001' && S.readBinary(pngPath).equals(png));

section('B. 备份往返后媒体仍可读');
const pack = path.join(work, `backup${B.BACKUP_EXTENSION}`);
B.createBackup(dataDir, pack, '3.0.18');
ok('新备份首字节非 PK', fs.readFileSync(pack)[0] !== 0x50);
const restored = path.join(work, 'restored');
fs.mkdirSync(restored, { recursive: true });
B.restoreBackup(pack, restored);
ok('还原后 PNG 仍是密文且可读回原文',
  fs.readFileSync(path.join(restored, 'images/chat.png')).subarray(0, 8).toString('ascii') === 'NYENC001' &&
  S.readBinary(path.join(restored, 'images/chat.png')).equals(png));
new AdmZip(B.secure.decryptBackup(fs.readFileSync(pack)));

section('C. 全链路源码强断言（协议 / 双窗 / 角色素材）');
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf-8');
ok('nianyuimg 改为 registerBufferProtocol', /registerBufferProtocol\('nianyuimg'/.test(mainSrc) &&
  !/registerFileProtocol\('nianyuimg'/.test(mainSrc));
ok('nianyuimg 返回 mimeType 且无明文临时文件', /mimeType:\s*mime/.test(mainSrc) && !/writeFileSync\([^)]*tmp[^)]*readBinary/.test(mainSrc));
ok('媒体写入统一 writeBinary（生图 / 头像 / 视频 / 图片保存）',
  (mainSrc.match(/writeBinary\(dest,/g) || []).length >= 6 && /writeBinary\(avatarDest, buf\)/.test(mainSrc));
ok('媒体读取统一 readBinary（image:get / dataUrl / 导入）',
  /const mediaBuf = readBinary\(p\)/.test(mainSrc) && /const buf = readBinary\(abs\)/.test(mainSrc));
const chatSrc = fs.readFileSync(path.join(ROOT, 'src/components/ChatWindow.tsx'), 'utf-8');
const miniSrc = fs.readFileSync(path.join(ROOT, 'src/components/MiniChat.tsx'), 'utf-8');
ok('主窗显示图片走安全 IPC getImage', /getImage\(/.test(chatSrc));
ok('小窗显示图片走安全 IPC getImage', /getImage\(/.test(miniSrc));
const assets = fs.readFileSync(path.join(ROOT, 'electron/characterAssets.ts'), 'utf-8');
ok('角色素材导入走 writeBinary / 协议读取走 readBinary',
  /writeBinary\(target, e\.getData\(\)\)/.test(assets) && /const buf = readBinary\(abs\)/.test(assets));
const doc = fs.readFileSync(path.join(ROOT, '使用说明.md'), 'utf8');
ok('明文例外已在文档逐项说明',
  doc.includes('tts-cache') && doc.includes('custom-sounds') && doc.includes('character-runtime'));

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} 全量存储不可读闸门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
