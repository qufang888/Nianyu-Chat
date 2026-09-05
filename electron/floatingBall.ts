import { BrowserWindow, screen, ipcMain, app } from 'electron';
import path from 'node:path';
import { getDataManager } from './db';

// ===================== 桌面悬浮球 =====================
// 独立 BrowserWindow 实例（与主窗口进程分离）：无边框、透明、置顶、跳过任务栏、不可缩放、禁用系统移动。
// 拖拽完全由渲染端 JS 基于屏幕逻辑坐标（CSS 像素，DPI 无关）增量计算，禁止 -webkit-app-region: drag，
// 杜绝无边框透明窗拖拽跳动/瞬移。
// 交互区域：透明窗配合 setIgnoreMouseEvents(true,{forward:true})，透明像素穿透到下层窗口，
// 仅悬浮球本体（不透明）与未读面板（不透明）可交互，无死区、无遮挡。

const dm = getDataManager();

let ballWindow: BrowserWindow | null = null;
let sessionClosed = false; // 本次运行用户手动关闭悬浮球（不持久化，重启恢复）
let mainShowFn: (() => void) | null = null; // 由 main.ts 注入：唤出主窗口
let mainWinRef: BrowserWindow | null = null; // 由 main.ts 注入：主窗口引用（用于跳转会话）
let activeChatKey = ''; // 由渲染端回传：用户当前正在查看的聊天 `${type}:${id}`

// 悬浮球当前屏幕逻辑坐标（由本模块权威维护，拖拽增量累加，避免渲染端反查坐标）
let ballX = 0;
let ballY = 0;

// 拖拽状态：主进程轮询系统光标直接定位窗口，窗口始终贴合光标，杜绝滞后与粘滞
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
let dragMaxDisp = 0;
const DRAG_CLAMP = 64; // 悬浮球本体尺寸，钳制时以本体右下角为准

export function setBallMainShow(fn: () => void): void {
  mainShowFn = fn;
}
export function setBallMainWindow(win: BrowserWindow | null): void {
  mainWinRef = win;
}

// 渲染端切换当前聊天时回传，用于判断「主动消息」是否应计入未读
export function setActiveChat(type: string, id: string): void {
  activeChatKey = `${type}:${id}`;
  // 用户打开某会话即视为已读：清除该会话在悬浮球清单中的未读，避免「已读残留」。
  // 同模块内可直接调用 clearUnreadForChat（仅在该会话确有未读时才会触发广播，无未读则为空操作）。
  clearUnreadForChat(type, id);
}

// ===== 未读消息存储（主进程权威数据源）=====
export interface UnreadItem {
  key: string; // `${chatType}:${chatId}`
  chatType: string;
  chatId: string;
  roleName: string; // 发送者（数字人）
  content: string; // 最新一条未读内容
  avatar: string; // 头像本地路径（渲染端经 getImage 解析）
  count: number; // 该会话累计未读数
  ts: number;
}

const unreadMap = new Map<string, UnreadItem>();

export function getUnreadList(): UnreadItem[] {
  return [...unreadMap.values()].sort((a, b) => b.ts - a.ts);
}
export function getUnreadCount(): number {
  let n = 0;
  for (const it of unreadMap.values()) n += it.count;
  return n;
}

function broadcastUnread(): void {
  const items = getUnreadList();
  const payload = { count: getUnreadCount(), items };
  // 给悬浮球窗口单独推送（其余窗口不需要）
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('ball:unread', payload);
  }
}

// 新增一条未读。fromProactive=true 表示这是角色「主动消息」回复（用户并未发消息请求）：
// 此类回复只要用户没正盯着该聊天本身，就计入未读（窗口隐藏 / 在看别的聊天都算）；
// 手动回复（fromProactive=false）维持原行为：仅主窗隐藏/最小化时才计未读。
export function pushUnread(
  chatType: string,
  chatId: string,
  roleName: string,
  content: string,
  avatar: string
): void {
  const settings = dm.getSettings();
  if (settings.floatingBall?.enabled === false) return; // 未启用悬浮球则不维护未读
  const mainVisible =
    mainWinRef && !mainWinRef.isDestroyed() && mainWinRef.isVisible() && !mainWinRef.isMinimized();
  // 类 IM 未读：仅当用户此刻正盯着该聊天本身（主窗可见且为当前会话）时视为已读；
  // 其余情况（主窗隐藏 / 在看别的聊天 / 手动回复 / 主动消息）均计入未读，悬浮球面板即可看到未读消息。
  const viewingThis = mainVisible && activeChatKey === `${chatType}:${chatId}`;
  if (viewingThis) return;
  const key = `${chatType}:${chatId}`;
  const existing = unreadMap.get(key);
  if (existing) {
    existing.count += 1;
    existing.content = content;
    existing.roleName = roleName;
    existing.avatar = avatar;
    existing.ts = Date.now();
  } else {
    unreadMap.set(key, {
      key,
      chatType,
      chatId,
      roleName,
      content: content || '',
      avatar: avatar || '',
      count: 1,
      ts: Date.now(),
    });
  }
  broadcastUnread();
}

// 打开某会话：清除该会话未读 + 唤出主窗并跳转
export function clearUnreadForChat(chatType: string, chatId: string): void {
  const key = `${chatType}:${chatId}`;
  if (unreadMap.delete(key)) broadcastUnread();
}
export function clearAllUnread(): void {
  if (unreadMap.size === 0) return;
  unreadMap.clear();
  broadcastUnread();
}

// ===== 悬浮球窗口创建 =====
export function createFloatingBall(): void {
  if (ballWindow && !ballWindow.isDestroyed()) return;
  if (sessionClosed) return; // 本次运行已手动关闭，重启前不再创建
  const settings = dm.getSettings();
  if (settings.floatingBall?.enabled === false) return; // 设置中关闭则不创建
  const aot = settings.floatingBall?.alwaysOnTop !== false; // 默认置顶

  const saved = settings.floatingBall || { enabled: true, x: 0, y: 0 };
  // 窗口逻辑尺寸：悬浮球本体 64x64，未读面板向下展开（透明区穿透，不占死区）
  const SIZE = 64;
  const WIN_W = 320;
  const WIN_H = 460;
  const primary = screen.getPrimaryDisplay().workArea;
  let x = saved.x;
  let y = saved.y;
  if (!x && !y) {
    // 默认位置：主屏右下角（留 24px 边距）
    x = primary.x + primary.width - SIZE - 24;
    y = primary.y + primary.height - SIZE - 24;
  }
  // 钳制到可视工作区，避免初始位置跑到屏幕外
  x = Math.max(primary.x + 4, Math.min(x, primary.x + primary.width - SIZE - 4));
  y = Math.max(primary.y + 4, Math.min(y, primary.y + primary.height - SIZE - 4));
  ballX = x;
  ballY = y;

  ballWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false, // 无边框
    transparent: true, // 透明背景
    backgroundColor: '#00000000',
    alwaysOnTop: aot, // 置顶由设置驱动（默认开）
    skipTaskbar: true, // 跳过任务栏
    resizable: false, // 不可缩放
    movable: false, // 禁用系统默认移动（拖拽完全由 JS 计算）
    hasShadow: false,
    roundedCorners: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // 透明窗默认整体穿透鼠标，仅不透明区域（球/面板）由渲染端动态切回可交互
  ballWindow.setIgnoreMouseEvents(true, { forward: true });

  const dev = process.env.NIANYU_DEV === '1';
  if (dev) ballWindow.loadURL(`${'http://localhost:5173'}/floating-ball.html`);
  else ballWindow.loadFile(path.join(__dirname, '../../dist/floating-ball.html'));

  ballWindow.once('ready-to-show', () => {
    if (ballWindow && !ballWindow.isDestroyed()) ballWindow.showInactive(); // 不抢焦点
    broadcastUnread(); // 首屏推送当前未读
  });

  ballWindow.on('closed', () => {
    ballWindow = null;
  });

  // 失去焦点时让渲染端收起未读菜单（点击外部关闭）
  ballWindow.on('blur', () => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.webContents.send('ball:blur');
    }
  });
}

export function destroyFloatingBall(): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.destroy();
  ballWindow = null;
}

// 切换悬浮球置顶并持久化（保留位置与启用状态）
export function setBallAlwaysOnTop(v: boolean): void {
  const s = dm.getSettings();
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.setAlwaysOnTop(v);
  dm.saveSettings({
    floatingBall: { enabled: s.floatingBall?.enabled !== false, x: Math.round(ballX), y: Math.round(ballY), alwaysOnTop: v },
  });
}

// 主窗口全屏时隐藏、退出全屏时恢复（由 main.ts 监听主窗口 fullscreen 事件调用）
export function hideFloatingBall(): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.hide();
}
export function showFloatingBall(): void {
  const s = dm.getSettings();
  if (s.floatingBall?.enabled === false) return;
  if (sessionClosed) return;
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.showInactive();
}

// 保存悬浮球停留位置
function saveBallPos(): void {
  dm.saveSettings({ floatingBall: { enabled: true, x: Math.round(ballX), y: Math.round(ballY) } });
}

// ===== 悬浮球相关 IPC =====
export function registerBallIPC(): void {
  // 拖拽开始：渲染端传入指针在窗口内的抓取偏移（gx,gy），主进程轮询系统光标直接定位窗口
  ipcMain.on('ball:drag-start', (_e, gx: number, gy: number) => {
    if (!ballWindow || ballWindow.isDestroyed()) return;
    // 拖拽期间整窗可交互，确保持续接收鼠标事件（窗口始终贴合光标，指针不会移出边界）
    ballWindow.setIgnoreMouseEvents(false);
    dragOffsetX = gx;
    dragOffsetY = gy;
    dragStartX = ballX;
    dragStartY = ballY;
    dragMaxDisp = 0;
    if (dragTimer) clearInterval(dragTimer);
    const primary = screen.getPrimaryDisplay().workArea;
    dragTimer = setInterval(() => {
      if (!ballWindow || ballWindow.isDestroyed()) return;
      const cur = screen.getCursorScreenPoint();
      let nx = cur.x - dragOffsetX;
      let ny = cur.y - dragOffsetY;
      nx = Math.max(primary.x + 4, Math.min(nx, primary.x + primary.width - DRAG_CLAMP - 4));
      ny = Math.max(primary.y + 4, Math.min(ny, primary.y + primary.height - DRAG_CLAMP - 4));
      ballX = nx;
      ballY = ny;
      ballWindow.setPosition(Math.round(nx), Math.round(ny));
      dragMaxDisp = Math.max(dragMaxDisp, Math.abs(nx - dragStartX) + Math.abs(ny - dragStartY));
    }, 16);
  });

  // 拖拽结束：停止轮询并持久化；返回是否发生过有效位移（用于区分点击与拖拽）
  ipcMain.handle('ball:drag-end', () => {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    saveBallPos();
    return dragMaxDisp > 4;
  });

  // 渲染端在悬浮球/面板上方时关闭鼠标穿透（可交互），离开时重新开启穿透
  ipcMain.on('ball:ignore', (_e, ignore: boolean) => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
  });

  // 左键点击：呼出主界面（不清未读；未读只在该聊天被真正打开时清除）
  ipcMain.on('ball:activate', () => {
    mainShowFn?.();
  });

  // 右键退出：安全销毁所有窗口并退出
  ipcMain.on('ball:quit', () => {
    app.quit();
  });

  // 本次关闭悬浮球：仅销毁窗口、记录会话级关闭标记，不改动设置（重启后按设置恢复）
  ipcMain.on('ball:close-session', () => {
    sessionClosed = true;
    destroyFloatingBall();
  });

  // 切换悬浮球置顶
  ipcMain.on('ball:set-always-on-top', (_e, v: boolean) => {
    setBallAlwaysOnTop(!!v);
  });

  // 渲染端请求拉取未读列表
  ipcMain.handle('ball:get-unread', () => ({
    count: getUnreadCount(),
    items: getUnreadList(),
  }));
}
