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
import { clampAnimSpeed, animSpeedFromSeconds, ANIM_SPEED_DEFAULT } from '../types';

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
      // v2.3.94 修正：用户否掉了「先很小再放大」的表现方式，该元素改为无动画直接出现。
      // v2.3.96（现状）：改为**淡入 + 轻微上移**（opacity 0→1 / translateY(4px)→none，0.5s），
      // 用的是 **transition 而非 @keyframes** —— 这正是它能被本组开关安全关掉的前提：
      // `transition:none !important` 只是取消插值，元素**瞬间跳到终态**（opacity:1）仍然可见；
      // 而 @keyframes 一旦被 `animation:none !important` 抹掉，元素会退回基态（opacity:0）永久不可见。
      // 因此本条登记从「无害的占位」升级为**功能性必需**：删掉它，动效开关就会对按钮失效。
      // 另在 index.css 里配了一条 `.anim-off .msg-action-bar.is-in { opacity:1 !important }` 兜底，
      // 双保险，保证任何关档组合下就绪态都不会卡在透明。
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
    // v2.3.96：面板改为「以队列图标为锚点」展开后，动效载体仍在这两个类上 ——
    // .queue-dock-handle 的 opacity 过渡、.queue-dock-panel 的 transform/opacity/visibility 过渡
    // 都已从组件的 inline style 收进 index.css 的类规则，故本组门禁能真正 kill 掉它们。
    // 追加 .expanded（展开态类）：其 transition 写在展开态选择器上，
    // 只登记基类会让「展开态的 transition」漏出门禁，故两个都登记。
    // 同时追加 :focus-visible —— 图标已改为真正的 <button>，焦点环过渡也归本组。
    selectors: [
      '.queue-dock-handle',
      '.queue-dock-panel',
      '.queue-dock-panel.expanded',
      '.queue-dock-handle:focus-visible',
    ],
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
      // v2.3.97：实心危险按钮（恢复出厂/删除全部数据/清空错误日志）。
      // 它的 hover/disabled 走 var(--transition) 过渡，与 .btn-primary 同族。
      '.btn-danger',
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
      // v2.3.97 补齐（审计发现的登记缺口）：以下选择器此前**带动画但从未登记**，
      // 导致自定义档的分组开关对它们完全失效（只有 all-off 档的 `.anim-off *`
      // 能杀掉，自定义档管不住）。补登记后 custom 档也能正常关掉。
      '.settings-suggest',   // 设置搜索候选（v2.3.97 补的 popupLinearIn）
      '.select-menu-tip',    // 下拉悬停提示（v2.3.97 补的 fadeIn）
      '.msg-search',         // 消息查找横条（v2.3.97 补的 popupLinearIn）
      // v2.3.97：通用模态三件套 —— 被 18 个弹窗共用（AboutModal / BondPanel /
      // ChatWindow×8 / CustomTitleBar 退出确认 / GroupEditor / ImageCropper /
      // Library×2 / MiniChat×5 / ModelEditor / MomentsView×2 / OnboardingWizard /
      // RoleEditor / SelfRoleEditor / Settings / TranslateModal / UpdatePopup）。
      // 改 index.css 这三个类一处即 18 个弹窗同时生效，故必须登记，否则
      // 「自定义档 → 关掉本组」对这 18 个弹窗的入场动画不起作用。
      // 语义上属theme 组（通用 UI 外观与交互），与 .hint-tip / .drop-hint 同族。
      '.modal-mask',
      '.modal',
      '.modal-card',
      // 事件弹窗：只列真正带过渡/动画的具体类。**禁用通配 `*`**（否则该弹窗内将来出现的
      // .stream-char/.pseudo-char 会被 theme 组静默关掉，破坏「流式恒开」承诺）。
      '.event-overlay',
      '.event-modal',
      '.event-option',
      '.event-close-top',
      // v2.3.97（液态玻璃 liquid 主题）：背景「液态流动」动画。
      // 载体是 .app-root（主窗）与 .mini-shell（小窗）的 background-position 位移，
      // 36s linear 往返（keyframes liquid-flow-drift）。放theme 组而非新建组，理由：
      //   ① 它就是「主题外观」的一部分，与 .theme-card / body 同族，语义一致；
      //   ② 新建分组会给设置页再添一个开关，而本主题另有独立的「液态流动」开关
      //      （settings.liquidFlow → html[data-liquid-flow="off"]），两者正交：
      //      本登记负责「三档总开关 / 自定义档」这一维度，独立开关负责「只关流动」。
      // 关掉后的兜底是安全的：animation:none 会让元素退回基态，而基态
      // background-position 就是 0% 0%（= keyframes 的 0% 声明值），
      // 即「静止的完整背景」，不会退回透明/不可见 —— 这是选 background-position
      // 位移（而非 opacity/transform 显隐类动画）的原因。
      //
      // ⚠️ 这里**只能登记裸类名**，不能写成 `[data-theme="liquid"] .app-root`：
      // buildGateCss 生成的规则是 `html[data-anim-off~="theme"] <登记的选择器>`，
      // 中间是**后代组合器**。而 data-theme 是设在 documentElement（即 <html>）上的，
      // 若登记成 `[data-theme="liquid"] .app-root`，拼出来就是
      // `html[...] [data-theme="liquid"] .app-root` —— 要求 html 的**后代**里有个
      // 带 data-theme 的元素，而 data-theme 就在 html 自己身上，永远匹配不上，
      // 结果是「自定义档关掉 theme 组，流动动画照样播」（静默失效）。
      // 裸类名即可：只有 liquid 主题给这两个元素加了 animation，
      // 其余主题下它们没有 animation/transition，被 kill 也不影响任何东西。
      '.app-root',
      '.mini-shell',
      // v2.3.97：拖拽导入「预检确认弹窗」的文件列表行。
      // 这一条是**功能性必需**，与 .msg-action-bar 同理：.qip-item 的基态是
      // `opacity:0`（靠 transition 插值到 .is-in 的 opacity:1），
      // 若不登记，`transition:none !important` 不会「跳到终态」而是把元素
      // 永久卡在 opacity:0 —— 整个文件列表会看不见。
      // 双重保险：index.css 里另有 `.anim-off .qip-item { opacity:1 !important }`。
      '.qip-item',
      '.qip-item.is-in',
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
    selectors: [
      '.tutorial-ring',
      '.tutorial-card',
      '.tutorial-card-center',
      // v2.3.97 补登记：引导遮罩此前带 maskFadeIn 动画却未登记，自定义档关不掉。
      // .tutorial-mask-full 只是尺寸修饰（inset:0），不带独立动画，无需登记。
      '.tutorial-mask',
    ],
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
      // v2.3.95：「你最喜欢的人物」板块移到最上方 + 拆出独立编辑界面（favEdit 子页）。
      // 新增的三处带动画的元素登记在此，确保它们同样受三档动效开关与自定义分组控制：
      //   .stats-fav-edit-btn           板块右上角的编辑入口按钮（hover/focus 过渡）
      //   .stats-fav-editor             编辑界面容器入场动画（statsFavEditorIn）
      //   .stats-fav-signature textarea 个性签名多行输入框的边框过渡
      '.stats-fav-edit-btn',
      '.stats-fav-editor',
      '.stats-fav-signature textarea',
      // v2.3.95：编辑界面的性别单选按钮组（选中态/hover 过渡）
      '.stats-fav-gender-pick button',
      // v2.3.97 补登记（审计发现的登记缺口）：这两类此前**已有popupLinearIn 动画
      // 却从未登记进任何分组** —— 自定义档的 stats 开关对它们完全无效。
      //   .stats-role-pick      「我最喜欢的人物」选人弹窗本体
      //   .stats-role-pick-mask该弹窗的遮罩层
      '.stats-role-pick',
      '.stats-role-pick-mask',
      // v2.3.97 新补：饼图扇区的悬浮 tooltip（fadeIn 0.12s linear）
      '.stats-pie-tip',
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
  Partial<
    Pick<AppSettings, 'animMode' | 'animControlMode' | 'animGroups' | 'animSpeed' | 'animSpeedSeconds' | 'animSpeedPreset'>
  >;

/**
 * 当前界面动效速度倍率 —— **速度的唯一读入口**（v2.3.97）。
 *
 * 返回值语义：`1` = 原始速度，`1.5` = 慢一倍半，`0.5` = 快一倍。
 * CSS 侧写成 `calc(<原值> * var(--anim-speed))`；JS 侧（饼图 rAF 补间、useRetract 延迟卸载、
 * 悬浮球菜单延迟卸载、光标淡入淡出）写成 `base / speed`。
 *
 * 与 `getAnimMode()` 的关系：**正交**。档位管「动不动」，速度管「动不动得快慢」——
 * 所以即使 `animMode === 'all-off'`（什么都不动），本函数仍照常返回倍率（只是没人消费它）；
 * 反过来全开档下速度也照常生效。
 *
 * 「自定义」档的换算：`animSpeedPreset === 'custom'` 时，以 `animSpeedSeconds`
 * 作为「单个弹窗的标准时长（秒）」，倍率 = `ANIM_SPEED_REF_SECONDS / 秒数`。
 * 两者都不合法（老 settings / 脏数据）时一律回落到 `ANIM_SPEED_DEFAULT`（=1，不改变观感）。
 */
export function getAnimSpeed(settings: AnimSettingsLike | null | undefined): number {
  if (!settings) return ANIM_SPEED_DEFAULT;
  if (settings.animSpeedPreset === 'custom') return animSpeedFromSeconds(settings.animSpeedSeconds);
  return clampAnimSpeed(settings.animSpeed);
}

/**
 * 把「CSS 里的基准秒数」换算成「JS 该等的毫秒数」—— **CSS 与 JS 时长配对的唯一入口**。
 *
 * ## 为什么需要它
 * 凡是「JS 用 setTimeout 等某个 CSS 动画播完再卸载 DOM」的地方，两侧时长必须**严格 1:1**。
 * CSS 侧在 v2.3.97 起已被统一改成 `calc(<原值> * var(--anim-speed, 1))`，所以这些
 * JS 定时器也必须跟着缩放，否则会出现两类用户可见故障：
 *   - 速度调**快**：动画早播完，元素傻等（拖沓感）；
 *   - 速度调**慢**：动画没播完 DOM 就被摘掉（元素凭空消失 / 菜单「点了不消失」）。
 *
 * ## 用法
 * ```ts
 * // CSS: animation: nodeBannerIn calc(0.2s * var(--anim-speed, 1)) linear both;
 * const IN_MS = animMs(0.2);   // ← 这行就是 CSS 那行的「孪生兄弟」
 * ```
 * 之所以做成函数而不是模块级常量：模块级常量**只求值一次**，用户在设置里改了速度后
 * 不会重算，长时间运行后会与 `--anim-speed` 脱节。函数在**调用时**现算，天然同步。
 *
 * ## 与「停留时长」的区分（重要）
 * 只有**与动画时长配对**的等待才该调用本函数。以下两类**不**该缩放：
 *   - 停留/可读时长（如 NodeBanner 的 `HOLD_MS` 3.5s、Toast 的 `duration` 1.5~3s）：
 *     那是给人读完文字的时间，缩放它会导致快档下一闪而过、慢档下久到以为卡死；
 *   - 轮询/节流间隔、冷却时间（如 `EVENT_COOLDOWN_MS`、节流 80ms）：与动画无关。
 *
 * @param cssSeconds CSS 里写的**基准**秒数（不含倍率，即 `calc()` 括号里那个数）
 * @param doc 目标文档，缺省 `document`
 * @returns 应等待的毫秒数；夹在 [16, 10000] 防脏数据与极端倍率
 */
export function animMs(cssSeconds: number, doc?: Document | null): number {
  const base = Number(cssSeconds);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0.2;
  return Math.min(10000, Math.max(16, Math.round(safeBase * 1000 * readAnimSpeed(doc))));
}

/**
 * 从某个 document 根元素上读回 `--anim-speed` —— **给拿不到 settings 的纯 hook 用**。
 *
 * 存在的理由：`useRetract` 是一个纯 React Hook，按契约不能改签名（16 处调用点零改动是它的卖点），
 * 却必须知道「缩入动画被放慢了多少倍」—— 否则速度调慢时 CSS 动画（例如 popupLinearOut 0.15s）
 * 还在播，JS 却已按固定 160ms 把 DOM 卸载了，表现为**菜单动画播到一半凭空消失**。
 *
 * 为什么读 CSS 变量而不是 React 上下文：`applyAnimControl` 已经把倍率写进了**每个 document
 * 自己的** `documentElement`（主窗 / 悬浮球 / 通知窗三者互不相同），这正是各自动画的唯一真源，
 * 且是同步写入、无需等 React 重渲染 —— 定时器里读到的必然是当前值。
 *
 * @param doc 目标文档，缺省为当前 `document`
 * @returns 倍率；变量缺失 / 非法 / document 不存在时返回 `ANIM_SPEED_DEFAULT`（=1，即原始速度）
 */
export function readAnimSpeed(doc?: Document | null): number {
  const target = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!target || !target.documentElement) return ANIM_SPEED_DEFAULT;
  const raw = target.documentElement.style.getPropertyValue('--anim-speed');
  if (!raw) return ANIM_SPEED_DEFAULT;
  const n = Number(raw);
  // 只接受「有限且 > 0」的值：脏数据（如空串/NaN/0）会让除法得到 Infinity 或除零
  return Number.isFinite(n) && n > 0 ? n : ANIM_SPEED_DEFAULT;
}

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

  // 3) 速度倍率变量（v2.3.97）：CSS 侧全部时长都写成 `calc(<原值> * var(--anim-speed))`，
  //    这里只写一个无单位数字。**必须写到各自的 documentElement 上** —— 主窗口 / 悬浮球 /
  //    通知窗是三个独立 BrowserWindow，CSS 变量不跨文档共享。
  //    与档位正交：即便 animMode==='all-off'（动画全关）也照写，因为该变量同时被
  //    useRetract / readAnimSpeed 消费（决定延迟卸载要等多久），且将来若某分组在
  //    all-off 档被豁免，无需再改这里。
  root.style.setProperty('--anim-speed', String(getAnimSpeed(settings)));

  // 4) 分组门禁规则（幂等）
  ensureGateStyle(doc, kind);
}