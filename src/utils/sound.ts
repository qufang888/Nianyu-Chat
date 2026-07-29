import { api, setBeforeConfirm } from '../ipc';

export type SoundType = 'error' | 'click' | 'notification' | 'popup' | 'miniPopup' | 'messageSend';

// 内置音效：使用相对路径，同时兼容生产环境（file:// 加载 dist/index.html）
// 与开发环境（vite dev server http://localhost:5173）两种加载方式。
const BUILTIN: Record<SoundType, string | string[]> = {
  error: 'sounds/audley_fergine-ui-button-click-5-327756.mp3',
  click: 'sounds/dragon-studio-mouse-click-sfx-free-376869.mp3',
  notification: [
    'sounds/universfield-new-notification-012-363675.mp3',
    'sounds/universfield-new-notification-021-370045.mp3',
    'sounds/universfield-new-notification-022-370046.mp3',
    'sounds/universfield-new-notification-026-380249.mp3',
    'sounds/universfield-new-notification-036-485897.mp3',
  ],
  popup: 'sounds/弹窗提示音.mp3',
  miniPopup: 'sounds/小窗弹出音.mp3',
  messageSend: 'sounds/消息发送.mp3',
};

// 用户自定义音效通过 nysound:// 协议读取（主进程映射到 userData/custom-sounds 目录）
const NY_SCHEME = 'nysound://';

export interface SoundCustom {
  error: string | null;
  click: string | null;
  notification: string | null;
  popup: string | null;
  miniPopup: string | null;
  messageSend: string | null;
}

interface SoundSettings {
  enabled: boolean;
  volume: number;
  custom: SoundCustom;
  silent: boolean;
}

let cached: SoundSettings | null = null;
let cacheAt = 0;
const CACHE_TTL = 3000;

function defaultCustom(): SoundCustom {
  return { error: null, click: null, notification: null, popup: null, miniPopup: null, messageSend: null };
}

async function getSettings(): Promise<SoundSettings> {
  const now = Date.now();
  if (cached && now - cacheAt < CACHE_TTL) return cached;
  try {
    const s = await api.getSettings();
    cached = {
      enabled: s.sound?.enabled !== false,
      volume: Math.max(0, Math.min(1, s.sound?.volume ?? 0.7)),
      custom: { ...defaultCustom(), ...(s.sound?.custom || {}) },
      silent: s.silent === true,
    };
  } catch {
    cached = { enabled: true, volume: 0.7, custom: defaultCustom(), silent: false };
  }
  cacheAt = now;
  return cached;
}

export function invalidateSoundCache(): void {
  cached = null;
}

function pickBuiltin(type: SoundType): string {
  const files = BUILTIN[type];
  if (Array.isArray(files)) return files[Math.floor(Math.random() * files.length)];
  return files;
}

/**
 * 解析最终播放 URL：
 * 1) 角色自定义消息音效（characterSound）最高优先
 * 2) 设置中该类型的全局自定义音效
 * 3) 内置默认音效
 */
export async function resolveSoundUrl(
  type: SoundType,
  characterSound?: string | null
): Promise<string> {
  const s = await getSettings();
  if (characterSound) return NY_SCHEME + characterSound;
  const custom = s.custom?.[type];
  if (custom) return NY_SCHEME + custom;
  return pickBuiltin(type);
}

/**
 * 播放音效。
 * @param opts.characterSound 角色级自定义消息音效文件名（仅 notification 类型有意义）
 * @param opts.force 为 true 时忽略「音效总开关」（用于试听）
 */
export async function playSound(
  type: SoundType,
  opts?: { characterSound?: string | null; force?: boolean }
): Promise<void> {
  const s = await getSettings();
  if (!opts?.force && (!s.enabled || s.volume <= 0)) return;
  // 静默模式：仅暂停消息提示音；点击音、报错音等仍正常播放（force 试听不受静默影响）
  if (type === 'notification' && s.silent && !opts?.force) return;
  const url = await resolveSoundUrl(type, opts?.characterSound);
  const audio = new Audio(url);
  audio.volume = s.volume;
  try {
    await audio.play();
  } catch {
    // 自动播放策略 / 文件缺失等情况下静默处理，不打扰用户
  }
}

export function playSoundSync(type: SoundType, opts?: { characterSound?: string | null }): void {
  void playSound(type, opts);
}

/** 试听：忽略「音效总开关」，但尊重音量设置（设置页 / 角色页预览用） */
export async function previewSound(type: SoundType, characterSound?: string | null): Promise<void> {
  const s = await getSettings();
  const url = await resolveSoundUrl(type, characterSound);
  const audio = new Audio(url);
  audio.volume = s.volume > 0 ? s.volume : 0.7;
  try {
    await audio.play();
  } catch {
    // 试听失败静默
  }
}

/**
 * 全局点击音效覆盖的可交互元素选择器。
 * 设计原则：仅对「真正可点击/可交互」的元素发声；点击纯空白容器（div/section/span/p 等）
 * 不会匹配，因此「空白界面的无效点击」天然不触发音效。
 */
const CLICK_SOUND_SELECTOR = [
  'button',
  '[role="button"]',
  'a',
  'summary',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'label',
  '.tool-btn',
  '.btn-primary',
  '.btn-ghost',
  '.btn-danger',
  '.mini-btn',
  '.modal-close',
  '.ctx-menu-item',
  '.nav-item', // 左侧栏导航（通讯录等）
  '.nav-lang button',
  '.list-item',
  '.clickable',
  '[data-clickable]',
  '.role-card',
  '.chat-item',
  'li',
  '.tab',
  '.toggle',
  '.switch',
].join(', ');

/**
 * 安装全局音效监听器：
 * 命中 CLICK_SOUND_SELECTOR 的任意可交互元素点击时播放 UI 点击音。
 * 应在应用顶层组件挂载后调用一次（主窗口与小窗共用同一入口）。
 */
export function installGlobalSoundListeners(): () => void {
  // 注册 showConfirm 前置钩子（弹窗提示音）
  setBeforeConfirm(() => playSoundSync('popup'));
  const onDocClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const el = target.closest(CLICK_SOUND_SELECTOR);
    if (el) playSoundSync('click');
  };
  document.addEventListener('click', onDocClick);
  return () => document.removeEventListener('click', onDocClick);
}
