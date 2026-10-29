/**
 * 桌面角色素材层（V3）—— 角色包导入 / 落盘 / 本地资源协议。
 *
 * 为什么放在主进程：
 * - 浏览器端拿不到真实路径、也不能解压；角色包（zip）解压、文件夹递归复制必须走 Node。
 * - 解压后的素材要能被角色窗与主窗的渲染层直接读取，因此在这里注册 `nychar://` 私有协议。
 *
 * 目录约定（跟随用户的数据目录，随「数据保存路径」一起搬走）：
 *   <数据目录>/characters/<角色 id>/<角色包内的相对路径…>
 *   <数据目录>/characters/<角色 id>/manifest.json   —— 记录入口文件、类型、原始包名
 *
 * 合规说明：
 * - 本模块只做「用户自有素材的搬运与登记」，不内置、不下载任何第三方角色模型/贴图/音频；
 * - 默认角色是渲染层用几何图形现画的占位形象（见 src/character/PlaceholderCharacter.tsx）；
 * - Live2D / VRM 的运行时（Cubism Core、Cubism 2 runtime）属于各自权利方，不随软件分发，
 *   由用户自行放入运行库目录（见 runtimeDir 与 UI 提示）。
 */
import { app, ipcMain, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { getDataManager } from './db';
import { requestFilePick } from './dialogBridge';
import type { CharacterImportResult, DesktopCharacter, DesktopCharacterKind } from '../src/types';

/** 单个角色包解压后的体积上限（字节）——防止用户误拖巨大压缩包把数据盘塞满 */
const MAX_PACKAGE_BYTES = 800 * 1024 * 1024;
/** 递归扫描的目录深度上限 */
const MAX_SCAN_DEPTH = 8;

/** 图片扩展名：可直接作为「静态立绘」角色 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'bmp', 'avif']);
/** 3D / Live2D 扩展名 */
const MODEL_EXT = new Set(['vrm', 'glb', 'gltf', 'moc3', 'moc', 'model3.json', 'model.json']);

const dm = getDataManager();

/** 角色素材根目录（跟随数据目录） */
export function charactersRoot(): string {
  const dir = path.join(dm.getCurrentDataPath(), 'characters');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 忽略：已存在或无权限，后续写入会给出明确错误 */
  }
  return dir;
}

/** 运行库目录：用户自行放入 live2dcubismcore.min.js / live2d.min.js 的位置 */
export function runtimeRoot(): string {
  const dir = path.join(app.getPath('userData'), 'character-runtime');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 忽略 */
  }
  return dir;
}

// ===================== 角色包识别 =====================

interface ScanHit {
  kind: DesktopCharacterKind;
  entry: string;
  score: number;
}

function extOf(file: string): string {
  const base = path.basename(file).toLowerCase();
  if (base.endsWith('.model3.json')) return 'model3.json';
  if (base.endsWith('.model.json')) return 'model.json';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1) : '';
}

/**
 * 从一组相对路径里挑出入口文件。
 * 优先级：Cubism 4（.model3.json）> VRM > GLB/GLTF > Cubism 2（.model.json/.moc）> 静态图片。
 * 同级里优先取层级更浅、文件名更短的那个（角色包常见的 xx/xx.model3.json 结构）。
 */
function pickEntry(files: string[]): ScanHit | null {
  const candidates: { kind: DesktopCharacterKind; entry: string; score: number }[] = [];
  for (const rel of files) {
    const e = extOf(rel);
    const depth = rel.split('/').length;
    const base = 100 - depth * 2 - Math.min(30, rel.length / 8);
    if (e === 'model3.json') candidates.push({ kind: 'live2d', entry: rel, score: 1000 + base });
    else if (e === 'vrm') candidates.push({ kind: 'vrm', entry: rel, score: 900 + base });
    else if (e === 'glb' || e === 'gltf') candidates.push({ kind: 'glb', entry: rel, score: 800 + base });
    else if (e === 'model.json' || e === 'moc' || e === 'moc3') candidates.push({ kind: 'live2d', entry: rel, score: 700 + base });
    else if (IMAGE_EXT.has(e)) candidates.push({ kind: 'image', entry: rel, score: 500 + base });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  return { kind: top.kind, entry: top.entry, score: top.score };
}

/** 递归列出目录下的相对文件路径（限深度，跳过隐藏文件） */
function listFiles(root: string, rel = '', depth = 0, out: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH) return out;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listFiles(root, childRel, depth + 1, out);
    else if (ent.isFile()) out.push(childRel);
  }
  return out;
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(childRel);
      else {
        try {
          total += fs.statSync(path.join(dir, childRel)).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk('');
  return total;
}

function newId(): string {
  return `dc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把 zip 解到目标目录（校验解压体积与路径穿越） */
function extractZip(zipPath: string, destDir: string): void {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    total += e.header.size || 0;
    if (total > MAX_PACKAGE_BYTES) throw new Error('package too large');
    const name = e.entryName.replace(/\\/g, '/');
    if (name.includes('..') || path.isAbsolute(name)) throw new Error('unsafe entry');
  }
  zip.extractAllTo(destDir, true);
}

/** 单文件/单目录/单 zip → characters/<id>/ */
async function importOne(srcPath: string): Promise<CharacterImportResult> {
  const rawName = path.basename(srcPath).replace(/\.[^.]+$/, '');
  const id = newId();
  const destDir = path.join(charactersRoot(), id);
  try {
    const st = fs.statSync(srcPath);
    if (st.isDirectory()) {
      if (dirSize(srcPath) > MAX_PACKAGE_BYTES) {
        return { ok: false, name: rawName, error: 'too_large' };
      }
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(srcPath, destDir, { recursive: true });
    } else {
      const ext = (srcPath.split('.').pop() || '').toLowerCase();
      if (ext === 'zip') {
        fs.mkdirSync(destDir, { recursive: true });
        extractZip(srcPath, destDir);
      } else {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(srcPath, path.join(destDir, path.basename(srcPath)));
      }
    }
  } catch (e: any) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: false, name: rawName, error: e?.message || 'read_failed' };
  }

  const files = listFiles(destDir);
  const hit = pickEntry(files);
  if (!hit) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: false, name: rawName, error: 'no_model' };
  }

  const manifest = {
    id,
    name: rawName,
    kind: hit.kind,
    entry: hit.entry,
    source: path.basename(srcPath),
    createdAt: new Date().toISOString(),
    files,
  };
  try {
    fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch {
    /* 忽略：manifest 只是辅助信息，丢了也能靠扫描工作 */
  }
  return { ok: true, id, name: rawName, kind: hit.kind, entry: hit.entry };
}

// ===================== 设置写入 =====================

function addToSettings(items: CharacterImportResult[]): DesktopCharacter[] {
  const s = dm.getSettings();
  const list: DesktopCharacter[] = [...(s.desktopCharacters || [])];
  for (const it of items) {
    if (!it.ok || !it.id || !it.kind || !it.entry) continue;
    const ch: DesktopCharacter = {
      id: it.id,
      name: it.name || '角色',
      kind: it.kind,
      files: [it.entry],
      entry: it.entry,
      boundChat: null,
      enabled: true,
      scale: 1,
      behavior: true,
      bubble: true,
      // Live2D / 3D 需要外部运行时，登记时带标记，UI 据此给出说明
      note: it.kind === 'live2d' || it.kind === 'vrm' || it.kind === 'glb' ? 'needs-runtime' : undefined,
    };
    list.push(ch);
  }
  dm.saveSettings({ desktopCharacters: list });
  const rt = s.characterRuntime;
  if (rt && !rt.activeId && list.length) {
    dm.saveSettings({ characterRuntime: { ...rt, activeId: list[0].id } });
  }
  return list;
}

/** 删除角色：先删设置，再删磁盘目录（删目录失败不影响设置，最多留个孤儿目录） */
function removeCharacter(id: string): void {
  const s = dm.getSettings();
  const list = (s.desktopCharacters || []).filter((c) => c.id !== id);
  const rt = s.characterRuntime;
  dm.saveSettings({ desktopCharacters: list });
  if (rt && rt.activeId === id) {
    dm.saveSettings({ characterRuntime: { ...rt, activeId: list[0]?.id || '' } });
  }
  // id 由本模块生成，形如 dc_xxx_yyy；非该形状的一律不碰磁盘，避免路径拼接被利用
  if (/^dc_[a-z0-9]+_[a-z0-9]+$/i.test(id)) {
    try {
      fs.rmSync(path.join(charactersRoot(), id), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

// ===================== 私有协议 =====================

/** nychar://model/<角色 id>/<相对路径> —— 供 <img>/GLTFLoader/pixi 读取解压后的素材 */
export function registerCharacterProtocol(): void {
  protocol.handle('nychar', async (request) => {
    try {
      const u = new URL(request.url);
      const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      if (!segs.length) return new Response('bad request', { status: 400 });
      // __runtime__ 段指向「运行库目录」（用户自备的 Cubism Core 等脚本），其余指向角色素材目录
      const isRuntime = segs[0] === '__runtime__';
      const root = isRuntime ? runtimeRoot() : charactersRoot();
      const parts = isRuntime ? segs.slice(1) : segs;
      if (!parts.length) return new Response('bad request', { status: 400 });
      const abs = path.resolve(root, ...parts);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return new Response('not found', { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(abs).toString());
      // 角色窗/主窗与素材不同源（file:// 或 dev server），必须显式允许跨源读取
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-cache');
      return new Response(res.body, { status: res.status, headers });
    } catch (e: any) {
      return new Response(`error: ${e?.message || 'unknown'}`, { status: 500 });
    }
  });
}

// ===================== IPC =====================

/** 解析拖拽进来的「角色包」路径；返回 handled=false 表示不归本模块管（交给快速导入流程） */
function looksLikeCharacterPackage(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const files = listFiles(p);
      return !!pickEntry(files) && files.length > 0;
    }
    const ext = (p.split('.').pop() || '').toLowerCase();
    if (ext === 'zip') {
      // zip 只认「解压后确实含模型/图片」的，避免把普通压缩包（如聊天记录备份）抢走
      try {
        const zip = new AdmZip(p);
        const names = zip.getEntries().map((e) => e.entryName);
        return !!pickEntry(names);
      } catch {
        return false;
      }
    }
    return MODEL_EXT.has(ext);
  } catch {
    return false;
  }
}

export function registerCharacterAssetIPC(onChanged: () => void): void {
  // 文件对话框导入：走项目自绘的 FilePickerHost（theme 适配 + 与其它入口一致），
  // 不直接调系统 dialog —— 原生对话框在深色主题下会突兀白底，且本项目有「禁止原生弹窗」闸门。
  ipcMain.handle('dc:pick-import', async (e, mode: 'file' | 'folder') => {
    const paths = await requestFilePick(e.sender, {
      kind: mode === 'folder' ? 'directory' : 'open',
      title: mode === 'folder' ? '选择角色文件夹' : '选择角色包 / 模型文件',
      multiple: mode !== 'folder',
      filters:
        mode === 'file'
          ? [
              { name: '角色包', extensions: ['zip'] },
              { name: '3D 模型', extensions: ['vrm', 'glb', 'gltf'] },
              { name: 'Live2D', extensions: ['json', 'moc3', 'moc'] },
              { name: '静态立绘', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
            ]
          : undefined,
    });
    if (!paths || !paths.length) return { canceled: true, results: [] as CharacterImportResult[] };
    const results: CharacterImportResult[] = [];
    for (const p of paths) results.push(await importOne(p));
    addToSettings(results);
    onChanged();
    return { canceled: false, results };
  });

  // 拖拽导入：App 的全局 drop 里先问这里要不要接管
  ipcMain.handle('dc:import-paths', async (_e, paths: string[]) => {
    const list = (paths || []).filter((p) => looksLikeCharacterPackage(p));
    if (!list.length) return { handled: false, results: [] as CharacterImportResult[] };
    const results: CharacterImportResult[] = [];
    for (const p of list) results.push(await importOne(p));
    addToSettings(results);
    onChanged();
    return { handled: true, results };
  });

  ipcMain.handle('dc:delete-character', (_e, id: string) => {
    removeCharacter(String(id || ''));
    onChanged();
    return true;
  });

  ipcMain.handle('dc:runtime-dir', () => runtimeRoot());

  // 运行时脚本是否存在（Cubism Core / Cubism 2 runtime）——渲染层据此决定能否渲染 Live2D
  ipcMain.handle('dc:runtime-status', () => {
    const dir = runtimeRoot();
    const has = (f: string) => fs.existsSync(path.join(dir, f));
    return {
      dir,
      cubism4: has('live2dcubismcore.min.js') || has('live2dcubismcore.js'),
      cubism2: has('live2d.min.js'),
    };
  });

  // 打开运行库目录，方便用户把 Cubism Core 放进去
  ipcMain.handle('dc:open-runtime-dir', async () => {
    const { shell } = await import('electron');
    await shell.openPath(runtimeRoot());
    return true;
  });
}
