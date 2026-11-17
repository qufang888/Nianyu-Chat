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
 *
 * 多窗口（v3.0.1-beta.13）：
 * - 旧版是**单窗口单例**（旧变量 dcWindow），只显示 `activeCharacter()` 那一个角色；
 * - 现改为**每个 enabled 角色各拥独立透明窗口**，可同时出现：窗口集合 `dcWindows: Map<id, BrowserWindow>`，
 *   每窗口挂 `(_w as any)._charId` 以便从 IPC `event.sender` 反查归属角色；
 * - 每角色独立位置（`DesktopCharacter.x?/y?`，按启用序号级联偏移避免完全重叠）、独立拖拽状态
 *   （`dragStates: Map<id, DragState>`，含弹簧/惯性/穿透意愿），单一全局 60Hz 定时器按 id 驱动所有正在
 *   拖拽/惯性的窗口；眼神光标广播与 `dc:state` 推送均按窗口遍历、各发各自角色；
 * - 「显示」勾（CharacterCollection）经 `settings:save` → `refreshDesktopCharacter()` 与窗口集合对齐：
 *   勾=建窗、空=关窗；右键「隐藏角色」只关本窗对应角色并置 `enabled:false`，其它窗口不受影响。
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
/** 多窗口级联偏移：第 n 个启用角色相对右下角默认位额外偏移 n*CASCADE_OFFSET，避免完全重叠。 */
const CASCADE_OFFSET = 28;
/** 拖拽看门狗（Bug 3）：dc:drag-start 起算，超过此时长仍 dragging 则强制结束，
 *  防 renderer 端 pointerup/cancel 丢失导致 st.dragging 恒 true、窗口永久跟随光标。 */
const DRAG_WATCHDOG_MS = 9000;
/** 看门狗检查周期（低频，独立于 60Hz 物理定时器）。 */
const DRAG_WATCHDOG_POLL_MS = 1000;
/**
 * 桌宠气泡的新消息推送：绑定对话里来了新消息时，实时弹到该角色头顶的气泡。
 *
 * 过滤规则（避免打扰与重复弹）：
 * - 只推 **AI 回复**（sender_type === 'ai'）与 **用户消息**（sender_type === 'user'）；
 *   system 消息（回滚/清空等系统提示）不弹。
 * - `from_proactive === true` 的消息**不推**：桌宠自己的主动消息链路已自行弹过气泡
 *   （CharacterApp 的 requestCharacterLine → showBubble），再推一次会重复弹两次。
 * - 空内容不推（纯图片消息 content 为空串，桌宠气泡是文字气泡，弹空白无意义）。
 * - `status === 'failed'` 的失败消息不推。
 */
const DC_BUBBLE_MAX_LEN = 120;

/** 把新消息推送给绑定了该会话的桌宠窗口。 */
export function pushChatMessageToCharacters(msg: {
  chat_type?: string;
  chat_id?: string;
  sender_type?: string;
  content?: string;
  status?: string;
  from_proactive?: boolean;
}): void {
  if (dcWindows.size === 0) return;
  const type = msg.chat_type;
  const id = msg.chat_id;
  if (!type || !id) return;
  if (msg.from_proactive === true) return;
  if (msg.status === 'failed') return;
  if (msg.sender_type !== 'ai' && msg.sender_type !== 'user') return;
  const raw = (msg.content || '').trim();
  if (!raw) return;
  const content = raw.length > DC_BUBBLE_MAX_LEN ? `${raw.slice(0, DC_BUBBLE_MAX_LEN)}…` : raw;
  for (const [cid, w] of dcWindows) {
    if (w.isDestroyed() || !w.isVisible()) continue;
    const c = findChar(cid);
    const bound = c?.boundChat;
    if (!bound || bound.type !== type || bound.id !== id) continue;
    w.webContents.send('dc:chat-message', { content, senderType: msg.sender_type });
  }
}

/** 每个角色窗口独立的拖拽/惯性/穿透意愿状态。 */
interface DragState {
  curX: number;
  curY: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  grabDX: number;
  grabDY: number;
  dragging: boolean;
  inertia: boolean;
  /** 本次拖拽起始时间戳（ms）；0=未在拖拽。看门狗据此强制收尾漏发的 drag-end。 */
  dragStartedAt: number;
  /** 看门狗心跳：上次采样到的光标屏幕坐标。光标仍在移动即视为活跃拖拽，不累计超时。 */
  watchdogCursorX: number;
  watchdogCursorY: number;
  /** 渲染层上报的可交互意愿（指针是否落在 drag/interactive 命中区） */
  wantInteractive: boolean;
}

/** 角色窗集合：key = 角色 id。多窗口同显的核心容器。 */
const dcWindows = new Map<string, BrowserWindow>();
/** 每角色独立的拖拽/惯性/穿透状态。 */
const dragStates = new Map<string, DragState>();
let mainWindowRef: BrowserWindow | null = null;
/**
 * 主窗唤出回调（由 main.ts 注入，内部走 showMainWindow()）。
 * 为什么需要：用户「关闭主界面」时 mainWindowRef 指向已销毁窗口（main.ts 的 closed 处理把
 * mainWindow 置 null），右键菜单的「绑定对话 / 打开角色舞台 / 管理角色」原本直接 return → 点了没反应。
 * 注入而非直接 import main.ts 可避免循环依赖（与 floatingBall 的 setBallMainShow 同模式）。
 */
let mainShowRef: (() => void) | null = null;
/**
 * 设置变更广播器（由 main.ts 注入）。
 * 为什么需要：运行时开关（启用/置顶/穿透锁定/当前角色）由主进程直接落盘，渲染层若只靠自己
 * `patch()` 落盘就会把设置页里的 **旧 x/y** 一起写回去，导致「在设置页开关一下，桌上角色瞬移回旧位置」。
 * 改成主进程唯一真源 + 广播 `settings:changed`，渲染层重读即可，不会带旧字段。
 */
let settingsSink: ((patch: Record<string, unknown>) => void) | null = null;

/** 全局光标广播定时器（眼神全屏跟随用）。 */
let cursorTimer: ReturnType<typeof setInterval> | null = null;
/** 单一全局拖拽/惯性定时器（60Hz，按 id 驱动所有正在拖拽/惯性的窗口）。 */
let dragTimer: ReturnType<typeof setInterval> | null = null;
/** 拖拽看门狗定时器（低频；超时强制收尾漏发的 drag-end）。 */
let dragWatchdogTimer: ReturnType<typeof setInterval> | null = null;

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

/** 角色可见区几何（与 src/styles/character.css 的 `.dc-character` 保持一致）：
 *  left:50% / bottom:10px / width:190 / height:228 / transform-origin:bottom center / scale(--dc-scale)。
 *  用于「按角色本体而非透明整窗」做位置钳制。 */
const CHAR_BODY_W = 190;
const CHAR_BODY_H = 228;
const CHAR_BODY_BOTTOM_GAP = 10;
const DC_SCALE_MIN = 0.6;
// v3.0.10：上限由 2.0 放宽到 5.0（用户要求最大 500% 且不糊），下限/步长不变
const DC_SCALE_MAX = 5.0;

/**
 * 位置钳制（Bug 2）：按「角色可见区」而非整窗矩形（340×420）钳制到工作区。
 * 旧实现把整窗锁在 workArea 内，而角色本体只在窗内底部中间（顶部约 wa.y+182、左缘约 wa.x+75），
 * 导致角色拖不到上半部、贴不到左边沿。现允许透明窗口部分越出 workArea，只要求角色本体整块落在
 * 工作区内；气泡（bottom:246px）是临时层，允许偶发出屏，优先满足用户「角色贴边」。
 * transform-origin:bottom center → 放大时角色更高/更宽，取该角色当前 scale（缺省 1，钳制到合法区间）
 * 算出保守可见矩形；scale 在每次钳制时现读，缩放后再次拖拽即时生效。
 */
function clampPos(x: number, y: number, id?: string): { x: number; y: number } {
  const wa = workArea();
  let scale = 1;
  if (id) {
    const s = dm.getSettings();
    const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
    const c = list.find((ch) => ch.id === id);
    if (c && typeof c.scale === 'number' && Number.isFinite(c.scale)) {
      scale = Math.max(DC_SCALE_MIN, Math.min(DC_SCALE_MAX, c.scale));
    }
  }
  const halfW = (CHAR_BODY_W * scale) / 2;
  const bodyH = CHAR_BODY_H * scale;
  const bodyBottom = DC_WIN_H - CHAR_BODY_BOTTOM_GAP; // 角色底缘相对窗口顶部的 y
  const centerX = DC_WIN_W / 2;
  // 角色可见矩形相对窗口左上角：left=centerX-halfW / right=centerX+halfW
  //                              top=bodyBottom-bodyH / bottom=bodyBottom
  // 令其落在 workArea 内 ⇒ 反解出窗口原点的合法区间（透明部分可越界）。
  const minX = wa.x - (centerX - halfW);
  const maxX = wa.x + wa.width - (centerX + halfW);
  const minY = wa.y - (bodyBottom - bodyH);
  const maxY = wa.y + wa.height - bodyBottom;
  return {
    x: Math.max(minX, Math.min(x, maxX)),
    y: Math.max(minY, Math.min(y, maxY)),
  };
}

/** 取（或惰性创建）某角色的拖拽状态。 */
function getDragState(id: string): DragState {
  let st = dragStates.get(id);
  if (!st) {
    st = {
      curX: 0,
      curY: 0,
      vx: 0,
      vy: 0,
      targetX: 0,
      targetY: 0,
      grabDX: 0,
      grabDY: 0,
      dragging: false,
      inertia: false,
      dragStartedAt: 0,
      watchdogCursorX: 0,
      watchdogCursorY: 0,
      wantInteractive: false,
    };
    dragStates.set(id, st);
  }
  return st;
}

/** 从 IPC 事件源反查归属角色 id（窗口对象上挂了 `(_w as any)._charId`）。 */
function winToId(sender: unknown): string | undefined {
  if (!sender) return undefined;
  const w = BrowserWindow.fromWebContents(sender as Electron.WebContents);
  if (!w || w.isDestroyed()) return undefined;
  const id = (w as unknown as { _charId?: string })._charId;
  return typeof id === 'string' ? id : undefined;
}

/** 按 id 定位某角色窗口（设置位置 / 切穿透等）。 */
function applyPos(id: string, x: number, y: number): void {
  const st = dragStates.get(id);
  if (st) {
    st.curX = x;
    st.curY = y;
  }
  const w = dcWindows.get(id);
  if (w && !w.isDestroyed()) {
    w.setPosition(Math.round(x), Math.round(y));
  }
}

/** 停止单一全局拖拽/惯性定时器。 */
function stopDragLoop(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
}

/** 确保单一全局拖拽/惯性定时器在跑（无则启动）。 */
function ensureDragTimer(): void {
  if (dragTimer) return;
  dragTimer = setInterval(dragTick, TICK_MS);
}

/** 停止全局光标广播定时器。 */
function stopCursorBroadcast(): void {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

/** 全局光标广播：把屏幕光标换算成「相对角色窗左上角的 DIP 坐标」推给渲染层，
 *  让眼神在整个屏幕范围跟随光标（窗口默认整体穿透，窗内 mousemove 收不到屏外光标）。
 *  与拖拽弹簧共用 screen.getCursorScreenPoint()，其返回的 DIP 坐标已与窗口 getBounds 对齐。 */
function startCursorBroadcast(): void {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (dcWindows.size === 0) return;
    const p = screen.getCursorScreenPoint();
    for (const [, w] of dcWindows) {
      if (w.isDestroyed() || !w.isVisible()) continue;
      const b = w.getBounds();
      w.webContents.send('dc:cursor', { x: p.x - b.x, y: p.y - b.y });
    }
  }, CURSOR_TICK_MS);
}

/** 持久化某角色窗口位置到其 `DesktopCharacter.x/y`（走 dm.saveSettings + settingsSink，不污染 runtime.x/y）。 */
function persistPos(id: string): void {
  const st = dragStates.get(id);
  if (!st) return;
  const s = dm.getSettings();
  const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const next = list.slice();
  next[idx] = { ...next[idx], x: Math.round(st.curX), y: Math.round(st.curY) };
  dm.saveSettings({ desktopCharacters: next });
  // 广播给所有窗口（面板据此刷新位置，不会覆盖其它字段）
  settingsSink?.({ desktopCharacters: next });
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

/** 按 id 查找角色（找不到返回 null）。 */
function findChar(id?: string): DesktopCharacter | null {
  if (!id) return null;
  const s = dm.getSettings();
  const list = s.desktopCharacters || [];
  return list.find((c) => c.id === id) || null;
}

/** 推送状态给角色窗：传 id 只发给该窗口 `{runtime, character: 该角色}`；
 *  不传则遍历所有窗口，各发各自角色（面板仍走无参 dcGetState，不受影响）。 */
function sendState(id?: string): void {
  if (id !== undefined) {
    const w = dcWindows.get(id);
    if (w && !w.isDestroyed()) {
      w.webContents.send('dc:state', { runtime: readRuntime(), character: findChar(id) });
    }
    return;
  }
  for (const [cid, w] of dcWindows) {
    if (w.isDestroyed()) continue;
    w.webContents.send('dc:state', { runtime: readRuntime(), character: findChar(cid) });
  }
}

// ===================== 窗口 =====================

export function setCharacterMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

/**
 * 注入「唤出（必要时重建）主窗」回调。main.ts 的回调在 showMainWindow() 之后会再次调用
 * setCharacterMainWindow(mainWindow)，确保 createWindow() 产生的新窗口同步回本模块引用。
 */
export function setCharacterMainShow(fn: () => void): void {
  mainShowRef = fn;
}

/** 注入设置变更广播器（main.ts 的 broadcast），让运行时开关的改动能被各窗口感知 */
export function setCharacterSettingsSink(fn: (patch: Record<string, unknown>) => void): void {
  settingsSink = fn;
}

/** 供 main 窗口 Z 序 probe 用：返回任一存在的角色窗或 null（保持函数名与存在性）。 */
export function getDesktopCharacterWindow(): BrowserWindow | null {
  for (const [, w] of dcWindows) {
    if (w && !w.isDestroyed()) return w;
  }
  return null;
}

/** 为指定角色创建独立桌面窗口（多窗口核心）。无参/空 id 直接跳过。 */
export function createDesktopCharacter(id: string): void {
  if (!id) return;
  const s = dm.getSettings();
  const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
  const c = list.find((ch) => ch.id === id);
  if (!c || !c.enabled) return;
  // 已存在且未销毁 → 仅确保可见（多窗口下不再「隐藏窗口 showInactive」模式）
  const existing = dcWindows.get(id);
  if (existing) {
    if (!existing.isDestroyed()) {
      if (!existing.isVisible()) existing.showInactive();
    } else {
      dcWindows.delete(id);
    }
    return;
  }

  const rt = readRuntime();
  const wa = workArea();
  // 级联偏移：第 n 个启用角色额外偏移，避免多个窗口完全重叠
  const enabledList = list.filter((ch) => ch.enabled);
  const cascade = Math.max(0, enabledList.findIndex((ch) => ch.id === id)) * CASCADE_OFFSET;
  const baseX = c.x ?? rt.x;
  const baseY = c.y ?? rt.y;
  const defX = wa.x + wa.width - DC_WIN_W - 24;
  const defY = wa.y + wa.height - DC_WIN_H - 24;
  let x = baseX || defX;
  let y = baseY || defY;
  x += cascade;
  y += cascade;
  const avoided = avoidBall(x, y);
  const clamped = clampPos(avoided.x, avoided.y, id);
  x = clamped.x;
  y = clamped.y;

  const dev = process.env.NIANYU_DEV === '1';
  const win = new BrowserWindow({
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
  // 在窗口对象上挂角色 id，便于 IPC 处理器用 event.sender 反查归属角色
  (win as unknown as { _charId: string })._charId = id;
  dcWindows.set(id, win);

  // 初始化该窗口的拖拽原点（与创建坐标一致）
  const st = getDragState(id);
  st.curX = x;
  st.curY = y;
  st.vx = 0;
  st.vy = 0;

  // 透明窗默认整体穿透；命中区由渲染层动态切回可交互。
  win.setIgnoreMouseEvents(true, { forward: true });
  // v3.0.1-beta.9：桌宠用 'pop-up-menu'（macOS 上低于悬浮球 'screen-saver'、高于小窗 'floating'）。
  // Windows 上 level 不参与 z_order，实际顺序由下方 ready-to-show 与悬浮球轮询里的
  // reassertFloatingBallOnTop()（moveTop）显式兜底，详见 windowLevels.ts。
  applyAlwaysOnTop(win, rt.alwaysOnTop !== false, DESKTOP_CHARACTER_LEVEL);

  if (dev) {
    win.loadURL(`http://localhost:5173/character.html?id=${encodeURIComponent(id)}`);
  } else {
    win.loadFile(path.join(__dirname, '../../dist/character.html'), {
      search: `?id=${encodeURIComponent(id)}`,
    });
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    // 桌宠窗显示后立刻把悬浮球三窗提到同层 Z 序顶部（Windows 兜底）。
    reassertFloatingBallOnTop('dc-ready');
    sendState(id);
    startCursorBroadcast();
  });
  win.on('closed', () => {
    dcWindows.delete(id);
    dragStates.delete(id);
    if (dcWindows.size === 0) {
      stopDragLoop();
      stopCursorBroadcast();
    }
  });
  // 窗口被系统移动（多显示器/DPI 变化）后重算位置并回存
  win.on('moved', () => {
    const stt = dragStates.get(id);
    if (!stt) return;
    if (stt.dragging || stt.inertia) return;
    const b = win.getBounds();
    const c = clampPos(b.x, b.y, id);
    if (c.x !== b.x || c.y !== b.y) win.setPosition(Math.round(c.x), Math.round(c.y));
    stt.curX = c.x;
    stt.curY = c.y;
  });
}

/** 关闭指定角色窗口；不传 id 则关闭全部（主开关 off 用）。 */
export function destroyDesktopCharacter(id?: string): void {
  if (id) {
    const w = dcWindows.get(id);
    if (w && !w.isDestroyed()) w.destroy();
    dcWindows.delete(id);
    dragStates.delete(id);
    if (dcWindows.size === 0) {
      stopDragLoop();
      stopCursorBroadcast();
    }
    return;
  }
  for (const [, w] of dcWindows) {
    if (!w.isDestroyed()) w.destroy();
  }
  dcWindows.clear();
  dragStates.clear();
  stopDragLoop();
  stopCursorBroadcast();
}

/** 为所有 enabled 角色创建窗口（已存在则跳过）。 */
export function showAllDesktopCharacters(): void {
  const s = dm.getSettings();
  const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
  for (const c of list.filter((ch) => ch.enabled)) {
    const w = dcWindows.get(c.id);
    if (!w || w.isDestroyed()) createDesktopCharacter(c.id);
  }
}

/** 主开关 / 设置变更后的刷新：使窗口集合与 `enabled` 状态对齐。 */
export function refreshDesktopCharacter(): void {
  const rt = readRuntime();
  const s = dm.getSettings();
  const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
  if (rt.enabled) {
    // 为每个 enabled 角色补窗（已存在/已销毁则重建）
    for (const c of list.filter((ch) => ch.enabled)) {
      const w = dcWindows.get(c.id);
      if (!w || w.isDestroyed()) createDesktopCharacter(c.id);
    }
    // 关掉不再 enabled / 已被删除角色的窗口
    for (const [id, w] of dcWindows) {
      const stillEnabled = list.some((ch) => ch.id === id && ch.enabled);
      if (!stillEnabled) {
        if (!w.isDestroyed()) w.destroy();
        dcWindows.delete(id);
        dragStates.delete(id);
      }
    }
    if (dcWindows.size === 0) stopCursorBroadcast();
  } else {
    destroyDesktopCharacter();
  }
  sendState();
}

export function setDesktopCharacterEnabled(v: boolean): void {
  patchRuntime({ enabled: v });
  if (v) {
    showAllDesktopCharacters();
    // 之前用右键菜单「隐藏角色」只是 hide()，窗口还在；重新开启时必须显式 show，
    // 否则用户会以为开关失灵（窗口存在但不可见）。
    for (const [, w] of dcWindows) {
      if (!w.isDestroyed() && !w.isVisible()) w.showInactive();
    }
    // v3.0.1-beta.9：重新启用 / 唤回后重申层级，避免窗口重建或 showInactive 后掉层。
    reassertFloatingBallOnTop('dc-enable');
    sendState();
  } else {
    destroyDesktopCharacter();
  }
}

export function setDesktopCharacterActive(id: string): void {
  patchRuntime({ activeId: id });
  const w = id ? dcWindows.get(id) : undefined;
  if (w && !w.isDestroyed()) {
    if (!w.isVisible()) w.showInactive();
    w.focus();
  }
  sendState();
}

/**
 * 右键菜单「隐藏角色」：关闭**当前这个窗口对应角色**的桌面显示（enabled=false），
 * 使「桌宠角色」面板里该角色的「显示」勾同步取消；其它角色窗口不受影响。
 *
 * 行为约定（与用户预期一致）：
 * - 只关一个窗口、只改这一个角色的 enabled，绝不关全部、绝不改主开关 runtime.enabled；
 * - 主开关 runtime.enabled（「桌面显示」总开关）由 setDesktopCharacterEnabled 负责，本函数不碰。
 */
export function hideActiveCharacter(sender?: unknown): void {
  const s = dm.getSettings();
  const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
  const id =
    (sender !== undefined ? winToId(sender) : undefined) ||
    readRuntime().activeId ||
    activeCharacter()?.id;
  if (!id) {
    // 兜底：无任何可解析角色时，关掉任意一个已开窗口
    const anyId = dcWindows.keys().next().value;
    if (anyId) destroyDesktopCharacter(anyId);
    return;
  }
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) {
    destroyDesktopCharacter(id);
    return;
  }
  // 只把这一角色的 enabled 置 false（面板「显示」勾同步取消），不碰 runtime.enabled / activeId
  const next = list.slice();
  next[idx] = { ...next[idx], enabled: false };
  dm.saveSettings({ desktopCharacters: next });
  // 广播给所有窗口（面板据此刷新「显示」勾，不会覆盖 x/y）
  settingsSink?.({ desktopCharacters: next });
  // 只销毁本窗对应角色的窗口，不动其它窗口
  destroyDesktopCharacter(id);
  sendState();
}

/** 供主窗口「桌宠角色」面板读取的完整快照。面板调用（无 id）返回 active 用于高亮；
 *  角色窗调用（带 id）额外返回 character 用于自身渲染。 */
export function getDesktopCharacterSnapshot(id?: string): {
  runtime: CharacterRuntimeSettings;
  characters: DesktopCharacter[];
  active: DesktopCharacter | null;
  character?: DesktopCharacter | null;
} {
  const s = dm.getSettings();
  const list = s.desktopCharacters || [];
  const active = id ? list.find((c) => c.id === id) || null : activeCharacter();
  const character = id ? list.find((c) => c.id === id) || null : null;
  return {
    runtime: readRuntime(),
    characters: list,
    active,
    character,
  };
}

// ===================== 拖拽物理（按 id 处理）=====================

/** 拖拽期间的弹簧积分：target = 设备光标 − 抓取偏移，显式 K/C + 1/120 子步。 */
function springStep(id: string, st: DragState): void {
  const p = screen.getCursorScreenPoint();
  st.targetX = p.x - st.grabDX;
  st.targetY = p.y - st.grabDY;
  const dt = TICK_MS / 1000;
  const steps = Math.max(1, Math.round(dt / SUBSTEP));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const ax = SPRING_K * (st.targetX - st.curX) - SPRING_C * st.vx;
    const ay = SPRING_K * (st.targetY - st.curY) - SPRING_C * st.vy;
    st.vx += ax * h;
    st.vy += ay * h;
    st.curX += st.vx * h;
    st.curY += st.vy * h;
  }
  const c = clampPos(st.curX, st.curY, id);
  if (c.x !== st.curX) st.vx = 0;
  if (c.y !== st.curY) st.vy = 0;
  applyPos(id, c.x, c.y);
}

/** 松手惯性：按末速度指数衰减滑停，撞边清零对应方向速度。 */
function inertiaStep(id: string, st: DragState): void {
  st.vx *= 0.9;
  st.vy *= 0.9;
  if (Math.hypot(st.vx, st.vy) < 24) {
    st.inertia = false;
    persistPos(id);
    return;
  }
  const nx = st.curX + st.vx * (TICK_MS / 1000);
  const ny = st.curY + st.vy * (TICK_MS / 1000);
  const c = clampPos(nx, ny, id);
  if (c.x !== nx) st.vx = 0;
  if (c.y !== ny) st.vy = 0;
  applyPos(id, c.x, c.y);
}

/** 单一全局定时器：遍历所有正在 dragging/inertia 的窗口，按 id 分别做弹簧/惯性积分。 */
function dragTick(): void {
  let active = false;
  for (const [id, st] of dragStates) {
    if (st.dragging) {
      springStep(id, st);
      active = true;
    } else if (st.inertia) {
      inertiaStep(id, st);
      active = true;
    }
  }
  if (!active) stopDragLoop();
}

/**
 * 结束某角色的拖拽（Bug 3）：idempotent —— 非 dragging 态直接返回。
 * dc:drag-end 与看门狗超时共用同一收尾路径，保证「必定且仅一次」落盘与穿透复位。
 */
function endDragState(id: string): void {
  const st = dragStates.get(id);
  if (!st || !st.dragging) return;
  st.dragging = false;
  st.dragStartedAt = 0;
  st.watchdogCursorX = 0;
  st.watchdogCursorY = 0;
  // 只在有实际速度时滑停；静止松手直接回存
  ensureDragTimer();
  if (Math.hypot(st.vx, st.vy) >= 24) {
    st.inertia = true;
  } else {
    st.vx = 0;
    st.vy = 0;
    persistPos(id);
  }
  const w = dcWindows.get(id);
  if (w && !w.isDestroyed()) {
    const rt = readRuntime();
    if (rt.passThroughLocked) w.setIgnoreMouseEvents(true, { forward: true });
    else w.setIgnoreMouseEvents(!st.wantInteractive, { forward: !st.wantInteractive });
  }
  sendState(id);
}

/** 停止拖拽看门狗定时器。 */
function stopDragWatchdog(): void {
  if (dragWatchdogTimer) {
    clearInterval(dragWatchdogTimer);
    dragWatchdogTimer = null;
  }
}

/**
 * 确保看门狗在跑（dc:drag-start 时启动）：仅当「光标静止」且迟迟未收到 drag-end 才强制收尾。
 *
 * 心跳语义：每次轮询采样 screen.getCursorScreenPoint()，只要光标相对上次采样发生了位移，
 * 就说明用户仍在进行一次真实的长按拖拽，刷新 dragStartedAt 起算点。这样正常长按 ≥9s 不会被误伤；
 * 而 pointerup 丢失后光标停住不动时，看门狗仍能在静止满 DRAG_WATCHDOG_MS 后兜底。
 *
 * 注意：绝不可在 springStep 里刷新 dragStartedAt —— 那样只要窗口还在跟随，看门狗就永不触发，
 * Bug 3（松手仍拖动）的兜底会彻底失效。心跳只认物理光标位移，不认窗口位置。
 */
function ensureDragWatchdog(): void {
  if (dragWatchdogTimer) return;
  dragWatchdogTimer = setInterval(() => {
    const now = Date.now();
    let any = false;
    for (const [id, st] of dragStates) {
      if (!st.dragging) continue;
      any = true;
      const p = screen.getCursorScreenPoint();
      if (p.x !== st.watchdogCursorX || p.y !== st.watchdogCursorY) {
        // 光标仍在移动：活跃拖拽，刷新采样与超时起算点
        st.watchdogCursorX = p.x;
        st.watchdogCursorY = p.y;
        st.dragStartedAt = now;
        continue;
      }
      if (st.dragStartedAt > 0 && now - st.dragStartedAt >= DRAG_WATCHDOG_MS) {
        endDragState(id);
      }
    }
    if (!any) stopDragWatchdog();
  }, DRAG_WATCHDOG_POLL_MS);
}

/**
 * 桌宠右键导航的统一投递：主窗还在就 restore/show/focus；主窗已销毁则先走注入的
 * showMainWindow() 重建（回调会刷新 mainWindowRef），等新 renderer 加载完成再补发 IPC。
 *
 * 为什么必须等 did-finish-load：重建出来的 BrowserWindow 是新 webContents，React 的
 * onDcOpenCollection / onDcOpenStage / onDcOpenChat 订阅在组件 mount 后才存在；若在
 * createWindow() 刚返回就 send，IPC 会落在空文档上被永久丢弃（表现为「按钮仍然没反应」）。
 * 已存在的窗口不等待，保持原来的即时响应手感。
 */
function withMainWindow(deliver: (win: BrowserWindow) => void): void {
  const existing = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  let win: BrowserWindow | null = existing;
  if (!win) {
    if (!mainShowRef) return;
    mainShowRef();
    win = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  }
  if (!win) return;
  const target = win;
  const send = (): void => {
    if (target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    try {
      deliver(target);
    } catch (e) {
      // 极端竞态（窗口在 send 瞬间被关）下静默跳过，避免 uncaughtException 弹窗
      console.warn('[nianyu] dc main ipc skip:', (e as Error)?.message);
    }
  };
  if (!existing && target.webContents.isLoadingMainFrame()) {
    target.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function openBoundChat(chat: { type: 'single' | 'group'; id: string; name?: string }): void {
  if (!chat?.id) return;
  withMainWindow((win) => win.webContents.send('dc:open-chat', chat));
}

// ===================== IPC =====================

export function registerDesktopCharacterIPC(): void {
  // 渲染层请求切换穿透态：穿透锁定期间恒穿透，忽略可交互请求（含拖拽）
  ipcMain.on('dc:set-ignore', (e, ignore: boolean) => {
    const id = winToId(e.sender);
    if (!id) return;
    const rt = readRuntime();
    const st = getDragState(id);
    st.wantInteractive = !ignore;
    if (rt.passThroughLocked) {
      const w = dcWindows.get(id);
      if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    // 拖拽中永远保持可交互，结束再交还（用局部变量匹配「dragging 分支先于 ignore 判定」契约）
    const dragging = st.dragging;
    if (dragging) {
      const w = dcWindows.get(id);
      if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(false);
      return;
    }
    const w = dcWindows.get(id);
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!!ignore, { forward: !!ignore });
  });

  // 拖拽开始：gdx/gdy = 设备光标 − 窗口原点（由渲染层按命中点换算后传入）
  ipcMain.on('dc:drag-start', (e, gdx: number, gdy: number) => {
    const id = winToId(e.sender);
    if (!id) return;
    const rt = readRuntime();
    if (rt.passThroughLocked) return; // 锁定穿透时不可拖拽
    const w = dcWindows.get(id);
    if (!w || w.isDestroyed()) return;
    const st = getDragState(id);
    st.dragging = true;
    st.inertia = false;
    st.dragStartedAt = Date.now(); // 看门狗起算点（Bug 3）
    const cur = screen.getCursorScreenPoint();
    st.watchdogCursorX = cur.x; // 心跳基线：以拖拽起点的物理光标位置为准
    st.watchdogCursorY = cur.y;
    st.grabDX = Number(gdx) || 0;
    st.grabDY = Number(gdy) || 0;
    const b = w.getBounds();
    st.curX = b.x;
    st.curY = b.y;
    st.vx = 0;
    st.vy = 0;
    w.setIgnoreMouseEvents(false);
    ensureDragTimer();
    ensureDragWatchdog();
  });

  ipcMain.on('dc:drag-end', (e) => {
    const id = winToId(e.sender);
    if (!id) return;
    // 与看门狗共用幂等收尾（内部 if(!st.dragging) return 保证仅一次）
    endDragState(id);
  });

  ipcMain.on('dc:set-always-on-top', (e, v: boolean) => {
    patchRuntime({ alwaysOnTop: !!v });
    const id = winToId(e.sender);
    const w = id ? dcWindows.get(id) : undefined;
    // 置顶是全局运行时设置；仅对触发菜单的该窗口立即 apply（其余窗口创建时已按此值）
    if (w && !w.isDestroyed()) applyAlwaysOnTop(w, !!v, DESKTOP_CHARACTER_LEVEL);
    // 桌宠重新置顶后立刻把悬浮球提到同层 Z 序顶部（Windows 兜底）。
    if (v) reassertFloatingBallOnTop('dc-aot-on');
    sendState();
  });

  ipcMain.on('dc:set-pass-through-lock', (_e, v: boolean) => {
    patchRuntime({ passThroughLocked: !!v });
    const want = !!v;
    // 穿透锁定是全局设置：所有窗口立即统一切到穿透（或回退到各自穿透意愿）
    for (const [cid, w] of dcWindows) {
      if (w.isDestroyed()) continue;
      if (want) {
        w.setIgnoreMouseEvents(true, { forward: true });
      } else {
        const cw = !getDragState(cid).wantInteractive;
        w.setIgnoreMouseEvents(cw, { forward: cw });
      }
    }
    sendState();
  });

  ipcMain.on('dc:set-enabled', (_e, v: boolean) => setDesktopCharacterEnabled(!!v));
  ipcMain.on('dc:set-active', (_e, id: string) => setDesktopCharacterActive(String(id || '')));
  // 右键菜单「隐藏角色」：关闭本窗对应角色的桌面显示（enabled=false），面板「显示」勾同步取消；主开关不动
  ipcMain.on('dc:hide-character', (e) => hideActiveCharacter(e.sender));

  // 滚轮缩放：持久化该角色的 scale（钳制 0.6~5.0），并广播 settings:changed + dc:state
  // （角色窗据此即时刷新显示，设置页「桌宠角色」面板同步显示新大小）。
  ipcMain.on('dc:set-scale', (_e, id: string, scale: number) => {
    if (!id) return;
    const s = dm.getSettings();
    const list = Array.isArray(s.desktopCharacters) ? s.desktopCharacters : [];
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const clamped = Math.max(0.6, Math.min(DC_SCALE_MAX, Number(scale) || 1));
    const next = list.slice();
    next[idx] = { ...next[idx], scale: clamped };
    dm.saveSettings({ desktopCharacters: next });
    // 广播给所有窗口（设置页据此刷新滑块/数值，不会覆盖 x/y 等其它字段）
    settingsSink?.({ desktopCharacters: next });
    // 立即刷新角色窗显示
    sendState();
  });

  // v3.0.3 预览通道：舞台拖动缩放滑块时的**实时预览**。
  //
  // 为什么需要独立通道（对比只发 dc:set-scale）：
  //   - dc:set-scale 会落盘 + 广播 settings:changed ⇒ 拖一次就是 N 次写盘 + N 次广播，
  //     既拖不动（主线程被 IO 拖慢），又违反「同一轮操作内只广播 1 次」；
  //   - 预览通道**只改角色窗本地的 --dc-scale**，不落盘、不广播 ⇒ 拖动全程跟手且零 IO。
  //
  // 提交（落盘）仍走既有的 dc:set-scale，由舞台在手势结束时发起一次。
  ipcMain.on('dc:set-scale-live', (_e, id: string, scale: number) => {
    if (!id) return;
    const w = dcWindows.get(id);
    if (!w || w.isDestroyed()) return;
    const clamped = Math.max(0.6, Math.min(DC_SCALE_MAX, Number(scale) || 1));
    w.webContents.send('dc:scale-preview', { id, scale: clamped });
  });

  ipcMain.handle('dc:get-state', (_e, id?: string) => getDesktopCharacterSnapshot(id));

  ipcMain.on('dc:open-chat', (_e, chat: { type: 'single' | 'group'; id: string; name?: string }) => {
    if (chat && chat.id) openBoundChat(chat);
  });

  // 角色窗请求打开主界面的「桌宠角色」面板（右键「管理角色」/ 未绑定时的「绑定对话」）
  ipcMain.on('dc:open-collection', () => {
    withMainWindow((win) => win.webContents.send('dc:open-collection'));
  });

  // Bug 1「打开角色舞台」：唤起主窗并带上角色 id，让「桌宠角色」面板自动打开该角色的 CharacterStage。
  // 无既有跨窗舞台机制（stageChar 原是面板本地 state），故新增此通道而不再只 dcOpenCollection。
  ipcMain.on('dc:open-stage', (_e, id: string) => {
    withMainWindow((win) => win.webContents.send('dc:open-stage', String(id || '')));
  });

  ipcMain.on('dc:show-window', () => {
    // 从托盘/全屏唤回：为每个 enabled 角色建窗（已存在则跳过），并补窗隐藏中的窗口
    showAllDesktopCharacters();
    for (const [, w] of dcWindows) {
      if (!w.isDestroyed() && !w.isVisible()) w.showInactive();
    }
    reassertFloatingBallOnTop('dc-show-window');
  });

  // 面板主动重定位（例如从收藏面板把角色拉回主屏）
  ipcMain.on('dc:reposition', (e, x: number, y: number) => {
    const id = winToId(e.sender);
    if (!id) return;
    const c = clampPos(Number(x) || 0, Number(y) || 0, id);
    applyPos(id, c.x, c.y);
    persistPos(id);
  });
}
