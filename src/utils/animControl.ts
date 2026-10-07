/**
 * 高级动画控制 —— 单一真源（v2.3.92 三档制）
 * ============================================================================
 * 用户需求（**三档互斥**，取代 v2.3.90 的「总控/单控」二元模式 + v2.3.91 的勾选框）：
 *   - `all-on`  （全部开启，默认）：所有动画一律播放；
 *   - `all-off` （全部关闭）：所有动画一律停播；
 *   - `custom`  （自定义）：由下面 13+1 个分组各自决定，只有勾选上的分组播放。
 *
 * 设置页只在 `custom` 档渲染分组开关；`all-on` / `all-off` 档把整块高级设置折叠隐藏，
 * 因为那两档下分组开关本来也不起作用（展示一组永远可点却无效的开关＝骗人的 UI）。
 *
 * 与既有机制的关系（不要破坏）：
 *   - `.anim-off`（index.css:1861）是「全关档」的全局 kill，语义完全保留；
 *   - 流式/打字机动画（`.stream-char` / `.stream-char.stall` / `.pseudo-char`）
 *     **任何档位都豁免**，本模块「刻意不把流式动画归入任何分组」，故三档都关不掉它。
 *
 * 门控实现（按档位二选一，绝不同时生效 —— 同时生效会误伤流式豁免）：
 *   1. `all-off` → 挂类名 `html.anim-off`（全局 kill，含各 document 自带的 kill 规则），
 *      **不设** `data-anim-off`；
 *   2. `custom`  → **绝不挂** `.anim-off`（否则会把仍开启的分组动画一起杀掉，也会误伤
 *      流式豁免），改设 `html[data-anim-off~="<id>"]`，配合每个 document 一次性注入的
 *      规则 `… { animation:none!important; transition:none!important }`；
 *   3. `all-on`  → 既不挂 `.anim-off` 也不设 `data-anim-off`（两条都不需要）。
 *   4. **内联动画**（transition / rAF 补间，CSS 规则管不到）：一律改读 `isGroupEnabled()`。
 *
 * 每个 document（主窗口 / 小窗 / 悬浮球 / 通知窗）各自独立注入、各自引用自己的选择器，
 * 因此同一个 `ANIM_GROUPS` 定义能同时服务 4 个文档而不必复制大段选择器列表。
 */
import type { AppSettings } from '../types';

/** 文档种类：决定某分组在该文档里用哪套选择器 */
export type AnimDocKind = 'main' | 'floating' | 'notify';

/**
 * 动画控制档位（v2.3.92）。
 * 旧的 `enableAnimations:boolean` + `animControlMode:'master'|'single'` 仍留在 settings 里
 * 作为兼容字段（读档位时按 `getAnimMode()` 的规则映射），但**新逻辑一律只看 `animMode`**。
 */
export type AnimMode = 'all-on' | 'all-off' | 'custom';

/** 三档的合法取值（设置页渲染顺序即此数组顺序） */
export const ANIM_MODES: AnimMode[] = ['all-on', 'all-off', 'custom'];

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
 * 分组分类法（唯一权威列表，v2.3.92 起共 14 组，v2.3.94 需求 11 新增 stats 后共 15 组）。
 *
 * 注意：**流式/打字机动画不在此列表中** —— 它按设计恒开（豁免总控，且无单项开关）。
 * 因此任何分组的选择器都**不得**写成 `.event-modal *` 这类通配：一旦某个容器将来新增了
 * `.stream-char` / `.pseudo-char`，通配会把它静默关掉，破坏「流式恒开」承诺。
 */
export const ANIM_GROUPS: AnimGroupDef[] = [
  {
    id: 'panel',
    labelKey: 'animCtl.groupPanel',
    selectors: [
      '.stories-panel',
      // v2.3.94 需求 2：消息下方按钮组曾改为「线性弹出」，动画载体是 .msg-action-bar 本身
      //（transition: transform），因此登记在本组以便被独立开关。
      // v2.3.94 修正：用户否掉了「先很小再放大」的表现方式，该元素已改为
      //「未就绪 visibility:hidden（保留占位）/ 就绪直接正常大小出现」，**本身不再产生 transform 动画**。
      // 仍**保留登记**：① 删除登记会让「面板类动画」开关的语义出现缺口；
      // ② 该元素后续若再加过渡，必须能被面板组开关覆盖；
      // ③ 保留一条不产生任何效果的登记是**无害**的，而误删后新加动画会漏出总控，属更坏的方向。
      // 刻意不把 .msg-ai-action-btn 也加进来：它属于 bubble 组（animControl.ts 的 bubble 项），
      // 同时登记到两个组会导致「关掉 panel 连带关掉 bubble 想保留的按钮动画」的语义冲突。
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
      // v2.3.94 需求 12：通用搜索候选面板（SearchSuggest.tsx，portal 到 body）
      '.search-suggest',
    ],
  },
  {
    id: 'toast',
    labelKey: 'animCtl.groupToast',
    selectors: ['.mini-toast', '.update-banner'],
    // 通知窗是独立文档，卡片类名是 .ny-card，关闭按钮是 .ny-close（notify.ts:43/75 有 transition）
    docSelectors: { notify: ['.ny-card', '.ny-close'] },
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
      // v2.3.92：整类登记（原先只登记了 .urgent，导致非 urgent 态的普通倒计时关不掉）。
      // 该类同时覆盖 .event-countdown.urgent 的脉冲与常态的 color 过渡。
      '.event-countdown',
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
    // 悬浮球是独立文档（floating-ball.ts 注入样式），类名自成一套
    selectors: [],
    docSelectors: {
      floating: [
        '.fb-panel',
        '.fb-ctx',
        '.fb-row',
        // v2.3.92 补齐：球体拖拽缩放过渡 / 生视频环形进度过渡 / 右键菜单项
        '.fb-ball',
        '.fb-prog .fg',
      ],
    },
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
    // v2.3.92 修正错位：真正动的是**子元素** `.node-banner-card`（父 `.node-banner` 只是定位容器，
    // 三条 phase 规则 `.node-banner.phase-* .node-banner-card` 都挂在子元素上）。
    // 登记父元素是无效的 —— 门禁规则会写 `… .node-banner { animation:none }`，而父元素本来就没有动画。
    selectors: ['.node-banner-card'],
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
      // v2.3.92 补齐：开关滑块本体与其滑块圆点（伪元素）——原先只登记了外层 .idle-toggle，
      // 拨动时真正做 transform 位移的是 ::after，父级 kill 管不到它。
      '.idle-toggle .idle-toggle-knob',
      '.idle-toggle .idle-toggle-knob::after',
      '.model-tag-click',
      '.hint-icon',
      '.settings-nav-item',
      '.settings-search-input',
      '.settings-suggest-item',
      // v2.3.94 需求 13/14：聊天列表搜索框与不常用聊天文件夹表头（均含 var(--transition) 过渡）
      '.list-search-row',
      '.list-search-input',
      '.list-search-clear',
      '.list-search-badge',
      '.inactive-folder-head',
      '.inactive-folder-caret',
      '.inactive-folder-count',
      // v2.3.94 需求 10：翻译弹窗的删除按钮 hover/focus 变色过渡（.tr-* 系列，主窗与小窗共用）
      '.tr-seg-del',
      '.tr-btn',
      // v2.3.92 补齐：提示气泡 / 设置跳转高亮 / 模型卡高亮 / 拖拽与快速导入遮罩
      '.hint-tip',
      '.setting-flash',
      '.model-flash',
      '.drop-hint',
      '.quick-import-overlay',
      // v2.3.94 需求 7：多媒体 API 配置编辑器（TTS/ASR/生图/生视频共用）
      // 的卡片边框过渡与展开表单入场动画
      '.media-cfg-card',
      '.media-cfg-body',
      // 事件弹窗：只列真正带过渡/动画的具体类。**禁用通配 `*`**（否则该弹窗内将来出现的
      // .stream-char/.pseudo-char 会被 theme 组静默关掉，破坏「流式恒开」承诺）。
      '.event-overlay',
      '.event-modal',
      '.event-option',
      '.event-close-top',
    ],
  },
  {
    id: 'scrollbar',
    labelKey: 'animCtl.groupScrollbar',
    // 自定义滚动条透明度过渡是内联 style → 由 isGroupEnabled 门控
    selectors: [],
  },
  {
    id: 'tutorial',
    labelKey: 'animCtl.groupTutorial',
    // v2.3.92 新建组：新手引导高亮环是**无限循环**动画，且新用户首启即默认显示，
    // 用户感知最强，值得独立成组单独关掉。
    selectors: ['.tutorial-ring', '.tutorial-card', '.tutorial-card-center'],
  },
  {
    // v2.3.94 需求 11（统计页三大板块）：饼图「从圆心顺时针拉开」的 rAF 补间与扇区悬停外扩
    // 都是**内联**动画（内联优先级高于 .anim-off 的 !important），故必须由 StatsView 里的
    // isGroupEnabled(settings, 'stats') 门控；这里同时登记 CSS 类名，让 CSS 侧的
    // transition（悬停外扩 / 榜单行浮现）在自定义档被关掉时也能被 kill 掉。
    id: 'stats',
    labelKey: 'animCtl.groupStats',
    selectors: [
      '.stats-pie-slice',
      '.stats-legend-row',
      '.stats-fav-card',
      '.stats-rank-row',
      '.stats-role-pick-item',
    ],
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
  Partial<Pick<AppSettings, 'animMode' | 'animControlMode' | 'animGroups'>>;

/** 值是否为合法的档位（用于挡住脏数据） */
function isAnimMode(v: unknown): v is AnimMode {
  return v === 'all-on' || v === 'all-off' || v === 'custom';
}

/**
 * 当前档位 —— **全模块唯一的档位读入口**。
 *
 * 向后兼容（老 settings 里没有 `animMode`，只有 v2.3.90/91 的两个字段）：
 *   1. `animControlMode === 'single'` → `'custom'`（当年拨过分项开关 = 用户明确要自定义）；
 *   2. 否则 `enableAnimations === false` → `'all-off'`；
 *   3. 其余（含 settings 为 null / 字段非法）→ `'all-on'`（与 v2.3.89 及以前行为一致）。
 */
export function getAnimMode(settings: AnimSettingsLike | null | undefined): AnimMode {
  if (settings && isAnimMode(settings.animMode)) return settings.animMode;
  if (settings?.animControlMode === 'single') return 'custom';
  if (settings && settings.enableAnimations === false) return 'all-off';
  return 'all-on';
}

/** 是否处于自定义档（只有这一档下分组开关才有意义） */
export function isCustomAnimMode(settings: AnimSettingsLike | null | undefined): boolean {
  return getAnimMode(settings) === 'custom';
}

/** 某分组当前是否启用 —— 所有内联动画组件的唯一判定入口 */
export function isGroupEnabled(
  settings: AnimSettingsLike | null | undefined,
  groupId: string
): boolean {
  const mode = getAnimMode(settings);
  if (mode === 'all-on') return true;
  if (mode === 'all-off') return false;
  // 自定义档：只看自己的开关，缺省视为开
  return settings?.animGroups?.[groupId] !== false;
}

/**
 * 需要写进 `data-anim-off` 的分组 id 列表（空格分隔）。
 * 只有自定义档需要 —— 全关档走 `.anim-off` 全局 kill，无需逐组登记。
 */
export function disabledGroupIds(settings: AnimSettingsLike | null | undefined): string[] {
  if (getAnimMode(settings) !== 'custom') return [];
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
    '/* 高级动画控制 · 自定义档分组门禁（自动生成，勿手改；见 src/utils/animControl.ts） */',
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
 * 三档互斥（详见文件头注释）：
 *   - `all-on`：清掉 `.anim-off` 与 `data-anim-off`；
 *   - `all-off`：挂 `.anim-off`，清掉 `data-anim-off`；
 *   - `custom`：**永不挂** `.anim-off`，只写 `data-anim-off`（空格分隔，`~=` 匹配）。
 *
 * 无论哪一档都会顺带注入该 document 的分组门禁规则（每个 document 只注入一次），
 * 这样从「自定义」切到「全关」再切回来不需要重新注入，切换是零延迟的。
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
  const mode = getAnimMode(settings);

  // 1) 全关档的全局 kill（其余档位一律不挂，否则会误伤流式豁免与仍开启的分组）
  root.classList.toggle('anim-off', mode === 'all-off');

  // 2) 自定义档的分组黑名单（其余档位清空，避免残留上一档的分组名单）
  const off = disabledGroupIds(settings);
  if (off.length > 0) root.setAttribute('data-anim-off', off.join(' '));
  else root.removeAttribute('data-anim-off');

  // 3) 分组门禁规则（幂等）
  ensureGateStyle(doc, kind);
}