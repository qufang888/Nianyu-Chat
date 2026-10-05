// 念语 · 桌面悬浮球（三窗口渲染端）
// 同一 floating-ball.html 由三个独立 BrowserWindow 加载，query ?role 区分：
//   role=ball  → 球窗（68x68 恒定）：球体 + 未读角标 + 生视频进度环 + 拖拽/点击/右键转发
//   role=panel → 面板窗（320x460）：快捷聊天面板 + 条目右键菜单，独立弹出/收回动画
//   role=menu  → 菜单窗（180x140）：球右键应用菜单（退出/本次关闭/置顶），独立弹出/缩入动画
// 交互区域：主进程对各窗 setIgnoreMouseEvents(true,{forward:true})，透明区穿透到下层窗口；
// 本端在球体/面板/菜单上方时切回可交互（ballSetIgnore/panelIgnore/menuIgnore(false)），离开时恢复穿透。
// 拖拽：主进程每 16ms 轮询系统光标直接 setPosition（球窗移动、面板窗跟随），渲染端仅发起止信号。
// 展开/收起决策全部在主进程 hover 状态机（160ms 防抖），本端只上报 hover 与播放动画。
import './theme/variables.css';
import { sortChats, togglePinnedChat, applyDragOrder } from './utils/chatOrdering';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeContext';
import CustomCursor from './components/CustomCursor';
import { applyAnimControl } from './utils/animControl';

const api = (window as any).api;

const BALL = 60;
const BALL_L = 4; // 球 DOM 相对球窗左上角内边距（与主进程 BALL_PAD 同步；角标溢出 4px 恰好仍在窗内）
const BALL_T = 4;
const PANEL_W = 320; // 面板窗尺寸（与主进程 PANEL_W/PANEL_H 同步）
const PANEL_H = 460;
const PANEL_PAD = 14; // 面板 DOM 相对面板窗内边距（与主进程方向偏移公式同步）
const MENU_HIDE_ANIM_MS = 180; // 菜单缩入动画播完的等待余量（动画 160ms linear + 20ms 余量，与主进程约定一致）

type UnreadItem = {
  key: string;
  chatType: string;
  chatId: string;
  roleName: string;
  content: string;
  avatar: string;
  count: number;
  ts: number;
};

type ChatItem = {
  chat_type: string;
  chat_id: string;
  name: string;
  chat_name?: string;
  avatar_path: string;
  last_message: string;
  member_count?: number;
};

type Dir = { h: 'right' | 'left'; v: 'down' | 'up' };

function baseCSS(): string {
  return `
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
    -webkit-user-select:none;user-select:none;}
  /* 动态光标启用时隐藏原生光标（主窗口由 index.css 提供，悬浮球两窗各自自带此规则） */
  body.cursor-hidden, body.cursor-hidden *{cursor:none !important;}
  #root{width:100%;height:100%;position:relative;}

  .fb-ball{position:absolute;left:${BALL_L}px;top:${BALL_T}px;width:${BALL}px;height:${BALL}px;
    border-radius:50%;cursor:grab;
    background:var(--color-primary);
    display:flex;align-items:center;justify-content:center;
    transition:transform .12s ease;}
  .fb-ball:active{cursor:grabbing;transform:scale(.94);}
  .fb-ball svg{width:30px;height:30px;fill:var(--color-primary-text);}
  .fb-ball.dragging{cursor:grabbing;transform:scale(.96);}

  /* 生视频轮巡进度：外圈环形进度 + 中心百分比（纯显示层，pointer-events:none 不影响交互） */
  .fb-prog{position:absolute;inset:0;pointer-events:none;display:none;}
  .fb-prog.show{display:block;}
  .fb-prog svg{width:100%;height:100%;transform:rotate(-90deg);fill:none;}
  .fb-prog circle{fill:none;stroke-width:4;}
  .fb-prog .bg{stroke:rgba(255,255,255,0.25);}
  .fb-prog .fg{stroke:#ffffff;stroke-linecap:round;transition:stroke-dashoffset .25s linear;}
  .fb-prog-txt{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
    font-size:15px;font-weight:800;color:#fff;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.45);}
  .fb-prog-txt.show{display:flex;}
  /* 进度显示时隐藏球内图标，让中心百分比数字清晰可读 */
  .fb-ball.gen > svg{visibility:hidden;}

  .fb-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;
    box-sizing:border-box;border-radius:9px;background:#ff4d4f;color:#fff;
    font-size:11px;font-weight:700;line-height:18px;text-align:center;
    border:2px solid var(--color-bg);}

  /* ===== 面板（面板窗内布局：窗内边距 14，max-height = 460 - 14*2 = 432）===== */
  .fb-panel{position:absolute;left:${PANEL_PAD}px;top:${PANEL_PAD}px;width:${PANEL_W - PANEL_PAD * 2}px;
    max-height:${PANEL_H - PANEL_PAD * 2}px;box-sizing:border-box;
    background:var(--color-panel);backdrop-filter:blur(var(--blur));-webkit-backdrop-filter:blur(var(--blur));
    border:1px solid var(--color-border);border-radius:var(--radius);
    color:var(--color-text);display:flex;flex-direction:column;overflow:hidden;
    opacity:0;transform:translateY(-8px) scale(.98);pointer-events:none;
    /* linear 为硬性要求：弹出/收回（含拖动换向两阶段）动画共用同一缓动 */
    transition:opacity .16s linear, transform .16s linear;}
  .fb-panel.show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}
  /* ===== 弹出方向镜像（挂在 #root 的 data-h / data-v 上，由主进程边界检测结果驱动）=====
     面板窗本体已按方向定位在球侧（主进程方向公式），窗内仅需水平/垂直镜像面板停靠边；
     up 模式浮现方向反向（translateY(8px)→0，与 down 模式对称） */
  #root[data-h='left'] .fb-panel{left:auto;right:${PANEL_PAD}px;}
  #root[data-v='up'] .fb-panel{top:auto;bottom:${PANEL_PAD}px;transform:translateY(8px) scale(.98);}
  #root[data-v='up'] .fb-panel.show{transform:translateY(0) scale(1);}
  .fb-panel-h{display:flex;align-items:center;justify-content:space-between;
    padding:12px 14px 8px;font-size:13px;font-weight:700;letter-spacing:.5px;}
  .fb-panel-h .cnt{font-size:11px;font-weight:600;color:var(--color-primary);
    background:var(--color-hover);padding:2px 8px;border-radius:10px;}
  .fb-list{overflow-y:auto;padding:2px 8px 6px;display:flex;flex-direction:column;gap:2px;}
  .fb-list::-webkit-scrollbar{width:6px;}
  .fb-list::-webkit-scrollbar-thumb{background:var(--color-border);border-radius:3px;}
  .fb-row{display:flex;align-items:center;gap:10px;padding:8px 8px;border-radius:10px;cursor:pointer;
    transition:background .12s;}
  .fb-row:hover{background:var(--color-hover);}
  .fb-av{flex:0 0 auto;width:38px;height:38px;border-radius:50%;
    background:var(--color-primary);
    display:flex;align-items:center;justify-content:center;
    font-size:16px;font-weight:700;color:var(--color-primary-text);object-fit:cover;
    background-size:cover;background-position:center;}
  .fb-row-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}
  .fb-row-name{font-size:13px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--color-text);}
  .fb-row-content{font-size:12px;color:var(--color-text-secondary);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .fb-row-cnt{flex:0 0 auto;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;
    background:#ff4d4f;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;}
  /* 置顶与拖拽排序指示 */
  .fb-row{position:relative;}
  .fb-row .fb-pin{flex:0 0 auto;font-size:11px;line-height:1;opacity:.95;}
  .fb-row.fb-pinned{background:var(--color-hover);}
  .fb-row.fb-dragging{opacity:.45;}
  .fb-row.fb-drag-over{box-shadow:inset 0 2px 0 var(--color-primary);}
  [data-theme='glass'] .fb-row.fb-pinned{background:rgba(255,255,255,0.10);}
  .fb-empty{padding:22px 12px;text-align:center;font-size:12.5px;color:var(--color-text-secondary);}
  .fb-foot{padding:8px 14px 10px;font-size:11px;color:var(--color-text-secondary);text-align:center;border-top:1px solid var(--color-border);}

  /* 右键菜单（跟随主题；无阴影——菜单窗独立透明承载，与悬浮球整体无阴影风格一致）
     弹出/缩入动画 linear 0.16s（硬性要求，与面板动画同一缓动） */
  .fb-ctx{position:absolute;z-index:50;min-width:150px;box-sizing:border-box;
    background:var(--color-panel);backdrop-filter:blur(var(--blur));-webkit-backdrop-filter:blur(var(--blur));
    border:1px solid var(--color-border);border-radius:var(--radius-sm);
    color:var(--color-text);font-size:13px;padding:4px;
    opacity:0;transform:scale(.92);
    transition:opacity .16s linear, transform .16s linear;}
  .fb-ctx.show{opacity:1;transform:scale(1);}
  /* 菜单窗（role=menu）容器：铺满整个菜单窗，菜单固定在窗内 (10,10) 附近 */
  .fb-ctx-menu-host{position:absolute;inset:0;}
  .fb-ctx-item{padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;user-select:none;white-space:nowrap;}
  .fb-ctx-item:hover{background:var(--color-hover);}
  .fb-ctx-aot-row{justify-content:flex-start;}
  .fb-ctx-aot-row input{accent-color:var(--color-primary);cursor:pointer;width:15px;height:15px;margin:0;}
  [data-theme='glass'] .fb-ctx{ background:rgba(18,16,38,0.88); border-color:rgba(255,255,255,0.28); }

  /* 毛玻璃主题：原面板背景为浅白低不透明（rgba(255,255,255,0.22)）+白字，
     在亮桌面下对比不足、字被吃掉。改用深暗半透明磨砂底，保证浅色文字始终可读。
     （这里"降不透明度"指降低亮色覆盖、提高暗色对比，而非单纯调低 alpha 导致透出桌面） */
  [data-theme='glass'] .fb-panel{
    background:rgba(18,16,38,0.88);
    border-color:rgba(255,255,255,0.28);
  }
  [data-theme='glass'] .fb-row:hover{ background:rgba(255,255,255,0.10); }
  [data-theme='glass'] .fb-panel-h .cnt{ color:#cfd2ff; background:rgba(124,131,255,0.32); }

  /* 动效开关（animMode='all-off' 时根元素挂 .anim-off）：全局禁用所有 CSS 动画/过渡，
     与主界面 index.css 的 .anim-off 规则同语义（覆盖 .fb-panel/.fb-ctx/.fb-ball 等全部动画）。
     'custom' 档不挂 .anim-off，改由 data-anim-off 逐组门禁（见 src/utils/animControl.ts）。 */
  .anim-off, .anim-off *, .anim-off *::before, .anim-off *::after {
    animation: none !important; transition: none !important;
  }
  `;
}

function ballSVG(): string {
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H9l-4 3.5v-3.5H5.5C4.67 16 4 15.33 4 14.5v-9Z"/>
    <circle cx="8.5" cy="9" r="1.2" fill="currentColor" opacity="0.75"/>
    <circle cx="12" cy="9" r="1.2" fill="currentColor" opacity="0.75"/>
    <circle cx="15.5" cy="9" r="1.2" fill="currentColor" opacity="0.75"/>
  </svg>`;
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)
  );
}

// 交互/穿透切换 + 动态光标门控（两窗各自独立 gate，channel 由调用方传入）：
// - on=true（鼠标在本窗不透明区域上）：关闭穿透，正常收事件 → 光标门控解除，动态光标正常显示
// - on=false（鼠标离开）：恢复穿透。穿透模式主进程只转发 mousemove，窗口收不到 mouseleave，
//   光标会残留，故加 cursor-gate-off 门控类（CustomCursor 忽略 mousemove），
//   并派发合成 mouseout 触发 CustomCursor 立即淡出、恢复原生光标。
function makeInteractive(ignoreFn: ((ignore: boolean) => void) | undefined) {
  let gateTimer = 0;
  function setInteractive(on: boolean): void {
    if (ignoreFn) ignoreFn(!on);
    if (gateTimer) {
      clearTimeout(gateTimer);
      gateTimer = 0;
    }
    if (on) {
      document.body.classList.remove('cursor-gate-off');
    } else {
      // 120ms 防抖：球→面板跨窗移动会短暂离开不透明区，避免光标闪隐
      gateTimer = window.setTimeout(() => {
        gateTimer = 0;
        document.body.classList.add('cursor-gate-off');
        document.dispatchEvent(new MouseEvent('mouseout'));
      }, 120);
    }
  }
  return setInteractive;
}

function injectCSS(): HTMLElement {
  const styleEl = document.createElement('style');
  document.head.appendChild(styleEl);
  styleEl.textContent = baseCSS();
  return styleEl;
}

// ===== 主题同步（三窗各自刷新）=====
function setupTheme(onChanged?: () => void): void {
  function applyTheme(theme?: string): void {
    document.documentElement.setAttribute('data-theme', theme || 'wechat');
  }
  // 高级动画控制（v2.3.90）：总控 / 单控互斥。悬浮球是独立 document，
  // 总控关闭 → 上面 baseCSS 的 `.anim-off` 全局 kill 生效；
  // 单控模式 → 改用 `html[data-anim-off~="floatball"]` + 自动生成的 <style> 精确关掉本窗动画。
  // kind 传 'floating'：本窗用 .fb-* 系列选择器，与主窗口的分类法共用同一份 ANIM_GROUPS 定义。
  function applyAnim(settings: any): void {
    applyAnimControl(document, settings, 'floating');
  }
  function refreshTheme(): void {
    if (api && api.getSettings) {
      api.getSettings()
        .then((s: any) => {
          applyTheme(s?.theme);
          applyAnim(s);
        })
        .catch(() => {});
    }
  }
  refreshTheme();
  if (api && api.onSettingsChanged) {
    api.onSettingsChanged(() => {
      refreshTheme(); // 内部已同步刷新 anim 状态（同一次 getSettings 取回主题 + 动效开关）
      onChanged?.();
    });
  }
}

// ===================== 球窗渲染端 =====================
function mountBall(): void {
  injectCSS();
  const root = document.getElementById('root') as HTMLElement;

  let unreadCount = 0;
  let dragging = false;

  const ball = document.createElement('div');
  ball.className = 'fb-ball';
  ball.title = '左键打开念语 · 右键菜单';
  ball.innerHTML = ballSVG();
  const badge = document.createElement('div');
  badge.className = 'fb-badge';
  badge.style.display = 'none';
  ball.appendChild(badge);
  root.appendChild(ball);

  // ===== 生视频轮巡进度（仅显示：外圈环形 + 中心百分比；悬浮球交互逻辑完全不变）=====
  const PROG_C = 2 * Math.PI * 27; // r=27 的周长，用于 stroke-dashoffset
  const prog = document.createElement('div');
  prog.className = 'fb-prog';
  prog.innerHTML =
    `<svg viewBox="0 0 60 60"><circle class="bg" cx="30" cy="30" r="27"/>` +
    `<circle class="fg" cx="30" cy="30" r="27" stroke-dasharray="${PROG_C}" stroke-dashoffset="${PROG_C}"/></svg>`;
  ball.appendChild(prog);
  const progTxt = document.createElement('div');
  progTxt.className = 'fb-prog-txt';
  ball.appendChild(progTxt);

  function setVideoProgress(percent: number, statusText?: string): void {
    if (percent < 0) {
      // 生成结束（完成/失败）：悬浮球图标恢复常态
      prog.classList.remove('show');
      progTxt.classList.remove('show');
      ball.classList.remove('gen');
      ball.title = '左键打开念语 · 右键菜单';
      return;
    }
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    ball.classList.add('gen');
    prog.classList.add('show');
    progTxt.classList.add('show');
    progTxt.textContent = `${p}%`;
    const fg = prog.querySelector('.fg') as SVGCircleElement | null;
    if (fg) fg.style.strokeDashoffset = String(PROG_C * (1 - p / 100));
    ball.title = statusText ? `生视频中 ${p}% · ${statusText}` : `生视频中 ${p}%`;
  }
  if (api && api.onBallVideoProgress) {
    api.onBallVideoProgress((data: any) => setVideoProgress(data?.percent ?? -1, data?.statusText));
  }

  const setInteractive = makeInteractive(api?.ballSetIgnore);

  // ===== 未读角标（后台来消息提示）=====
  function renderBadge(): void {
    if (unreadCount > 0) {
      badge.style.display = 'block';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    } else {
      badge.style.display = 'none';
    }
  }
  function onUnread(data: { count: number; items: UnreadItem[] }): void {
    unreadCount = data.count || 0;
    renderBadge();
  }
  if (api && api.onBallUnread) api.onBallUnread((_e: any, data: any) => onUnread(data));
  if (api && api.ballGetUnread) {
    api.ballGetUnread().then((d: any) => onUnread(d)).catch(() => {});
  }

  setupTheme();

  // ===== hover 上报（展开/收起决策在主进程状态机）=====
  ball.addEventListener('mouseenter', () => {
    setInteractive(true);
    if (api?.ballHoverBall) api.ballHoverBall(true);
  });
  ball.addEventListener('mouseleave', () => {
    if (dragging) return; // 拖拽中球窗贴合光标，鼠标事件链不可断（mouseup 依赖可交互窗口）
    if (api?.ballHoverBall) api.ballHoverBall(false);
    setInteractive(false);
  });

  // 主进程轮询兜底：穿透 forward 模式下鼠标直接移出球窗边界时 DOM 收不到 mouseleave，
  // 光标离开窗口矩形 → 主进程推送 false → 走隐藏链路（gate-off + 合成 mouseout）。
  if (api && api.onBallCursorWindow) {
    api.onBallCursorWindow((inside: boolean) => {
      if (inside) return;
      setInteractive(false);
    });
  }
  // 失焦（点击球唤出主窗等）：恢复穿透与光标门控；面板收起由主进程 blur 链路统一处理
  if (api && api.onBallBlur) api.onBallBlur(() => setInteractive(false));

  // ===== 拖拽 + 点击 + 右键 =====
  ball.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setInteractive(true);
    dragging = true;
    ball.classList.add('dragging');
    // 球窗恒 68x68：抓取偏移 gx/gy ∈ [4,64] 直接上报，主进程无方向换算
    if (api?.ballDragStart) api.ballDragStart(e.clientX, e.clientY);
    window.addEventListener('mouseup', onUp);
  });

  function onUp(): void {
    if (!dragging) return;
    dragging = false;
    ball.classList.remove('dragging');
    window.removeEventListener('mouseup', onUp);
    const finish = (wasDrag: boolean) => {
      if (!wasDrag) {
        // 左键点击：唤出主界面并主动收起面板（旧版 hidePanel 行为；
        // 主进程 ball:collapse 强制收起，轮询电平不会触发展开边沿，面板不回弹）
        if (api?.ballActivate) api.ballActivate();
        if (api?.ballCollapse) api.ballCollapse();
      }
      // 有效拖拽后球仍悬停：面板保持展开（主进程已让面板窗跟随到新位置），交由 hover 离开后防抖收起
    };
    if (api?.ballDragEnd) {
      Promise.resolve(api.ballDragEnd()).then(finish).catch(() => finish(false));
    } else {
      finish(false);
    }
  }

  // 主进程 mouseup 丢失自愈（P0-1）：球被钳制贴屏边而光标继续移出球窗时，窗外 mouseup
  // 穿透丢失、onUp 永不触发，球会永久吸附光标。主进程连续 30 tick 检测到光标在球窗外即
  // 强制收尾并推送本消息；渲染端复位拖拽状态并恢复穿透（setInteractive(false) 走既有
  // 120ms 防抖 gate 链路），避免球窗残留可交互矩形遮挡屏幕边缘。
  if (api && api.onBallDragForceEnd) {
    api.onBallDragForceEnd(() => {
      if (!dragging) return;
      dragging = false;
      ball.classList.remove('dragging');
      window.removeEventListener('mouseup', onUp);
      setInteractive(false);
    });
  }

  // 右键：通知主进程展开面板窗并转发菜单显示（菜单渲染在面板窗内）
  ball.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (api?.ballCtxMenu) api.ballCtxMenu();
  });
}

// ===================== 面板窗渲染端 =====================
function mountPanel(): void {
  injectCSS();
  const root = document.getElementById('root') as HTMLElement;

  let panelShown = false; // 面板当前是否处于 .show 弹出态
  let menuOpen = false; // 任一右键菜单打开中（期间 .fb-panel mouseleave 不上报，防误收起）
  let chatList: ChatItem[] = [];
  let suppressClick = false;
  let ctxMenu: HTMLDivElement | null = null;

  const panel = document.createElement('div');
  panel.className = 'fb-panel';
  root.appendChild(panel);

  // 同步弹出方向到 #root data 属性（驱动 CSS 镜像布局）
  function setRootDir(h: 'right' | 'left', v: 'down' | 'up'): void {
    root.dataset.h = h;
    root.dataset.v = v;
  }

  const setInteractive = makeInteractive(api?.panelIgnore);

  // ===== 聊天列表数据（置顶/手动顺序与主界面一致）=====
  let pinnedChats: string[] = [];
  let chatOrder: string[] = [];
  async function loadOrdering(): Promise<void> {
    try {
      const s = api && api.getSettings ? await api.getSettings() : null;
      pinnedChats = (s && (s.pinnedChats || [])) || [];
      chatOrder = (s && (s.chatOrder || [])) || [];
    } catch {
      pinnedChats = [];
      chatOrder = [];
    }
  }
  async function fetchChats(): Promise<void> {
    if (api && api.getChatList) {
      try {
        const [list] = await Promise.all([api.getChatList(), loadOrdering()]);
        chatList = sortChats(list || [], pinnedChats, chatOrder);
        if (panelShown) renderPanel();
      } catch {
        /* ignore */
      }
    }
  }

  async function savePin(key: string): Promise<void> {
    pinnedChats = togglePinnedChat(pinnedChats, key);
    if (api && api.saveSettings) await api.saveSettings({ pinnedChats });
    await fetchChats();
  }

  async function saveRowOrder(next: string[]): Promise<void> {
    chatOrder = next;
    if (api && api.saveSettings) await api.saveSettings({ chatOrder: next });
    await fetchChats();
  }

  function renderPanel(): void {
    if (chatList.length === 0) {
      panel.innerHTML = `<div class="fb-panel-h"><span>快捷聊天</span></div>
        <div class="fb-empty">暂无可切换的聊天</div>
        <div class="fb-foot">滚轮可滚动查看更多 · 右键悬浮球可退出念语</div>`;
    } else {
      const pinSet = new Set(pinnedChats || []);
      const rows = chatList
        .map((it) => {
          const isGroup = it.chat_type === 'group';
          const key = `${it.chat_type}:${it.chat_id}`;
          const name = it.chat_name || it.name;
          const tag = isGroup ? '群聊' : '单聊';
          return `<div class="fb-row${pinSet.has(key) ? ' fb-pinned' : ''}" draggable="true" data-key="${key}" data-chat='${JSON.stringify({
            chatType: it.chat_type,
            chatId: it.chat_id,
            name,
          }).replace(/'/g, '&#39;')}'>
            <div class="fb-av" data-av="${it.avatar_path || ''}">${(name || '?').trim().charAt(0) || '?'}</div>
            <div class="fb-row-body">
              <div class="fb-row-name">${escapeHTML(name)}</div>
              <div class="fb-row-content">${isGroup ? '👥 ' : '💬 '}${escapeHTML(tag)}${it.last_message ? ' · ' + escapeHTML(it.last_message) : ''}</div>
            </div>
            ${pinSet.has(key) ? '<span class="fb-pin" title="置顶">📌</span>' : ''}
          </div>`;
        })
        .join('');
      panel.innerHTML = `<div class="fb-panel-h"><span>快捷聊天</span><span class="cnt">${chatList.length}</span></div>
        <div class="fb-list">${rows}</div>
        <div class="fb-foot">拖动可调整顺序 · 右键条目可置顶 · 滚轮查看更多</div>`;

      panel.querySelectorAll<HTMLElement>('.fb-av').forEach((el) => {
        const p = el.getAttribute('data-av');
        if (p && api?.getImage) {
          api.getImage(p).then((d: string | null) => {
            if (d) {
              el.style.backgroundImage = `url(${d})`;
              el.textContent = '';
            }
          }).catch(() => {});
        }
      });

      // 面板内拖拽状态（每次 render 后重新绑定）
      let dragKey: string | null = null;
      panel.querySelectorAll<HTMLElement>('.fb-row').forEach((row) => {
        const key = row.getAttribute('data-key') || '';
        row.addEventListener('click', () => {
          if (suppressClick) return; // 拖拽结束后的误触保护
          try {
            const chat = JSON.parse(row.getAttribute('data-chat') || '{}');
            // 跳转小窗前面板主动收起（主进程 ball:collapse 强制路径，
            // 轮询电平不会重建展开边沿，面板不会回弹）
            if (api?.ballCollapse) api.ballCollapse();
            if (api?.ballOpenChat) api.ballOpenChat(chat);
          } catch {
            /* ignore */
          }
        });
        // 拖拽排序（与主界面一致：写入 chatOrder）
        row.addEventListener('dragstart', () => {
          dragKey = key;
          row.classList.add('fb-dragging');
          suppressClick = true;
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('fb-dragging');
          dragKey = null;
          window.setTimeout(() => { suppressClick = false; }, 120);
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (dragKey && dragKey !== key) row.classList.add('fb-drag-over');
        });
        row.addEventListener('dragleave', () => {
          if (dragKey !== key) row.classList.remove('fb-drag-over');
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('fb-drag-over');
          const visibleKeys = Array.from(panel.querySelectorAll<HTMLElement>('.fb-row'))
            .map((r) => r.getAttribute('data-key') || '');
          const next = applyDragOrder(visibleKeys, dragKey || '', key);
          dragKey = null;
          void saveRowOrder(next);
        });
        // 右键条目：置顶 / 取消置顶
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showRowCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, key);
        });
      });
    }
  }

  // ===== 右键菜单（面板列表条目的置顶菜单，渲染在本面板窗内）=====
  function onDocDown(e: MouseEvent): void {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
  }

  function closeCtxMenu(): void {
    if (!ctxMenu) {
      menuOpen = false;
      document.removeEventListener('mousedown', onDocDown, true);
      setInteractive(!!(panel && panel.matches(':hover')));
      return;
    }
    const el = ctxMenu;
    ctxMenu = null;
    menuOpen = false;
    document.removeEventListener('mousedown', onDocDown, true);
    // linear 缩入动画（与弹出对称；.anim-off 总控下 transition:none → 瞬时完成，180ms 定时器
    // 到点 remove() 无害）。旧元素独立于后续新菜单 DOM：右键另一条目重入时旧菜单边缩入边被
    // 新菜单替换，互不影响。
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 180); // 160ms 动画 + 余量后移除 DOM
    // 菜单关闭后按当前悬停状态恢复穿透（悬停在面板上则保持可交互）
    setInteractive(!!(panel && panel.matches(':hover')));
  }

  function attachMenu(menu: HTMLDivElement): void {
    menuOpen = true;
    setInteractive(true); // 菜单可点击（含穿透恢复）
    document.body.appendChild(menu);
    ctxMenu = menu;
    void menu.offsetWidth; // 强制同步样式计算：先提交初始态（opacity:0），确保 .show 触发 transition
    requestAnimationFrame(() => menu.classList.add('show')); // linear 弹出
    // 延迟注册，避免与打开菜单的右键 mousedown 冲突导致立刻关闭
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  }

  // 条目右键菜单（置顶/取消置顶）
  function showRowCtxMenu(x: number, y: number, key: string): void {
    closeCtxMenu();
    const isPinned = (pinnedChats || []).includes(key);
    const menu = document.createElement('div');
    menu.className = 'fb-ctx';
    menu.innerHTML = `<div class="fb-ctx-item" data-act="pin">${isPinned ? '取消置顶' : '📌 置顶'}</div>`;
    // clamp 防溢出面板窗
    menu.style.left = `${Math.max(6, Math.min(x, PANEL_W - 160))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, PANEL_H - 120))}px`;
    attachMenu(menu);
    menu.querySelector('[data-act="pin"]')?.addEventListener('click', () => {
      closeCtxMenu();
      void savePin(key);
    });
  }

  // ===== 主进程推送：弹出 / 收回 / 换向重弹 =====
  if (api && api.onPanelShow) {
    api.onPanelShow((d: Dir) => {
      closeCtxMenu(); // 面板重弹前清掉残留菜单（如失焦期间未关）
      setRootDir(d?.h || 'right', d?.v || 'down');
      panelShown = true;
      void fetchChats(); // 每次展开都拉取最新聊天列表
      requestAnimationFrame(() => panel.classList.add('show')); // linear 弹出
    });
  }
  if (api && api.onPanelHide) {
    api.onPanelHide(() => {
      panelShown = false;
      panel.classList.remove('show'); // linear 收回（窗口由主进程在动画播完后 hide）
    });
  }
  if (api && api.onPanelLayout) {
    api.onPanelLayout((d: Dir) => {
      // 拖动中换向第二阶段：按新方向镜像布局并重播弹出动画（面板窗已由主进程换位）
      closeCtxMenu();
      setRootDir(d?.h || 'right', d?.v || 'down');
      panelShown = true;
      void fetchChats();
      panel.classList.remove('show');
      void panel.offsetWidth; // 强制 reflow：确保收回态生效后再重弹
      requestAnimationFrame(() => panel.classList.add('show')); // linear 重新弹出
    });
  }

  // ===== hover 上报 =====
  let lastMoveReport = 0;
  // 面板窗内任意 mousemove（含 forward 转发的透明内边距区移动）都视为悬停面板：
  // 覆盖球→面板跨窗时 14px 内边距过渡带，杜绝 160ms 防抖窗口内的误收起（100ms 节流）。
  document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMoveReport < 100) return;
    lastMoveReport = now;
    if (api?.panelHoverPanel) api.panelHoverPanel(true);
  });
  panel.addEventListener('mouseenter', () => {
    setInteractive(true);
    if (api?.panelHoverPanel) api.panelHoverPanel(true);
  });
  panel.addEventListener('mouseleave', () => {
    if (menuOpen) return; // 光标移入菜单（菜单不在 .fb-panel 子树）：菜单打开期间不上报离开
    if (api?.panelHoverPanel) api.panelHoverPanel(false);
    setInteractive(false);
  });
  // 失焦：收起菜单（主进程 blur 链路已统一走防抖收起）
  if (api && api.onBallBlur) api.onBallBlur(() => closeCtxMenu());

  setupTheme(() => {
    // 主窗口改了置顶/拖动顺序时，悬浮球面板同步刷新排序
    if (api && api.getChatList) void fetchChats();
  });
  void fetchChats(); // 首屏拉取一次，保证首次展开即有数据
}

// ===================== 菜单窗渲染端 =====================
// 球右键应用菜单（退出/本次关闭/置顶）独立窗口。动画与面板一致：linear 0.16s 弹出/缩入。
// 关闭链路三来源：① 菜单项点击 / 窗内菜单区外 mousedown（本地播缩入 + menuHideDone）
// ② 主进程光标轮询超时推送 menu:hide → 缩入动画 → menuHideDone（主进程 hide 窗口）
// ③ 全屏隐藏/销毁由主进程直接 hide（无动画，不经本渲染端）。
function mountMenu(): void {
  injectCSS();
  const root = document.getElementById('root') as HTMLElement;

  const host = document.createElement('div');
  host.className = 'fb-ctx-menu-host'; // 铺满菜单窗，菜单固定在窗内 (10,10) 附近
  const ctx = document.createElement('div');
  ctx.className = 'fb-ctx';
  let aot = true;
  if (api && api.getSettings) {
    api.getSettings().then((s: any) => {
      aot = s?.floatingBall?.alwaysOnTop !== false;
      const chk = ctx.querySelector<HTMLInputElement>('.fb-ctx-aot');
      if (chk) chk.checked = aot;
    }).catch(() => {});
  }
  ctx.innerHTML = `
    <div class="fb-ctx-item" data-act="quit">退出念语</div>
    <div class="fb-ctx-item" data-act="close">本次关闭悬浮球</div>
    <label class="fb-ctx-item fb-ctx-aot-row">
      <input type="checkbox" class="fb-ctx-aot" ${aot ? 'checked' : ''}/>
      <span>悬浮球置顶</span>
    </label>`;
  ctx.style.left = '10px';
  ctx.style.top = '10px';
  host.appendChild(ctx);
  root.appendChild(host);

  setupTheme();

  // 菜单窗初始整体穿透（主进程 show 时重置），窗内 mousemove（含 forward 转发）→ 切回可交互
  // （与 mountPanel 对齐：100ms 节流，避免 menuIgnore IPC 高频风暴）
  const setInteractive = makeInteractive(api?.menuIgnore);
  let lastMoveReport = 0;
  document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMoveReport < 100) return;
    lastMoveReport = now;
    setInteractive(true);
  });

  // ===== 缩入动画 + 完成回发（hidePending 幂等守卫：一次关闭只播一次缩入、只回发一次）=====
  let hideTimer = 0;
  let hidePending = false;
  function playHideAnim(): void {
    if (hidePending) return;
    hidePending = true;
    ctx.classList.remove('show'); // linear 缩入（160ms）
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      hidePending = false;
      if (api?.menuHideDone) api.menuHideDone();
    }, MENU_HIDE_ANIM_MS);
  }

  // 主进程推送：弹出 / 收回
  if (api && api.onMenuShow) {
    api.onMenuShow(() => {
      // 右键重入：作废进行中的缩入动画，避免迟到的 menu:hide-done 误关刚重开的菜单
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = 0;
      }
      hidePending = false;
      ctx.classList.remove('show'); // 先复位（全屏隐藏等路径不经 menu:hide，可能残留 .show），确保每次弹出都重播动画
      void ctx.offsetWidth; // 强制 flush：窗口隐藏期初始态可能未提交，确保 .show 触发 transition
      requestAnimationFrame(() => ctx.classList.add('show')); // linear 弹出
    });
  }
  if (api && api.onMenuHide) {
    api.onMenuHide(() => playHideAnim());
  }

  // 窗内 mousedown：点在菜单 DOM 外（窗内边距）→ 本地播缩入 + menuHideDone
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!ctx.contains(e.target as Node)) playHideAnim();
    },
    true
  );

  // 菜单项点击：执行动作 + 关菜单（走缩入流程；置顶 checkbox 切换不关菜单）
  ctx.querySelector('[data-act="quit"]')?.addEventListener('click', () => {
    playHideAnim();
    if (api?.ballQuit) api.ballQuit();
  });
  ctx.querySelector('[data-act="close"]')?.addEventListener('click', () => {
    playHideAnim();
    if (api?.ballCloseSession) api.ballCloseSession();
  });
  ctx.querySelector<HTMLInputElement>('.fb-ctx-aot')?.addEventListener('change', (e) => {
    if (api?.ballSetAlwaysOnTop) api.ballSetAlwaysOnTop((e.target as HTMLInputElement).checked);
  });
}

// ===== 入口：按 query role 分支挂载 =====
const role = new URLSearchParams(location.search).get('role') || 'ball';
if (role === 'panel') mountPanel();
else if (role === 'menu') mountMenu();
else mountBall();

// ===== 动态光标（CustomCursor，球窗/面板窗各自独立挂载/gate）=====
// 悬浮球两窗均为原生 DOM 窗口，无 React 根。单独挂一个 React 根只为渲染
// <ThemeProvider> + <CustomCursor>，光标画布 portal 到 document.body（pointer-events:none，
// 不影响透明区的鼠标穿透）。配置与总开关复用 settings.customCursor，与主界面/小窗一致。
// 菜单窗（role=menu）不挂载：菜单窗无动态光标需求，减少复杂度。
function mountCursor(): void {
  try {
    // 初始即为穿透区（鼠标不在球/面板上）：门控开启，动态光标不显示、原生光标不受影响
    document.body.classList.add('cursor-gate-off');
    let host = document.getElementById('cursor-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cursor-root';
      host.style.position = 'fixed';
      host.style.inset = '0';
      host.style.pointerEvents = 'none';
      host.style.zIndex = '2147483646';
      document.body.appendChild(host);
    }
    const cursorRoot = createRoot(host);
    cursorRoot.render(
      React.createElement(ThemeProvider, null, React.createElement(CustomCursor)),
    );
  } catch (e) {
    console.error('[floating-ball] mount Cursor failed', e);
  }
}

if (role !== 'menu') mountCursor();
