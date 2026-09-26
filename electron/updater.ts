// ===== 自动检查更新 / 提醒 / 从 GitHub 下载更新（v2.3.45）=====
// 说明：本项目发布产物由 CI 打到 GitHub Releases（tag vX.Y.Z，资产 Setup.X.Y.Z.exe）。
// 本模块不依赖 electron-updater，直接用 GitHub REST API + Node 流式下载，避免改动打包链路。
// 数据来源：https://api.github.com/repos/{owner}/{repo}/releases/latest（无鉴权，匿名额度 60 次/小时，
// 定时检查间隔 6 小时，够用；如遇 403 限流会返回明确错误文案）。
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDataManager } from './db';
import type { UpdateState, UpdateStatus } from '../src/types';
export type { UpdateState, UpdateStatus };


const OWNER = 'qufang888';
const REPO = 'Nianyu-Chat';
const API_LATEST = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;
// 硬编码：自动检查延迟与间隔（改动需同步告知用户）
const FIRST_CHECK_DELAY_MS = 8 * 1000; // 启动后 8 秒首次检查（等界面就绪）
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 之后每 6 小时一次
const REQUEST_TIMEOUT_MS = 20 * 1000;

let broadcaster: ((channel: string, payload: unknown) => void) | null = null;
let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
let timer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let downloading = false;

export function setUpdateBroadcaster(fn: (channel: string, payload: unknown) => void): void {
  broadcaster = fn;
}

function emit(patch: Partial<UpdateStatus>): UpdateStatus {
  status = { ...status, ...patch, currentVersion: app.getVersion() };
  try {
    broadcaster?.('update:status', status);
  } catch {
    /* 广播失败不影响主流程 */
  }
  return status;
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status, currentVersion: app.getVersion() };
}

// 版本比较：按数字段比较（忽略 v 前缀与后缀标记，如 2.3.45 / v2.3.45 / 2.3.45-beta.1）
export function compareVersions(a: string, b: string): number {
  const seg = (v: string) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((x) => parseInt(x, 10) || 0);
  const x = seg(a);
  const y = seg(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

interface LatestInfo {
  version: string;
  assetName?: string;
  assetUrl?: string;
  assetSize?: number;
  releaseUrl: string;
  notes?: string;
  publishedAt?: string;
}

async function fetchLatestRelease(): Promise<LatestInfo> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'nianyu-client-updater',
      },
      signal: controller.signal,
    });
    if (resp.status === 403 || resp.status === 429) {
      throw new Error('GitHub API 请求受限（可能是匿名额度用尽），请稍后再试');
    }
    if (!resp.ok) throw new Error(`检查更新失败：HTTP ${resp.status}`);
    const data = (await resp.json()) as any;
    const version = String(data?.tag_name || data?.name || '').replace(/^v/i, '').trim();
    if (!version) throw new Error('发布信息缺少版本号');
    const assets: any[] = Array.isArray(data?.assets) ? data.assets : [];
    // 产物优先级：与本版本号匹配的 Setup.<version>.exe > 其它 Setup*.exe
    const exes = assets.filter((a) => typeof a?.name === 'string' && /\.exe$/i.test(a.name));
    const exact = exes.find((a) => a.name.includes(version));
    const picked = exact || exes[0];
    return {
      version,
      assetName: picked?.name,
      assetUrl: picked?.browser_download_url,
      assetSize: typeof picked?.size === 'number' ? picked.size : undefined,
      releaseUrl: data?.html_url || `${RELEASE_PAGE}/tag/v${version}`,
      notes: typeof data?.body === 'string' ? data.body.slice(0, 2000) : undefined,
      publishedAt: data?.published_at,
    };
  } finally {
    clearTimeout(t);
  }
}

// 检查更新：manual=true 时（用户点「检查更新」）无论是最新还是报错都会回状态并在界面提示
export async function checkForUpdate(manual = false): Promise<UpdateStatus> {
  if (downloading) return getUpdateStatus();
  emit({ state: 'checking', manual, message: undefined });
  try {
    const info = await fetchLatestRelease();
    const current = app.getVersion();
    if (compareVersions(info.version, current) > 0) {
      const next = emit({
        state: info.assetUrl ? 'available' : 'error',
        latestVersion: info.version,
        assetName: info.assetName,
        assetUrl: info.assetUrl,
        assetSize: info.assetSize,
        releaseUrl: info.releaseUrl,
        notes: info.notes,
        publishedAt: info.publishedAt,
        message: info.assetUrl ? undefined : '该发布未附带安装包资产，请到发布页手动下载',
        checkedAt: Date.now(),
      });
      // 自动下载（用户开启时）：非手动检查与手动检查都会自动开始
      if (next.state === 'available' && getDataManager().getSettings().autoDownloadUpdate === true) {
        void downloadUpdate();
      }
      return next;
    }
    return emit({
      state: 'latest',
      latestVersion: info.version,
      releaseUrl: info.releaseUrl,
      checkedAt: Date.now(),
      message: undefined,
    });
  } catch (e: any) {
    return emit({
      state: 'error',
      message: e?.message || String(e),
      checkedAt: Date.now(),
    });
  }
}

// 下载目录：优先系统「下载」目录，失败回退到数据目录 updates/
function resolveDownloadDir(): string {
  try {
    const d = app.getPath('downloads');
    if (d) return d;
  } catch {
    /* 某些环境无下载目录 */
  }
  return path.join(getDataManager().dataDirectory, 'updates');
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (downloading) return getUpdateStatus();
  if (!status.assetUrl) {
    // 没有可用资产信息：先检查一次
    const s = await checkForUpdate(true);
    if (s.state !== 'available') return s;
  }
  const url = status.assetUrl!;
  const name = status.assetName || `Setup.${status.latestVersion}.exe`;
  const dir = resolveDownloadDir();
  const target = path.join(dir, name);
  const tmp = `${target}.part`;
  downloading = true;
  emit({ state: 'downloading', received: 0, total: status.assetSize || 0, percent: 0, filePath: undefined });
  const controller = new AbortController();
  let lastEmit = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'nianyu-client-updater', Accept: 'application/octet-stream' },
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`下载失败：HTTP ${resp.status}`);
    const total = Number(resp.headers.get('content-length')) || status.assetSize || 0;
    let received = 0;
    const body = Readable.fromWeb(resp.body as any);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      // 节流：每 200ms 广播一次进度，避免高频 IPC
      if (now - lastEmit > 200 || (total && received >= total)) {
        lastEmit = now;
        emit({
          state: 'downloading',
          received,
          total,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : undefined,
        });
      }
    });
    await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
    downloading = false;
    return emit({ state: 'downloaded', filePath: target, percent: 100, message: undefined });
  } catch (e: any) {
    downloading = false;
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 清理失败忽略 */
    }
    return emit({ state: 'error', message: `下载更新失败：${e?.message || String(e)}` });
  }
}

// 打开已下载安装包所在文件夹（选中文件）
export function openDownloadedFolder(): boolean {
  if (!status.filePath || !fs.existsSync(status.filePath)) return false;
  shell.showItemInFolder(status.filePath);
  return true;
}

// 运行安装包：交给系统安装器（NSIS），随后退出应用避免文件占用
export function runInstaller(): boolean {
  if (!status.filePath || !fs.existsSync(status.filePath)) return false;
  void shell.openPath(status.filePath);
  setTimeout(() => app.quit(), 1200);
  return true;
}

// 打开 Release 页面（浏览器）
export function openReleasePage(): boolean {
  const url = status.releaseUrl || RELEASE_PAGE;
  void shell.openExternal(url);
  return true;
}

// 启动时自动检查 + 周期检查；设置变化时调用 syncAutoCheck 重新同步
export function startAutoCheck(): void {
  stopAutoCheck();
  const settings = getDataManager().getSettings();
  if (settings.autoCheckUpdate === false) return;
  firstTimer = setTimeout(() => {
    void checkForUpdate(false);
  }, FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => {
    void checkForUpdate(false);
  }, CHECK_INTERVAL_MS);
}

export function stopAutoCheck(): void {
  if (firstTimer) {
    clearTimeout(firstTimer);
    firstTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function syncAutoCheck(): void {
  startAutoCheck();
}

export { RELEASE_PAGE };
