// 共享类型定义（渲染进程与主进程通用）

export type Gender = 'male' | 'female' | 'other' | 'unknown';

export type Provider = 'openai' | 'deepseek' | 'anthropic' | 'custom' | 'openai-compatible';

// 模型配置（保存在 settings.json 的 models 数组）
export interface ModelConfig {
  id: string;
  name: string; // 显示名称，如 "DeepSeek R1"
  provider: Provider;
  baseUrl: string; // API Base URL
  apiKey: string;
  model: string; // 实际模型 ID，如 deepseek-reasoner
  maxContext: number; // 最大上下文长度（token）
  temperature: number; // 0 - 2
  enabled: boolean;
  supportsImages?: boolean; // 是否支持图片输入（多模态视觉）：开启后用户发送的图片才会作为 image_url 内容块发给模型；关闭则图片仅作占位文本，绝不报错
  qps?: number; // 每分钟请求上限，0 或未设置=无限制；超出后请求延迟，限制解除后自动发送排队消息
}

export interface Role {
  id: string;
  name: string;
  avatar_path: string;
  gender: string;
  age: number | null;
  occupation: string;
  short_intro: string;
  personality: string;
  background: string;
  appearance: string;
  world_setting: string;
  key_memories: string;
  rules: string;
  example_dialogue: string;
  first_message: string;
  affinity: number;
  affinity_factor: number;
  soundPath?: string | null; // 角色自定义消息音效文件名（nysound:// 协议）；缺省/空=使用全局通知音
  mood?: string; // 当前情绪/心情（事件设定或按好感度推导），影响模型输出语气与上下文情绪
  model_config_id: string; // 绑定的模型配置 ID
  worldBookId?: string; // 绑定世界书（空=继承全局默认/按聊），优先级低于 chatWorldBooks
  ruleIds: string[]; // 从规则库勾选的专属规则 id 列表
  bond?: number; // 人物养成：关系值（由 AI 依据聊天内容判定，纯展示，不影响剧情）
  level?: number; // 人物养成：养成等级（由 bond 推导，默认 1）
  relation?: string; // 人物养成：AI 判定的关系类别（如 恋人/朋友/……），纯展示
  bondSnapshot?: string; // 关系值判定时的聊天内容快照：用于判断「自上次判定后是否有新聊天内容」，无变化则跳过重新判定
  momentDailyLimit?: number; // 朋友圈：单人物每日自动发送上限（留空用全局 dailyMomentLimit 兜底）；与手动触发无关
  created_at: string;
  updated_at: string;
}

// ===== 世界书（可管理的世界观库） =====
export interface WorldBookEntry {
  id: string;
  key: string; // 触发关键词（仅展示/说明用，不参与注入逻辑）
  content: string; // 该条目文本内容
  constant?: boolean; // 是否常驻
}

export interface WorldBook {
  id: string;
  name: string;
  description?: string;
  content: string; // 整段世界观文本（手动创建/纯文本导入时使用）
  entries: WorldBookEntry[]; // 条目化（SillyTavern/NAI lorebook 导入时填充）
  created_at: string;
  updated_at: string;
}

// ===== 规则库（可复制、可分共用/角色） =====
export interface Rule {
  id: string;
  name: string;
  content: string;
  scope: 'shared' | 'character'; // 共用（所有对话遵守）/ 角色专属
  source?: 'manual' | 'plugin'; // 来源：手动创建 / 插件导入
  created_at: string;
  updated_at: string;
}

// ===== 记忆（角色在互动中保存、可手动修改） =====
export interface MemoryEntry {
  id: string;
  roleId: string;
  content: string;
  source: 'manual' | 'auto'; // 手动添加 / AI 自动提炼
  sourceMsgId?: number; // 来源消息 ID（自动记忆关联，用于回滚/撤回时精准删除）
  sourceMsgIds?: number[]; // 关联的一组消息 ID（触发对话的用户消息 + AI 回复），任一命中即联动删除
  image_path?: string; // 图片记忆：存一张图片（手动保存图片入记忆时使用）
  created_at: string;
  updated_at: string;
}

export type ChatType = 'single' | 'group';
export type SenderType = 'user' | 'ai' | 'system';

export interface ChatMessage {
  id: number;
  chat_type: ChatType;
  chat_id: string;
  sender_type: SenderType;
  sender_name: string;
  content: string;
  reasoning?: string; // 思维链（推理模型思考过程），仅展示，不进入上下文与自动记忆
  image_path: string | null;
  images?: string[] | null; // 多图消息：图片路径数组（单图消息仅用 image_path，二者优先取 images）
  token_used: number;
  timestamp: string;
  msg_kind?: 'public' | 'private'; // 观察者模式：公屏 / 私密小窗对话（默认 public）
  status?: 'normal' | 'recalled' | 'failed'; // 消息状态：正常 / 已撤回 / 发送失败
  from_proactive?: boolean; // 是否由主动消息机制产生（用于记忆控制：空闲主动发消息时此字段为 true）
  genPrompt?: string; // 软件内生图时使用的提示词：仅 AI 生成的图片消息带此字段；手动发送的图片为空，用于右键「查看提示词」
}

export interface Group {
  group_id: string;
  group_name: string;
  member_ids: string; // 逗号分隔的角色id
  created_at: string;
  ignoreConvert?: boolean; // 群聊仅剩 1 人时，用户选择「保持群聊」的持久化忽略标记
  aiMentionEnabled?: boolean; // 群内 AI 互 @：开启后 AI 生成群聊消息时可 @ 其他成员
  // ===== 观察者模式（对局）配置 =====
  observerMode?: boolean; // 是否开启观察者模式（当前群即为一局「对局」）
  freezeMemory?: boolean; // 全局记忆冻结：对局内禁止读取外部历史记忆（含世界书）
  publicWriteMemory?: boolean; // 公屏记忆写入：对局公屏对话是否触发 AI 自动记忆提炼；默认 true（开启）
  observerNoEmotion?: boolean; // 关闭观察者发言的情绪演算（无干扰纯旁观）；默认 true
  privateWriteMemory?: boolean; // 私密小窗对话是否写入 AI 角色长期记忆；默认 false
  privateAffectsEmotion?: boolean; // 私密小窗对话是否影响 AI 情绪/好感；默认 false
}

export interface AffinityLogEntry {
  id: number;
  role_id: string;
  change: number;
  reason: string;
  timestamp: string;
}

// 用户自己的身份（自我角色卡）：可创建多个，在不同对话中切换使用
export interface SelfRole {
  id: string;
  name: string;
  avatar_path: string;
  gender: string;
  age: number | null;
  short_intro: string;
  personality: string;
  background: string;
  world_setting: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKeys {
  openai: string;
  deepseek: string;
  custom: { name: string; baseUrl: string; apiKey: string };
}

// 快捷聊天小窗设置
export interface MiniWindowSettings {
  enabled: boolean; // 总开关
  hotkey: string; // 全局快捷键，如 CommandOrControl+Shift+Z
  autoPopupOnMinimize: boolean; // 主窗最小化时自动弹出小窗
  alwaysOnTop: boolean; // 小窗置顶
  defaultChat: string; // 默认绑定会话："single:roleId" / "group:groupId" / ''
}

// 语音功能（ASR 语音输入 + TTS 文本转语音）设置
export interface VoiceSettings {
  asrBaseUrl: string; // ASR 专用 API 的 baseUrl（手填到版本号，如 https://api.openai.com/v1），与模型配置完全独立
  asrApiKey: string; // ASR 专用 API 密钥
  asrModel: string; // 转写模型名，如 whisper-1
  ttsBaseUrl: string; // TTS 专用 API 的 baseUrl（手填到版本号，如 https://api.openai.com/v1），与模型配置完全独立
  ttsApiKey: string; // TTS 专用 API 密钥
  ttsModel: string; // TTS 模型名，如 tts-1
  ttsVoice: string; // 音色，如 alloy
  ttsAutoPlay: boolean; // 全局自动播报 AI 回复
}

// 生图（专用图像生成 API）：拥有独立的 baseUrl/apiKey，与「模型配置中心」完全解耦，调用 OpenAI 兼容 /images/generations
export interface ImageGenSettings {
  enabled: boolean; // 总开关
  baseUrl: string; // 生图 API baseUrl（手填到版本号，如 https://api.openai.com/v1），系统自动补全 /images/generations
  apiKey: string; // 生图 API 密钥
  model: string; // 生图模型名，如 gpt-image-1 / dall-e-3
  size: string; // 尺寸，如 1024x1024
}

export interface AppSettings {
  apiKeys: ApiKeys;
  defaultModel: string;
  models: ModelConfig[]; // 模型配置中心
  theme: ThemeName;
  lang: 'zh' | 'en';
  windowBounds: { x: number; y: number; width: number; height: number; isMaximized?: boolean };
  lastBackupTime: string | null;
  fontSize: number; // 全局 UI 字体大小(px)
  fontFamily: string; // 字体样式 key：见 FONT_FAMILIES
  enableStreaming: boolean;
  streamParallel: number; // 群聊流式并行数量：1=顺序，3=适中，999=全部并行
  chatBackgrounds: Record<string, string>; // key: "single:roleId" or "group:groupId"
  chatSoundPaths: Record<string, string>; // 每个聊天的自定义通知铃声路径，key 同上。空 = 使用全局通知音
  backupDir: string; // 自定义备份目录（空 = 每次手动选择）
  uiRadius: number; // 整体 UI 圆角(px)
  bubbleRadius: number; // 聊天气泡圆角(px)
  bubbleOpacity: number; // 聊天气泡透明度（50~100，100=完全不透明）
  voice: VoiceSettings;
  miniWindow: MiniWindowSettings;
  enableAnimations: boolean; // 全局 UI 动效总开关（低配电脑可关闭）
  // ===== 首启向导与自我身份 =====
  firstRunDone: boolean; // 是否已走过初始设置（老用户读取到旧 settings 时由 db 强制置 true）
  selfRoles: SelfRole[]; // 用户自建的「我的角色卡」
  currentSelfRoleId: string; // 全局默认使用的自我身份
  chatSelfRoles: Record<string, string>; // 按会话覆盖的自我身份：key="single:roleId"/"group:groupId"，value=selfRoleId / 'none' / 'default'
  worldBook: string; // 兼容旧版单世界书，迁移后清空
  defaultWorldBookId: string; // 全局默认世界书 id（空=不使用）
  chatWorldBooks: Record<string, string>; // 按聊天覆盖：key="single:roleId"/"group:groupId" -> worldBookId（''=继承角色/默认）
  sharedRuleIds: string[]; // 共用规则（所有对话/模型遵守）
  enableAutoMemory: boolean; // AI 自动提炼记忆（默认关）
  hideReasoning: boolean; // 隐藏思维链（默认开=折叠显示，点击箭头展开）
  enableRandomEvents: boolean; // 随机事件：开启后聊天过程中会自动弹出随机事件（关闭则仅手动触发）
  // ===== 空闲主动回复 =====
  idleEnabled: boolean; // 全局主开关：关闭时所有按聊天的主动消息都失效（默认开）
  chatIdleEnabled: Record<string, boolean>; // 按聊天覆盖：key="single:roleId"/"group:groupId"；缺省视为 true
  idleInterval: number; // 触发主动消息前的静默时长（秒）：从离散选项中选择（默认 600s=10min）
  idleWriteMemory: boolean; // 主动消息是否参与 AI 自动记忆提炼（默认 false）
  idleSwitchAction: 'pause' | 'reset' | 'continue'; // 切换聊天时主动消息计时行为：暂停/重置/继续（全局，默认 pause）
  eventMoodImpact: number; // 随机事件影响心情的程度（0~1）：0=事件只改好感度，1=事件必按所选心情改变角色心情
  dialogueMoodImpact: number; // 对话影响心情的程度（0~1）：0=心情只由事件决定，1=AI 充分依据对话判定当前心情
  autoRelationship: boolean; // AI 依据聊天内容自动判定关系值/关系类别（关闭则不更新，纯展示）
  autoMoments: boolean; // AI 依据聊天内容自动发朋友圈动态（关闭则仅手动发）
  dailyMomentLimit: number; // 朋友圈每日上限：每个（角色 + 自我身份）每天自动发条数，0 表示不限制
  // ===== 情绪与事件（高级可调）=====
  moodJudgeCooldownMs: number; // 心情判定冷却（毫秒）：防止每轮都调用 AI 判定，节省调用
  moodJudgeHistory: number; // 心情判定回顾的最近消息条数：AI 据此判断角色此刻心情
  eventNegAffinity: number; // 好感度低于该值（或心情负面）→ 随机事件偏向冲突/拌嘴
  eventPosAffinity: number; // 好感度高于该值（或心情正面）→ 随机事件偏向甜蜜/撒娇
  eventHistory: number; // 事件生成时参考的最近对话条数
  eventMaxTokens: number; // 事件生成的最大 token 数（控制描述长度与成本）
  // ===== 群聊智能体互聊 =====
  groupScheduler: 'director' | 'roundRobin'; // 接话调度：导演模型智能挑人 / 按成员顺序轮询
  groupAutoRounds: number; // 自动接话轮数上限：0=无限，默认 6
  groupAutoChain: boolean; // 群聊发消息后，AI 是否主动按轮数上限多轮接话（无需手动点自动接话）
  groupMaxConsecutive: number; // 群聊自动接话时同一角色最多连续发言条数（1-20，默认 1）
  // ===== 音效设置 =====
  sound: {
    enabled: boolean; // 全局音效开关
    volume: number; // 音量 0~1
    // 各类型音效的自定义文件（userData/custom-sounds 下的文件名）；null=使用内置默认音效
    custom: {
      error: string | null;
      click: string | null;
      notification: string | null;
      popup: string | null;
      miniPopup: string | null;
      messageSend: string | null;
    };
  };
  silent: boolean; // 静默模式：暂停后台消息卡片通知 + 关闭消息提示音（点击/报错音效仍正常）
  // ===== 关闭主界面行为 =====
  closeToTray: boolean; // 关闭主界面时：true=最小化到托盘继续运行；false=直接退出程序。设置内即时生效
  closeConfirmDone: boolean; // 是否已走过「首次关闭提示」并勾选「不再提示」；false 时首次点关闭会弹提示框
  // ===== 自定义 Canvas 光标 =====
  customCursor: {
    enabled: boolean; // 总开关：false=系统原生光标，true=动态Canvas光标
    lerpSpeed: number; // 光标跟随缓动系数（0.1~0.5，越大跟得越紧）
    trailEnabled: boolean; // 液态渐变拖尾开关
    trailMaxLength: number; // 拖尾最大点位数（上限10）
    particlesEnabled: boolean; // 流光粒子点缀开关
    maxParticles: number; // 粒子数上限（上限8）
    hoverScale: number; // 悬浮可交互控件时放大比例（1.0~1.5）
    idleHideMs: number; // 空闲隐藏时长（毫秒）：静止超过此时长后隐藏自定义光标并恢复系统原生光标（500~300000，最高 5 分钟）
    cursorSize: number; // 光标显示尺寸（像素，长边）：16~64，默认 28。越大越清晰醒目
    hotspotX: number;  // 热点水平偏移（像素，相对图像左上角）：0~cursorSize。运行时为 (cx - hotspotX*scale, cy - hotspotY*scale) 绘制，使该点对齐鼠标实际位置
    hotspotY: number;  // 热点垂直偏移（像素，相对图像左上角）：0~cursorSize。
  };
  // ===== 翻译（右键菜单翻译文本） =====
  translationEnabled?: boolean; // 是否启用右键"翻译文本"
  translationModelId?: string; // 翻译专用模型配置 id（空=使用默认模型）
  translationLang?: 'auto' | 'zh' | 'en'; // 翻译目标语言：auto=随软件语言
  imageGen?: ImageGenSettings; // 生图（专用图像生成 API）设置
  // ===== 窗口整体等比缩放（基准尺寸 + 上下限，主窗与小窗分别配置）=====
  uiZoom?: {
    mainBaseW: number; // 主窗基准宽（zoom=1 的参考宽）
    mainBaseH: number; // 主窗基准高
    mainMin: number; // 主窗缩放下限
    mainMax: number; // 主窗缩放上限
    miniBaseW: number; // 小窗基准宽
    miniBaseH: number; // 小窗基准高
    miniMin: number; // 小窗缩放下限
    miniMax: number; // 小窗缩放上限
  };
}

export type ThemeName =
  | 'wechat'
  | 'glass'
  | 'dark'
  | 'vibrant'
  | 'azure'
  | 'galaxy'
  | 'pine'
  | 'ember'
  | 'frost'
  | 'rose'
  | 'cyber'
  | 'graphite'
  | 'indigo'
  | 'sand';

export const PROVIDER_DEFAULTS: Record<
  Provider,
  { baseUrl: string; model: string; maxContext: number; label: string }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', maxContext: 128000, label: 'OpenAI' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', maxContext: 64000, label: 'DeepSeek' },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    maxContext: 200000,
    label: 'Anthropic',
  },
  custom: { baseUrl: '', model: '', maxContext: 128000, label: '自定义' },
  'openai-compatible': {
    baseUrl: '',
    model: '',
    maxContext: 128000,
    label: 'OpenAI 兼容',
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeys: {
    openai: '',
    deepseek: '',
    custom: { name: '', baseUrl: '', apiKey: '' },
  },
  defaultModel: '',
  models: [],
  theme: 'wechat',
  lang: 'zh',
  windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
  lastBackupTime: null,
  fontSize: 14,
  fontFamily: 'system',
  enableStreaming: false,
  streamParallel: 1,
  chatBackgrounds: {},
  chatSoundPaths: {},
  backupDir: '',
  uiRadius: 10,
  bubbleRadius: 10,
  bubbleOpacity: 100,
  voice: {
    asrBaseUrl: '',
    asrApiKey: '',
    asrModel: 'whisper-1',
    ttsBaseUrl: '',
    ttsApiKey: '',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsAutoPlay: false,
  },
  miniWindow: {
    enabled: true,
    hotkey: 'CommandOrControl+Shift+Z',
    autoPopupOnMinimize: false,
    alwaysOnTop: true,
    defaultChat: '',
  },
  imageGen: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: 'gpt-image-1',
    size: '1024x1024',
  },
  enableAnimations: true,
  firstRunDone: false,
  selfRoles: [],
  currentSelfRoleId: '',
  chatSelfRoles: {},
  worldBook: '',
  defaultWorldBookId: '',
  chatWorldBooks: {},
  sharedRuleIds: [],
  enableAutoMemory: false,
  hideReasoning: true,
  enableRandomEvents: true,
  idleEnabled: true,
  chatIdleEnabled: {},
  idleInterval: 600,
  idleWriteMemory: false,
  idleSwitchAction: 'pause',
  eventMoodImpact: 1,
  dialogueMoodImpact: 1,
  moodJudgeCooldownMs: 20000,
  autoRelationship: true,
  autoMoments: true,
  dailyMomentLimit: 5,
  moodJudgeHistory: 10,
  eventNegAffinity: 30,
  eventPosAffinity: 70,
  eventHistory: 12,
  eventMaxTokens: 700,
  groupScheduler: 'director',
  groupAutoRounds: 6,
  groupAutoChain: true,
  groupMaxConsecutive: 1,
  sound: {
    enabled: true,
    volume: 0.7,
    custom: {
      error: null,
      click: null,
      notification: null,
      popup: null,
      miniPopup: null,
      messageSend: null,
    },
  },
  silent: false,
  closeToTray: true,
  closeConfirmDone: false,
  customCursor: {
    enabled: false,
    lerpSpeed: 0.25,
    trailEnabled: true,
    trailMaxLength: 10,
    particlesEnabled: true,
    maxParticles: 8,
    hoverScale: 1.25,
    idleHideMs: 5000,
    cursorSize: 28,
    hotspotX: 1, // 默认贴近图像左上角（标准箭头光标的尖端）
    hotspotY: 1,
  },
  uiZoom: {
    mainBaseW: 1200,
    mainBaseH: 800,
    mainMin: 0.85,
    mainMax: 1.3,
    miniBaseW: 340,
    miniBaseH: 520,
    miniMin: 0.75,
    miniMax: 1.8,
  },
};

// 字体样式选项：key -> CSS font-family 栈（含中英文回退，跨平台安全）
// 关系类别枚举：AI 判定关系值时只能从中精确选一个 key，避免自由文本前后不一致导致标签乱跳。
export const RELATION_TYPES = ['lover', 'friend', 'ambiguous', 'mentor', 'colleague', 'stranger', 'rival', 'secret_crush', 'family', 'classmate', 'partner', 'enemy', 'idol', 'benefactor', 'kindred'] as const;
export type RelationType = typeof RELATION_TYPES[number];
export const RELATION_LABELS: Record<RelationType, string> = {
  lover: '恋人',
  friend: '朋友',
  ambiguous: '暧昧',
  mentor: '师徒',
  colleague: '同事',
  stranger: '陌生',
  rival: '宿敌',
  secret_crush: '暗恋',
  family: '家人',
  classmate: '同学',
  partner: '搭档',
  enemy: '仇人',
  idol: '偶像',
  benefactor: '恩人',
  kindred: '知己',
};

// 把任意来源的关系值归一化为合法枚举 key，杜绝 AI 漂移出的自由英文/错别标签污染展示：
// 已是合法 key 直接返回；是中文标签则反查 key；含近义别称（英文或中文）则匹配最近 key；否则回退 stranger。
const RELATION_ALIASES: Array<[string, string]> = [
  ['lover', 'lover'], ['恋人', 'lover'], ['爱人', 'lover'], ['伴侣', 'lover'], ['对象', 'lover'],
  ['friend', 'friend'], ['朋友', 'friend'], ['好友', 'friend'],
  ['ambiguous', 'ambiguous'], ['暧昧', 'ambiguous'],
  ['mentor', 'mentor'], ['师徒', 'mentor'], ['师父', 'mentor'], ['师傅', 'mentor'], ['学生', 'mentor'],
  ['colleague', 'colleague'], ['同事', 'colleague'],
  ['stranger', 'stranger'], ['陌生', 'stranger'], ['陌生人', 'stranger'], ['不熟', 'stranger'],
  ['rival', 'rival'], ['宿敌', 'rival'], ['对手', 'rival'], ['死对头', 'rival'],
  ['secret_crush', 'secret_crush'], ['暗恋', 'secret_crush'], ['单恋', 'secret_crush'],
  ['family', 'family'], ['家人', 'family'], ['亲属', 'family'], ['亲人', 'family'],
  ['classmate', 'classmate'], ['同学', 'classmate'], ['同窗', 'classmate'],
  ['partner', 'partner'], ['搭档', 'partner'], ['伙伴', 'partner'],
  ['enemy', 'enemy'], ['仇人', 'enemy'], ['敌人', 'enemy'], ['仇敌', 'enemy'],
  ['idol', 'idol'], ['偶像', 'idol'],
  ['benefactor', 'benefactor'], ['恩人', 'benefactor'],
  ['kindred', 'kindred'], ['知己', 'kindred'], ['知音', 'kindred'],
];

export function normalizeRelation(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return 'stranger';
  const s = raw.trim();
  if (!s) return 'stranger';
  if ((RELATION_TYPES as readonly string[]).includes(s)) return s;
  const byLabel = (Object.keys(RELATION_LABELS) as RelationType[]).find((k) => RELATION_LABELS[k] === s);
  if (byLabel) return byLabel;
  const lower = s.toLowerCase();
  for (const [alias, key] of RELATION_ALIASES) {
    if (lower.includes(alias.toLowerCase())) return key;
  }
  return 'stranger';
}

export const FONT_FAMILIES: Record<string, string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  sans: "'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  pingfang: "'PingFang SC', 'PingFang TC', 'Microsoft YaHei', sans-serif",
  yahei: "'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', sans-serif",
  sourcehan:
    "'Source Han Sans SC', 'Source Han Sans CN', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  sourcehanSerif:
    "'Source Han Serif SC', 'Source Han Serif CN', 'Noto Serif CJK SC', 'Songti SC', 'SimSun', serif",
  serif: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif",
  mono: "'SFMono-Regular', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  rounded: "'Comic Sans MS', 'Yuanti SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  kai: "'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif",
};

export interface ChatListItem {
  chat_type: ChatType;
  chat_id: string;
  name: string;
  chat_name?: string; // 自定义卡片名（重命名覆盖），优先于 name 显示
  avatar_path: string;
  last_message: string;
  last_time: string;
  member_count?: number;
}

export interface SendMessageResult {
  userMessage: ChatMessage;
  aiMessages: ChatMessage[];
  affinityChanges: { role_id: string; change: number; total: number }[];
  totalTokens: number;
}

export interface ChatContextMsg {
  role: SenderType;
  content: string;
}

// 单个人物的聊天统计（token 与消息数）
export interface RoleStat {
  roleId: string;
  roleName: string;
  tokens: number; // 该人物参与对话累计消耗的 token（含单聊与该人物名义的群聊回复）
  messages: number; // 计入该人物的消息条数
}

// ===== 错误日志 =====
// 错误类别：功能错误（界面/交互/本地逻辑异常）、模型错误（AI/生图/ASR/TTS 调用失败）、其他错误（兜底）
export type ErrorCategory = 'functional' | 'model' | 'other';
export interface ErrorLogEntry {
  id: number;
  time: string; // ISO 时间戳
  category: ErrorCategory;
  message: string; // 简短错误信息
  detail?: string; // 详细堆栈/上下文
}
