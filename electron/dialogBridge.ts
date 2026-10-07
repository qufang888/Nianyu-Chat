/**
 * 自绘弹窗桥（v2.3.97）—— 主进程侧的「请求 / 等待回传」中枢
 * ============================================================================
 * 背景：项目原有 11 处系统原生弹窗（2 处 `dialog.showMessageBox` + 9 处
 * `dialog.showOpenDialog` / `showSaveDialog`）。它们在深色主题下是刺眼的白底黑字
 * 系统对话框，且原生确认框关闭后还会破坏渲染器输入框的焦点路由。本模块把这 11 处
 * 全部改为「主进程把请求推给渲染层 → 渲染层弹自绘弹窗 → 回传结果」，
 * 由 `ConfirmHost` / `FilePickerHost` 两个顶层宿主组件负责渲染与回传。
 *
 * 设计要点（与旧实现的差异及理由）：
 * 1. **保留 `ipcMain.handle` 而非改成 `ipcMain.on` + preload 本地 Promise**。
 *    旧 `app:confirm` 本来就是 `handle`（preload 用 `ipcRenderer.invoke`），
 *    9 个文件选择器也都是 `handle`。只要**保持 channel 名与签名不变**，
 *    preload.ts 与 17 处 `api.showConfirm` 调用点、以及 30+ 处 pick* 调用点
 *    就**一行都不用改** —— 这比「preload 里手工维护 id→Promise 表」少一层状态、
 *    少一类竞态（preload 重载后 pending 表泄漏）。主进程侧照样能拿到 `e.sender`
 *    做窗口路由（下面第 3 点）、超时兜底与窗口销毁清理，能力一点不少。
 * 2. **谁来弹 = 发起方所在窗口**。用 `e.sender` 而非固定的 `mainWindow`，
 *    于是小窗（`MiniChat`，独立 BrowserWindow）里的删除消息/回滚也能弹确认框，
 *    不需要第二套通道。
 * 3. **排队而非替换**。同一窗口同时来多个请求时，按到达顺序串行弹；
 *    用户漏点一个不会导致后一个请求被静默顶掉（替换策略会让先发的请求
 *    永远拿不到结果，只能等超时）。
 * 4. **超时兜底 60s**：渲染层崩溃 / 未挂载宿主 / 用户最小化不管时，
 *    Promise 必须自己落地，否则渲染层的 `await` 永远挂住（更糟：用户点了按钮
 *    但界面无反应，像是卡死）。超时一律回**否 / 空**（安全侧默认值：
 *    破坏性操作不执行、文件不导入）。
 * 5. **窗口销毁即清空**：窗口关掉时把该窗口名下所有 pending 立刻落地，
 *    不等 60s。
 */
import { BrowserWindow, ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/** 渲染层无响应时的兜底超时（毫秒）。到期一律回「否 / 空」。 */
export const DIALOG_REQUEST_TIMEOUT_MS = 60_000;

// ============================================================================
// 类型（主进程侧定义；preload / 渲染层各有自己的同构声明，见各自文件注释）
// ============================================================================

/** 确认框请求参数 */
export interface ConfirmAskPayload {
  message: string;
  title?: string;
  /** 破坏性操作：渲染层用 --color-danger 渲染确认按钮 */
  danger?: boolean;
}

/** 文件选择请求参数（渲染层据此决定 open / save / directory 三种形态） */
export interface FilePickPayload {
  /** open=选文件（可多选）；save=选保存路径（带文件名输入框）；directory=只选目录 */
  kind: 'open' | 'save' | 'directory';
  title?: string;
  /** 扩展名过滤（不含点，小写）。空/缺省 = 不过滤 */
  filters?: { name: string; extensions: string[] }[];
  /** open 模式是否允许多选 */
  multiple?: boolean;
  /** save 模式的默认文件名 */
  defaultName?: string;
  /** 起始目录（缺省用上次目录 → 数据目录 → 文档目录） */
  startDir?: string;
  /** 追加式：文件名已存在时是否自动改名（save 模式，备份另存为用） */
  unique?: boolean;
}

/** 目录列表项 */
export interface DirEntryFile {
  name: string;
  size: number;
  /** 修改时间（epoch ms） */
  mtime: number;
}

/** 左侧「位置」栏的快捷入口 */
export interface DirPlace {
  key: string;
  label: string;
  path: string;
}

/** `fs:listDir` 返回值 */
export interface DirListing {
  /** 子目录名（已按名称排序） */
  dirs: string[];
  /** 当前目录下的文件（不含目录），已按名称排序 */
  files: DirEntryFile[];
  /** 实际列出的目录（绝对路径，已归一化） */
  cwd: string;
  /** 上级目录；已在根目录时为 null（此时「返回上级」按钮应禁用） */
  parent: string | null;
  /** 左侧位置栏 */
  places: DirPlace[];
  /** 读取失败时的原因（权限 / 不存在 / 路径非法）；成功时为 null */
  error?: string | null;
}

// ============================================================================
// pending 请求登记表
// ============================================================================

/** 每个待回传请求的落地函数 + 超时定时器 + 发起窗口 id */
interface Pending {
  settle: (result: unknown) => void;
  timer: NodeJS.Timeout;
  /** 发起方 webContents id；用于窗口销毁时精准清空 */
  ownerId: number;
}

/** 确认框 pending（key = 请求 id） */
const confirmPending = new Map<number, Pending>();
/** 文件选择 pending（key = 请求 id） */
const pickPending = new Map<number, Pending>();
/** 自增请求 id。确认框与文件选择共用一个计数器也没问题（不同 Map）。 */
let requestSeq = 0;
/** 每个窗口记住上一次成功浏览的目录，下次打开选择器时作为起点（贴近系统框行为） */
const lastDirByWindow = new Map<number, string>();

/**
 * 登记一个 pending 请求并返回其 id。
 * @param map 目标登记表
 * @param ownerId 发起窗口的 webContents id
 * @param settle 回传时的落地函数
 * @param timeoutMs 超时时长
 */
function registerPending(
  map: Map<number, Pending>,
  ownerId: number,
  settle: (result: unknown) => void,
  timeoutMs: number
): number {
  const id = ++requestSeq;
  const timer = setTimeout(() => {
    // 超时：删掉登记并落地「安全侧默认值」（confirm=false / pick=null）
    if (!map.has(id)) return;
    map.delete(id);
    console.warn(`[dialogBridge] 请求 #${id} 等待渲染层回传超时（${timeoutMs}ms），按默认值落地`);
    settle(map === confirmPending ? false : null);
  }, timeoutMs);
  // 不要因为这个定时器而吊住主进程退出
  if (typeof timer.unref === 'function') timer.unref();
  map.set(id, { settle, timer, ownerId });
  return id;
}

/** 取出并清理一个 pending（正常回传路径） */
function takePending(map: Map<number, Pending>, id: number): Pending | null {
  const p = map.get(id);
  if (!p) return null;
  map.delete(id);
  clearTimeout(p.timer);
  return p;
}

/** 清空某个窗口名下的全部 pending（窗口销毁时调用，立刻落地避免渲染层 await 悬挂） */
function clearPendingForOwner(ownerId: number): void {
  for (const [map, fallback] of [
    [confirmPending, false],
    [pickPending, null],
  ] as const) {
    for (const [id, p] of Array.from(map.entries())) {
      if (p.ownerId !== ownerId) continue;
      map.delete(id);
      clearTimeout(p.timer);
      try {
        p.settle(fallback);
      } catch {
        /* 落地失败也不能影响清空流程 */
      }
    }
  }
}

// ============================================================================
// 目录浏览（fs:listDir）
// ============================================================================

/**
 * 判断请求路径是否试图用 `..` 穿越。
 *
 * 注意这是**显式拒绝 `..` 段**，而不是「把路径钳制在某几个白名单根下」。
 * 理由：文件选择器必须能浏览用户磁盘上的任意位置（备份目录可能就在 D 盘、
 * 用户可能从任意挂载点导入世界书），一旦白名单化就把产品功能改窄了；
 * 而本 IPC **只读**（列目录，不提供删除/改名/写入），没有 `..` 穿越就没有
 * 提权面。因此这里采取的策略是：
 *   - 输入里出现 `..` 段 → 直接拒绝（渲染层永远只传 `parent` 字段算出的上级目录，
 *     那是 `path.dirname` 的产物，不含 `..`）；
 *   - 含 NUL 字节 → 拒绝（Node 会直接抛错，提前拦掉给出可读原因）；
 *   - 归一化用 `path.resolve`，消掉重复分隔符与 `.` 段；
 *   - `parent` 由 `path.dirname` 得到，天然停在盘符/文件系统根，不会越界。
 */
function hasTraversalSegment(input: string): boolean {
  return input
    .replace(/\\/g, '/')
    .split('/')
    .some((seg) => seg === '..');
}

/** 校验并归一化一个待列目录的路径 */
function normalizeDirInput(input: string): { dir: string } | { error: string } {
  if (typeof input !== 'string' || !input.trim()) return { error: 'EMPTY_PATH' };
  if (input.includes('\0')) return { error: 'INVALID_PATH' };
  if (hasTraversalSegment(input)) return { error: 'TRAVERSAL_DENIED' };
  const dir = path.resolve(input.trim());
  return { dir };
}

// ============================================================================
// 新建文件夹（fs:makeDir）
// ============================================================================
// ⚠️ 这是本模块唯一的**写操作**，安全要求比只读的 `fs:listDir` 高一档。
// 它替代了旧 `dialog.showOpenDialog({ properties: ['openDirectory','createDirectory'] })`
// 里的 `createDirectory` 能力（备份目录 / 数据目录选择时用户需要现场建个专用文件夹）。
//
// 三层校验，缺一不可：
//  1. **父目录校验** —— 必须已存在且是目录；复用 normalizeDirInput 拦 `..` 与 NUL。
//  2. **目录名白名单校验** —— 见 assertSafeFolderName，拦路径分隔符 / 保留名 / 控制字符 / 尾点。
//  3. **只建一层** —— 用 `fs.mkdir`（**不带 recursive**）。这一点是刻意的：
//     若开了recursive，一次调用就能凭空造出任意深度的目录树，
//     相当于给了渲染层「在任何父目录下批量建目录」的能力，权限面骤然放大。
//     不带 recursive 时，一旦父目录不存在就报错，天然限制了「只能在已存在的目录里建」。
//
// 另外三条产品级约束：
//  - **绝不覆盖**：目标已存在则返回 EXISTS 错误（不做「自动追加 (1)」—— 那是选文件的策略，
//    建文件夹时静默改名会让用户找不到自己刚建的东西）；
//  - **失败不吞**：返回具体错误码（PERMISSION / EXISTS / INVALID_NAME / NOT_A_DIR 等），
//    渲染层据此给对应语言的提示，而不是笼统的「失败」；
//  - **有上限**：单层 255 字符、名称非空、去掉首尾空白与尾点后再判重名。
// ============================================================================

/** Windows 保留设备名（不区分大小写）—— 用这些名字建目录会失败或指向设备 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 单个目录名的长度上限（多数文件系统 255 字节，保守取 255 字符） */
const MAX_FOLDER_NAME_LEN = 255;

/**
 * 校验一个「新建文件夹」的名称是否安全。
 *
 * 拒绝清单（每一项都对应一类真实事故）：
 *  - `/` `\`：**最关键的一项**。若放行，渲染层就能传 `../../evil` 或 `C:\Windows\evil`
 *    这类含分隔符的「名字」，一次 mkdir 就写到父目录外面去了 —— 名称必须只能是**一段**。
 *  - `..` / `.`：单段路径分隔语义（`path.join(parent,'..')` 会回到父目录），必须拒。
 *  - `:`：Windows 盘符分隔符（`C:`），也是 NTFS 的 ADS（备用数据流）前缀。
 *  - 保留设备名：Windows 上`con`/`nul`/`com1` 等无法建成目录。
 *  - 控制字符（0x00–0x1F）：含 NUL 会直接让 fs 调用抛错，含换行/制表会污染日志与 UI。
 *  - `*` `?` `"` `<` `>` `|`：Windows 禁用字符，mkdir 会抛 EINVAL。
 *  - 尾部点/空格：Windows 会静默截断（`foo.` 实存为 `foo`），导致「建出来的名字不是我输入的」。
 *
 * @returns 清洗后的名称，或错误码
 */
function assertSafeFolderName(rawName: string): { name: string } | { error: string } {
  if (typeof rawName !== 'string') return { error: 'INVALID_NAME' };
  // 先去掉首尾空白（含全角空格）—— 用户从输入法带出的空格不该让 mkdir 失败
  const name = rawName.trim();
  if (!name) return { error: 'INVALID_NAME' };
  if (name.length > MAX_FOLDER_NAME_LEN) return { error: 'NAME_TOO_LONG' };
  if (name.includes('\0')) return { error: 'INVALID_NAME' };
  // 控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: 'INVALID_NAME' };
  // 路径分隔符与单段语义：这一条挡住了整个「名字里带路径」的越权面
  if (/[/\\]/.test(name)) return { error: 'INVALID_NAME' };
  if (name === '.' || name === '..') return { error: 'INVALID_NAME' };
  // Windows 禁用字符
  if (/[:*?"<>|]/.test(name)) return { error: 'INVALID_NAME' };
  // Windows 尾点/尾空格（trim 已去掉尾空格，这里只查尾点）
  if (name.endsWith('.')) return { error: 'INVALID_NAME' };
  // Windows 保留设备名（含 `con.txt` 这类带扩展名的形式）
  const stem = name.split('.')[0].toLowerCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) return { error: 'INVALID_NAME' };
  return { name };
}

/** `fs:makeDir` 的返回值（失败时 error 是可读的原因码） */
export interface MakeDirResult {
  ok: boolean;
  /** 成功时为新目录的绝对路径 */
  path?: string;
  /** 失败原因码：INVALID_NAME / NAME_TOO_LONG / TRAVERSAL_DENIED / NOT_A_DIR / NOT_DIR_TARGET / EXISTS / PERMISSION / MAKE_FAILED */
  error?: string;
}

/**
 * 新建一个单层文件夹。
 *
 * @param parentDirName 父目录名（由 `fs:listDir` 返回的 cwd，或位置栏里的目录）
 * @param name 新目录名（必须是**单段**，不含任何路径分隔符）
 */
export function makeDirectory(parentDirName: string, name: string): MakeDirResult {
  // ---- 第 1 层：父目录校验 ----
  const parent = normalizeDirInput(parentDirName);
  if ('error' in parent) return { ok: false, error: parent.error };
  let st: fs.Stats;
  try {
    st = fs.statSync(parent.dir);
  } catch {
    return { ok: false, error: 'NOT_A_DIR' };
  }
  if (!st.isDirectory()) return { ok: false, error: 'NOT_A_DIR' };

  // ---- 第 2 层：名称白名单校验 ----
  const safe = assertSafeFolderName(name);
  if ('error' in safe) return { ok: false, error: safe.error };

  // ---- 第 3 层：拼接 + 落盘 ----
  // 名称已确保不含分隔符，path.join 在这里等价于「父目录 + 一段名字」，
  // 二次防御性检查拼接结果仍以父目录开头（万一未来规则被改坏，这一行会兜住）
  const target = path.join(parent.dir, safe.name);
  if (path.dirname(target) !== path.normalize(parent.dir)) {
    return { ok: false, error: 'INVALID_NAME' };
  }

  // 绝不覆盖：已存在（含同名文件）一律拒绝，不静默改名
  if (fs.existsSync(target)) return { ok: false, error: 'EXISTS' };

  try {
    // ⚠️ 刻意**不加 recursive**：只允许在已存在的目录里建一层，
    // 防止渲染层一次性构造出任意深度的目录树（详见上方注释）
    fs.mkdirSync(target);
    return { ok: true, path: target };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code || '';
    if (code === 'EEXIST') return { ok: false, error: 'EXISTS' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'PERMISSION' };
    if (code === 'ENOENT') return { ok: false, error: 'NOT_A_DIR' };
    console.error('[dialogBridge] 新建文件夹失败', e);
    return { ok: false, error: 'MAKE_FAILED' };
  }
}

/** 左侧位置栏的快捷入口（数据目录优先，因为它是最常用的目标） */
function buildPlaces(dataDir: string | null): DirPlace[] {
  const places: DirPlace[] = [];
  const push = (key: string, label: string, p: string | null | undefined): void => {
    if (!p) return;
    places.push({ key, label, path: path.resolve(p) });
  };
  // i18n 在渲染层做（这里只给 key + 英文兜底标签，渲染层会用自己的字典覆盖 label）
  push('data', '念语数据目录', dataDir);
  try {
    push('documents', '文档', app.getPath('documents'));
  } catch {
    /* 某些精简环境无 documents 目录 */
  }
  try {
    push('downloads', '下载', app.getPath('downloads'));
  } catch {
    /* ignore */
  }
  try {
    push('desktop', '桌面', app.getPath('desktop'));
  } catch {
    /* ignore */
  }
  try {
    push('pictures', '图片', app.getPath('pictures'));
  } catch {
    /* ignore */
  }
  push('home', '主目录', app.getPath('home'));
  // 此电脑：Windows 下为盘符根；其他平台给根目录
  if (process.platform === 'win32') {
    const drives: DirPlace[] = [];
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const L of letters) {
      const root = `${L}:\\`;
      // 只列出真实存在的盘符（fs.existsSync 对不存在的盘符很快返回 false）
      try {
        if (fs.existsSync(root)) drives.push({ key: `drive-${L}`, label: `${L}:`, path: root });
      } catch {
        /* ignore */
      }
    }
    places.push(...drives);
  } else {
    places.push({ key: 'root', label: '/', path: path.parse(app.getPath('home')).root });
  }
  return places;
}

/**
 * 列出目录内容（`fs:listDir` 的实现）。
 * **纯只读**：只做 readdir + stat，不提供任何写入/删除/改名能力。
 */
export async function listDirectory(dirInput: string, dataDir: string | null): Promise<DirListing> {
  const places = buildPlaces(dataDir);
  const normalized = normalizeDirInput(dirInput);
  if ('error' in normalized) {
    // 路径非法时仍然回一份可渲染的骨架，让弹窗能显示错误而不是崩掉
    const fallbackCwd = dataDir || app.getPath('home');
    return {
      dirs: [],
      files: [],
      cwd: fallbackCwd,
      parent: null,
      places,
      error: normalized.error,
    };
  }
  const dir = normalized.dir;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code || 'READ_FAILED';
    return {
      dirs: [],
      files: [],
      cwd: dir,
      // 读失败时仍允许返回上级，让用户能从坏目录里退出去
      parent: safeParent(dir),
      places,
      error: code,
    };
  }

  // 显式标注元素类型：否则 TS 会把 push 后的数组元素推成联合类型，
  // 导致下面 localeCompare 报错（dirs 是 string[]，files 是 DirEntryFile[]）
  const dirs: string[] = [];
  const files: DirEntryFile[] = [];
  for (const ent of entries) {
    // 目录与文件分开收集；符号链接一律跳过（避免软链指到无权限/循环的位置）
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      dirs.push(ent.name);
      continue;
    }
    if (!ent.isFile()) continue;
    // 过滤规则由渲染层做（它知道当前请求的 filters），这里回全量
    files.push({ name: ent.name, size: 0, mtime: 0 });
  }
  // stat 文件补齐大小/时间。逐个 stat 但并发受限，避免一次拉起上千个句柄。
  const CONCURRENCY = 24;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const slice = files.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (f) => {
        try {
          const st = await fs.promises.stat(path.join(dir, f.name));
          f.size = st.size;
          f.mtime = st.mtimeMs;
        } catch {
          // 单个文件 stat 失败（权限/已被删除）→ 保留 0 值，列表仍可用
        }
      })
    );
  }

  // 排序：目录按名称、文件按名称。用 localeCompare 保证中文名按拼音而非码点排序。
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return {
    dirs,
    files,
    cwd: dir,
    parent: safeParent(dir),
    places,
    error: null,
  };
}

/** 取上级目录；在盘符根/文件系统根时返回 null（`path.dirname` 天然满足） */
function safeParent(dir: string): string | null {
  const parent = path.dirname(dir);
  if (!parent || parent === dir) return null;
  return parent;
}

// ============================================================================
// 对外 API：发起请求
// ============================================================================

/**
 * 弹一个自绘确认框并等待用户选择。
 *
 * @param sender 发起方 webContents（决定弹在哪个窗口；小窗也能用）
 * @param payload 文案 / 标题 / 是否危险
 * @returns 用户点「确定」为 true；取消 / 超时 / 窗口不在 / 窗口销毁均为 false
 */
export function requestConfirm(
  sender: Electron.WebContents | null,
  payload: ConfirmAskPayload
): Promise<boolean> {
  if (!sender || sender.isDestroyed()) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const id = registerPending(
      confirmPending,
      sender.id,
      (r) => resolve(r === true),
      DIALOG_REQUEST_TIMEOUT_MS
    );
    try {
      sender.send('app:confirm:show', {
        id,
        message: payload.message || '',
        title: payload.title || '',
        danger: !!payload.danger,
      });
    } catch (e) {
      // send 抛错（窗口正在销毁）→ 立刻落地，不留悬挂
      const p = takePending(confirmPending, id);
      if (p) {
        clearTimeout(p.timer);
        resolve(false);
      }
      console.warn('[dialogBridge] 推送确认框失败：', e);
    }
  });
}

/**
 * 弹一个自绘文件选择器并等待用户选择。
 *
 * @param sender 发起方 webContents
 * @param payload 模式 / 过滤规则 / 默认文件名 / 起始目录
 * @returns 选中的绝对路径数组（directory/open 单选时长度为 1）；
 *          取消 / 超时 / 窗口不在为 null。注意与旧实现的 `null` 语义一致，
 *          渲染层现有的 `if (!paths) return;` 判断无需改动。
 */
export function requestFilePick(
  sender: Electron.WebContents | null,
  payload: FilePickPayload
): Promise<string[] | null> {
  if (!sender || sender.isDestroyed()) return Promise.resolve(null);
  return new Promise<string[] | null>((resolve) => {
    const id = registerPending(
      pickPending,
      sender.id,
      (r) => resolve(Array.isArray(r) ? (r as string[]) : null),
      DIALOG_REQUEST_TIMEOUT_MS
    );
    // save 模式的「自动防覆盖改名」：把 unique 标记透给渲染层，
    // 渲染层在同名文件存在时自动追加 (1)(2)…，与旧 backup:pickTarget 行为一致
    const startDir = payload.startDir || lastDirByWindow.get(sender.id) || '';
    try {
      sender.send('app:filepick:show', {
        id,
        kind: payload.kind,
        title: payload.title || '',
        filters: payload.filters || [],
        multiple: !!payload.multiple,
        defaultName: payload.defaultName || '',
        startDir,
        unique: !!payload.unique,
      });
    } catch (e) {
      const p = takePending(pickPending, id);
      if (p) {
        clearTimeout(p.timer);
        resolve(null);
      }
      console.warn('[dialogBridge] 推送文件选择器失败：', e);
    }
  });
}

/**
 * 主进程主动弹确认框（`confirmFromMain`：后台自动生图/生视频前的许可询问）。
 * 与 `requestConfirm` 的区别只是发起方是主进程自己 —— 这里固定弹在主窗口。
 */
export function requestConfirmFromMain(payload: ConfirmAskPayload): Promise<boolean> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.isMinimized());
  const target = win || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!target) return Promise.resolve(false);
  return requestConfirm(target.webContents, payload);
}

// ============================================================================
// IPC 注册
// ============================================================================

/** 当前应用数据目录（惰性取，避免模块加载期 dm 未初始化的时序问题） */
let dataDirProvider: (() => string | null) | null = null;
/** 由 main.ts 在 dm 就绪后注入 */
export function setDataDirProvider(fn: () => string | null): void {
  dataDirProvider = fn;
}

/**
 * 注册自绘弹窗所需的全部 IPC。
 * 由 main.ts 在 `app.whenReady()` 之后调用一次。
 */
export function registerDialogIpc(): void {
  // ---------- 确认框：渲染层 17 处调用点（签名不变，仍是 invoke）----------
  ipcMain.handle('app:confirm', async (e, message: string, title?: string) => {
    return requestConfirm(e.sender, { message, title });
  });

  // ---------- 文件选择器 9 处（channel 名与返回结构全部不变）----------
  // 渲染层拿到的仍是 `string[] | null`（多选图片）、`string | null`（单选）、
  // `string | null`（另存为），因此 30+ 处 pick* 调用点零改动。
  ipcMain.handle('dialog:pickImage', async (e) => {
    return requestFilePick(e.sender, {
      kind: 'open',
      multiple: true,
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
  });

  ipcMain.handle('file:pickText', async (e, filters) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'open',
      multiple: false,
      title: '选择文本文件',
      filters:
        filters && filters.length
          ? filters
          : [{ name: '文本 / 角色卡', extensions: ['json', 'txt', 'md', 'yaml', 'yml'] }],
    });
    if (!picked || !picked[0]) return null;
    const p = picked[0];
    rememberDir(e.sender.id, p);
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return { path: p, content };
    } catch (err) {
      console.error('读取文本文件失败', err);
      return null;
    }
  });

  ipcMain.handle('sound:pick', async (e) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'open',
      multiple: false,
      title: '选择音效文件',
      filters: [{ name: '音效文件 (MP3 / WAV)', extensions: ['mp3', 'wav'] }],
    });
    if (!picked || !picked[0]) return null;
    rememberDir(e.sender.id, picked[0]);
    return picked[0];
  });

  ipcMain.handle('character:importCard', async (e) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'open',
      multiple: false,
      title: '选择角色卡',
      filters: [{ name: '角色卡 (JSON / PNG)', extensions: ['json', 'png', 'txt', 'card', 'chara'] }],
    });
    if (!picked || !picked[0]) return null;
    const p = picked[0];
    rememberDir(e.sender.id, p);
    // ↓↓↓ 以下解析逻辑与旧实现逐字一致（v2.3.97 只替换了「怎么选文件」）↓↓↓
    return importCharacterCardFrom(p);
  });

  ipcMain.handle('file:saveText', async (e, content: string, defaultName?: string) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'save',
      title: '保存文本',
      defaultName: defaultName || 'export.txt',
      // 另存为默认落在数据目录旁边，用文档目录更符合直觉
      startDir: safeParent(defaultName || '') || undefined,
      filters: [{ name: '文本', extensions: ['txt'] }],
    });
    if (!picked || !picked[0]) return null;
    const dest = picked[0];
    rememberDir(e.sender.id, dest);
    try {
      fs.writeFileSync(dest, content || '', 'utf-8');
      return dest;
    } catch (err) {
      console.error('保存文本文件失败', err);
      return null;
    }
  });

  ipcMain.handle('backup:pickTarget', async (e) => {
    const s = backupSettingsProvider ? backupSettingsProvider() : null;
    const fileName = backupNameProvider ? backupNameProvider() : 'nianyu-backup.zip';
    const defaultPath = s && s.backupDir && fs.existsSync(s.backupDir) ? path.join(s.backupDir, fileName) : fileName;
    const picked = await requestFilePick(e.sender, {
      kind: 'save',
      title: '选择备份保存位置',
      defaultName: path.basename(defaultPath),
      startDir: path.dirname(path.resolve(defaultPath)),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
      unique: true,
    });
    if (!picked || !picked[0]) return null;
    rememberDir(e.sender.id, picked[0]);
    return picked[0];
  });

  ipcMain.handle('backup:pickDir', async (e) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'directory',
      title: '选择默认备份目录',
    });
    if (!picked || !picked[0]) return null;
    rememberDir(e.sender.id, picked[0]);
    return picked[0];
  });

  ipcMain.handle('backup:pickFile', async (e) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'open',
      multiple: false,
      title: '选择备份文件',
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (!picked || !picked[0]) return null;
    rememberDir(e.sender.id, picked[0]);
    return picked[0];
  });

  ipcMain.handle('data:pickDir', async (e) => {
    const picked = await requestFilePick(e.sender, {
      kind: 'directory',
      title: '选择应用数据保存目录',
      startDir: dataDirProvider?.() || undefined,
    });
    if (!picked || !picked[0]) return null;
    rememberDir(e.sender.id, picked[0]);
    return picked[0];
  });

  // ---------- 目录列表（自绘文件选择器的数据源）----------
  ipcMain.handle('fs:listDir', async (_e, p?: { dir?: string }) => {
    const dataDir = dataDirProvider?.() || null;
    const requested = p?.dir ? String(p.dir) : dataDir || app.getPath('documents');
    const listing = await listDirectory(requested, dataDir);
    // 记住浏览位置（仅成功时），下次打开选择器从这里开始
    if (!listing.error) lastDirByWindow.set(_e.sender.id, listing.cwd);
    return listing;
  });

  // ---------- 新建文件夹（补回旧 createDirectory 能力）----------
  // ⚠️ 写操作，校验全部在 makeDirectory 内（三层，见其注释）。
  // 只在「选目录」场景暴露：选文件/另存为时用不到新建文件夹按钮。
  ipcMain.handle('fs:makeDir', (_e, p: { parentDir: string; name: string }) => {
    try {
      return makeDirectory(String(p?.parentDir || ''), String(p?.name || ''));
    } catch (e) {
      // 理论上不会走到这里（makeDirectory 内部全try），兜底防止主进程被打挂
      console.error('[dialogBridge] fs:makeDir 异常', e);
      return { ok: false, error: 'MAKE_FAILED' } as MakeDirResult;
    }
  });

  // ---------- 回传通道 ----------
  ipcMain.on('app:confirm:reply', (_e, payload: { id: number; ok: boolean }) => {
    if (!payload || typeof payload.id !== 'number') return;
    const p = takePending(confirmPending, payload.id);
    if (!p) return;
    p.settle(!!payload.ok);
  });

  ipcMain.on('app:filepick:reply', (_e, payload: { id: number; paths: string[] | null }) => {
    if (!payload || typeof payload.id !== 'number') return;
    const p = takePending(pickPending, payload.id);
    if (!p) return;
    p.settle(Array.isArray(payload.paths) ? payload.paths : null);
  });

  // ---------- 窗口销毁：立刻落地该窗口所有 pending，不等 60s 超时 ----------
  const dropOwner = (wcId: number): void => clearPendingForOwner(wcId);
  app.on('web-contents-created', (_evt, contents) => {
    contents.once('destroyed', () => dropOwner(contents.id));
  });
}

/** 记住某窗口最后浏览/选择的目录（下次打开选择器作为起点） */
function rememberDir(ownerId: number, p: string): void {
  try {
    const dir = fs.statSync(p).isDirectory() ? p : path.dirname(p);
    lastDirByWindow.set(ownerId, dir);
  } catch {
    /* 文件可能已被删除，忽略 */
  }
}

// ============================================================================
// 由 main.ts 注入的依赖（避免本模块反向依赖 db / backup 造成循环 import）
// ============================================================================

type BackupSettingsLike = { backupDir?: string | null } | null;

/** 取设置里的 backupDir（备份相关选择器的起点） */
export let backupSettingsProvider: (() => BackupSettingsLike) | null = null;
/** 生成备份文件名 */
export let backupNameProvider: (() => string) | null = null;
/** 解析角色卡文件（复用 main.ts 里既有的实现，避免逻辑二次实现走偏） */
export let characterCardImporter: ((p: string) => Promise<unknown>) | null = null;

export function setBackupProviders(
  settings: () => BackupSettingsLike,
  name: () => string
): void {
  backupSettingsProvider = settings;
  backupNameProvider = name;
}

/** 角色卡导入：由 main.ts 注入其既有实现（`importCharacterCardFrom`） */
function importCharacterCardFrom(p: string): Promise<unknown> {
  if (characterCardImporter) return characterCardImporter(p);
  return Promise.resolve(null);
}

export function setCharacterCardImporter(fn: (p: string) => Promise<unknown>): void {
  characterCardImporter = fn;
}