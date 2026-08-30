import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  screen,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDataManager, defaultDataDirPath } from './db';
import {
  queryAI,
  aiCompleteRole,
  listModels,
  testConnection,
  AIMessage,
  ContentPart,
  streamAI,
  transcribeAudio,
  textToSpeech,
  generateImage,
  generateVideo,
  setDeepThinkLevel,
  ModelErrorInfo,
  ModelApiError,
} from './ai';
import { createBackup, restoreBackup } from './backup';
import { parseCharacterCard, parseCharacterCardText } from '../src/utils/characterCard';
import { diagnoseError } from '../src/utils/errorDiagnosis';
import type {
  Role,
  ChatMessage,
  SendMessageResult,
  ModelConfig,
  AppSettings,
  SelfRole,
  WorldBook,
  Rule,
  MemoryEntry,
  Group,
  Plugin,
  PluginTool,
} from '../src/types';
import { normalizeRelation } from '../src/types';
import { RELATION_TYPES, RELATION_LABELS } from '../src/types';
import {
  createFloatingBall,
  destroyFloatingBall,
  registerBallIPC,
  setBallMainShow,
  setBallMainWindow,
  pushUnread,
  clearAllUnread,
  clearUnreadForChat,
  showFloatingBall,
  hideFloatingBall,
  setActiveChat,
} from './floatingBall';

// 媒体生成（生图/生视频）完成写入 AI 消息后补未读：仅主窗不可见 / 未正盯该聊天时计入，
// 防止「结果已生成但悬浮球未读清单没显示」。头像按聊天类型解析（单聊取角色，群聊无头像留空）。
// 内容用占位文案，渲染端点击未读项跳回对应聊天即可看到实际图片/视频。
function pushMediaUnread(chatType: string, chatId: string, aiName: string, kind: 'image' | 'video'): void {
  const settings = dm.getSettings();
  if (settings.floatingBall?.enabled === false) return;
  const content = kind === 'image' ? '[图片]' : '[视频]';
  let avatar = '';
  if (chatType === 'single') {
    const rid = dm.resolveSingleRoleId(chatType, chatId);
    avatar = (rid && dm.getRole(rid)?.avatar_path) || '';
  }
  pushUnread(chatType, chatId, aiName, content, avatar, true);
  // 后台消息提醒卡片：主窗/小窗均隐藏时由 showNotifyCard 内部判断并弹出（与渲染端互补，覆盖未挂载聊天）
  try {
    const name =
      chatType === 'group'
        ? ((dm.getGroup(chatId)?.group_name as string) || chatId)
        : ((dm.getRole(chatId)?.name as string) || chatId);
    showNotifyCard({ chatType, chatId, name, roleName: aiName, content });
  } catch {
    /* 通知卡片失败不影响消息下发 */
  }
}

// 自定义音效协议：用于播放用户选择的 MP3/WAV（映射到 userData/custom-sounds）
// 必须在 app ready 之前注册为特权协议，才能被 <audio> 正常加载。
protocol.registerSchemesAsPrivileged([
  { scheme: 'nysound', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

// 禁用若干 Chromium 媒体/GPU 子功能。本应用无视频播放，这些功能初始化时
// 常会在 Windows 显卡驱动上触发 [ERROR:ffmpeg_common.cc(965)] Unsupported pixel format: -1 日志。
// 提前关闭它们可避免终端/调试窗口被此类无意义错误刷屏。
app.commandLine.appendSwitch(
  'disable-features',
  'HardwareMediaKeyHandling,MediaSessionService,AudioServiceOutOfProcess'
);

// 修复 Windows 上 Chromium 缓存目录拒绝访问 / GPU 磁盘缓存创建失败的问题
// (cache_util_win.cc:20 Unable to move the cache + gpu_disk_cache.cc:713 Gpu Cache Creation failed)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-dir', path.join(app.getPath('userData'), 'Cache'));

let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const dm = getDataManager();

// ===== 单实例锁：保证念语全局只有一个客户端在运行 =====
// 已有一个实例时，重复点击启动文件/快捷方式只会把已有窗口聚焦到前台，而不是再开一个新进程。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 未取得锁：说明已有实例在运行，本进程直接退出，由已有实例接管。
  app.quit();
} else {
  app.on('second-instance', (_e, _argv) => {
    // 已有实例收到二次启动：把主窗口唤到前台并聚焦（若已最小化则还原）。
    showMainWindow();
  });
}

// 后台消息提醒（Steam 风格卡片）相关状态
let notifyWindow: BrowserWindow | null = null;
let notifyReady = false;
let currentNotify: any = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const notifyQueue: any[] = [];
let lastNotifySig = '';
let lastNotifyTime = 0;

const DEV_SERVER = 'http://localhost:5173';

type Lang = 'zh' | 'en';

const MENU_LABELS: Record<Lang, Record<string, string>> = {
  zh: {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    reload: '重新加载',
    forceReload: '强制刷新',
    toggleDevTools: '开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullscreen: '全屏',
    minimize: '最小化',
    close: '关闭',
    about: '关于 念语',
    learnMore: '了解更多',
  },
  en: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullscreen: 'Toggle Fullscreen',
    minimize: 'Minimize',
    close: 'Close',
    about: 'About Nianyu',
    learnMore: 'Learn More',
  },
};

function buildMenu(lang: Lang = 'zh'): Menu {
  const l = MENU_LABELS[lang];
  const isMac = process.platform === 'darwin';
  const appName = '念语';
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { label: l.about, role: 'about' },
        { type: 'separator' },
        { label: l.close, role: 'close' },
      ],
    });
  }

  template.push({
    label: l.file,
    submenu: [isMac ? { label: l.close, role: 'close' } : { label: l.close, role: 'quit' }],
  });

  template.push({
    label: l.edit,
    submenu: [
      { label: l.undo, role: 'undo' },
      { label: l.redo, role: 'redo' },
      { type: 'separator' },
      { label: l.cut, role: 'cut' },
      { label: l.copy, role: 'copy' },
      { label: l.paste, role: 'paste' },
      { label: l.selectAll, role: 'selectAll' },
    ],
  });

  template.push({
    label: l.view,
    submenu: [
      { label: l.reload, role: 'reload' },
      { label: l.forceReload, role: 'forceReload' },
      { label: l.toggleDevTools, role: 'toggleDevTools' },
      { type: 'separator' },
      { label: l.actualSize, role: 'resetZoom' },
      { label: l.zoomIn, role: 'zoomIn' },
      { label: l.zoomOut, role: 'zoomOut' },
      { type: 'separator' },
      { label: l.toggleFullscreen, role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: l.window,
    submenu: [
      { label: l.minimize, role: 'minimize' },
      { label: l.close, role: 'close' },
    ],
  });

  template.push({
    label: l.help,
    submenu: [
      {
        label: l.about,
        click: () => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('app:showAbout');
          }
        },
      },
      {
        label: l.learnMore,
        click: async () => {
          const { shell } = await import('electron');
          shell.openExternal('https://github.com');
        },
      },
    ],
  });

  return Menu.buildFromTemplate(template);
}

let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveBounds(): void {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    const w = mainWindow;
    if (!w || w.isDestroyed()) return;
    // 同样使用 getNormalBounds()：窗口最大化时存盘的是「还原后」的尺寸，避免保存成全屏大小
    const b = (w as any).getNormalBounds ? (w as any).getNormalBounds() : w.getBounds();
    dm.saveSettings({
      windowBounds: {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        isMaximized: w.isMaximized(),
      },
    });
  }, 400);
}

// 窗口整体 UI 等比缩放：窗口尺寸变化时，以基准设计尺寸为参照，按「宽/高缩放比取较小值」统一缩放整个页面
// （字体、间距、图标、边框一并等比缩放），使内部内容随窗口大小成比例适配，而非仅 flex 重排。
// 关键：缩放因子基于 getBounds() 返回的设备像素（不受 zoom 影响），因此不会形成反馈回路。
// 基准尺寸与上下限为硬编码可调值：主窗 1200×800（0.85~1.3），小窗 340×520（0.75~1.8）。
// 从设置读取缩放基准与上下限（旧设置缺省时回退到内置默认值，保证不崩）
function getZoomCfg(isMini: boolean): { baseW: number; baseH: number; min: number; max: number } {
  const s = dm.getSettings().uiZoom;
  if (!s) {
    return isMini
      ? { baseW: 340, baseH: 520, min: 0.75, max: 1.8 }
      : { baseW: 1200, baseH: 800, min: 0.85, max: 1.3 };
  }
  return isMini
    ? { baseW: s.miniBaseW, baseH: s.miniBaseH, min: s.miniMin, max: s.miniMax }
    : { baseW: s.mainBaseW, baseH: s.mainBaseH, min: s.mainMin, max: s.mainMax };
}

function applyWindowZoom(win: BrowserWindow | null, isMini: boolean): void {
  if (!win || win.isDestroyed()) return;
  const { baseW, baseH, min, max } = getZoomCfg(isMini);
  const b = win.getBounds();
  const z = Math.min(b.width / baseW, b.height / baseH);
  const clamped = Math.max(min, Math.min(max, z));
  try {
    win.webContents.setZoomFactor(clamped);
  } catch {
    // webContents 尚未就绪时静默忽略
  }
}

const zoomTimers = new Map<number, ReturnType<typeof setTimeout>>();
function scheduleWindowZoom(win: BrowserWindow | null, isMini: boolean): void {
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  const existing = zoomTimers.get(id);
  if (existing) clearTimeout(existing);
  zoomTimers.set(
    id,
    setTimeout(() => {
      zoomTimers.delete(id);
      applyWindowZoom(win, isMini);
    }, 60),
  );
}

// 仅进程冷启动播放开屏；窗口被销毁后由 showMainWindow 重建时（托盘/悬浮球唤出）带 ?nosplash=1，不重播。
let firstWindowEver = true;

function createWindow(opts?: { coldStart?: boolean }): void {
  const coldStart = opts?.coldStart ?? firstWindowEver;
  firstWindowEver = false;
  const saved = dm.getSettings();
  const b = saved.windowBounds || { x: 0, y: 0, width: 1200, height: 800 };
  // 解构出 isMaximized（不传给 BrowserWindow 构造选项，避免无关参数），其余作为窗口位置/尺寸
  const { isMaximized: _max, ...bounds } = b;
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1000,
    minHeight: 700,
    icon: getAppIcon(),
    // ===== 无边框自定义窗口 =====
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000', // 全透明背景，支撑毛玻璃半透明与圆角
    roundedCorners: true, // Windows 11 原生圆角
    hasShadow: true, // 保留窗口阴影
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // 托盘/隐藏状态下仍需保持主动消息定时器运行
    },
  });

  const splashQuery = coldStart ? '' : '?nosplash=1';
  if (process.env.NIANYU_DEV === '1') {
    mainWindow.loadURL(`${DEV_SERVER}${splashQuery}`);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, '../../dist/index.html'),
      splashQuery ? { search: splashQuery } : {}
    );
  }
  // 同步悬浮球模块持有的主窗引用（主窗可能被 recreate，需刷新）
  setBallMainWindow(mainWindow);

  // 关闭默认不退出：隐藏到托盘；仅 quitting 时真正关闭
  mainWindow.on('close', (e) => {
    // getNormalBounds() 返回窗口未最大化时的尺寸（恢复尺寸），避免把最大化时的全屏尺寸当作「正常大小」存盘
    const cur = (mainWindow as any)?.getNormalBounds
      ? (mainWindow as any).getNormalBounds()
      : mainWindow?.getBounds();
    if (cur) {
      dm.saveSettings({
        windowBounds: {
          x: cur.x,
          y: cur.y,
          width: cur.width,
          height: cur.height,
          isMaximized: mainWindow?.isMaximized() || false,
        },
      });
    }
    if (!quitting) {
      // 关闭行为设置：true=最小化到托盘继续运行；false=直接退出程序（即时生效，读取实时设置）
      const closeToTray = dm.getSettings().closeToTray !== false;
      if (closeToTray) {
        e.preventDefault();
        mainWindow?.hide();
      }
      // 否则不拦截，窗口按默认行为关闭（window-all-closed 触发 app.quit）
    }
  });

  // 最小化时按需弹出小窗
  mainWindow.on('minimize', () => {
    const s = dm.getSettings();
    if (s.miniWindow?.enabled && s.miniWindow?.autoPopupOnMinimize) {
      showMiniWindow();
    }
  });

  // 最大化/还原：推送状态给渲染端 + 持久化
  const pushWindowState = () => {
    const w = mainWindow;
    if (!w || w.isDestroyed()) return;
    w.webContents.send('window-state-change', w.isMaximized());
    scheduleSaveBounds();
  };
  mainWindow.on('maximize', pushWindowState);
  mainWindow.on('unmaximize', pushWindowState);
  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);
  // 主窗口全屏：按设置自动隐藏/恢复悬浮球（避免遮挡全屏内容）
  mainWindow.on('enter-full-screen', () => {
    const s = dm.getSettings();
    if (s.floatingBall?.autoHideInFullscreen !== false) hideFloatingBall();
  });
  mainWindow.on('leave-full-screen', () => {
    const s = dm.getSettings();
    if (s.floatingBall?.autoHideInFullscreen !== false) showFloatingBall();
  });
  // 主窗整体 UI 随窗口尺寸等比缩放（字体/间距/图标一并缩放），适配不同窗口大小
  mainWindow.on('resize', () => scheduleWindowZoom(mainWindow, false));
  // 注意:'closed' 事件触发时 BrowserWindow 已被销毁,访问 webContents 会抛 "Object has been destroyed"。
  // 必须在窗口创建时即缓存 webContents.id,closed 处理中只用该缓存值。
  const mainWindowWcId = mainWindow.webContents.id;
  mainWindow.on('closed', () => {
    clearAutoChatDriverByWindow(mainWindowWcId, 'closed');
    clearGroupEditorLockByWindow(mainWindowWcId);
  });

  // 还原最大化状态
  mainWindow.once('ready-to-show', () => {
    if (b.isMaximized) mainWindow?.maximize();
  });
  // 首次加载完成后推送初始窗口状态（最大化/还原图标同步）
  mainWindow.webContents.once('did-finish-load', () => {
    safeSend(mainWindow, 'window-state-change', mainWindow ? mainWindow.isMaximized() : false);
    // 首屏加载完成后按当前窗口尺寸设定初始缩放
    applyWindowZoom(mainWindow, false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 真正退出时销毁隐藏的小窗，让 window-all-closed 正常触发
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.destroy();
      miniWindow = null;
    }
  });
}

// ---------- 快捷聊天小窗 ----------
function createMiniWindow(): void {
  const s = dm.getSettings();
  miniWindow = new BrowserWindow({
    width: 340,
    height: 520,
    minWidth: 280,
    minHeight: 380,
    icon: getAppIcon(),
    // 与主窗一致的无边框 + 透明 + 圆角 + 阴影
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000',
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: s.miniWindow?.alwaysOnTop !== false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // 隐藏/后台状态下保持主动消息与随机事件定时器运行
    },
  });

  if (process.env.NIANYU_DEV === '1') {
    miniWindow.loadURL(`${DEV_SERVER}/#mini`);
  } else {
    miniWindow.loadFile(path.join(__dirname, '../../dist/index.html'), { hash: 'mini' });
  }

  // 关闭仅隐藏，不退出
  miniWindow.on('close', (e) => {
    if (!quitting && miniWindow && !miniWindow.isDestroyed()) {
      e.preventDefault();
      miniWindow.hide();
    }
  });
  // 注意:'closed' 事件触发时 BrowserWindow 已被销毁,访问 webContents 会抛 "Object has been destroyed"。
  // 必须在窗口创建时即缓存 webContents.id,closed 处理中只用该缓存值。
  const miniWindowWcId = miniWindow.webContents.id;

  // 边缘吸附：靠近屏幕边缘 12px 内自动贴边
  miniWindow.on('moved', () => {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    const b = miniWindow.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const SNAP = 12;
    let { x, y } = b;
    if (Math.abs(x - wa.x) < SNAP) x = wa.x;
    if (Math.abs(x + b.width - (wa.x + wa.width)) < SNAP) x = wa.x + wa.width - b.width;
    if (Math.abs(y - wa.y) < SNAP) y = wa.y;
    if (Math.abs(y + b.height - (wa.y + wa.height)) < SNAP) y = wa.y + wa.height - b.height;
    if (x !== b.x || y !== b.y) miniWindow.setPosition(x, y);
  });

  // 小窗整体 UI 随窗口尺寸等比缩放（字体/间距/图标一并缩放），缩放因子基于窗口真实像素、无反馈回路
  miniWindow.on('resize', () => scheduleWindowZoom(miniWindow, true));
  miniWindow.webContents.once('did-finish-load', () => applyWindowZoom(miniWindow, true));

  // 有交互时恢复不透明
  miniWindow.on('focus', () => miniWindow?.setOpacity(1));

  miniWindow.on('closed', () => {
    miniWindow = null;
    clearAutoChatDriverByWindow(miniWindowWcId, 'closed');
    clearGroupEditorLockByWindow(miniWindowWcId);
  });
}

function showMiniWindow(): void {
  // 显式点击「打开小窗」即明确意图，不再受 miniWindow.enabled 限制；
  // enabled 仅用于「开机/最小化自动弹出」等被动行为，手动打开始终可用。
  if (!miniWindow || miniWindow.isDestroyed()) createMiniWindow();
  if (!miniWindow) return;
  // 默认出现在屏幕右下角
  if (!miniWindow.isVisible()) {
    const wa = screen.getPrimaryDisplay().workArea;
    const b = miniWindow.getBounds();
    miniWindow.setPosition(wa.x + wa.width - b.width - 16, wa.y + wa.height - b.height - 16);
  }
  safeSend(miniWindow, 'mini:switch', null);
  miniWindow.setOpacity(1);
  miniWindow.show();
  miniWindow.focus();
}

function toggleMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()) {
    miniWindow.hide();
  } else {
    showMiniWindow();
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // 回到主界面即视为已读：清空悬浮球未读（面板与主界面数据实时一致）
  clearAllUnread();
}

// ---------- 后台消息提醒（Steam 风格卡片） ----------
function ensureNotifyWindow(): void {
  if (notifyWindow && !notifyWindow.isDestroyed()) return;
  notifyWindow = new BrowserWindow({
    width: 360,
    height: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    roundedCorners: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (process.env.NIANYU_DEV === '1') {
    notifyWindow.loadURL(`${DEV_SERVER}/notify.html`);
  } else {
    notifyWindow.loadFile(path.join(__dirname, '../../dist/notify.html'));
  }
  notifyWindow.once('ready-to-show', () => {
    notifyReady = true;
    processNotifyQueue();
  });
  notifyWindow.on('closed', () => {
    notifyWindow = null;
    notifyReady = false;
  });
}

function positionNotifyWindow(): void {
  if (!notifyWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  notifyWindow.setPosition(wa.x + wa.width - 360 - 16, wa.y + wa.height - 120 - 16);
}

// 收到一条 AI 消息：主窗与小窗均隐藏或最小化（软件在后台）才弹出提醒卡片
function showNotifyCard(item: any): void {
  // 静默模式：暂停后台消息卡片通知（提示音由渲染进程在播放前拦截）
  if (dm.getSettings().silent === true) return;
  // 窗口可见且未最小化 = 用户正在使用，不弹卡片
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) return;
  if (miniWindow && miniWindow.isVisible() && !miniWindow.isMinimized()) return;
  const sig = `${item.chatType}:${item.chatId}:${String(item.content).slice(0, 40)}`;
  const now = Date.now();
  if (sig === lastNotifySig && now - lastNotifyTime < 1500) return; // 防抖去重
  lastNotifySig = sig;
  lastNotifyTime = now;
  notifyQueue.push(item);
  processNotifyQueue();
}

function processNotifyQueue(): void {
  if (!notifyWindow || notifyWindow.isDestroyed()) {
    ensureNotifyWindow();
    return;
  }
  if (!notifyReady) return;
  if (currentNotify) return; // 当前正在展示一张，等待其收回
  const item = notifyQueue.shift();
  if (!item) return;
  currentNotify = item;
  const lang = dm.getSettings().lang === 'en' ? 'en' : 'zh';
  const theme = dm.getSettings().theme || 'wechat';
  positionNotifyWindow();
  notifyWindow.setIgnoreMouseEvents(true, { forward: true });
  notifyWindow.showInactive();
  safeSend(notifyWindow, 'notify:data', {
    action: 'show',
    label: lang === 'en' ? 'New message' : '新消息',
    roleName: item.roleName,
    content: item.content,
    chat: {
      chatType: item.chatType,
      chatId: item.chatId,
      name: item.name,
      soundPath: dm.getSettings().chatSoundPaths?.[`${item.chatType}:${item.chatId}`] || null,
    },
    theme,
  });
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    if (notifyWindow && !notifyWindow.isDestroyed()) {
      notifyWindow.webContents.send('notify:data', { action: 'hide' });
    }
    setTimeout(() => {
      if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.hide();
      currentNotify = null;
      processNotifyQueue();
    }, 450);
  }, 10000);
}

// 点击卡片：打开对应会话（主窗置前并切换到该聊天）
function openNotifyChat(chat: any): void {
  // 点击通知卡片打开会话，同步清除悬浮球未读
  if (chat && chat.chatType && chat.chatId) clearUnreadForChat(chat.chatType, chat.chatId);
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  currentNotify = null;
  if (notifyWindow && !notifyWindow.isDestroyed()) {
    notifyWindow.webContents.send('notify:data', { action: 'hide' });
    setTimeout(() => notifyWindow?.hide(), 200);
  }
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:openChat', chat);
  }
  setTimeout(processNotifyQueue, 120);
}

// 关闭按钮：收起当前卡片并处理下一条
function hideNotifyWindow(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  currentNotify = null;
  if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.hide();
  setTimeout(processNotifyQueue, 120);
}

// ---------- 应用图标 ----------
const APP_ICON_NAME = 'k0z5e-rk3ah-001.ico';
function getAppIconPath(): string {
  // 构建后 __dirname 为 dist-electron/electron/，图标位于项目根目录或 build/
  const dev = path.join(__dirname, '..', '..', APP_ICON_NAME);
  if (fs.existsSync(dev)) return dev;
  // 尝试 icon.ico（某些环境下复制为这个文件名）
  const alt = path.join(__dirname, '..', '..', 'icon.ico');
  if (fs.existsSync(alt)) return alt;
  const buildDir = path.join(__dirname, '..', '..', 'build', APP_ICON_NAME);
  if (fs.existsSync(buildDir)) return buildDir;
  // 打包后 resources 目录
  const res = path.join(process.resourcesPath || '', APP_ICON_NAME);
  if (res && fs.existsSync(res)) return res;
  return '';
}
function getAppIcon(): Electron.NativeImage {
  const iconPath = getAppIconPath();
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

// ---------- Tray 托盘 ----------
function createTrayIcon(): Electron.NativeImage {
  // 优先使用项目根目录的 ICO 图标；若不存在则回退到程序化绿色圆点
  const iconPath = getAppIconPath();
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // 程序化生成 16x16 绿色圆点图标（BGRA），避免依赖外部图标文件
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 7.5;
  const r = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        buf[i] = 0x60; // B
        buf[i + 1] = 0xc1; // G
        buf[i + 2] = 0x07; // R
        buf[i + 3] = d > r - 1 ? Math.round(255 * (r - d)) : 255; // 边缘抗锯齿
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const TRAY_LABELS: Record<Lang, Record<string, string>> = {
  zh: { showMain: '打开主窗口', showMini: '快捷聊天小窗', silent: '静默模式', quit: '退出' },
  en: { showMain: 'Open Main Window', showMini: 'Quick Chat Mini Window', silent: 'Silent Mode', quit: 'Quit' },
};

// 切换静默模式：持久化到设置、重建托盘菜单（更新勾选态）、广播给渲染进程同步
function toggleSilentMode(): void {
  const next = !(dm.getSettings().silent === true);
  dm.saveSettings({ silent: next });
  const lang: Lang = dm.getSettings().lang === 'en' ? 'en' : 'zh';
  buildTrayMenu(lang);
  broadcast('settings:changed', { silent: next });
}

function buildTrayMenu(lang: Lang): void {
  if (!tray) return;
  const l = TRAY_LABELS[lang];
  const silentOn = dm.getSettings().silent === true;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: l.showMain, click: () => showMainWindow() },
      { label: l.showMini, click: () => showMiniWindow() },
      { type: 'separator' },
      {
        label: l.silent,
        type: 'checkbox',
        checked: silentOn,
        click: () => toggleSilentMode(),
      },
      { type: 'separator' },
      {
        label: l.quit,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('念语 Nianyu');
  const lang: Lang = dm.getSettings().lang === 'en' ? 'en' : 'zh';
  buildTrayMenu(lang);
  tray.on('double-click', () => showMainWindow());
}

// ---------- 全局快捷键 ----------
function applyMiniSettings(): void {
  globalShortcut.unregisterAll();
  const s = dm.getSettings();
  const mw = s.miniWindow;
  if (mw?.alwaysOnTop !== undefined && miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.setAlwaysOnTop(!!mw.alwaysOnTop);
  }
  if (!mw?.enabled || !mw.hotkey) return;
  try {
    globalShortcut.register(mw.hotkey, () => {
      // 主窗在前台时，快捷键改为激活主窗
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.focus();
        return;
      }
      toggleMiniWindow();
    });
  } catch (e) {
    console.error('注册全局快捷键失败', e);
  }
}

// ---------- 好感度情感分析 ----------
const POSITIVE: [string, number, string][] = [
  ['喜欢', 3, '用户表达喜欢'], ['爱', 3, '用户表达爱意'], ['爱死', 3, '用户强烈喜爱'],
  ['谢谢', 2, '用户致谢'], ['感谢', 2, '用户致谢'], ['棒', 2, '用户称赞'], ['厉害', 2, '用户称赞'],
  ['可爱', 2, '用户称赞外貌'], ['漂亮', 2, '用户称赞外貌'], ['温柔', 2, '用户称赞性格'],
  ['开心', 1, '用户情绪正面'], ['高兴', 1, '用户情绪正面'], ['赞', 2, '用户点赞'],
  ['好', 1, '用户认可'], ['完美', 2, '用户高度认可'], ['支持', 1, '用户支持'],
];
const NEGATIVE: [string, number, string][] = [
  ['讨厌', -3, '用户表达厌恶'], ['恨', -3, '用户表达恨意'], ['烦', -2, '用户烦躁'],
  ['生气', -3, '用户生气'], ['滚', -3, '用户驱逐'], ['笨', -2, '用户贬低'],
  ['丑', -2, '用户贬低外貌'], ['无聊', -2, '用户无聊'], ['差', -2, '用户否定'],
  ['讨厌你', -3, '用户针对角色'], ['无聊透顶', -2, '用户强烈否定'],
  ['不理', -1, '用户冷淡'], ['懒得', -1, '用户敷衍'],
];

function analyzeSentiment(text: string): { change: number; reason: string } {
  if (!text) return { change: 0, reason: '无文本' };
  let change = 0;
  let reason = '中性';
  for (const [kw, val, r] of POSITIVE) {
    if (text.includes(kw)) {
      change += val;
      reason = r;
    }
  }
  for (const [kw, val, r] of NEGATIVE) {
    if (text.includes(kw)) {
      change += val;
      reason = r;
    }
  }
  change = Math.max(-3, Math.min(3, change));
  return { change, reason };
}

function affinityTone(affinity: number): string {
  if (affinity >= 80) return '你非常喜欢对方，请用亲密、热情、可撒娇的语气回复。';
  if (affinity >= 60) return '你对对方很有好感，请用亲切、友好的语气回复。';
  if (affinity >= 40) return '你对对方态度平常自然，请保持日常、得体的语气。';
  if (affinity >= 20) return '你对对方有些冷淡，请保持礼貌但略带距离感。';
  return '你对对方明显反感，请用疏离甚至略带刺的语气回复。';
}

// 解析某对话实际生效的世界书文本内容（优先级：按聊天 > 按角色 > 全局默认）
function resolveWorldBook(chatType: string, chatId: string, settings: AppSettings): string {
  const key = `${chatType}:${chatId}`;
  let wbId: string | undefined;
  if (settings.chatWorldBooks && settings.chatWorldBooks[key]) {
    const v = settings.chatWorldBooks[key];
    if (v === 'none') return ''; // 该聊天显式不使用世界书
    wbId = v;
  } else if (chatType === 'single') {
    const r = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
    if (r && r.worldBookId) {
      if (r.worldBookId === 'none') return ''; // 该角色显式不使用世界书
      wbId = r.worldBookId;
    }
  }
  if (!wbId) wbId = settings.defaultWorldBookId;
  if (!wbId) return '';
  const wb = dm.getWorldBook(wbId);
  return wb ? worldBookText(wb) : '';
}

function worldBookText(wb: WorldBook): string {
  if (wb.entries && wb.entries.length > 0) {
    return wb.entries.map((e) => (e.key ? `【${e.key}】${e.content}` : e.content)).join('\n');
  }
  return wb.content || '';
}

// ===================== 情绪系统 =====================
// 心情词汇表：AI 判定的唯一候选集合（不写死「某好感度=某心情」）
const MOODS = ['开心', '撒娇', '心动', '害羞', '平静', '低落', '难过', '生气'] as const;

// 心情 → 注入系统提示的语气描述（仅把 AI 判定的心情词转成上下文情绪，不决定具体心情）
const MOOD_DESC: Record<string, string> = {
  开心: '你此刻心情愉悦、眉眼弯弯，语气轻快温暖，会自然地把快乐分享给对方。',
  撒娇: '你此刻满心欢喜又有点黏人，会不自觉地撒娇，用软糯亲昵的语气靠近对方。',
  心动: '你此刻被对方牵动心弦，有些害羞又雀跃，言语间藏着甜蜜的试探与期待。',
  害羞: '你此刻有些脸红心跳、不太敢直视对方，说话会轻轻吞吞吐吐，带着青涩。',
  平静: '你此刻心境平和，如常地与对方相处，语气自然安稳。',
  低落: '你此刻情绪低落、兴致缺缺，语气会偏冷淡疏离，像隔着一层薄雾。',
  难过: '你此刻心里泛着酸涩与委屈，容易沉默，偶尔语气带刺也只是藏在乎。',
  生气: '你此刻压着一股火气与不满，语气会带刺、生冷，但深处仍记挂着对方。',
};
const NEG_MOODS: string[] = [...MOODS].filter((m) => m === '生气' || m === '低落' || m === '难过');
const POS_MOODS: string[] = [...MOODS].filter((m) => m === '开心' || m === '撒娇' || m === '心动');

// 计算当前情绪上下文：直接采用 AI 根据对话判定的 role.mood（不按好感度写死具体心情）
function buildEmotionContext(role: Role): string {
  const eff = role.mood && (MOODS as readonly string[]).includes(role.mood) ? role.mood : '平静';
  const desc = MOOD_DESC[eff] || MOOD_DESC['平静'];
  return `【当前情绪】${desc}`;
}

// 心情平滑过渡：把离散心情词映射为连续情绪值（-100~100），便于做指数平滑，避免忽喜忽悲
const MOOD_VALENCE: Record<string, number> = {
  生气: -100,
  难过: -75,
  低落: -45,
  平静: 0,
  害羞: 25,
  撒娇: 50,
  心动: 75,
  开心: 100,
};

// 连续情绪值 → 最近的心情词（分段取中值，保证过渡连续、不会瞬跳）
function valenceToMood(v: number): string {
  if (v <= -87.5) return '生气';
  if (v <= -60) return '难过';
  if (v <= -22.5) return '低落';
  if (v <= 12.5) return '平静';
  if (v <= 37.5) return '害羞';
  if (v <= 62.5) return '撒娇';
  if (v <= 87.5) return '心动';
  return '开心';
}

// 心情平滑过渡核心：以「心情过渡指数」(settings.moodSmoothing) 为步进系数，
// 把底层连续情绪 moodValue 朝 AI 判定的目标心情平滑移动，再反推出显示用的离散心情词。
// 返回最终生效的心情词与连续值；若目标非法则返回 null（保持原状）。
function applyMoodChange(
  role: Role,
  targetLabel: string,
  settings: AppSettings,
  ctx: { chatType: string; chatId: string }
): { label: string; value: number } | null {
  if (!targetLabel || !(MOODS as readonly string[]).includes(targetLabel)) return null;
  const smoothing = Math.max(0, Math.min(1, settings.moodSmoothing ?? 0.5));
  const targetVal = MOOD_VALENCE[targetLabel] ?? 0;
  const oldVal = typeof role.moodValue === 'number' ? role.moodValue : MOOD_VALENCE[role.mood || '平静'] ?? 0;
  const newVal = Math.round(oldVal + smoothing * (targetVal - oldVal));
  const newLabel = valenceToMood(newVal);
  dm.updateRole(role.id, { mood: newLabel, moodValue: newVal });
  broadcast('role:mood', { roleId: role.id, chatType: ctx.chatType, chatId: ctx.chatId, mood: newLabel });
  return { label: newLabel, value: newVal };
}

// AI 根据最近对话判定角色「此刻」心情（使用默认模型，不计入聊天 token 消耗）
async function judgeMood(role: Role, settings: AppSettings, recent: string): Promise<string | null> {
  const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
  if (!cfg) return null;
  const impact = settings.dialogueMoodImpact ?? 1;
  let strength = '适度根据最近对话调整角色心情';
  if (impact >= 0.66) strength = '让最近对话充分决定角色此刻的心情';
  else if (impact <= 0.33) strength = '除非对话里出现明显情绪信号，否则尽量保持角色当前心情稳定';
  const prompt = [
    `你是角色「${role.name}」。`,
    role.personality ? `性格：${role.personality}。` : '',
    `当前好感度：${role.affinity}/100。`,
    role.mood ? `角色当前心情：${role.mood}（仅作参考，可依据新对话更新）。` : '',
    `最近对话：\n${recent || '（尚无对话）'}`,
    `请依据上述对话里用户的言行、角色的性格与好感度，${strength}，判断角色「此刻」最贴切的心情。`,
    `只输出一个 JSON：{ "mood": "心情词", "reason": "一句话理由" }。`,
    `mood 只能从以下枚举选一个：${MOODS.join(' / ')}。`,
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const res = await queryAI(
      cfg,
      [
        { role: 'system', content: '你是判断角色心情的助手，严格按要求的 JSON 格式输出，不要输出任何多余内容。' },
        { role: 'user', content: prompt },
      ],
      200
    );
    if (res.content.startsWith('（')) return null;
    const p = parseFirstJson(res.content);
    if (p && typeof p.mood === 'string' && (MOODS as readonly string[]).includes(p.mood)) return p.mood;
    return null;
  } catch {
    return null;
  }
}

// 同聊天同时只存在一个随机事件（跨主窗/小窗防重复生成）；记录哪个窗口触发的
const activeEvents = new Map<string, { window: string }>();

const moodJudgeCooldown = new Map<string, number>();
// 一轮 AI 回复完成后，后台判定并更新角色心情，向所有窗口广播
async function requestMoodJudge(chatType: string, chatId: string, roleId: string): Promise<void> {
  const settings = dm.getSettings();
  if ((settings.dialogueMoodImpact ?? 1) <= 0) return; // 关闭「对话影响心情」则不判定
  const now = Date.now();
  const last = moodJudgeCooldown.get(roleId) || 0;
  if (now - last < (settings.moodJudgeCooldownMs ?? 20000)) return; // 心情判定冷却：避免每轮都调用 AI 判定
  // 观察者模式：群内「关闭观察者发言的情绪演算」时跳过；私密小窗「不影响情绪」时跳过
  const obs = getObserverConfig(chatType, chatId);
  if (obs.observerMode) {
    if (chatType === 'group' && obs.observerNoEmotion) return;
    if (chatType === 'single' && chatId.startsWith('obs:') && !obs.privateAffectsEmotion) return;
  }
  moodJudgeCooldown.set(roleId, now);
  const role = dm.getRole(roleId);
  if (!role) return;
  const history = dm.getMessages(chatType, chatId).slice(-(settings.moodJudgeHistory ?? 10)); // 取最近 N 条供 AI 判定心情
  const recent = history.map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 140)}`).join('\n');
  const mood = await judgeMood(role, settings, recent);
  if (mood) {
    applyMoodChange(role, mood, settings, { chatType, chatId }); // 平滑过渡，避免忽喜忽悲
    logEmotionIfObserver(chatType, chatId, roleId); // 记录对局情绪轨迹
  }
}

const relationshipCooldown = new Map<string, number>();
const DAILY_MOMENT_LIMIT = 5; // 每个（角色 + 自我身份）每天自动发朋友圈上限，防止长聊灌满

// 把生图返回的 base64 写入图片库，返回本地路径（模块级，供生图 handler 与朋友圈自动配图共用）
function saveGeneratedImage(b64: string): string | null {
  try {
    const m = b64.match(/^data:(image\/\w+);base64,(.+)$/);
    const meta = m ? m[1] : 'image/png';
    const data = m ? m[2] : b64;
    const ext = meta === 'image/jpeg' ? '.jpg' : '.png';
    const name = `gen_${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`;
    const dest = path.join(dm.imagesDir, name);
    fs.writeFileSync(dest, Buffer.from(data, 'base64'));
    return dest;
  } catch (e) {
    console.error('保存生图失败', e);
    return null;
  }
}

// 计算某聊天的「内容快照」：取最近若干条消息的 id+内容拼接，用于判断自上次关系判定后是否有新聊天内容。
function computeChatSnapshot(chatType: string, chatId: string): string {
  const msgs = dm.getMessages(chatType, chatId).slice(-50);
  return msgs.map((m) => `${m.id}:${(m.content || '').slice(0, 200)}`).join('|');
}

// 一轮单聊 AI 回复完成后，后台由 AI 依据聊天内容判定关系值/关系类别，并视情况自动发朋友圈动态。
// 关系值纯展示、绝不回灌聊天 prompt（只有剧情影响关系值，关系值不影响剧情）。
async function requestRelationshipAndMoments(
  chatType: string,
  chatId: string,
  roleId: string,
  opts: { force?: boolean; doRelationship?: boolean; doMoments?: boolean } = {}
): Promise<{ ok: boolean; moments: number; relation?: string }> {
  const force = opts.force ?? false;
  const settings = dm.getSettings();
  const doRelationship = opts.doRelationship ?? settings.autoRelationship;
  const doMoments = opts.doMoments ?? settings.autoMoments;
  if (chatType !== 'single' && chatType !== 'group') return { ok: false, moments: 0 };
  if (!doRelationship && !doMoments) return { ok: false, moments: 0 };
  const now = Date.now();
  const last = relationshipCooldown.get(roleId) || 0;
  if (!force && now - last < (settings.moodJudgeCooldownMs ?? 20000)) return { ok: false, moments: 0 }; // 复用心情判定冷却，避免每轮都烧 token；手动触发(force)绕过冷却
  relationshipCooldown.set(roleId, now);
  const role = dm.getRole(roleId);
  if (!role) return { ok: false, moments: 0 };
  const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
  if (!cfg) return { ok: false, moments: 0 };
  const selfRole = resolveActiveSelfRole(settings, chatType, chatId);
  const history = dm.getMessages(chatType, chatId).slice(-(settings.moodJudgeHistory ?? 10));
  const recent = history.map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 200)}`).join('\n');
  const userDesc = selfRole
    ? `用户当前使用的身份「${selfRole.name}」${selfRole.personality ? `（${selfRole.personality}）` : ''}。`
    : '用户身份未指定（默认身份）。';

  let storedRelation: string | undefined;
  if (doRelationship) {
    storedRelation = await judgeRelationship(role, cfg, userDesc, recent);
  }
  let added = 0;
  if (doMoments) {
    added = await judgeAndPostMoments(role, cfg, userDesc, recent, settings, selfRole, force);
  }
  return { ok: true, moments: added, relation: storedRelation };
}

// 关系值/关系类别判定：独立 prompt，直接采用 AI 给出的亲密度作为当前关系值（不做增量阻尼）
async function judgeRelationship(role: Role, cfg: ModelConfig, userDesc: string, recent: string): Promise<string | undefined> {
  const prompt = [
    `你是关系分析助手。请基于最近对话，分析角色「${role.name}」与用户之间的关系状态。`,
    `角色设定：${role.personality || role.background || '（无）'}`,
    userDesc,
    `最近对话：\n${recent || '（尚无对话）'}`,
    `请输出严格 JSON，不要任何多余内容：`,
    `{`,
    `  "relation": "关系类别，必须从以下枚举中精确选一个 key：${RELATION_TYPES.map((k) => `${k}(${RELATION_LABELS[k]})`).join('/')}；无法确定时给 stranger",`,
    `  "trend": "closer 表示关系更亲近 / farther 表示更疏远 / same 表示持平",`,
    `  "intimacy": 0到100的整数，表示当前的亲密程度`,
    `}`,
  ].join('\n');
  try {
    const res = await queryAI(
      cfg,
      [
        { role: 'system', content: '你是分析助手，严格只输出要求的 JSON，不要输出任何解释或多余内容。' },
        { role: 'user', content: prompt },
      ],
      600
    );
    const parsed: any = parseFirstJson(res.content);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const prevBond = role.bond ?? 0;
    const intimacy = typeof parsed.intimacy === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.intimacy))) : null;
    const patch: Partial<Role> = {};
    if (intimacy != null) {
      // 直接采用 AI 给出的亲密度作为当前关系值（0~100 -> 0~1000，维持每 100 = 1 级的展示语义），不做 +/-20 增量阻尼
      const next = Math.round(Math.max(0, Math.min(1000, intimacy * 10)));
      if (next !== prevBond) patch.bond = next;
    }
    const rel = normalizeRelation(parsed.relation);
    if (rel) patch.relation = rel;
    if (Object.keys(patch).length) {
      dm.updateRole(role.id, patch);
      broadcast('role:bond', { roleId: role.id });
    }
    return rel;
  } catch {
    return undefined;
  }
}

// 朋友圈判定与发布：独立 prompt，由 AI 动态判定此刻是否想发（postMoments），与关系值判定完全无关
async function judgeAndPostMoments(
  role: Role,
  cfg: ModelConfig,
  userDesc: string,
  recent: string,
  settings: AppSettings,
  selfRole: SelfRole | undefined,
  force: boolean
): Promise<number> {
  const prompt = [
    `你是朋友圈动态助手。请基于最近对话，判断角色「${role.name}」此刻是否想发一条朋友圈，并写出内容。`,
    `角色设定：${role.personality || role.background || '（无）'}`,
    userDesc,
    `角色当前心情：${role.mood || '平静'}（只有聊到尽兴、情绪上扬、有共鸣或有有趣梗时才更想分享）。`,
    `最近对话：\n${recent || '（尚无对话）'}`,
    `请输出严格 JSON，不要任何多余内容：`,
    `{`,
    `  "postMoments": true或false，表示角色此刻是否真的想发朋友圈。仅当对话中出现了角色有冲动分享的内容（真实情绪起伏、重要事件、用户说了特别的话、关系进展、有趣的梗等）才为 true；日常寒暄、礼节性回复、无明显可分享点时必须为 false。不要因为被要求就发。`,
    `  "shareUrge": 0到100的整数，表示此刻想发朋友圈的强烈程度；聊到尽兴、有共鸣、有有趣梗或重要情绪起伏时更高，普通寒暄、礼节性回复时很低（接近0）。`,
    `  "moments": [ { "content": "角色视角的朋友圈文案，第一人称，自然口语化，不超过60字", "needImage": true或false, "imagePrompt": "若需要配图，这里是英文生图提示词，否则空串", "needVideo": true或false, "videoPrompt": "若需要视频，这里是英文视频生成提示词（画面描述，含镜头/氛围/风格），否则空串" } ]`,
    `}`,
    `只有当 postMoments 为 true 时才给出 moments，最多2条；否则 moments 给空数组。发朋友圈应当是低频、有质感的，不要每条对话都发。`,
  ].join('\n');
  let parsed: any = null;
  try {
    const res = await queryAI(
      cfg,
      [
        { role: 'system', content: '你是朋友圈助手，严格只输出要求的 JSON，不要输出任何解释或多余内容。' },
        { role: 'user', content: prompt },
      ],
      600
    );
    parsed = parseFirstJson(res.content);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== 'object') return 0;
  if (parsed.postMoments === false) return 0; // 显式不想发才硬拦截；缺省视为由阈值决定（向后兼容旧模型）
  // 朋友圈敏感程度：threshold = (1 - momentsSensitivity) * 100；
  // 敏感度高(→1) → 阈值低 → 稍想发就发；敏感度低(→0) → 阈值高(100) → 只有极度想发才发，普通唠嗑绝不发
  const sensitivity = Math.max(0, Math.min(1, settings.momentsSensitivity ?? 0.5));
  const threshold = Math.round((1 - sensitivity) * 100);
  // 旧模型未返回 shareUrge 时视为 100（始终满足阈值），向后兼容
  const urge = typeof parsed.shareUrge === 'number' ? parsed.shareUrge : 100;
  if (urge < threshold) return 0; // 分享冲动未达敏感阈值，不发（避免普通唠嗑也发朋友圈）
  if (!Array.isArray(parsed.moments) || parsed.moments.length === 0) return 0; // 无内容不发

  const ig = settings.imageGen;
  const igCfg = ig && ig.enabled && ig.baseUrl && ig.apiKey ? { baseUrl: ig.baseUrl, apiKey: ig.apiKey } : undefined;
  const selfRoleId = selfRole?.id || '';
  const todayKey = new Date().toISOString().slice(0, 10);
  // 单人物每日上限：手动触发(force)不受限；自动触发受角色 momentDailyLimit 约束（角色未填则用全局 dailyMomentLimit）
  const resolvedLimit =
    role.momentDailyLimit && role.momentDailyLimit > 0
      ? role.momentDailyLimit
      : settings.dailyMomentLimit === 0
        ? Infinity // 全局显式设为无限（0 哨兵），角色未单独设置时继承
        : settings.dailyMomentLimit && settings.dailyMomentLimit > 0
          ? settings.dailyMomentLimit
          : DAILY_MOMENT_LIMIT;
  const perCharLimit = force ? Infinity : resolvedLimit;
  let todayCount = force
    ? 0
    : dm.listMoments(role.id, true).filter((m) => m.published && (m.created_at || '').slice(0, 10) === todayKey).length;
  let added = 0;
  for (const mm of parsed.moments.slice(0, 2)) {
    if (todayCount >= perCharLimit) break; // 自动触发达单人物每日上限即暂停；手动触发无上限
    if (!mm || typeof mm.content !== 'string' || !mm.content.trim()) continue;
    const images: string[] = [];
    if (mm.needImage && igCfg) {
      try {
        const { b64 } = await generateImage(
          { baseUrl: igCfg.baseUrl, apiKey: igCfg.apiKey },
          String(mm.imagePrompt || mm.content).slice(0, 400),
          ig!.model || 'gpt-image-1',
          ig!.size || '1024x1024'
        );
        if (b64) {
          const p = saveGeneratedImage(b64);
          if (p) images.push(p);
        }
      } catch {
        // 配图失败则降级为纯文字动态，不阻塞
      }
    }
    const momentId = dm.addMoment(role.id, mm.content.trim(), images, undefined, selfRoleId);
    added++;
    todayCount++;
    // 朋友圈视频：独立开关 momentsVideoEnabled + 已配置视频模型时才生成（后台任务，进度走全局气泡）
    const vg = settings.videoGen;
    if (
      settings.momentsVideoEnabled &&
      vg && vg.enabled && vg.baseUrl && vg.apiKey &&
      mm.needVideo && String(mm.videoPrompt || '').trim()
    ) {
      void runMomentVideoJob(role.id, momentId, String(mm.videoPrompt || mm.content).slice(0, 400));
    }
  }
  if (added > 0) {
    broadcast('moments:changed', { roleId: role.id, selfRoleId });
    broadcast('moments:autoPosted', { roleId: role.id, selfRoleId, roleName: role.name, count: added });
  }
  return added;
}

// ===== 异步场景生图：AI 判定当前对话是否值得配一张场景图（指令不进聊天界面） =====
const lastSceneImageAt = new Map<string, number>(); // `${chatType}:${chatId}` -> 上次生图时间戳

// LLM 判定：是否该生成场景图 + 英文生图提示词
async function judgeSceneImageLLM(
  role: Role,
  cfg: ModelConfig,
  recent: string
): Promise<{ should: boolean; prompt: string }> {
  const prompt = [
    `你是场景插画助手。请基于最近对话，判断此刻是否值得为这段对话生成一张「场景配图」，帮助可视化当前的氛围、地点或画面感。`,
    `角色设定：${role.personality || role.background || '（无）'}`,
    `最近对话：\n${recent || '（尚无对话）'}`,
    `判定原则：仅当对话中出现了具体地点、画面感强的场景、明显情绪高潮、动作或可被视觉化的意象时 should 才为 true；日常寒暄、纯文字讨论、无明显画面感时应为 false。不要每条对话都生图。`,
    `请输出严格 JSON，不要任何多余内容：`,
    `{`,
    `  "should": true或false，表示是否值得生成场景配图`,
    `  "prompt": "若 should 为 true，给出英文场景生图提示词（不超过200词，含角色名与画面氛围，写实插画风）；否则给空串"`,
    `}`,
  ].join('\n');
  try {
    const res = await queryAI(
      cfg,
      [
        { role: 'system', content: '你是场景判定助手，严格只输出要求的 JSON，不要任何解释。' },
        { role: 'user', content: prompt },
      ],
      400
    );
    const p: any = parseFirstJson(res.content);
    if (!p || typeof p !== 'object') return { should: false, prompt: '' };
    if (p.should === true && typeof p.prompt === 'string' && p.prompt.trim()) {
      return { should: true, prompt: p.prompt.trim().slice(0, 400) };
    }
    return { should: false, prompt: '' };
  } catch {
    return { should: false, prompt: '' };
  }
}

// 启发式判定：无需调用 AI，扫描最近对话中的画面感关键词
const SCENE_KEYWORDS = [
  '看', '景色', '风景', '海边', '海', '山', '天空', '夕阳', '落日', '夜晚', '夜里',
  '房间', '咖啡', '雨', '雪', '笑', '哭', '抱', '吻', '街', '公园', '城市', '灯',
  '月光', '花园', '窗外', '阳光', '樱花', '森林', '湖', '床', '沙发', '厨房', '车站', '机场',
];
function judgeSceneImageHeuristic(recent: string): { should: boolean; prompt: string } {
  let hits = 0;
  for (const k of SCENE_KEYWORDS) if (recent.includes(k)) hits += 1;
  if (hits >= 2) {
    const snippet = recent.replace(/\s+/g, ' ').slice(-120);
    return { should: true, prompt: `Scene illustration, atmospheric, detailed, character present: ${snippet}` };
  }
  return { should: false, prompt: '' };
}

// 主入口：判定 + 生图 + 落库 + 双窗广播（只生一次，指令不写入聊天）
// 读取本地图片为 data URL（用于把角色头像作为生图参考图传入）
function readImageDataUrl(filePath: string): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    const ext = (filePath.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// 判断场景生图提示词是否涉及「人物/角色」（仅此时才把头像作为参考，避免无关场景被头像干扰）
function scenePromptInvolvesPerson(prompt: string, roleName: string): boolean {
  if (!prompt) return false;
  if (roleName && prompt.includes(roleName)) return true;
  return /(人|角色|他|她|我|你|们|脸|肖像|形象|自拍|合照|站|坐|走|看|笑|哭|抱|牵|亲)/.test(prompt);
}

async function triggerSceneImage(chatType: string, chatId: string, roleId: string): Promise<void> {
  const settings = dm.getSettings();
  if (!settings.autoSceneImageChats?.[`${chatType}:${chatId}`]) return; // 该对话未开启场景生图
  const ig = settings.imageGen;
  if (!ig || !ig.enabled || !ig.baseUrl || !ig.apiKey) return; // 未配置生图 API 则跳过
  const key = `${chatType}:${chatId}`;
  const now = Date.now();
  const last = lastSceneImageAt.get(key) || 0;
  const interval = Math.max(5, Math.min(3600, settings.sceneImageIntervalSec || 120)) * 1000;
  if (now - last < interval) return; // 节流：两次生图间隔不足则跳过
  const role = dm.getRole(roleId);
  if (!role) return;
  const history = dm.getMessages(chatType, chatId).slice(-(settings.moodJudgeHistory ?? 10));
  const recent = history.map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 200)}`).join('\n');
  let judge: { should: boolean; prompt: string };
  if (settings.sceneImageJudge === 'heuristic') {
    judge = judgeSceneImageHeuristic(recent);
  } else {
    const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
    if (!cfg) return;
    judge = await judgeSceneImageLLM(role, cfg, recent);
  }
  if (!judge.should || !judge.prompt) return;
  lastSceneImageAt.set(key, now); // 先占位，避免并发重复生成
  // 自动读取人物头像作为参考图（仅当开启且场景涉及人物时），使生成形象更贴近角色；无关场景不传，不影响内容
  let referenceImages: string[] | undefined;
  if (settings.asyncImageUseAvatar && role.avatar_path) {
    const avatar = readImageDataUrl(role.avatar_path);
    if (avatar && scenePromptInvolvesPerson(judge.prompt, role.name)) {
      referenceImages = [avatar];
    }
  }
  try {
    const { b64, url } = await generateImage(
      { baseUrl: ig.baseUrl!, apiKey: ig.apiKey! },
      judge.prompt,
      ig.model || 'gpt-image-1',
      ig.size || '1024x1024',
      referenceImages
    );
    let imagePath: string | null = null;
    if (b64) imagePath = saveGeneratedImage(b64);
    else if (url) {
      try {
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const name = `gen_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
        const dest = path.join(dm.imagesDir, name);
        fs.writeFileSync(dest, buf);
        imagePath = dest;
      } catch {
        /* 下载失败则放弃 */
      }
    }
    if (!imagePath) return;
    const aiName = chatType === 'single' ? role.name : dm.getGroup(chatId)?.group_name || 'AI';
    const aiMsg = dm.addMessage({
      chat_type: chatType as any,
      chat_id: chatId,
      sender_type: 'ai',
      sender_name: aiName,
      content: '',
      image_path: imagePath,
      token_used: 0,
      timestamp: new Date().toISOString(),
      genPrompt: judge.prompt,
    });
    broadcast('stream:user', aiMsg); // 主窗/小窗同时收到，只生一次
    pushMediaUnread(chatType, chatId, aiName, 'image'); // 主窗不可见/未盯该聊天则补未读
  } catch (e) {
    console.error('[nianyu] 场景生图失败', e);
    lastSceneImageAt.delete(key); // 失败则回退节流，允许下次重试
  }
}

// ===== 联网搜索：把检索结果作为上下文注入 AI 回复（类 DeepSeek 联网搜索） =====
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(s: string): string {
  return (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function decodeEntities(s: string): string {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// 按 provider 执行检索；DuckDuckGo HTML 免费无需 Key，其余需 Key
// 单引擎免费直爬（无需 Key），返回前若干条结果
async function searchOne(engine: string, q: string): Promise<SearchResult[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    if (engine === 'baidu') {
      const r = await fetch(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=10`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://www.baidu.com/',
        },
        signal: ac.signal,
      });
      if (!r.ok) return [];
      const res = parseBaidu(await r.text());
      console.log('[websearch] baidu results:', res.length);
      return res;
    }
    if (engine === 'bing') {
      const r = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&cc=CN`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: ac.signal,
      });
      if (!r.ok) return [];
      const res = parseBing(await r.text());
      console.log('[websearch] bing results:', res.length);
      return res;
    }
    // DuckDuckGo：优先 Lite（结构干净、更抗反爬），失败再试 HTML
    try {
      const lite = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        body: `q=${encodeURIComponent(q)}`,
        signal: ac.signal,
      });
      if (lite.ok) {
        const res = parseDdgLite(await lite.text());
        if (res.length) return res;
      }
    } catch { /* fallthrough to html */ }
    const html = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: ac.signal,
    });
    if (!html.ok) return [];
    return parseDdgHtml(await html.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// 按 provider 执行检索；auto=多引擎免费回退（国内可达），tavily/serpapi 需 Key
async function searchWeb(provider: string, query: string, apiKey: string): Promise<SearchResult[]> {
  const q = (query || '').trim().slice(0, 400);
  if (!q) {
    console.log('[websearch] empty query, skip');
    return [];
  }
  let results: SearchResult[] = [];
  if (provider === 'tavily') results = apiKey ? await searchTavily(q, apiKey) : [];
  else if (provider === 'serpapi') results = apiKey ? await searchSerpapi(q, apiKey) : [];
  else if (provider === 'auto') {
    // 国内可达优先：Bing → 百度 → DuckDuckGo（DDG 在国内常被墙，放最后避免空等超时）
    for (const e of ['bing', 'baidu', 'duckduckgo']) {
      try {
        const r = await searchOne(e, q);
        if (r.length) {
          results = r;
          break;
        }
      } catch (err) {
        console.log('[websearch] engine failed:', e, String(err).slice(0, 80));
      }
    }
  } else {
    results = await searchOne(provider, q);
  }
  console.log(`[websearch] provider=${provider} query=${q.slice(0, 40)} results=${results.length}`);
  return results;
}

// —— 各引擎解析器（结果按 url 去重）——
function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const re = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 6) {
    const block = m[1];
    const a = /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = a[1];
    if (seen.has(url) || !url.startsWith('http')) continue;
    seen.add(url);
    const title = decodeEntities(stripTags(a[2])) || url;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const snippet = p ? decodeEntities(stripTags(p[1])) : '';
    out.push({ title, url, snippet });
  }
  return out;
}

function parseBaidu(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  // 兼容新旧两种结构：旧版 <h3 class="t">、新版 <h3 class="c-title t tttitle">
  const re =
    /<h3[^>]*class="[^"]*\b(?:t|c-title)\b[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 6) {
    const url = m[1];
    if (seen.has(url) || !url.startsWith('http')) continue;
    seen.add(url);
    const title = decodeEntities(stripTags(m[2])) || url;
    const after = html.slice(m.index, m.index + 1500);
    const snip =
      /<div[^>]*class="[^"]*\bc-abstract\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(after) ||
      /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(after) ||
      /<div[^>]*class="[^"]*\bc-span[0-9][^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(after);
    const snippet = snip ? decodeEntities(stripTags(snip[1])) : '';
    out.push({ title, url, snippet });
  }
  return out;
}

function parseDdgLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const re = /<a class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<(?:td|div|span) class="result-snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 6) {
    const href = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    const url = uddg ? decodeURIComponent(uddg[1]) : href;
    if (seen.has(url) || !url.startsWith('http')) continue;
    seen.add(url);
    const title = decodeEntities(stripTags(m[2]));
    const snippet = decodeEntities(stripTags(m[3]));
    out.push({ title, url, snippet });
  }
  return out;
}

function parseDdgHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 6) {
    const href = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    const url = uddg ? decodeURIComponent(uddg[1]) : href;
    if (seen.has(url) || !url.startsWith('http')) continue;
    seen.add(url);
    const title = decodeEntities(stripTags(m[2]));
    const snippet = decodeEntities(stripTags(m[3]));
    out.push({ title, url, snippet });
  }
  return out;
}

// 需 Key 的搜索 API
async function searchTavily(q: string, apiKey: string): Promise<SearchResult[]> {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: q, max_results: 5, search_depth: 'basic' }),
    });
    if (!r.ok) return [];
    const j: any = await r.json();
    const arr = Array.isArray(j?.results) ? j.results : [];
    return arr
      .slice(0, 5)
      .map((x: any) => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.content || x.snippet || '') }))
      .filter((x: SearchResult) => x.url.startsWith('http'));
  } catch {
    return [];
  }
}

async function searchSerpapi(q: string, apiKey: string): Promise<SearchResult[]> {
  try {
    const r = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return [];
    const j: any = await r.json();
    const arr = j?.organic_results || [];
    return arr
      .slice(0, 5)
      .map((x: any) => ({ title: String(x.title || ''), url: String(x.link || ''), snippet: String(x.snippet || '') }))
      .filter((x: SearchResult) => x.url.startsWith('http'));
  } catch {
    return [];
  }
}

// —— 轻量网页正文提取（类 DeepSeek「只读纯文本正文，过滤广告/CSS/JS」）——
const PAGE_TEXT_MAX = 2600; // 单页注入模型的最大字符数
const PAGE_BYTES_MAX = 1_500_000; // 单页下载字节上限，防止大文件/内存爆炸
const FETCH_PAGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 抽取网页正文纯文本：优先 <article>/<main>，其次聚合 <p>，再退而聚合 <div>，最后全文去标签
function extractArticleText(html: string): string {
  if (!html) return '';
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|svg|head|meta|link|template|nav|footer|header|aside)[^>]*>[\s\S]*?<\/(script|style|noscript|svg|head|meta|link|template|nav|footer|header|aside)>/gi,
      ' '
    )
    .replace(/<(script|style|noscript|svg|head|meta|link|template|nav|footer|header|aside|br|img|input|hr)[^>]*\/?>/gi, ' ');
  const grab = (s: string) => decodeEntities(stripTags(s));
  let body = '';
  const articleMatch = /<(article|main)[^>]*>([\s\S]*?)<\/(article|main)>/i.exec(cleaned);
  if (articleMatch) body = grab(articleMatch[2]);
  if (body.length < 200) {
    const ps = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => grab(m[1]))
      .filter((t) => t.length > 10);
    const joined = ps.join('\n\n');
    if (joined.length > body.length) body = joined;
  }
  // 退路：聚合内容较长的 <div>（很多中文资讯/官网页无 <p> 而用 <div> 排版）
  if (body.length < 200) {
    const divs = [...cleaned.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((m) => grab(m[1]))
      .filter((t) => t.length > 40);
    divs.sort((a, b) => b.length - a.length);
    const joined = divs.slice(0, 10).join('\n\n');
    if (joined.length > body.length) body = joined;
  }
  if (body.length < 200) body = grab(cleaned); // 兜底：全文去标签
  // 折叠空白：多空格→单空格，多空行→单空行
  body = body.replace(/[ \t ]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  return body.slice(0, PAGE_TEXT_MAX);
}

// 抓取单篇网页正文（带超时 + 仅 text/html + 字节上限）
async function fetchOnePage(
  url: string,
  timeoutMs: number
): Promise<{ url: string; text: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  let referer = 'https://www.baidu.com/';
  try {
    referer = new URL(url).origin + '/';
  } catch {
    /* keep default */
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': FETCH_PAGE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: referer,
      },
      signal: ac.signal,
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) return null; // 只处理网页，跳过 pdf/json/图片等
    const html = await resp.text();
    if (!html || html.length > PAGE_BYTES_MAX) return null;
    const text = extractArticleText(html);
    if (text.length < 120) return null; // 正文过短（JS 渲染页/反爬页），丢弃
    return { url, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 并发抓取前 N 篇结果网页正文（Promise.allSettled 容错，单页失败不影响其余）
// 返回 { context, pages }：context 为注入模型的带编号正文；pages 为展示用（标题/链接/摘要），
// 二者顺序一致，编号 [1..N] 完全相同，确保模型引用的 [n] 能与前端气泡一一对应。
async function fetchPageContext(
  results: SearchResult[],
  settings: AppSettings,
  query: string
): Promise<{ context: string; pages: SearchResult[] } | null> {
  let sources = results.slice();
  // 百度结果链接是加密跳转（/link?url=），目标页多为 JS 渲染/反爬（知道/百科/知乎），
  // 直连抓取几乎必失败。改用 Bing 的真实直连 URL 作为抓取源，显著提升可用率；
  // 同时保留原结果，合并去重后一起尝试，最大化拿到可读正文的机会。
  if (settings.searchProvider === 'baidu') {
    try {
      const bing = await searchOne('bing', query);
      if (bing.length) {
        const seen = new Set(sources.map((r) => r.url));
        for (const b of bing) {
          if (!seen.has(b.url)) {
            sources.push(b);
            seen.add(b.url);
          }
        }
        console.log(`[websearch] baidu→补充 ${bing.length} 条 Bing 直连 URL 用于抓取`);
      }
    } catch {
      /* 忽略：Bing 不可达则仍用百度结果 */
    }
  }
  const top = sources.slice(0, Math.min(Math.max(1, settings.webSearchFetchCount || 5), 6));
  const timeout = Math.min(Math.max(2000, settings.webSearchFetchTimeout || 8000), 20000);
  const settled = await Promise.allSettled(top.map((r) => fetchOnePage(r.url, timeout)));
  const items: { result: SearchResult; text: string }[] = [];
  settled.forEach((s, idx) => {
    if (s.status === 'fulfilled' && s.value) {
      items.push({ result: top[idx], text: s.value.text });
    }
  });
  if (!items.length) return null;
  console.log(`[websearch] fetched ${items.length}/${top.length} page texts`);
  // 展示用：气泡只显示标题/链接/短摘要（正文太长不进气泡）
  const pages = items.map((it) => ({
    title: it.result.title,
    url: it.result.url,
    snippet: it.result.snippet || it.text.slice(0, 120),
  }));
  // 注入模型：带 [n] 编号与完整正文，供模型引用
  const context = items
    .map((it, i) => `[${i + 1}] 标题：${it.result.title}\n链接：${it.result.url}\n正文：${it.text}`)
    .join('\n\n');
  return { context, pages };
}

// 取检索结果拼成上下文文本（每聊一次只检索一次），并广播状态/结果供前端展示
// 返回 { context, pages }：context 为注入模型的带编号资料；pages 为前端气泡展示用（顺序与编号一致）
async function fetchSearchContext(
  chatType: string,
  chatId: string,
  query: string,
  settings: AppSettings
): Promise<{ context: string; pages: SearchResult[] } | null> {
  if (!settings.webSearchChats?.[`${chatType}:${chatId}`]) return null;
  broadcast('search:status', { chatType, chatId, status: 'searching' });
  const results = await searchWeb(settings.searchProvider || 'duckduckgo', query, settings.searchApiKey || '');
  broadcast('search:status', {
    chatType,
    chatId,
    status: results.length ? 'done' : 'failed',
    count: results.length,
  });
  if (!results.length) return null;
  // DeepSeek 式：检索拿到链接后，并发读取前 N 篇网页正文作为 grounding 注入
  let payload: { context: string; pages: SearchResult[] } | null = null;
  if (settings.webSearchFetchPages) {
    const pageCtx = await fetchPageContext(results, settings, query);
    if (pageCtx) payload = pageCtx;
    else console.log('[websearch] page fetch empty, fallback to snippets');
  }
  // 抓取关闭或抓取全部失败时：用搜索摘要兜底（同样带 [n] 编号，保证引用一致）
  if (!payload) {
    const top = results.slice(0, Math.min(Math.max(1, settings.webSearchFetchCount || 5), 6));
    const pages = top.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    const context = top
      .map(
        (r, i) =>
          `[${i + 1}] 标题：${r.title}\n链接：${r.url}\n摘要：${(r.snippet || '').trim() || '(无摘要)'}`
      )
      .join('\n\n');
    payload = { context, pages };
  }
  // 把检索结果（仅标题/链接/摘要，顺序与注入模型编号一致）广播给前端，用于折叠气泡展示
  broadcast('search:results', { chatType, chatId, query, results: payload.pages });
  return payload;
}

// 把额外上下文（联网搜索结果 / 插件指令）合并进「第一条」system 消息。
// 关键：Anthropic 路径只读取第一条 system 消息（ai.ts 中 messages.find(role==='system')），
// 多数 OpenAI 兼容端点也只认首条 system。若用 messages.push 追加到末尾，结果会被丢弃 / 降权，
// 导致模型「裸答」、看不到检索结果。合并到首条 system 可保证所有 provider 都能读到。
function appendToFirstSystem(messages: any[], content: string) {
  if (!content) return;
  const idx = messages.findIndex((m) => m.role === 'system');
  if (idx >= 0) {
    messages[idx] = { role: 'system', content: `${messages[idx].content}\n\n${content}` };
  } else {
    messages.unshift({ role: 'system', content });
  }
}


function buildSystemPrompt(role: Role, freezeMemory = false, chatId?: string): string {
  const parts: string[] = [];
  parts.push(`你是数字人「${role.name}」。`);
  if (role.gender) parts.push(`性别：${role.gender}。`);
  if (role.age) parts.push(`年龄：${role.age}。`);
  if (role.occupation) parts.push(`职业：${role.occupation}。`);
  if (role.personality) parts.push(`性格：${role.personality}。`);
  if (role.background) parts.push(`背景故事：${role.background}。`);
  if (role.appearance) parts.push(`外貌：${role.appearance}。`);
  if (role.world_setting) parts.push(`世界观：${role.world_setting}。`);
  if (role.key_memories) parts.push(`关键记忆：${role.key_memories}。`);
  if (role.rules) parts.push(`行为规则与禁忌：${role.rules}。`);
  if (role.example_dialogue) parts.push(`说话风格示例：${role.example_dialogue}。`);
  parts.push(affinityTone(role.affinity));
  // 情绪系统：把当前心情注入上下文，影响模型输出语气与情节走向
  parts.push(buildEmotionContext(role));
  // ===== 规则库注入 =====
  const settings = dm.getSettings();
  const allRules = dm.listRules();
  const charRuleIds = role.ruleIds || [];
  const charRules = allRules.filter((r) => charRuleIds.includes(r.id));
  const sharedRules = allRules.filter((r) => (settings.sharedRuleIds || []).includes(r.id));
  if (charRules.length > 0) {
    parts.push(`【角色专属规则】\n${charRules.map((r) => `- ${r.content}`).join('\n')}`);
  }
  if (sharedRules.length > 0) {
    parts.push(`【通用规则（所有对话均需遵守）】\n${sharedRules.map((r) => `- ${r.content}`).join('\n')}`);
  }
  // ===== 记忆注入（观察者模式「记忆冻结」时跳过外部历史记忆）=====
  if (!freezeMemory) {
    // 记忆隔离：开启时只取该聊天的记忆 + 角色级共享记忆（chatId 为空）；关闭则取角色全部记忆
    const iso = role.memoryIsolation ?? true;
    const memories = dm.listMemories(role.id, iso ? chatId : undefined);
    if (memories.length > 0) {
      parts.push(`【关于你与用户的记忆】\n${memories.map((m) => `- ${m.content}`).join('\n')}`);
    }
  }
  parts.push('请始终以该角色身份和口吻回复，不要跳出角色，不要提及你是AI或语言模型。');
  return parts.join('\n');
}

function copyImageToStore(absPath: string | null): string | null {
  if (!absPath) return null;
  try {
    if (!fs.existsSync(absPath)) return null;
    const ext = path.extname(absPath) || '.png';
    const name = `img_${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`;
    const dest = path.join(dm.imagesDir, name);
    fs.copyFileSync(absPath, dest);
    return dest;
  } catch (e) {
    console.error('复制图片失败', e);
    return null;
  }
}

// 多图：逐张复制到 images 目录，返回成功落盘的绝对路径数组
function copyImagesToStore(paths?: string[] | null): string[] | null {
  if (!paths || paths.length === 0) return null;
  const out: string[] = [];
  for (const p of paths) {
    const stored = copyImageToStore(p);
    if (stored) out.push(stored);
  }
  return out.length ? out : null;
}

// ===== 角色卡导入：兼容 SillyTavern 的 PNG 角色卡 =====
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 从 PNG 二进制中提取 tEXt 块的 `chara` 字段（SillyTavern 角色卡元数据）
function extractPngCharaChunk(buffer: Buffer): string | null {
  if (buffer.length < PNG_SIG.length + 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buffer.length) break;
    if (type === 'tEXt') {
      const sepRel = buffer.subarray(dataStart, dataEnd).indexOf(0);
      const sep = sepRel >= 0 ? dataStart + sepRel : -1;
      if (sep !== -1) {
        const key = buffer.toString('utf8', dataStart, sep);
        if (key === 'chara') {
          return buffer.toString('utf8', sep + 1, dataEnd);
        }
      }
    }
    if (type === 'IEND') break;
    off = dataEnd + 4; // 跳过 CRC
  }
  return null;
}

// 解析 PNG 角色卡为 JSON 对象（兼容直接 JSON 或 base64 包裹）
function parseCharacterPng(buffer: Buffer): any | null {
  const chara = extractPngCharaChunk(buffer);
  if (!chara) return null;
  let json: any = null;
  try {
    json = JSON.parse(chara);
  } catch {
    try {
      json = JSON.parse(Buffer.from(chara, 'base64').toString('utf8'));
    } catch {
      json = null;
    }
  }
  return json && typeof json === 'object' ? json : null;
}

// 将 base64 头像字符串写入图片目录，返回路径
function writeBase64Avatar(b64: string): string | null {
  try {
    const m = b64.match(/^data:(image\/\w+)(;base64)?,/);
    const mime = m ? m[1] : 'image/png';
    const pure = b64.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(pure, 'base64');
    const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
    const name = `avatar_${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`;
    const dest = path.join(dm.imagesDir, name);
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (e) {
    console.error('写入 base64 头像失败', e);
    return null;
  }
}

// 将图片绝对路径读为 data URL（base64 内联），用于多模态模型输入
function imageToDataUrl(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const ext = path.extname(p).toLowerCase();
    const mime =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/png';
    const b64 = fs.readFileSync(p).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

// 收集一条消息的图片绝对路径（images 数组优先，回退 image_path）
function collectImagePaths(m: ChatMessage): string[] {
  return ((m.images && m.images.length ? m.images : m.image_path ? [m.image_path] : []) as string[]).filter(Boolean);
}

// 构建用户消息内容：vision 模型返回多模态 content parts（文本 + 图片），否则返回占位文本（不报错）
function buildUserContent(text: string, images: string[], vision: boolean): string | ContentPart[] {
  if (vision && images.length) {
    const parts: ContentPart[] = [];
    if (text && text.trim()) parts.push({ type: 'text', text });
    for (const p of images) {
      const url = imageToDataUrl(p);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
    if (parts.length) return parts;
  }
  return images.length ? `[用户发送了一张图片]${text || ''}` : text || '';
}

function historyToMessages(history: ChatMessage[], vision = false): AIMessage[] {
  return history.map((m) => {
    const images = collectImagePaths(m);
    const base = m.content || '';
    return {
      role: m.sender_type === 'user' ? 'user' : 'assistant',
      content: buildUserContent(base, images, vision),
    };
  });
}

// ===== 上下文 / 短期记忆控制 =====
// 轻量 token 估算（启发式，非精确）：CJK/全角约 1 token/字符，其它约 4 字符 1 token。
// 用于「上下文限制(maxContext)」裁剪，避免超大历史超出模型上下文窗口；估算偏差不影响功能正确性。
function estimateTokens(s: string): number {
  if (!s) return 0;
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x2e80) t += 1;
    else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) t += 0;
    else t += 0.25;
  }
  return Math.ceil(t);
}

function messageTokens(m: any): number {
  if (!m) return 0;
  if (typeof m.content === 'string') return estimateTokens(m.content);
  if (Array.isArray(m.content)) {
    return m.content.reduce(
      (sum: number, part: any) => sum + (part?.type === 'text' ? estimateTokens(part.text || '') : 256),
      0
    );
  }
  return 0;
}

// 上下文裁剪：maxContext>0 时，保留 system(首条) 并从最新消息向前保留，直到估算 token <= maxContext（至少保留 1 条最新消息）。
function trimToContext(messages: any[], maxContext: number): void {
  if (!maxContext || maxContext <= 0 || messages.length <= 1) return;
  const sys = messages[0];
  const rest = messages.slice(1);
  const sysTok = messageTokens(sys);
  const total0 = sysTok + rest.reduce((s, m) => s + messageTokens(m), 0);
  if (total0 <= maxContext) return;
  const kept: any[] = [];
  let running = sysTok;
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = messageTokens(rest[i]);
    if (kept.length === 0 || running + t <= maxContext) {
      kept.unshift(rest[i]);
      running += t;
    } else {
      break;
    }
  }
  messages.length = 0;
  messages.push(sys, ...kept);
}

// 短期记忆条数上限：memReadLimit>0 时生效，否则回退默认窗口（群 24 / 单 16）。
function effectiveHistoryCap(cfg?: ModelConfig, isGroup = false): number {
  if (cfg && cfg.memReadLimit && cfg.memReadLimit > 0) return cfg.memReadLimit;
  return isGroup ? 24 : 16;
}

// ===== 请求限速（QPS）：每模型每分钟最多 N 次请求 =====
// 仅记录时间戳，真实延迟由调用方在发请求前 sleep；前端也会用 rateInfo 做预排队 UI。
const RATE_WINDOW_MS = 60000;
const modelRequestLog = new Map<string, number[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 计算某模型还需等待多少毫秒才能再发一次（基于该模型配置的 qps）；无限制返回 0
function rateWaitMs(modelId: string): number {
  const settings = dm.getSettings();
  const cfg = settings.models.find((m) => m.id === modelId);
  const qps = cfg?.qps;
  if (!qps || qps <= 0) return 0;
  const now = Date.now();
  const arr = (modelRequestLog.get(modelId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  modelRequestLog.set(modelId, arr);
  if (arr.length < qps) return 0;
  return RATE_WINDOW_MS - (now - arr[0]) + 50;
}

// 标记一次实际发出的请求（用于计数）
function rateMark(modelId: string): void {
  if (!modelId) return;
  const now = Date.now();
  const arr = (modelRequestLog.get(modelId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  modelRequestLog.set(modelId, arr);
}

// ===== 翻译（右键菜单翻译文本） =====
async function translateText(text: string, settings: AppSettings): Promise<string> {
  const modelId = settings.translationModelId || settings.defaultModel;
  const cfg = settings.models.find((m) => m.id === modelId && m.enabled);
  if (!cfg) return text;
  const target = settings.translationLang === 'auto' ? settings.lang : settings.translationLang || settings.lang;
  const langName = target === 'en' ? 'English' : '中文';
  const prompt = `请将下面的文本翻译成${langName}，只返回译文本身，不要任何解释，也不要用引号包裹：\n\n${text}`;
  const res = await queryAI(
    cfg,
    [
      { role: 'system', content: 'You are a precise translator. Output only the translation.' },
      { role: 'user', content: prompt },
    ],
    1024
  );
  return res.content || text;
}

async function handleSend(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
  visibleToGroup?: boolean;
  toMemory?: boolean;
}): Promise<SendMessageResult> {
  const settings = dm.getSettings();
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) {
    throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  }
  validateModels(memberRoles, settings);

  const userMsg = addUserMessage(p);

  // 群聊选人回复：用户发消息后不直接生成，先广播「请选择下一位发言者」，由前端驱动后续生成
  if (p.chatType === 'group' && settings.groupSelectReply) {
    broadcast('group:needSpeaker', {
      chatId: p.chatId,
      members: memberRoles.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_path })),
    });
    return { userMessage: userMsg, aiMessages: [], affinityChanges: [], totalTokens: 0 };
  }

  const result = await generateAIResponses(
    { ...p, imagePath: userMsg.image_path, imagePaths: userMsg.images },
    memberRoles,
    settings
  );
  return { userMessage: userMsg, ...result };
}

function resolveMembers(chatType: string, chatId: string, content: string): Role[] {
  let memberRoles: Role[] = [];
  if (chatType === 'single') {
    const r = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
    if (r) memberRoles = [r];
  } else {
    const g = dm.getGroup(chatId);
    if (g) {
      const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
      let roles = ids.map((id) => dm.getRole(id)).filter(Boolean) as Role[];
      const mentioned = roles.filter((r) => content.includes('@' + r.name));
      if (mentioned.length > 0) roles = mentioned;
      memberRoles = roles;
    }
  }
  return memberRoles;
}

function resolveRoleModel(role: Role, settings: AppSettings): ModelConfig | undefined {
  return (
    settings.models.find((m) => m.id === role.model_config_id && m.enabled) ||
    settings.models.find((m) => m.id === settings.defaultModel && m.enabled)
  );
}

// 取设置里的默认模型配置（随机事件一律用默认 AI 生成，不计入聊天消耗）
function getDefaultModelConfig(settings: AppSettings): ModelConfig | undefined {
  return settings.models.find((m) => m.id === settings.defaultModel && m.enabled);
}

// 解析当前对话实际使用的「自我身份」：
// 优先取按会话覆盖（chatSelfRoles[key]），否则回退全局默认 currentSelfRoleId。
// 覆盖值可为具体 selfRoleId / 'none'（不使用身份）/ 'default'（用全局默认）。
function resolveActiveSelfRole(
  settings: AppSettings,
  chatType: string,
  chatId: string
): SelfRole | undefined {
  const override = settings.chatSelfRoles?.[`${chatType}:${chatId}`];
  let id: string | undefined;
  if (override === undefined || override === 'default' || override === '') {
    id = settings.currentSelfRoleId;
  } else if (override === 'none') {
    return undefined;
  } else {
    id = override;
  }
  if (!id) return undefined;
  return settings.selfRoles?.find((r) => r.id === id);
}

function validateModels(memberRoles: Role[], settings: AppSettings): void {
  const resolveModel = (role: Role): ModelConfig | undefined => resolveRoleModel(role, settings);
  const invalid = memberRoles.find((r) => !resolveModel(r));
  if (invalid) {
    throw new Error(`角色[${invalid.name}]绑定的模型已失效，请重新选择模型`);
  }
}

function addUserMessage(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
  visibleToGroup?: boolean;
  toMemory?: boolean;
}): ChatMessage {
  const settings = dm.getSettings();
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  // 多图优先：使用 imagePaths 数组；单图回退到 imagePath
  const multi = p.imagePaths && p.imagePaths.length ? copyImagesToStore(p.imagePaths) : null;
  const storedImage = multi ? multi[0] : copyImageToStore(p.imagePath || null);
  // 群聊可见性 / 记忆收录：visibleToGroup 默认 true；toMemory 仅在可见时生效，默认 true
  const visible = p.visibleToGroup !== false;
  const toMem = visible && p.toMemory !== false;
  const msg = dm.addMessage({
    chat_type: p.chatType as any,
    chat_id: p.chatId,
    sender_type: 'user',
    sender_name: selfRole?.name || '我',
    content: p.content || '',
    image_path: storedImage,
    images: multi || null,
    token_used: 0,
    timestamp: new Date().toISOString(),
    visibleToGroup: visible,
    toMemory: toMem,
    msg_kind: visible ? 'public' : 'private',
  });
  // 广播用户消息到所有窗口（让 MiniChat 发出的图片在小窗/主窗同步显示）
  broadcast('stream:user', msg);
  return msg;
}

function applyAffinityChange(role: Role, content: string, storedImage: string | null): number {
  const sentiment = analyzeSentiment(content);
  if (sentiment.change !== 0 && !storedImage) {
    return dm.updateAffinity(role.id, sentiment.change, sentiment.reason);
  }
  return role.affinity;
}

function buildMessagesForRole(
  role: Role,
  content: string,
  storedImage: string | null,
  history: ChatMessage[],
  affinityTotal: number,
  selfRole?: SelfRole | null,
  worldBook?: string,
  instruction?: string,
  freezeMemory = false,
  privateObserver = false,
  storedImages?: string[] | null,
  vision = false,
  chatId?: string
): AIMessage[] {
  const parts: string[] = [buildSystemPrompt({ ...role, affinity: affinityTotal }, freezeMemory, chatId)];
  // 观察者私密小窗：告知 AI 这是完全私密的一对一，可袒露内心推演
  if (privateObserver) {
    parts.push(
      '（这是你与观察者之间完全私密的 1 对 1 对话，外界与其他对局参与者都看不到。你可以毫无保留地袒露内心推演、真实盘算与私下想法，不必像公开场合那样克制。）'
    );
  }
  if (worldBook && worldBook.trim()) {
    parts.push(`【世界书 / 共享世界观】\n${worldBook.trim()}`);
  }
  if (selfRole && selfRole.name) {
    const b: string[] = [`你正在与用户「${selfRole.name}」对话。`];
    if (selfRole.gender) b.push(`性别：${selfRole.gender}。`);
    if (selfRole.age) b.push(`年龄：${selfRole.age}。`);
    if (selfRole.short_intro) b.push(`简介：${selfRole.short_intro}。`);
    if (selfRole.personality) b.push(`性格：${selfRole.personality}。`);
    if (selfRole.background) b.push(`背景：${selfRole.background}。`);
    if (selfRole.world_setting) b.push(`世界观：${selfRole.world_setting}。`);
    parts.push(`【对话对象（用户）设定】\n${b.join('\n')}`);
  }
  const sysPrompt = parts.join('\n\n');
  const finalImages =
    storedImages && storedImages.length ? storedImages : storedImage ? [storedImage] : [];
  return [
    { role: 'system', content: sysPrompt },
    ...historyToMessages(history, vision),
    {
      role: 'user',
      content: instruction
        ? instruction
        : buildUserContent(content, finalImages, vision),
    },
  ];
}

// ===== 群聊互聊：带发言人标注的消息构建 =====
// 群聊中每个成员要能「看见」其他成员的发言：
// 自己的历史发言 → assistant；其他成员/用户的发言 → user（带「名字: 」前缀）。
// 连续同角色消息合并为一条，兼容要求严格交替的 API。
function buildGroupMessages(
  role: Role,
  memberNames: string[],
  history: ChatMessage[],
  affinityTotal: number,
  selfRole: SelfRole | undefined,
  worldBook: string,
  instruction?: string,
  freezeMemory = false,
  groupId?: string,
  vision = false
): AIMessage[] {
  const parts: string[] = [buildSystemPrompt({ ...role, affinity: affinityTotal }, freezeMemory, groupId)];
  if (worldBook && worldBook.trim()) {
    parts.push(`【世界书 / 共享世界观】\n${worldBook.trim()}`);
  }
  if (selfRole && selfRole.name) {
    const b: string[] = [`群聊中的用户是「${selfRole.name}」。`];
    if (selfRole.gender) b.push(`性别：${selfRole.gender}。`);
    if (selfRole.age) b.push(`年龄：${selfRole.age}。`);
    if (selfRole.short_intro) b.push(`简介：${selfRole.short_intro}。`);
    if (selfRole.personality) b.push(`性格：${selfRole.personality}。`);
    if (selfRole.background) b.push(`背景：${selfRole.background}。`);
    if (selfRole.world_setting) b.push(`世界观：${selfRole.world_setting}。`);
    parts.push(`【对话对象（用户）设定】\n${b.join('\n')}`);
  }
  parts.push(
    `【群聊规则】\n这是一个多人群聊，成员有：${memberNames.join('、')}。\n` +
      `你是「${role.name}」，只能以「${role.name}」的身份发言。\n` +
      `下面对话中「名字: 内容」表示对应成员或用户的发言。\n` +
      `不要代替其他成员或用户发言；不要在回复前加「${role.name}:」之类的名字前缀，直接说话即可。` +
      (groupId && dm.getGroup(groupId)?.aiMentionEnabled
        ? `\n如果需要引起其他成员的注意，可以使用 @名字 来点名他们。`
        : '')
  );
  const msgs: AIMessage[] = [{ role: 'system', content: parts.join('\n\n') }];
  for (const m of history) {
    const images = collectImagePaths(m);
    const isSelf = m.sender_type === 'ai' && m.sender_name === role.name;
    const roleTag: 'user' | 'assistant' = isSelf ? 'assistant' : 'user';
    const text = images.length ? `[发送了一张图片]${m.content || ''}` : (m.content || '');
    const textContent = isSelf ? text : `${m.sender_name}: ${text}`;
    let content: string | ContentPart[];
    if (vision && images.length) {
      const parts2: ContentPart[] = [];
      if (textContent) parts2.push({ type: 'text', text: textContent });
      for (const p of images) {
        const url = imageToDataUrl(p);
        if (url) parts2.push({ type: 'image_url', image_url: { url } });
      }
      content = parts2.length ? parts2 : textContent;
    } else {
      content = textContent;
    }
    const last = msgs[msgs.length - 1];
    // 多模态内容（数组）不与文本合并，避免破坏 parts 结构；仅文本之间合并
    if (last && last.role === roleTag && typeof last.content === 'string' && typeof content === 'string') {
      last.content += `\n${content}`;
    } else {
      msgs.push({ role: roleTag, content });
    }
  }
  if (instruction) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') last.content += `\n\n${instruction}`;
    else msgs.push({ role: 'user', content: instruction });
  } else if (msgs[msgs.length - 1].role !== 'user') {
    msgs.push({ role: 'user', content: '（请继续这段群聊，自然接话）' });
  }
  return msgs;
}

// 取群全部成员名（提示词用，不受 @ 过滤影响）
function getGroupMemberNames(groupId: string): string[] {
  const g = dm.getGroup(groupId);
  if (!g) return [];
  return g.member_ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => dm.getRole(id)?.name)
    .filter(Boolean) as string[];
}

async function generateAIResponses(
  p: { chatType: string; chatId: string; content: string; imagePath?: string | null; imagePaths?: string[] | null },
  memberRoles: Role[],
  settings: AppSettings,
  controller?: AbortController
): Promise<Omit<SendMessageResult, 'userMessage'>> {
  const storedImage = p.imagePath || null;
  const storedImages = p.imagePaths && p.imagePaths.length ? p.imagePaths : (p.imagePath ? [p.imagePath] : []);
  const history = dm.getMessages(p.chatType, p.chatId);
  const resolveModel = (role: Role): ModelConfig | undefined => resolveRoleModel(role, settings);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const isGroup = p.chatType === 'group';
  // 观察者模式「记忆冻结」：对局内不读取外部世界书
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const groupNames = isGroup ? getGroupMemberNames(p.chatId) : [];

  // 联网搜索：每个聊天每次只检索一次，结果作为上下文注入所有成员的回复
  let searchCtx: string | null = null;
  if (settings.webSearchChats?.[`${p.chatType}:${p.chatId}`]) {
    const sp = await fetchSearchContext(p.chatType, p.chatId, p.content, settings);
    searchCtx = sp?.context ?? null;
  }
  // 已启用插件的提示词片段（声明式，全局生效）
  const pluginCtx = getEnabledPluginContext();

  const runOne = async (role: Role, hist: ChatMessage[], searchContext?: string | null) => {
    const cfg = resolveModel(role) as ModelConfig;
    const vision = !!cfg?.supportsImages;
    // 短期记忆条数上限：按模型 memReadLimit 裁剪最近对话（隔离于每个角色配置）
    hist = hist.slice(-effectiveHistoryCap(cfg, isGroup));
    // 私密小窗：若关闭「影响情绪好感」，则不因该对话改变好感度
    const isPrivate = !isGroup && p.chatId.startsWith('obs:');
    const allowEmotion = !isPrivate || !!obs?.privateAffectsEmotion;
    const total = allowEmotion ? applyAffinityChange(role, p.content, storedImage) : role.affinity;
    // 群聊：串行 + 带发言人标注，让成员能看见彼此的发言；单聊维持原逻辑
    const messages = isGroup
      ? buildGroupMessages(role, groupNames, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, p.chatId, vision)
      : buildMessagesForRole(
          role,
          p.content,
          storedImage,
          hist,
          total,
          selfRole,
          worldBook,
          undefined,
          obs?.freezeMemory,
          isPrivate,
          storedImages,
          vision,
          p.chatId
        );
    if (searchContext) {
      appendToFirstSystem(
        messages,
        `【联网搜索结果 · 网页正文 · 必须依据】
以下是实时联网检索并抓取网页正文得到的资料（已滤除广告/样式/脚本，仅保留正文），已按 [1]、[2]… 依次编号，与用户当前问题高度相关。你必须优先依据这些资料回答，不得凭空编造，也不得只依赖自身记忆；若资料中包含答案，请直接引用其中的关键信息并自然融入角色口吻的回复（可提及"据搜索/资料显示"，但严禁说"我搜索了"）。
引用要求：当你在回复中使用了某条资料的信息时，请在对应内容的句末用其编号标注，例如「相关结论……[1]」；若同时参考了多条资料，可并列标注如「……[1][3]」；只标注你真正用到的编号，不得编造不存在的编号。资料确实与问题无关时才可不引用。
${searchContext}`
      );
      console.log('[websearch] injected search ctx len=', searchContext.length, 'role=', role.name);
    }
    if (pluginCtx) {
      appendToFirstSystem(messages, `【已启用插件指令】\n${pluginCtx}`);
    }
    // 上下文限制裁剪（maxContext>0 时按 token 预算丢弃最旧非 system 消息）
    trimToContext(messages, (cfg as ModelConfig)?.maxContext ?? 0);
    const streamId = `${p.chatId}:${role.id}`;
    // 每个成员完成时立即广播，前端按完成顺序逐步显示；即使关闭全局流式也生效。
    sendStreamStart(streamId, role.id, role.name);
    try {
      // 请求限速（QPS）：超出则等待限速窗口解除后再发，避免触发服务端限流
      const wait = rateWaitMs(cfg.id);
      if (wait > 0) await sleep(wait);
      rateMark(cfg.id);
      const res = await queryAI(cfg, messages, 1024, controller?.signal);
      if (res.error) {
        // 模型回复错误：不进聊天框、不进记忆；用气泡通知用户（前端据此显示重发面板）
        notifyModelError(res.error, role.name);
        sendStreamChunk(streamId, { content: '', done: true, error: res.error.message, seq: 1 });
        return { aiMsg: null as any, roleId: role.id, total, tokens: 0, error: res.error.message };
      }
      const aiMsg = dm.addMessage({
        chat_type: p.chatType as any,
        chat_id: p.chatId,
        sender_type: 'ai',
        sender_name: role.name,
        content: res.content,
        reasoning: res.reasoning,
        image_path: null,
        token_used: res.promptTokens + res.completionTokens,
        timestamp: new Date().toISOString(),
      });
      sendStreamDone(streamId, aiMsg);
      void requestMoodJudge(p.chatType, p.chatId, role.id);
      void requestRelationshipAndMoments(p.chatType, p.chatId, role.id);
      void triggerSceneImage(p.chatType, p.chatId, role.id);
      return { aiMsg, roleId: role.id, total, tokens: aiMsg.token_used };
    } catch (e: any) {
      // 被打断：保留头像/名称/气泡，用省略号占位；其他异常用气泡通知，不把错误文本写进聊天框
      const interrupted = controller ? controller.signal.aborted : false;
      if (interrupted) {
        const msg = dm.addMessage({
          chat_type: p.chatType as any,
          chat_id: p.chatId,
          sender_type: 'ai',
          sender_name: role.name,
          content: '...',
          image_path: null,
          token_used: 0,
          timestamp: new Date().toISOString(),
        });
        sendStreamDone(streamId, msg);
        return { aiMsg: msg, roleId: role.id, total, tokens: 0 };
      }
      const info: ModelErrorInfo = { code: 'exception', message: e?.message || String(e), detail: e?.stack };
      notifyModelError(info, role.name);
      sendStreamChunk(streamId, { content: '', done: true, error: info.message, seq: 1 });
      return { aiMsg: null as any, roleId: role.id, total, tokens: 0, error: info.message };
    }
  };

  let results: { aiMsg: ChatMessage | null; roleId: string; total: number; tokens: number; error?: string }[];
  if (isGroup) {
    // 串行轮流发言：每位成员生成后立即落库，下一位重新读取最新历史（含前一位的发言）
    results = [];
    for (const role of memberRoles) {
      const hist = dm.getMessages(p.chatType, p.chatId).slice(-effectiveHistoryCap(resolveModel(role), true));
      results.push(await runOne(role, hist, searchCtx));
    }
  } else {
    results = await Promise.all(memberRoles.map((role) => runOne(role, history, searchCtx)));
  }

  const aiMessages: ChatMessage[] = [];
  const affinityChanges: { role_id: string; change: number; total: number }[] = [];
  let totalTokens = 0;
  for (const r of results) {
    if (!r.aiMsg) continue; // 模型回复错误：仅气泡通知，不写入聊天（前端已显示重发面板）
    aiMessages.push(r.aiMsg);
    const original = memberRoles.find((role) => role.id === r.roleId)?.affinity || r.total;
    affinityChanges.push({ role_id: r.roleId, change: r.total - original, total: r.total });
    totalTokens += r.tokens;
  }
  return { aiMessages, affinityChanges, totalTokens };
}

async function handleSendUser(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
  visibleToGroup?: boolean;
  toMemory?: boolean;
}): Promise<ChatMessage> {
  return addUserMessage(p);
}

// 进行中的流式生成控制器，按 chatId 归组；删除聊天时整体中止，杜绝孤儿流继续写库
const streamControllers = new Map<string, AbortController>();
function registerStream(chatId: string, c: AbortController): void {
  const prev = streamControllers.get(chatId);
  if (prev && prev !== c) prev.abort(); // 同一聊天只保留一条进行中生成
  streamControllers.set(chatId, c);
}
function unregisterStream(chatId: string, c: AbortController): void {
  if (streamControllers.get(chatId) === c) streamControllers.delete(chatId);
}
function abortStreamsForChat(chatId: string): void {
  const c = streamControllers.get(chatId);
  if (c) {
    c.abort();
    streamControllers.delete(chatId);
  }
}

async function handleSendAI(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
}): Promise<Omit<SendMessageResult, 'userMessage'>> {
  const settings = dm.getSettings();
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) {
    throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  }
  validateModels(memberRoles, settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);
  try {
    return await generateAIResponses(p, memberRoles, settings, controller);
  } finally {
    clearTimeout(timer);
    unregisterStream(p.chatId, controller);
  }
}

// 流式生成：单聊与群聊通用；群聊按 settings.streamParallel 分批并发
async function handleStream(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
  visibleToGroup?: boolean;
  toMemory?: boolean;
}): Promise<{ userMessage: ChatMessage; members: { streamId: string; roleId: string; roleName: string }[] }> {
  const settings = dm.getSettings();
  const parallel = Math.max(1, Math.floor(settings.streamParallel) || 1);
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) {
    throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  }
  validateModels(memberRoles, settings);

  const userMsg = addUserMessage(p);
  const storedImage = userMsg.image_path;
  const storedImages = userMsg.images || (userMsg.image_path ? [userMsg.image_path] : []);
  const history = dm.getMessages(p.chatType, p.chatId);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const isGroup = p.chatType === 'group';
  // 观察者模式「记忆冻结」：对局内不读取外部世界书
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const groupNames = isGroup ? getGroupMemberNames(p.chatId) : [];

  // 联网搜索：每个聊天每次只检索一次，结果作为上下文注入所有成员的回复
  let searchCtx: string | null = null;
  if (settings.webSearchChats?.[`${p.chatType}:${p.chatId}`]) {
    const sp = await fetchSearchContext(p.chatType, p.chatId, p.content, settings);
    searchCtx = sp?.context ?? null;
  }
  // 已启用插件的提示词片段（声明式，全局生效）
  const pluginCtx = getEnabledPluginContext();

  const members = memberRoles.map((role) => ({
    streamId: `${p.chatId}:${role.id}`,
    roleId: role.id,
    roleName: role.name,
  }));

  // 整段生成（群聊多位成员串行）共享一个控制器，删除聊天时整体中止，避免孤儿流继续写库产生幽灵会话
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);

  const streamOne = async (role: Role, searchContext?: string | null) => {
    if (controller.signal.aborted) return;
    const cfg = resolveRoleModel(role, settings) as ModelConfig;
    const vision = !!cfg?.supportsImages;
    const streamId = `${p.chatId}:${role.id}`;
    let seq = 0;
    const emitChunk = (content: string, done: boolean, error: string, reasoning = '') => {
      seq += 1;
      sendStreamChunk(streamId, { content, reasoning, done, error, seq });
    };
    // 私密小窗：若关闭「影响情绪好感」，则不因该对话改变好感度
    const isPrivate = !isGroup && p.chatId.startsWith('obs:');
    const allowEmotion = !isPrivate || !!obs?.privateAffectsEmotion;
    const total = allowEmotion ? applyAffinityChange(role, p.content, storedImage) : role.affinity;
    // 群聊：每位成员发言前重新读取最新历史（含前面成员刚说的话），并用带发言人标注的构建器
    const hist = isGroup ? dm.getMessages(p.chatType, p.chatId).slice(-effectiveHistoryCap(cfg, true)) : history.slice(-effectiveHistoryCap(cfg, false));
    const messages = isGroup
      ? buildGroupMessages(role, groupNames, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, p.chatId, vision)
      : buildMessagesForRole(
          role,
          p.content,
          storedImage,
          hist,
          total,
          selfRole,
          worldBook,
          undefined,
          obs?.freezeMemory,
          isPrivate,
          storedImages,
          vision,
          p.chatId
        );
    if (searchContext) {
      appendToFirstSystem(
        messages,
        `【联网搜索结果 · 网页正文 · 必须依据】
以下是实时联网检索并抓取网页正文得到的资料（已滤除广告/样式/脚本，仅保留正文），已按 [1]、[2]… 依次编号，与用户当前问题高度相关。你必须优先依据这些资料回答，不得凭空编造，也不得只依赖自身记忆；若资料中包含答案，请直接引用其中的关键信息并自然融入角色口吻的回复（可提及"据搜索/资料显示"，但严禁说"我搜索了"）。
引用要求：当你在回复中使用了某条资料的信息时，请在对应内容的句末用其编号标注，例如「相关结论……[1]」；若同时参考了多条资料，可并列标注如「……[1][3]」；只标注你真正用到的编号，不得编造不存在的编号。资料确实与问题无关时才可不引用。
${searchContext}`
      );
      console.log('[websearch] injected search ctx len=', searchContext.length, 'role=', role.name);
    }
    if (pluginCtx) {
      appendToFirstSystem(messages, `【已启用插件指令】\n${pluginCtx}`);
    }
    sendStreamStart(streamId, role.id, role.name);
    // 中断时保留已生成的部分内容并落库（DeepSeek 风格的「打断生成」）
    let full = '';
    let reasoningAcc = '';
    // 被打断时给已输出内容追加省略号，未输出部分用「...」占位，避免气泡消失只剩头像名称
    const truncateMarker = '...';
    const finalizeRole = (content: string, reasoning: string, interrupted: boolean) => {
      let finalContent = content.trim();
      if (interrupted) {
        if (!finalContent) finalContent = truncateMarker;
        else if (!/[.…。]+$/.test(finalContent)) finalContent += truncateMarker;
      }
      const aiMsg = dm.addMessage({
        chat_type: p.chatType as any,
        chat_id: p.chatId,
        sender_type: 'ai',
        sender_name: role.name,
        content: finalContent,
        reasoning: reasoning || '',
        image_path: null,
        token_used: 0,
        timestamp: new Date().toISOString(),
      });
      sendStreamDone(streamId, aiMsg);
      if (!interrupted) void requestMoodJudge(p.chatType, p.chatId, role.id);
      if (!interrupted) void requestRelationshipAndMoments(p.chatType, p.chatId, role.id);
      if (!interrupted) void triggerSceneImage(p.chatType, p.chatId, role.id);
    };
    try {
      // 请求限速（QPS）：超出则等待限速窗口解除后再发，避免触发服务端限流
      const wait = rateWaitMs(cfg.id);
      if (wait > 0) await sleep(wait);
      rateMark(cfg.id);
      // Anthropic 不支持流式，回退到非流式（一次性整段）
      if (cfg.provider === 'anthropic') {
        const res = await queryAI(cfg, messages, 1024);
        if (res.error) {
          // 模型回复错误：不进聊天框、不进记忆；用气泡通知用户
          notifyModelError(res.error, role.name);
          emitChunk('', true, res.error.message);
          return;
        }
        if (controller.signal.aborted) {
          finalizeRole(res.content || '', res.reasoning || '', true);
          return;
        }
        emitChunk(res.content, true, '', res.reasoning || '');
        finalizeRole(res.content, res.reasoning || '', false);
        return;
      }

      const res = await streamAI(
        cfg,
        messages,
        1024,
        (chunk) => {
          if (chunk.content) full += chunk.content;
          if (chunk.reasoning) reasoningAcc += chunk.reasoning;
          emitChunk(chunk.content || '', chunk.done, '', chunk.reasoning || '');
        },
        controller
      );
      if (controller.signal.aborted) {
        finalizeRole(full || '', reasoningAcc || '', true);
        return;
      }
      finalizeRole(full || res.content || '', reasoningAcc || res.reasoning || '', false);
    } catch (e: any) {
      if (controller.signal.aborted) {
        // 中断导致的流异常：保留已生成部分内容，静默收尾
        finalizeRole(full || '', reasoningAcc || '', true);
        return;
      }
      // 模型流式错误：诊断 + 气泡通知（前端据此显示重发面板），不把错误文本写进聊天框
      const info: ModelErrorInfo = e instanceof ModelApiError
        ? { status: e.status, code: e.code, message: e.message, detail: e.detail }
        : { code: 'exception', message: e?.message || String(e), detail: e?.stack };
      notifyModelError(info, role.name);
      emitChunk('', true, info.message);
    }
  };

  // 群聊：强制串行轮流发言（互聊的前提——每位成员要能看到前一位刚说的话）。
  // 单聊：保留原分批并发逻辑（单聊只有 1 个成员，行为等价）。
  // 整体 fire-and-forget，确保 startStream 立即返回 userMessage，流式在后台进行。
  (async () => {
    try {
      if (isGroup) {
        for (const role of memberRoles) {
          if (controller.signal.aborted) break;
          await streamOne(role, searchCtx);
        }
      } else {
        for (let i = 0; i < memberRoles.length; i += parallel) {
          if (controller.signal.aborted) break;
          const batch = memberRoles.slice(i, i + parallel);
          await Promise.all(batch.map((role) => streamOne(role, searchCtx)));
        }
      }
    } finally {
      clearTimeout(timer);
      unregisterStream(p.chatId, controller);
      // 整轮流式结束（无论群聊串行几轮、单聊并行几批，最终统一发一次）。
      // 前端以此判断"用户消息之后所有 AI 回复都已完成",触发 AI 主动续聊。
      broadcast('stream:roundDone', { chatId: p.chatId, chatType: p.chatType });
    }
  })();

  return { userMessage: userMsg, members };
}

// ===== 群聊接话调度（导演模型 / 轮询）与「继续对话」 =====
function pickRoundRobin(memberRoles: Role[], history: ChatMessage[]): Role {
  const lastAi = [...history].reverse().find((m) => m.sender_type === 'ai');
  if (!lastAi) return memberRoles[0];
  const idx = memberRoles.findIndex((r) => r.name === lastAi.sender_name);
  return memberRoles[(idx + 1) % memberRoles.length] || memberRoles[0];
}

async function pickNextSpeaker(
  memberRoles: Role[],
  settings: AppSettings,
  history: ChatMessage[]
): Promise<Role> {
  if (settings.groupScheduler === 'roundRobin' || memberRoles.length === 1) {
    return pickRoundRobin(memberRoles, history);
  }
  // 导演模型：用默认（或第一个可用）模型从成员中挑「最该接话的人」；失败回退轮询
  const cfg =
    settings.models.find((m) => m.id === settings.defaultModel && m.enabled) ||
    settings.models.find((m) => m.enabled);
  if (!cfg) return pickRoundRobin(memberRoles, history);
  const lastSpeaker =
    [...history].reverse().find((m) => m.sender_type === 'ai')?.sender_name || '';
  const candidates = memberRoles.filter((r) => r.name !== lastSpeaker);
  const pool = candidates.length > 0 ? candidates : memberRoles;
  const recent = history
    .slice(-10)
    .map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 200)}`)
    .join('\n');
  try {
    const res = await queryAI(
      cfg,
      [
        {
          role: 'system',
          content:
            '你是群聊导演。根据最近的对话，从候选成员中选出最适合接话的一位。只输出该成员的名字，不要输出任何其他内容。',
        },
        {
          role: 'user',
          content: `候选成员：${pool.map((r) => r.name).join('、')}\n\n最近对话：\n${recent}\n\n最适合接话的成员是：`,
        },
      ],
      24
    );
    const text = (res.content || '').trim();
    const hit =
      pool.find((r) => text.includes(r.name)) ||
      memberRoles.find((r) => text.includes(r.name));
    if (hit) return hit;
  } catch (e) {
    console.error('导演调度失败，回退轮询', e);
  }
  return pickRoundRobin(memberRoles, history);
}

// 群聊自动接话：计算末尾同一角色已连续发言的条数
function countConsecutiveByRole(history: ChatMessage[], roleName: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].sender_name === roleName) count++;
    else break;
  }
  return count;
}

// 继续对话：不插入用户消息，调度一位成员接话；等流式完整结束后才 resolve，
// 便于前端自动模式「一轮结束→隔一会儿→下一轮」串行驱动。
async function handleGroupContinue(
  e: Electron.IpcMainInvokeEvent | null,
  p: { chatId: string; forceRoleId?: string; visibleToGroup?: boolean; toMemory?: boolean }
): Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }> {
  // 若该聊天已被另一个窗口认领为自动接话 driver,拒绝非 driver 窗口的调用,避免并发群聊生成冲突
  if (e) {
    const senderId = e.sender.id;
    const driverId = autoChatDrivers.get(p.chatId);
    if (driverId !== undefined && driverId !== senderId) {
      return { ok: false, error: '该聊天已在另一窗口运行自动接话' };
    }
  }
  const settings = dm.getSettings();
  const g = dm.getGroup(p.chatId);
  if (!g) return { ok: false, error: '群组不存在' };
  const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
  const memberRoles = ids.map((id) => dm.getRole(id)).filter(Boolean) as Role[];
  if (memberRoles.length === 0) return { ok: false, error: '群组没有可用成员' };
  try {
    validateModels(memberRoles, settings);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }

  const history = dm.getMessages('group', p.chatId);
  // 选人回复：若前端指定了下一位发言者，则优先使用（仍校验其为群成员）
  let role = await pickNextSpeaker(memberRoles, settings, history);
  if (p.forceRoleId) {
    const forced = memberRoles.find((r) => r.id === p.forceRoleId);
    if (forced) role = forced;
  }

  // 自动接话模式下限制同一角色连续发言条数（仅对群聊生效）
  const maxConsecutive = Math.max(1, Math.min(20, settings.groupMaxConsecutive ?? 1));
  if (memberRoles.length > 1 && countConsecutiveByRole(history, role.name) >= maxConsecutive) {
    const idx = memberRoles.findIndex((r) => r.id === role.id);
    role = memberRoles[(idx + 1) % memberRoles.length] || role;
  }
  const cfg = resolveRoleModel(role, settings) as ModelConfig;
  const selfRole = resolveActiveSelfRole(settings, 'group', p.chatId);
  const obs = getObserverConfig('group', p.chatId);
  const worldBook = obs.freezeMemory ? '' : resolveWorldBook('group', p.chatId, settings);
  const messages = buildGroupMessages(
    role,
    memberRoles.map((r) => r.name),
    history.slice(-24),
    role.affinity,
    selfRole,
    worldBook,
    '（继续这段群聊：以你自己的身份自然接话，可以回应他人观点、提出新话题或提问，避免重复已说过的内容。）',
    obs.freezeMemory,
    p.chatId
  );

  const streamId = `${p.chatId}:${role.id}`;
  let seq = 0;
  const emitChunk = (content: string, done: boolean, error: string, reasoning = '') => {
    seq += 1;
    sendStreamChunk(streamId, { content, reasoning, done, error, seq });
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);
  sendStreamStart(streamId, role.id, role.name);
  try {
    let full = '';
    let tokens = 0;
    let reasoning: string | undefined;
      if (cfg.provider === 'anthropic') {
        const res = await queryAI(cfg, messages, 1024);
        if (res.error) {
          // 模型回复错误：不进聊天框、不进记忆；用气泡通知用户
          notifyModelError(res.error, role.name);
          emitChunk('', true, res.error.message);
          return { ok: false, roleId: role.id, roleName: role.name, error: res.error.message };
        }
        full = res.content;
        tokens = res.promptTokens + res.completionTokens;
        reasoning = res.reasoning;
        emitChunk(full, true, '', res.reasoning || '');
      } else {
      const res = await streamAI(
        cfg,
        messages,
        1024,
        (chunk) => {
          if (chunk.content) full += chunk.content;
          emitChunk(chunk.content || '', chunk.done, '', chunk.reasoning || '');
        },
        controller
      );
      full = full || res.content;
      tokens = res.promptTokens + res.completionTokens;
      reasoning = res.reasoning;
    }
    const aiVisible = p.visibleToGroup !== false;
    const aiToMem = aiVisible && p.toMemory !== false;
    const aiMsg = dm.addMessage({
      chat_type: 'group',
      chat_id: p.chatId,
      sender_type: 'ai',
      sender_name: role.name,
      content: full,
      reasoning,
      image_path: null,
      token_used: tokens,
      timestamp: new Date().toISOString(),
      visibleToGroup: aiVisible,
      toMemory: aiToMem,
      msg_kind: aiVisible ? 'public' : 'private',
    });
    sendStreamDone(streamId, aiMsg);
    void requestMoodJudge('group', p.chatId, role.id);
    void requestRelationshipAndMoments('group', p.chatId, role.id);
    void triggerSceneImage('group', p.chatId, role.id);
    // 选人回复：本轮结束后请用户选择下一位发言者（取代自动接话循环）
    if (settings.groupSelectReply) {
      broadcast('group:needSpeaker', {
        chatId: p.chatId,
        members: memberRoles.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_path })),
      });
    }
    return { ok: true, roleId: role.id, roleName: role.name };
    } catch (e: any) {
      const info: ModelErrorInfo = e instanceof ModelApiError
        ? { status: e.status, code: e.code, message: e.message, detail: e.detail }
        : { code: 'exception', message: e?.message || String(e), detail: e?.stack };
      notifyModelError(info, role.name);
      emitChunk('', true, info.message);
      return { ok: false, roleId: role.id, roleName: role.name, error: info.message };
    } finally {
    clearTimeout(timer);
    unregisterStream(p.chatId, controller);
  }
}

// ===== 空闲主动回复 =====
// 用户在线但一段时间无操作时，角色主动发一条贴合语境与心情的消息（不写入用户发言）。
async function handleProactive(p: {
  chatType: string;
  chatId: string;
}): Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }> {
  const settings = dm.getSettings();
  // 全局主开关 + 按聊天单独开关：任一关闭则不主动发消息
  const globalOn = settings.idleEnabled !== false;
  const perChat = (settings.chatIdleEnabled || {})[`${p.chatType}:${p.chatId}`];
  const chatOn = perChat === undefined ? true : !!perChat;
  if (!globalOn || !chatOn) {
    return { ok: false, error: '主动消息已关闭' };
  }
  const memberRoles = resolveMembers(p.chatType, p.chatId, '');
  if (memberRoles.length === 0) {
    return { ok: false, error: '未找到可回复的角色，请检查角色或群组成员是否存在' };
  }
  try {
    validateModels(memberRoles, settings);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }

  const isGroup = p.chatType === 'group';
  // 群聊：由调度器（导演/轮询）挑「最该开口」的一位；单聊直接用唯一角色
  let role = memberRoles[0];
  if (isGroup) {
    const history = dm.getMessages('group', p.chatId);
    role = await pickNextSpeaker(memberRoles, settings, history);
  }

  const history = dm
    .getMessages(p.chatType, p.chatId)
    .slice(isGroup ? -24 : -16);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  // 观察者模式「记忆冻结」：对局内不读取外部世界书
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  // 主动发言指令：贴合刚才的对话氛围与「当前心情」，自然开口；不等待用户提问
  const instruction =
    '（主动发起）你注意到用户暂时没有说话。请结合刚才的对话氛围与你当前的【情绪】，' +
    '主动向用户发一条自然、贴合情境的消息：可以延续刚才的话题，也可以自然地开启一个新话题。' +
    '直接说话，不要加任何前缀、括号说明或「用户不在」之类的元描述。';

  const isPrivate = !isGroup && p.chatId.startsWith('obs:');
  const messages = isGroup
    ? buildGroupMessages(
        role,
        memberRoles.map((r) => r.name),
        history,
        role.affinity,
        selfRole,
        worldBook,
        instruction,
        obs?.freezeMemory,
        p.chatId
      )
      : buildMessagesForRole(
          role,
          '',
          null,
          history,
          role.affinity,
          selfRole,
          worldBook,
          instruction,
          obs?.freezeMemory,
          isPrivate,
          undefined,
          false,
          p.chatId
      );

  const cfg = resolveRoleModel(role, settings) as ModelConfig;
  const streamId = `${p.chatId}:${role.id}`;
  sendStreamStart(streamId, role.id, role.name);
  const controller = new AbortController();
  registerStream(p.chatId, controller);
  try {
    const res = await queryAI(cfg, messages, 1024);
    if (res.error) {
      // 模型回复错误：不进聊天框、不进记忆；用气泡通知用户（主动消息无需重发面板，仅移除占位）
      notifyModelError(res.error, role.name);
      sendStreamChunk(streamId, { content: '', done: true, error: res.error.message, seq: 1 });
      return { ok: false, roleId: role.id, roleName: role.name, error: res.error.message };
    }
    if (controller.signal.aborted) return { ok: false, roleId: role.id, roleName: role.name };
    const aiMsg = dm.addMessage({
      chat_type: p.chatType as any,
      chat_id: p.chatId,
      sender_type: 'ai',
      sender_name: role.name,
      content: res.content,
      reasoning: res.reasoning,
      image_path: null,
      token_used: res.promptTokens + res.completionTokens,
      timestamp: new Date().toISOString(),
      from_proactive: true,
    } as any);
    sendStreamDone(streamId, aiMsg);
    void requestMoodJudge(p.chatType, p.chatId, role.id);
    void requestRelationshipAndMoments(p.chatType, p.chatId, role.id);
    void triggerSceneImage(p.chatType, p.chatId, role.id);
    return { ok: true, roleId: role.id, roleName: role.name };
  } catch (e: any) {
    const errMsg = dm.addMessage({
      chat_type: p.chatType as any,
      chat_id: p.chatId,
      sender_type: 'ai',
      sender_name: role.name,
      content: `⚠️ ${e?.message || String(e)}`,
      image_path: null,
      token_used: 0,
      timestamp: new Date().toISOString(),
    });
    sendStreamDone(streamId, errMsg);
    return { ok: false, roleId: role.id, roleName: role.name, error: e?.message || String(e) };
  } finally {
    unregisterStream(p.chatId, controller);
  }
}

// ===== 随机事件 =====
// 从模型返回里健壮地抽出第一个 JSON 对象（兼容 ```json 围栏与前后废话）
function parseFirstJson(text: string): any | null {
  if (!text) return null;
  let s = text.trim();
  // 去 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 随机事件的主题偏好（快捷调出）：送礼 / 约会 / 日常 / 惊喜 / 争执
const EVENT_THEMES: Record<string, string> = {
  gift: '可以围绕「送礼 / 收到礼物 / 准备惊喜小礼物」展开，让礼物成为情感的载体。',
  date: '可以围绕「约会 / 外出 / 两人独处的浪漫时刻」展开，制造甜蜜氛围。',
  daily: '可以是生活化、轻松有趣的日常小插曲，像普通日子里的一点小波澜。',
  surprise: '可以是一个出人意料、令人心动的小转折，带来新鲜感。',
  quarrel: '可以是一场小小的争执、拌嘴或误会，让情绪有起伏与张力。',
};

async function handleRandomEvent(p: {
  chatType: string;
  chatId: string;
  theme?: string;
  window?: string;
}): Promise<
  | { busy: true; window?: string }
  | {
      roleId: string;
      roleName: string;
      event: string;
      options: { text: string; affinity: number; mood: string }[];
    }
> {
  const settings = dm.getSettings();
  const members = resolveMembers(p.chatType, p.chatId, '');
  if (members.length === 0) {
    throw new Error('未找到可生成事件的角色，请检查角色/群组成员是否存在');
  }
  // 同一聊天同时只存在一个随机事件（防止主窗/小窗重复弹出 / 重复点击）
  if (activeEvents.has(p.chatId)) {
    return { busy: true, window: activeEvents.get(p.chatId)?.window || '' };
  }
  activeEvents.set(p.chatId, { window: p.window || '' });
  const releaseTimer = setTimeout(() => activeEvents.delete(p.chatId), 5 * 60 * 1000); // 安全兜底：5 分钟自动释放
  try {
    // 单聊用该角色；群聊随机挑一位成员，让事件视角更多样
    const role = p.chatType === 'group' ? members[Math.floor(Math.random() * members.length)] : members[0];
  // 随机事件一律用默认 AI 生成（不计入聊天 token 消耗）
  const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
  if (!cfg) {
    throw new Error('未配置可用的默认模型，无法生成随机事件（请在设置中选定默认模型）');
  }
  const history = dm.getMessages(p.chatType, p.chatId).slice(-(settings.eventHistory ?? 12)); // 事件生成参考的最近对话条数
  const recent = history
    .map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 160)}`)
    .join('\n');
  const themeHint = p.theme && EVENT_THEMES[p.theme] ? EVENT_THEMES[p.theme] : '';
  // 依据好感度与当前心情，让事件偏向「冲突」或「甜蜜」（阈值可由设置调整：eventNegAffinity / eventPosAffinity）
  let bias = '';
  const lowMood = NEG_MOODS.includes(role.mood || '');
  const highMood = POS_MOODS.includes(role.mood || '');
  if (role.affinity < (settings.eventNegAffinity ?? 30) || lowMood) { // 低好感/负面心情 → 事件偏冲突
    bias =
      '当前角色对用户的亲近度偏低或心情不佳，事件可以偏向制造一点小摩擦、拌嘴、试探或情绪低落的小插曲，让角色可能说出带刺、冷淡或委屈的话；选项里应包含能缓和矛盾与加深矛盾的不同走向。';
  } else if (role.affinity > (settings.eventPosAffinity ?? 70) || highMood) { // 高好感/正面心情 → 事件偏甜蜜
    bias =
      '当前角色对用户的亲近度很高或心情很好，事件可以偏向甜蜜、撒娇、心动或浪漫的小插曲；选项里应包含能进一步升温与稍拉开距离的不同走向。';
  } else {
    bias = '事件自然、平衡即可，不刻意偏向甜蜜或冲突。';
  }
  const prompt = [
    `你是角色「${role.name}」。`,
    role.personality ? `性格：${role.personality}。` : '',
    role.background ? `背景：${role.background.slice(0, 200)}。` : '',
    `当前好感度：${role.affinity}/100（数值越高越亲近）。`,
    role.mood ? `当前心情：${role.mood}。` : '',
    `当前对话片段：\n${recent || '（对话刚开始）'}`,
    `请在你们的世界观里，即兴生成一个自然发生、能推动聊天发展的「随机事件 / 小插曲」。${themeHint}`,
    bias,
    `只输出一个 JSON 对象，不要任何额外解释，格式严格如下：`,
    `{ "event": "对事件的一两句生动描述（可包含你的语气）", "options": [ { "text": "用户的某个选择（第一人称或动作）", "affinity": 3, "mood": "撒娇" }, { "text": "另一个选择", "affinity": 0, "mood": "平静" }, { "text": "再一个选择", "affinity": -2, "mood": "生气" } ] }`,
    `options 必须恰好 3 个。affinity 为该选择带来的好感度变化（正数增加、负数减少，范围约 -5 到 +5，需符合选择的性质）。mood 为该选择后角色会进入的心情，只能从以下枚举选一个：${MOODS.join(' / ')}。`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await queryAI(
    cfg,
    [
      { role: 'system', content: '你是一个擅长即兴叙事与角色扮演的助手，严格按用户要求的 JSON 格式输出，不要输出 JSON 以外的任何内容。' },
      { role: 'user', content: prompt },
    ],
    settings.eventMaxTokens ?? 700
  );
  if (res.content.startsWith('（')) {
    throw new Error(res.content);
  }
  const parsed = parseFirstJson(res.content);
  if (!parsed || typeof parsed.event !== 'string' || !Array.isArray(parsed.options) || parsed.options.length === 0) {
    throw new Error('事件生成结果解析失败，请重试');
  }
  const validMoods: string[] = [...MOODS];
  const options = parsed.options
    .filter((o: any) => o && typeof o.text === 'string')
    .map((o: any) => ({
      text: o.text,
      affinity: Number(o.affinity) || 0,
      mood: validMoods.includes(o.mood) ? o.mood : '平静',
    }))
    .slice(0, 3);
    if (options.length < 2) throw new Error('事件选项不足，请重试');
    return { roleId: role.id, roleName: role.name, event: String(parsed.event), options };
  } catch (e) {
    activeEvents.delete(p.chatId);
    clearTimeout(releaseTimer);
    throw e;
  } finally {
    clearTimeout(releaseTimer);
  }
}

async function handleChooseEvent(p: {
  chatType: string;
  chatId: string;
  roleId: string;
  change: number;
  choiceText: string;
  eventText: string;
  mood?: string;
}): Promise<{ roleId: string; roleName: string; total: number; change: number; mood: string }> {
  const role = dm.getRole(p.roleId);
  if (!role) throw new Error('角色不存在');
  // 情绪系统影响好感度：选项自带 affinity 变化
  const total = dm.updateAffinity(p.roleId, p.change, `随机事件：${p.eventText} → ${p.choiceText}`);
  let mood = role.mood || '平静';
  // 事件影响心情程度（0 = 事件只改好感度；>0 = 按所选心情改变角色心情，概率 = eventMoodImpact）
  const impact = dm.getSettings().eventMoodImpact ?? 1;
  if (p.mood && impact > 0 && Math.random() < impact) {
    // 事件选定的心情也走平滑过渡，避免点一下就忽喜忽悲
    const res = applyMoodChange(role, p.mood, dm.getSettings(), { chatType: p.chatType, chatId: p.chatId });
    if (res) mood = res.label;
  }
  logEmotionIfObserver(p.chatType, p.chatId, p.roleId); // 记录对局情绪轨迹（事件也会改变好感/心情）
  activeEvents.delete(p.chatId); // 选完即关闭该聊天的事件占用
  // 在聊天中插入系统消息通知好感/情绪变化
  const moodNote = p.mood ? ` · 心情 → ${mood}` : '';
  const affinityNote = p.change !== 0 ? `好感 ${p.change > 0 ? '+' : ''}${p.change}` : '';
  let sysMsg: any = null;
  if (affinityNote || moodNote) {
    sysMsg = {
      chat_type: p.chatType as any,
      chat_id: p.chatId,
      sender_type: 'system',
      sender_name: 'system',
      content: `${role.name} ${affinityNote}${moodNote}（当前好感：${total}）`,
      token_used: 0,
      id: Date.now() + Math.floor(Math.random() * 1000),
      timestamp: new Date().toISOString(),
      image_path: null,
    };
    dm.addMessage(sysMsg as any);
  }
  // 广播选择结果到所有窗口（让另一窗口关闭事件弹窗、显示系统消息）
  broadcast('event:chosen', {
    chatType: p.chatType,
    chatId: p.chatId,
    roleId: p.roleId,
    roleName: role.name,
    total,
    change: p.change,
    mood,
    message: sysMsg,
  });
  return { roleId: role.id, roleName: role.name, total, change: p.change, mood };
}

// ===================== 观察者模式（对局） =====================
// 两套隔离信息流：公屏频道（普通群聊） + 观察者专属私密小窗（id 形如 obs:<groupId>:<roleId>）。
// 私密小窗对话不进公屏、不串流给其他参与者；其记忆写入与情绪影响由独立开关控制。

interface ObserverConfig {
  observerMode: boolean;
  freezeMemory: boolean; // 全局记忆冻结：对局内禁止读取外部历史记忆（含世界书）
  publicWriteMemory: boolean; // 公屏记忆写入：对局公屏对话是否触发 AI 自动记忆；默认 true
  observerNoEmotion: boolean; // 关闭观察者发言的情绪演算（纯旁观）
  privateWriteMemory: boolean; // 私密小窗对话是否写入 AI 长期记忆
  privateAffectsEmotion: boolean; // 私密小窗对话是否影响 AI 情绪/好感
}

// 从私密小窗 chatId 回溯所属对局（群）id
function parseObsGroupId(chatId: string): string | null {
  if (chatId.startsWith('obs:')) {
    const parts = chatId.split(':');
    if (parts.length >= 3) return parts[1]; // obs:<groupId>:<roleId>
  }
  return null;
}




// 取某聊天关联的观察者配置（私密小窗需回溯到所属群）
function getObserverConfig(chatType: string, chatId: string): ObserverConfig {
  const groupId = chatType === 'group' ? chatId : parseObsGroupId(chatId);
  const g = groupId ? dm.getGroup(groupId) : null;
  return {
    observerMode: !!g?.observerMode,
    freezeMemory: !!g?.freezeMemory,
    // 公屏记忆默认允许写入（publicWriteMemory 缺省视为 true）
    publicWriteMemory: g?.publicWriteMemory !== false,
    // 默认纯旁观（observerNoEmotion 缺省视为 true）
    observerNoEmotion: g?.observerNoEmotion !== false,
    privateWriteMemory: !!g?.privateWriteMemory,
    privateAffectsEmotion: !!g?.privateAffectsEmotion,
  };
}

// 对局情绪轨迹日志（仅在对局进行中记录）
const matchEmotionLogs = new Map<
  string,
  { t: string; roleId: string; roleName: string; mood: string; affinity: number }[]
>();

function initialEmotionSnapshot(groupId: string): { t: string; roleId: string; roleName: string; mood: string; affinity: number }[] {
  const g = dm.getGroup(groupId);
  if (!g) return [];
  const now = new Date().toISOString();
  return g.member_ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => dm.getRole(id))
    .filter(Boolean)
    .map((r) => ({ t: now, roleId: r!.id, roleName: r!.name, mood: r!.mood || '平静', affinity: r!.affinity }));
}

// 在情绪/好感发生变化时，若所属群处于对局中则记录轨迹
function logEmotionIfObserver(chatType: string, chatId: string, roleId: string): void {
  const groupId = chatType === 'group' ? chatId : parseObsGroupId(chatId);
  if (!groupId) return;
  const g = dm.getGroup(groupId);
  if (!g || !g.observerMode) return;
  if (!matchEmotionLogs.has(groupId)) return; // 仅在对局进行中记录
  const role = dm.getRole(roleId);
  if (!role) return;
  matchEmotionLogs.get(groupId)!.push({
    t: new Date().toISOString(),
    roleId,
    roleName: role.name,
    mood: role.mood || '平静',
    affinity: role.affinity,
  });
}

// 序列化一条消息用于对局日志（标记公屏 / 私密私聊）
function serialMsg(m: ChatMessage) {
  const isPrivate = m.msg_kind === 'private' || m.chat_id.startsWith('obs:');
  return {
    type: isPrivate ? '私密私聊' : '公屏',
    msg_kind: isPrivate ? 'private' : 'public',
    id: m.id,
    sender_type: m.sender_type,
    sender_name: m.sender_name,
    content: m.content,
    reasoning: m.reasoning || '',
    timestamp: m.timestamp,
  };
}

// 结束对局时自动本地归档完整 JSON 日志
async function archiveMatch(groupId: string): Promise<string | null> {
  const g = dm.getGroup(groupId);
  if (!g) return null;
  const members = g.member_ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => dm.getRole(id))
    .filter(Boolean) as Role[];
  const emotion = matchEmotionLogs.get(groupId) || initialEmotionSnapshot(groupId);
  const archive = {
    matchId: `match_${groupId}_${Date.now()}`,
    groupId,
    groupName: g.group_name,
    startedAt: emotion[0]?.t || null,
    endedAt: new Date().toISOString(),
    config: {
      freezeMemory: !!g.freezeMemory,
      observerNoEmotion: g.observerNoEmotion !== false,
      privateWriteMemory: !!g.privateWriteMemory,
      privateAffectsEmotion: !!g.privateAffectsEmotion,
    },
    publicLog: dm.getMessages('group', groupId).map(serialMsg),
    privateLog: members
      .map((r) => ({
        roleId: r.id,
        roleName: r.name,
        messages: dm.getMessages('single', `obs:${groupId}:${r.id}`).map(serialMsg),
      }))
      .filter((c) => c.messages.length > 0),
    emotionTrajectory: emotion,
    members: members.map((r) => ({
      roleId: r.id,
      roleName: r.name,
      finalMood: r.mood || '平静',
      finalAffinity: r.affinity,
    })),
  };
  const dir = path.join(dm.dataDirectory, 'matches');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `match_${groupId}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(archive, null, 2), 'utf-8');
  return file;
}

// 开启/关闭观察者模式（对局）。关闭即结束对局并自动归档。
async function setObserverMode(p: {
  groupId: string;
  on: boolean;
  applyPreset?: boolean;
}): Promise<{ ok: boolean; archivePath?: string }> {
  const g = dm.getGroup(p.groupId);
  if (!g) return { ok: false };
  if (p.on) {
    const patch: Partial<Group> = { observerMode: true };
    // 首次开启或显式套用预设：写入推荐默认值（纯旁观、不写记忆、不影响情绪、不冻结记忆）
    if (g.observerMode !== true || p.applyPreset) {
      patch.freezeMemory = false;
      patch.observerNoEmotion = true;
      patch.privateWriteMemory = false;
      patch.privateAffectsEmotion = false;
    }
    dm.createGroup({ ...g, ...patch });
    matchEmotionLogs.set(p.groupId, initialEmotionSnapshot(p.groupId));
    broadcast('group:observer', { groupId: p.groupId, observerMode: true });
    return { ok: true };
  }
  // 关闭 = 结束对局，自动归档
  const archivePath = await archiveMatch(p.groupId);
  matchEmotionLogs.delete(p.groupId);
  dm.createGroup({ ...g, observerMode: false });
  broadcast('group:observer', { groupId: p.groupId, observerMode: false });
  return { ok: true, archivePath: archivePath || undefined };
}

// 仅更新观察者配置（不开关对局）：记忆冻结 / 纯旁观 / 私密写记忆 / 私密影响情绪
async function setObserverConfig(p: {
  groupId: string;
  patch: Partial<ObserverConfig>;
}): Promise<{ ok: boolean }> {
  const g = dm.getGroup(p.groupId);
  if (!g) return { ok: false };
  dm.createGroup({ ...g, ...p.patch });
  broadcast('group:observer', { groupId: p.groupId, observerMode: !!g.observerMode, config: p.patch });
  return { ok: true };
}

// ===================== 世界书 / 规则 / 记忆 / 插件 =====================

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// 从多种 lorebook 形态中抽取条目数组（SillyTavern / NovelAI / 通用）
function extractLoreEntries(raw: any): any[] {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.entries)) return raw.entries;
  if (raw.entries && typeof raw.entries === 'object') return Object.values(raw.entries);
  if (raw.lorebook && raw.lorebook.entries) {
    const e = raw.lorebook.entries;
    return Array.isArray(e) ? e : Object.values(e);
  }
  return [];
}

// 解析世界书（兼容 SillyTavern/NAI lorebook、通用 JSON、纯文本/Markdown）
function parseWorldBook(content: string, name: string): WorldBook {
  const now = new Date().toISOString();
  const base: WorldBook = {
    id: '',
    name: name || '导入的世界书',
    description: '',
    content: '',
    entries: [],
    created_at: now,
    updated_at: now,
  };
  const text = (content || '').trim();
  if (!text) return base;
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === 'object') {
      const entries = extractLoreEntries(raw);
      if (entries.length > 0 || raw.lorebook || raw.worldbook || raw.world_book) {
        base.entries = entries.map((e: any) => ({
          id: uid('wbe'),
          key: Array.isArray(e.keys) ? e.keys.join(', ') : (e.key || ''),
          content: e.content || e.entry || '',
          constant: !!e.constant,
        }));
        if (raw.name) base.name = raw.name;
        if (raw.description) base.description = raw.description;
        else if (raw.lorebook?.name) base.description = raw.lorebook.name;
        return base;
      }
      if (raw.content || raw.text || raw.scenario || raw.world) {
        base.content = raw.content || raw.text || raw.scenario || raw.world || '';
        if (raw.name) base.name = raw.name;
        if (raw.description) base.description = raw.description;
        return base;
      }
    }
  } catch {
    // 非 JSON，按纯文本处理
  }
  base.content = text;
  return base;
}

function parseRule(content: string, name: string): Rule {
  const now = new Date().toISOString();
  let n = name || '导入的规则';
  let c = (content || '').trim();
  try {
    const raw = JSON.parse(c);
    if (raw && typeof raw === 'object') {
      if (raw.content || raw.text) c = raw.content || raw.text;
      if (raw.name) n = raw.name;
    }
  } catch {
    // 纯文本即提示词内容
  }
  return {
    id: '',
    name: n,
    content: c,
    scope: 'character',
    source: 'plugin',
    created_at: now,
    updated_at: now,
  };
}

function buildRoleFromParsed(p: any, nameHint?: string): Role {
  const now = new Date().toISOString();
  return {
    id: uid('role'),
    name: p.name || nameHint || '未命名角色',
    avatar_path: '',
    gender: p.gender || '',
    age: p.age,
    occupation: p.occupation || '',
    short_intro: p.short_intro || '',
    personality: p.personality || '',
    background: p.background || '',
    appearance: p.appearance || '',
    world_setting: p.world_setting || '',
    key_memories: p.key_memories || '',
    rules: p.rules || '',
    example_dialogue: p.example_dialogue || '',
    first_message: p.first_message || '',
    affinity: 50,
    affinity_factor: 1,
    model_config_id: '',
    worldBookId: '',
    ruleIds: [],
    created_at: now,
    updated_at: now,
  };
}

function normalizePluginTool(t: any): PluginTool {
  return {
    name: String(t?.name || 'tool'),
    description: String(t?.description || ''),
    method: t?.method === 'POST' ? 'POST' : 'GET',
    url: String(t?.url || ''),
    headers: t?.headers && typeof t.headers === 'object' ? t.headers : undefined,
    bodyTemplate: t?.bodyTemplate ? String(t.bodyTemplate) : undefined,
    paramName: t?.paramName ? String(t.paramName) : undefined,
  };
}

// 取所有「已启用且带提示词片段」的插件上下文，作为系统提示注入 AI 回复
function getEnabledPluginContext(): string {
  const plugins = dm
    .listPlugins()
    .filter((p) => p.enabled && p.promptSegments && p.promptSegments.length);
  if (!plugins.length) return '';
  return plugins.map((p) => `【插件「${p.name}」】\n${p.promptSegments!.join('\n')}`).join('\n\n');
}

// 插件导入：自动识别为外部插件清单 / 世界书 / 角色预设包 / 提示词规则包
// 统一落为声明式 Plugin 记录（兼容 SillyTavern / NovelAI / OpenAI ai-plugin.json / 念语原生清单）。
// 安全约束：默认不执行任何 JS；只有 settings.pluginAllowJs 为真且插件带 jsEntry 时才在受限上下文加载。
async function importPluginLogic(
  content: string,
  name: string
): Promise<{ kind: 'worldbook' | 'rule' | 'role' | 'plugin'; id: string; name: string }> {
  const text = (content || '').trim();
  let raw: any = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }

  // 念语原生插件清单：直接采用声明的 Plugin 结构
  if (raw && typeof raw === 'object' && (raw.tools || raw.promptSegments || raw.source === 'tool' || raw.jsEntry)) {
    const plugin: Plugin = {
      id: uid('plugin'),
      name: String(raw.name || name || '导入的插件'),
      description: String(raw.description || ''),
      version: raw.version ? String(raw.version) : undefined,
      author: raw.author ? String(raw.author) : undefined,
      source: 'tool',
      tools: Array.isArray(raw.tools) ? raw.tools.map(normalizePluginTool) : [],
      promptSegments: Array.isArray(raw.promptSegments) ? raw.promptSegments.map(String) : [],
      jsEntry: raw.jsEntry ? String(raw.jsEntry) : undefined,
      enabled: true,
      created_at: new Date().toISOString(),
    };
    dm.savePlugin(plugin);
    return { kind: 'plugin', id: plugin.id, name: plugin.name };
  }

  // OpenAI 插件清单 ai-plugin.json
  if (raw && typeof raw === 'object' && raw.name_for_model && (raw.description_for_model || raw.api?.url)) {
    const plugin: Plugin = {
      id: uid('plugin'),
      name: String(raw.name_for_human || raw.name_for_model || name || 'OpenAI 插件'),
      description: String(raw.description_for_human || ''),
      version: typeof raw.version === 'string' ? raw.version : undefined,
      author: undefined,
      source: 'tool',
      tools: raw.api?.url
        ? [
            {
              name: String(raw.name_for_model),
              description: String(raw.description_for_model || ''),
              method: 'GET',
              url: String(raw.api.url),
              paramName: 'q',
            },
          ]
        : [],
      promptSegments: raw.description_for_model ? [String(raw.description_for_model)] : [],
      jsEntry: undefined,
      enabled: true,
      created_at: new Date().toISOString(),
    };
    dm.savePlugin(plugin);
    return { kind: 'plugin', id: plugin.id, name: plugin.name };
  }

  // 其余走原有世界书/角色/规则识别
  if (raw && typeof raw === 'object') {
    const ent = extractLoreEntries(raw);
    if (ent.length > 0 || raw.lorebook || raw.worldbook || raw.world_book) {
      const wb = parseWorldBook(content, name || '导入的世界书');
      wb.id = uid('wb');
      dm.saveWorldBook(wb);
      const plugin: Plugin = {
        id: uid('plugin'),
        name: wb.name,
        description: '导入的世界书',
        source: 'worldbook',
        worldBookId: wb.id,
        enabled: true,
        created_at: new Date().toISOString(),
      };
      dm.savePlugin(plugin);
      return { kind: 'worldbook', id: wb.id, name: wb.name };
    }
    const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const isRole =
      d.name || d.char_name || d.character_name || d.title || d.description || d.char_persona || d.personality || d.first_mes;
    if (isRole) {
      const parsed = parseCharacterCard(raw);
      const role = buildRoleFromParsed(parsed, name);
      dm.createRole(role);
      const plugin: Plugin = {
        id: uid('plugin'),
        name: role.name,
        description: '导入的角色卡',
        source: 'role',
        roleId: role.id,
        enabled: true,
        created_at: new Date().toISOString(),
      };
      dm.savePlugin(plugin);
      return { kind: 'role', id: role.id, name: role.name };
    }
  }
  const rule = parseRule(content, name || '导入的规则');
  rule.id = uid('rule');
  dm.saveRule(rule);
  const plugin: Plugin = {
    id: uid('plugin'),
    name: rule.name,
    description: '导入的提示词规则',
    source: 'rule',
    ruleId: rule.id,
    enabled: true,
    created_at: new Date().toISOString(),
  };
  dm.savePlugin(plugin);
  return { kind: 'rule', id: rule.id, name: rule.name };
}

// AI 自动提炼记忆：取最近对话，让模型总结 durable 事实，去重后写入记忆
async function extractMemories(chatType: string, chatId: string): Promise<number> {
  const settings = dm.getSettings();
  if (!settings.enableAutoMemory) return 0;
  // 观察者私密小窗：受「写入长期记忆」开关控制（默认不写入）
  if (chatId.startsWith('obs:')) {
    const obs = getObserverConfig(chatType, chatId);
    if (!obs.privateWriteMemory) return 0;
  }
  // 观察者模式公屏：受「公屏记忆写入」开关控制（默认开启），关闭则不提炼记忆
  if (chatType === 'group') {
    const obs = getObserverConfig('group', chatId);
    if (obs.observerMode && !obs.publicWriteMemory) return 0;
  }
  // 主动消息的最近消息：受「主动消息写入记忆」开关控制（默认不写入）
  const hist0 = dm.getMessages(chatType, chatId);
  if (hist0.length > 0 && hist0[hist0.length - 1].from_proactive && !settings.idleWriteMemory) {
    return 0;
  }
  const history = hist0;
  if (history.length < 2) return 0;
  let roleId: string | undefined;
  if (chatType === 'single') {
    roleId = dm.resolveSingleRoleId(chatType, chatId);
  } else {
    const lastAi = [...history].reverse().find((m) => m.sender_type === 'ai');
    roleId = lastAi ? dm.getRoleByName(lastAi.sender_name)?.id : undefined;
  }
  if (!roleId) return 0;
  const role = dm.getRole(roleId);
  const iso = role?.memoryIsolation ?? true;
  // 记忆隔离：仅与该聊天/角色级共享记忆去重，避免不同聊天的记忆互相抑制
  const existing = dm.listMemories(roleId, iso ? chatId : undefined).map((m) => m.content.trim());
  // 图片消息（生图结果/用户发图）不送入自动记忆提炼：AI 不会自动总结或保存图片记忆，仅可手动保存
  // 群聊中标记为「不进入记忆」的消息也跳过（前提是消息全群可见）
  const convo = history
    .slice(-14)
    .filter((m) => !(m.images && m.images.length) && !m.image_path)
    .filter((m) => m.toMemory !== false)
    .map((m) => `${m.sender_name}: ${m.content || ''}`)
    .join('\n');
  const cfg =
    settings.models.find((m) => m.id === settings.defaultModel && m.enabled) ||
    settings.models.find((m) => m.enabled);
  if (!cfg) return 0;
  const prompt = `你是记忆提炼助手。从下面的对话中，提取关于用户或角色关系「值得长期记住」的事实（如用户偏好、禁忌、约定、重要事件、角色对用户的看法等）。\n已存在的记忆：\n${existing.length ? existing.join('\n') : '（无）'}\n\n最近对话：\n${convo}\n\n请只输出新增的、不与已有记忆重复、且确实值得长期记住的要点。每条一行，不要编号，不要解释。如果没有新要点，只输出一个空行。`;
  try {
    const res = await queryAI(cfg, [{ role: 'system', content: prompt }], 600);
    const lines = (res.content || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((l) => !existing.includes(l))
      .slice(0, 6);
    let n = 0;
    const lastMsgId = history.length > 0 ? history[history.length - 1].id : undefined;
    // 关联「触发本轮对话的用户消息」+「AI 回复」，任一被撤回/删除时都会联动清理该记忆
    const lastUserMsg = [...history].reverse().find((m) => m.sender_type === 'user');
    const userMsgId = lastUserMsg ? lastUserMsg.id : undefined;
    const sourceMsgIds = [lastMsgId, userMsgId].filter((x): x is number => x !== undefined);
    for (const l of lines) {
      dm.addMemory({ roleId, chatId: iso ? chatId : undefined, content: l, source: 'auto', sourceMsgIds } as any);
      n += 1;
    }
    return n;
  } catch (e) {
    console.error('记忆提炼失败', e);
    return 0;
  }
}

// 安全发送：窗口不存在或已销毁时静默跳过，杜绝 "Object has been destroyed"
function safeSend(
  win: BrowserWindow | null | undefined,
  channel: string,
  payload?: unknown
): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch (e) {
    // 极端竞态下仍可能抛错，静默吞掉避免触发 uncaughtException 弹窗
    console.warn('[nianyu] safeSend skip:', channel, (e as Error)?.message);
  }
}

// 广播到所有窗口（主窗 + 快捷小窗）
function broadcast(channel: string, payload: unknown): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch (e) {
    console.warn('[nianyu] broadcast skip:', channel, (e as Error)?.message);
  }
}

// 模型回复错误：记录到错误日志 + 自动诊断原因/解决方案 + 广播给前端非模态气泡。
// 错误信息不进入聊天框、不写入记忆；用软件当前设置的语言告诉用户「发生了什么、该怎么办」。
function notifyModelError(err: ModelErrorInfo, roleName?: string): void {
  dm.logError('model', `[${err.code}] ${err.message}`, err.detail);
  const diag = diagnoseError(err.message || err.code);
  const settings = dm.getSettings();
  const lang: 'zh' | 'en' = settings.lang === 'en' ? 'en' : 'zh';
  broadcast('app:modelError', {
    code: err.code,
    message: err.message,
    detail: err.detail,
    cause: diag.cause[lang],
    solution: diag.solution[lang],
    lang,
    roleName,
  });
}

// ===== 生视频后台任务 =====
// 非阻塞执行：校验配置 → 调用 generateVideo（内部含任务式轮询）→ 下载到本地 → 写 AI 视频消息。
// 全程广播 video:progress（0~100 进度）与 video:done（成功携带 imagePath / 失败携带 error）。
async function runVideoGenJob(chatType: string, chatId: string, prompt: string, refDataUrl?: string): Promise<void> {
  try {
    const vg = dm.getSettings().videoGen;
    if (!vg || !vg.enabled || !vg.baseUrl || !vg.apiKey) {
      throw new Error('未配置生视频 API，请在设置中开启「生视频」并填写独立的 Base URL 与 API Key');
    }
    broadcast('video:progress', { chatType, chatId, prompt, percent: 0, status: 'queued' });
    const { url } = await generateVideo(
      { baseUrl: vg.baseUrl, apiKey: vg.apiKey },
      prompt,
      vg.model || '',
      vg.size || '1280x720',
      vg.duration || '5',
      refDataUrl ? [refDataUrl] : undefined,
      (percent, status) =>
        broadcast('video:progress', { chatType, chatId, prompt, percent, status: status || 'generating' })
    );
    let videoPath: string | null = null;
    if (url) {
      try {
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const name = `gen_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mp4`;
        const dest = path.join(dm.imagesDir, name);
        fs.writeFileSync(dest, buf);
        videoPath = dest;
      } catch (e) {
        console.error('下载生视频失败', e);
      }
    }
    if (!videoPath) throw new Error('生视频失败：未获取到视频数据');
    const aiName =
      chatType === 'single'
        ? dm.getRole(dm.resolveSingleRoleId(chatType, chatId))?.name || 'AI'
        : dm.getGroup(chatId)?.group_name || 'AI';
    const aiMsg = dm.addMessage({
      chat_type: chatType as any,
      chat_id: chatId,
      sender_type: 'ai',
      sender_name: aiName,
      content: '',
      image_path: videoPath,
      token_used: 0,
      timestamp: new Date().toISOString(),
      genPrompt: prompt,
    });
    broadcast('stream:user', aiMsg);
    broadcast('video:done', { chatType, chatId, prompt, ok: true, imagePath: videoPath });
    pushMediaUnread(chatType, chatId, aiName, 'video'); // 主窗不可见/未盯该聊天则补未读
  } catch (e: any) {
    console.error('[nianyu] 生视频失败', e?.message || e);
    broadcast('video:done', { chatType, chatId, prompt, ok: false, error: e?.message || String(e) });
  }
}

// 朋友圈视频生成后台任务：进度走全局气泡（key: moments|<roleId>|<prompt>），完成写入 moment.videos
async function runMomentVideoJob(roleId: string, momentId: number, prompt: string): Promise<void> {
  const s = dm.getSettings();
  const vg = s.videoGen;
  if (!s.momentsVideoEnabled || !vg || !vg.enabled || !vg.baseUrl || !vg.apiKey) return;
  try {
    broadcast('video:progress', { chatType: 'moments', chatId: roleId, prompt, percent: 0, status: 'queued' });
    const { url } = await generateVideo(
      { baseUrl: vg.baseUrl, apiKey: vg.apiKey },
      prompt,
      vg.model || '',
      vg.size || '1280x720',
      vg.duration || '5',
      undefined,
      (percent, status) =>
        broadcast('video:progress', { chatType: 'moments', chatId: roleId, prompt, percent, status: status || 'generating' })
    );
    let videoPath: string | null = null;
    if (url) {
      try {
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const name = `moment_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mp4`;
        const dest = path.join(dm.imagesDir, name);
        fs.writeFileSync(dest, buf);
        videoPath = dest;
      } catch (e) {
        console.error('下载朋友圈视频失败', e);
      }
    }
    if (videoPath) {
      const m = dm.listMoments(roleId, true).find((x) => x.id === momentId);
      if (m) dm.updateMoment(momentId, { videos: [...(m.videos || []), videoPath] });
      broadcast('moments:changed', { roleId });
      broadcast('video:done', { chatType: 'moments', chatId: roleId, prompt, ok: true, imagePath: videoPath });
    } else {
      broadcast('video:done', { chatType: 'moments', chatId: roleId, prompt, ok: false, error: '生视频失败：未获取到视频数据' });
    }
  } catch (e: any) {
    console.error('[nianyu] 朋友圈视频失败', e?.message || e);
    broadcast('video:done', { chatType: 'moments', chatId: roleId, prompt, ok: false, error: e?.message || String(e) });
  }
}

// ===== 自动接话：单驱动器 =====
// 同一聊天同一时刻只允许一个窗口驱动 groupContinue 循环。
// 其余窗口收到 driver 广播后仅同步显示状态（按钮/轮数），不驱动循环。
const autoChatDrivers = new Map<string, number>(); // chatId -> webContents.id

// ===== 群成员编辑：单窗口锁 =====
// 同一群组同一时刻只允许一个窗口打开编辑器，其余窗口尝试时会被拒绝并提示。
const groupEditorLocks = new Map<string, number>(); // groupId -> webContents.id

function clearAutoChatDriverByWindow(windowId: number, reason: 'closed' | 'lost'): void {
  for (const [chatId, driverId] of autoChatDrivers.entries()) {
    if (driverId === windowId) {
      autoChatDrivers.delete(chatId);
      broadcast('chat:autoChat:driver', { chatId, action: 'stop', reason });
    }
  }
}

function clearGroupEditorLockByWindow(windowId: number): void {
  for (const [groupId, ownerId] of groupEditorLocks.entries()) {
    if (ownerId === windowId) {
      groupEditorLocks.delete(groupId);
      broadcast('chat:groupEditor:state', { groupId, action: 'closed', ownerId: windowId });
    }
  }
}

function sendStreamChunk(
  streamId: string,
  chunk: { content: string; done: boolean; error: string; reasoning?: string; seq?: number }
): void {
  broadcast('stream:chunk', { streamId, ...chunk });
}

function sendStreamStart(streamId: string, roleId: string, roleName: string): void {
  broadcast('stream:start', { streamId, roleId, roleName });
}

function sendStreamDone(streamId: string, message: ChatMessage): void {
  broadcast('stream:done', { streamId, message });
  // 悬浮球未读同步：主窗隐藏时，把本次 AI 回复计入未读并实时广播给悬浮球
  try {
    const idx = streamId.indexOf(':');
    const chatId = idx >= 0 ? streamId.slice(0, idx) : streamId;
    const roleId = idx >= 0 ? streamId.slice(idx + 1) : '';
    const chatType = dm.getGroup(chatId) ? 'group' : 'single';
    const role = dm.getRole(roleId) || (chatType === 'single' ? dm.getRole(chatId) : undefined);
    const avatar = role?.avatar_path || '';
    pushUnread(chatType, chatId, message.sender_name, message.content, avatar, message.from_proactive === true);
    // 后台消息提醒卡片：主窗/小窗均隐藏时由 showNotifyCard 内部判断并弹出；
    // 与渲染端 onDone 触发的 notifyCard 互补，覆盖当前未挂载聊天的场景（避免卡片消失）
    if (message.sender_type === 'ai' && message.content) {
      const name =
        chatType === 'group'
          ? ((dm.getGroup(chatId)?.group_name as string) || chatId)
          : ((role?.name as string) || chatId);
      showNotifyCard({ chatType, chatId, name, roleName: message.sender_name, content: message.content });
    }
  } catch {
    /* 未读统计/通知卡片失败时静默，不影响消息下发 */
  }
}

// ---------- IPC 注册 ----------
function registerIPC(): void {
  ipcMain.handle('roles:list', () => dm.listRoles());
  ipcMain.handle('roles:get', (_e, id) => dm.getRole(id));
  ipcMain.handle('roles:save', (_e, role) => dm.createRole(role));
  ipcMain.handle('roles:delete', (_e, id) => dm.deleteRole(id));
  ipcMain.handle('roles:aiComplete', async (_e, basic, modelId) => {
    const settings = dm.getSettings();
    const cfg =
      settings.models.find((m) => m.id === modelId && m.enabled) ||
      settings.models.find((m) => m.enabled);
    if (!cfg) return '（请先在设置-模型管理中添加并启用一个模型配置）';
    return aiCompleteRole(cfg, basic);
  });

  ipcMain.handle('chats:list', () => dm.getChatList());
  ipcMain.handle('chats:messages', (_e, type, id) => dm.getMessages(type, id));
  ipcMain.handle('chats:send', async (_e, p) => handleSend(p));
  ipcMain.handle('chats:sendUser', async (_e, p) => handleSendUser(p));
  ipcMain.handle('chats:sendAI', async (_e, p) => handleSendAI(p));
  ipcMain.handle('chats:stream', async (_e, p) => handleStream(p));
  // 请求限速（QPS）状态查询：前端据此做"X 秒后自动发送"预排队 UI
  ipcMain.handle('chats:rateInfo', async (_e, modelId: string) => {
    const settings = dm.getSettings();
    const cfg = settings.models.find((m) => m.id === modelId);
    const qps = cfg?.qps;
    const wait = rateWaitMs(modelId);
    return { enabled: !!(qps && qps > 0), limit: qps || 0, waitMs: wait };
  });
  // 取当前聊天参与限速的代表模型 id（单聊=角色模型；群聊=默认模型），供前端预排队 UI 使用
  ipcMain.handle('chats:activeModel', (_e, chatType: string, chatId: string) => {
    const settings = dm.getSettings();
    if (chatType === 'single') {
      const role = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
      if (role) return resolveRoleModel(role, settings)?.id || '';
      return '';
    }
    return settings.models.find((m) => m.id === settings.defaultModel && m.enabled)?.id || '';
  });
  // 翻译文本（右键菜单"翻译文本"）：未设翻译专用模型则用默认模型
  ipcMain.handle('chats:translate', async (_e, text: string) => {
    const settings = dm.getSettings();
    if (!settings.translationEnabled) return { ok: false, error: 'disabled' };
    try {
      const out = await translateText(String(text || ''), settings);
      return { ok: true, text: out };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // 打断生成：中止某聊天当前进行中的流式，已生成的部分内容仍会落库并 finalize
  ipcMain.handle('chats:interrupt', (_e, chatId: string): { ok: boolean } => {
    abortStreamsForChat(chatId);
    return { ok: true };
  });
  ipcMain.handle('chats:groupContinue', (e, p) => handleGroupContinue(e, p));
  ipcMain.handle('chats:proactive', async (_e, p) => handleProactive(p));
  ipcMain.handle('chats:randomEvent', async (_e, p) => handleRandomEvent(p));
  ipcMain.handle('chats:chooseEvent', async (_e, p) => handleChooseEvent(p));
  ipcMain.handle('chats:eventClosed', (_e, p: { chatId: string }) => {
    if (p && p.chatId) activeEvents.delete(p.chatId);
  });
  ipcMain.handle('chats:delete', (_e, type, id) => {
    // 中止该聊天的进行中流式生成，避免孤儿流继续写库产生幽灵会话 / 串台
    abortStreamsForChat(id);
    // 群聊删除时一并移除群组记录，避免残留
    if (type === 'group') dm.deleteGroup(id);
    else dm.deleteChat(type, id);
  });
  // 复制聊天：1:1 复制消息与卡片，新卡片名加「副本」后缀
  ipcMain.handle('chats:copy', (_e, chatType: string, chatId: string) => dm.copyChat(chatType, chatId));
  // 复制数字人：克隆角色状态 + 记忆参数；includeChats 为 true 时一并复制聊天记录与聊天隔离记忆（chatId 重映射）
  ipcMain.handle('roles:copy', (_e, id: string, includeChats: boolean) => dm.copyRole(id, !!includeChats));
  // ===== 模型对比（测试窗口，与角色记忆完全无关）=====
  // 同一问题同时发给 ≤3 个模型；返回每模型耗时/token；随后用默认模型对输出质量打分
  // 模型对比：同一问题并发发给 ≤3 个模型；每个模型完成后立即广播 compare:result，
  // 评分完成广播 compare:judged，全部结束广播 compare:done。前端据此为每个窗口独立计时、独立展示。
  ipcMain.handle('compare:start', async (_e, p: { question: string; modelIds: string[]; compareId?: string; judgeModelId?: string }) => {
    const settings = dm.getSettings();
    const ids = (Array.isArray(p?.modelIds) ? p.modelIds : []).slice(0, 3);
    const question = String(p?.question || '').trim();
    const compareId = String(p?.compareId || `cmp_${Date.now()}`);
    if (!question) throw new Error('请输入要对比的问题');
    if (!ids.length) throw new Error('请至少选择一个模型');
    const cfgMap = new Map(settings.models.filter((m) => m.enabled).map((m) => [m.id, m]));
    const startedAt = Date.now();
    const jobs = ids.map(async (id) => {
      const cfg = cfgMap.get(id);
      const base = { modelId: id, modelName: cfg?.name || id };
      if (!cfg) {
        const r = { ...base, content: '', promptTokens: 0, completionTokens: 0, elapsedMs: 0, error: '模型未启用或不存在' };
        broadcast('compare:result', { compareId, ...r });
        return r;
      }
      const t0 = Date.now();
      try {
        const res = await queryAI(
          cfg,
          [
            { role: 'system', content: '你是一个 AI 能力测试助手。请直接、完整地回答用户的问题，不要提及测试、对比、评分或任何角色设定。' },
            { role: 'user', content: question },
          ],
          2048
        );
        if (res.error) {
          const r = { ...base, content: '', promptTokens: 0, completionTokens: 0, elapsedMs: Date.now() - t0, error: res.error.message };
          broadcast('compare:result', { compareId, ...r });
          return r;
        }
        const r = {
          ...base,
          content: res.content,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          elapsedMs: Date.now() - t0,
          error: '',
        };
        broadcast('compare:result', { compareId, ...r });
        return r;
      } catch (e: any) {
        const r = { ...base, content: '', promptTokens: 0, completionTokens: 0, elapsedMs: Date.now() - t0, error: e?.message || String(e) };
        broadcast('compare:result', { compareId, ...r });
        return r;
      }
    });
    const results = await Promise.all(jobs);
    // 质量评判：评测模型可由界面临时指定（judgeModelId），否则回退默认模型。
    // 若评测模型本身是被测模型之一（互评），则不评判其自身输出，仅评判其它被测模型。
    const judgments: Record<string, { score: number; comment: string }> = {};
    let judgeError: string | undefined;
    const judgeCfg =
      (p.judgeModelId && cfgMap.get(p.judgeModelId)) ||
      settings.models.find((m) => m.id === settings.defaultModel && m.enabled);
    if (judgeCfg && results.some((r) => !r.error)) {
      const judgeIsCompared = ids.includes(judgeCfg.id);
      try {
        const list = results
          .map((r, i) => `【${i + 1}. ${r.modelName}】\n${(r.content || '(无输出)').slice(0, 1500)}`)
          .join('\n\n');
        const res = await queryAI(
          judgeCfg,
          [
            {
              role: 'system',
              content: '你是 AI 输出质量评测员。请从准确度、完整性、逻辑、可读性四方面为下面的若干 AI 回答打分（0-100 整数），并给每条不超过 30 字的中文评语。严格输出 JSON：{"scores":[{"index":1,"score":88,"comment":"评语"}]}，不要输出任何其他内容。',
            },
            { role: 'user', content: list },
          ],
          1024
        );
        if (res.error) {
          judgeError = res.error.message;
        } else {
          const parsed = parseFirstJson(res.content);
          if (parsed && Array.isArray(parsed.scores)) {
            for (const s of parsed.scores) {
              const idx = Number(s?.index) - 1;
              if (results[idx] && !results[idx].error && !(judgeIsCompared && results[idx].modelId === judgeCfg.id)) {
                judgments[results[idx].modelId] = { score: Math.max(0, Math.min(100, Number(s?.score) || 0)), comment: String(s?.comment || '') };
              }
            }
          } else {
            judgeError = '评分结果解析失败（模型未返回合法 JSON）';
          }
        }
      } catch (e: any) {
        judgeError = e?.message || String(e);
      }
      if (judgeError) dm.logError('model', `对比质量评判失败：${judgeError}`);
    }
    broadcast('compare:judged', { compareId, judgments, judgeModel: judgeCfg?.name || '', judgeError });
    broadcast('compare:done', { compareId, totalMs: Date.now() - startedAt });
    return { results, judgments, totalMs: Date.now() - startedAt, judgeModel: judgeCfg?.name || '' };
  });
  // 重命名聊天卡片：写入 chat_name 覆盖显示名，不改动角色/群本身
  ipcMain.handle('chats:rename', (_e, chatType: string, chatId: string, name: string) =>
    dm.renameChat(chatType, chatId, name)
  );
  // 解析单聊真实 roleId（普通单聊 / 观察者私密 / 复制出的解绑单聊），前端用于角色缺失判定等
  ipcMain.handle('chats:resolveRole', (_e, chatType: string, chatId: string) =>
    dm.resolveSingleRoleId(chatType, chatId)
  );
  // 自适应故事线：开关 / 查询 / 标记节点 / 列表 / 删除节点
  ipcMain.handle('chats:setStory', (_e, chatType: string, chatId: string, enabled: boolean) => {
    const v = dm.setStoryEnabled(chatType, chatId, enabled);
    broadcast('story:changed', { chatType, chatId, enabled });
    return v;
  });
  ipcMain.handle('chats:getStory', (_e, chatType: string, chatId: string) =>
    dm.getStoryEnabled(chatType, chatId)
  );
  ipcMain.handle('chats:addStoryNode', (_e, chatType: string, chatId: string, msgId: number, title: string) =>
    dm.addStoryNode(chatType, chatId, msgId, title)
  );
  ipcMain.handle('chats:listStoryNodes', (_e, chatType: string, chatId: string) =>
    dm.listStoryNodes(chatType, chatId)
  );
  ipcMain.handle('chats:removeStoryNode', (_e, id: number) => dm.removeStoryNode(id));
  // 朋友圈动态：新增 / 列表 / 删除 / 到点发布
  ipcMain.handle('moments:add', (_e, roleId: string, content: string, images: string[], scheduledAt?: string | null, selfRoleId?: string) =>
    dm.addMoment(roleId, content, images, scheduledAt, selfRoleId)
  );
  ipcMain.handle('moments:list', (_e, roleId?: string, includeUnpublished?: boolean, selfRoleId?: string, favoritedOnly?: boolean) =>
    dm.listMoments(roleId, includeUnpublished, selfRoleId, favoritedOnly)
  );
  ipcMain.handle('moments:remove', (_e, id: number) => dm.removeMoment(id));
  ipcMain.handle('moments:update', (_e, id: number, patch: Record<string, unknown>) => {
    dm.updateMoment(id, patch as any);
    broadcast('moments:changed', { id });
  });
  ipcMain.handle('moments:publishDue', () => dm.publishDueMoments());
  // 人物养成：关系值增减
  ipcMain.handle('role:adjustBond', (_e, roleId: string, delta: number) => {
    const v = dm.adjustBond(roleId, delta);
    // 广播关系值变更，主窗与小窗同步刷新展示（避免一端调了另一端没显示）
    broadcast('role:bond', { roleId });
    return v;
  });
  // 手动触发：withMoments 控制是否连带生成朋友圈。
  // 关系值界面只判定关系（withMoments=false），朋友圈板块的生成按钮才发朋友圈（withMoments=true）。
  // 手动触发：withMoments 控制是否发朋友圈，doRelationship 控制是否判定关系值（两者独立）。
  // 关系值界面只判定关系（withMoments=false，doRelationship=true）；朋友圈板块只生成（withMoments=true，doRelationship=false）。
  ipcMain.handle('relationship:trigger', async (_e, chatType: string, chatId: string, roleId: string, withMoments = true, doRelationship = true) => {
    const role = dm.getRole(roleId);
    if (!role) return { ok: false, moments: 0, error: '角色不存在' };
    try {
      // 仅「手动重新判定关系」时检查：自上次判定后聊天内容无变化则跳过 AI，提示用户继续聊天
      if (doRelationship) {
        const sig = computeChatSnapshot(chatType, chatId);
        if (role.bondSnapshot && role.bondSnapshot === sig) {
          return { ok: true, moments: 0, noNewContent: true };
        }
      }
      const r = await requestRelationshipAndMoments(chatType, chatId, roleId, { force: true, doMoments: withMoments, doRelationship });
      if (doRelationship && r.ok) {
        const sig = computeChatSnapshot(chatType, chatId);
        dm.updateRole(roleId, { bondSnapshot: sig });
      }
      return r;
    } catch (err) {
      return { ok: false, moments: 0, error: String(err) };
    }
  });
  ipcMain.handle('chats:clearMessages', (_e, chatType: string, chatId: string, withMemories: boolean) =>
    dm.clearChatMessages(chatType, chatId, withMemories)
  );
  // 窗口间同步：自动接话状态广播
  ipcMain.handle('chat:syncAutoChat', (_e, payload: { chatId: string; action: 'start' | 'stop' }) => {
    broadcast('chat:autoChatSync', payload);
  });
  // 窗口间同步：消息变更广播（清空/撤回/回滚后通知其他窗口刷新）
  ipcMain.handle('chat:syncMessages', (_e, payload: { chatType: string; chatId: string; action: 'cleared' | 'recalled' | 'rolledBack' }) => {
    broadcast('chat:messagesSync', payload);
  });
  // ===== 自动接话：单驱动器 =====
  ipcMain.handle('chat:autoChat:claim', (e, chatId: string): { isDriver: boolean; ownerId?: number } => {
    const senderId = e.sender.id;
    const existing = autoChatDrivers.get(chatId);
    if (existing === undefined) {
      autoChatDrivers.set(chatId, senderId);
      // 中止上一轮可能仍在运行的流（防止前一轮被 forceStop 后残留的流到新 driver 时异常触发 failed）
      abortStreamsForChat(chatId);
      broadcast('chat:autoChat:driver', { chatId, action: 'start', driverId: senderId });
      broadcast('chat:clearFailed', { chatId });
      return { isDriver: true, ownerId: senderId };
    }
    if (existing === senderId) return { isDriver: true, ownerId: senderId };
    return { isDriver: false, ownerId: existing };
  });
  ipcMain.handle('chat:autoChat:release', (e, chatId: string): { released: boolean } => {
    const senderId = e.sender.id;
    const owner = autoChatDrivers.get(chatId);
    if (owner === undefined) return { released: true };
    if (owner !== senderId) return { released: false };
    autoChatDrivers.delete(chatId);
    broadcast('chat:autoChat:driver', { chatId, action: 'stop', driverId: senderId });
    return { released: true };
  });
  // 任一窗口可强制停止（让另一窗口的循环也退出）
  ipcMain.handle('chat:autoChat:forceStop', (_e, chatId: string): { ok: boolean } => {
    if (!autoChatDrivers.has(chatId)) return { ok: true };
    autoChatDrivers.delete(chatId);
    // 中止正在运行的流 + 清掉各窗口的 failed 态,避免下一轮续接时遗留红框+透明气泡
    abortStreamsForChat(chatId);
    broadcast('chat:autoChat:driver', { chatId, action: 'stop', reason: 'forced' });
    broadcast('chat:clearFailed', { chatId });
    return { ok: true };
  });
  ipcMain.handle('chat:autoChat:round', (_e, chatId: string, round: number): void => {
    broadcast('chat:autoChat:driver', { chatId, action: 'round', round });
  });
  // 查询某聊天当前是否处于自动接话（被某窗口驱动）。用于窗口（尤其小窗）在驱动已存在后才打开时，
  // 挂载即同步为「运行中」显示状态，避免卡在「非自动接话」状态导致按钮/轮数不同步。
  ipcMain.handle('chat:autoChat:state', (_e, chatId: string): { active: boolean; driverId?: number } => {
    const owner = autoChatDrivers.get(chatId);
    return { active: owner !== undefined, driverId: owner };
  });
  // ===== 群成员编辑：单窗口锁 =====
  ipcMain.handle('chat:groupEditor:open', (e, groupId: string): { ok: boolean; ownerId?: number } => {
    const senderId = e.sender.id;
    const existing = groupEditorLocks.get(groupId);
    if (existing === undefined) {
      groupEditorLocks.set(groupId, senderId);
      broadcast('chat:groupEditor:state', { groupId, action: 'opened', ownerId: senderId });
      return { ok: true, ownerId: senderId };
    }
    if (existing === senderId) return { ok: true, ownerId: senderId };
    return { ok: false, ownerId: existing };
  });
  ipcMain.handle('chat:groupEditor:close', (e, groupId: string): { ok: boolean } => {
    const senderId = e.sender.id;
    const owner = groupEditorLocks.get(groupId);
    if (owner !== undefined && owner !== senderId) return { ok: false };
    groupEditorLocks.delete(groupId);
    broadcast('chat:groupEditor:state', { groupId, action: 'closed', ownerId: senderId });
    return { ok: true };
  });
  ipcMain.handle('chat:groupEditor:saved', (e, groupId: string): void => {
    const senderId = e.sender.id;
    broadcast('chat:groupEditor:state', { groupId, action: 'saved', ownerId: senderId });
  });

  ipcMain.handle('groups:list', () => dm.listGroups());
  ipcMain.handle('groups:get', (_e, id) => dm.getGroup(id));
  ipcMain.handle('groups:save', (_e, g) => dm.createGroup(g));
  ipcMain.handle('groups:delete', (_e, id) => dm.deleteGroup(id));
  ipcMain.handle('groups:convertToSingle', (_e, groupId, roleId) =>
    dm.convertGroupToSingle(groupId, roleId)
  );
  ipcMain.handle('groups:setIgnoreConvert', (_e, groupId, value) =>
    dm.setGroupIgnoreConvert(groupId, value)
  );

  // ---------- 观察者模式（对局） ----------
  ipcMain.handle('observer:setMode', (_e, p) => setObserverMode(p));
  ipcMain.handle('observer:setConfig', (_e, p) => setObserverConfig(p));

  // ---------- 消息回滚 / 撤回 ----------
  ipcMain.handle('messages:recall', (_e, msgId: number) => dm.deleteMessage(msgId));
  ipcMain.handle('messages:rollback', (_e, chatType: string, chatId: string, fromMsgId: number) =>
    dm.rollbackMessages(chatType, chatId, fromMsgId)
  );
  // ---------- 记忆快捷添加（选中文本一键记忆） ----------
  ipcMain.handle('memories:addQuick', (_e, p: { roleId: string; content: string }) =>
    dm.addMemory({ roleId: p.roleId, content: p.content, source: 'manual' })
  );

  ipcMain.handle('stats:tokens', () => {
    const rows = dm
      .getChatList()
      .map((c) => dm.getMessages(c.chat_type, c.chat_id))
      .flat();
    return rows.reduce((s, m) => s + (m.token_used || 0), 0);
  });
  ipcMain.handle('stats:roles', () => dm.getRoleStats());

  ipcMain.handle('affinity:log', (_e, roleId) => dm.getAffinityLog(roleId));

  ipcMain.handle('settings:get', () => dm.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => {
    const next = dm.saveSettings(patch);
    // 快捷键 / 置顶等小窗设置即时生效
    if (patch && (patch.miniWindow || patch.lang)) {
      applyMiniSettings();
      if (patch.lang) buildTrayMenu(next.lang === 'en' ? 'en' : 'zh');
    }
    // 深度思考等级同步给 AI 调用层（全局，避免改动所有调用点）
    if (patch && patch.deepThinkLevel !== undefined) setDeepThinkLevel(next.deepThinkLevel);
    // 广播设置变更，让主窗与小窗同步刷新（世界书/身份/背景/开关等）
    broadcast('settings:changed', patch || {});
    // 缩放基准/上下限变更时，主窗与小窗立即按新参数重新缩放（两端同步显示）
    if (patch && patch.uiZoom) {
      applyWindowZoom(mainWindow, false);
      applyWindowZoom(miniWindow, true);
    }
    return next;
  });
  ipcMain.handle('settings:reset', (_e, keepKeys: boolean) => {
    const next = dm.resetSettings(keepKeys);
    // 语言/小窗设置即时生效
    applyMiniSettings();
    buildTrayMenu(next.lang === 'en' ? 'en' : 'zh');
    setDeepThinkLevel(next.deepThinkLevel);
    broadcast('settings:changed', { reset: true });
    return next;
  });

  ipcMain.handle('app:deleteAllData', async () => {
    // 删除所有角色
    const roles = dm.listRoles();
    for (const r of roles) dm.deleteRole(r.id);
    // 删除所有群组
    const groups = dm.listGroups();
    for (const g of groups) dm.deleteGroup(g.group_id);
    // 删除所有聊天及消息
    const chats = dm.getChatList();
    for (const c of chats) {
      dm.deleteChat(c.chat_type, c.chat_id);
    }
    // 删除所有世界书
    const wbs = dm.listWorldBooks();
    for (const w of wbs) dm.deleteWorldBook(w.id);
    // 删除所有规则
    const rules = dm.listRules();
    for (const r of rules) dm.deleteRule(r.id);
    // 删除所有记忆
    const mems = dm.listMemories();
    for (const m of mems) dm.deleteMemory(m.id);
    // 清理文件系统数据（图片、自定义音效等）—— 必须用 dm.dataDir 而非硬编码路径，
    // 因为用户可能已将数据目录迁移到自定义位置（如文档文件夹）。
    try {
      const imagesDir = path.join(dm.getCurrentDataPath(), 'images');
      if (fs.existsSync(imagesDir)) {
        for (const f of fs.readdirSync(imagesDir)) {
          fs.rmSync(path.join(imagesDir, f), { recursive: true, force: true });
        }
      }
      const soundsDir = path.join(app.getPath('userData'), 'custom-sounds');
      if (fs.existsSync(soundsDir)) {
        for (const f of fs.readdirSync(soundsDir)) {
          fs.rmSync(path.join(soundsDir, f), { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.error('[nianyu] deleteAllData 清理文件系统失败', e);
    }
    // 重置设置
    dm.resetSettings(false);
    broadcast('settings:changed', { reset: true });
    return true;
  });

  ipcMain.handle('models:list', async (_e, cfg) => listModels(cfg));
  ipcMain.handle('models:test', async (_e, cfg) => {
    try {
      const res = await testConnection(cfg);
      if (!res.ok) dm.logError('model', `模型连接测试失败：${res.message}`);
      return res;
    } catch (e: any) {
      dm.logError('model', `模型连接测试异常：${e?.message || String(e)}`, e?.stack);
      throw e;
    }
  });
  ipcMain.handle('app:setMenuLang', (_e, lang: string) => {
    if (lang === 'zh' || lang === 'en') Menu.setApplicationMenu(buildMenu(lang));
  });

  ipcMain.handle('dialog:pickImage', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    return res.canceled ? null : res.filePaths;
  });

  // 选择并读取文本文件（用于导入世界书 / 角色卡）
  ipcMain.handle('file:pickText', async (_e, filters) => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters:
        filters && filters.length
          ? filters
          : [{ name: '文本 / 角色卡', extensions: ['json', 'txt', 'md', 'yaml', 'yml'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = res.filePaths[0];
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return { path: p, content };
    } catch (e) {
      console.error('读取文本文件失败', e);
      return null;
    }
  });

  // 自定义音效：选择 MP3 / WAV 文件
  ipcMain.handle('sound:pick', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: '音效文件 (MP3 / WAV)', extensions: ['mp3', 'wav'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  // 自定义音效：将用户选择的文件复制到 userData/custom-sounds 并返回目标文件名
  // key: 'error' | 'click' | 'notification' | 'role:<roleId>'
  ipcMain.handle('sound:setCustom', async (_e, payload: { key: string; srcPath: string }) => {
    const { key, srcPath } = payload || ({} as any);
    if (!key || !srcPath) return null;
    const ext = srcPath.split('.').pop()?.toLowerCase();
    if (ext !== 'mp3' && ext !== 'wav') return null;
    const baseName =
      key === 'error' || key === 'click' || key === 'notification'
        ? `snd-${key}.${ext}`
        : `snd-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
    const dir = path.join(app.getPath('userData'), 'custom-sounds');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const dest = path.join(dir, baseName);
    try {
      fs.copyFileSync(srcPath, dest);
      return baseName;
    } catch (err) {
      console.error('[nianyu] 复制自定义音效失败', err);
      return null;
    }
  });

  // 导入角色卡：兼容本软件格式、SillyTavern JSON 以及 SillyTavern PNG 角色卡。
  // PNG 角色卡以图自身作为头像；JSON 内嵌 base64 头像也会被提取保存。
  ipcMain.handle('character:importCard', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: '角色卡 (JSON / PNG)', extensions: ['json', 'png', 'txt', 'card', 'chara'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = res.filePaths[0];
    const fileName = path.basename(p);
    try {
      const buf = fs.readFileSync(p);
      const isPng = buf.subarray(0, 8).equals(PNG_SIG);
      if (isPng) {
        const json = parseCharacterPng(buf);
        if (!json) return { error: 'not_character_png', fileName };
        // 以该 PNG 本身作为头像
        const avatarName = `avatar_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
        const avatarDest = path.join(dm.imagesDir, avatarName);
        fs.copyFileSync(p, avatarDest);
        return { parsed: parseCharacterCard(json), avatarPath: avatarDest, fileName, isPng: true };
      }
      // 文本 / JSON 角色卡
      const text = buf.toString('utf-8');
      const parsed = parseCharacterCardText(text);
      // 提取内嵌 base64 头像（SillyTavern V2 data.avatar）
      let raw: any = null;
      try {
        raw = JSON.parse(text);
      } catch {
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) {
          try {
            raw = JSON.parse(fence[1]);
          } catch {
            raw = null;
          }
        }
      }
      const d = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
      let avatarPath: string | undefined;
      if (d && typeof d.avatar === 'string' && d.avatar) {
        avatarPath = writeBase64Avatar(d.avatar) || undefined;
      }
      return { parsed, avatarPath, fileName, isPng: false };
    } catch (e) {
      console.error('导入角色卡失败', e);
      return { error: 'read_failed', fileName };
    }
  });

  // 将文本写入文件（用于导出世界书）
  ipcMain.handle('file:saveText', async (_e, content: string, defaultName?: string) => {
    if (!mainWindow) return null;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存文本',
      defaultPath: defaultName || 'export.txt',
      filters: [{ name: '文本', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return null;
    try {
      fs.writeFileSync(res.filePath, content || '', 'utf-8');
      return res.filePath;
    } catch (e) {
      console.error('保存文本文件失败', e);
      return null;
    }
  });

  ipcMain.handle('image:get', (_e, p) => {
    try {
      if (!p || !fs.existsSync(p)) return null;
      const ext = path.extname(p).toLowerCase();
      const mime: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      };
      const b64 = fs.readFileSync(p).toString('base64');
      return `data:${mime[ext] || 'image/png'};base64,${b64}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle('image:save', (_e, dataUrl: string) => {
    try {
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) return null;
      const ext = match[1] === 'image/jpeg' ? '.jpg' : match[1] === 'image/png' ? '.png' : '.png';
      const name = `avatar_${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`;
      const dest = path.join(dm.imagesDir, name);
      fs.writeFileSync(dest, Buffer.from(match[2], 'base64'));
      return dest;
    } catch (e) {
      console.error('保存图片失败', e);
      return null;
    }
  });

  // ---------- 生图（专用图像生成 API） ----------
  ipcMain.handle('image:generate', async (_e, chatType: string, chatId: string, prompt: string) => {
    const s = dm.getSettings();
    const ig = s.imageGen;
    if (!ig || !ig.enabled || !ig.baseUrl || !ig.apiKey) {
      throw new Error('未配置生图 API，请在设置中开启「生图」并填写独立的 Base URL 与 API Key');
    }
    const { b64, url } = await generateImage(
      { baseUrl: ig.baseUrl, apiKey: ig.apiKey },
      prompt,
      ig.model || 'gpt-image-1',
      ig.size || '1024x1024'
    );
    let imagePath: string | null = null;
    if (b64) {
      imagePath = saveGeneratedImage(b64);
    } else if (url) {
      try {
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const name = `gen_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
        const dest = path.join(dm.imagesDir, name);
        fs.writeFileSync(dest, buf);
        imagePath = dest;
      } catch (e) {
        console.error('下载生图失败', e);
      }
    }
    if (!imagePath) throw new Error('生图失败：未获取到图片数据');

    // 软件内生图：不把用户输入的提示词作为聊天消息写入（用户不会在对话中看到自己的生图指令），
    // 仅产生一条 AI 图片消息，并保留 genPrompt 供右键「查看提示词」使用。
    const aiName =
      chatType === 'single'
        ? dm.getRole(dm.resolveSingleRoleId(chatType, chatId))?.name || 'AI'
        : dm.getGroup(chatId)?.group_name || 'AI';
    const aiMsg = dm.addMessage({
      chat_type: chatType as any,
      chat_id: chatId,
      sender_type: 'ai',
      sender_name: aiName,
      content: '',
      image_path: imagePath,
      token_used: 0,
      timestamp: new Date().toISOString(),
      genPrompt: prompt,
    });
    broadcast('stream:user', aiMsg);
    pushMediaUnread(chatType, chatId, aiName, 'image'); // 主窗不可见/未盯该聊天则补未读
    return { ok: true, imagePath };
  });

  // ---------- 生视频（专用视频生成 API，使用方式与生图一致） ----------
  // 非阻塞：handler 立即返回 started，生成在后台运行，进度经 video:progress / video:done 广播，
  // 完成时自动写入一条 AI 视频消息（broadcast stream:user）并广播 video:done；失败只广播 video:done。
  ipcMain.handle('video:generate', async (_e, chatType: string, chatId: string, prompt: string) => {
    void runVideoGenJob(chatType, chatId, prompt);
    return { ok: true, started: true };
  });
  // 发图片生图 / 生视频：以用户发送的图片 + 文字提示词为输入
  // 仅当 prompt 非空才生效（只发图片无提示词则无效，不生图/生视频）
  ipcMain.handle(
    'image:generateFromImage',
    async (_e, chatType: string, chatId: string, prompt: string, imagePath: string, kind: 'image' | 'video') => {
      if (!prompt || !prompt.trim()) {
        throw new Error('请先输入文字提示词：仅发送图片不会生图/生视频');
      }
      if (!imagePath) throw new Error('未找到要参考的图片');
      const dataUrl = readImageDataUrl(imagePath);
      if (!dataUrl) throw new Error('参考图片读取失败');
      if (kind === 'video') {
        // 非阻塞：图生视频同样走后台任务 + 进度气泡
        void runVideoGenJob(chatType, chatId, prompt, dataUrl);
        return { ok: true, started: true };
      }
      // kind === 'image'
      const ig = dm.getSettings().imageGen;
      if (!ig || !ig.enabled || !ig.baseUrl || !ig.apiKey) {
        throw new Error('未配置生图 API，请在设置中开启「生图」');
      }
      const { b64, url } = await generateImage(
        { baseUrl: ig.baseUrl, apiKey: ig.apiKey },
        prompt,
        ig.model || 'gpt-image-1',
        ig.size || '1024x1024',
        [dataUrl]
      );
      let imagePathOut: string | null = null;
      if (b64) imagePathOut = saveGeneratedImage(b64);
      else if (url) {
        try {
          const resp = await fetch(url);
          const buf = Buffer.from(await resp.arrayBuffer());
          const name = `gen_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
          const dest = path.join(dm.imagesDir, name);
          fs.writeFileSync(dest, buf);
          imagePathOut = dest;
        } catch (e) {
          console.error('下载生图失败', e);
        }
      }
      if (!imagePathOut) throw new Error('生图失败：未获取到图片数据');
      const aiMsg = dm.addMessage({
        chat_type: chatType as any,
        chat_id: chatId,
        sender_type: 'ai',
        sender_name: 'AI',
        content: '',
        image_path: imagePathOut,
        token_used: 0,
        timestamp: new Date().toISOString(),
        genPrompt: prompt,
      });
      broadcast('stream:user', aiMsg);
      pushMediaUnread(chatType, chatId, 'AI', 'image'); // 主窗不可见/未盯该聊天则补未读
      return { ok: true, imagePath: imagePathOut };
    }
  );

  // 手动把一张图片存入角色记忆（AI 不会自动保存图片记忆）
  ipcMain.handle('memory:saveImage', (_e, p: { roleId: string; imagePath: string; note?: string }) => {
    if (!p.roleId || !p.imagePath) return null;
    const name = (p.imagePath || '').split(/[\\/]/).pop() || '图片';
    const content = p.note && p.note.trim() ? p.note.trim() : `生成/收到图片：${name}`;
    return dm.addMemory({ roleId: p.roleId, content, source: 'manual', image_path: p.imagePath } as any);
  });

  ipcMain.handle('backup:pickTarget', async () => {
    if (!mainWindow) return null;
    const s = dm.getSettings();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const fileName = `NianyuBackup_${stamp}.zip`;
    const defaultPath =
      s.backupDir && fs.existsSync(s.backupDir)
        ? path.join(s.backupDir, fileName)
        : fileName;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '选择备份保存位置',
      defaultPath,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    return res.canceled ? null : res.filePath;
  });
  // 选择默认备份目录
  ipcMain.handle('backup:pickDir', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择默认备份目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  // 一键导出备份到默认备份目录（无对话框）
  ipcMain.handle('backup:export', () => {
    const s = dm.getSettings();
    if (!s.backupDir) throw new Error('尚未设置默认备份目录');
    fs.mkdirSync(s.backupDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const dest = path.join(s.backupDir, `NianyuBackup_${stamp}.zip`);
    createBackup(dm.dataDirectory, dest);
    dm.saveSettings({ lastBackupTime: new Date().toISOString() });
    return dest;
  });
  ipcMain.handle('backup:create', (_e, destPath) => {
    createBackup(dm.dataDirectory, destPath);
    dm.saveSettings({ lastBackupTime: new Date().toISOString() });
  });
  ipcMain.handle('backup:pickFile', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('backup:restore', (_e, zipPath) => {
    restoreBackup(zipPath, dm.dataDirectory);
    dm.reloadAll();
    app.relaunch();
    app.exit(0);
  });

  // ---------- 应用数据保存路径（实时数据，非备份）----------
  ipcMain.handle('data:getPath', () => {
    return {
      current: dm.getCurrentDataPath(),
      custom: dm.getCustomDataPath(),
      def: defaultDataDirPath(),
    };
  });
  ipcMain.handle('data:setPath', (_e, dir: string) => {
    const res = dir && dir.trim() ? dm.setCustomDataPath(dir) : dm.resetDataPathToDefault();
    if (res.ok) {
      // 数据已整体迁移到新目录并写入 path-config；延迟重启以让 IPC 响应先返回前端，
      // 重启后 resolveDataDir() 读取新配置，后续写入落到新目录，避免内存态与磁盘配置不一致。
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 400);
    }
    return res;
  });
  ipcMain.handle('data:pickDir', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择应用数据保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // ---------- 错误日志 ----------
  ipcMain.handle('error:log', (_e, category: 'functional' | 'model' | 'other', message: string, detail?: string) => {
    dm.logError(category, message, detail);
  });
  ipcMain.handle('error:get', () => dm.getErrorLog());
  ipcMain.handle('error:clear', () => dm.clearErrorLog());

  // ---------- 语音：ASR 转写 ----------
  ipcMain.handle('audio:transcribe', async (_e, data: Uint8Array) => {
    const s = dm.getSettings();
    const v = s.voice;
    if (!v?.asrBaseUrl || !v?.asrApiKey) throw new Error('未配置语音输入 API（请在设置中填写 ASR 专用 Base URL 与 API Key）');
    const fmt = (v.asrFormat || 'wav') as 'wav' | 'mp3' | 'm4a' | 'flac' | 'webm';
    return transcribeAudio(
      { baseUrl: v.asrBaseUrl, apiKey: v.asrApiKey },
      Buffer.from(data),
      v.asrModel || 'whisper-1',
      fmt,
      v.asrLanguage || undefined
    );
  });

  // ---------- 语音：TTS 合成，返回 base64 mp3 ----------
  // roleId 可选：按数字人角色分别解析音色（ttsVoices[roleId] 优先，缺省回退全局 ttsVoice）
  ipcMain.handle('audio:tts', async (_e, text: string, roleId?: string) => {
    const s = dm.getSettings();
    const v = s.voice;
    if (!v?.ttsBaseUrl || !v?.ttsApiKey) throw new Error('未配置 TTS 专用 API，请在设置中填写独立的 Base URL 与 API Key');
    const voiceName = (roleId && v.ttsVoices && v.ttsVoices[roleId]) || v.ttsVoice || 'alloy';
    const buf = await textToSpeech(
      { baseUrl: v.ttsBaseUrl, apiKey: v.ttsApiKey },
      text,
      v.ttsModel || 'tts-1',
      voiceName
    );
    return `data:audio/mpeg;base64,${buf.toString('base64')}`;
  });

  // ---------- 语音：拉取 TTS 可用音色列表（服务端优先，失败回退内置清单） ----------
  ipcMain.handle('audio:listVoices', async () => {
    const DEFAULT_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    const v = dm.getSettings().voice;
    if (!v?.ttsBaseUrl || !v?.ttsApiKey) return DEFAULT_VOICES;
    try {
      const url = `${v.ttsBaseUrl.replace(/\/+$/, '')}/audio/voices`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${v.ttsApiKey}` } });
      if (resp.ok) {
        const data: any = await resp.json().catch(() => null);
        const arr: any[] = Array.isArray(data) ? data : data?.voices ?? data?.data ?? [];
        if (Array.isArray(arr) && arr.length) {
          const names = arr
            .map((x) => (typeof x === 'string' ? x : x?.id || x?.name || x?.voice || ''))
            .filter((x) => !!x);
          if (names.length) return names;
        }
      }
    } catch {
      /* 服务端不支持列接口时回退内置清单 */
    }
    return DEFAULT_VOICES;
  });

  // ---------- 快捷小窗 ----------
  // 可携带 initialChat（如观察者私密小窗 obs:<groupId>:<roleId>），将小窗直接切到该会话
  let pendingMiniChat:
    | { chatType: string; chatId: string; isObserverPrivate?: boolean }
    | null = null;
  ipcMain.handle(
    'mini:open',
    (_e, p?: { initialChat?: { chatType: string; chatId: string; isObserverPrivate?: boolean } }) => {
      const initial = p?.initialChat || null;
      if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.webContents.send('mini:switch', initial);
        miniWindow.setOpacity(1);
        miniWindow.show();
        miniWindow.focus();
        return;
      }
      pendingMiniChat = initial;
      showMiniWindow();
    }
  );
  ipcMain.handle('mini:getInitial', () => {
    const v = pendingMiniChat;
    pendingMiniChat = null;
    return v;
  });
  ipcMain.handle('mini:hide', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
  });
  ipcMain.handle('mini:setOnTop', (_e, v: boolean) => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.setAlwaysOnTop(!!v);
  });
  // ===== 空闲主动回复：主进程维护全局权威计时基准（跨窗口唯一数据源）=====
  // 两窗口各自渲染进程独立，无法共享模块变量，因此由主进程统一持有 lastActivity
  // 并每秒广播 elapsed，渲染进程只负责显示，杜绝相位差与初始化差。
  const idleState = new Map<string, number>(); // chatKey -> lastActivityTs
  ipcMain.handle('idle:get', (_e, chatKey: string) => {
    return idleState.get(chatKey) ?? null;
  });
  ipcMain.on('idle:set', (_e, data: { chatKey: string; ts: number }) => {
    if (!data || !data.chatKey) return;
    idleState.set(data.chatKey, data.ts);
    // 广播给所有窗口，使其 lastActivityRef 同步为权威值
    broadcast('idle:activity', { chatKey: data.chatKey, timestamp: data.ts });
  });
  // 全局 tick：广播各聊天已静默毫秒数，渲染进程据此计算剩余秒数（多窗口完全一致）
  setInterval(() => {
    if (quitting) return;
    if (idleState.size === 0) return;
    const now = Date.now();
    const payload: Record<string, number> = {};
    for (const [k, ts] of idleState) payload[k] = now - ts;
    broadcast('idle:tick', payload);
  }, 250);
  ipcMain.handle('mini:setOpacity', (_e, v: number) => {
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.setOpacity(Math.max(0.4, Math.min(1, Number(v) || 1)));
    }
  });
  ipcMain.handle('main:show', () => showMainWindow());

  // 打开外部网页（联网搜索结果点击编号）：仅允许 http/https，避免任意协议被拉起
  // 注意：preload 端用 ipcRenderer.send 发送，故此处必须用 ipcMain.on 配对（handle 只响应 invoke）
  ipcMain.on('app:openExternal', async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const { shell } = await import('electron');
      shell.openExternal(url);
    }
  });

  // ---------- 世界书 ----------
  ipcMain.handle('worldbooks:list', () => dm.listWorldBooks());
  ipcMain.handle('worldbooks:get', (_e, id) => dm.getWorldBook(id));
  ipcMain.handle('worldbooks:save', (_e, wb: WorldBook) => dm.saveWorldBook(wb));
  ipcMain.handle('worldbooks:delete', (_e, id) => dm.deleteWorldBook(id));
  ipcMain.handle('worldbooks:copy', (_e, id) => dm.copyWorldBook(id) || null);
  ipcMain.handle('worldbooks:import', (_e, content: string, name: string) => {
    const wb = parseWorldBook(content, name);
    if (!wb.id) wb.id = uid('wb');
    dm.saveWorldBook(wb);
    return wb;
  });
  ipcMain.handle('worldbook:effectiveId', (_e, chatType: string, chatId: string) => {
    const settings = dm.getSettings();
    const key = `${chatType}:${chatId}`;
    if (settings.chatWorldBooks && settings.chatWorldBooks[key]) return settings.chatWorldBooks[key];
    if (chatType === 'single') {
      const r = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
      if (r && r.worldBookId) return r.worldBookId;
    }
    return settings.defaultWorldBookId || '';
  });

  // ---------- 规则库 ----------
  ipcMain.handle('rules:list', () => dm.listRules());
  ipcMain.handle('rules:save', (_e, rule: Rule) => dm.saveRule(rule));
  ipcMain.handle('rules:delete', (_e, id) => dm.deleteRule(id));
  ipcMain.handle('rules:copy', (_e, id) => dm.copyRule(id) || null);
  ipcMain.handle('rules:import', (_e, content: string, name: string) => {
    const rule = parseRule(content, name);
    if (!rule.id) rule.id = uid('rule');
    dm.saveRule(rule);
    return rule;
  });

  // ---------- 记忆 ----------
  ipcMain.handle('memories:list', (_e, roleId?: string) => dm.listMemories(roleId));
  ipcMain.handle('memories:add', (_e, m: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at'>) =>
    dm.addMemory(m)
  );
  ipcMain.handle('memories:update', (_e, id: string, content: string) => dm.updateMemory(id, content));
  ipcMain.handle('memories:delete', (_e, id) => dm.deleteMemory(id));
  ipcMain.handle('memories:extract', async (_e, chatType: string, chatId: string) =>
    extractMemories(chatType, chatId)
  );

  // ---------- 插件导入 ----------
  ipcMain.handle('plugin:import', async (_e, content: string, name: string) =>
    importPluginLogic(content, name)
  );

  // 插件列表
  ipcMain.handle('plugin:list', () => dm.listPlugins());

  // 删除插件（仅删插件记录，不级联删底层世界书/角色/规则，避免误伤既有资产）
  ipcMain.handle('plugin:remove', (_e, id: string) => {
    dm.deletePlugin(id);
    return { ok: true };
  });

  // 启停插件
  ipcMain.handle('plugin:toggle', (_e, id: string, enabled: boolean) => {
    const next = dm.updatePlugin(id, { enabled });
    return { ok: !!next, plugin: next };
  });

  // 受控 HTTP 工具调用：只发预设的请求，绝不执行任意代码（安全边界）
  ipcMain.handle(
    'plugin:callTool',
    async (_e, pluginId: string, toolName: string, arg: string) => {
      const plugin = dm.getPlugin(pluginId);
      const tool = plugin?.tools?.find((t) => t.name === toolName);
      if (!plugin || !tool || !tool.url) throw new Error('插件或工具不存在');
      const base = tool.url;
      const url = tool.paramName
        ? `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(tool.paramName)}=${encodeURIComponent(arg || '')}`
        : base;
      const headers: Record<string, string> = tool.headers || {};
      const body = tool.bodyTemplate
        ? tool.bodyTemplate.replace(/\{\{arg\}\}/g, arg || '').replace(/\{\{query\}\}/g, arg || '')
        : undefined;
      const r = await fetch(url, {
        method: tool.method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body || undefined,
      });
      if (!r.ok) throw new Error(`插件请求失败：${r.status}`);
      const text = await r.text();
      return { ok: true, text: text.slice(0, 8000) };
    }
  );

  // ---------- 窗口控制（最小化 / 最大化 / 还原 / 关闭） ----------
  ipcMain.on(
    'window-control',
    (e, action: 'minimize' | 'maximize' | 'unmaximize' | 'close') => {
      const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
      if (!win || win.isDestroyed()) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') win.maximize();
      else if (action === 'unmaximize') win.unmaximize();
      else if (action === 'close') win.close();
    }
  );

  ipcMain.on('window-drag-to', (_e, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(_e.sender);
    if (win && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y));
  });

  // ---------- 确认对话框（替换 window.confirm 避免 Electron 阻塞渲染器事件循环） ----------
  ipcMain.handle('app:confirm', async (_e, message: string, title?: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: title || '确认',
      message: message || '',
    });
    // 原生对话框关闭后会破坏渲染器输入框的焦点路由：键击无法进入任何输入框，
    // 直到窗口失去并重新获得 OS 焦点才恢复（即用户手动切到小窗再切回的现象）。
    // 此处主动重置窗口 OS 焦点，等价于一次真实的窗口焦点切换，彻底修复
    // 「删除角色/模型配置后主界面输入框锁死」的同类 bug（覆盖所有 confirm 流程）。
    try {
      mainWindow.focus();
      mainWindow.webContents.focus();
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
    return res.response === 0;
  });

  // ---------- 后台消息提醒（Steam 风格卡片） ----------
  ipcMain.handle('notify:card', (_e, item) => {
    showNotifyCard(item);
  });
  ipcMain.handle('notify:open', (_e, chat) => {
    openNotifyChat(chat);
  });
  ipcMain.handle('notify:close', () => {
    hideNotifyWindow();
  });
  // 鼠标进入/离开卡片时切换鼠标穿透：进入后取消穿透，关闭按钮才能正常响应点击
  ipcMain.handle('notify:ignoreMouse', (_e, ignore: boolean) => {
    if (notifyWindow && !notifyWindow.isDestroyed()) {
      notifyWindow.setIgnoreMouseEvents(!!ignore, { forward: !!ignore });
    }
  });

  // ===== 桌面悬浮球 IPC =====
  registerBallIPC();
  // 渲染端切换当前聊天时回传，供悬浮球未读判断「主动消息」是否计入
  ipcMain.on('app:active-chat', (_e, p: { type: string; id: string }) => {
    if (p && typeof p.type === 'string' && typeof p.id === 'string') setActiveChat(p.type, p.id);
  });
  // 设置中切换悬浮球开关：启用则创建、关闭则销毁
  ipcMain.on('ball:set-enabled', (_e, enabled: boolean) => {
    if (enabled) createFloatingBall();
    else destroyFloatingBall();
  });
}

// ===== 全局错误监听（主进程） =====
function getAppLangFromSettings(): 'zh' | 'en' {
  try {
    const s = dm.getSettings();
    return s.lang === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

process.on('uncaughtException', (error) => {
  const lang = getAppLangFromSettings();
  const msg = error?.message || String(error);
  // 退出流程中窗口已销毁的竞态错误：静电忽略，不再弹窗也不再退出
  if (/object has been destroyed/i.test(msg)) {
    console.warn('[nianyu] ignored destroyed-object exception during quit:', msg);
    return;
  }
  const diag = diagnoseError(msg);
  console.error('[nianyu] uncaughtException:', msg);
  const isZh = lang === 'zh';
  dialog.showErrorBox(
    isZh ? '念语 - 发生错误' : 'Nianyu - Error',
    `${isZh ? '错误信息' : 'Error'}: ${msg}\n\n${isZh ? '可能原因' : 'Cause'}: ${diag.cause[lang]}\n\n${isZh ? '解决方法' : 'Solution'}: ${diag.solution[lang]}\n\n${isZh ? '应用将自动退出。请根据解决方法排查后重启。' : 'The app will exit. Please follow the solution and restart.'}`
  );
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  const lang = getAppLangFromSettings();
  const msg = reason instanceof Error ? reason.message : String(reason || 'Unknown rejection');
  const diag = diagnoseError(msg);
  console.error('[nianyu] unhandledRejection:', msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:error', {
      message: msg,
      cause: diag.cause[lang],
      solution: diag.solution[lang],
      lang,
    });
  } else {
    console.warn(`[nianyu] Unhandled rejection: ${msg} | ${diag.cause[lang]} | ${diag.solution[lang]}`);
  }
});

app.whenReady().then(() => {
  const settings = dm.getSettings();
  setDeepThinkLevel(settings.deepThinkLevel);
  Menu.setApplicationMenu(buildMenu(settings.lang === 'en' ? 'en' : 'zh'));
  protocol.registerFileProtocol('nianyuimg', (request, callback) => {
    const url = request.url.replace('nianyuimg://', '');
    callback(decodeURIComponent(url));
  });
  // 自定义音效协议：nysound://<filename> -> userData/custom-sounds/<filename>
  const customSoundsDir = path.join(app.getPath('userData'), 'custom-sounds');
  try {
    fs.mkdirSync(customSoundsDir, { recursive: true });
  } catch {
    /* 忽略：目录已存在或无权限（后续复制会报错提示） */
  }
  protocol.registerFileProtocol('nysound', (request, callback) => {
    try {
      // request.url 格式为 nysound://<filename>,用 path.basename 提取纯文件名。
      // 直接用 request.url 手动解析而非 new URL(),避免标准 URL 解析对 pathname 的干扰。
      const raw = request.url.replace(/^nysound:\/*/, '');
      const file = path.basename(decodeURIComponent(raw));
      callback({ path: path.join(customSoundsDir, file) });
    } catch {
      callback({ path: '' });
    }
  });
  registerIPC();
  createWindow();
  createTray();
  applyMiniSettings();
  // 桌面悬浮球：注入主窗引用/唤出函数，并按设置创建悬浮球窗口
  setBallMainShow(showMainWindow);
  setBallMainWindow(mainWindow);
  createFloatingBall();
  // 启动即处于全屏时，按设置隐藏悬浮球
  if (mainWindow && mainWindow.isFullScreen()) {
    const s = dm.getSettings();
    if (s.floatingBall?.autoHideInFullscreen !== false) hideFloatingBall();
  }
  // 朋友圈：启动时发布已到点的定时动态，并每 60 秒轮询一次，实现「定时发动态」
  dm.publishDueMoments();
  setInterval(() => { try { dm.publishDueMoments(); } catch { /* 忽略：数据异常不影响主流程 */ } }, 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  autoChatDrivers.clear();
  if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.destroy();
  notifyWindow = null;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
