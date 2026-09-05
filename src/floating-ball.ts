// 念语 · 桌面悬浮球（独立透明窗口渲染端）
// 交互区域：主进程 setIgnoreMouseEvents(true,{forward:true}) 使透明区穿透到下层窗口，
// 本端在悬浮球/面板上方时切回可交互（ballSetIgnore(false)），离开时恢复穿透。
// 拖拽：主进程每 16ms 轮询系统光标直接 setPosition，渲染端仅发出起止信号。
import './theme/variables.css';

const api = (window as any).api;

const WIN_W = 320;
const WIN_H = 460;
const BALL = 60;
const BALL_L = 18; // 球相对窗口左上内边距
const BALL_T = 18;

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

function baseCSS(): string {
  return `
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
    -webkit-user-select:none;user-select:none;}
  #root{width:100%;height:100%;position:relative;}

  .fb-ball{position:absolute;left:${BALL_L}px;top:${BALL_T}px;width:${BALL}px;height:${BALL}px;
    border-radius:50%;cursor:grab;
    background:var(--color-primary);
    display:flex;align-items:center;justify-content:center;
    transition:transform .12s ease;}
  .fb-ball:active{cursor:grabbing;transform:scale(.94);}
  .fb-ball svg{width:30px;height:30px;fill:var(--color-primary-text);}
  .fb-ball.dragging{cursor:grabbing;transform:scale(.96);}

  .fb-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;
    box-sizing:border-box;border-radius:9px;background:#ff4d4f;color:#fff;
    font-size:11px;font-weight:700;line-height:18px;text-align:center;
    border:2px solid var(--color-bg);}

  .fb-panel{position:absolute;left:${BALL_L}px;top:${BALL_T + BALL + 12}px;width:${WIN_W - BALL_L * 2}px;
    max-height:${WIN_H - (BALL_T + BALL + 12) - 14}px;box-sizing:border-box;
    background:var(--color-panel);backdrop-filter:blur(var(--blur));-webkit-backdrop-filter:blur(var(--blur));
    border:1px solid var(--color-border);border-radius:var(--radius);
    color:var(--color-text);display:flex;flex-direction:column;overflow:hidden;
    opacity:0;transform:translateY(-8px) scale(.98);pointer-events:none;
    transition:opacity .16s ease, transform .16s ease;}
  .fb-panel.show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}
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
  .fb-empty{padding:22px 12px;text-align:center;font-size:12.5px;color:var(--color-text-secondary);}
  .fb-foot{padding:8px 14px 10px;font-size:11px;color:var(--color-text-secondary);text-align:center;border-top:1px solid var(--color-border);}

  /* 右键菜单（跟随主题，弹出浮层保留轻阴影用于层级区分） */
  .fb-ctx{position:absolute;z-index:50;min-width:150px;box-sizing:border-box;
    background:var(--color-panel);backdrop-filter:blur(var(--blur));-webkit-backdrop-filter:blur(var(--blur));
    border:1px solid var(--color-border);border-radius:var(--radius-sm);
    color:var(--color-text);font-size:13px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,0.28);}
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

function mount(): void {
  const styleEl = document.createElement('style');
  document.head.appendChild(styleEl);
  styleEl.textContent = baseCSS();

  const root = document.getElementById('root') as HTMLElement;

  // 面板状态（提升到 mount 顶部，避免被闭包在 TDZ 期间引用）
  let unreadCount = 0;
  let panelOpen = false;
  let dragging = false;
  let chatList: ChatItem[] = [];

  const ball = document.createElement('div');
  ball.className = 'fb-ball';
  ball.title = '左键打开念语 · 右键退出';
  ball.innerHTML = ballSVG();
  const badge = document.createElement('div');
  badge.className = 'fb-badge';
  badge.style.display = 'none';
  ball.appendChild(badge);
  root.appendChild(ball);

  const panel = document.createElement('div');
  panel.className = 'fb-panel';
  root.appendChild(panel);

  // ===== 主题同步 =====
  function applyTheme(theme?: string): void {
    document.documentElement.setAttribute('data-theme', theme || 'wechat');
  }
  function refreshTheme(): void {
    if (api && api.getSettings) {
      api.getSettings().then((s: any) => applyTheme(s?.theme)).catch(() => {});
    }
  }
  refreshTheme();
  if (api && api.onSettingsChanged) {
    api.onSettingsChanged(() => refreshTheme());
  }

  // ===== 未读角标（保留：后台来消息仍给角标提示）=====
  function renderBadge(): void {
    if (unreadCount > 0) {
      badge.style.display = 'block';
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    } else {
      badge.style.display = 'none';
    }
  }

  // ===== 拉取聊天列表（单聊 + 群聊）=====
  function fetchChats(): void {
    if (api && api.getChatList) {
      api.getChatList().then((list: ChatItem[]) => {
        chatList = list || [];
        if (panelOpen) renderPanel();
      }).catch(() => {});
    }
  }

  function renderPanel(): void {
    if (chatList.length === 0) {
      panel.innerHTML = `<div class="fb-panel-h"><span>快捷聊天</span></div>
        <div class="fb-empty">暂无可切换的聊天</div>
        <div class="fb-foot">滚轮可滚动查看更多 · 右键悬浮球可退出念语</div>`;
      return;
    }
    const rows = chatList
      .map((it) => {
        const isGroup = it.chat_type === 'group';
        const name = it.chat_name || it.name;
        const tag = isGroup ? '群聊' : '单聊';
        return `<div class="fb-row" data-chat='${JSON.stringify({
          chatType: it.chat_type,
          chatId: it.chat_id,
          name,
        }).replace(/'/g, '&#39;')}'>
          <div class="fb-av" data-av="${it.avatar_path || ''}">${(name || '?').trim().charAt(0) || '?'}</div>
          <div class="fb-row-body">
            <div class="fb-row-name">${escapeHTML(name)}</div>
            <div class="fb-row-content">${isGroup ? '👥 ' : '💬 '}${escapeHTML(tag)}${it.last_message ? ' · ' + escapeHTML(it.last_message) : ''}</div>
          </div>
        </div>`;
      })
      .join('');
    panel.innerHTML = `<div class="fb-panel-h"><span>快捷聊天</span><span class="cnt">${chatList.length}</span></div>
      <div class="fb-list">${rows}</div>
      <div class="fb-foot">滚轮可滚动查看更多 · 右键悬浮球可退出念语</div>`;

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

    panel.querySelectorAll<HTMLElement>('.fb-row').forEach((row) => {
      row.addEventListener('click', () => {
        try {
          const chat = JSON.parse(row.getAttribute('data-chat') || '{}');
          hidePanel();
          if (api?.ballOpenChat) api.ballOpenChat(chat);
        } catch {
          /* ignore */
        }
      });
    });
  }

  function escapeHTML(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)
    );
  }

  function showPanel(): void {
    if (panelOpen) return;
    panelOpen = true;
    fetchChats(); // 每次展开都拉取最新聊天列表
    renderPanel();
    requestAnimationFrame(() => panel.classList.add('show'));
    setInteractive(true);
  }
  function hidePanel(): void {
    if (!panelOpen) return;
    panelOpen = false;
    panel.classList.remove('show');
  }

  function setInteractive(on: boolean): void {
    if (api?.ballSetIgnore) api.ballSetIgnore(!on);
  }

  // 未读仅用于角标提示（保留原有后台消息提示能力），不再渲染未读列表
  function onUnread(data: { count: number; items: UnreadItem[] }): void {
    unreadCount = data.count || 0;
    renderBadge();
  }

  if (api && api.onBallUnread) api.onBallUnread((_e: any, data: any) => onUnread(data));
  if (api && api.onBallBlur) api.onBallBlur(() => { hidePanel(); closeCtxMenu(); });
  if (api && api.ballGetUnread) {
    api.ballGetUnread().then((d: any) => onUnread(d)).catch(() => {});
  }
  fetchChats(); // 首屏拉取一次，保证首次 hover 即有数据

  // ===== 拖拽 + 点击 + 右键 =====
  ball.addEventListener('mouseenter', () => {
    setInteractive(true);
    showPanel();
  });
  ball.addEventListener('mouseleave', () => {
    if (panelOpen) {
      window.setTimeout(() => {
        if (!panel.matches(':hover') && !ball.matches(':hover')) hidePanel();
      }, 160);
    }
    if (!panelOpen) setInteractive(false);
  });

  panel.addEventListener('mouseenter', () => setInteractive(true));
  panel.addEventListener('mouseleave', () => {
    if (!ball.matches(':hover')) {
      hidePanel();
      setInteractive(false);
    }
  });

  // ===== 右键菜单 =====
  let ctxMenu: HTMLDivElement | null = null;
  function closeCtxMenu(): void {
    if (ctxMenu) {
      ctxMenu.remove();
      ctxMenu = null;
    }
    document.removeEventListener('mousedown', onDocDown, true);
  }
  function onDocDown(e: MouseEvent): void {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
  }
  function showCtxMenu(x: number, y: number): void {
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'fb-ctx';
    let aot = true;
    if (api && api.getSettings) {
      api.getSettings().then((s: any) => {
        aot = s?.floatingBall?.alwaysOnTop !== false;
        const chk = menu.querySelector<HTMLInputElement>('.fb-ctx-aot');
        if (chk) chk.checked = aot;
      }).catch(() => {});
    }
    menu.innerHTML = `
      <div class="fb-ctx-item" data-act="quit">退出念语</div>
      <div class="fb-ctx-item" data-act="close">本次关闭悬浮球</div>
      <label class="fb-ctx-item fb-ctx-aot-row">
        <input type="checkbox" class="fb-ctx-aot" ${aot ? 'checked' : ''}/>
        <span>悬浮球置顶</span>
      </label>`;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.appendChild(menu);
    ctxMenu = menu;
    menu.querySelector('[data-act="quit"]')?.addEventListener('click', () => {
      closeCtxMenu();
      if (api?.ballQuit) api.ballQuit();
    });
    menu.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      closeCtxMenu();
      if (api?.ballCloseSession) api.ballCloseSession();
    });
    menu.querySelector<HTMLInputElement>('.fb-ctx-aot')?.addEventListener('change', (e) => {
      if (api?.ballSetAlwaysOnTop) api.ballSetAlwaysOnTop((e.target as HTMLInputElement).checked);
    });
    // 延迟注册，避免与本次右键的 mousedown 冲突导致立刻关闭
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  }

  ball.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY);
  });

  ball.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setInteractive(true);
    dragging = true;
    ball.classList.add('dragging');
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
        if (api?.ballActivate) api.ballActivate();
        hidePanel();
      }
      if (!ball.matches(':hover') && !panelOpen) setInteractive(false);
    };
    if (api?.ballDragEnd) {
      Promise.resolve(api.ballDragEnd()).then(finish).catch(() => finish(false));
    } else {
      finish(false);
    }
  }
}

mount();
