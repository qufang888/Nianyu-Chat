// ===== 自动检查更新 / 提醒 / 从 GitHub 下载更新（v2.3.45）=====
// 说明：本项目发布产物由 CI 打到 GitHub Releases（tag vX.Y.Z，资产 Setup.X.Y.Z.exe）。
// 本模块不依赖 electron-updater，直接用 GitHub REST API + 流式下载，避免改动打包链路。
// 下载通道：安装包与 .sha256 校验文件均走 electron.net.request（Chromium 网络栈，默认使用系统代理，
// 与浏览器下载同通道，规避 Node fetch 直连导致的传输干扰/安装包损坏）；仅检查更新的 API 查询保持 Node fetch。
import { app, net, shell } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
// 硬编码：net 下载通道参数（改动需同步告知用户）
// 说明：net.request 走 Chromium 网络栈，此处为「socket 空闲超时」而非总时长超时——
// 只要数据持续到达就不会触发（83MB 安装包慢速下载不受影响）；旧 Node fetch 的 20s 总超时对大文件本就不够。
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000; // socket 空闲 30 秒无数据则中止下载（触发 error 拒绝）
const SHA256_RETRY_MAX = 2; // SHA-256 哈希不匹配时的最大下载尝试次数（首次 + 自动重试 1 次）
// .sha256 必选阈值：从该版本起新发布必然附带 .sha256 校验资产，获取失败即中止（老版本无此资产，保持大小校验兜底）
const SHA256_ASSET_MIN_VERSION = '2.3.51';

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
  sumAssetUrl?: string; // .sha256 校验文件直链（release assets 透传，与安装包同源同通道）
  sumAssetSize?: number; // .sha256 校验文件字节数（下载后顺带校验，可选加固）
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
    // .sha256 校验资产：优先取与安装包同名（<assetName>.sha256）的资产，其次取名称含版本号的
    const sums = assets.filter((a) => typeof a?.name === 'string' && /\.sha256$/i.test(a.name));
    const exactSum = picked ? sums.find((a) => a.name === `${picked.name}.sha256`) : undefined;
    const sumPicked = exactSum || sums.find((a) => a.name.includes(version)) || sums[0];
    return {
      version,
      assetName: picked?.name,
      assetUrl: picked?.browser_download_url,
      assetSize: typeof picked?.size === 'number' ? picked.size : undefined,
      sumAssetUrl: sumPicked?.browser_download_url,
      sumAssetSize: typeof sumPicked?.size === 'number' ? sumPicked.size : undefined,
      releaseUrl: data?.html_url || `${RELEASE_PAGE}/tag/v${version}`,
      notes: typeof data?.body === 'string' ? data.body.slice(0, 2000) : undefined,
      publishedAt: data?.published_at,
    };
  } finally {
    clearTimeout(t);
  }
}

// ===== 下载完整性校验（v2.3.50）=====
// 流式计算文件 SHA-256（不把整包读进内存）
function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// 内部错误标记：SHA-256 哈希不匹配（唯一触发自动重新下载重试的错误类型）
class HashMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashMismatchError';
  }
}

// 通过 electron.net.request（Chromium 网络栈）流式下载到文件。
// 走 Chromium 网络：默认使用系统代理（与浏览器下载同通道，规避 Node fetch 直连被网络环境干扰）；
// 默认自动跟随 HTTP 重定向（GitHub browser_download_url 会 302 到 objects.githubusercontent.com）。
// 注意：net 仅在 app ready 后可用——updater 全部在 ready 后运行，满足前提。
// 超时语义：30s 为 socket 空闲超时（数据持续到达不触发），abort 会触发 error 事件 → reject。
// 返回实际接收字节数与 content-length 总数；未完成的文件由调用方负责关闭/删除。
function netDownloadToFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<{ received: number; total: number }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url });
    req.setHeader('User-Agent', 'nianyu-client-updater');
    let ws: fs.WriteStream | null = null;
    let settled = false;
    let total = 0;
    let received = 0;
    let lastNotify = 0;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try { req.abort(); } catch { /* ignore */ }
      if (ws) {
        try { ws.destroy(); } catch { /* ignore */ }
      }
      reject(err);
    };

    // 空闲超时：30 秒无任何数据到达则中止（数据持续到达会不断重置计时，大文件慢速下载不受影响）。
    // 说明：Electron ClientRequest 类型未暴露 setTimeout（Node http.ClientRequest 的 socket 空闲超时），
    // 故用「data 事件重置的计时器」实现等价的空闲超时；abort 会触发 error 事件 → reject。
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = (): void => {
      if (settled) return; // 已结束（含 abort 后事件循环里排队的末个 data）不再新建计时器
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        fail(new Error(`下载超时：连接空闲超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒，请重试`));
      }, DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    req.on('response', (resp) => {
      if (resp.statusCode !== 200) {
        fail(new Error(`下载失败：HTTP ${resp.statusCode}`));
        return;
      }
      const cl = resp.headers['content-length'];
      total = Number(Array.isArray(cl) ? cl[0] : cl) || 0;
      ws = fs.createWriteStream(dest);
      const sink = ws; // 固定非空引用：嵌套回调内 TS 无法对可变变量保持收窄
      sink.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      sink.on('finish', () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (settled) return;
        // Windows：WriteStream 的 fd 在 finish 后才异步 close，立即 rename 可能 EBUSY/EPERM——
        // 等 'close'（fd 已释放）再 resolve，避免调用方对未关闭句柄 rename 失败
        sink.once('close', () => {
          if (settled) return;
          settled = true;
          resolve({ received, total });
        });
      });
      resp.on('data', (chunk: Buffer) => {
        received += chunk.length;
        resetIdle(); // 数据持续到达 → 重置空闲计时
        const now = Date.now();
        // 节流：每 200ms 回调一次进度（或收满时回调末次），避免高频 IPC
        if (onProgress && (now - lastNotify > 200 || (total > 0 && received >= total))) {
          lastNotify = now;
          try { onProgress(received, total); } catch { /* 进度回调异常不影响下载 */ }
        }
      });
      resp.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      // end:false：由 resp 'end' 事件显式收尾，确保 finish 前所有字节已写入
      // Electron IncomingMessage 类型未声明 NodeJS.ReadableStream，实际是 Node 可读流，收窄后使用 pipe
      const src = resp as unknown as NodeJS.ReadableStream;
      src.pipe(ws, { end: false });
      resp.on('end', () => {
        try { ws?.end(); } catch { /* ignore */ }
      });
    });
    resetIdle(); // 从发起请求起即计时（含连接/重定向等待阶段）
    req.end();
  });
}

// 通过 electron.net.request 下载小文件到内存（供 .sha256 校验文件用，90 字节级）；失败/非 200 reject
function netDownloadToBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url });
    req.setHeader('User-Agent', 'nianyu-client-updater');
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      try { req.abort(); } catch { /* ignore */ }
      reject(err);
    };
    // 空闲超时（与 netDownloadToFile 同一实现方式：data 事件重置计时）
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = (): void => {
      if (settled) return; // 已结束（含 abort 后事件循环里排队的末个 data）不再新建计时器
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        fail(new Error(`连接空闲超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒`));
      }, DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    req.on('response', (resp) => {
      if (resp.statusCode !== 200) {
        fail(new Error(`HTTP ${resp.statusCode}`));
        return;
      }
      resp.on('data', (chunk: Buffer) => {
        resetIdle();
        chunks.push(chunk);
      });
      resp.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      resp.on('end', () => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        resolve(Buffer.concat(chunks));
      });
    });
    resetIdle();
    req.end();
  });
}

// 取发布页附带的 .sha256 校验文件内容（改用 release API 透传的 .sha256 资产直链下载，
// 与安装包同源同通道走 electron.net——不再拼接 URL 单独请求）。返回 64 位 hex 小写。
// sumAssetUrl 缺省（老版本资产无 .sha256）返回 null；sumAssetSize 存在时顺带校验文件大小（可选加固）。
async function fetchExpectedChecksum(sumAssetUrl?: string, sumAssetSize?: number): Promise<string | null> {
  if (!sumAssetUrl) return null;
  const buf = await netDownloadToBuffer(sumAssetUrl);
  if (sumAssetSize && buf.length !== sumAssetSize) {
    throw new Error(`校验文件（.sha256）大小不符（期望 ${sumAssetSize}，实际 ${buf.length}），可能下载被拦截或文件损坏`);
  }
  const m = buf.toString('utf8').trim().toLowerCase().match(/[0-9a-f]{64}/);
  if (!m) {
    throw new Error('校验文件（.sha256）内容异常，无法解析出哈希值，可能下载被拦截或文件损坏');
  }
  return m[0];
}

// 检查更新：manual=true 时（用户点「检查更新」）无论是最新还是报错都会回状态并在界面提示
export async function checkForUpdate(manual = false): Promise<UpdateStatus> {
  if (downloading) return getUpdateStatus();
  return checkForUpdateCore(manual);
}

// 检查更新核心逻辑（无并发锁检查）：供 downloadUpdate 在已持有 downloading 锁时内嵌调用，
// 避免「锁已置位 → 内嵌检查被自身锁拦截」；downloadUpdate 内部还会透传 manual 与自动下载逻辑
async function checkForUpdateCore(manual: boolean): Promise<UpdateStatus> {
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
        sumAssetUrl: info.sumAssetUrl,
        sumAssetSize: info.sumAssetSize,
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
  // 并发锁立即置位：assetUrl 缺失时内嵌检查存在 await 窗口，
  // 若此时不持锁，第二次 downloadUpdate 可并发进入并写同一 .part 临时文件
  downloading = true;
  if (!status.assetUrl) {
    // 没有可用资产信息：先检查一次（走无锁核心，避免被自身刚置位的锁拦截）
    const s = await checkForUpdateCore(true);
    if (s.state !== 'available') {
      downloading = false;
      return s;
    }
  }
  const url = status.assetUrl!;
  const name = status.assetName || `Setup.${status.latestVersion}.exe`;
  const dir = resolveDownloadDir();
  const target = path.join(dir, name);
  const tmp = `${target}.part`;
  // .sha256 必选化语义：latestVersion >= SHA256_ASSET_MIN_VERSION（新版本发布必然附带 .sha256 资产）
  // 时校验必选——校验文件缺失/下载失败一律中止，绝不交付未校验的安装包；
  // 老版本（< 2.3.51）资产无 .sha256，保持大小校验兜底（不误拦历史版本）。
  const latestVersion = status.latestVersion || '';
  const sha256Required = !!latestVersion && compareVersions(latestVersion, SHA256_ASSET_MIN_VERSION) >= 0;
  // downloading 已在函数入口置位（含内嵌检查路径），此处不再重复
  emit({ state: 'downloading', received: 0, total: status.assetSize || 0, percent: 0, filePath: undefined });
  const onProgress = (received: number, total: number): void => {
    emit({
      state: 'downloading',
      received,
      total,
      percent: total ? Math.min(100, Math.round((received / total) * 100)) : undefined,
    });
  };
  try {
    // 下载 + 校验；仅 SHA-256 哈希不匹配触发自动重试（最多 SHA256_RETRY_MAX 次尝试），其余错误立即失败
    for (let attemptNo = 1; attemptNo <= SHA256_RETRY_MAX; attemptNo++) {
      fs.mkdirSync(dir, { recursive: true });
      // 清除历史残留（防复用坏文件 / 上次中断的部分文件）
      for (const p of [target, tmp]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
      }
      let received = 0;
      let total = 0;
      try {
        ({ received, total } = await netDownloadToFile(url, tmp, onProgress));
        // ===== 完整性校验：先大小、再 SHA-256 比对发布页 .sha256 =====
        emit({ state: 'verifying', received, total, percent: 100, filePath: undefined });
        const st = fs.statSync(tmp);
        if (total && st.size !== total) {
          throw new Error(`下载文件大小不符（期望 ${total}，实际 ${st.size}），可能下载被截断，请重试`);
        }
        const actual = await sha256File(tmp);
        if (sha256Required) {
          if (!status.sumAssetUrl) {
            throw new Error('无法获取安装包校验文件（.sha256），为避免安装损坏的更新包已中止。请到发布页用浏览器手动下载');
          }
          let expected: string | null = null;
          try {
            expected = await fetchExpectedChecksum(status.sumAssetUrl, status.sumAssetSize);
          } catch (e: any) {
            throw new Error(
              `无法获取安装包校验文件（.sha256）${e?.message ? `：${e.message}` : ''}，为避免安装损坏的更新包已中止。请到发布页用浏览器手动下载`
            );
          }
          if (!expected || actual !== expected) {
            throw new HashMismatchError('下载文件校验失败（哈希不匹配，可能下载被拦截或文件损坏）。请关闭杀毒软件实时防护后重试，或到发布页用浏览器手动下载');
          }
        } else {
          // 老版本：尽力获取 .sha256（走透传的资产直链），取不到则回退仅大小校验
          const expected = await fetchExpectedChecksum(status.sumAssetUrl, status.sumAssetSize).catch(() => null);
          if (expected && actual !== expected) {
            throw new HashMismatchError('下载文件校验失败（哈希不匹配，可能下载被拦截或文件损坏）。请关闭杀毒软件实时防护后重试，或到发布页用浏览器手动下载');
          }
        }
        break; // 校验通过，退出重试循环
      } catch (e: any) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          /* 清理失败忽略 */
        }
        // 仅哈希不匹配自动重新下载一次；其它错误（网络/截断/校验文件缺失等）直接失败
        if (!(e instanceof HashMismatchError) || attemptNo >= SHA256_RETRY_MAX) throw e;
      }
    }
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
  // 轻量复检：文件在下载后被外部（如杀软实时防护）改写则拦截，避免把坏包交给系统安装器
  try {
    const st = fs.statSync(status.filePath);
    if (status.assetSize && st.size !== status.assetSize) {
      emit({ state: 'error', message: '安装包在下载后被修改（大小变化），可能被杀软拦截。请重新下载，或关闭杀毒软件实时防护后重试' });
      return false;
    }
  } catch { /* ignore */ }
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
