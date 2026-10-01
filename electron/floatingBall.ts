import { BrowserWindow, screen, ipcMain, app } from 'electron';
import path from 'node:path';
import { getDataManager } from './db';

// ===================== 桌面悬浮球（三窗口架构）=====================
// 球窗 + 面板窗 + 菜单窗三个独立 BrowserWindow：
// - 球窗 68x68 恒定：创建后除拖拽外永不改变 bounds —— 球在屏幕上绝对静止，
//   根治单窗方案（v2.3.52/53）中「窗口随面板方向移动 + switching 瞬隐」造成的可见闪烁。
// - 面板窗 320x460 独立定位、独立动画：展开 = 按方向公式 setBounds + showInactive；
//   收起 = 渲染端播 linear 收回动画（160ms）后窗口 hide。隐藏窗口完全不参与鼠标
//   命中（无 hit-test），收起后面板区域零干扰，比单窗收缩方案更彻底。
// - 菜单窗 180x140 独立渲染球右键应用菜单：与面板异侧（calcMenuRect 保证不重叠）、
//   弹出/缩入 linear 0.16s 动画，光标轮询超时/点击/全屏隐藏多来源关闭。
// 交互区域：两窗均 setIgnoreMouseEvents(true,{forward:true})，透明像素穿透到下层窗口，
// 仅球体/面板/菜单（不透明）由各自渲染端动态切回可交互，无死区、无遮挡。
// hover 协调：主进程权威状态机（hoverBall/hoverPanel + 160ms 防抖收起），渲染端
// mouseenter/mouseleave 上报 + 主进程 200ms 光标轮询双路径融合，展开/收起全部经
// 同一入口（setHoverBall/setHoverPanel）防重复触发。

const dm = getDataManager();

// ===== 几何常量（渲染端 src/floating-ball.ts 同步维护）=====
const BALL_WIN = 68; // 球窗边长：球 DOM 60x60 内边距 4，未读角标溢出 4px 恰好仍在窗内
const BALL_PAD = 4; // 球 DOM 相对球窗左上角的偏移
const BALL_SIZE = 60; // 球径
const PANEL_W = 320; // 面板窗宽
const PANEL_H = 460; // 面板窗高
const MENU_W = 180; // 菜单窗宽（球右键应用菜单，独立窗口渲染）
const MENU_H = 140; // 菜单窗高
const MENU_GAP = 8; // 菜单窗与球窗/面板窗之间的间距
// 面板 DOM 相对面板窗内边距 14（down/right: left/top；left: right；up: bottom），见渲染端 PANEL_PAD。
// 面板窗相对球窗的偏移（方向不变期间恒定）：
//   right/down → (+62, +62)：面板 DOM 左/顶缘 = 球缘(BALL_PAD+BALL_SIZE=64) + 12 = 76，窗原点 = 76 - 14 = 62
//   left       → (-304, *)：窗右缘 = 球左缘(4) + 12 = 16，窗原点 = 16 - 320 = -304
//   up         → (*, -454)：面板 DOM 底缘 = 窗底缘 - 14 = 球顶缘(4) - 12，窗原点 = -8 + 14 - 460 = -454
function panelOffsetX(h: 'right' | 'left'): number {
  return h === 'right' ? 62 : -304;
}
function panelOffsetY(v: 'down' | 'up'): number {
  return v === 'down' ? 62 : -454;
}

const DRAG_CLAMP = 72; // 球窗拖拽钳制：球缘 = BALL_PAD + BALL_SIZE = 64，钳制以球缘距屏幕边 8px 为准
const COLLAPSE_DEBOUNCE_MS = 160; // hover 全部离开后的收起防抖（覆盖球→面板跨窗 IPC 延迟）
const HIDE_ANIM_MS = 180; // panel:hide 后等渲染端 160ms linear 收回动画播完再 hide 窗口的余量
const REFHIP_PHASE_MS = 200; // 拖动中换向第一阶段（收回动画）与第二阶段（换向重弹）的间隔
const CURSOR_POLL_MS = 200; // 光标轮询间隔（动态光标残留兜底 + hover 电平兜底）
const MENU_OFF_TICKS = 2; // 菜单自动关闭：光标连续在菜单/球/面板窗外的采样次数（200ms × 2 = 400ms）
// 拖拽 mouseup 丢失自愈阈值：球被钳制贴屏边而光标继续移出球窗时，窗外 mouseup 穿透丢失，
// 渲染端 onUp 永不触发，球将持续吸附光标。正常拖拽中窗口每 16ms 贴合光标（光标恒在球窗内），
// 贴边钳制时光标出窗深度仅 ≤8px 且沿边滑动仍在窗内垂直范围，故「连续 30 tick（≈480ms）
// 光标都在球窗矩形外」只可能是 mouseup 已丢失，据此强制收尾。
const DRAG_LOST_TICKS = 30;

// 拖拽状态：主进程轮询系统光标直接定位窗口，窗口始终贴合光标，杜绝滞后与粘滞
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
let dragMaxDisp = 0;
let dragLostTicks = 0; // 光标连续在球窗矩形外的 tick 数（mouseup 丢失自愈计数）

let ballWindow: BrowserWindow | null = null;
let panelWindow: BrowserWindow | null = null;
let menuWindow: BrowserWindow | null = null; // 球右键应用菜单窗（180x140，独立于面板窗）
let sessionClosed = false; // 本次运行用户手动关闭悬浮球（不持久化，重启恢复）
let mainShowFn: (() => void) | null = null; // 由 main.ts 注入：唤出主窗口
let mainWinRef: BrowserWindow | null = null; // 由 main.ts 注入：主窗口引用（用于跳转会话）
let activeChatKey = ''; // 由渲染端回传：用户当前正在查看的聊天 `${type}:${id}`（主窗）
let activeChatKeyMini = ''; // 同上，但来自迷你窗；主窗/迷你窗各自独立记录，互不覆盖

// 悬浮球（球窗）当前屏幕逻辑坐标 = 球窗左上角（68x68 恒定，球屏幕位置 = ballX+4, ballY+4）。
// 由本模块权威维护，拖拽增量累加，避免渲染端反查坐标。
let ballX = 0;
let ballY = 0;

// ===== 面板窗可见性与方向 =====
let panelVisible = false; // 面板窗当前是否可见（展开态）
let panelDir: 'right' | 'left' = 'right'; // 当前水平弹出方向
let panelVDir: 'down' | 'up' = 'down'; // 当前垂直弹出方向
let flipping = false; // 拖动中换向进行中（收回 → 换向重弹两阶段），期间禁止重复触发
let reflipTimer: ReturnType<typeof setTimeout> | null = null; // 换向第二阶段（重弹）定时器

// ===== 菜单窗可见性状态 =====
let menuVisible = false; // 菜单窗当前是否可见
let menuHidePending = false; // menu:hide 已推送、等渲染端播完 160ms 缩入动画（防重入）
let menuOffTicks = 0; // 光标连续在菜单/球/面板窗外的采样计数（菜单自动关闭判定）

// ===== hover 协调状态机（主进程权威）=====
let hoverBall = false; // 光标悬停球窗（DOM mouseenter/leave 上报 + 轮询融合）
let hoverPanel = false; // 光标悬停面板窗
let collapseTimer: ReturnType<typeof setTimeout> | null = null; // 收起防抖定时器
let collapseTimer2: ReturnType<typeof setTimeout> | null = null; // panel:hide 后等动画播完再 hide 窗口

function cancelCollapseTimer(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
}

// 撤销进行中的收起（P1-B）：清两级收起定时器；若收回动画已在播（collapseTimer2 未触发、
// panel:hide 已推送且窗口仍可见）则重发 panel:show 重播弹出动画，避免面板在光标下消失。
function undoCollapse(): void {
  cancelCollapseTimer();
  if (collapseTimer2) {
    clearTimeout(collapseTimer2);
    collapseTimer2 = null;
    if (panelVisible && panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send('panel:show', { h: panelDir, v: panelVDir });
    }
  }
}

// 展开/重弹面板的唯一入口（panelVisible 守卫防重复触发）。
// 已可见时：若收回动画进行中（collapseTimer2 未触发，panel:hide 已推送）则撤销隐藏
// 并重播弹出动画；否则零动作。
function expandPanel(): void {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  if (!ballWindow || ballWindow.isDestroyed()) return;
  // 菜单打开时面板不可见 → 菜单按默认「右」落位，面板随后同侧展开会盖住菜单：
  // 先走缩入动画收起菜单，再展开面板。
  if (menuVisible) requestMenuHide();
  if (panelVisible) {
    undoCollapse(); // 收回动画进行中：撤销隐藏并重播弹出动画
    return;
  }
  const d = calcPanelDir();
  panelDir = d.h;
  panelVDir = d.v;
  panelWindow.setBounds({
    x: Math.round(ballX + panelOffsetX(panelDir)),
    y: Math.round(ballY + panelOffsetY(panelVDir)),
    width: PANEL_W,
    height: PANEL_H,
  });
  panelWindow.showInactive(); // 不抢焦点（focusable:false 双保险）
  panelVisible = true;
  panelWindow.webContents.send('panel:show', { h: panelDir, v: panelVDir });
}

// 收起执行：推送 panel:hide（渲染端播 160ms linear 收回动画），HIDE_ANIM_MS 后隐藏窗口。
// 拖拽期间禁止收起决策（P0-1）：拖拽中面板必须跟随球窗，collapse 被误触发会让面板塌缩。
function doCollapse(): void {
  if (dragTimer) return;
  // 面板收起时菜单不应残留：菜单显示中则一并走缩入动画关闭
  if (menuVisible) requestMenuHide();
  if (!panelVisible) return;
  if (!panelWindow || panelWindow.isDestroyed()) {
    panelVisible = false;
    return;
  }
  panelWindow.webContents.send('panel:hide');
  if (collapseTimer2) clearTimeout(collapseTimer2);
  collapseTimer2 = setTimeout(() => {
    collapseTimer2 = null;
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
    panelVisible = false;
    hoverPanel = false;
  }, HIDE_ANIM_MS);
}

// ===== 菜单窗（球右键应用菜单）=====
// 标准矩形相交测试：A/B 在 x 轴或 y 轴任一维投影分离即不相交
function rectsOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

// 计算菜单窗放置位置（候选序列取第一个「完整在 workArea 内 且 与面板窗矩形不相交」者）：
//   面板可见：水平反侧（面板右弹→菜单在球左 / 左弹→球右）→ 垂直反侧（面板下弹→球上 / 上弹→球下）→ 兜底
//   面板不可见：右 → 左 → 下 → 上 → 兜底
//   兜底：球下方贴工作区底缘（x 钳制在 workArea 内，双侧均不可行的极小屏幕仍保证菜单可见）
// 数学保证：面板 h=right 时菜单 left 候选 x ∈ [ballX-184, ballX-4] 与面板窗 x ≥ ballX+62 在 x 轴分离；
// 垂直反侧候选 y 与面板窗 y 同理分离 —— 每个反侧候选至少一轴与面板窗分离。
function calcMenuRect(): Electron.Rectangle {
  const wa = screen.getPrimaryDisplay().workArea;
  const panelRect =
    panelVisible && panelWindow && !panelWindow.isDestroyed() ? panelWindow.getBounds() : null;
  const cands: { x: number; y: number }[] = [];
  if (panelRect) {
    // 1. 水平反侧：与面板窗水平异侧（球体右缘 = ballX+64，左缘 = ballX+4）
    if (panelDir === 'right') cands.push({ x: ballX + BALL_PAD - MENU_GAP - MENU_W, y: ballY });
    else cands.push({ x: ballX + BALL_WIN + MENU_GAP, y: ballY });
    // 2. 垂直反侧：与面板窗垂直异侧
    if (panelVDir === 'down') cands.push({ x: ballX - 4, y: ballY - MENU_GAP - MENU_H });
    else cands.push({ x: ballX - 4, y: ballY + BALL_WIN + MENU_GAP });
  } else {
    // 3. 面板不可见默认序：右 → 左 → 下 → 上
    cands.push(
      { x: ballX + BALL_WIN + MENU_GAP, y: ballY },
      { x: ballX + BALL_PAD - MENU_GAP - MENU_W, y: ballY },
      { x: ballX - 4, y: ballY + BALL_WIN + MENU_GAP },
      { x: ballX - 4, y: ballY - MENU_GAP - MENU_H },
    );
  }
  // 4. 兜底：球下方贴工作区底缘
  cands.push({
    x: Math.max(wa.x + 4, Math.min(ballX - 4, wa.x + wa.width - MENU_W - 4)),
    y: wa.y + wa.height - MENU_H - 8,
  });
  let fallback: Electron.Rectangle | null = null;
  for (const c of cands) {
    const rect: Electron.Rectangle = {
      x: Math.round(c.x),
      y: Math.round(c.y),
      width: MENU_W,
      height: MENU_H,
    };
    fallback = rect; // 循环结束后保持为最后一个候选（兜底位置）
    const inWa =
      rect.x >= wa.x + 4 &&
      rect.y >= wa.y + 4 &&
      rect.x + rect.width <= wa.x + wa.width - 4 &&
      rect.y + rect.height <= wa.y + wa.height - 4;
    if (inWa && (!panelRect || !rectsOverlap(rect, panelRect))) return rect;
  }
  // 所有候选均不可行（极小屏幕）：返回兜底候选（保持可预期位置）
  return fallback as Electron.Rectangle;
}

// 关闭菜单（带动画链路入口）：推送 menu:hide，渲染端播 160ms linear 缩入后回发
// menu:hide-done，主进程再 hide 窗口。menuHidePending 防重入：动画期间重复推送只会播一次。
function requestMenuHide(): void {
  if (!menuVisible || menuHidePending) return;
  if (!menuWindow || menuWindow.isDestroyed()) {
    menuVisible = false;
    return;
  }
  menuHidePending = true;
  menuWindow.webContents.send('menu:hide');
}

// hover 全部离开后的收起防抖；期间任一 hover 回归（undoCollapse）即取消。
// 拖拽期间禁止收起决策（P0-1）：拖拽中光标可能贴边越出球窗被误判 hover 离开。
function scheduleCollapse(): void {
  if (dragTimer) return;
  if (hoverBall || hoverPanel) return;
  if (collapseTimer) return;
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (hoverBall || hoverPanel) return;
    doCollapse();
  }, COLLAPSE_DEBOUNCE_MS);
}

// hover 状态统一入口（球窗）。
// expandOnly=true（渲染端 .fb-ball DOM mouseenter，真实「进入球体」事件）才允许触发展开；
// 主进程轮询 / blur 等电平维护路径（expandOnly=false）不触发展开——否则「点击球唤出主窗
// 后光标仍停留在球窗内」会被轮询误判为新的展开边沿，面板在主窗上方回弹。
function setHoverBall(v: boolean, expandOnly: boolean): void {
  if (v) {
    const edge = !hoverBall;
    hoverBall = true;
    cancelCollapseTimer();
    if (edge && expandOnly) expandPanel();
  } else {
    hoverBall = false;
    scheduleCollapse();
  }
}

// hover 状态统一入口（面板窗）。hoverPanel 只参与收起判定（取消防抖/阻止收起），永不触发展开。
// 回归面板时撤销进行中的收起（P1-B）：collapseTimer2 存续期（收回动画播放中）移入面板，
// 若只清 collapseTimer 不撤 collapseTimer2，面板会在光标下消失。
function setHoverPanel(v: boolean): void {
  if (v) {
    hoverPanel = true;
    undoCollapse();
  } else {
    hoverPanel = false;
    scheduleCollapse();
  }
}

// ===== 面板弹出方向（四向边界检测）=====
// 按球心在屏幕的左右/上下半区取默认方向；默认方向展开会超出工作区且对侧可行时翻转到
// 对侧；双侧均不可行（屏幕极小）保持默认方向兜底（球本体始终可见）。
function calcPanelDir(): { h: 'right' | 'left'; v: 'down' | 'up' } {
  const wa = screen.getPrimaryDisplay().workArea;
  // 球中心 = (ballX + BALL_PAD + 30, ballY + BALL_PAD + 30) = (ballX+34, ballY+34)
  let h: 'right' | 'left' = ballX + BALL_PAD + BALL_SIZE / 2 <= wa.x + wa.width / 2 ? 'right' : 'left';
  let v: 'down' | 'up' = ballY + BALL_PAD + BALL_SIZE / 2 <= wa.y + wa.height / 2 ? 'down' : 'up';
  const rightOk = ballX + panelOffsetX('right') + PANEL_W <= wa.x + wa.width; // 右弹：面板窗右缘不越出工作区
  const leftOk = ballX + panelOffsetX('left') >= wa.x; // 左弹：面板窗左缘不越出工作区
  const downOk = ballY + panelOffsetY('down') + PANEL_H <= wa.y + wa.height; // 下弹：面板窗下缘不越出工作区
  const upOk = ballY + panelOffsetY('up') >= wa.y; // 上弹：面板窗上缘不越出工作区
  if (h === 'right' && !rightOk && leftOk) h = 'left';
  else if (h === 'left' && !leftOk && rightOk) h = 'right';
  if (v === 'down' && !downOk && upOk) v = 'up';
  else if (v === 'up' && !upOk && downOk) v = 'down';
  return { h, v };
}

// ===== 光标轮询（双重职责）=====
// 1) 动态光标残留兜底（v2.3.36 起）：穿透窗 forward 模式下鼠标直接移出窗口边界时渲染端
//    收不到任何 mouseleave，主进程轮询检测离开瞬间推送 ball:cursor-window=false。
// 2) hover 电平兜底：轮询结果与渲染端 mouseenter/leave 上报融合（同一入口 setHoverBall/
//    setHoverPanel），覆盖「跨窗间隙内 DOM 事件时序抖动」导致的漏报。
let cursorPollTimer: ReturnType<typeof setInterval> | null = null;
let lastCursorInside = true; // 初始视为在窗内，避免启动瞬间多发一次 false
function pointInRect(px: number, py: number, b: Electron.Rectangle): boolean {
  return px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height;
}
function startCursorPoll(): void {
  if (cursorPollTimer) clearInterval(cursorPollTimer);
  cursorPollTimer = setInterval(() => {
    if (!ballWindow || ballWindow.isDestroyed() || !ballWindow.isVisible()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const inBall = pointInRect(p.x, p.y, ballWindow.getBounds());
      // 菜单窗相关判定（menuVisible 时有效）
      const inMenu =
        menuVisible &&
        !!menuWindow &&
        !menuWindow.isDestroyed() &&
        pointInRect(p.x, p.y, menuWindow.getBounds());
      // 拖拽活动期间跳过球窗离窗推送与 hover 降级（P0-1）：贴边钳制时光标可能越出球窗矩形，
      // 此刻推送 cursor-window=false 会让渲染端 setInteractive(false)→ignore(true)，
      // 窗外 mouseup 穿透丢失；拖拽期间球窗可交互恒由 drag-start 设置，轮询不干预。
      if (!dragTimer) {
        if (inMenu) {
          // 光标悬停菜单窗：跳过 hover 降级（防止右键菜单显示期间光标在菜单上导致面板被误收）
          menuOffTicks = 0;
        } else {
          setHoverBall(inBall, false); // 轮询只维护电平，不触发展开
          if (inBall !== lastCursorInside) {
            lastCursorInside = inBall;
            ballWindow.webContents.send('ball:cursor-window', inBall);
          }
        }
      }
      if (!inMenu && panelVisible && panelWindow && !panelWindow.isDestroyed()) {
        setHoverPanel(pointInRect(p.x, p.y, panelWindow.getBounds()));
      }
      // 菜单自动关闭：光标不在菜单窗、球窗、面板窗（panelVisible 时）任一矩形内，
      // 连续 MENU_OFF_TICKS 次采样（200ms × 2 = 400ms）→ 推 menu:hide 走缩入动画。
      // 右键瞬间光标在球窗内（菜单在反侧），判定含球窗矩形不会立即误关；光标移向菜单
      // 穿过球窗与菜单窗之间的空隙时，400ms 双采样大概率错过，即使误关重新右键即可（可接受取舍）。
      if (menuVisible && !menuHidePending && menuWindow && !menuWindow.isDestroyed()) {
        const inPanel =
          panelVisible &&
          !!panelWindow &&
          !panelWindow.isDestroyed() &&
          pointInRect(p.x, p.y, panelWindow.getBounds());
        if (inMenu || inBall || inPanel) {
          menuOffTicks = 0;
        } else if (++menuOffTicks >= MENU_OFF_TICKS) {
          menuOffTicks = 0;
          requestMenuHide();
        }
      }
    } catch {
      /* 轮询失败静默跳过，下一轮重试 */
    }
  }, CURSOR_POLL_MS);
}

export function setBallMainShow(fn: () => void): void {
  mainShowFn = fn;
}
export function setBallMainWindow(win: BrowserWindow | null): void {
  mainWinRef = win;
}

// 渲染端切换当前聊天时回传，用于判断「主动消息」是否应计入未读。
// fromMini=true 表示来自迷你窗（与主窗分别记录，避免两者互相覆盖导致迷你窗当前聊天丢失已读判定）。
export function setActiveChat(type: string, id: string, fromMini = false): void {
  if (fromMini) activeChatKeyMini = `${type}:${id}`;
  else activeChatKey = `${type}:${id}`;
  // 用户打开某会话即视为已读：清除该会话在悬浮球清单中的未读，避免「已读残留」。
  // 同模块内可直接调用 clearUnreadForChat（仅在该会话确有未读时才会触发广播，无未读则为空操作）。
  clearUnreadForChat(type, id);
}

// 迷你窗关闭时清空其前台聊天标记，避免残留导致「已关闭的迷你窗仍在看的聊天」被误判为已读
export function clearMiniActiveChat(): void {
  activeChatKeyMini = '';
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

function sendToBoth(channel: string, payload?: unknown): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.webContents.send(channel, payload);
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send(channel, payload);
}

function broadcastUnread(): void {
  // 双窗统一推送：球窗渲染角标，面板窗忽略即可
  sendToBoth('ball:unread', { count: getUnreadCount(), items: getUnreadList() });
}

// 新增一条未读。fromProactive=true 表示这是角色「主动消息」回复（用户并未发消息请求）：
// 此类回复只要用户没正盯着该聊天本身，就计入未读（窗口隐藏 / 在看别的聊天都算）；
// 手动回复（fromProactive=false）维持原行为：仅主窗隐藏/最小化时才计未读。
// 生视频轮巡进度：仅用于悬浮球显示，不改变悬浮球任何交互逻辑。
// percent 0~100 表示进度；percent < 0 表示生成结束（完成/失败），球恢复常态图标。
export function sendBallVideoProgress(percent: number, statusText?: string): void {
  // 双窗统一推送：球窗渲染进度环，面板窗忽略即可
  sendToBoth('ball:videoProgress', {
    percent: Math.max(-1, Math.min(100, Math.round(percent))),
    statusText: statusText || '',
  });
}

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
  // 类 IM 未读：仅当用户此刻正盯着该聊天本身（主窗可见且为当前会话，或迷你窗正显示该会话）时视为已读；
  // 其余情况（主窗隐藏 / 在看别的聊天 / 手动回复 / 主动消息）均计入未读，悬浮球面板即可看到未读消息。
  const viewingThis =
    (mainVisible && activeChatKey === `${chatType}:${chatId}`) ||
    activeChatKeyMini === `${chatType}:${chatId}`;
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

// ===== 持久化（位置 + 开关，含坐标语义版本）=====
// coordVer：floatingBall.x/y 的坐标语义版本。
//   1（旧，v2.3.53 及以前）：x/y = 旧单窗左上角 = 球左缘 - 18（旧窗内球偏移 18）
//   2（新，双窗架构）：      x/y = 68x68 球窗左上角 = 球左缘 - 4（新窗内球偏移 4）
// 读取时 coordVer<2 则一次性转换 x+14 / y+14（18 - 4 = 14）并立即回存，此后不再转换。
function persistBallPos(alwaysOnTopOverride?: boolean): void {
  const s = dm.getSettings();
  dm.saveSettings({
    floatingBall: {
      enabled: s.floatingBall?.enabled !== false,
      x: Math.round(ballX),
      y: Math.round(ballY),
      alwaysOnTop: alwaysOnTopOverride ?? s.floatingBall?.alwaysOnTop !== false,
      autoHideInFullscreen: s.floatingBall?.autoHideInFullscreen !== false,
      coordVer: 2,
    },
  });
}

// ===== 悬浮球窗口创建（球窗 + 面板窗）=====
export function createFloatingBall(): void {
  if ((ballWindow && !ballWindow.isDestroyed()) || (panelWindow && !panelWindow.isDestroyed())) return;
  if (sessionClosed) return; // 本次运行已手动关闭，重启前不再创建
  const settings = dm.getSettings();
  if (settings.floatingBall?.enabled === false) return; // 设置中关闭则不创建
  const aot = settings.floatingBall?.alwaysOnTop !== false; // 默认置顶

  const saved = settings.floatingBall || { enabled: true, x: 0, y: 0 };
  // ===== 位置语义迁移（一次性，见 persistBallPos 注释）=====
  let x = saved.x || 0;
  let y = saved.y || 0;
  const needMigrate = (!!x || !!y) && (saved.coordVer || 1) < 2;
  if (needMigrate) {
    x += 14;
    y += 14;
  }
  const primary = screen.getPrimaryDisplay().workArea;
  if (!x && !y) {
    // 默认位置：主屏右下角（留 24px 边距）
    x = primary.x + primary.width - BALL_WIN - 24;
    y = primary.y + primary.height - BALL_WIN - 24;
  }
  // 钳制到可视工作区，避免初始位置跑到屏幕外（与拖拽钳制一致：球缘距边 8px）
  x = Math.max(primary.x + 4, Math.min(x, primary.x + primary.width - DRAG_CLAMP));
  y = Math.max(primary.y + 4, Math.min(y, primary.y + primary.height - DRAG_CLAMP));
  ballX = x;
  ballY = y;
  if (needMigrate) persistBallPos(aot); // 迁移立即回存（coordVer=2），此后不再转换

  const webPrefs = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    autoplayPolicy: 'no-user-gesture-required' as const,
  };
  const dev = process.env.NIANYU_DEV === '1';

  // ----- 球窗：68x68 恒定，除拖拽外永不改变 bounds -----
  ballWindow = new BrowserWindow({
    width: BALL_WIN,
    height: BALL_WIN,
    x: Math.round(x),
    y: Math.round(y),
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
    webPreferences: webPrefs,
  });
  // 透明窗默认整体穿透鼠标，仅不透明区域（球/角标）由渲染端动态切回可交互
  ballWindow.setIgnoreMouseEvents(true, { forward: true });
  // 置顶分层（v2.3.37）：悬浮球用 'screen-saver'（最高层），恒高于小窗的 'floating' 层——
  // 期望顺序：悬浮球 > 小窗 > 其他软件窗口（构造参数不支持 level，创建后显式设置）
  ballWindow.setAlwaysOnTop(aot, 'screen-saver');

  // ----- 面板窗：320x460，独立定位/独立动画，不抢焦点 -----
  panelWindow = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    x: Math.round(x + panelOffsetX('right')),
    y: Math.round(y + panelOffsetY('down')),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: aot,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    focusable: false, // 面板不抢焦点：点击面板不会夺走主窗/小窗焦点
    show: false,
    webPreferences: webPrefs,
  });
  panelWindow.setIgnoreMouseEvents(true, { forward: true });
  panelWindow.setAlwaysOnTop(aot, 'screen-saver');

  // ----- 菜单窗：180x140，球右键应用菜单（退出/本次关闭/置顶），独立于面板窗 -----
  // focusable:false 不抢焦点；创建顺序在球/面板之后 → 同 'screen-saver' 层内后显示者居上，
  // showInactive 时菜单恒盖在面板之上。初始整体穿透，菜单 DOM 悬停由渲染端经 menu:ignore 切回。
  menuWindow = new BrowserWindow({
    width: MENU_W,
    height: MENU_H,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: aot,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    focusable: false, // 不抢焦点（checkbox 鼠标交互不受影响）
    show: false,
    webPreferences: webPrefs,
  });
  menuWindow.setIgnoreMouseEvents(true, { forward: true });
  menuWindow.setAlwaysOnTop(aot, 'screen-saver');

  startCursorPoll(); // 光标轮询（动态光标残留兜底 + hover 电平兜底）

  // 三窗加载同一 floating-ball.html，query 区分 role（ball / panel / menu）
  if (dev) {
    ballWindow.loadURL(`${'http://localhost:5173'}/floating-ball.html?role=ball`);
    panelWindow.loadURL(`${'http://localhost:5173'}/floating-ball.html?role=panel`);
    menuWindow.loadURL(`${'http://localhost:5173'}/floating-ball.html?role=menu`);
  } else {
    ballWindow.loadFile(path.join(__dirname, '../../dist/floating-ball.html'), { search: 'role=ball' });
    panelWindow.loadFile(path.join(__dirname, '../../dist/floating-ball.html'), { search: 'role=panel' });
    menuWindow.loadFile(path.join(__dirname, '../../dist/floating-ball.html'), { search: 'role=menu' });
  }

  ballWindow.once('ready-to-show', () => {
    if (ballWindow && !ballWindow.isDestroyed()) ballWindow.showInactive(); // 不抢焦点
    broadcastUnread(); // 首屏推送当前未读
  });
  // 面板窗保持隐藏，首次 hover 展开时才 showInactive

  ballWindow.on('closed', () => {
    ballWindow = null;
  });
  panelWindow.on('closed', () => {
    panelWindow = null;
  });
  menuWindow.on('closed', () => {
    menuWindow = null;
  });

  // 失焦：主进程收 hover 并走防抖收起；渲染端各自收起菜单/门控动态光标
  ballWindow.on('blur', () => {
    setHoverBall(false, false);
    if (ballWindow && !ballWindow.isDestroyed()) ballWindow.webContents.send('ball:blur');
  });
  panelWindow.on('blur', () => {
    setHoverPanel(false);
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('ball:blur');
  });
}

export function destroyFloatingBall(): void {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
    lastCursorInside = true; // 重建窗口后重新从「在窗内」状态起步
  }
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (collapseTimer2) {
    clearTimeout(collapseTimer2);
    collapseTimer2 = null;
  }
  if (reflipTimer) {
    clearTimeout(reflipTimer);
    reflipTimer = null;
  }
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  flipping = false;
  panelVisible = false;
  hoverBall = false;
  hoverPanel = false;
  panelDir = 'right'; // 方向状态一并复位，重建窗口后从默认方向起步
  panelVDir = 'down';
  menuVisible = false; // 菜单窗状态复位
  menuHidePending = false;
  menuOffTicks = 0;
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.destroy();
  ballWindow = null;
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.destroy();
  panelWindow = null;
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuWindow = null;
}

// 会话级关闭标记 setter（P1-C）：设置中显式重新启用悬浮球时清除「本次关闭」标记，
// 使 createFloatingBall 不再被 sessionClosed 守卫拦截（showFloatingBall 的守卫保留不变）。
export function setBallSessionClosed(v: boolean): void {
  sessionClosed = v;
}

// 切换悬浮球置顶并持久化（三窗同步）
export function setBallAlwaysOnTop(v: boolean): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.setAlwaysOnTop(v, 'screen-saver'); // 最高层，恒高于小窗 'floating'（v2.3.37）
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.setAlwaysOnTop(v, 'screen-saver');
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.setAlwaysOnTop(v, 'screen-saver');
  persistBallPos(v);
}

// 主窗口全屏时隐藏、退出全屏时恢复（由 main.ts 监听主窗口 fullscreen 事件调用；三窗联动）
export function hideFloatingBall(): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.hide();
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
  // 菜单若显示中一并隐藏（无动画直接 hide）；恢复时不主动弹菜单
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide();
  menuVisible = false;
  menuHidePending = false;
  menuOffTicks = 0;
}
export function showFloatingBall(): void {
  const s = dm.getSettings();
  if (s.floatingBall?.enabled === false) return;
  if (sessionClosed) return;
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.showInactive();
  if (panelVisible && panelWindow && !panelWindow.isDestroyed()) panelWindow.showInactive();
  // 菜单不随恢复重新弹出（menuVisible 已在 hideFloatingBall 复位为 false）
}

// ===== 悬浮球相关 IPC =====
export function registerBallIPC(): void {
  // 拖拽开始：渲染端传入指针在球窗内的抓取偏移（gx,gy），主进程轮询系统光标直接定位窗口。
  // 球窗恒 68x68（球 DOM 在 (4,4)），gx/gy ∈ [4,64] 直接使用，无方向换算。
  ipcMain.on('ball:drag-start', (_e, gx: number, gy: number) => {
    if (!ballWindow || ballWindow.isDestroyed()) return;
    // 拖拽期间整窗可交互，确保持续接收鼠标事件（窗口始终贴合光标，指针不会移出边界）
    ballWindow.setIgnoreMouseEvents(false);
    dragOffsetX = gx;
    dragOffsetY = gy;
    dragStartX = ballX;
    dragStartY = ballY;
    dragMaxDisp = 0;
    dragLostTicks = 0;
    if (dragTimer) clearInterval(dragTimer);
    const primary = screen.getPrimaryDisplay().workArea;
    dragTimer = setInterval(() => {
      if (!ballWindow || ballWindow.isDestroyed()) return;
      const cur = screen.getCursorScreenPoint();
      // ===== mouseup 丢失自愈（P0-1）=====
      // 正常拖拽中窗口每 tick 贴合光标，光标恒在球窗矩形内；贴边钳制时光标出窗深度
      // 仅 ≤8px 且沿边滑动仍在窗内垂直范围。连续 DRAG_LOST_TICKS 个 tick 光标都在
      // 球窗外 → 判定窗外 mouseup 已穿透丢失（球将永久吸附光标），强制收尾并通知渲染端复位。
      if (pointInRect(cur.x, cur.y, ballWindow.getBounds())) {
        dragLostTicks = 0;
      } else if (++dragLostTicks > DRAG_LOST_TICKS) {
        dragLostTicks = 0;
        finishDrag();
        if (ballWindow && !ballWindow.isDestroyed()) {
          ballWindow.webContents.send('ball:drag-force-end');
        }
        return;
      }
      let nx = cur.x - dragOffsetX;
      let ny = cur.y - dragOffsetY;
      nx = Math.max(primary.x + 4, Math.min(nx, primary.x + primary.width - DRAG_CLAMP));
      ny = Math.max(primary.y + 4, Math.min(ny, primary.y + primary.height - DRAG_CLAMP));
      ballX = nx;
      ballY = ny;
      ballWindow.setPosition(Math.round(nx), Math.round(ny));
      // 面板窗跟随：面板窗相对球窗的偏移由当前方向决定（方向不变期间恒定）
      if (panelVisible && panelWindow && !panelWindow.isDestroyed()) {
        panelWindow.setPosition(
          Math.round(nx + panelOffsetX(panelDir)),
          Math.round(ny + panelOffsetY(panelVDir))
        );
      }
      dragMaxDisp = Math.max(dragMaxDisp, Math.abs(nx - dragStartX) + Math.abs(ny - dragStartY));
      // ===== 拖动中面板出界检测（两阶段换向）=====
      // 面板窗越出工作区且需换向时：第一阶段推送 panel:hide（渲染端 linear 收回），
      // 200ms 后（收回动画播完）按新方向重设面板窗 bounds 并推送 panel:layout 重弹。
      // 球窗全程不动 —— 换向期间球纹丝不动，这正是双窗架构的意义。
      if (panelVisible && !flipping && panelWindow && !panelWindow.isDestroyed()) {
        try {
          const waNow = screen.getPrimaryDisplay().workArea;
          const px = ballX + panelOffsetX(panelDir);
          const py = ballY + panelOffsetY(panelVDir);
          const out =
            px < waNow.x ||
            py < waNow.y ||
            px + PANEL_W > waNow.x + waNow.width ||
            py + PANEL_H > waNow.y + waNow.height;
          if (out) {
            const want = calcPanelDir();
            if (want.h !== panelDir || want.v !== panelVDir) {
              flipping = true;
              panelWindow.webContents.send('panel:hide'); // 第一阶段：linear 收回
              if (reflipTimer) clearTimeout(reflipTimer);
              reflipTimer = setTimeout(() => {
                reflipTimer = null;
                panelDir = want.h;
                panelVDir = want.v;
                if (panelWindow && !panelWindow.isDestroyed()) {
                  panelWindow.setBounds({
                    x: Math.round(ballX + panelOffsetX(panelDir)),
                    y: Math.round(ballY + panelOffsetY(panelVDir)),
                    width: PANEL_W,
                    height: PANEL_H,
                  });
                  panelWindow.webContents.send('panel:layout', { h: panelDir, v: panelVDir }); // 第二阶段：重弹
                }
                flipping = false;
              }, REFHIP_PHASE_MS);
            }
            // 出界但方向未变（双侧均不可行的极小屏幕兜底）：零动作，绝不重复触发
          }
        } catch {
          /* 出界检测失败静默跳过，下一轮 tick 重试 */
        }
      }
    }, 16);
  });

  // 拖拽收尾（drag-end 与 mouseup 丢失自愈共用）：停轮询、作废未完成换向、面板复位、持久化
  function finishDrag(): void {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    // 拖拽结束时作废未完成的换向：面板收回动画可能已开始，重播弹出动画保持面板可见
    // （与旧行为一致：拖拽结束后面板保持展开，交由 hover 离开后防抖收起）
    if (reflipTimer) {
      clearTimeout(reflipTimer);
      reflipTimer = null;
    }
    flipping = false;
    dragLostTicks = 0;
    if (panelVisible && panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.setBounds({
        x: Math.round(ballX + panelOffsetX(panelDir)),
        y: Math.round(ballY + panelOffsetY(panelVDir)),
        width: PANEL_W,
        height: PANEL_H,
      });
      panelWindow.webContents.send('panel:show', { h: panelDir, v: panelVDir });
    }
    saveBallPos();
  }

  // 拖拽结束：停止轮询并持久化；返回是否发生过有效位移（用于区分点击与拖拽）
  ipcMain.handle('ball:drag-end', () => {
    finishDrag();
    return dragMaxDisp > 4;
  });

  // mouseup 丢失自愈的渲染端通知已由 finishDrag 后的 drag-force-end 推送完成（见 drag-start tick）

  // 球窗渲染端在球体上方时关闭鼠标穿透（可交互），离开时重新开启穿透
  ipcMain.on('ball:ignore', (_e, ignore: boolean) => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
  });

  // 面板窗渲染端在面板上方时关闭鼠标穿透（可交互），离开时重新开启穿透
  ipcMain.on('panel:ignore', (_e, ignore: boolean) => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
  });

  // 球体 hover 上报（true=mouseenter 真实进入球体，可触发展开；false=离开，走防抖收起）
  ipcMain.on('ball:hover-ball', (_e, v: boolean) => {
    setHoverBall(!!v, true);
  });

  // 面板 hover 上报（只参与收起判定，永不触发展开）
  ipcMain.on('panel:hover-panel', (_e, v: boolean) => {
    setHoverPanel(!!v);
  });

  // 球右键：弹出独立菜单窗（不强制展开面板，面板展开状态保持原样）。
  // 位置由 calcMenuRect 决定（与面板异侧、不重叠、完整在 workArea 内）；重复右键重入时
  // 重设 bounds 并重推 menu:show（同一窗口，无重复弹窗；渲染端会作废进行中的缩入动画）。
  ipcMain.on('ball:ctx-menu', () => {
    if (!menuWindow || menuWindow.isDestroyed()) return;
    // show 时重置为 forward 穿透初始态（上一次显示期间渲染端可能切过可交互）
    menuWindow.setIgnoreMouseEvents(true, { forward: true });
    menuWindow.setBounds(calcMenuRect());
    menuWindow.showInactive(); // 不抢焦点（focusable:false 双保险）
    menuVisible = true;
    menuHidePending = false; // 重入：作废进行中的隐藏（渲染端同步作废缩入定时器）
    menuOffTicks = 0;
    menuWindow.webContents.send('menu:show');
  });

  // 菜单窗渲染端在菜单上方时关闭鼠标穿透（可交互），离开/复位时重新开启穿透
  ipcMain.on('menu:ignore', (_e, ignore: boolean) => {
    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
  });

  // 菜单窗缩入动画播完（渲染端 160ms linear + 180ms 余量后回发）：隐藏窗口并复位状态。
  // 三个关闭来源最终都汇聚于此：① 渲染端菜单项点击/窗外 mousedown ② 光标轮询超时 ③ 全屏/销毁（直接 hide 无动画，不经此路径）。
  ipcMain.on('menu:hide-done', () => {
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide();
    menuVisible = false;
    menuHidePending = false;
    menuOffTicks = 0;
  });

  // 强制立即收起（渲染端主动：左键点击球唤出主窗 / 面板条目点击跳转小窗后收起面板）
  ipcMain.on('ball:collapse', () => {
    hoverBall = false;
    hoverPanel = false;
    cancelCollapseTimer();
    doCollapse();
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

// 保存悬浮球（球窗）停留位置
function saveBallPos(): void {
  persistBallPos();
}
