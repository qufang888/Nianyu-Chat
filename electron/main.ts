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
import { getDataManager } from './db';
import {
  queryAI,
  aiCompleteRole,
  listModels,
  testConnection,
  AIMessage,
  streamAI,
  transcribeAudio,
  textToSpeech,
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
} from '../src/types';

// 自定义音效协议：用于播放用户选择的 MP3/WAV（映射到 userData/custom-sounds）
// 必须在 app ready 之前注册为特权协议，才能被 <audio> 正常加载。
protocol.registerSchemesAsPrivileged([
  { scheme: 'nysound', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const dm = getDataManager();

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

function createWindow(): void {
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
    },
  });

  if (process.env.NIANYU_DEV === '1') {
    mainWindow.loadURL(DEV_SERVER);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

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
      e.preventDefault();
      mainWindow?.hide();
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

  // 还原最大化状态
  mainWindow.once('ready-to-show', () => {
    if (b.isMaximized) mainWindow?.maximize();
  });
  // 首次加载完成后推送初始窗口状态（最大化/还原图标同步）
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.send('window-state-change', mainWindow.isMaximized());
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
  miniWindow.on('closed', () => {
    miniWindow = null;
  });

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

  // 有交互时恢复不透明
  miniWindow.on('focus', () => miniWindow?.setOpacity(1));
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
  miniWindow.webContents.send('mini:switch', null);
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
  notifyWindow.webContents.send('notify:data', {
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
    const r = dm.getRole(parseObsRoleId(chatId) || chatId);
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
    dm.updateRole(roleId, { mood });
    broadcast('role:mood', { roleId, chatType, chatId, mood });
    logEmotionIfObserver(chatType, chatId, roleId); // 记录对局情绪轨迹
  }
}

function buildSystemPrompt(role: Role, freezeMemory = false): string {
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
    const memories = dm.listMemories(role.id);
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

function historyToMessages(history: ChatMessage[]): AIMessage[] {
  return history.map((m) => ({
    role: m.sender_type === 'user' ? 'user' : 'assistant',
    content: m.image_path || (m.images && m.images.length) ? `[用户发送了一张图片]${m.content || ''}` : m.content || '',
  }));
}

async function handleSend(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
}): Promise<SendMessageResult> {
  const settings = dm.getSettings();
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) {
    throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  }
  validateModels(memberRoles, settings);

  const userMsg = addUserMessage(p);
  const result = await generateAIResponses(
    { ...p, imagePath: userMsg.image_path },
    memberRoles,
    settings
  );
  return { userMessage: userMsg, ...result };
}

function resolveMembers(chatType: string, chatId: string, content: string): Role[] {
  let memberRoles: Role[] = [];
  if (chatType === 'single') {
    const r = dm.getRole(parseObsRoleId(chatId) || chatId);
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
}): ChatMessage {
  const settings = dm.getSettings();
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  // 多图优先：使用 imagePaths 数组；单图回退到 imagePath
  const multi = p.imagePaths && p.imagePaths.length ? copyImagesToStore(p.imagePaths) : null;
  const storedImage = multi ? multi[0] : copyImageToStore(p.imagePath || null);
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
  privateObserver = false
): AIMessage[] {
  const parts: string[] = [buildSystemPrompt({ ...role, affinity: affinityTotal }, freezeMemory)];
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
  return [
    { role: 'system', content: sysPrompt },
    ...historyToMessages(history),
    {
      role: 'user',
      content: instruction || (storedImage ? '[用户发送了一张图片，请结合图片内容回应]' : content),
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
  groupId?: string
): AIMessage[] {
  const parts: string[] = [buildSystemPrompt({ ...role, affinity: affinityTotal }, freezeMemory)];
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
    const text = m.image_path || (m.images && m.images.length) ? `[发送了一张图片]${m.content || ''}` : m.content || '';
    const isSelf = m.sender_type === 'ai' && m.sender_name === role.name;
    const roleTag: 'user' | 'assistant' = isSelf ? 'assistant' : 'user';
    const content = isSelf ? text : `${m.sender_name}: ${text}`;
    const last = msgs[msgs.length - 1];
    if (last && last.role === roleTag) {
      last.content += `\n${content}`;
    } else {
      msgs.push({ role: roleTag, content });
    }
  }
  if (instruction) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user') last.content += `\n\n${instruction}`;
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
  p: { chatType: string; chatId: string; content: string; imagePath?: string | null },
  memberRoles: Role[],
  settings: AppSettings
): Promise<Omit<SendMessageResult, 'userMessage'>> {
  const storedImage = p.imagePath || null;
  const history = dm.getMessages(p.chatType, p.chatId).slice(-16);
  const resolveModel = (role: Role): ModelConfig | undefined => resolveRoleModel(role, settings);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const isGroup = p.chatType === 'group';
  // 观察者模式「记忆冻结」：对局内不读取外部世界书
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const groupNames = isGroup ? getGroupMemberNames(p.chatId) : [];

  const runOne = async (role: Role, hist: ChatMessage[]) => {
    const cfg = resolveModel(role) as ModelConfig;
    // 私密小窗：若关闭「影响情绪好感」，则不因该对话改变好感度
    const isPrivate = !isGroup && p.chatId.startsWith('obs:');
    const allowEmotion = !isPrivate || !!obs?.privateAffectsEmotion;
    const total = allowEmotion ? applyAffinityChange(role, p.content, storedImage) : role.affinity;
    // 群聊：串行 + 带发言人标注，让成员能看见彼此的发言；单聊维持原逻辑
    const messages = isGroup
      ? buildGroupMessages(role, groupNames, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, p.chatId)
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
          isPrivate
        );
    const streamId = `${p.chatId}:${role.id}`;
    // 每个成员完成时立即广播，前端按完成顺序逐步显示；即使关闭全局流式也生效。
    sendStreamStart(streamId, role.id, role.name);
    try {
      const res = await queryAI(cfg, messages, 1024);
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
      return { aiMsg, roleId: role.id, total, tokens: aiMsg.token_used };
    } catch (e: any) {
      // 失败也广播完成，避免占位气泡卡住
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
      return { aiMsg: errMsg, roleId: role.id, total, tokens: 0 };
    }
  };

  let results: { aiMsg: ChatMessage; roleId: string; total: number; tokens: number }[];
  if (isGroup) {
    // 串行轮流发言：每位成员生成后立即落库，下一位重新读取最新历史（含前一位的发言）
    results = [];
    for (const role of memberRoles) {
      const hist = dm.getMessages(p.chatType, p.chatId).slice(-24);
      results.push(await runOne(role, hist));
    }
  } else {
    results = await Promise.all(memberRoles.map((role) => runOne(role, history)));
  }

  const aiMessages: ChatMessage[] = [];
  const affinityChanges: { role_id: string; change: number; total: number }[] = [];
  let totalTokens = 0;
  for (const r of results) {
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
  return generateAIResponses(p, memberRoles, settings);
}

// 流式生成：单聊与群聊通用；群聊按 settings.streamParallel 分批并发
async function handleStream(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
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
  const history = dm.getMessages(p.chatType, p.chatId).slice(-16);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const isGroup = p.chatType === 'group';
  // 观察者模式「记忆冻结」：对局内不读取外部世界书
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const groupNames = isGroup ? getGroupMemberNames(p.chatId) : [];

  const members = memberRoles.map((role) => ({
    streamId: `${p.chatId}:${role.id}`,
    roleId: role.id,
    roleName: role.name,
  }));

  // 整段生成（群聊多位成员串行）共享一个控制器，删除聊天时整体中止，避免孤儿流继续写库产生幽灵会话
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);

  const streamOne = async (role: Role) => {
    if (controller.signal.aborted) return;
    const cfg = resolveRoleModel(role, settings) as ModelConfig;
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
    const hist = isGroup ? dm.getMessages(p.chatType, p.chatId).slice(-24) : history;
    const messages = isGroup
      ? buildGroupMessages(role, groupNames, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, p.chatId)
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
          isPrivate
        );
    sendStreamStart(streamId, role.id, role.name);
    try {
      // Anthropic 不支持流式，回退到非流式（一次性整段）
      if (cfg.provider === 'anthropic') {
        const res = await queryAI(cfg, messages, 1024);
        if (controller.signal.aborted) return;
        emitChunk(res.content, true, '', res.reasoning || '');
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
        return;
      }

      let full = '';
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
      if (controller.signal.aborted) return;
      const aiMsg = dm.addMessage({
        chat_type: p.chatType as any,
        chat_id: p.chatId,
        sender_type: 'ai',
        sender_name: role.name,
        content: full || res.content,
        reasoning: res.reasoning,
        image_path: null,
        token_used: res.promptTokens + res.completionTokens,
        timestamp: new Date().toISOString(),
      });
      sendStreamDone(streamId, aiMsg);
      void requestMoodJudge(p.chatType, p.chatId, role.id);
    } catch (e: any) {
      emitChunk('', true, e?.message || String(e));
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
          await streamOne(role);
        }
      } else {
        for (let i = 0; i < memberRoles.length; i += parallel) {
          if (controller.signal.aborted) break;
          const batch = memberRoles.slice(i, i + parallel);
          await Promise.all(batch.map((role) => streamOne(role)));
        }
      }
    } finally {
      clearTimeout(timer);
      unregisterStream(p.chatId, controller);
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
async function handleGroupContinue(p: {
  chatId: string;
}): Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }> {
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
  let role = await pickNextSpeaker(memberRoles, settings, history);

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
    });
    sendStreamDone(streamId, aiMsg);
    void requestMoodJudge('group', p.chatId, role.id);
    return { ok: true, roleId: role.id, roleName: role.name };
  } catch (e: any) {
    emitChunk('', true, e?.message || String(e));
    return { ok: false, roleId: role.id, roleName: role.name, error: e?.message || String(e) };
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
        isPrivate
      );

  const cfg = resolveRoleModel(role, settings) as ModelConfig;
  const streamId = `${p.chatId}:${role.id}`;
  sendStreamStart(streamId, role.id, role.name);
  const controller = new AbortController();
  registerStream(p.chatId, controller);
  try {
    const res = await queryAI(cfg, messages, 1024);
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
    dm.updateRole(p.roleId, { mood: p.mood });
    mood = p.mood;
    broadcast('role:mood', { roleId: p.roleId, chatType: p.chatType, chatId: p.chatId, mood: p.mood });
  }
  logEmotionIfObserver(p.chatType, p.chatId, p.roleId); // 记录对局情绪轨迹（事件也会改变好感/心情）
  activeEvents.delete(p.chatId); // 选完即关闭该聊天的事件占用
  // 在聊天中插入系统消息通知好感/情绪变化
  const moodNote = p.mood && mood === p.mood ? ` · 心情 → ${mood}` : '';
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

// 从私密小窗 chatId 提取关联角色 id（roleId 取末段，兼容 groupId 含冒号）
function parseObsRoleId(chatId: string): string | null {
  if (chatId.startsWith('obs:')) {
    const parts = chatId.split(':');
    if (parts.length >= 3) return parts[parts.length - 1];
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

// 插件导入：自动识别为世界书 / 角色预设包 / 提示词规则包
async function importPluginLogic(
  content: string,
  name: string
): Promise<{ kind: 'worldbook' | 'rule' | 'role'; id: string; name: string }> {
  const text = (content || '').trim();
  let raw: any = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (raw && typeof raw === 'object') {
    const ent = extractLoreEntries(raw);
    if (ent.length > 0 || raw.lorebook || raw.worldbook || raw.world_book) {
      const wb = parseWorldBook(content, name || '导入的世界书');
      wb.id = uid('wb');
      dm.saveWorldBook(wb);
      return { kind: 'worldbook', id: wb.id, name: wb.name };
    }
    const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const isRole =
      d.name || d.char_name || d.character_name || d.title || d.description || d.char_persona || d.personality || d.first_mes;
    if (isRole) {
      const parsed = parseCharacterCard(raw);
      const role = buildRoleFromParsed(parsed, name);
      dm.createRole(role);
      return { kind: 'role', id: role.id, name: role.name };
    }
  }
  const rule = parseRule(content, name || '导入的规则');
  rule.id = uid('rule');
  dm.saveRule(rule);
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
    roleId = parseObsRoleId(chatId) || chatId;
  } else {
    const lastAi = [...history].reverse().find((m) => m.sender_type === 'ai');
    roleId = lastAi ? dm.getRoleByName(lastAi.sender_name)?.id : undefined;
  }
  if (!roleId) return 0;
  const existing = dm.listMemories(roleId).map((m) => m.content.trim());
  const convo = history
    .slice(-14)
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
    for (const l of lines) {
      dm.addMemory({ roleId, content: l, source: 'auto', sourceMsgId: lastMsgId } as any);
      n += 1;
    }
    return n;
  } catch (e) {
    console.error('记忆提炼失败', e);
    return 0;
  }
}

// 广播到所有窗口（主窗 + 快捷小窗）
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
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
  ipcMain.handle('chats:groupContinue', async (_e, p) => handleGroupContinue(p));
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
    // 广播设置变更，让主窗与小窗同步刷新（世界书/身份/背景/开关等）
    broadcast('settings:changed', patch || {});
    return next;
  });
  ipcMain.handle('settings:reset', (_e, keepKeys: boolean) => {
    const next = dm.resetSettings(keepKeys);
    // 语言/小窗设置即时生效
    applyMiniSettings();
    buildTrayMenu(next.lang === 'en' ? 'en' : 'zh');
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
    // 重置设置
    dm.resetSettings(false);
    broadcast('settings:changed', { reset: true });
    return true;
  });

  ipcMain.handle('models:list', async (_e, cfg) => listModels(cfg));
  ipcMain.handle('models:test', async (_e, cfg) => testConnection(cfg));
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
    app.relaunch();
    app.exit(0);
  });

  // ---------- 语音：ASR 转写 ----------
  ipcMain.handle('audio:transcribe', async (_e, data: Uint8Array) => {
    const s = dm.getSettings();
    const v = s.voice;
    if (!v?.asrModelId) throw new Error('未配置语音输入模型');
    const cfg = s.models.find((m) => m.id === v.asrModelId);
    if (!cfg) throw new Error('语音输入引用的模型配置不存在');
    return transcribeAudio(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      Buffer.from(data),
      v.asrModel || 'whisper-1'
    );
  });

  // ---------- 语音：TTS 合成，返回 base64 mp3 ----------
  ipcMain.handle('audio:tts', async (_e, text: string) => {
    const s = dm.getSettings();
    const v = s.voice;
    if (!v?.ttsModelId) throw new Error('未配置 TTS 模型');
    const cfg = s.models.find((m) => m.id === v.ttsModelId);
    if (!cfg) throw new Error('TTS 引用的模型配置不存在');
    const buf = await textToSpeech(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      text,
      v.ttsModel || 'tts-1',
      v.ttsVoice || 'alloy'
    );
    return `data:audio/mpeg;base64,${buf.toString('base64')}`;
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
      const r = dm.getRole(parseObsRoleId(chatId) || chatId);
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
      const u = new URL(request.url);
      const file = path.basename(decodeURIComponent(u.pathname));
      callback({ path: path.join(customSoundsDir, file) });
    } catch {
      callback({ path: '' });
    }
  });
  registerIPC();
  createWindow();
  createTray();
  applyMiniSettings();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.destroy();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
