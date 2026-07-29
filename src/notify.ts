// 念语 · 后台消息提醒卡片（独立透明窗口，使用 window.api 与主进程通信）
// 仅在「主界面与小窗均未打开/最小化、软件在后台运行」时由主进程弹出。
// 卡片自动适配系统主题（浅色/深色），色调与主界面一致。
import { playSoundSync, invalidateSoundCache } from './utils/sound';
const api = (window as any).api;

const CARD_W = 340;
const CARD_H = 96;

/** 深色系主题列表（其余为浅色系） */
const DARK_THEMES = new Set(['dark', 'glass', 'galaxy', 'cyber', 'ember']);

/** 根据主题名判断是否深色 */
function isDarkTheme(theme?: string): boolean {
  return !!theme && DARK_THEMES.has(theme);
}

/** 生成主题适配的卡片 CSS */
function cardCSS(dark: boolean): string {
  if (dark) {
    return `
    .ny-card{position:absolute;right:0;bottom:0;width:${CARD_W}px;height:${CARD_H}px;box-sizing:border-box;
      background:linear-gradient(135deg,rgba(32,34,42,.95),rgba(20,22,28,.95));
      backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border:1px solid rgba(255,255,255,.08);border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.18);
      color:#eee;padding:12px 14px 12px 12px;
      display:flex;flex-direction:row;align-items:center;gap:12px;cursor:pointer;
      transform:translateX(380px);opacity:0;
      transition:transform .42s cubic-bezier(.22,.61,.36,1),opacity .42s linear;}
    .ny-card.show{transform:translateX(0);opacity:1;}
    .ny-card.hide{transform:translateX(380px);opacity:0;}
    .ny-avatar{flex:0 0 auto;width:46px;height:46px;border-radius:50%;
      background:linear-gradient(135deg,#5ad1a8,#3a8fd0);display:flex;align-items:center;justify-content:center;
      font-size:20px;font-weight:700;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);}
    .ny-body{position:relative;flex:1 1 auto;min-width:0;display:flex;flex-direction:column;
      justify-content:center;gap:3px;}
    .ny-label{font-size:10px;letter-spacing:.8px;color:#6fe3c0;text-transform:uppercase;opacity:.92;}
    .ny-name{font-size:14px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;}
    .ny-content{font-size:12.5px;color:rgba(255,255,255,.78);line-height:1.35;overflow:hidden;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
    .ny-close{position:absolute;top:-2px;right:0;width:22px;height:22px;border-radius:50%;
      background:rgba(255,255,255,.10);color:rgba(255,255,255,.7);font-size:15px;line-height:22px;text-align:center;
      cursor:pointer;transition:background .15s;}
    .ny-close::after{content:'';position:absolute;inset:-10px;}
    .ny-close:hover{background:rgba(255,255,255,.22);}`;
  }
  // 浅色模式：白色基底 + 柔和灰影，与系统浅色风格协调
  return `
    .ny-card{position:absolute;right:0;bottom:0;width:${CARD_W}px;height:${CARD_H}px;box-sizing:border-box;
      background:linear-gradient(135deg,rgba(255,255,255,.97),rgba(248,250,252,.96));
      backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border:1px solid rgba(0,0,0,.07);border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,.10),0 2px 8px rgba(0,0,0,.05);
      color:#1a1a1a;padding:12px 14px 12px 12px;
      display:flex;flex-direction:row;align-items:center;gap:12px;cursor:pointer;
      transform:translateX(380px);opacity:0;
      transition:transform .42s cubic-bezier(.22,.61,.36,1),opacity .42s linear;}
    .ny-card.show{transform:translateX(0);opacity:1;}
    .ny-card.hide{transform:translateX(380px);opacity:0;}
    .ny-avatar{flex:0 0 auto;width:46px;height:46px;border-radius:50%;
      background:linear-gradient(135deg,#5ad1a8,#3a8fd0);display:flex;align-items:center;justify-content:center;
      font-size:20px;font-weight:700;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.12);}
    .ny-body{position:relative;flex:1 1 auto;min-width:0;display:flex;flex-direction:column;
      justify-content:center;gap:3px;}
    .ny-label{font-size:10px;letter-spacing:.8px;color:#07c160;text-transform:uppercase;opacity:.85;}
    .ny-name{font-size:14px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1a1a1a;}
    .ny-content{font-size:12.5px;color:rgba(0,0,0,.62);line-height:1.35;overflow:hidden;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
    .ny-close{position:absolute;top:-2px;right:0;width:22px;height:22px;border-radius:50%;
      background:rgba(0,0,0,.06);color:rgba(0,0,0,.45);font-size:15px;line-height:22px;text-align:center;
      cursor:pointer;transition:background .15s;}
    .ny-close::after{content:'';position:absolute;inset:-10px;}
    .ny-close:hover{background:rgba(0,0,0,.14);}`;
}

function buildCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ny-card';
  card.innerHTML = `
    <div class="ny-avatar" id="ny-avatar">?</div>
    <div class="ny-body">
      <div class="ny-close" title="关闭">×</div>
      <div class="ny-label" id="ny-label">新消息</div>
      <div class="ny-name" id="ny-name"></div>
      <div class="ny-content" id="ny-content"></div>
    </div>
  `;
  // 鼠标进入卡片区域时取消鼠标穿透，让关闭按钮和卡片点击正常响应；离开时恢复穿透
  card.addEventListener('mouseenter', () => {
    if (api && api.notifyIgnoreMouse) api.notifyIgnoreMouse(false);
  });
  card.addEventListener('mouseleave', () => {
    if (api && api.notifyIgnoreMouse) api.notifyIgnoreMouse(true);
  });
  card.addEventListener('click', (e) => {
    // 点到关闭按钮（含其放大后的命中区）不打开主界面，仅关闭卡片
    const t = e.target as HTMLElement | null;
    if (t && t.closest('.ny-close')) return;
    const chat = (window as any).__nyChat;
    if (chat && api && api.notifyOpen) api.notifyOpen(chat);
  });
  const close = card.querySelector('.ny-close') as HTMLElement;
  close.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (api && api.notifyClose) api.notifyClose();
  });
  // 放大叉号命中区，避免点偏误触卡片主体而打开主界面
  close.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return card;
}

function mount(): void {
  let currentTheme: string | undefined;
  const styleEl = document.createElement('style');
  document.head.appendChild(styleEl);

  /** 根据当前主题刷新卡片样式 */
  function applyTheme(theme?: string): void {
    currentTheme = theme;
    const dark = isDarkTheme(theme);
    styleEl.textContent = `
      html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}
      #root{width:100%;height:100%;}
      ${cardCSS(dark)}
    `;
  }
  // 初始默认浅色（主进程首条消息会携带真实主题）
  applyTheme();

  const root = document.getElementById('root') as HTMLElement;
  const card = buildCard();
  root.appendChild(card);

  const avatarEl = card.querySelector('#ny-avatar') as HTMLElement;
  const labelEl = card.querySelector('#ny-label') as HTMLElement;
  const nameEl = card.querySelector('#ny-name') as HTMLElement;
  const contentEl = card.querySelector('#ny-content') as HTMLElement;

  // 消息提示音效：优先级：聊天自定义 > 角色自定义 > 全局通知音
  async function playNotifySound(chat?: any): Promise<void> {
    let characterSound: string | null = null;
    // 1. 聊天级自定义铃声
    if (chat && chat.soundPath) {
      characterSound = chat.soundPath;
    }
    // 2. 角色级自定义音效（仅单聊）
    else if (chat && chat.chatType === 'single' && chat.chatId && api?.getRole) {
      try {
        const role = (await api.getRole(chat.chatId)) as any;
        characterSound = (role && role.soundPath) || null;
      } catch {
        /* 角色不存在时回退全局通知音 */
      }
    }
    playSoundSync('notification', { characterSound });
  }

  function show(data: any): void {
    // 每次显示时同步主题（支持运行时切换主题后下次弹出即时适配）
    if (data.theme && data.theme !== currentTheme) applyTheme(data.theme);
    // 消息提示音效（角色自定义音效优先）
    void playNotifySound(data.chat);
    (window as any).__nyChat = data.chat;
    labelEl.textContent = data.label || '新消息';
    nameEl.textContent = data.roleName || '';
    contentEl.textContent = data.content || '';
    avatarEl.textContent = (data.roleName || '?').trim().charAt(0) || '?';
    card.classList.remove('hide');
    void card.offsetWidth; // 重启动画
    card.classList.add('show');
  }
  function hide(): void {
    card.classList.remove('show');
    card.classList.add('hide');
  }

  if (api && api.onNotifyData) {
    api.onNotifyData((_e: any, data: any) => {
      if (!data) return;
      if (data.action === 'show') show(data);
      else hide();
    });
  }

  // 静默模式切换后，立即刷新音效缓存，使「关闭通知提示音」即时生效
  if (api && api.onSettingsChanged) {
    api.onSettingsChanged(() => invalidateSoundCache());
  }
}

mount();
