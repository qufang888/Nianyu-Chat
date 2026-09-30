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
let activeChatKey = ''; // 由渲染端回传：用户当前正在查看的聊天 `${type}:${id}`（主窗）
let activeChatKeyMini = ''; // 同上，但来自迷你窗；主窗/迷你窗各自独立记录，互不覆盖

// 悬浮球当前屏幕逻辑坐标（由本模块权威维护，拖拽增量累加，避免渲染端反查坐标）
let ballX = 0;
let ballY = 0;

// ===== 窗口尺寸跟随面板展开状态（修复：收起后残留 320x460 透明矩形干扰相邻窗口 resize 拖动）=====
// 透明置顶窗 forward 模式下，收起态的空面板区域仍参与鼠标消息命中/转发，导致重叠窗口
// 拖边缘调整大小时反复被打断再恢复而上下/左右闪烁。改为：收起时窗口收缩到只包住球体
// 区域（球底边 = 18 + 60 = 78px，留 10px 余量取 88），展开/右键菜单时恢复完整高度。
const WIN_W = 320;
const WIN_H_EXPANDED = 460;
const WIN_COLLAPSED = 88; // 收起态窗口边长（正方形，恰好包住球体：18 内边距 + 60 球径 + 10 余量）
let ballExpanded = false; // 面板或右键菜单展开时为 true（窗口保持完整尺寸）

// ===== 面板弹出方向（四向自适应 + 边界检测）=====
// 展开态窗口 320x460；球屏幕位置恒为 (ballX+18, ballY+18)，任何方向下窗口左上角按通式反算：
//   x = ballX - (h==='left' ? DIR_OFFSET_LEFT : 0)
//   y = ballY - (v==='up'   ? DIR_OFFSET_UP   : 0)
// 镜像布局下球在窗口内偏移：left → x+242（球距窗右 18）、up → y+382（球距窗底 18），
// 渲染端通过 #root[data-h]/[data-v] 镜像 .fb-ball/.fb-panel 位置，两端共同保证球在屏幕上永不动。
const DIR_OFFSET_LEFT = 224; // 320 - (18 + 60 + 18)：left 展开时窗口相对球坐标向左延伸量
const DIR_OFFSET_UP = 364; // 460 - (18 + 60 + 18)：up 展开时窗口相对球坐标向上延伸量
let panelDir: 'right' | 'left' = 'right'; // 当前水平弹出方向
let panelVDir: 'down' | 'up' = 'down'; // 当前垂直弹出方向
let flipping = false; // 拖动中翻转进行中（线性收回 → 换向重弹两阶段），期间禁止重复触发
let reflipTimer: ReturnType<typeof setTimeout> | null = null; // 翻转第二阶段（换向重弹）定时器

// 按当前展开状态与弹出方向设置窗口 bounds。
// 收起态：88x88 正方形恰好包住球体（球恒在窗口内 (18,18)，与方向无关），窗口位置 = (ballX, ballY)；
// 展开态：320x460，按方向通式反算窗口左上角，保证球屏幕位置 (ballX+18, ballY+18) 恒定不动。
function applyBallWindowSize(): void {
  if (ballWindow && !ballWindow.isDestroyed()) {
    if (ballExpanded) {
      const ox = panelDir === 'left' ? DIR_OFFSET_LEFT : 0;
      const oy = panelVDir === 'up' ? DIR_OFFSET_UP : 0;
      ballWindow.setBounds({
        x: Math.round(ballX - ox),
        y: Math.round(ballY - oy),
        width: WIN_W,
        height: WIN_H_EXPANDED,
      });
    } else {
      ballWindow.setBounds({
        x: Math.round(ballX),
        y: Math.round(ballY),
        width: WIN_COLLAPSED,
        height: WIN_COLLAPSED,
      });
    }
  }
}

// 展开前边界检测：依球心在屏幕的左右/上下半区取默认方向；默认方向展开会超出工作区且
// 对侧可行时翻转到对侧；双侧均不可行（屏幕极小）保持默认方向兜底（球本体始终可见）。
function calcPanelDir(): { h: 'right' | 'left'; v: 'down' | 'up' } {
  const wa = screen.getPrimaryDisplay().workArea;
  // 球中心 = (ballX+18+30, ballY+18+30) = (ballX+48, ballY+48)
  let h: 'right' | 'left' = ballX + 48 <= wa.x + wa.width / 2 ? 'right' : 'left';
  let v: 'down' | 'up' = ballY + 48 <= wa.y + wa.height / 2 ? 'down' : 'up';
  const rightOk = ballX + WIN_W <= wa.x + wa.width; // 右弹：窗口右缘不越出工作区
  const leftOk = ballX - DIR_OFFSET_LEFT >= wa.x; // 左弹：窗口左缘不越出工作区
  const downOk = ballY + WIN_H_EXPANDED <= wa.y + wa.height; // 下弹：窗口下缘不越出工作区
  const upOk = ballY - DIR_OFFSET_UP >= wa.y; // 上弹：窗口上缘不越出工作区
  if (h === 'right' && !rightOk && leftOk) h = 'left';
  else if (h === 'left' && !leftOk && rightOk) h = 'right';
  if (v === 'down' && !downOk && upOk) v = 'up';
  else if (v === 'up' && !upOk && downOk) v = 'down';
  return { h, v };
}

// 拖拽状态：主进程轮询系统光标直接定位窗口，窗口始终贴合光标，杜绝滞后与粘滞
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
let dragMaxDisp = 0;
const DRAG_CLAMP = 78; // 球体右/底缘 = 18(窗口内边距) + 60(球径) = 78，钳制以球缘为准：拖拽中球完整可见（距屏幕边 4px）

// ===== 光标在窗检测轮询（v2.3.36 修复：动态光标移出悬浮球不隐去）=====
// 穿透窗 forward 模式只转发 mousemove：鼠标直接移出窗口边界时，渲染端收不到任何
// mouseleave/mouseout（DOM 合成事件也无从派发），setInteractive(false) 永不执行，
// 动态光标残留在 alwaysOnTop 画布上。主进程按固定间隔轮询系统光标是否仍在窗口矩形内，
// 离开瞬间推送 ball:cursor-window=false，渲染端据此走既有隐藏链路（gate-off + 合成 mouseout）。
// 球↔面板之间的细粒度进出仍由 DOM mouseenter/mouseleave 处理，本轮询仅兜底「出窗」场景。
const CURSOR_POLL_MS = 200; // 轮询间隔：隐去延迟上限 ≈ 间隔 + 渲染端 120ms 防抖，观感约 0.3s
let cursorPollTimer: ReturnType<typeof setInterval> | null = null;
let lastCursorInside = true; // 初始视为在窗内，避免启动瞬间多发一次 false
function startCursorPoll(): void {
  if (cursorPollTimer) clearInterval(cursorPollTimer);
  cursorPollTimer = setInterval(() => {
    if (!ballWindow || ballWindow.isDestroyed() || !ballWindow.isVisible()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = ballWindow.getBounds();
      const inside =
        p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (inside !== lastCursorInside) {
        lastCursorInside = inside;
        ballWindow.webContents.send('ball:cursor-window', inside);
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
// 生视频轮巡进度：仅用于悬浮球显示，不改变悬浮球任何交互逻辑。
// percent 0~100 表示进度；percent < 0 表示生成结束（完成/失败），球恢复常态图标。
export function sendBallVideoProgress(percent: number, statusText?: string): void {
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('ball:videoProgress', {
      percent: Math.max(-1, Math.min(100, Math.round(percent))),
      statusText: statusText || '',
    });
  }
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

// ===== 悬浮球窗口创建 =====
export function createFloatingBall(): void {
  if (ballWindow && !ballWindow.isDestroyed()) return;
  if (sessionClosed) return; // 本次运行已手动关闭，重启前不再创建
  const settings = dm.getSettings();
  if (settings.floatingBall?.enabled === false) return; // 设置中关闭则不创建
  const aot = settings.floatingBall?.alwaysOnTop !== false; // 默认置顶

  const saved = settings.floatingBall || { enabled: true, x: 0, y: 0 };
  // 窗口逻辑尺寸：悬浮球本体 60x60，未读面板四向自适应展开（弹出方向由边界检测决定）；
  // 初始为收起态 88x88（仅包住球体），面板展开时由 ball:expand-panel 按方向恢复完整尺寸
  const SIZE = 64;
  ballExpanded = false;
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
    width: WIN_COLLAPSED,
    height: WIN_COLLAPSED,
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

  // 置顶分层（v2.3.37）：悬浮球用 'screen-saver'（最高层），恒高于小窗的 'floating' 层——
  // 期望顺序：悬浮球 > 小窗 > 其他软件窗口（构造参数不支持 level，创建后显式设置）
  ballWindow.setAlwaysOnTop(aot, 'screen-saver');

  startCursorPoll(); // 光标在窗检测轮询（修复动态光标移出不隐去）

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
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
    lastCursorInside = true; // 重建窗口后重新从「在窗内」状态起步
  }
  if (reflipTimer) {
    clearTimeout(reflipTimer);
    reflipTimer = null;
  }
  flipping = false;
  panelDir = 'right'; // 方向状态一并复位，重建窗口后从默认方向起步
  panelVDir = 'down';
  ballExpanded = false; // 重置展开状态，重建窗口后从收起态起步
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.destroy();
  ballWindow = null;
}

// 切换悬浮球置顶并持久化（保留位置与启用状态）
export function setBallAlwaysOnTop(v: boolean): void {
  const s = dm.getSettings();
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.setAlwaysOnTop(v, 'screen-saver'); // 最高层，恒高于小窗 'floating'（v2.3.37）
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
    // 抓取偏移换算到球坐标模型（ballX/ballY = 球屏幕位置 - 18）：展开态镜像布局下球在窗口内
    // 偏移为 (242, 382)，窗口坐标需扣除方向延伸量；收起态与 right/down 展开态偏移为 0（原行为）。
    dragOffsetX = gx - (ballExpanded && panelDir === 'left' ? DIR_OFFSET_LEFT : 0);
    dragOffsetY = gy - (ballExpanded && panelVDir === 'up' ? DIR_OFFSET_UP : 0);
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
      // 方向感知定位：展开态窗口左上角 = 球坐标 - 方向延伸量（收起态延伸量为 0），
      // 保证任意方向下球屏幕位置 (ballX+18, ballY+18) 恒定，镜像 CSS 与窗口位置始终匹配。
      const ox = ballExpanded && panelDir === 'left' ? DIR_OFFSET_LEFT : 0;
      const oy = ballExpanded && panelVDir === 'up' ? DIR_OFFSET_UP : 0;
      ballWindow.setPosition(Math.round(nx - ox), Math.round(ny - oy));
      dragMaxDisp = Math.max(dragMaxDisp, Math.abs(nx - dragStartX) + Math.abs(ny - dragStartY));
      // ===== 拖动中面板出界检测：展开窗口越出工作区且需换向时，先推送渲染端线性收回面板，
      // 260ms 后（≥160ms 收回动画 + 200ms 渲染端收缩定时器）按新方向重弹。=====
      if (ballExpanded && !flipping) {
        try {
          const waNow = screen.getPrimaryDisplay().workArea;
          const b = ballWindow.getBounds();
          const out =
            b.x < waNow.x ||
            b.y < waNow.y ||
            b.x + b.width > waNow.x + waNow.width ||
            b.y + b.height > waNow.y + waNow.height;
          if (out) {
            const want = calcPanelDir();
            if (want.h !== panelDir || want.v !== panelVDir) {
              flipping = true;
              ballWindow.webContents.send('ball:panel-reflip'); // 渲染端 hidePanel（linear 收回）
              reflipTimer = setTimeout(() => {
                reflipTimer = null;
                panelDir = want.h;
                panelVDir = want.v;
                ballExpanded = true;
                // 先推新方向布局再重设窗口 bounds：此刻窗口尚为收起态 88x88，
                // 镜像偏移误差仅 8px；若先扩窗后推布局，球会瞬时偏移 224px，视觉跳动明显
                if (ballWindow && !ballWindow.isDestroyed()) {
                  ballWindow.webContents.send('ball:panel-layout', { h: want.h, v: want.v });
                }
                applyBallWindowSize();
                flipping = false;
              }, 260);
            }
            // 出界但方向未变（双侧均不可行的极小屏幕兜底）：零动作，绝不重复触发
          }
        } catch {
          /* 出界检测失败静默跳过，下一轮 tick 重试 */
        }
      }
    }, 16);
  });

  // 拖拽结束：停止轮询并持久化；返回是否发生过有效位移（用于区分点击与拖拽）
  ipcMain.handle('ball:drag-end', () => {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    // 拖拽结束时作废未完成的翻转：渲染端 hidePanel 的收缩定时器会把窗口收回 88x88，
    // ballExpanded 随 ball:set-expanded(false) 归位，状态自洽
    if (reflipTimer) {
      clearTimeout(reflipTimer);
      reflipTimer = null;
    }
    flipping = false;
    saveBallPos();
    return dragMaxDisp > 4;
  });

  // 渲染端在悬浮球/面板上方时关闭鼠标穿透（可交互），离开时重新开启穿透
  ipcMain.on('ball:ignore', (_e, ignore: boolean) => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
  });

  // 渲染端切换展开状态：true=面板/右键菜单展开（恢复完整高度），false=收起（仅包住球体）。
  // 幂等：状态相同时不重复 setBounds，避免快速 hover 进出竞态下的无谓重排。
  ipcMain.on('ball:set-expanded', (_e, v: boolean) => {
    const next = !!v;
    if (next === ballExpanded) return;
    ballExpanded = next;
    applyBallWindowSize();
  });

  // 展开面板（含边界检测）：计算可行方向 → 按方向重设窗口 bounds → 回传方向供渲染端镜像布局。
  // 渲染端收到 undefined / 异常时回退旧 ball:set-expanded(true) 通道。
  ipcMain.handle('ball:expand-panel', () => {
    const d = calcPanelDir();
    panelDir = d.h;
    panelVDir = d.v;
    ballExpanded = true;
    applyBallWindowSize();
    return { h: d.h, v: d.v };
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
