// 共享类型定义（渲染进程与主进程通用）
import { DEFAULT_MEMORY_SUMMARIZE_PROMPT, DEFAULT_MEMORY_INJECT_PROMPT } from './utils/builtinPrompts';

export type Gender = 'male' | 'female' | 'other' | 'unknown';

export type Provider = 'openai' | 'deepseek' | 'anthropic' | 'anthropic-compatible' | 'gemini' | 'openai-compatible' | 'local';

// 模型配置（保存在 settings.json 的 models 数组）
export interface ModelConfig {
  id: string;
  name: string; // 显示名称，如 "DeepSeek R1"
  provider: Provider;
  baseUrl: string; // API Base URL
  apiKey: string;
  model: string; // 实际模型 ID，如 deepseek-reasoner
  maxContext: number; // 最大上下文长度（token）
  // 温度（0~2）。可选：未设置=跟随全局默认（settings.globalModelParams.temperature），
  // 全局也未设置时由 ai.ts 兜底 1.0。模型编辑器可单独覆盖，「恢复到全局设置」即清空此值。
  temperature?: number;
  // 模型级流式输出：undefined=跟随全局（settings.enableStreaming）；true/false=强制开/关（覆盖全局）
  streamEnabled?: boolean;
  enabled: boolean;
  supportsImages?: boolean; // 是否支持图片输入（多模态视觉）：开启后用户发送的图片才会作为 image_url 内容块发给模型；关闭则图片仅作占位文本，绝不报错
  supportsReasoning?: boolean; // 是否标记该模型支持深度思考/推理（手动标记，替代早期「按模型名关键字猜测」）；开启且全局深度思考档位非 off 时，请求体写入 reasoning_effort
  supportsTools?: boolean; // 能力探针结果：是否支持工具调用（function calling / tool_calls）；开启后请求体可带 tools，AI 可触发工具
  supportsJson?: boolean; // 能力探针结果：是否支持 JSON 模式（response_format={"type":"json_object"}）；开启后可用于需要结构化输出的场景
  supportsStream?: boolean; // 能力探针结果：是否支持流式输出（SSE）。false 时聊天对该模型自动走非流式，即使全局/模型开关为开
  lastDetectedAt?: number | null; // 最近一次能力探针时间戳（ms），null=从未检测；用于设置页展示「上次检测」
  qps?: number; // 每分钟请求上限，支持小数（如 0.5=每 120 秒 1 次）；0 或未设置=无限制；超出后请求延迟，限制解除后自动发送排队消息
  // ===== 采样与上下文高级参数（无极滑动 + 输入框直输）=====
  topP?: number; // 核采样 top-p（0~1）。未设置=跟随全局默认（globalModelParams.topP），全局也未设置=使用模型默认
  topK?: number; // 核采样 top-k（0~50），0=关闭。未设置=跟随全局默认（globalModelParams.topK）
  maxTokens?: number; // 单次输出最大 token 数，不设置=使用软件内置兜底(1024)
  memReadLimit?: number; // 短期记忆：发送给模型的最近对话条数上限（0=不限制）
  // ===== API 级参数（模型编辑器「高级设置 → API 参数」，优先级高于全局模型设置）=====
  // 与全局参数（globalModelParams）的区别：这四项是「API 级」覆盖，优先级高于全局；
  // 未设置（undefined）时才回退到全局模型设置（如有），全局也没有则该参数不发送，交给服务端默认值。
  frequencyPenalty?: number; // 词频惩罚（-2~2）。undefined=不发送；0 是有效值（不能用真值判断）
  presencePenalty?: number; // 存在惩罚（-2~2）。undefined=不发送；0 是有效值
  // 自定义请求头原文：每行「<name>: <value>」，发送时覆盖同名请求头（优先级最高，可覆盖 Authorization）。
  // 与 customParams（自定义 Body）一样保存用户输入原文，便于编辑与容错，由 parseCustomHeaders 在发送时解析。
  customHeaders?: string;
  // ===== 自定义请求参数（JSON 文本）=====
  // 用户在模型编辑器输入的合法 JSON 对象，会在发送请求时合并进请求体（覆盖同名内置参数，但 messages/model/stream 受保护不被覆盖）。
  // 用于传入厂商特有、UI 未单独暴露的参数（如 stop / frequency_penalty / extra_body 等）。
  customParams?: string;
  supportsNsfw?: boolean; // 是否可输出 NSFW（成人）内容。由「检测能力」的 NSFW 探针自动判定，也可手动开启/关闭。仅作标记展示，不影响任何请求体、不绕过模型自身安全策略
  // ===== 分组与标签（手动归类，用于设置页快速筛选）=====
  // groupIds 指向 settings.modelGroups 中的分组（大归类，一个模型可属于多个分组，分组可改名/改色/删除）
  // tags 为自由文本标签（细标记，如「便宜」「快」），与分组同属「分类维度」，筛选时组内 OR
  groupIds?: string[];
  tags?: string[];
}

// 模型分组（全局实体，保存在 settings.modelGroups，可被多个模型引用）
export interface ModelGroup {
  id: string;
  name: string; // 分组名，长度上限 MODEL_GROUP_NAME_MAX（12 字符）
  color: string; // CSS 颜色，取自 MODEL_GROUP_COLORS 调色板
}

// ===== API 级参数的硬编码常量（改动这些值需同步告知用户）=====
// 词频惩罚 / 存在惩罚的取值范围与步长：取 OpenAI 官方标准范围 -2~2，步长 0.1
export const API_PENALTY_MIN = -2;
export const API_PENALTY_MAX = 2;
export const API_PENALTY_STEP = 0.1;

// 解析自定义请求头文本：每行「<name>: <value>」。
//   - 按行拆分（\n / \r\n / \r 均可），逐行 trim
//   - 跳过空行与不含冒号的行
//   - 只按「第一个」冒号切分，因此 value 里可再含冒号（如 URL: https://x）
//   - key 大小写不敏感去重：HTTP 头名本就不区分大小写，故按小写归一化判重，
//     后出现的同名 key 覆盖先出现的（连同其大小写写法一并覆盖）
//   - 解析不出任何合法行时返回空对象（不抛错，由 UI 在保存时给出提示）
// 主进程（发送请求）与渲染进程（实时校验）共用此函数，保证两侧解析规则完全一致。
export function parseCustomHeaders(text?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text || !text.trim()) return out;
  // 小写键 → 已写入的原始键名，用于大小写不敏感去重
  const seen = new Map<string, string>();
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // 无冒号，或以冒号开头（空key）→ 跳过
    const name = line.slice(0, idx).trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    const prev = seen.get(lower);
    if (prev !== undefined) delete out[prev]; // 移除旧写法，保证同名只留最新一条
    seen.set(lower, name);
    out[name] = line.slice(idx + 1).trim();
  }
  return out;
}

// 自定义请求头是否「有内容但一行都解析不出来」（UI 据此红字提示；主进程不拦截）
export function customHeadersInvalid(text?: string | null): boolean {
  if (!text || !text.trim()) return false;
  return Object.keys(parseCustomHeaders(text)).length === 0;
}

// ===== 分组与标签的硬编码上限（改动这些值需同步告知用户）=====
export const MODEL_GROUP_COLORS: string[] = [
  '#5b8def',
  '#4caf72',
  '#e0a33e',
  '#e06c75',
  '#9b7ee0',
  '#3fb0b5',
  '#d2695a',
  '#7a8a99',
];
export const MODEL_GROUP_NAME_MAX = 12; // 分组名单条长度上限
export const MODEL_GROUP_MAX = 20; // 分组数量上限
export const MODEL_TAG_LEN_MAX = 16; // 单个标签长度上限
export const MODEL_TAG_MAX = 12; // 每个模型的标签数量上限

// 模型能力探针的探测项开关（主进程与渲染进程共用；未传=全跑）
export interface ProbeOptions {
  images?: boolean;
  tools?: boolean;
  json?: boolean;
  nsfw?: boolean;
  stream?: boolean;
  thinkLevel?: boolean; // 思考等级（reasoning_effort / thinking）：探测模型是否接受思考强度参数
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
  moodValue?: number; // 心情平滑过渡：底层连续情绪值（-100~100），由 AI 判定目标与「心情过渡指数」平滑推导，显示用的 mood 由该值分段得到
  model_config_id: string; // 绑定的模型配置 ID
  worldBookId?: string; // 绑定世界书（空=继承全局默认/按聊），优先级低于 chatWorldBooks
  ruleIds: string[]; // 从规则库勾选的专属规则 id 列表
  bond?: number; // 人物养成：关系值（由 AI 依据聊天内容判定，纯展示，不影响剧情）
  level?: number; // 人物养成：养成等级（由 bond 推导，默认 1）
  relation?: string; // 人物养成：AI 判定的关系类别（如 恋人/朋友/……），纯展示
  bondSnapshot?: string; // 关系值判定时的聊天内容快照：用于判断「自上次判定后是否有新聊天内容」，无变化则跳过重新判定
  momentDailyLimit?: number; // 朋友圈：单人物每日自动发送上限（留空用全局 dailyMomentLimit 兜底）；与手动触发无关
  memoryIsolation?: boolean; // 记忆隔离（默认开）：开启后同一人物在不同聊天的记忆互相独立；缺省视为 true
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
  chatId?: string; // 记忆归属的聊天 id（记忆隔离开启时填写）；空=角色级共享记忆（跨聊天共享）
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
  status?: 'normal' | 'failed'; // 消息状态：正常 / 发送失败（v2.3.63 移除 'recalled'——撤回功能已下线；历史数据里的 recalled 消息按普通消息渲染）
  from_proactive?: boolean; // 是否由主动消息机制产生（用于记忆控制：空闲主动发消息时此字段为 true）
  search_results?: Array<{ title: string; url: string; snippet?: string }>; // 本条回复依据的联网搜索结果（与正文 [n] 编号一致），持久化后历史消息也能点击引用
  from_auto?: boolean; // 是否由「自动接话 / 续聊」产生：非用户直接请求的 AI 自发消息，仅用于悬浮球未读判定，不参与记忆控制
  genPrompt?: string; // 软件内生图时使用的提示词：仅 AI 生成的图片消息带此字段；手动发送的图片为空，用于右键「查看提示词」
  visibleToGroup?: boolean; // 群聊消息是否全群可见（默认 true）；false=仅用户与指定 AI 可见的私密备注
  toMemory?: boolean; // 群聊消息是否可被自动记忆提炼收录（仅当 visibleToGroup 为 true 时生效；默认 true）
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
  ttsBaseUrl: string; // TTS 专用 API 的 baseUrl：可填到版本号（自动补 /audio/speech），也可直接填完整 /audio/speech 接口地址（v2.3.20）；与模型配置完全独立
  ttsApiKey: string; // TTS 专用 API 密钥
  ttsModel: string; // TTS 模型名，如 tts-1
  ttsVoice: string; // 音色，如 alloy
  ttsAutoPlay: boolean; // 全局自动播报 AI 回复
  ttsEnabled?: boolean; // v2.3.44：全局 TTS 语音总开关（false=聊天界面隐藏播报按钮且不自动播报；缺省视为 true）
  // ===== ASR 上传格式（修复第三方 ASR 返回 400 的核心配置）=====
  asrFormat?: 'wav' | 'mp3' | 'webm' | 'm4a' | 'flac'; // 上传给服务器的音频容器格式；默认 wav（兼容性最好）
  asrLanguage?: string; // 可选：强制识别语言（如 zh / en），空=自动检测
  ttsScopes?: { dialogue?: boolean; narration?: boolean; psyche?: boolean }; // 朗读范围（全局）：勾选的类别才会被朗读；默认仅对话
  ttsRegenerate?: boolean; // 朗读音频缓存：false（默认）=已合成过的文本直接复用音频，不重复调用 API 不消耗 token；true=每次重新合成
  // ===== 数字人角色独立音色 / 语音 API（按角色配置 TTS 输出音色与调用端点）=====
  ttsVoices?: Record<string, string | RoleTtsConfig>; // key=roleId；值为音色名（旧格式，兼容）或 RoleTtsConfig；缺省回退全局 voice 设置
  // ===== 语速 / 音调（v2.3.34）=====
  // 说明：语速与音调由「提供商原生参数」实现（不做前端变调，避免变速同时改变音高）。
  // 因此只有协议原生支持该参数的提供商才会真正生效，不支持者静默忽略（设置界面已列出各提供商支持情况）。
  ttsSpeed?: number; // 语速倍率 TTS_SPEED_MIN~TTS_SPEED_MAX（0.5~2.0），1=原速（默认）
  ttsPitch?: number; // 音调偏移 TTS_PITCH_MIN~TTS_PITCH_MAX（-12~12，近似半音），0=不变（默认）
}

// 按角色的 TTS 独立配置：未填写的字段回退全局 voice 设置（旧版纯音色名字符串自动兼容）
export interface RoleTtsConfig {
  voice?: string; // 音色名
  baseUrl?: string; // 独立 TTS API baseUrl（空=用全局 ttsBaseUrl）
  apiKey?: string; // 独立 TTS API Key（空=用全局 ttsApiKey）
  model?: string; // 独立 TTS 模型名（空=用全局 ttsModel）
  speed?: number; // 该角色独立语速倍率（空=用全局 ttsSpeed）
  pitch?: number; // 该角色独立音调偏移（空=用全局 ttsPitch）
}

// ===== 语速 / 音调的可调范围（硬编码上限，改动需同步告知用户）=====
export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2;
export const TTS_SPEED_DEFAULT = 1;
export const TTS_PITCH_MIN = -12;
export const TTS_PITCH_MAX = 12;
export const TTS_PITCH_DEFAULT = 0;

// 把任意来源的语速/音调归一化到合法区间（非法值回退默认）
export function clampTtsSpeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return TTS_SPEED_DEFAULT;
  return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, n));
}
export function clampTtsPitch(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return TTS_PITCH_DEFAULT;
  return Math.min(TTS_PITCH_MAX, Math.max(TTS_PITCH_MIN, n));
}

// ===== TTS 提供商（协议）清单 =====
// 用途：① 设置界面「已适配的 TTS 提供商」列表展示；② 标明各协议是否原生支持语速/音调、是否有音色列表端点、是否有国内站/国际站。
// 维护约定（用户明令）：以后每适配一个新的 TTS 提供商，必须在此追加一条，并在 i18n 中补齐 nameKey / noteKey 的中英文案。
// match 为 Base URL 识别特征（仅展示用，真实识别逻辑见 electron/ai.ts textToSpeech）。
export interface TtsProviderInfo {
  id: string;
  name: string; // 提供商名称（品牌名，一般不翻译；中文名称用 nameKey 覆盖）
  nameKey?: string; // i18n key（有中文名称的提供商使用）
  match: string; // Base URL 特征（展示用）
  site: 'cn' | 'intl' | 'both' | 'global'; // cn=仅国内站；intl=仅国际站；both=国内站+国际站都适配；global=全球单站
  speed: boolean; // 是否原生支持语速
  pitch: boolean; // 是否原生支持音调
  voiceList: boolean; // 是否提供音色列表端点（false=音色需手填）
  noteKey: string; // i18n key：补充说明（凭据约定 / 站点域名等）
}

export const TTS_PROVIDERS: TtsProviderInfo[] = [
  { id: 'openai-native', name: 'OpenAI', match: 'api.openai.com', site: 'global', speed: true, pitch: false, voiceList: false, noteKey: 'settings.ttsProvOpenAINative' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', nameKey: 'settings.ttsProvOpenAICompatName', match: '/audio/speech', site: 'global', speed: true, pitch: false, voiceList: true, noteKey: 'settings.ttsProvOpenAICompat' },
  { id: 'minimax', name: 'MiniMax', match: '/t2a_v2', site: 'both', speed: true, pitch: true, voiceList: false, noteKey: 'settings.ttsProvMiniMax' },
  { id: 'bytedance', name: 'ByteDance Doubao', nameKey: 'settings.ttsProvByteDanceName', match: 'openspeech.bytedance.com', site: 'cn', speed: true, pitch: true, voiceList: false, noteKey: 'settings.ttsProvByteDance' },
  { id: 'bytedance-v3', name: 'ByteDance Doubao 2.0 / BytePlus', nameKey: 'settings.ttsProvByteDanceV3Name', match: '/api/v3/tts/unidirectional', site: 'both', speed: true, pitch: true, voiceList: false, noteKey: 'settings.ttsProvByteDanceV3' },
  { id: 'azure', name: 'Azure Speech', nameKey: 'settings.ttsProvAzureName', match: 'tts.speech.microsoft.com / *.tts.speech.azure.cn', site: 'both', speed: true, pitch: true, voiceList: true, noteKey: 'settings.ttsProvAzure' },
  { id: 'tencent', name: 'Tencent Cloud TTS', nameKey: 'settings.ttsProvTencentName', match: 'tts.tencentcloudapi.com / tts.intl.tencentcloudapi.com', site: 'both', speed: true, pitch: false, voiceList: false, noteKey: 'settings.ttsProvTencent' },
  { id: 'baidu', name: 'Baidu Smart Cloud TTS', nameKey: 'settings.ttsProvBaiduName', match: 'tsn.baidu.com', site: 'cn', speed: true, pitch: true, voiceList: false, noteKey: 'settings.ttsProvBaidu' },
  { id: 'aliyun', name: 'Alibaba Bailian DashScope', nameKey: 'settings.ttsProvAliyunName', match: 'dashscope(-intl|-us).aliyuncs.com', site: 'both', speed: true, pitch: false, voiceList: false, noteKey: 'settings.ttsProvAliyun' },
  { id: 'elevenlabs', name: 'ElevenLabs', match: 'api.elevenlabs.io', site: 'global', speed: true, pitch: false, voiceList: true, noteKey: 'settings.ttsProvElevenLabs' },
  { id: 'fishaudio', name: 'Fish Audio', match: 'api.fish.audio', site: 'global', speed: true, pitch: false, voiceList: true, noteKey: 'settings.ttsProvFishAudio' },
  { id: 'cartesia', name: 'Cartesia Sonic', match: 'api.cartesia.ai', site: 'global', speed: true, pitch: false, voiceList: true, noteKey: 'settings.ttsProvCartesia' },
  { id: 'gemini', name: 'Google Gemini', match: 'generativelanguage.googleapis.com', site: 'global', speed: false, pitch: false, voiceList: false, noteKey: 'settings.ttsProvGemini' },
  { id: 'polly', name: 'AWS Polly', match: 'polly.*.amazonaws.com(.cn)', site: 'both', speed: false, pitch: false, voiceList: true, noteKey: 'settings.ttsProvPolly' },
];

// ===== 伪流式输出（v2.3.34 起；v2.3.36 重构为「5 字动画队列 + 单一动画速度」）=====
// 前端「看上去像流式」：正文等模型全部输出完毕后再逐字（按顺序、一个接一个）渐显；思维链不受影响。
// 队列模型（v2.3.36）：任意时刻动画队列中共有 PSEUDO_QUEUE(=5) 个字处于渐显动画中，
//   相邻两字的触发间隔 = 动画时长 / (PSEUDO_QUEUE - 1)，即第 5 个字开始渐显的瞬间第 1 个字的动画恰好走完，
//   首尾无缝衔接，视觉上保持 5 字连续渐入的流水观感。
// 唯一可调参数「动画速度」（pseudoStreamSpeed）= 单个字渐显动画的播放时长（CSS fade-in），触发间隔由它自动推导。
export const PSEUDO_QUEUE = 5; // 动画队列字数：任意时刻同时处于渐显动画中的字数
export const PSEUDO_SPEED_MIN = 0.05; // 动画速度下限（秒/字，即单字渐显时长）
export const PSEUDO_SPEED_MAX = 1; // 动画速度上限（秒/字）
export const PSEUDO_SPEED_DEFAULT = 0.8; // 默认 0.8 秒/字（触发间隔自动 = 0.8/4 = 0.2 秒，与 v2.3.35 旧默认观感一致）
export function clampPseudoSpeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return PSEUDO_SPEED_DEFAULT;
  return Math.min(PSEUDO_SPEED_MAX, Math.max(PSEUDO_SPEED_MIN, n));
}

// 生图（专用图像生成 API）：拥有独立的 baseUrl/apiKey，与「模型配置中心」完全解耦，调用 OpenAI 兼容 /images/generations
export interface ImageGenSettings {
  enabled: boolean; // 总开关
  baseUrl: string; // 生图 API baseUrl（手填到版本号，如 https://api.openai.com/v1），系统自动补全 /images/generations
  apiKey: string; // 生图 API 密钥
  model: string; // 生图模型名，如 gpt-image-1 / dall-e-3
  size: string; // 尺寸，如 1024x1024
}

// 生视频（专用视频生成 API）：使用方式与生图完全一致，调用 OpenAI 兼容 /videos/generations（依供应商支持）
export interface VideoGenSettings {
  enabled: boolean; // 总开关
  baseUrl: string; // 视频生成 API baseUrl（手填到版本号，如 https://api.openai.com/v1），系统自动补全 /videos/generations
  apiKey: string; // 视频生成 API 密钥
  model: string; // 视频生成模型名，如 wan-2.1 / veo-2 / hunyuan-video
  duration: string; // 时长（秒），如 5
  size: string; // 尺寸，如 1280x720
}

// 深度思考等级：off=关闭；low/medium/high=不同强度（仅对支持深度思考的模型生效）
export type DeepThinkLevel = 'off' | 'low' | 'medium' | 'high';

// ===== 插件（声明式 / 受控 HTTP；可含沙箱化 JS，默认关）=====
// 工具型插件：声明一个受主进程白名单管控的 HTTP 调用，不执行任意 JS（除非 pluginAllowJs 开启）
export interface PluginTool {
  name: string; // 工具名（英文标识）
  description: string; // 用途说明（给人/给模型看）
  method: 'GET' | 'POST';
  url: string; // 目标 URL（须命中域名白名单）
  headers?: Record<string, string>;
  bodyTemplate?: string; // POST 请求体模板，可用 {{arg}} 占位
  paramName?: string; // GET 查询参数名（如 q）
}
export interface Plugin {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  source: 'worldbook' | 'role' | 'rule' | 'tool' | 'mixed'; // 导入后归类
  // 内容挂载（声明式）
  worldBookId?: string; // 若导入为世界书，记录其 id
  roleId?: string; // 若导入为角色，记录其 id
  ruleId?: string; // 若导入为规则，记录其 id
  // 工具挂载（受控 HTTP）
  tools?: PluginTool[];
  // 提示词片段（注入系统提示词）
  promptSegments?: string[];
  // 本地 JS 扩展入口（仅当全局 pluginAllowJs 时由沙箱加载）
  jsEntry?: string; // 相对插件目录的 js 文件名
  enabled: boolean; // 是否启用
  created_at: string;
}

export interface AppSettings {
  apiKeys: ApiKeys;
  defaultModel: string;
  visionModelId?: string; // 识图模型（v2.3.51）：聊天中带图消息路由到该模型识别与回复；空 = 未设置，图片按各模型能力处理
  models: ModelConfig[]; // 模型配置中心
  modelGroups: ModelGroup[]; // 模型分组（全局实体，ModelConfig.groupIds 引用其中的 id）
  theme: ThemeName;
  lang: 'zh' | 'en' | 'fr' | 'de' | 'ja' | 'ko' | 'es' | 'pt' | 'ru' | 'zh-Hant';
  windowBounds: { x: number; y: number; width: number; height: number; isMaximized?: boolean };
  lastBackupTime: string | null;
  fontSize: number; // 全局 UI 字体大小(px)
  fontFamily: string; // 字体样式 key：见 FONT_FAMILIES
  enableStreaming: boolean; // 全局流式输出开关（设置页）；模型可用 streamEnabled 单独覆盖
  streamParallel: number; // 群聊流式并行数量：1=顺序，3=适中，999=全部并行
  // ===== 伪流式输出（v2.3.34）=====
  // 开启后：正文在气泡内不再实时逐字显示（后端仍真实流式接收，思维链照常实时输出），
  // 等一条回复全部生成完毕，再以「每字固定间隔」的渐显动画匀速放出，营造流式观感。
  pseudoStreamEnabled?: boolean; // 伪流式输出总开关（默认关）
  pseudoStreamSpeed?: number; // 动画速度（秒/字，即单字渐显时长）：0.05~1，默认 0.8；相邻字触发间隔 = 此值/(PSEUDO_QUEUE-1)，自动推导
  // 全局模型参数（默认值）：模型编辑器内未单独设置的参数（温度/topP/topK）回退到这里。
  // 模型一旦在编辑器内单独设置，即用独立值、不随全局调节；「恢复到全局设置」按钮清空独立值。
  globalModelParams: {
    temperature?: number; // 全局默认温度（0~2）
    topP?: number; // 全局默认 top-p（0~1）；不设置=请求不带 top_p（用服务端模型默认）
    topK?: number; // 全局默认 top-k（0~50）；0=不带 top_k
  };
  // ===== 主动消息引擎（v2.3.17 新增；与经典 idle 定时消息隔离，二选一）=====
  proactiveEngine?: 'legacy' | 'nhpp'; // legacy=经典定时（默认，原机制不动）；nhpp=NHPP+贝叶斯智能调度
  proactiveDnd?: { enabled?: boolean; start?: string; end?: string }; // 勿扰窗口（'HH:mm'，支持跨午夜）
  proactiveDailyLimit?: number; // NHPP：每聊天每日主动消息硬上限（默认 5）
  proactiveFreshnessMin?: number; // NHPP：距上一条消息不足 N 分钟不触发（默认 10）
  // ===== MCP 服务器（v2.3.17 新增）=====
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>;
  chatBackgrounds: Record<string, string>; // key: "single:roleId" or "group:groupId"
  chatSoundPaths: Record<string, string>; // 每个聊天的自定义通知铃声路径，key 同上。空 = 使用全局通知音
  backupDir: string; // 自定义备份目录（空 = 每次手动选择）
  uiRadius: number; // 整体 UI 圆角(px)
  bubbleRadius: number; // 聊天气泡圆角(px)
  bubbleOpacity: number; // 聊天气泡透明度（50~100，100=完全不透明）
  voice: VoiceSettings;
  miniWindow: MiniWindowSettings;
  enableAnimations: boolean; // 全局 UI 动效总开关（低配电脑可关闭）
  // ===== 软件更新（v2.3.45）=====
  autoCheckUpdate?: boolean; // 启动时自动检查更新（默认 true）；关闭后仅手动检查
  autoDownloadUpdate?: boolean; // 发现新版本后自动从 GitHub 下载安装包（默认 false）
  updateDismissedVersion?: string; // 已忽略提醒的版本号（该版本不再弹提醒条）
  // ===== 更新提醒（v2.3.48）=====
  disableUpdateReminder?: boolean; // 永久关闭更新提醒（v2.3.48）：开启后不弹更新提醒弹窗、聊天界面也不显示更新提示条；设置页手动检查更新不受影响
  updatePopupShownVersion?: string; // 已弹过更新提醒弹窗的版本号（每版本只弹一次）
  modelTagMode?: 'api' | 'model'; // v2.3.44：聊天界面模型标签显示模式——'api'=显示 API 配置名（默认）/'model'=显示实际模型名；点击标签即可切换
  queueDockY?: number; // 请求队列贴边图标的纵坐标 px（v2.3.46，仅主界面右缘可上下拖动；缺省=视口垂直偏上 40%）
  // ===== 首启向导与自我身份 =====
  firstRunDone: boolean; // 是否已走过初始设置（老用户读取到旧 settings 时由 db 强制置 true）
  tutorialDone: boolean; // v2.3.90：是否已完成/已跳过「新手引导」（添加人物卡 → 开启第一个聊天）；与 firstRunDone 独立，二者互斥触发
  selfRoles: SelfRole[]; // 用户自建的「我的角色卡」
  currentSelfRoleId: string; // 全局默认使用的自我身份
  chatSelfRoles: Record<string, string>; // 按会话覆盖的自我身份：key="single:roleId"/"group:groupId"，value=selfRoleId / 'none' / 'default'
  worldBook: string; // 兼容旧版单世界书，迁移后清空
  defaultWorldBookId: string; // 全局默认世界书 id（空=不使用）
  chatWorldBooks: Record<string, string>; // 按聊天覆盖：key="single:roleId"/"group:groupId" -> worldBookId（''=继承角色/默认）
  chatModels?: Record<string, { follow?: boolean; modelId?: string }>; // 聊天级模型覆盖（v2.3.41，仅单聊）：key="single:roleId"；缺记录或 follow!=false → 跟随人物绑定模型（无则默认模型）；follow=false 且 modelId 有效 → 该聊天用自选模型，人物绑定模型与其他聊天不受影响
  worldBookOrder?: string[]; // 世界书管理界面展示顺序（worldBook id 数组，拖拽排序；缺失的按原顺序追加在末尾）
  pinnedChats?: string[]; // 置顶聊天（key="${chatType}:${chatId}"），聊天列表/悬浮球面板置顶展示
  chatOrder?: string[]; // 手动拖动的聊天顺序（key 数组，按显示顺序；新聊天按后端顺序追加末尾）
  sharedRuleIds: string[]; // 共用规则（所有对话/模型遵守）
  enableAutoMemory: boolean; // AI 自动提炼记忆（默认关）
  memorySummarizePrompt?: string; // 总结记忆提示词（AI 自动提炼与手动「AI 总结记忆」共用；出厂默认见 src/utils/builtinPrompts.ts，清空保存时自动填回默认）
  memoryInjectPrompt?: string; // 注入记忆提示词（构建角色 system prompt 时注入记忆用，{memories} 占位符替换为记忆列表；清空保存时自动填回默认）
  longMemory: Record<string, boolean>; // 长记忆独立开关：key="single:roleId"/"group:groupId"，每聊天独立；开启后该聊天启用「手动让 AI 总结记忆」按钮（仅长记忆开时可用）
  readWatermark: Record<string, number>; // 已读水位线：key="single:roleId"/"group:groupId"，value=该聊天最后已读消息 id；消息 id 大于该值视为未读（未加入该 key=全部未读）
  autoMemRoundCount: Record<string, number>; // 长记忆自动提炼轮数计数器：key="single:roleId"/"group:groupId"，value=累计用户消息轮数；满 10 触发一次 10 轮自动提炼并归零
  hideReasoning: boolean; // 隐藏思维链（默认开=折叠显示，点击箭头展开）
  deepThinkLevel: DeepThinkLevel; // 深度思考等级（off/low/medium/high）；仅对支持深度思考的模型生效，软件自动探测模型能力
  // ===== 输入框外观（自定义文字色 / 内部背景色，防止文字与背景相近看不清）=====
  inputTextColor?: string; // 输入框文字颜色（CSS 颜色），空=跟随主题
  inputBgColor?: string; // 输入框内部背景色（CSS 颜色），空=跟随主题（默认浅灰/白）
  // ===== 毛玻璃主题背景（仅 glass/frost 主题生效；设置毛玻璃专属，未开启毛玻璃主题时隐藏）=====
  glassBgColor?: string; // 毛玻璃主题自定义背景色（CSS 颜色），空=跟随主题默认渐变
  glassBgImage?: string; // 毛玻璃主题自定义背景图（data URL），空=无；设置后毛玻璃磨砂效果仍保留
  glassTokenText?: string; // 毛玻璃主题：Token 栏字体色（空=跟随主题主色）
  glassTokenBorder?: string; // 毛玻璃主题：Token 栏边框色/椭圆（空=跟随主题主色）
  glassBubbleUserText?: string; // 毛玻璃主题：用户气泡文字色（空=跟随主题）
  glassBubbleAiText?: string; // 毛玻璃主题：AI 气泡文字色（空=跟随主题）
  glassBubbleBorder?: string; // 毛玻璃主题：气泡边框色（空=透明/无）
  enableRandomEvents: boolean; // 随机事件：开启后聊天过程中会自动弹出随机事件（关闭则仅手动触发）
  // ===== 空闲主动回复 =====
  idleEnabled: boolean; // 全局主开关：关闭时所有按聊天的主动消息都失效（默认开）
  chatIdleEnabled: Record<string, boolean>; // 按聊天覆盖：key="single:roleId"/"group:groupId"；缺省视为 true
  idleInterval: number; // 触发主动消息前的静默时长（秒）：从离散选项中选择（默认 600s=10min）
  idleTimingMode?: 'fixed' | 'random'; // 触发时机模式：fixed=固定间隔（idleInterval）；random=每次在 [min,max] 内随机抽取（默认 fixed）
  idleRandomMinSec?: number; // 随机模式最小静默时长（秒）：钳制 1~86400（1 秒 ~ 24 小时），默认 60
  idleRandomMaxSec?: number; // 随机模式最大静默时长（秒）：钳制 1~86400 且 ≥ 最小值，默认 1800
  idleWriteMemory: boolean; // 主动消息是否参与 AI 自动记忆提炼（默认 false）
  idleSwitchAction: 'pause' | 'reset' | 'continue'; // 切换聊天时主动消息计时行为：继续（默认，每聊天独立后台触发）/暂停/重置
  idleCooldownUntilReply?: boolean; // 主动消息冷却：发出主动消息后，用户在该聊天回复前不再触发（默认 true；按聊天独立）
  eventMoodImpact: number; // 随机事件影响心情的程度（0~1）：0=事件只改好感度，1=事件必按所选心情改变角色心情
  dialogueMoodImpact: number; // 对话影响心情的程度（0~1）：0=心情只由事件决定，1=AI 充分依据对话判定当前心情
  autoRelationship: boolean; // AI 依据聊天内容自动判定关系值/关系类别（关闭则不更新，纯展示）
  autoMoments: boolean; // AI 依据聊天内容自动发朋友圈动态（关闭则仅手动发）
  dailyMomentLimit: number; // 朋友圈每日上限：每个（角色 + 自我身份）每天自动发条数，0 表示不限制
  momentsVideoEnabled?: boolean; // 朋友圈：AI 自动生成视频动态（需配置视频生成模型，否则默认关闭）
  // ===== 情绪与事件（高级可调）=====
  moodJudgeCooldownMs: number; // 心情判定冷却（毫秒）：防止每轮都调用 AI 判定，节省调用
  moodJudgeHistory: number; // 心情判定回顾的最近消息条数：AI 据此判断角色此刻心情
  moodSmoothing: number; // 心情过渡指数（0~1）：越小越平滑，角色不会忽喜忽悲；越大越灵敏，越贴近 AI 每次判定的目标心情。设为 1 等同旧版每次直接跳变
  momentsSensitivity: number; // 朋友圈敏感程度（0~1）：越高越容易自动发朋友圈（聊到尽兴就发），越低越克制，普通唠嗑几乎不发
  eventNegAffinity: number; // 好感度低于该值（或心情负面）→ 随机事件偏向冲突/拌嘴
  eventPosAffinity: number; // 好感度高于该值（或心情正面）→ 随机事件偏向甜蜜/撒娇
  eventHistory: number; // 事件生成时参考的最近对话条数
  eventMaxTokens: number; // 事件生成的最大 token 数（控制描述长度与成本）
  // ===== 群聊智能体互聊 =====
  groupScheduler: 'director' | 'roundRobin'; // 接话调度：导演模型智能挑人 / 按成员顺序轮询
  groupAutoRounds: number; // 自动接话轮数上限：0=无限，默认 6
  groupAutoChain: boolean; // 群聊发消息后，AI 是否主动按轮数上限多轮接话（无需手动点自动接话）
  groupMaxConsecutive: number; // 群聊自动接话时同一角色最多连续发言条数（1-20，默认 1）
  groupSelectReply: boolean; // 群聊选人回复：开启后每次主动发送与 AI 回复后，由用户自由选择下一位发言者
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
  // ===== 开机自启动 =====
  launchOnBoot?: boolean; // 系统启动时自动运行念语（默认开），可在设置中关闭
  // ===== 开屏动画（仅首次启动展示一次）=====
  hasShownSplash?: boolean; // 为 true 后，之后启动不再展示开屏动画
  // ===== 桌面悬浮球 =====
  floatingBall?: {
    enabled: boolean; // 是否启用悬浮球（默认开）
    x: number; // 上次停留的屏幕逻辑坐标 X（球窗左上角，语义版本见 coordVer）
    y: number; // 上次停留的屏幕逻辑坐标 Y（球窗左上角，语义版本见 coordVer）
    alwaysOnTop?: boolean; // 悬浮球是否始终置顶（默认开；关闭后会被其它窗口覆盖）
    autoHideInFullscreen?: boolean; // 主窗口全屏时自动关闭悬浮球（默认开）
    coordVer?: number; // x/y 坐标语义版本：1=旧单窗左上角（球偏移18），2=双窗架构球窗左上角（球偏移4）；读取时 <2 一次性 +14 迁移
  };
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
  translationLang?: 'auto' | 'zh' | 'en' | 'fr' | 'de' | 'ja' | 'ko' | 'es' | 'pt' | 'ru' | 'zh-Hant'; // 翻译目标语言：auto=随软件语言
  imageGen?: ImageGenSettings; // 生图（专用图像生成 API）设置
  videoGen?: VideoGenSettings; // 生视频（专用视频生成 API）设置
  // ===== 异步场景生图（后端按对话场景自动生图，节流 + 每对话开关）=====
  autoSceneImageChats: Record<string, boolean>; // 每对话独立开关：key="single:roleId"/"group:groupId" -> bool（主窗/小窗共用同一值，杜绝主关小开）
  sceneImageIntervalSec: number; // 两次生图最小间隔（秒），设置内可调节
  sceneImageJudge: 'llm' | 'heuristic'; // 场景判定方式：'llm'=轻量模型判定（最准，耗 token）；'heuristic'=关键词/情绪启发式（零成本）
  asyncImageUseAvatar: boolean; // 异步生图时自动读取 AI 人物头像作为参考，使生成形象更贴近角色（无关内容时不影响图片）
  // ===== 调试模式 / 内置内容 =====
  debugMode?: boolean; // 调试模式：进入时快照数据，会话内修改在退出时全部恢复（不生效），并输出错误报告
  builtinSeeded?: boolean; // 内置人物卡/世界书是否已注入（只注入一次，删除后不复活）
  builtinContentVersion?: number; // 内置内容版本：升级软件后据此刷新内置教学世界书/人物卡
  // ===== 自动生图/生视频前的调用确认（仅自动流程生效；手动生图生视频不弹）=====
  confirmBeforeAutoImage: boolean; // 自动生图（异步场景生图 / 朋友圈自动配图）调用模型前先弹确认框取得许可
  confirmBeforeAutoVideo: boolean; // 自动生视频（朋友圈自动配视频）调用模型前先弹确认框取得许可
  // ===== 插件系统 =====
  pluginAllowJs: boolean; // 允许本地 JS 插件（默认关；开启有 RCE 风险，需弹窗确认）
  // ===== 联网搜索（类 DeepSeek，上下文注入式）=====
  webSearchChats: Record<string, boolean>; // 每对话独立开关：key="single:roleId"/"group:groupId" -> bool
  searchProvider: 'auto' | 'duckduckgo' | 'bing' | 'baidu' | 'tavily' | 'serpapi' | 'model-native'; // 搜索供应商（auto=多引擎免费回退；duckduckgo/bing/baidu=免费直爬；tavily/serpapi=需 Key）
  searchApiKey: string; // 搜索 API Key（duckduckgo 免费源可空）
  // DeepSeek 式「检索后抓取网页正文」：搜索拿到结果链接后，并发读取前 N 篇网页的纯文本正文，
  // 过滤广告/CSS/JS 后作为上下文注入模型（而非仅用搜索摘要）。关闭则回退到摘要格式。
  webSearchFetchPages: boolean; // 是否抓取网页正文（默认 true）
  webSearchFetchCount: number; // 抓取前 N 条结果的正文（默认 5，范围 1~6）
  webSearchFetchTimeout: number; // 单页抓取超时 ms（默认 8000，范围 2000~20000）
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

// v2.3.44：model 一律留空（不预填模型名，由用户手填或从「刷新模型列表」选取）；
// 仅 baseUrl 对固定官方端点的提供商预填（openai/deepseek/anthropic/gemini），兼容类留空手填。
// ===== 软件更新（v2.3.45）：主进程 updater 探测结果，渲染层展示 =====
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  assetName?: string;
  assetUrl?: string; // 安装包直链
  assetSize?: number;
  sumAssetUrl?: string; // .sha256 校验文件直链（release assets 透传，与安装包同源同通道下载）
  sumAssetSize?: number; // .sha256 校验文件字节数（下载后顺带校验，可选加固）
  releaseUrl?: string;
  notes?: string;
  publishedAt?: string;
  received?: number;
  total?: number;
  percent?: number;
  filePath?: string; // 下载完成后的本地路径
  message?: string;
  manual?: boolean; // 是否用户手动触发的检查
  checkedAt?: number;
}

// 快速导入（v2.3.51）：拖入窗口的文件逐个导入结果
export type QuickImportKind = 'role' | 'worldbook' | 'rule' | 'plugin';
export interface QuickImportResult {
  name: string; // 文件名
  ok: boolean;
  kind?: QuickImportKind; // 成功时的导入类型
  error?: 'not_character_png' | 'read_failed' | 'unsupported'; // 失败原因
}

export const PROVIDER_DEFAULTS: Record<
  Provider,
  { baseUrl: string; model: string; maxContext: number; label: string }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: '', maxContext: 128000, label: 'OpenAI' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: '', maxContext: 64000, label: 'DeepSeek' },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: '',
    maxContext: 200000,
    label: 'Anthropic',
  },
  'anthropic-compatible': {
    baseUrl: '',
    model: '',
    maxContext: 200000,
    label: 'Anthropic 兼容',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: '',
    maxContext: 1000000,
    label: 'Gemini',
  },
  'openai-compatible': {
    baseUrl: '',
    model: '',
    maxContext: 128000,
    label: 'OpenAI 兼容',
  },
  local: {
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    maxContext: 8192,
    label: '本地模型',
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeys: {
    openai: '',
    deepseek: '',
    custom: { name: '', baseUrl: '', apiKey: '' },
  },
  defaultModel: '',
  visionModelId: '',
  models: [],
  modelGroups: [],
  theme: 'wechat',
  lang: 'zh',
  windowBounds: { x: 0, y: 0, width: 1200, height: 800 },
  lastBackupTime: null,
  fontSize: 14,
  fontFamily: 'system',
  enableStreaming: true, // 全局流式输出默认开启（v2.3.16 起；已保存过设置的老用户不受影响）
  streamParallel: 1,
  // ===== 伪流式输出（v2.3.34 起；v2.3.35 触发间隔与动画速度拆为独立设置）=====
  pseudoStreamEnabled: false, // 默认关闭：正文随生成实时显示（保持既有观感）
  pseudoStreamSpeed: PSEUDO_SPEED_DEFAULT, // 动画速度（单字渐显时长）0.8 秒/字；触发间隔 = 0.8/4 = 0.2 秒自动推导
  globalModelParams: { temperature: 1.0, topP: 0.95, topK: 50 }, // 全局模型参数默认值（模型未单独设置时生效）
  proactiveEngine: 'legacy', // 主动消息机制默认经典定时；NHPP 智能调度可在设置中切换
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
    ttsModel: '', // 模型名不内置默认：由用户手填或从服务端拉取，留空时合成前会明确报错提示补填
    ttsVoice: '', // 音色不内置默认：同上
    ttsAutoPlay: false,
    ttsEnabled: true,
    asrFormat: 'wav',
    asrLanguage: '',
    ttsVoices: {},
    ttsScopes: { dialogue: true, narration: false, psyche: false }, // 朗读范围默认仅对话
    ttsRegenerate: false, // 默认复用已合成音频（重复朗读不消耗 token）
    ttsSpeed: TTS_SPEED_DEFAULT, // 语速默认 1 倍（原速）
    ttsPitch: TTS_PITCH_DEFAULT, // 音调默认 0（不变）
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
  videoGen: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    duration: '5',
    size: '1280x720',
  },
  // ===== 异步场景生图默认值 =====
  autoSceneImageChats: {},
  sceneImageIntervalSec: 120,
  sceneImageJudge: 'llm',
  asyncImageUseAvatar: true,
  // ===== 自动生图/生视频调用确认默认值（默认开启，需用户许可才调用模型）=====
  confirmBeforeAutoImage: true,
  confirmBeforeAutoVideo: true,
  debugMode: false,
  builtinSeeded: false,
  builtinContentVersion: 0,
  // ===== 插件系统默认值 =====
  pluginAllowJs: false,
  // ===== 联网搜索默认值 =====
  webSearchChats: {},
  searchProvider: 'auto',
  webSearchFetchPages: true,
  webSearchFetchCount: 5,
  webSearchFetchTimeout: 8000,
  searchApiKey: '',
  enableAnimations: true,
  autoCheckUpdate: true,
  autoDownloadUpdate: false,
  modelTagMode: 'api',
  firstRunDone: false,
  tutorialDone: false,
  selfRoles: [],
  currentSelfRoleId: '',
  chatSelfRoles: {},
  worldBook: '',
  defaultWorldBookId: '',
  chatWorldBooks: {},
  chatModels: {},
  sharedRuleIds: [],
  enableAutoMemory: false,
  memorySummarizePrompt: DEFAULT_MEMORY_SUMMARIZE_PROMPT, // 总结记忆提示词出厂默认（可改，清空保存回默认）
  memoryInjectPrompt: DEFAULT_MEMORY_INJECT_PROMPT, // 注入记忆提示词出厂默认（可改，清空保存回默认）
  longMemory: {},
  readWatermark: {},
  autoMemRoundCount: {},
  hideReasoning: true,
  deepThinkLevel: 'off',
  inputTextColor: '',
  inputBgColor: '',
  glassBgColor: '',
  glassBgImage: '',
  glassTokenText: '',
  glassTokenBorder: '',
  glassBubbleUserText: '',
  glassBubbleAiText: '',
  glassBubbleBorder: '',
  enableRandomEvents: true,
  idleEnabled: true,
  chatIdleEnabled: {},
  idleInterval: 600,
  idleTimingMode: 'fixed',
  idleRandomMinSec: 60,
  idleRandomMaxSec: 1800,
  idleWriteMemory: false,
  idleSwitchAction: 'continue', // 默认「继续计时」：每个聊天独立计时并可在后台触发（主动消息类 IM 化）
  idleCooldownUntilReply: true, // 主动消息冷却默认开启：用户回复上一条主动消息后才发下一条
  eventMoodImpact: 1,
  dialogueMoodImpact: 1,
  moodJudgeCooldownMs: 20000,
  autoRelationship: true,
  autoMoments: true,
  dailyMomentLimit: 5,
  momentsVideoEnabled: false, // 朋友圈视频动态：默认关；未配置视频生成模型时即使开启也不生效
  moodJudgeHistory: 10,
  moodSmoothing: 0.5, // 心情过渡指数：默认 0.5，平滑过渡，避免忽喜忽悲
  momentsSensitivity: 0.5, // 朋友圈敏感程度：默认 0.5，中等，普通唠嗑不发、聊到尽兴才发
  eventNegAffinity: 30,
  eventPosAffinity: 70,
  eventHistory: 12,
  eventMaxTokens: 700,
  groupScheduler: 'director',
  groupAutoRounds: 6,
  groupAutoChain: true,
  groupMaxConsecutive: 1,
  groupSelectReply: false,
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
  launchOnBoot: true, // 开机自启动默认开启
  hasShownSplash: false,
  floatingBall: { enabled: true, x: 0, y: 0, alwaysOnTop: true, autoHideInFullscreen: true },
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

// ===== 请求队列（v2.3.46）：主界面贴边排队面板数据结构 =====
export interface QueueItemInfo {
  id: string; // 队列项唯一 id（调序用）
  label: string; // 请求来源标签（主进程硬编码简体中文）
  enqueuedAt: number; // 入队时间戳 ms
  etaMs: number; // 预计发出前的等待毫秒（估算值）
  locked?: boolean; // 队头正在倒计时，锁定不可调序
}
export interface QueueLaneInfo {
  key: string; // 限速键（模型 id）
  modelName: string;
  qps: number;
  intervalMs: number; // 两次请求的最小间隔 60000/qps
  items: QueueItemInfo[];
}
export interface QueueSnapshot {
  lanes: QueueLaneInfo[];
  total: number;
}

// ===== 异步场景生图状态提醒（v2.3.81）=====
// 主进程在 triggerSceneImage 的关键节点广播，渲染端据此显示「正在生图中」内联状态条，
// 并对成功 / 失败给出提醒。仅覆盖异步场景生图，不含手动生图、生视频、朋友圈配图。
export type SceneImageStatus = 'started' | 'success' | 'failed';
export interface SceneImageStatusEvent {
  status: SceneImageStatus;
  chatType: string; // 'single' | 'group'
  chatId: string;
  roleId: string; // 触发本次生图的角色 id。预留字段：渲染端当前未消费，供后续「点状态条定位角色」等扩展
  roleName: string; // AI 名字（单聊=角色名，群聊=群名或'AI'）
  error?: string; // 仅 failed：给用户看的简短原因（v2.3.83 起按码点安全截断，不会切坏 emoji）
  // v2.3.82 起 failed、v2.3.87 起 success 也带此字段。为 true 表示主进程已用提醒卡片告知过本次结果，
  // 渲染端据此跳过站内 Toast，避免「卡片 + Toast」双弹。
  // 仅在卡片**确实会展示**时为 true（两态同口径）：双窗全隐藏（默认放行），
  // 或窗口可见但用户正看着**别的**会话（此时 force=true 强制弹）。
  // 若用户正看着该会话，showNotifyCard 会被窗口可见性拦截、卡片不弹，故为 false，由渲染端弹 Toast。
  // 静默模式下面板一律被拦截，也为 false。
  cardShown?: boolean;
  ts: number; // 事件发出时的 Date.now()
}

// ===== 朋友圈自动配图 / 配视频状态提醒（v2.3.88）=====
// 主进程在「朋友圈自动发动态」流程里为 AI 自动配图 / 配视频的三个关键节点广播，
// 渲染端（MomentsView）据此弹站内 Toast，主进程在用户不在朋友圈页时改用后台提醒卡片。
//
// ⚠️ 为什么不复用 SceneImageStatusEvent：那条通道是**会话维度**的，字段带 chatType/chatId 语义
// （悬浮球未读、点卡片跳会话、渲染端按会话过滤都依赖它），而朋友圈没有「聊天」这个概念，
// 硬塞 chatType='moments' 会让 isViewingChat / pushUnread 等既有语义变得含糊。故另开一条通道。
export type MomentMediaStatus = 'started' | 'success' | 'failed';
export interface MomentMediaStatusEvent {
  status: MomentMediaStatus;
  kind: 'image' | 'video'; // 配图 / 配视频
  roleId: string; // 发动态的角色 id（也用作朋友圈维度的定位键）
  roleName: string; // 角色名，展示用
  error?: string; // 仅 failed：给用户看的简短原因（按码点安全截断）
  // 与 SceneImageStatusEvent.cardShown 同义：为 true 表示主进程已用提醒卡片告知过本次结果，
  // 渲染端据此跳过站内 Toast，避免「卡片 + Toast」双弹。仅在卡片**确实会展示**时为 true。
  cardShown?: boolean;
  ts: number; // 事件发出时的 Date.now()
}
