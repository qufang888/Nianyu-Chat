/**
 * 桌面角色（V3）—— 主进程窗口与物理层。
 *
 * 设计边界（合规）：
 * - 仅实现「透明置顶窗口 / 命中与穿透切换 / 弹簧拖拽 / 待机动作 / 气泡反馈」这类**通用交互范式**；
 * - 不含任何第三方桌面宠物软件的品牌资产、角色形象、专有文案、音效或动画素材；
 * - 默认角色由渲染层用原创几何图形绘制（见 src/character/PlaceholderCharacter.tsx），非任何商业角色。
 *
 * 物理与穿透（对应需求「第一层」）：
 * - 透明 / 无边框 / 无阴影 / 置顶（'pop-up-menu'；Windows 上由悬浮球 moveTop() 保证球在上）/ 跳过任务栏；
 * - 默认整体 `setIgnoreMouseEvents(true, { forward: true })`，由渲染层按命中区域动态切回可交互；
 * - 拖拽由**主进程轮询设备光标**（screen.getCursorScreenPoint）驱动显式弹簧（K=200 / C=30，子步 1/120），
 *   松手后按末速度做惯性滑停；拖拽期间锁定可交互，结束再交还穿透路由；
 * - 「穿透锁定」：锁定后角色恒穿透、不再自动切回可交互（只能在主界面「桌宠角色」面板解锁）；
 * - 与悬浮球**非重叠**：初始定位与拖拽落点都按悬浮球窗矩形做位移避让。
 */
import { BrowserWindow, screen, ipcMain } from 'electron';
import path from 'node:path';
import { getDataManager } from './db';
// v3.0.1-beta.9 P0：本模块已 import floatingBall（同向依赖），再引入其 Z 序兜底函数
// 不会形成环；反向（floatingBall → desktopCharacter）则改用 main.ts 注入 probe 规避。
import { getBallWindowBounds, reassertFloatingBallOnTop } from './floatingBall';
// v3.0.1-beta.9：置顶层级统一由 windowLevels 定义（悬浮球 > 桌宠 > 小窗）。
import { applyAlwaysOnTop, DESKTOP_CHARACTER_LEVEL } from './windowLevels';
import type { CharacterRuntimeSettings, DesktopCharacter } from '../src/types';

const dm = getDataManager();

/** 角色窗尺寸（DIP）。角色立绘在窗内底部，气泡在上方，右键菜单在窗内浮层。 */
export const DC_WIN_W = 340;
export const DC_WIN_H = 420;
/** 弹簧参数与积分步长（需求给定参考值） */
const SPRING_K = 200;
const SPRING_C = 30;
const SUBSTEP = 1 / 120;
/** 拖拽/惯性刷新周期（≈60Hz） */
const TICK_MS = 16;
/** 与悬浮球避让的间距 */
const BALL_GAP = 16;
/** 眼神跟随采样周期（毫秒，≈30Hz）：主进程轮询全局光标并推给角色窗，实现全屏跟随。 */
const CURSOR_TICK_MS = 33;

let dcWindow: BrowserWindow | null = null;
let mainWindowRef: BrowserWindow | null = null;
/**
 * 设置变更广播器（由 main.ts 注入）。
 * 为什么需要：运行时开关（启用/置顶/穿透锁定/当前角色）由主进程直接落盘，渲染层若只靠自己
 * `patch()` 落盘就会把设置页里的 **旧 x/y** 一起写回去，导致「在设置页开关一下，桌上角色瞬移回旧位置」。
 * 改成主进程唯一真源 + 广播 `settings:changed`，渲染层重读即可，不会带旧字段。
 */
let settingsSink: ((patch: Record<string, unknown>) => void) | null = null;

let curX = 0;
let curY = 0;
let vx = 0;
let vy = 0;
let targetX = 0;
let targetY = 0;
let grabDX = 0;
let grabDY = 0;
let dragging = false;
let inertia = false;
let dragTimer: ReturnType<typeof setInterval> | null = null;
let inertiaTimer: ReturnType<typeof setInterval> | null = null;
/** 全局光标广播定时器（眼神全屏跟随用）。 */
let cursorTimer: ReturnType<typeof setInterval> | null = null;
/** 渲染层上报的可交互意愿（指针是否落在 drag/interactive 命中区） */
let wantInteractive = false;

// ===================== 工具 =====================

function workArea(): Electron.Rectangle {
  return screen.getPrimaryDisplay().workArea;
}

function readRuntime(): CharacterRuntimeSettings {
  const s = dm.getSettings();
  return (
    s.characterRuntime || {
      enabled: false,
      x: 0,
      y: 0,
      alwaysOnTop: true,
      passThroughLocked: false,
      activeId: '',
    }
  );
}

function patchRuntime(patch: Partial<CharacterRuntimeSettings>): CharacterRuntimeSettings {
  const next: CharacterRuntimeSettings = { ...readRuntime(), ...patch };
  dm.saveSettings({ characterRuntime: next });
  // 广播给所有窗口（设置页据此刷新开关，不会覆盖 x/y）
  settingsSink?.({ characterRuntime: next });
  return next;
}

function rectsOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 被悬浮球遮挡时做位移避让：优先放到球左侧，放不下再放球右侧，仍不行则放球上方/下方。 */
function avoidBall(x: number, y: number): { x: number; y: number } {
  const ball = getBallWindowBounds();
  if (!ball) return { x, y };
  const wa = workArea();
  const rect = { x, y, width: DC_WIN_W, height: DC_WIN_H };
  if (!rectsOverlap(rect, ball)) return { x, y };

  const tryX: number[] = [ball.x - DC_WIN_W - BALL_GAP, ball.x + ball.width + BALL_GAP];
  for (const nx of tryX) {
    if (nx >= wa.x && nx + DC_WIN_W <= wa.x + wa.width) return { x: nx, y };
  }
  const tryY: number[] = [ball.y - DC_WIN_H - BALL_GAP, ball.y + ball.height + BALL_GAP];
  for (const ny of tryY) {
    if (ny >= wa.y && ny + DC_WIN_H <= wa.y + wa.height) return { x, y: ny };
  }
  return { x, y };
}

/** 位置钳制：窗口整体留在工作区内（保证窗内气泡始终可见）。 */
function clampPos(x: number, y: number): { x: number; y: number } {
  const wa = workArea();
  return {
    x: Math.max(wa.x, Math.min(x, wa.x + wa.width - DC_WIN_W)),
    y: Math.max(wa.y, Math.min(y, wa.y + wa.height - DC_WIN_H)),
  };
}

function applyPos(x: number, y: number): void {
  curX = x;
  curY = y;
  if (dcWindow && !dcWindow.isDestroyed()) {
    dcWindow.setPosition(Math.round(x), Math.round(y));
  }
}

function stopDragLoop(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
}

function stopInertia(): void {
  if (inertiaTimer) {
    clearInterval(inertiaTimer);
    inertiaTimer = null;
  }
  inertia = false;
}

/** 全局光标广播：把屏幕光标换算成「相对角色窗左上角的 DIP 坐标」推给渲染层，
 *  让眼神在整个屏幕范围跟随光标（窗口默认整体穿透，窗内 mousemove 收不到屏外光标）。
 *  与拖拽弹簧共用 screen.getCursorScreenPoint()，其返回的 DIP 坐标已与窗口 getBounds 对齐。 */
function startCursorBroadcast(): void {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!dcWindow || dcWindow.isDestroyed() || !dcWindow.isVisible()) return;
    const b = dcWindow.getBounds();
    const p = screen.getCursorScreenPoint();
    dcWindow.webContents.send('dc:cursor', { x: p.x - b.x, y: p.y - b.y });
  }, CURSOR_TICK_MS);
}

function stopCursorBroadcast(): void {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

function persistPos(): void {
  patchRuntime({ x: Math.round(curX), y: Math.round(curY) });
}

/** 拖拽期间的弹簧积分：target = 设备光标 − 抓取偏移，显式 K/C + 1/120 子步。 */
function springTick(): void {
  const p = screen.getCursorScreenPoint();
  targetX = p.x - grabDX;
  targetY = p.y - grabDY;
  const dt = TICK_MS / 1000;
  const steps = Math.max(1, Math.round(dt / SUBSTEP));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const ax = SPRING_K * (targetX - curX) - SPRING_C * vx;
    const ay = SPRING_K * (targetY - curY) - SPRING_C * vy;
    vx += ax * h;
    vy += ay * h;
    curX += vx * h;
    curY += vy * h;
  }
  const c = clampPos(curX, curY);
  if (c.x !== curX) vx = 0;
  if (c.y !== curY) vy = 0;
  applyPos(c.x, c.y);
}

/** 松手惯性：按末速度指数衰减滑停，撞边清零对应方向速度。 */
function inertiaTick(): void {
  vx *= 0.9;
  vy *= 0.9;
  if (Math.hypot(vx, vy) < 24) {
    stopInertia();
    persistPos();
    return;
  }
  const nx = curX + vx * (TICK_MS / 1000);
  const ny = curY + vy * (TICK_MS / 1000);
  const c = clampPos(nx, ny);
  if (c.x !== nx) vx = 0;
  if (c.y !== ny) vy = 0;
  applyPos(c.x, c.y);
}

/** 当前激活角色（runtime.activeId 优先，否则首个 enabled）。 */
function activeCharacter(): DesktopCharacter | null {
  const s = dm.getSettings();
  const list = s.desktopCharacters || [];
  const rt = readRuntime();
  const byId = rt.activeId ? list.find((c) => c.id === rt.activeId) : undefined;
  if (byId) return byId;
  return list.find((c) => c.enabled) || list[0] || null;
}

function sendState(): void {
  if (!dcWindow || dcWindow.isDestroyed()) return;
  dcWindow.webContents.send('dc:state', {
    runtime: readRuntime(),
    character: activeCharacter(),
  });
}

// ===================== 窗口 =====================

export function setCharacterMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

/** 注入设置变更广播器（main.ts 的 broadcast），让运行时开关的改动能被各窗口感知 */
export function setCharacterSettingsSink(fn: (patch: Record<string, unknown>) => void): void {
  settingsSink = fn;
}

export function getDesktopCharacterWindow(): BrowserWindow | null {
  return dcWindow && !dcWindow.isDestroyed() ? dcWindow : null;
}

export function createDesktopCharacter(): void {
  if (dcWindow && !dcWindow.isDestroyed()) return;
  const rt = readRuntime();
  if (!rt.enabled) return;
  const wa = workArea();
  const hasPos = !!(rt.x || rt.y);
  let x = hasPos ? rt.x : wa.x + wa.width - DC_WIN_W - 24;
  let y = hasPos ? rt.y : wa.y + wa.height - DC_WIN_H - 24;
  const avoided = avoidBall(x, y);
  const clamped = clampPos(avoided.x, avoided.y);
  x = clamped.x;
  y = clamped.y;
  applyPos(x, y);

  const dev = process.env.NIANYU_DEV === '1';
  dcWindow = new BrowserWindow({
    width: DC_WIN_W,
    height: DC_WIN_H,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: rt.alwaysOnTop !== false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
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
  // 透明窗默认整体穿透；命中区由渲染层动态切回可交互。
  dcWindow.setIgnoreMouseEvents(true, { forward: true });
  // v3.0.1-beta.9：桌宠用 'pop-up-menu'（macOS 上低于悬浮球 'screen-saver'、高于小窗 'floating'）。
  // Windows 上 level 不参与 z_order，实际顺序由下方 ready-to-show 与悬浮球轮询里的
  // reassertFloatingBallOnTop()（moveTop）显式兜底，详见 windowLevels.ts。
  applyAlwaysOnTop(dcWindow, rt.alwaysOnTop !== false, DESKTOP_CHARACTER_LEVEL);

  if (dev) {
    dcWindow.loadURL('http://localhost:5173/character.html');
  } else {
    dcWindow.loadFile(path.join(__dirname, '../../dist/character.html'));
  }

  dcWindow.once('ready-to-show', () => {
    if (dcWindow && !dcWindow.isDestroyed()) dcWindow.showInactive();
    // 桌宠窗显示后立刻把悬浮球三窗提到同层 Z 序顶部（Windows 兜底）。
    reassertFloatingBallOnTop('dc-ready');
    sendState();
    startCursorBroadcast();
  });
  dcWindow.on('closed', () => {
    dcWindow = null;
  });
  // 窗口被系统移动（多显示器/DPI 变化）后重算位置并回存
  dcWindow.on('moved', () => {
    if (!dcWindow || dcWindow.isDestroyed()) return;
    if (dragging || inertia) return;
    const b = dcWindow.getBounds();
    const c = clampPos(b.x, b.y);
    if (c.x !== b.x || c.y !== b.y) dcWindow.setPosition(Math.round(c.x), Math.round(c.y));
    curX = c.x;
    curY = c.y;
  });
}

export function destroyDesktopCharacter(): void {
  stopDragLoop();
  stopInertia();
  stopCursorBroadcast();
  dragging = false;
  if (dcWindow && !dcWindow.isDestroyed()) dcWindow.destroy();
  dcWindow = null;
}

export function setDesktopCharacterEnabled(v: boolean): void {
  patchRuntime({ enabled: v });
  if (v) {
    createDesktopCharacter();
    // 之前用右键菜单「隐藏角色」只是 hide()，窗口还在；重新开启时必须显式 show，
    // 否则用户会以为开关失灵（窗口存在但不可见）。
    const w = getDesktopCharacterWindow();
    // v3.0.1-beta.9：重新启用 / 唤回后重申层级，避免窗口重建或 showInactive 后掉层。
    if (w) applyAlwaysOnTop(w, readRuntime().alwaysOnTop !== false, DESKTOP_CHARACTER_LEVEL);
    if (w && !w.isVisible()) w.showInactive();
    reassertFloatingBallOnTop('dc-enable');
    sendState();
  } else {
    destroyDesktopCharacter();
  }
}

export function setDesktopCharacterActive(id: string): void {
  patchRuntime({ activeId: id });
  sendState();
}

/**
 * 右键菜单「隐藏角色」：关闭**当前激活角色**的桌面显示（enabled=false），
 * 使「桌宠角色」面板里该角色的「显示」勾同步取消。
 *
 * 行为约定（与用户预期一致）：
 * - 仍有其它启用角色 → 切到下一个启用角色并继续显示窗口；
 * - 无剩余启用角色 → 清空 activeId 并隐藏窗口（主开关 runtime.enabled 不变，
 *   用户在面板重新勾选「显示」即可经由 refreshDesktopCharacter 唤回）。
 *
 * **本函数只动单角色的 enabled 与 activeId，绝不改主开关 runtime.enabled**
 * （那是「桌面显示」总开关，见 setDesktopCharacterEnabled）。
 */
export function hideActiveCharacter(): void {
  const s = dm.getSettings();
  const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
  const rt = readRuntime();
  const target = rt.activeId ? list.find((c) => c.id === rt.activeId) : activeCharacter();
  if (!target) {
    if (dcWindow && !dcWindow.isDestroyed()) dcWindow.hide();
    return;
  }
  const idx = list.findIndex((c) => c.id === target.id);
  if (idx < 0) {
    if (dcWindow && !dcWindow.isDestroyed()) dcWindow.hide();
    return;
  }
  const next = list.slice();
  next[idx] = { ...next[idx], enabled: false };
  const remaining = next.filter((c) => c.enabled);
  let activeId: string;
  let showWindow: boolean;
  if (remaining.length) {
    // 与 activeCharacter() 的回退一致：取首个启用角色，窗口继续显示。
    activeId = remaining[0].id;
    showWindow = true;
  } else {
    activeId = '';
    showWindow = false;
  }
  const nextRuntime: CharacterRuntimeSettings = { ...rt, activeId };
  dm.saveSettings({ desktopCharacters: next, characterRuntime: nextRuntime });
  // 广播给所有窗口（面板据此刷新「显示」勾，不会覆盖 x/y）
  settingsSink?.({ desktopCharacters: next, characterRuntime: nextRuntime });
  if (showWindow) {
    if (dcWindow && !dcWindow.isDestroyed()) {
      if (!dcWindow.isVisible()) dcWindow.showInactive();
    } else {
      createDesktopCharacter();
    }
  } else if (dcWindow && !dcWindow.isDestroyed()) {
    dcWindow.hide();
  }
  sendState();
}

/** 设置页/收藏面板改动了角色数据后，主进程据此刷新角色窗与状态。 */
export function refreshDesktopCharacter(): void {
  const rt = readRuntime();
  if (rt.enabled) {
    if (!dcWindow || dcWindow.isDestroyed()) createDesktopCharacter();
  } else if (dcWindow && !dcWindow.isDestroyed()) {
    destroyDesktopCharacter();
  }
  sendState();
}

/** 供主窗口「桌宠角色」面板读取的完整快照。 */
export function getDesktopCharacterSnapshot(): {
  runtime: CharacterRuntimeSettings;
  characters: DesktopCharacter[];
  active: DesktopCharacter | null;
} {
  const s = dm.getSettings();
  return {
    runtime: readRuntime(),
    characters: s.desktopCharacters || [],
    active: activeCharacter(),
  };
}

function openBoundChat(chat: { type: 'single' | 'group'; id: string; name?: string }): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  if (mainWindowRef.isMinimized()) mainWindowRef.restore();
  mainWindowRef.show();
  mainWindowRef.focus();
  mainWindowRef.webContents.send('dc:open-chat', chat);
}

// ===================== IPC =====================

export function registerDesktopCharacterIPC(): void {
  // 渲染层请求切换穿透态：穿透锁定期间恒穿透，忽略可交互请求（含拖拽）
  ipcMain.on('dc:set-ignore', (_e, ignore: boolean) => {
    const rt = readRuntime();
    if (!dcWindow || dcWindow.isDestroyed()) return;
    if (!ignore) wantInteractive = true;
    else wantInteractive = false;
    if (rt.passThroughLocked) {
      dcWindow.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    // 拖拽中永远保持可交互，结束再交还
    if (dragging) {
      dcWindow.setIgnoreMouseEvents(false);
      return;
    }
    dcWindow.setIgnoreMouseEvents(!!ignore, { forward: !!ignore });
  });

  // 拖拽开始：gdx/gdy = 设备光标 − 窗口原点（由渲染层按命中点换算后传入）
  ipcMain.on('dc:drag-start', (_e, gdx: number, gdy: number) => {
    if (!dcWindow || dcWindow.isDestroyed()) return;
    const rt = readRuntime();
    if (rt.passThroughLocked) return; // 锁定穿透时不可拖拽
    stopInertia();
    stopDragLoop();
    dragging = true;
    grabDX = Number(gdx) || 0;
    grabDY = Number(gdy) || 0;
    const b = dcWindow.getBounds();
    curX = b.x;
    curY = b.y;
    vx = 0;
    vy = 0;
    dcWindow.setIgnoreMouseEvents(false);
    dragTimer = setInterval(springTick, TICK_MS);
  });

  ipcMain.on('dc:drag-end', () => {
    if (!dragging) return;
    dragging = false;
    stopDragLoop();
    // 只在有实际速度时滑停；静止松手直接回存
    if (Math.hypot(vx, vy) >= 24) {
      inertia = true;
      stopInertia();
      inertiaTimer = setInterval(inertiaTick, TICK_MS);
    } else {
      vx = 0;
      vy = 0;
      persistPos();
    }
    if (dcWindow && !dcWindow.isDestroyed()) {
      const rt = readRuntime();
      if (rt.passThroughLocked) dcWindow.setIgnoreMouseEvents(true, { forward: true });
      else dcWindow.setIgnoreMouseEvents(!wantInteractive, { forward: !wantInteractive });
    }
    sendState();
  });

  ipcMain.on('dc:set-always-on-top', (_e, v: boolean) => {
    patchRuntime({ alwaysOnTop: !!v });
    if (dcWindow && !dcWindow.isDestroyed()) {
      applyAlwaysOnTop(dcWindow, !!v, DESKTOP_CHARACTER_LEVEL);
    }
    // 桌宠重新置顶后立刻把悬浮球提到同层 Z 序顶部（Windows 兜底）。
    if (v) reassertFloatingBallOnTop('dc-aot-on');
    sendState();
  });

  ipcMain.on('dc:set-pass-through-lock', (_e, v: boolean) => {
    patchRuntime({ passThroughLocked: !!v });
    if (dcWindow && !dcWindow.isDestroyed()) {
      dcWindow.setIgnoreMouseEvents(!!v ? true : !wantInteractive, { forward: !!v ? true : !wantInteractive });
    }
    sendState();
  });

  ipcMain.on('dc:set-enabled', (_e, v: boolean) => setDesktopCharacterEnabled(!!v));
  ipcMain.on('dc:set-active', (_e, id: string) => setDesktopCharacterActive(String(id || '')));
  // 右键菜单「隐藏角色」：关闭当前激活角色的桌面显示（enabled=false），让面板「显示」勾同步取消；主开关不动
  ipcMain.on('dc:hide-character', () => hideActiveCharacter());

  // 滚轮缩放：持久化该角色的 scale（钳制 0.6~1.6），并广播 settings:changed + dc:state
  // （角色窗据此即时刷新显示，设置页「桌宠角色」面板同步显示新大小）。
  ipcMain.on('dc:set-scale', (_e, id: string, scale: number) => {
    if (!id) return;
    const s = dm.getSettings();
    const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const clamped = Math.max(0.6, Math.min(1.6, Number(scale) || 1));
    const next = list.slice();
    next[idx] = { ...next[idx], scale: clamped };
    dm.saveSettings({ desktopCharacters: next });
    // 广播给所有窗口（设置页据此刷新滑块/数值，不会覆盖 x/y 等其它字段）
    settingsSink?.({ desktopCharacters: next });
    // 立即刷新角色窗显示
    sendState();
  });

  ipcMain.handle('dc:get-state', () => getDesktopCharacterSnapshot());

  ipcMain.on('dc:open-chat', (_e, chat: { type: 'single' | 'group'; id: string; name?: string }) => {
    if (chat && chat.id) openBoundChat(chat);
  });

  // 角色窗请求打开主界面的「桌宠角色」面板
  ipcMain.on('dc:open-collection', () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
    if (mainWindowRef.isMinimized()) mainWindowRef.restore();
    mainWindowRef.show();
    mainWindowRef.focus();
    mainWindowRef.webContents.send('dc:open-collection');
  });

  ipcMain.on('dc:show-window', () => {
    if (dcWindow && !dcWindow.isDestroyed()) {
      // v3.0.1-beta.9：从托盘唤回时重申层级，保证仍恒在悬浮球之下。
      applyAlwaysOnTop(dcWindow, readRuntime().alwaysOnTop !== false, DESKTOP_CHARACTER_LEVEL);
      dcWindow.showInactive();
      reassertFloatingBallOnTop('dc-show-window');
    } else createDesktopCharacter();
  });

  // 面板主动重定位（例如从收藏面板把角色拉回主屏）
  ipcMain.on('dc:reposition', (_e, x: number, y: number) => {
    if (!dcWindow || dcWindow.isDestroyed()) return;
    const c = clampPos(Number(x) || 0, Number(y) || 0);
    applyPos(c.x, c.y);
    persistPos();
  });
}
