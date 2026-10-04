/**
 * 高级动画控制 —— 单一真源（v2.3.90）
 * ============================================================================
 * 用户需求（互斥二选一，控制「谁来决定动画开关」）：
 *   - 总控模式（master，默认）：唯一的总开关 `settings.enableAnimations` 一次性管全部动画；
 *   - 单控模式（single）：只要用户拨动了**任意一个**单项动画开关就进入本模式，此后
 *     **总控被忽略**，每个动画按自己的开关播放/停止；再次拨动总控开关即回到总控模式。
 *
 * 与既有机制的关系（不要破坏）：
 *   - `.anim-off`（index.css:1861）是总控的全局 kill，语义完全保留；
 *   - 流式/打字机动画（`.stream-char` / `.pseudo-char`）**豁免总控**，本模块
 *     「刻意不把流式动画归入任何分组」，故任何模式下都不会被重新关掉。
 *
 * 门控实现（两条腿并行，缺一不可）：
 *   1. **类名**（总控）：`html.anim-off` —— 只在「总控模式且总开关关闭」时挂。
 *      单控模式下**永不挂**，否则会把仍然开启的分组动画一起杀掉，也会误伤流式豁免。
 *   2. **data 属性 + 生成的 <style>**（单控）：`html[data-anim-off~="<id>"]`，
 *      配合每个 document 一次性注入的规则 `… { animation:none!important; transition:none!important }`。
 *   3. **内联动画**（transition / rAF 补间，CSS 规则管不到）：改读 `isGroupEnabled()`。
 *
 * 每个 document（主窗口 / 小窗 / 悬浮球 / 通知窗）各自独立注入、各自引用自己的选择器，
 * 因此同一个 `ANIM_GROUPS` 定义能同时服务 4 个文档而不必复制大段选择器列表。
 */
import type { AppSettings } from '../types';

/** 文档种类：决定某分组在该文档里用哪套选择器 */
export type AnimDocKind = 'main' | 'floating' | 'notify';

/** 控制模式 */
export type AnimControlMode = 'master' | 'single';

/** 分组定义：id 既是设置里的 key，也是 data-anim-off 里的 token */
export interface AnimGroupDef {
  /** 分组 id（存进 settings.animGroups 的 key） */
  id: string;
  /** i18n 标签 key（`animCtl.group*`） */
  labelKey: string;
  /**
   * 主窗口 / 小窗用的选择器（`src/styles/index.css` 里定义）。
   * 无纯 CSS 动画、只有内联动画的分组留空数组（由 `isGroupEnabled` 负责门控）。
   */
  selectors: string[];
  /** 独立文档专属选择器（悬浮球 / 通知窗的 HTML 与主窗口不是同一套类名） */
  docSelectors?: Partial<Record<AnimDocKind, string[]>>;
}

/**
 * 分组分类法（唯一权威列表）。
 *
 * 注意：**流式/打字机动画不在此列表中** —— 它按设计恒开（豁免总控，且无单项开关）。
 */
export const ANIM_GROUPS: AnimGroupDef[] = [
  {
    id: 'panel',
    labelKey: 'animCtl.groupPanel',
    selectors: [
      '.stories-panel',
      '.msg-action-bar',
      '.scroll-to-bottom',
      '.mini-scroll-to-bottom',
    ],
  },
  {
    id: 'ctxmenu',
    labelKey: 'animCtl.groupCtxmenu',
    selectors: [
      '.ctx-menu',
      '.list-menu',
      '.sel-popup',
      '.more-dropdown',
      '.obs-menu',
      '.obs-config',
      '.select-menu-panel',
      '.chat-model-picker',
      '.mention-pop',
      '.mini-drawer',
      '.mini-drawer-mask',
    ],
  },
  {
    id: 'toast',
    labelKey: 'animCtl.groupToast',
    selectors: ['.mini-toast', '.update-banner'],
    // 通知窗是独立文档，卡片类名是 .ny-card
    docSelectors: { notify: ['.ny-card'] },
  },
  {
    id: 'bubble',
    labelKey: 'animCtl.groupBubble',
    selectors: [
      '.msg-ai-action-btn',
      '.cite-badge',
      '.error-bubble',
      '.msg-collapse-bar',
      '.reasoning-arrow',
    ],
  },
  {
    id: 'loading',
    labelKey: 'animCtl.groupLoading',
    selectors: [
      '.typing-bar::after',
      '.typing-inline::after',
      '.scene-image-dot',
      '.replying-bar .dot',
      '.tool-btn.recording',
      '.mini-btn.recording',
      '.event-countdown.urgent',
      '.affinity-pop',
    ],
  },
  {
    id: 'progress',
    labelKey: 'animCtl.groupProgress',
    // 其余进度条（token 占比 / 生视频 / 更新下载 / 亲密度条中的内联部分）走 isGroupEnabled
    selectors: ['.bond-bar-fill'],
  },
  {
    id: 'queue',
    labelKey: 'animCtl.groupQueue',
    selectors: ['.queue-dock-handle', '.queue-dock-panel'],
  },
  {
    id: 'floatball',
    labelKey: 'animCtl.groupFloatball',
    // 悬浮球是独立文档（floating-ball.html），类名自成一套
    selectors: [],
    docSelectors: { floating: ['.fb-panel', '.fb-ctx', '.fb-row'] },
  },
  {
    id: 'splash',
    labelKey: 'animCtl.groupSplash',
    selectors: ['.splash', '.splash-line::after'],
  },
  {
    id: 'cursor',
    labelKey: 'animCtl.groupCursor',
    // 自定义光标是 canvas rAF 补间，无 CSS 动画 → 由 isGroupEnabled 门控
    selectors: [],
  },
  {
    id: 'banner',
    labelKey: 'animCtl.groupBanner',
    selectors: ['.node-banner'],
  },
  {
    id: 'theme',
    labelKey: 'animCtl.groupTheme',
    selectors: [
      // 全局 var(--transition) 的背景/颜色过渡（index.css 里所有用到它的规则）
      'body',
      'input, textarea, select',
      '.sidebar',
      '.sidebar .nav-item',
      '.sidebar-restore',
      '.list-pane',
      '.list-item',
      '.list-del',
      '.list-more',
      '.main-pane',
      // 通用交互元素
      '.btn-primary',
      '.role-card',
      '.speaker-item',
      '.select-menu-trigger',
      '.theme-card',
      '.ctb-btn',
      '.stories-tab',
      '.story-node',
      '.tab',
      '.moment-act',
      '.srb-item',
      '.btn-primary:disabled',
      '.idle-toggle',
      '.model-tag-click',
      '.hint-icon',
      '.settings-nav-item',
      '.settings-search-input',
      '.settings-suggest-item',
      // 事件弹窗：只列真正带过渡的具体类，禁用通配 `*`（否则该弹窗内将来出现的
      // .stream-char/.pseudo-char 会被 theme 组静默关掉，破坏「流式恒开」承诺）。
      '.event-option',
      '.event-close-top',
      '.event-countdown:not(.urgent)',
    ],
  },
  {
    id: 'scrollbar',
    labelKey: 'animCtl.groupScrollbar',
    // 自定义滚动条透明度过渡是内联 style → 由 isGroupEnabled 门控
    selectors: [],
  },
];

/** 全部分组 id（设置页渲染列表的顺序即此数组顺序） */
export const ANIM_GROUP_IDS: string[] = ANIM_GROUPS.map((g) => g.id);

/** 出厂默认：所有分组全开 */
export const DEFAULT_ANIM_GROUPS: Record<string, boolean> = ANIM_GROUPS.reduce(
  (acc, g) => {
    acc[g.id] = true;
    return acc;
  },
  {} as Record<string, boolean>
);

/** 只需要「动效相关字段」的部分设置（避免与 AppSettings 形成运行时循环依赖） */
export type AnimSettingsLike = Pick<AppSettings, 'enableAnimations'> &
  Partial<Pick<AppSettings, 'animControlMode' | 'animGroups'>>;

/** 当前控制模式：读不到 / 值非法一律回落总控模式 */
export function getAnimControlMode(settings: AnimSettingsLike | null | undefined): AnimControlMode {
  return settings?.animControlMode === 'single' ? 'single' : 'master';
}

/** 是否处于单控模式（总控被忽略） */
export function isSingleControl(settings: AnimSettingsLike | null | undefined): boolean {
  return getAnimControlMode(settings) === 'single';
}

/** 某分组当前是否启用 —— 所有内联动画组件的唯一判定入口 */
export function isGroupEnabled(
  settings: AnimSettingsLike | null | undefined,
  groupId: string
): boolean {
  // 设置尚未加载（null）：默认全开，行为与 v2.3.89 及以前一致
  if (!settings) return true;
  if (isSingleControl(settings)) {
    // 单控模式：只看自己的开关，缺省视为开；**总控在此被完全忽略**
    return settings.animGroups?.[groupId] !== false;
  }
  return settings.enableAnimations !== false;
}

/** 单控模式下被关闭的分组 id 列表（写入 data-anim-off） */
export function disabledGroupIds(settings: AnimSettingsLike | null | undefined): string[] {
  if (!isSingleControl(settings)) return [];
  return ANIM_GROUPS.filter((g) => !isGroupEnabled(settings, g.id)).map((g) => g.id);
}

/** 取某分组在某 document 下生效的选择器列表 */
export function selectorsForGroup(group: AnimGroupDef, kind: AnimDocKind): string[] {
  const docSel = group.docSelectors?.[kind];
  if (docSel) return docSel;
  return kind === 'main' ? group.selectors : [];
}

/** 生成某个 document 的全部分组门禁规则（每个 document 只生成一次） */
function buildGateCss(kind: AnimDocKind): string {
  const chunks: string[] = [
    '/* 高级动画控制 · 单控模式分组门禁（自动生成，勿手改；见 src/utils/animControl.ts） */',
  ];
  for (const group of ANIM_GROUPS) {
    const sels = selectorsForGroup(group, kind);
    if (sels.length === 0) continue;
    const rule = sels
      .map((sel) => `html[data-anim-off~="${group.id}"] ${sel}`)
      .join(',\n');
    chunks.push(`${rule} {\n  animation: none !important;\n  transition: none !important;\n}`);
  }
  return chunks.join('\n');
}

/** 已注入门禁样式的 document（弱引用，document 关闭即回收） */
const injectedDocs = new WeakMap<Document, HTMLStyleElement>();

/**
 * 幂等注入分组门禁 `<style>`：同一个 document 只注入一次，重复调用只更新内容。
 * 用独立元素而非改写各 document 自己的主题样式表，避免被主题刷新覆盖。
 */
function ensureGateStyle(doc: Document, kind: AnimDocKind): void {
  const existing = injectedDocs.get(doc);
  const css = buildGateCss(kind);
  if (existing && existing.isConnected) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  // 上一次注入的元素已被移除（如整页重载）：按标记重新兜底查一次
  const orphan = doc.querySelector<HTMLStyleElement>('style[data-anim-gate]');
  if (orphan) {
    orphan.textContent = css;
    injectedDocs.set(doc, orphan);
    return;
  }
  const el = doc.createElement('style');
  el.setAttribute('data-anim-gate', kind);
  el.textContent = css;
  (doc.head || doc.documentElement).appendChild(el);
  injectedDocs.set(doc, el);
}

/**
 * 把设置应用到指定 document —— 整个动画门控的唯一入口。
 *
 * 1. 总控模式且总开关关闭 → 挂 `.anim-off`（全局 kill，含各 document 自带的 kill 规则）；
 *    单控模式**永不挂**，保证仍开启的分组动画与流式豁免都不受影响；
 * 2. 单控模式 → 把被关闭的分组 id 写进 `html[data-anim-off]`（空格分隔，`~=` 匹配）；
 * 3. 顺带注入该 document 的分组门禁规则（每个 document 只注入一次）。
 *
 * @param doc 目标文档（主窗口 `document` / 悬浮球 / 通知窗各自的 document）
 * @param settings 当前设置（可为 null，表示尚未加载 → 视为全开）
 * @param kind 文档种类，决定各分组使用哪套选择器
 */
export function applyAnimControl(
  doc: Document | null | undefined,
  settings: AnimSettingsLike | null | undefined,
  kind: AnimDocKind = 'main'
): void {
  if (!doc || !doc.documentElement) return;
  const root = doc.documentElement;

  // 1) 总控 kill（单控模式下永不挂）
  const masterOff = !isSingleControl(settings) && settings?.enableAnimations === false;
  root.classList.toggle('anim-off', masterOff);

  // 2) 单控模式的分组黑名单
  const off = disabledGroupIds(settings);
  if (off.length > 0) root.setAttribute('data-anim-off', off.join(' '));
  else root.removeAttribute('data-anim-off');

  // 3) 分组门禁规则（幂等）
  ensureGateStyle(doc, kind);
}

/** 供设置页渲染：分组定义 + 当前开关状态 */
export function readGroupState(
  settings: AnimSettingsLike | null | undefined,
  groupId: string
): boolean {
  return isGroupEnabled(settings, groupId);
}