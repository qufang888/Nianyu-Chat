import { api, setBeforeConfirm } from '../ipc';

export type SoundType = 'error' | 'click' | 'notification' | 'popup' | 'miniPopup' | 'messageSend';

/**
 * 音效主题（v2.3.111）。
 *
 * `default` = 既有经典音效（public/sounds/*.wav，v2.3.97 程序合成）；
 * 其余 5 套为程序合成的主题包（public/sounds/themes/<id>/*.wav），
 * 每套覆盖全部 6 类音效，由 scripts/gen-builtin-sounds.mjs 生成。
 *
 * 解析优先级（resolveSoundUrl）：角色自定义 > 该类型用户自定义（nysound://）
 * > 主题音效文件 > 内置 default 兜底。
 */
export type SoundTheme = 'default' | 'aurora' | 'crystal' | 'wood' | 'bubble' | 'chime';

/** 全部内置主题 id（出厂顺序即设置页展示顺序；default 必须是第一项） */
export const SOUND_THEMES: SoundTheme[] = ['default', 'aurora', 'crystal', 'wood', 'bubble', 'chime'];

/** 主题名 i18n 键（设置页主题选择器用） */
export const SOUND_THEME_LABEL_KEYS: Record<SoundTheme, string> = {
  default: 'settings.soundThemeDefault',
  aurora: 'settings.soundThemeAurora',
  crystal: 'settings.soundThemeCrystal',
  wood: 'settings.soundThemeWood',
  bubble: 'settings.soundThemeBubble',
  chime: 'settings.soundThemeChime',
};

/** 6 类音效的文件名（不含目录；与 BUILTIN 的键一一对应） */
const SOUND_FILE_NAMES: Record<SoundType, string> = {
  error: 'error.wav',
  click: 'click.wav',
  notification: 'notification.wav',
  popup: 'popup.wav',
  miniPopup: 'miniPopup.wav',
  messageSend: 'messageSend.wav',
};

// 内置音效：使用相对路径，同时兼容生产环境（file:// 加载 dist/index.html）
// 与开发环境（vite dev server http://localhost:5173）两种加载方式。
//
// v2.3.97 安全处置：此前这里是 11 个第三方音效站的 mp3
//（`audley_fergine-*` / `dragon-studio-*` / `universfield-*`）。
// 作者已无法回忆下载站点，无法确认许可是否允许**原样再分发**；
// 而此类站点的通行条款（Pixabay Content License 为例）明文禁止
// "sell or redistribute the sound effects as they are"。
// 念语把 mp3 提交进 git 并随安装包分发，正落在该禁止条款内 ——
// 这是本项目唯一有实质法律风险的项，故已全部替换。
//
// 现用 `scripts/gen-builtin-sounds.mjs` **程序合成**（正弦/三角/方波 + 指数包络，
// 纯数学波形，不含任何采样素材）→ 不触发任何第三方许可，作者本人即著作权人。
// 旧的 11 个 mp3 已从仓库与 public/sounds 删除，不再随安装包分发。
const BUILTIN: Record<SoundType, string | string[]> = {
  error: 'sounds/error.wav',
  click: 'sounds/click.wav',
  notification: 'sounds/notification.wav',
  popup: 'sounds/popup.wav',
  miniPopup: 'sounds/miniPopup.wav',
  messageSend: 'sounds/messageSend.wav',
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
  /** v2.3.111：音效主题（出厂 'default'；老 settings / 脏数据由 isSoundTheme 回退） */
  theme: SoundTheme;
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
      theme: isSoundTheme(s.sound?.theme) ? (s.sound?.theme as SoundTheme) : 'default',
    };
  } catch {
    cached = { enabled: true, volume: 0.7, custom: defaultCustom(), silent: false, theme: 'default' };
  }
  cacheAt = now;
  return cached;
}

/** 主题 id 合法性校验（老 settings / 脏数据一律回退 'default'） */
function isSoundTheme(v: unknown): v is SoundTheme {
  return typeof v === 'string' && (SOUND_THEMES as string[]).includes(v);
}

export function invalidateSoundCache(): void {
  cached = null;
}

function pickBuiltin(type: SoundType, theme: SoundTheme = 'default'): string {
  // v2.3.111：主题音效文件（default 主题没有独立目录，直接用根下的经典音效）
  if (theme !== 'default') return `sounds/themes/${theme}/${SOUND_FILE_NAMES[type]}`;
  const files = BUILTIN[type];
  if (Array.isArray(files)) return files[Math.floor(Math.random() * files.length)];
  return files;
}

/**
 * 解析最终播放 URL：
 * 1) 角色自定义消息音效（characterSound）最高优先
 * 2) 设置中该类型的全局自定义音效
 * 3) 主题音效文件（v2.3.111；非 default 主题）
 * 4) 内置默认音效（兜底）
 *
 * @param opts.theme 主题覆盖（试听指定主题用）；缺省读设置里的当前主题
 */
export async function resolveSoundUrl(
  type: SoundType,
  characterSound?: string | null,
  opts?: { theme?: SoundTheme }
): Promise<string> {
  const s = await getSettings();
  if (characterSound) return NY_SCHEME + characterSound;
  const custom = s.custom?.[type];
  if (custom) return NY_SCHEME + custom;
  const theme = opts?.theme ?? s.theme;
  return pickBuiltin(type, theme);
}

/**
 * 播放音效。
 * @param opts.characterSound 角色级自定义消息音效文件名（仅 notification 类型有意义）
 * @param opts.force 为 true 时忽略「音效总开关」（用于试听）
 * @param opts.theme 主题覆盖（试听指定主题用）；缺省用设置里的当前主题
 */
export async function playSound(
  type: SoundType,
  opts?: { characterSound?: string | null; force?: boolean; theme?: SoundTheme }
): Promise<void> {
  const s = await getSettings();
  if (!opts?.force && (!s.enabled || s.volume <= 0)) return;
  // 静默模式：仅暂停消息提示音；点击音、报错音等仍正常播放（force 试听不受静默影响）
  if (type === 'notification' && s.silent && !opts?.force) return;
  const url = await resolveSoundUrl(type, opts?.characterSound, { theme: opts?.theme });
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

// 剧情节点横幅音效（v2.3.37）：固定内置文件（public/sounds/），跟随音效总开关与音量；
// 不进自定义音效类型系统，避免牵连设置页 UI。
// v2.3.97：同 BUILTIN 的安全处置，改用程序合成音（原为 universfield-achievement-unlock-*.mp3）。
const NODE_BANNER_SOUND = 'sounds/nodeBanner.wav';
export async function playNodeBannerSound(): Promise<void> {
  const s = await getSettings();
  if (!s.enabled || s.volume <= 0) return;
  const audio = new Audio(NODE_BANNER_SOUND);
  audio.volume = s.volume;
  try {
    await audio.play();
  } catch {
    /* 自动播放策略/文件缺失时静默 */
  }
}

/**
 * 试听：忽略「音效总开关」，但尊重音量设置（设置页 / 角色页预览用）。
 * @param theme 试听指定主题的音效（v2.3.111 主题选择器用）；缺省 = 当前设置的主题
 */
export async function previewSound(
  type: SoundType,
  characterSound?: string | null,
  theme?: SoundTheme
): Promise<void> {
  const s = await getSettings();
  const url = await resolveSoundUrl(type, characterSound, { theme });
  const audio = new Audio(url);
  audio.volume = s.volume > 0 ? s.volume : 0.7;
  try {
    await audio.play();
  } catch {
    // 试听失败静默
  }
}

/**
 * 直接试听某个**主题包**自带的音效（v2.3.111 主题选择器用）。
 *
 * 与 {@link previewSound} 的区别：**绕过**自定义音效与角色音效的解析，
 * 只播主题包文件本身 —— 用户要听的是「这套主题的声音」，而不是
 * 「应用了自定义文件之后的效果」。主题文件缺失时 play() 失败静默
 * （浏览器对 404 音频不抛异常，只是不出声）。
 */
export async function previewThemeSound(
  theme: SoundTheme,
  type: SoundType = 'messageSend'
): Promise<void> {
  const s = await getSettings();
  const audio = new Audio(pickBuiltin(type, theme));
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
