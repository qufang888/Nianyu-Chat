// Web 版后端编排（浏览器 / Capacitor WebView 环境）
// 替代 electron/main.ts 的 IPC 层：用 EventTarget 总线替代 broadcast / ipcRenderer，
// 用 IndexedDB 数据层（webStore）与纯 fetch AI 层（webAI）复刻桌面端全部编排逻辑。
// 图片在 Web 端以「dataURL 直接传递 + 入库后返回 id」的形式存在，替代桌面端的文件路径。
import type {
  Role,
  ChatMessage,
  Group,
  AppSettings,
  SendMessageResult,
  ModelConfig,
  WorldBook,
  Rule,
  SelfRole,
} from '../types';
import { RELATION_TYPES, RELATION_LABELS, normalizeRelation } from '../types';
import { getDataManager, WebDataManager } from './webStore';
import {
  queryAI,
  streamAI,
  listModels,
  testConnection,
  transcribeAudio,
  textToSpeech,
  generateImage as aiGenerateImage,
  aiCompleteRole,
  type AIMessage,
  type ContentPart,
} from './webAI';
import { parseCharacterCard, parseCharacterCardText } from '../utils/characterCard';
import type { NianyuAPI } from '../ipc';

const dm: WebDataManager = getDataManager();

// ===================== 事件总线（替代 ipcRenderer / broadcast） =====================
// 桌面端把事件广播到所有窗口；Web 端是单渲染进程（可能多个 React 组件订阅），
// 用 EventTarget 即可：onX 注册监听并返回取消函数，broadcast 派发 CustomEvent。
const bus = new EventTarget();
const busWrappers = new WeakMap<object, EventListener>();

function emit(channel: string, payload: unknown): void {
  try {
    bus.dispatchEvent(new CustomEvent(channel, { detail: payload }));
  } catch (e) {
    console.warn('[nianyu-web] emit skip:', channel, (e as Error)?.message);
  }
}

function on(channel: string, cb: (e: any, data: any) => void): () => void {
  const listener: EventListener = (ev) => cb(ev, (ev as CustomEvent).detail);
  busWrappers.set(cb, listener);
  bus.addEventListener(channel, listener);
  return () => bus.removeEventListener(channel, listener);
}

function off(channel: string, cb: (e: any, data: any) => void): void {
  const listener = busWrappers.get(cb);
  if (listener) bus.removeEventListener(channel, listener);
}

function broadcast(channel: string, payload: unknown): void {
  emit(channel, payload);
}

// ===================== 情感 / 心情 / 关系 词典与函数 =====================
const POSITIVE: [string, number, string][] = [
  ['喜欢', 3, '用户表达喜欢'], ['爱', 3, '用户表达爱意'], ['爱死', 3, '用户强烈喜爱'],
  ['谢谢', 2, '用户致谢'], ['感谢', 2, '用户致谢'], ['棒', 2, '用户称赞'], ['厉害', 2, '用户称赞'],
  ['可爱', 2, '用户称赞外貌'], ['漂亮', 2, '用户称赞外貌'], ['温柔', 2, '用户称赞性格'],
  ['开心', 1, '用户情绪正面'], ['高兴', 1, '用户情绪正面'], ['赞', 2, '用户点赞'],
  ['好', 1, '用户认可'], ['完美', 2, '用户高度认可'], ['支持', 1, '用户支持'],
];
const NEGATIVE: [string, number, string][] = [
  ['讨厌', -3, '用户表达厌恶'], ['恨', -3, '用户表达恨意'], ['烦', -2, '用户烦躁'],
  ['生气', -3, '用户生气'], ['滚', -3, '用户驱逐'], ['笨', -2, '用户贬低'],
  ['丑', -2, '用户贬低外貌'], ['无聊', -2, '用户无聊'], ['差', -2, '用户否定'],
  ['讨厌你', -3, '用户针对角色'], ['无聊透顶', -2, '用户强烈否定'],
  ['不理', -1, '用户冷淡'], ['懒得', -1, '用户敷衍'],
];

function analyzeSentiment(text: string): { change: number; reason: string } {
  if (!text) return { change: 0, reason: '无文本' };
  let change = 0;
  let reason = '中性';
  for (const [kw, val, r] of POSITIVE) {
    if (text.includes(kw)) { change += val; reason = r; }
  }
  for (const [kw, val, r] of NEGATIVE) {
    if (text.includes(kw)) { change += val; reason = r; }
  }
  change = Math.max(-3, Math.min(3, change));
  return { change, reason };
}

function affinityTone(affinity: number): string {
  if (affinity >= 80) return '你非常喜欢对方，请用亲密、热情、可撒娇的语气回复。';
  if (affinity >= 60) return '你对对方很有好感，请用亲切、友好的语气回复。';
  if (affinity >= 40) return '你对对方态度平常自然，请保持日常、得体的语气。';
  if (affinity >= 20) return '你对对方有些冷淡，请保持礼貌但略带距离感。';
  return '你对对方明显反感，请用疏离甚至略带刺的语气回复。';
}

function resolveWorldBook(chatType: string, chatId: string, settings: AppSettings): string {
  const key = `${chatType}:${chatId}`;
  let wbId: string | undefined;
  if (settings.chatWorldBooks && settings.chatWorldBooks[key]) {
    const v = settings.chatWorldBooks[key];
    if (v === 'none') return '';
    wbId = v;
  } else if (chatType === 'single') {
    const r = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
    if (r && r.worldBookId) {
      if (r.worldBookId === 'none') return '';
      wbId = r.worldBookId;
    }
  }
  if (!wbId) wbId = settings.defaultWorldBookId;
  if (!wbId) return '';
  const wb = dm.getWorldBook(wbId);
  return wb ? worldBookText(wb) : '';
}

function worldBookText(wb: WorldBook): string {
  if (wb.entries && wb.entries.length > 0) {
    return wb.entries.map((e) => (e.key ? `【${e.key}】${e.content}` : e.content)).join('\n');
  }
  return wb.content || '';
}

const MOODS = ['开心', '撒娇', '心动', '害羞', '平静', '低落', '难过', '生气'] as const;
const MOOD_DESC: Record<string, string> = {
  开心: '你此刻心情愉悦、眉眼弯弯，语气轻快温暖，会自然地把快乐分享给对方。',
  撒娇: '你此刻满心欢喜又有点黏人，会不自觉地撒娇，用软糯亲昵的语气靠近对方。',
  心动: '你此刻被对方牵动心弦，有些害羞又雀跃，言语间藏着甜蜜的试探与期待。',
  害羞: '你此刻有些脸红心跳、不太敢直视对方，说话会轻轻吞吞吐吐，带着青涩。',
  平静: '你此刻心境平和，如常地与对方相处，语气自然安稳。',
  低落: '你此刻情绪低落、兴致缺缺，语气会偏冷淡疏离，像隔着一层薄雾。',
  难过: '你此刻心里泛着酸涩与委屈，容易沉默，偶尔语气带刺也只是藏在乎。',
  生气: '你此刻压着一股火气与不满，语气会带刺、生冷，但深处仍记挂着对方。',
};
const NEG_MOODS: string[] = [...MOODS].filter((m) => m === '生气' || m === '低落' || m === '难过');
const POS_MOODS: string[] = [...MOODS].filter((m) => m === '开心' || m === '撒娇' || m === '心动');

function buildEmotionContext(role: Role): string {
  const eff = role.mood && (MOODS as readonly string[]).includes(role.mood) ? role.mood : '平静';
  const desc = MOOD_DESC[eff] || MOOD_DESC['平静'];
  return `【当前情绪】${desc}`;
}

async function judgeMood(role: Role, settings: AppSettings, recent: string): Promise<string | null> {
  const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
  if (!cfg) return null;
  const impact = settings.dialogueMoodImpact ?? 1;
  let strength = '适度根据最近对话调整角色心情';
  if (impact >= 0.66) strength = '让最近对话充分决定角色此刻的心情';
  else if (impact <= 0.33) strength = '除非对话里出现明显情绪信号，否则尽量保持角色当前心情稳定';
  const prompt = [
    `你是角色「${role.name}」。`,
    role.personality ? `性格：${role.personality}。` : '',
    `当前好感度：${role.affinity}/100。`,
    role.mood ? `角色当前心情：${role.mood}（仅作参考，可依据新对话更新）。` : '',
    `最近对话：\n${recent || '（尚无对话）'}`,
    `请依据上述对话里用户的言行、角色的性格与好感度，${strength}，判断角色「此刻」最贴切的心情。`,
    `只输出一个 JSON：{ "mood": "心情词", "reason": "一句话理由" }。`,
    `mood 只能从以下枚举选一个：${MOODS.join(' / ')}。`,
  ].filter(Boolean).join('\n');
  try {
    const res = await queryAI(cfg, [
      { role: 'system', content: '你是判断角色心情的助手，严格按要求的 JSON 格式输出，不要输出任何多余内容。' },
      { role: 'user', content: prompt },
    ], 200);
    if (res.content.startsWith('（')) return null;
    const p = parseFirstJson(res.content);
    if (p && typeof p.mood === 'string' && (MOODS as readonly string[]).includes(p.mood)) return p.mood;
    return null;
  } catch {
    return null;
  }
}

const moodJudgeCooldown = new Map<string, number>();
const relationshipCooldown = new Map<string, number>();
const DAILY_MOMENT_LIMIT = 5;

async function requestMoodJudge(chatType: string, chatId: string, roleId: string): Promise<void> {
  const settings = dm.getSettings();
  if ((settings.dialogueMoodImpact ?? 1) <= 0) return;
  const now = Date.now();
  const last = moodJudgeCooldown.get(roleId) || 0;
  if (now - last < (settings.moodJudgeCooldownMs ?? 20000)) return;
  const obs = getObserverConfig(chatType, chatId);
  if (obs.observerMode) {
    if (chatType === 'group' && obs.observerNoEmotion) return;
    if (chatType === 'single' && chatId.startsWith('obs:') && !obs.privateAffectsEmotion) return;
  }
  moodJudgeCooldown.set(roleId, now);
  const role = dm.getRole(roleId);
  if (!role) return;
  const history = dm.getMessages(chatType, chatId).slice(-(settings.moodJudgeHistory ?? 10));
  const recent = history.map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 140)}`).join('\n');
  const mood = await judgeMood(role, settings, recent);
  if (mood) {
    dm.updateRole(roleId, { mood });
    broadcast('role:mood', { roleId, chatType, chatId, mood });
    logEmotionIfObserver(chatType, chatId, roleId);
  }
}

async function requestRelationshipAndMoments(
  chatType: string,
  chatId: string,
  roleId: string,
  opts: { force?: boolean; doRelationship?: boolean; doMoments?: boolean } = {}
): Promise<{ ok: boolean; moments: number; relation?: string }> {
  const force = opts.force ?? false;
  const settings = dm.getSettings();
  const doRelationship = opts.doRelationship ?? settings.autoRelationship;
  const doMoments = opts.doMoments ?? settings.autoMoments;
  if (chatType !== 'single' && chatType !== 'group') return { ok: false, moments: 0 };
  if (!doRelationship && !doMoments) return { ok: false, moments: 0 };
  const now = Date.now();
  const last = relationshipCooldown.get(roleId) || 0;
  if (!force && now - last < (settings.moodJudgeCooldownMs ?? 20000)) return { ok: false, moments: 0 };
  relationshipCooldown.set(roleId, now);
  const role = dm.getRole(roleId);
  if (!role) return { ok: false, moments: 0 };
  const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
  if (!cfg) return { ok: false, moments: 0 };
  const selfRole = resolveActiveSelfRole(settings, chatType, chatId);
  const history = dm.getMessages(chatType, chatId).slice(-(settings.moodJudgeHistory ?? 10));
  const recent = history.map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 200)}`).join('\n');
  const userDesc = selfRole
    ? `用户当前使用的身份「${selfRole.name}」${selfRole.personality ? `（${selfRole.personality}）` : ''}。`
    : '用户身份未指定（默认身份）。';

  let storedRelation: string | undefined;
  if (doRelationship) storedRelation = await judgeRelationship(role, cfg, userDesc, recent);
  let added = 0;
  if (doMoments) added = await judgeAndPostMoments(role, cfg, userDesc, recent, settings, selfRole, force);
  return { ok: true, moments: added, relation: storedRelation };
}

async function judgeRelationship(role: Role, cfg: ModelConfig, userDesc: string, recent: string): Promise<string | undefined> {
  const prompt = [
    `你是关系分析助手。请基于最近对话，分析角色「${role.name}」与用户之间的关系状态。`,
    `角色设定：${role.personality || role.background || '（无）'}`,
    userDesc,
    `最近对话：\n${recent || '（尚无对话）'}`,
    `请输出严格 JSON，不要任何多余内容：`,
    `{`,
    `  "relation": "关系类别，必须从以下枚举中精确选一个 key：${RELATION_TYPES.map((k) => `${k}(${RELATION_LABELS[k]})`).join('/')}；无法确定时给 stranger",`,
    `  "trend": "closer 表示关系更亲近 / farther 表示更疏远 / same 表示持平",`,
    `  "intimacy": 0到100的整数，表示当前的亲密程度`,
    `}`,
  ].join('\n');
  try {
    const res = await queryAI(cfg, [
      { role: 'system', content: '你是分析助手，严格只输出要求的 JSON，不要输出任何解释或多余内容。' },
      { role: 'user', content: prompt },
    ], 600);
    const parsed: any = parseFirstJson(res.content);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const prevBond = role.bond ?? 0;
    const intimacy = typeof parsed.intimacy === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.intimacy))) : null;
    const patch: Partial<Role> = {};
    if (intimacy != null) {
      const next = Math.round(Math.max(0, Math.min(1000, intimacy * 10)));
      if (next !== prevBond) patch.bond = next;
    }
    const rel = normalizeRelation(parsed.relation);
    if (rel) patch.relation = rel;
    if (Object.keys(patch).length) {
      dm.updateRole(role.id, patch);
      broadcast('role:bond', { roleId: role.id });
    }
    return rel;
  } catch {
    return undefined;
  }
}

async function judgeAndPostMoments(
  role: Role,
  cfg: ModelConfig,
  userDesc: string,
  recent: string,
  settings: AppSettings,
  selfRole: SelfRole | undefined,
  force: boolean
): Promise<number> {
  const prompt = [
    `你是朋友圈动态助手。请基于最近对话，判断角色「${role.name}」此刻是否想发一条朋友圈，并写出内容。`,
    `角色设定：${role.personality || role.background || '（无）'}`,
    userDesc,
    `最近对话：\n${recent || '（尚无对话）'}`,
    `请输出严格 JSON，不要任何多余内容：`,
    `{`,
    `  "postMoments": true或false，表示角色此刻是否真的想发朋友圈。仅当对话中出现了角色有冲动分享的内容（真实情绪起伏、重要事件、用户说了特别的话、关系进展、有趣的梗等）才为 true；日常寒暄、礼节性回复、无明显可分享点时必须为 false。不要因为被要求就发。`,
    `  "moments": [ { "content": "角色视角的朋友圈文案，第一人称，自然口语化，不超过60字", "needImage": true或false, "imagePrompt": "若需要配图，这里是英文生图提示词，否则空串" } ]`,
    `}`,
    `只有当 postMoments 为 true 时才给出 moments，最多2条；否则 moments 给空数组。发朋友圈应当是低频、有质感的，不要每条对话都发。`,
  ].join('\n');
  let parsed: any = null;
  try {
    const res = await queryAI(cfg, [
      { role: 'system', content: '你是朋友圈助手，严格只输出要求的 JSON，不要输出任何解释或多余内容。' },
      { role: 'user', content: prompt },
    ], 600);
    parsed = parseFirstJson(res.content);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== 'object') return 0;
  if (parsed.postMoments === false) return 0;
  if (!Array.isArray(parsed.moments) || parsed.moments.length === 0) return 0;

  const ig = settings.imageGen;
  const igCfg = ig && ig.enabled && ig.baseUrl && ig.apiKey ? { baseUrl: ig.baseUrl, apiKey: ig.apiKey } : undefined;
  const selfRoleId = selfRole?.id || '';
  const todayKey = new Date().toISOString().slice(0, 10);
  const resolvedLimit =
    role.momentDailyLimit && role.momentDailyLimit > 0
      ? role.momentDailyLimit
      : settings.dailyMomentLimit === 0
        ? Infinity
        : settings.dailyMomentLimit && settings.dailyMomentLimit > 0
          ? settings.dailyMomentLimit
          : DAILY_MOMENT_LIMIT;
  const perCharLimit = force ? Infinity : resolvedLimit;
  let todayCount = force
    ? 0
    : dm.listMoments(role.id, true).filter((m) => m.published && (m.created_at || '').slice(0, 10) === todayKey).length;
  let added = 0;
  for (const mm of parsed.moments.slice(0, 2)) {
    if (todayCount >= perCharLimit) break;
    if (!mm || typeof mm.content !== 'string' || !mm.content.trim()) continue;
    const images: string[] = [];
    if (mm.needImage && igCfg) {
      try {
        const { b64 } = await aiGenerateImage(igCfg, String(mm.imagePrompt || mm.content).slice(0, 400), ig!.model || 'gpt-image-1', ig!.size || '1024x1024');
        if (b64) {
          const p = await saveGeneratedImage(b64);
          if (p) images.push(p);
        }
      } catch {
        /* 配图失败降级为纯文字 */
      }
    }
    dm.addMoment(role.id, mm.content.trim(), images, undefined, selfRoleId);
    added++;
    todayCount++;
  }
  if (added > 0) {
    broadcast('moments:changed', { roleId: role.id, selfRoleId });
    broadcast('moments:autoPosted', { roleId: role.id, selfRoleId, roleName: role.name, count: added });
  }
  return added;
}

// ===================== 系统提示 / 消息构建 =====================
function buildSystemPrompt(role: Role, freezeMemory = false): string {
  const parts: string[] = [];
  parts.push(`你是数字人「${role.name}」。`);
  if (role.gender) parts.push(`性别：${role.gender}。`);
  if (role.age) parts.push(`年龄：${role.age}。`);
  if (role.occupation) parts.push(`职业：${role.occupation}。`);
  if (role.personality) parts.push(`性格：${role.personality}。`);
  if (role.background) parts.push(`背景故事：${role.background}。`);
  if (role.appearance) parts.push(`外貌：${role.appearance}。`);
  if (role.world_setting) parts.push(`世界观：${role.world_setting}。`);
  if (role.key_memories) parts.push(`关键记忆：${role.key_memories}。`);
  if (role.rules) parts.push(`行为规则与禁忌：${role.rules}。`);
  if (role.example_dialogue) parts.push(`说话风格示例：${role.example_dialogue}。`);
  parts.push(affinityTone(role.affinity));
  parts.push(buildEmotionContext(role));
  const settings = dm.getSettings();
  const allRules = dm.listRules();
  const charRuleIds = role.ruleIds || [];
  const charRules = allRules.filter((r) => charRuleIds.includes(r.id));
  const sharedRules = allRules.filter((r) => (settings.sharedRuleIds || []).includes(r.id));
  if (charRules.length > 0) parts.push(`【角色专属规则】\n${charRules.map((r) => `- ${r.content}`).join('\n')}`);
  if (sharedRules.length > 0) parts.push(`【通用规则（所有对话均需遵守）】\n${sharedRules.map((r) => `- ${r.content}`).join('\n')}`);
  if (!freezeMemory) {
    const memories = dm.listMemories(role.id);
    if (memories.length > 0) parts.push(`【关于你与用户的记忆】\n${memories.map((m) => `- ${m.content}`).join('\n')}`);
  }
  parts.push('请始终以该角色身份和口吻回复，不要跳出角色，不要提及你是AI或语言模型。');
  return parts.join('\n');
}

// 把图片引用（dataURL 或入库后的 id）解析为可用于多模态的 dataURL
function imageToDataUrl(p: string): string | null {
  if (!p) return null;
  if (p.startsWith('data:')) return p;
  return dm.getDataUrlSync(p);
}

function collectImagePaths(m: ChatMessage): string[] {
  return ((m.images && m.images.length ? m.images : m.image_path ? [m.image_path] : []) as string[]).filter(Boolean);
}

function buildUserContent(text: string, images: string[], vision: boolean): string | ContentPart[] {
  if (vision && images.length) {
    const parts: ContentPart[] = [];
    if (text && text.trim()) parts.push({ type: 'text', text });
    for (const p of images) {
      const url = imageToDataUrl(p);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
    if (parts.length) return parts;
  }
  return images.length ? `[用户发送了一张图片]${text || ''}` : text || '';
}

function historyToMessages(history: ChatMessage[], vision = false): AIMessage[] {
  return history.map((m) => {
    const images = collectImagePaths(m);
    const base = m.content || '';
    return {
      role: m.sender_type === 'user' ? 'user' : 'assistant',
      content: buildUserContent(base, images, vision),
    };
  });
}

// ===================== 速率限制 / 翻译 =====================
const RATE_WINDOW_MS = 60000;
const modelRequestLog = new Map<string, number[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rateWaitMs(modelId: string): number {
  const settings = dm.getSettings();
  const cfg = settings.models.find((m) => m.id === modelId);
  const qps = cfg?.qps;
  if (!qps || qps <= 0) return 0;
  const now = Date.now();
  const arr = (modelRequestLog.get(modelId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  modelRequestLog.set(modelId, arr);
  if (arr.length < qps) return 0;
  return RATE_WINDOW_MS - (now - arr[0]) + 50;
}

function rateMark(modelId: string): void {
  if (!modelId) return;
  const now = Date.now();
  const arr = (modelRequestLog.get(modelId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  modelRequestLog.set(modelId, arr);
}

async function translateText(text: string, settings: AppSettings): Promise<string> {
  const modelId = settings.translationModelId || settings.defaultModel;
  const cfg = settings.models.find((m) => m.id === modelId && m.enabled);
  if (!cfg) return text;
  const target = settings.translationLang === 'auto' ? settings.lang : settings.translationLang || settings.lang;
  const langName = target === 'en' ? 'English' : '中文';
  const prompt = `请将下面的文本翻译成${langName}，只返回译文本身，不要任何解释，也不要用引号包裹：\n\n${text}`;
  const res = await queryAI(cfg, [
    { role: 'system', content: 'You are a precise translator. Output only the translation.' },
    { role: 'user', content: prompt },
  ], 1024);
  return res.content || text;
}

// ===================== 成员解析 / 模型解析 =====================
function resolveMembers(chatType: string, chatId: string, content: string): Role[] {
  let memberRoles: Role[] = [];
  if (chatType === 'single') {
    const r = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
    if (r) memberRoles = [r];
  } else {
    const g = dm.getGroup(chatId);
    if (g) {
      const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
      let roles = ids.map((id) => dm.getRole(id)).filter(Boolean) as Role[];
      const mentioned = roles.filter((r) => content.includes('@' + r.name));
      if (mentioned.length > 0) roles = mentioned;
      memberRoles = roles;
    }
  }
  return memberRoles;
}

function resolveRoleModel(role: Role, settings: AppSettings): ModelConfig | undefined {
  return (
    settings.models.find((m) => m.id === role.model_config_id && m.enabled) ||
    settings.models.find((m) => m.id === settings.defaultModel && m.enabled)
  );
}

function getDefaultModelConfig(settings: AppSettings): ModelConfig | undefined {
  return settings.models.find((m) => m.id === settings.defaultModel && m.enabled);
}

function resolveActiveSelfRole(settings: AppSettings, chatType: string, chatId: string): SelfRole | undefined {
  const override = settings.chatSelfRoles?.[`${chatType}:${chatId}`];
  let id: string | undefined;
  if (override === undefined || override === 'default' || override === '') {
    id = settings.currentSelfRoleId;
  } else if (override === 'none') {
    return undefined;
  } else {
    id = override;
  }
  if (!id) return undefined;
  return settings.selfRoles?.find((r) => r.id === id);
}

function validateModels(memberRoles: Role[], settings: AppSettings): void {
  const invalid = memberRoles.find((r) => !resolveRoleModel(r, settings));
  if (invalid) throw new Error(`角色[${invalid.name}]绑定的模型已失效，请重新选择模型`);
}

// Web 端：把可能直接传来的 dataURL 入库为 id（已是 id 则保留）
async function storeImages(paths?: string[] | null): Promise<string[] | null> {
  if (!paths || !paths.length) return null;
  const ids: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    if (p.startsWith('data:')) {
      const id = await dm.saveImage(p);
      if (id) ids.push(id);
    } else {
      ids.push(p);
    }
  }
  return ids.length ? ids : null;
}

async function addUserMessage(p: {
  chatType: string;
  chatId: string;
  content: string;
  imagePath?: string | null;
  imagePaths?: string[];
}): Promise<ChatMessage> {
  const settings = dm.getSettings();
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const multi = p.imagePaths && p.imagePaths.length ? await storeImages(p.imagePaths) : null;
  const storedImage = multi ? multi[0] : (p.imagePath ? (p.imagePath.startsWith('data:') ? (await storeImages([p.imagePath]))?.[0] || null : p.imagePath) : null);
  const msg = dm.addMessage({
    chat_type: p.chatType as any,
    chat_id: p.chatId,
    sender_type: 'user',
    sender_name: selfRole?.name || '我',
    content: p.content || '',
    image_path: storedImage,
    images: multi || null,
    token_used: 0,
    timestamp: new Date().toISOString(),
  } as any);
  broadcast('stream:user', msg);
  return msg;
}

function applyAffinityChange(role: Role, content: string, storedImage: string | null): number {
  const sentiment = analyzeSentiment(content);
  if (sentiment.change !== 0 && !storedImage) {
    return dm.updateAffinity(role.id, sentiment.change, sentiment.reason);
  }
  return role.affinity;
}

// ===================== 消息构建（单聊 / 群聊） =====================
function buildMessagesForRole(
  role: Role, content: string, storedImage: string | null, history: ChatMessage[],
  affinityTotal: number, selfRole?: SelfRole | null, worldBook?: string, instruction?: string,
  freezeMemory = false, privateObserver = false, storedImages?: string[] | null, vision = false
): AIMessage[] {
  const parts: string[] = [buildSystemPrompt({ ...role, affinity: affinityTotal }, freezeMemory)];
  if (privateObserver) {
    parts.push('（这是你与观察者之间完全私密的一对一对话，外界与其他对局参与者都看不到。你可以毫无保留地袒露内心推演、真实盘算与私下想法，不必像公开场合那样克制。）');
  }
  if (worldBook && worldBook.trim()) parts.push(`【世界书 / 共享世界观】\n${worldBook.trim()}`);
  if (selfRole && selfRole.name) {
    const b: string[] = [`你正在与用户「${selfRole.name}」对话。`];
    if (selfRole.gender) b.push(`性别：${selfRole.gender}。`);
    if (selfRole.age) b.push(`年龄：${selfRole.age}。`);
    if (selfRole.short_intro) b.push(`简介：${selfRole.short_intro}。`);
    if (selfRole.personality) b.push(`性格：${selfRole.personality}。`);
    if (selfRole.background) b.push(`背景：${selfRole.background}。`);
    if (selfRole.world_setting) b.push(`世界观：${selfRole.world_setting}。`);
    parts.push(`【对话对象（用户）设定】\n${b.join('\n')}`);
  }
  const sysPrompt = parts.join('\n\n');
  const finalImages = storedImages && storedImages.length ? storedImages : storedImage ? [storedImage] : [];
  return [
    { role: 'system', content: sysPrompt },
    ...historyToMessages(history, vision),
    { role: 'user', content: instruction ? instruction : buildUserContent(content, finalImages, vision) },
  ];
}

function buildGroupMessages(
  role: Role, memberNames: string[], history: ChatMessage[], affinityTotal: number,
  selfRole: SelfRole | undefined, worldBook: string, instruction?: string,
  freezeMemory = false, groupId?: string, vision = false
): AIMessage[] {
  const parts: string[] = [buildSystemPrompt({ ...role, affinity: affinityTotal }, freezeMemory)];
  if (worldBook && worldBook.trim()) parts.push(`【世界书 / 共享世界观】\n${worldBook.trim()}`);
  if (selfRole && selfRole.name) {
    const b: string[] = [`群聊中的用户是「${selfRole.name}」。`];
    if (selfRole.gender) b.push(`性别：${selfRole.gender}。`);
    if (selfRole.age) b.push(`年龄：${selfRole.age}。`);
    if (selfRole.short_intro) b.push(`简介：${selfRole.short_intro}。`);
    if (selfRole.personality) b.push(`性格：${selfRole.personality}。`);
    if (selfRole.background) b.push(`背景：${selfRole.background}。`);
    if (selfRole.world_setting) b.push(`世界观：${selfRole.world_setting}。`);
    parts.push(`【对话对象（用户）设定】\n${b.join('\n')}`);
  }
  parts.push(
    `【群聊规则】\n这是一个多人群聊，成员有：${memberNames.join('、')}。\n` +
    `你是「${role.name}」，只能以「${role.name}」的身份发言。\n` +
    `下面对话中「名字: 内容」表示对应成员或用户的发言。\n` +
    `不要代替其他成员或用户发言；不要在回复前加「${role.name}:」之类的名字前缀，直接说话即可。` +
    (groupId && dm.getGroup(groupId)?.aiMentionEnabled ? `\n如果需要引起其他成员的注意，可以使用 @名字 来点名他们。` : '')
  );
  const msgs: AIMessage[] = [{ role: 'system', content: parts.join('\n\n') }];
  for (const m of history) {
    const images = collectImagePaths(m);
    const isSelf = m.sender_type === 'ai' && m.sender_name === role.name;
    const roleTag: 'user' | 'assistant' = isSelf ? 'assistant' : 'user';
    const text = images.length ? `[发送了一张图片]${m.content || ''}` : (m.content || '');
    const textContent = isSelf ? text : `${m.sender_name}: ${text}`;
    let content: string | ContentPart[];
    if (vision && images.length) {
      const parts2: ContentPart[] = [];
      if (textContent) parts2.push({ type: 'text', text: textContent });
      for (const p of images) {
        const url = imageToDataUrl(p);
        if (url) parts2.push({ type: 'image_url', image_url: { url } });
      }
      content = parts2.length ? parts2 : textContent;
    } else {
      content = textContent;
    }
    const last = msgs[msgs.length - 1];
    if (last && last.role === roleTag && typeof last.content === 'string' && typeof content === 'string') {
      last.content += `\n${content}`;
    } else {
      msgs.push({ role: roleTag, content });
    }
  }
  if (instruction) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') last.content += `\n\n${instruction}`;
    else msgs.push({ role: 'user', content: instruction });
  } else if (msgs[msgs.length - 1].role !== 'user') {
    msgs.push({ role: 'user', content: '（请继续这段群聊，自然接话）' });
  }
  return msgs;
}

function getGroupMemberNames(groupId: string): string[] {
  const g = dm.getGroup(groupId);
  if (!g) return [];
  return g.member_ids.split(',').map((s) => s.trim()).filter(Boolean)
    .map((id) => dm.getRole(id)?.name).filter(Boolean) as string[];
}

// ===================== 流式 / 生成 =====================
const streamControllers = new Map<string, AbortController>();
function registerStream(chatId: string, c: AbortController): void {
  const prev = streamControllers.get(chatId);
  if (prev && prev !== c) prev.abort();
  streamControllers.set(chatId, c);
}
function unregisterStream(chatId: string, c: AbortController): void {
  if (streamControllers.get(chatId) === c) streamControllers.delete(chatId);
}
function abortStreamsForChat(chatId: string): void {
  const c = streamControllers.get(chatId);
  if (c) { c.abort(); streamControllers.delete(chatId); }
}

function sendStreamChunk(streamId: string, chunk: { content: string; done: boolean; error: string; reasoning?: string; seq?: number }): void {
  broadcast('stream:chunk', { streamId, ...chunk });
}
function sendStreamStart(streamId: string, roleId: string, roleName: string): void {
  broadcast('stream:start', { streamId, roleId, roleName });
}
function sendStreamDone(streamId: string, message: ChatMessage): void {
  broadcast('stream:done', { streamId, message });
}

async function generateAIResponses(
  p: { chatType: string; chatId: string; content: string; imagePath?: string | null; imagePaths?: string[] | null },
  memberRoles: Role[],
  settings: AppSettings,
  controller?: AbortController
): Promise<Omit<SendMessageResult, 'userMessage'>> {
  const storedImage = p.imagePath || null;
  const storedImages = p.imagePaths && p.imagePaths.length ? p.imagePaths : (p.imagePath ? [p.imagePath] : []);
  const history = dm.getMessages(p.chatType, p.chatId).slice(-16);
  const resolveModel = (role: Role): ModelConfig | undefined => resolveRoleModel(role, settings);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const isGroup = p.chatType === 'group';
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const groupNames = isGroup ? getGroupMemberNames(p.chatId) : [];

  const runOne = async (role: Role, hist: ChatMessage[]) => {
    const cfg = resolveModel(role) as ModelConfig;
    const vision = !!cfg?.supportsImages;
    const isPrivate = !isGroup && p.chatId.startsWith('obs:');
    const allowEmotion = !isPrivate || !!obs?.privateAffectsEmotion;
    const total = allowEmotion ? applyAffinityChange(role, p.content, storedImage) : role.affinity;
    const messages = isGroup
      ? buildGroupMessages(role, groupNames, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, p.chatId, vision)
      : buildMessagesForRole(role, p.content, storedImage, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, isPrivate, storedImages, vision);
    const streamId = `${p.chatId}:${role.id}`;
    sendStreamStart(streamId, role.id, role.name);
    try {
      const wait = rateWaitMs(cfg.id);
      if (wait > 0) await sleep(wait);
      rateMark(cfg.id);
      const res = await queryAI(cfg, messages, 1024, controller?.signal);
      const aiMsg = dm.addMessage({
        chat_type: p.chatType as any, chat_id: p.chatId, sender_type: 'ai', sender_name: role.name,
        content: res.content, reasoning: res.reasoning, image_path: null,
        token_used: res.promptTokens + res.completionTokens, timestamp: new Date().toISOString(),
      } as any);
      sendStreamDone(streamId, aiMsg);
      void requestMoodJudge(p.chatType, p.chatId, role.id);
      void requestRelationshipAndMoments(p.chatType, p.chatId, role.id);
      return { aiMsg, roleId: role.id, total, tokens: aiMsg.token_used };
    } catch (e: any) {
      const interrupted = controller ? controller.signal.aborted : false;
      const content = interrupted ? '...' : `⚠️ ${e?.message || String(e)}`;
      const msg = dm.addMessage({
        chat_type: p.chatType as any, chat_id: p.chatId, sender_type: 'ai', sender_name: role.name,
        content, image_path: null, token_used: 0, timestamp: new Date().toISOString(),
      } as any);
      sendStreamDone(streamId, msg);
      return { aiMsg: msg, roleId: role.id, total, tokens: 0 };
    }
  };

  let results: { aiMsg: ChatMessage; roleId: string; total: number; tokens: number }[];
  if (isGroup) {
    results = [];
    for (const role of memberRoles) {
      const hist = dm.getMessages(p.chatType, p.chatId).slice(-24);
      results.push(await runOne(role, hist));
    }
  } else {
    results = await Promise.all(memberRoles.map((role) => runOne(role, history)));
  }

  const aiMessages: ChatMessage[] = [];
  const affinityChanges: { role_id: string; change: number; total: number }[] = [];
  let totalTokens = 0;
  for (const r of results) {
    aiMessages.push(r.aiMsg);
    const original = memberRoles.find((role) => role.id === r.roleId)?.affinity || r.total;
    affinityChanges.push({ role_id: r.roleId, change: r.total - original, total: r.total });
    totalTokens += r.tokens;
  }
  return { aiMessages, affinityChanges, totalTokens };
}

async function handleSend(p: {
  chatType: string; chatId: string; content: string; imagePath?: string | null; imagePaths?: string[];
}): Promise<SendMessageResult> {
  const settings = dm.getSettings();
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  validateModels(memberRoles, settings);
  const userMsg = await addUserMessage(p);
  const result = await generateAIResponses({ ...p, imagePath: userMsg.image_path, imagePaths: userMsg.images }, memberRoles, settings);
  return { userMessage: userMsg, ...result };
}

async function handleSendUser(p: {
  chatType: string; chatId: string; content: string; imagePath?: string | null; imagePaths?: string[];
}): Promise<ChatMessage> {
  return addUserMessage(p);
}

async function handleSendAI(p: {
  chatType: string; chatId: string; content: string; imagePath?: string | null; imagePaths?: string[];
}): Promise<Omit<SendMessageResult, 'userMessage'>> {
  const settings = dm.getSettings();
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  validateModels(memberRoles, settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);
  try {
    return await generateAIResponses(p, memberRoles, settings, controller);
  } finally {
    clearTimeout(timer);
    unregisterStream(p.chatId, controller);
  }
}

async function handleStream(p: {
  chatType: string; chatId: string; content: string; imagePath?: string | null; imagePaths?: string[];
}): Promise<{ userMessage: ChatMessage; members: { streamId: string; roleId: string; roleName: string }[] }> {
  const settings = dm.getSettings();
  const parallel = Math.max(1, Math.floor(settings.streamParallel) || 1);
  const memberRoles = resolveMembers(p.chatType, p.chatId, p.content);
  if (memberRoles.length === 0) throw new Error('未找到可回复的角色，请检查群组成员或角色是否存在');
  validateModels(memberRoles, settings);

  const userMsg = await addUserMessage(p);
  const storedImage = userMsg.image_path;
  const storedImages = userMsg.images || (userMsg.image_path ? [userMsg.image_path] : []);
  const history = dm.getMessages(p.chatType, p.chatId).slice(-16);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const isGroup = p.chatType === 'group';
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const groupNames = isGroup ? getGroupMemberNames(p.chatId) : [];

  const members = memberRoles.map((role) => ({ streamId: `${p.chatId}:${role.id}`, roleId: role.id, roleName: role.name }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);

  const streamOne = async (role: Role) => {
    if (controller.signal.aborted) return;
    const cfg = resolveRoleModel(role, settings) as ModelConfig;
    const vision = !!cfg?.supportsImages;
    const streamId = `${p.chatId}:${role.id}`;
    let seq = 0;
    const emitChunk = (content: string, done: boolean, error: string, reasoning = '') => {
      seq += 1;
      sendStreamChunk(streamId, { content, reasoning, done, error, seq });
    };
    const isPrivate = !isGroup && p.chatId.startsWith('obs:');
    const allowEmotion = !isPrivate || !!obs?.privateAffectsEmotion;
    const total = allowEmotion ? applyAffinityChange(role, p.content, storedImage) : role.affinity;
    const hist = isGroup ? dm.getMessages(p.chatType, p.chatId).slice(-24) : history;
    const messages = isGroup
      ? buildGroupMessages(role, groupNames, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, p.chatId, vision)
      : buildMessagesForRole(role, p.content, storedImage, hist, total, selfRole, worldBook, undefined, obs?.freezeMemory, isPrivate, storedImages, vision);
    sendStreamStart(streamId, role.id, role.name);
    let full = '';
    let reasoningAcc = '';
    const truncateMarker = '...';
    const finalizeRole = (content: string, reasoning: string, interrupted: boolean) => {
      let finalContent = content.trim();
      if (interrupted) {
        if (!finalContent) finalContent = truncateMarker;
        else if (!/[.…。]+$/.test(finalContent)) finalContent += truncateMarker;
      }
      const aiMsg = dm.addMessage({
        chat_type: p.chatType as any, chat_id: p.chatId, sender_type: 'ai', sender_name: role.name,
        content: finalContent, reasoning: reasoning || '', image_path: null, token_used: 0, timestamp: new Date().toISOString(),
      } as any);
      sendStreamDone(streamId, aiMsg);
      if (!interrupted) { void requestMoodJudge(p.chatType, p.chatId, role.id); void requestRelationshipAndMoments(p.chatType, p.chatId, role.id); }
    };
    try {
      const wait = rateWaitMs(cfg.id);
      if (wait > 0) await sleep(wait);
      rateMark(cfg.id);
      if (cfg.provider === 'anthropic') {
        const res = await queryAI(cfg, messages, 1024);
        if (controller.signal.aborted) { finalizeRole(res.content || '', res.reasoning || '', true); return; }
        emitChunk(res.content, true, '', res.reasoning || '');
        finalizeRole(res.content, res.reasoning || '', false);
        return;
      }
      const res = await streamAI(cfg, messages, 1024, (chunk) => {
        if (chunk.content) full += chunk.content;
        if (chunk.reasoning) reasoningAcc += chunk.reasoning;
        emitChunk(chunk.content || '', chunk.done, '', chunk.reasoning || '');
      }, controller);
      if (controller.signal.aborted) { finalizeRole(full || '', reasoningAcc || '', true); return; }
      finalizeRole(full || res.content || '', reasoningAcc || res.reasoning || '', false);
    } catch (e: any) {
      if (controller.signal.aborted) { finalizeRole(full || '', reasoningAcc || '', true); return; }
      emitChunk('', true, e?.message || String(e));
    }
  };

  (async () => {
    try {
      if (isGroup) {
        for (const role of memberRoles) {
          if (controller.signal.aborted) break;
          await streamOne(role);
        }
      } else {
        for (let i = 0; i < memberRoles.length; i += parallel) {
          if (controller.signal.aborted) break;
          const batch = memberRoles.slice(i, i + parallel);
          await Promise.all(batch.map((role) => streamOne(role)));
        }
      }
    } finally {
      clearTimeout(timer);
      unregisterStream(p.chatId, controller);
      broadcast('stream:roundDone', { chatId: p.chatId, chatType: p.chatType });
    }
  })();

  return { userMessage: userMsg, members };
}

// ===================== 群聊接话调度 =====================
function pickRoundRobin(memberRoles: Role[], history: ChatMessage[]): Role {
  const lastAi = [...history].reverse().find((m) => m.sender_type === 'ai');
  if (!lastAi) return memberRoles[0];
  const idx = memberRoles.findIndex((r) => r.name === lastAi.sender_name);
  return memberRoles[(idx + 1) % memberRoles.length] || memberRoles[0];
}

async function pickNextSpeaker(memberRoles: Role[], settings: AppSettings, history: ChatMessage[]): Promise<Role> {
  if (settings.groupScheduler === 'roundRobin' || memberRoles.length === 1) return pickRoundRobin(memberRoles, history);
  const cfg = settings.models.find((m) => m.id === settings.defaultModel && m.enabled) || settings.models.find((m) => m.enabled);
  if (!cfg) return pickRoundRobin(memberRoles, history);
  const lastSpeaker = [...history].reverse().find((m) => m.sender_type === 'ai')?.sender_name || '';
  const candidates = memberRoles.filter((r) => r.name !== lastSpeaker);
  const pool = candidates.length > 0 ? candidates : memberRoles;
  const recent = history.slice(-10).map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 200)}`).join('\n');
  try {
    const res = await queryAI(cfg, [
      { role: 'system', content: '你是群聊导演。根据最近的对话，从候选成员中选出最适合接话的一位。只输出该成员的名字，不要输出任何其他内容。' },
      { role: 'user', content: `候选成员：${pool.map((r) => r.name).join('、')}\n\n最近对话：\n${recent}\n\n最适合接话的成员是：` },
    ], 24);
    const text = (res.content || '').trim();
    const hit = pool.find((r) => text.includes(r.name)) || memberRoles.find((r) => text.includes(r.name));
    if (hit) return hit;
  } catch (e) {
    console.error('导演调度失败，回退轮询', e);
  }
  return pickRoundRobin(memberRoles, history);
}

function countConsecutiveByRole(history: ChatMessage[], roleName: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].sender_name === roleName) count++;
    else break;
  }
  return count;
}

async function handleGroupContinue(p: { chatId: string }): Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }> {
  const settings = dm.getSettings();
  const g = dm.getGroup(p.chatId);
  if (!g) return { ok: false, error: '群组不存在' };
  const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
  const memberRoles = ids.map((id) => dm.getRole(id)).filter(Boolean) as Role[];
  if (memberRoles.length === 0) return { ok: false, error: '群组没有可用成员' };
  try { validateModels(memberRoles, settings); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }

  const history = dm.getMessages('group', p.chatId);
  let role = await pickNextSpeaker(memberRoles, settings, history);
  const maxConsecutive = Math.max(1, Math.min(20, settings.groupMaxConsecutive ?? 1));
  if (memberRoles.length > 1 && countConsecutiveByRole(history, role.name) >= maxConsecutive) {
    const idx = memberRoles.findIndex((r) => r.id === role.id);
    role = memberRoles[(idx + 1) % memberRoles.length] || role;
  }
  const cfg = resolveRoleModel(role, settings) as ModelConfig;
  const selfRole = resolveActiveSelfRole(settings, 'group', p.chatId);
  const obs = getObserverConfig('group', p.chatId);
  const worldBook = obs.freezeMemory ? '' : resolveWorldBook('group', p.chatId, settings);
  const messages = buildGroupMessages(
    role, memberRoles.map((r) => r.name), history.slice(-24), role.affinity, selfRole, worldBook,
    '（继续这段群聊：以你自己的身份自然接话，可以回应他人观点、提出新话题或提问，避免重复已说过的内容。）',
    obs.freezeMemory, p.chatId
  );

  const streamId = `${p.chatId}:${role.id}`;
  let seq = 0;
  const emitChunk = (content: string, done: boolean, error: string, reasoning = '') => { seq += 1; sendStreamChunk(streamId, { content, reasoning, done, error, seq }); };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  registerStream(p.chatId, controller);
  sendStreamStart(streamId, role.id, role.name);
  try {
    let full = '';
    let tokens = 0;
    let reasoning: string | undefined;
    if (cfg.provider === 'anthropic') {
      const res = await queryAI(cfg, messages, 1024);
      full = res.content; tokens = res.promptTokens + res.completionTokens; reasoning = res.reasoning;
      emitChunk(full, true, '', res.reasoning || '');
    } else {
      const res = await streamAI(cfg, messages, 1024, (chunk) => {
        if (chunk.content) full += chunk.content;
        emitChunk(chunk.content || '', chunk.done, '', chunk.reasoning || '');
      }, controller);
      full = full || res.content; tokens = res.promptTokens + res.completionTokens; reasoning = res.reasoning;
    }
    const aiMsg = dm.addMessage({
      chat_type: 'group', chat_id: p.chatId, sender_type: 'ai', sender_name: role.name,
      content: full, reasoning, image_path: null, token_used: tokens, timestamp: new Date().toISOString(),
    } as any);
    sendStreamDone(streamId, aiMsg);
    void requestMoodJudge('group', p.chatId, role.id);
    void requestRelationshipAndMoments('group', p.chatId, role.id);
    return { ok: true, roleId: role.id, roleName: role.name };
  } catch (e: any) {
    emitChunk('', true, e?.message || String(e));
    return { ok: false, roleId: role.id, roleName: role.name, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
    unregisterStream(p.chatId, controller);
  }
}

// ===================== 空闲主动回复 =====================
async function handleProactive(p: { chatType: string; chatId: string }): Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }> {
  const settings = dm.getSettings();
  const globalOn = settings.idleEnabled !== false;
  const perChat = (settings.chatIdleEnabled || {})[`${p.chatType}:${p.chatId}`];
  const chatOn = perChat === undefined ? true : !!perChat;
  if (!globalOn || !chatOn) return { ok: false, error: '主动消息已关闭' };
  const memberRoles = resolveMembers(p.chatType, p.chatId, '');
  if (memberRoles.length === 0) return { ok: false, error: '未找到可回复的角色，请检查角色或群组成员是否存在' };
  try { validateModels(memberRoles, settings); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }

  const isGroup = p.chatType === 'group';
  let role = memberRoles[0];
  if (isGroup) {
    const history = dm.getMessages('group', p.chatId);
    role = await pickNextSpeaker(memberRoles, settings, history);
  }
  const history = dm.getMessages(p.chatType, p.chatId).slice(isGroup ? -24 : -16);
  const selfRole = resolveActiveSelfRole(settings, p.chatType, p.chatId);
  const obs = isGroup ? getObserverConfig('group', p.chatId) : null;
  const worldBook = obs?.freezeMemory ? '' : resolveWorldBook(p.chatType, p.chatId, settings);
  const instruction =
    '（主动发起）你注意到用户暂时没有说话。请结合刚才的对话氛围与你当前的【情绪】，' +
    '主动向用户发一条自然、贴合情境的消息：可以延续刚才的话题，也可以自然地开启一个新话题。' +
    '直接说话，不要加任何前缀、括号说明或「用户不在」之类的元描述。';
  const isPrivate = !isGroup && p.chatId.startsWith('obs:');
  const messages = isGroup
    ? buildGroupMessages(role, memberRoles.map((r) => r.name), history, role.affinity, selfRole, worldBook, instruction, obs?.freezeMemory, p.chatId)
    : buildMessagesForRole(role, '', null, history, role.affinity, selfRole, worldBook, instruction, obs?.freezeMemory, isPrivate);

  const cfg = resolveRoleModel(role, settings) as ModelConfig;
  const streamId = `${p.chatId}:${role.id}`;
  sendStreamStart(streamId, role.id, role.name);
  const controller = new AbortController();
  registerStream(p.chatId, controller);
  try {
    const res = await queryAI(cfg, messages, 1024);
    if (controller.signal.aborted) return { ok: false, roleId: role.id, roleName: role.name };
    const aiMsg = dm.addMessage({
      chat_type: p.chatType as any, chat_id: p.chatId, sender_type: 'ai', sender_name: role.name,
      content: res.content, reasoning: res.reasoning, image_path: null,
      token_used: res.promptTokens + res.completionTokens, timestamp: new Date().toISOString(), from_proactive: true,
    } as any);
    sendStreamDone(streamId, aiMsg);
    void requestMoodJudge(p.chatType, p.chatId, role.id);
    void requestRelationshipAndMoments(p.chatType, p.chatId, role.id);
    return { ok: true, roleId: role.id, roleName: role.name };
  } catch (e: any) {
    const errMsg = dm.addMessage({
      chat_type: p.chatType as any, chat_id: p.chatId, sender_type: 'ai', sender_name: role.name,
      content: `⚠️ ${e?.message || String(e)}`, image_path: null, token_used: 0, timestamp: new Date().toISOString(),
    } as any);
    sendStreamDone(streamId, errMsg);
    return { ok: false, roleId: role.id, roleName: role.name, error: e?.message || String(e) };
  } finally {
    unregisterStream(p.chatId, controller);
  }
}

// ===================== 随机事件 =====================
function parseFirstJson(text: string): any | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const EVENT_THEMES: Record<string, string> = {
  gift: '可以围绕「送礼 / 收到礼物 / 准备惊喜小礼物」展开，让礼物成为情感的载体。',
  date: '可以围绕「约会 / 外出 / 两人独处的浪漫时刻」展开，制造甜蜜氛围。',
  daily: '可以是生活化、轻松有趣的日常小插曲，像普通日子里的一点小波澜。',
  surprise: '可以是一个出人意料、令人心动的小转折，带来新鲜感。',
  quarrel: '可以是一场小小的争执、拌嘴或误会，让情绪有起伏与张力。',
};

const activeEvents = new Map<string, { window: string }>();

async function handleRandomEvent(p: {
  chatType: string; chatId: string; theme?: string; window?: string;
}): Promise<
  | { busy: true; window?: string }
  | { roleId: string; roleName: string; event: string; options: { text: string; affinity: number; mood: string }[] }
> {
  const settings = dm.getSettings();
  const members = resolveMembers(p.chatType, p.chatId, '');
  if (members.length === 0) throw new Error('未找到可生成事件的角色，请检查角色/群组成员是否存在');
  if (activeEvents.has(p.chatId)) return { busy: true, window: activeEvents.get(p.chatId)?.window || '' };
  activeEvents.set(p.chatId, { window: p.window || '' });
  const releaseTimer = setTimeout(() => activeEvents.delete(p.chatId), 5 * 60 * 1000);
  try {
    const role = p.chatType === 'group' ? members[Math.floor(Math.random() * members.length)] : members[0];
    const cfg = getDefaultModelConfig(settings) || resolveRoleModel(role, settings);
    if (!cfg) throw new Error('未配置可用的默认模型，无法生成随机事件（请在设置中选定默认模型）');
    const history = dm.getMessages(p.chatType, p.chatId).slice(-(settings.eventHistory ?? 12));
    const recent = history.map((m) => `${m.sender_name}: ${(m.content || '').slice(0, 160)}`).join('\n');
    const themeHint = p.theme && EVENT_THEMES[p.theme] ? EVENT_THEMES[p.theme] : '';
    let bias = '';
    const lowMood = NEG_MOODS.includes(role.mood || '');
    const highMood = POS_MOODS.includes(role.mood || '');
    if (role.affinity < (settings.eventNegAffinity ?? 30) || lowMood) {
      bias = '当前角色对用户的亲近度偏低或心情不佳，事件可以偏向制造一点小摩擦、拌嘴、试探或情绪低落的小插曲，让角色可能说出带刺、冷淡或委屈的话；选项里应包含能缓和矛盾与加深矛盾的不同走向。';
    } else if (role.affinity > (settings.eventPosAffinity ?? 70) || highMood) {
      bias = '当前角色对用户的亲近度很高或心情很好，事件可以偏向甜蜜、撒娇、心动或浪漫的小插曲；选项里应包含能进一步升温与稍拉开距离的不同走向。';
    } else {
      bias = '事件自然、平衡即可，不刻意偏向甜蜜或冲突。';
    }
    const prompt = [
      `你是角色「${role.name}」。`,
      role.personality ? `性格：${role.personality}。` : '',
      role.background ? `背景：${role.background.slice(0, 200)}。` : '',
      `当前好感度：${role.affinity}/100（数值越高越亲近）。`,
      role.mood ? `当前心情：${role.mood}。` : '',
      `当前对话片段：\n${recent || '（对话刚开始）'}`,
      `请在你们的世界观里，即兴生成一个自然发生、能推动聊天发展的「随机事件 / 小插曲」。${themeHint}`,
      bias,
      `只输出一个 JSON 对象，不要任何额外解释，格式严格如下：`,
      `{ "event": "对事件的一两句生动描述（可包含你的语气）", "options": [ { "text": "用户的某个选择（第一人称或动作）", "affinity": 3, "mood": "撒娇" }, { "text": "另一个选择", "affinity": 0, "mood": "平静" }, { "text": "再一个选择", "affinity": -2, "mood": "生气" } ] }`,
      `options 必须恰好 3 个。affinity 为该选择带来的好感度变化（正数增加、负数减少，范围约 -5 到 +5，需符合选择的性质）。mood 为该选择后角色会进入的心情，只能从以下枚举选一个：${MOODS.join(' / ')}。`,
    ].filter(Boolean).join('\n');
    const res = await queryAI(cfg, [
      { role: 'system', content: '你是一个擅长即兴叙事与角色扮演的助手，严格按用户要求的 JSON 格式输出，不要输出 JSON 以外的任何内容。' },
      { role: 'user', content: prompt },
    ], settings.eventMaxTokens ?? 700);
    if (res.content.startsWith('（')) throw new Error(res.content);
    const parsed = parseFirstJson(res.content);
    if (!parsed || typeof parsed.event !== 'string' || !Array.isArray(parsed.options) || parsed.options.length === 0) throw new Error('事件生成结果解析失败，请重试');
    const validMoods: string[] = [...MOODS];
    const options = parsed.options
      .filter((o: any) => o && typeof o.text === 'string')
      .map((o: any) => ({ text: o.text, affinity: Number(o.affinity) || 0, mood: validMoods.includes(o.mood) ? o.mood : '平静' }))
      .slice(0, 3);
    if (options.length < 2) throw new Error('事件选项不足，请重试');
    return { roleId: role.id, roleName: role.name, event: String(parsed.event), options };
  } catch (e) {
    activeEvents.delete(p.chatId);
    clearTimeout(releaseTimer);
    throw e;
  } finally {
    clearTimeout(releaseTimer);
  }
}

async function handleChooseEvent(p: {
  chatType: string; chatId: string; roleId: string; change: number; choiceText: string; eventText: string; mood?: string;
}): Promise<{ roleId: string; roleName: string; total: number; change: number; mood: string }> {
  const role = dm.getRole(p.roleId);
  if (!role) throw new Error('角色不存在');
  const total = dm.updateAffinity(p.roleId, p.change, `随机事件：${p.eventText} → ${p.choiceText}`);
  let mood = role.mood || '平静';
  const impact = dm.getSettings().eventMoodImpact ?? 1;
  if (p.mood && impact > 0 && Math.random() < impact) {
    dm.updateRole(p.roleId, { mood: p.mood });
    mood = p.mood;
    broadcast('role:mood', { roleId: p.roleId, chatType: p.chatType, chatId: p.chatId, mood: p.mood });
  }
  logEmotionIfObserver(p.chatType, p.chatId, p.roleId);
  activeEvents.delete(p.chatId);
  const moodNote = p.mood && mood === p.mood ? ` · 心情 → ${mood}` : '';
  const affinityNote = p.change !== 0 ? `好感 ${p.change > 0 ? '+' : ''}${p.change}` : '';
  let sysMsg: any = null;
  if (affinityNote || moodNote) {
    sysMsg = {
      chat_type: p.chatType as any, chat_id: p.chatId, sender_type: 'system', sender_name: 'system',
      content: `${role.name} ${affinityNote}${moodNote}（当前好感：${total}）`,
      token_used: 0, id: Date.now() + Math.floor(Math.random() * 1000), timestamp: new Date().toISOString(), image_path: null,
    };
    dm.addMessage(sysMsg as any);
  }
  broadcast('event:chosen', { chatType: p.chatType, chatId: p.chatId, roleId: p.roleId, roleName: role.name, total, change: p.change, mood, message: sysMsg });
  return { roleId: role.id, roleName: role.name, total, change: p.change, mood };
}

// ===================== 观察者模式（对局） =====================
interface ObserverConfig {
  observerMode: boolean; freezeMemory: boolean; publicWriteMemory: boolean;
  observerNoEmotion: boolean; privateWriteMemory: boolean; privateAffectsEmotion: boolean;
}

function parseObsGroupId(chatId: string): string | null {
  if (chatId.startsWith('obs:')) {
    const parts = chatId.split(':');
    if (parts.length >= 3) return parts[1];
  }
  return null;
}

function getObserverConfig(chatType: string, chatId: string): ObserverConfig {
  const groupId = chatType === 'group' ? chatId : parseObsGroupId(chatId);
  const g = groupId ? dm.getGroup(groupId) : null;
  return {
    observerMode: !!g?.observerMode,
    freezeMemory: !!g?.freezeMemory,
    publicWriteMemory: g?.publicWriteMemory !== false,
    observerNoEmotion: g?.observerNoEmotion !== false,
    privateWriteMemory: !!g?.privateWriteMemory,
    privateAffectsEmotion: !!g?.privateAffectsEmotion,
  };
}

const matchEmotionLogs = new Map<string, { t: string; roleId: string; roleName: string; mood: string; affinity: number }[]>();

function initialEmotionSnapshot(groupId: string): { t: string; roleId: string; roleName: string; mood: string; affinity: number }[] {
  const g = dm.getGroup(groupId);
  if (!g) return [];
  const now = new Date().toISOString();
  return g.member_ids.split(',').map((s) => s.trim()).filter(Boolean)
    .map((id) => dm.getRole(id)).filter(Boolean)
    .map((r) => ({ t: now, roleId: r!.id, roleName: r!.name, mood: r!.mood || '平静', affinity: r!.affinity }));
}

function logEmotionIfObserver(chatType: string, chatId: string, roleId: string): void {
  const groupId = chatType === 'group' ? chatId : parseObsGroupId(chatId);
  if (!groupId) return;
  const g = dm.getGroup(groupId);
  if (!g || !g.observerMode) return;
  if (!matchEmotionLogs.has(groupId)) return;
  const role = dm.getRole(roleId);
  if (!role) return;
  matchEmotionLogs.get(groupId)!.push({ t: new Date().toISOString(), roleId, roleName: role.name, mood: role.mood || '平静', affinity: role.affinity });
}

async function setObserverMode(p: { groupId: string; on: boolean; applyPreset?: boolean }): Promise<{ ok: boolean; archivePath?: string }> {
  const g = dm.getGroup(p.groupId);
  if (!g) return { ok: false };
  if (p.on) {
    const patch: Partial<Group> = { observerMode: true };
    if (g.observerMode !== true || p.applyPreset) {
      patch.freezeMemory = false; patch.observerNoEmotion = true; patch.privateWriteMemory = false; patch.privateAffectsEmotion = false;
    }
    dm.createGroup({ ...g, ...patch });
    matchEmotionLogs.set(p.groupId, initialEmotionSnapshot(p.groupId));
    broadcast('group:observer', { groupId: p.groupId, observerMode: true });
    return { ok: true };
  }
  // 关闭 = 结束对局。Web 端不写本地归档文件，仅清理内存状态
  matchEmotionLogs.delete(p.groupId);
  dm.createGroup({ ...g, observerMode: false });
  broadcast('group:observer', { groupId: p.groupId, observerMode: false });
  return { ok: true, archivePath: undefined };
}

async function setObserverConfig(p: { groupId: string; patch: Partial<ObserverConfig> }): Promise<{ ok: boolean }> {
  const g = dm.getGroup(p.groupId);
  if (!g) return { ok: false };
  dm.createGroup({ ...g, ...p.patch } as any);
  broadcast('group:observer', { groupId: p.groupId, observerMode: !!g.observerMode, config: p.patch });
  return { ok: true };
}

// ===================== 世界书 / 规则 / 记忆 / 插件 =====================
function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function extractLoreEntries(raw: any): any[] {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.entries)) return raw.entries;
  if (raw.entries && typeof raw.entries === 'object') return Object.values(raw.entries);
  if (raw.lorebook && raw.lorebook.entries) {
    const e = raw.lorebook.entries;
    return Array.isArray(e) ? e : Object.values(e);
  }
  return [];
}

function parseWorldBook(content: string, name: string): WorldBook {
  const now = new Date().toISOString();
  const base: WorldBook = { id: '', name: name || '导入的世界书', description: '', content: '', entries: [], created_at: now, updated_at: now };
  const text = (content || '').trim();
  if (!text) return base;
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === 'object') {
      const entries = extractLoreEntries(raw);
      if (entries.length > 0 || raw.lorebook || raw.worldbook || raw.world_book) {
        base.entries = entries.map((e: any) => ({
          id: uid('wbe'), key: Array.isArray(e.keys) ? e.keys.join(', ') : (e.key || ''),
          content: e.content || e.entry || '', constant: !!e.constant,
        }));
        if (raw.name) base.name = raw.name;
        if (raw.description) base.description = raw.description;
        else if (raw.lorebook?.name) base.description = raw.lorebook.name;
        return base;
      }
      if (raw.content || raw.text || raw.scenario || raw.world) {
        base.content = raw.content || raw.text || raw.scenario || raw.world || '';
        if (raw.name) base.name = raw.name;
        if (raw.description) base.description = raw.description;
        return base;
      }
    }
  } catch { /* 非 JSON */ }
  base.content = text;
  return base;
}

function parseRule(content: string, name: string): Rule {
  const now = new Date().toISOString();
  let n = name || '导入的规则';
  let c = (content || '').trim();
  try {
    const raw = JSON.parse(c);
    if (raw && typeof raw === 'object') {
      if (raw.content || raw.text) c = raw.content || raw.text;
      if (raw.name) n = raw.name;
    }
  } catch { /* 纯文本 */ }
  return { id: '', name: n, content: c, scope: 'character', source: 'plugin', created_at: now, updated_at: now };
}

function buildRoleFromParsed(p: any, nameHint?: string): Role {
  const now = new Date().toISOString();
  return {
    id: uid('role'), name: p.name || nameHint || '未命名角色', avatar_path: '', gender: p.gender || '',
    age: p.age, occupation: p.occupation || '', short_intro: p.short_intro || '', personality: p.personality || '',
    background: p.background || '', appearance: p.appearance || '', world_setting: p.world_setting || '',
    key_memories: p.key_memories || '', rules: p.rules || '', example_dialogue: p.example_dialogue || '',
    first_message: p.first_message || '', affinity: 50, affinity_factor: 1, model_config_id: '', worldBookId: '',
    ruleIds: [], created_at: now, updated_at: now,
  } as Role;
}

async function importPluginLogic(content: string, name: string): Promise<{ kind: 'worldbook' | 'rule' | 'role'; id: string; name: string }> {
  const text = (content || '').trim();
  let raw: any = null;
  try { raw = JSON.parse(text); } catch { raw = null; }
  if (raw && typeof raw === 'object') {
    const ent = extractLoreEntries(raw);
    if (ent.length > 0 || raw.lorebook || raw.worldbook || raw.world_book) {
      const wb = parseWorldBook(content, name || '导入的世界书'); wb.id = uid('wb'); dm.saveWorldBook(wb);
      return { kind: 'worldbook', id: wb.id, name: wb.name };
    }
    const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const isRole = d.name || d.char_name || d.character_name || d.title || d.description || d.char_persona || d.personality || d.first_mes;
    if (isRole) {
      const parsed = parseCharacterCard(raw);
      const role = buildRoleFromParsed(parsed, name);
      dm.createRole(role);
      return { kind: 'role', id: role.id, name: role.name };
    }
  }
  const rule = parseRule(content, name || '导入的规则'); rule.id = uid('rule'); dm.saveRule(rule);
  return { kind: 'rule', id: rule.id, name: rule.name };
}

async function extractMemories(chatType: string, chatId: string): Promise<number> {
  const settings = dm.getSettings();
  if (!settings.enableAutoMemory) return 0;
  if (chatId.startsWith('obs:')) {
    const obs = getObserverConfig(chatType, chatId);
    if (!obs.privateWriteMemory) return 0;
  }
  if (chatType === 'group') {
    const obs = getObserverConfig('group', chatId);
    if (obs.observerMode && !obs.publicWriteMemory) return 0;
  }
  const hist0 = dm.getMessages(chatType, chatId);
  if (hist0.length > 0 && (hist0[hist0.length - 1] as any).from_proactive && !settings.idleWriteMemory) return 0;
  const history = hist0;
  if (history.length < 2) return 0;
  let roleId: string | undefined;
  if (chatType === 'single') {
    roleId = dm.resolveSingleRoleId(chatType, chatId);
  } else {
    const lastAi = [...history].reverse().find((m) => m.sender_type === 'ai');
    roleId = lastAi ? dm.getRoleByName(lastAi.sender_name)?.id : undefined;
  }
  if (!roleId) return 0;
  const existing = dm.listMemories(roleId).map((m) => m.content.trim());
  const convo = history.slice(-14).filter((m) => !(m.images && m.images.length) && !m.image_path)
    .map((m) => `${m.sender_name}: ${m.content || ''}`).join('\n');
  const cfg = settings.models.find((m) => m.id === settings.defaultModel && m.enabled) || settings.models.find((m) => m.enabled);
  if (!cfg) return 0;
  const prompt = `你是记忆提炼助手。从下面的对话中，提取关于用户或角色关系「值得长期记住」的事实（如用户偏好、禁忌、约定、重要事件、角色对用户的看法等）。\n已存在的记忆：\n${existing.length ? existing.join('\n') : '（无）'}\n\n最近对话：\n${convo}\n\n请只输出新增的、不与已有记忆重复、且确实值得长期记住的要点。每条一行，不要编号，不要解释。如果没有新要点，只输出一个空行。`;
  try {
    const res = await queryAI(cfg, [{ role: 'system', content: prompt }], 600);
    const lines = (res.content || '').split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => !existing.includes(l)).slice(0, 6);
    let n = 0;
    const lastMsgId = history.length > 0 ? history[history.length - 1].id : undefined;
    const lastUserMsg = [...history].reverse().find((m) => m.sender_type === 'user');
    const userMsgId = lastUserMsg ? lastUserMsg.id : undefined;
    const sourceMsgIds = [lastMsgId, userMsgId].filter((x): x is number => x !== undefined);
    for (const l of lines) { dm.addMemory({ roleId, content: l, source: 'auto', sourceMsgIds } as any); n += 1; }
    return n;
  } catch (e) {
    console.error('记忆提炼失败', e);
    return 0;
  }
}

// ===================== 图片 / 生图 / 自定义音效 =====================
async function saveGeneratedImage(b64: string): Promise<string | null> {
  try {
    const m = b64.match(/^data:(image\/\w+);base64,(.+)$/);
    const data = m ? m[2] : b64;
    const dataUrl = m ? b64 : `data:image/png;base64,${data}`;
    return await dm.saveImage(dataUrl);
  } catch (e) {
    console.error('保存生图失败', e);
    return null;
  }
}

// 把 dataURL（或已入库的 id）解析为用于 getImage 返回的显示 dataURL
function resolveImageForDisplay(p: string): string | null {
  if (!p) return null;
  if (p.startsWith('data:')) return p;
  return dm.getDataUrlSync(p);
}

// 浏览器端文件选择：返回选中的文件 dataURL 数组（替代桌面端 dialog 返回的文件路径）
function pickFilesViaInput(accept: string, multiple: boolean): Promise<{ name: string; dataUrl: string }[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (multiple) input.multiple = true;
    input.onchange = () => {
      const files = input.files;
      if (!files || files.length === 0) { resolve(null); return; }
      const out: { name: string; dataUrl: string }[] = [];
      let pending = files.length;
      Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          out.push({ name: file.name, dataUrl: reader.result as string });
          pending -= 1;
          if (pending === 0) resolve(out);
        };
        reader.onerror = () => { pending -= 1; if (pending === 0) resolve(out); };
        reader.readAsDataURL(file);
      });
    };
    input.click();
  });
}

// 浏览器端 PNG 角色卡 chara 块提取（替代桌面端 Buffer 实现）
function extractPngCharaChunk(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 12) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) break;
    if (type === 'tEXt') {
      let sep = -1;
      for (let i = dataStart; i < dataEnd; i++) if (bytes[i] === 0) { sep = i; break; }
      if (sep !== -1) {
        let key = '';
        for (let i = dataStart; i < sep; i++) key += String.fromCharCode(bytes[i]);
        if (key === 'chara') {
          let s = '';
          for (let i = sep + 1; i < dataEnd; i++) s += String.fromCharCode(bytes[i]);
          return s;
        }
      }
    }
    if (type === 'IEND') break;
    off = dataEnd + 4;
  }
  return null;
}

// ===================== 自动接话 / 群编辑 锁（Web 端单窗口，用固定 driverId） =====================
const FAKE_WINDOW_ID = 1;
const autoChatDrivers = new Map<string, number>();
const groupEditorLocks = new Map<string, number>();

// 空闲计时（Web 端单窗口，权威源即此处）
const idleState = new Map<string, number>();

// ===================== 备份（Web 端：JSON 导出 / 导入，无原生对话框） =====================
function serializeAll(): string {
  const store: any = (dm as any).store;
  const settings = dm.getSettings();
  return JSON.stringify({ version: 1, store, settings });
}

async function importAll(json: string): Promise<void> {
  const data = JSON.parse(json);
  if (!data || !data.store) throw new Error('备份文件格式不正确');
  // 直接覆盖内存 store 后落盘
  (dm as any).store = data.store;
  if (data.settings) dm.saveSettings(data.settings);
  (dm as any).schedulePersist?.();
}

// 触发浏览器下载（替代桌面端 saveDialog）
function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ===================== NianyuAPI 实现 =====================
function getEffectiveWorldBookId(chatType: string, chatId: string): string {
  const settings = dm.getSettings();
  const key = `${chatType}:${chatId}`;
  let wbId: string | undefined;
  if (settings.chatWorldBooks && settings.chatWorldBooks[key]) {
    const v = settings.chatWorldBooks[key];
    if (v === 'none') return 'none';
    wbId = v;
  } else if (chatType === 'single') {
    const r = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
    if (r && r.worldBookId) { if (r.worldBookId === 'none') return 'none'; wbId = r.worldBookId; }
  }
  if (!wbId) wbId = settings.defaultWorldBookId;
  return wbId || '';
}

// 桌面端所有 api 方法经 ipcRenderer.invoke 返回 Promise；Web 端为同进程同步实现。
// 此适配器把"数据/动作方法"的返回值包成 Promise，保证与 NianyuAPI 契约一致（前端统一 await）。
// 事件订阅方法（on*/off*）返回取消订阅函数或 void，前端直接调用取消函数，不能包成 Promise，故原样透传。
function promisifyWebApi(obj: Record<string, any>): NianyuAPI {
  const out: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'function' && !key.startsWith('on') && !key.startsWith('off')) {
      out[key] = (...args: any[]) => Promise.resolve(v(...args));
    } else {
      out[key] = v;
    }
  }
  return out as NianyuAPI;
}

export const webApi: NianyuAPI = promisifyWebApi({
  // ---------- 角色 ----------
  getRoles: () => dm.listRoles(),
  getRole: (id: string) => dm.getRole(id),
  saveRole: (role: Role) => dm.createRole(role),
  deleteRole: (id: string) => dm.deleteRole(id),
  aiCompleteRole: async (basic: Record<string, string>, modelId?: string) => {
    const settings = dm.getSettings();
    const cfg = settings.models.find((m) => m.id === modelId && m.enabled) || settings.models.find((m) => m.enabled);
    if (!cfg) return '（请先在设置-模型管理中添加并启用一个模型配置）';
    return aiCompleteRole(cfg, basic);
  },

  // ---------- 聊天 ----------
  getChatList: () => dm.getChatList(),
  getMessages: (type: string, id: string) => dm.getMessages(type, id),
  sendMessage: (p: any) => handleSend(p),
  sendUserMessage: (p: any) => handleSendUser(p),
  sendAIMessages: (p: any) => handleSendAI(p),
  startStream: (p: any) => handleStream(p),
  rateInfo: (modelId: string) => {
    const settings = dm.getSettings();
    const cfg = settings.models.find((m) => m.id === modelId);
    const qps = cfg?.qps;
    return { enabled: !!(qps && qps > 0), limit: qps || 0, waitMs: rateWaitMs(modelId) };
  },
  getChatModelId: (chatType: string, chatId: string) => {
    const settings = dm.getSettings();
    if (chatType === 'single') {
      const role = dm.getRole(dm.resolveSingleRoleId(chatType, chatId));
      if (role) return resolveRoleModel(role, settings)?.id || '';
      return '';
    }
    return settings.models.find((m) => m.id === settings.defaultModel && m.enabled)?.id || '';
  },
  translate: async (text: string) => {
    const settings = dm.getSettings();
    if (!settings.translationEnabled) return { ok: false, error: 'disabled' };
    try { const out = await translateText(String(text || ''), settings); return { ok: true, text: out }; }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  },
  interruptStream: (chatId: string) => { abortStreamsForChat(chatId); return { ok: true }; },
  groupContinue: (p: any) => handleGroupContinue(p),
  proactive: (p: any) => handleProactive(p),
  randomEvent: (p: any) => handleRandomEvent(p),
  chooseEvent: (p: any) => handleChooseEvent(p),

  // ---------- 观察者模式 ----------
  observerSetMode: (p: any) => setObserverMode(p),
  observerSetConfig: (p: any) => setObserverConfig(p),
  onGroupObserver: (cb: any) => on('group:observer', cb),
  offGroupObserver: (cb: any) => off('group:observer', cb),

  // ---------- 消息操作 ----------
  recallMessage: (msgId: number) => dm.deleteMessage(msgId),
  rollbackMessages: (p: any) => dm.rollbackMessages(p.chatType, p.chatId, p.fromMsgId),
  addQuickMemory: (p: any) => dm.addMemory({ roleId: p.roleId, content: p.content, source: 'manual' }),

  // ---------- 事件订阅 ----------
  onSettingsChanged: (cb: any) => on('settings:changed', cb),
  offSettingsChanged: (cb: any) => off('settings:changed', cb),
  onStreamChunk: (cb: any) => on('stream:chunk', cb),
  offStreamChunk: (cb: any) => off('stream:chunk', cb),
  onStreamStart: (cb: any) => on('stream:start', cb),
  offStreamStart: (cb: any) => off('stream:start', cb),
  onStreamDone: (cb: any) => on('stream:done', cb),
  offStreamDone: (cb: any) => off('stream:done', cb),
  onStreamUser: (cb: any) => on('stream:user', cb),
  offStreamUser: (cb: any) => off('stream:user', cb),
  onEventChosen: (cb: any) => on('event:chosen', cb),
  offEventChosen: (cb: any) => off('event:chosen', cb),
  sendIdleActivity: (chatKey: string) => emit('idle:activity', { chatKey, timestamp: Date.now() }),
  idleGet: (chatKey: string) => idleState.get(chatKey) ?? null,
  idleSet: (chatKey: string, ts: number) => { idleState.set(chatKey, ts); emit('idle:activity', { chatKey, timestamp: ts }); },
  onIdleActivity: (cb: any) => on('idle:activity', cb),
  offIdleActivity: (cb: any) => off('idle:activity', cb),
  onIdleTick: (cb: any) => on('idle:tick', cb),
  onRoleMood: (cb: any) => on('role:mood', cb),
  offRoleMood: (cb: any) => off('role:mood', cb),
  onRoleBond: (cb: any) => on('role:bond', cb),
  offRoleBond: (cb: any) => off('role:bond', cb),
  onMomentsChanged: (cb: any) => on('moments:changed', cb),
  offMomentsChanged: (cb: any) => off('moments:changed', cb),
  onMomentsAutoPosted: (cb: any) => on('moments:autoPosted', cb),
  offMomentsAutoPosted: (cb: any) => off('moments:autoPosted', cb),
  onStoryChanged: (cb: any) => on('story:changed', cb),
  offStoryChanged: (cb: any) => off('story:changed', cb),
  eventClosed: (p: any) => { if (p && p.chatId) activeEvents.delete(p.chatId); },
  deleteChat: (type: string, id: string) => { abortStreamsForChat(id); if (type === 'group') dm.deleteGroup(id); else dm.deleteChat(type, id); },
  copyChat: (type: string, id: string) => dm.copyChat(type, id),
  renameChat: (type: string, id: string, name: string) => dm.renameChat(type, id, name),
  resolveRoleId: (chatType: string, chatId: string) => dm.resolveSingleRoleId(chatType, chatId),
  setStoryEnabled: (chatType: string, chatId: string, enabled: boolean) => { dm.setStoryEnabled(chatType, chatId, enabled); broadcast('story:changed', { chatType, chatId, enabled }); },
  getStoryEnabled: (chatType: string, chatId: string) => dm.getStoryEnabled(chatType, chatId),
  addStoryNode: (chatType: string, chatId: string, msgId: number, title: string) => dm.addStoryNode(chatType, chatId, msgId, title),
  listStoryNodes: (chatType: string, chatId: string) => dm.listStoryNodes(chatType, chatId),
  removeStoryNode: (id: number) => dm.removeStoryNode(id),

  // ---------- 朋友圈 ----------
  addMoment: (roleId: string, content: string, images: string[], scheduledAt?: string | null, selfRoleId?: string) => dm.addMoment(roleId, content, images, scheduledAt, selfRoleId),
  listMoments: (roleId?: string, includeUnpublished?: boolean, selfRoleId?: string, favoritedOnly?: boolean) => dm.listMoments(roleId, includeUnpublished, selfRoleId, favoritedOnly),
  removeMoment: (id: number) => dm.removeMoment(id),
  updateMoment: (id: number, patch: Record<string, unknown>) => { dm.updateMoment(id, patch as any); broadcast('moments:changed', { id }); },
  publishDueMoments: () => dm.publishDueMoments(),
  triggerRelationship: async (chatType: string, chatId: string, roleId: string, withMoments = true, doRelationship = true) => {
    try { return await requestRelationshipAndMoments(chatType, chatId, roleId, { force: true, doMoments: withMoments, doRelationship }); }
    catch (err) { return { ok: false, moments: 0, error: String(err) }; }
  },
  adjustBond: (roleId: string, delta: number) => { const v = dm.adjustBond(roleId, delta); broadcast('role:bond', { roleId }); return v; },
  generateImage: async (chatType: string, chatId: string, prompt: string) => {
    const s = dm.getSettings();
    const ig = s.imageGen;
    if (!ig || !ig.enabled || !ig.baseUrl || !ig.apiKey) throw new Error('未配置生图 API，请在设置中开启「生图」并填写独立的 Base URL 与 API Key');
    const { b64, url } = await aiGenerateImage({ baseUrl: ig.baseUrl, apiKey: ig.apiKey }, prompt, ig.model || 'gpt-image-1', ig.size || '1024x1024');
    let imageId: string | null = null;
    if (b64) imageId = await saveGeneratedImage(b64);
    else if (url) {
      try { const resp = await fetch(url); const ab = await resp.arrayBuffer(); const dataUrl = `data:image/png;base64,${(await blobToBase64(ab))}`; imageId = await dm.saveImage(dataUrl); }
      catch (e) { console.error('下载生图失败', e); }
    }
    if (!imageId) throw new Error('生图失败：未获取到图片数据');
    const selfRole = resolveActiveSelfRole(s, chatType, chatId);
    const userMsg = dm.addMessage({ chat_type: chatType as any, chat_id: chatId, sender_type: 'user', sender_name: selfRole?.name || '我', content: prompt, image_path: null, images: null, token_used: 0, timestamp: new Date().toISOString() } as any);
    broadcast('stream:user', userMsg);
    const aiName = chatType === 'single' ? dm.getRole(dm.resolveSingleRoleId(chatType, chatId))?.name || 'AI' : dm.getGroup(chatId)?.group_name || 'AI';
    const aiMsg = dm.addMessage({ chat_type: chatType as any, chat_id: chatId, sender_type: 'ai', sender_name: aiName, content: '', image_path: imageId, token_used: 0, timestamp: new Date().toISOString() } as any);
    broadcast('stream:user', aiMsg);
    return { ok: true, imagePath: imageId };
  },
  saveImageMemory: (p: any) => { if (!p.roleId || !p.imagePath) return null; const name = (p.imagePath || '').split(/[\\/]/).pop() || '图片'; const content = p.note && p.note.trim() ? p.note.trim() : `生成/收到图片：${name}`; return dm.addMemory({ roleId: p.roleId, content, source: 'manual', image_path: p.imagePath } as any); },
  clearChatMessages: (chatType: string, chatId: string, withMemories: boolean) => dm.clearChatMessages(chatType, chatId, withMemories),

  // ---------- 自动接话 ----------
  syncAutoChat: (p: any) => broadcast('chat:autoChatSync', p),
  syncMessages: (p: any) => broadcast('chat:messagesSync', p),
  onAutoChatSync: (cb: any) => on('chat:autoChatSync', cb),
  onMessagesSync: (cb: any) => on('chat:messagesSync', cb),
  onStreamRoundDone: (cb: any) => on('stream:roundDone', cb),
  onClearFailed: (cb: any) => on('chat:clearFailed', cb),
  claimAutoChat: (chatId: string) => {
    const existing = autoChatDrivers.get(chatId);
    if (existing === undefined) { autoChatDrivers.set(chatId, FAKE_WINDOW_ID); abortStreamsForChat(chatId); broadcast('chat:autoChat:driver', { chatId, action: 'start', driverId: FAKE_WINDOW_ID }); broadcast('chat:clearFailed', { chatId }); return { isDriver: true, ownerId: FAKE_WINDOW_ID }; }
    if (existing === FAKE_WINDOW_ID) return { isDriver: true, ownerId: FAKE_WINDOW_ID };
    return { isDriver: false, ownerId: existing };
  },
  releaseAutoChat: (chatId: string) => { const owner = autoChatDrivers.get(chatId); if (owner === undefined) return { released: true }; if (owner !== FAKE_WINDOW_ID) return { released: false }; autoChatDrivers.delete(chatId); broadcast('chat:autoChat:driver', { chatId, action: 'stop', driverId: FAKE_WINDOW_ID }); return { released: true }; },
  forceStopAutoChat: (chatId: string) => { if (!autoChatDrivers.has(chatId)) return { ok: true }; autoChatDrivers.delete(chatId); abortStreamsForChat(chatId); broadcast('chat:autoChat:driver', { chatId, action: 'stop', reason: 'forced' }); broadcast('chat:clearFailed', { chatId }); return { ok: true }; },
  updateAutoChatRound: (chatId: string, round: number) => broadcast('chat:autoChat:driver', { chatId, action: 'round', round }),
  getAutoChatState: (chatId: string) => { const owner = autoChatDrivers.get(chatId); return { active: owner !== undefined, driverId: owner }; },
  onAutoChatDriver: (cb: any) => on('chat:autoChat:driver', cb),

  // ---------- 群编辑锁 ----------
  openGroupEditor: (groupId: string) => { const existing = groupEditorLocks.get(groupId); if (existing === undefined) { groupEditorLocks.set(groupId, FAKE_WINDOW_ID); broadcast('chat:groupEditor:state', { groupId, action: 'opened', ownerId: FAKE_WINDOW_ID }); return { ok: true, ownerId: FAKE_WINDOW_ID }; } if (existing === FAKE_WINDOW_ID) return { ok: true, ownerId: FAKE_WINDOW_ID }; return { ok: false, ownerId: existing }; },
  closeGroupEditor: (groupId: string) => { const owner = groupEditorLocks.get(groupId); if (owner !== undefined && owner !== FAKE_WINDOW_ID) return { ok: false }; groupEditorLocks.delete(groupId); broadcast('chat:groupEditor:state', { groupId, action: 'closed', ownerId: FAKE_WINDOW_ID }); return { ok: true }; },
  notifyGroupEditorSaved: (groupId: string) => broadcast('chat:groupEditor:state', { groupId, action: 'saved', ownerId: FAKE_WINDOW_ID }),
  onGroupEditorState: (cb: any) => on('chat:groupEditor:state', cb),

  // ---------- 群组 ----------
  getGroups: () => dm.listGroups(),
  getGroup: (id: string) => dm.getGroup(id),
  saveGroup: (g: Group) => dm.createGroup(g),
  deleteGroup: (id: string) => dm.deleteGroup(id),
  convertGroupToSingle: (groupId: string, roleId: string) => dm.convertGroupToSingle(groupId, roleId),
  setGroupIgnoreConvert: (groupId: string, value: boolean) => dm.setGroupIgnoreConvert(groupId, value),

  // ---------- 好感 / 统计 ----------
  getAffinityLog: (roleId?: string) => dm.getAffinityLog(roleId),
  getGlobalTokens: () => dm.getChatList().map((c) => dm.getMessages(c.chat_type, c.chat_id)).flat().reduce((s: number, m: any) => s + (m.token_used || 0), 0),
  getRoleStats: () => dm.getRoleStats(),

  // ---------- 设置 ----------
  getSettings: () => dm.getSettings(),
  saveSettings: (patch: Partial<AppSettings>) => { const next = dm.saveSettings(patch); broadcast('settings:changed', patch || {}); return next; },
  resetSettings: (keepKeys: boolean) => { const next = dm.resetSettings(keepKeys); broadcast('settings:changed', { reset: true }); return next; },
  deleteAllData: async () => { await dm.deleteAllData(); broadcast('settings:changed', { reset: true }); return true; },
  setMenuLang: (_lang: string) => { /* Web 端无应用菜单 */ },

  // ---------- 图片 / 文件 ----------
  pickImage: async () => { const files = await pickFilesViaInput('image/*', true); return files ? files.map((f) => f.dataUrl) : null; },
  getImage: (p: string) => Promise.resolve(resolveImageForDisplay(p)),
  saveImage: (dataUrl: string) => dm.saveImage(dataUrl),

  pickTextFile: async (filters?: any) => {
    const accept = filters && filters[0]?.extensions?.length ? `.${filters[0].extensions.join(',.')}` : '.json,.txt,.md,.yaml,.yml';
    const files = await pickFilesViaInput(accept, false);
    if (!files || !files.length) return null;
    return { path: '', content: atob(files[0].dataUrl.split(',')[1] || '') };
  },
  pickAudioFile: async () => null,
  setCustomSound: async () => null,
  saveTextFile: async (content: string, defaultName?: string) => { downloadText(defaultName || 'export.txt', content, 'text/plain'); return defaultName || 'export.txt'; },
  importCharacterCard: async () => {
    const files = await pickFilesViaInput('.json,.png,.txt,.card,.chara', false);
    if (!files || !files.length) return null;
    const file = files[0];
    try {
      if (file.dataUrl.startsWith('data:image/png') || file.name.toLowerCase().endsWith('.png')) {
        const ab = await (await fetch(file.dataUrl)).arrayBuffer();
        const jsonStr = extractPngCharaChunk(ab);
        if (!jsonStr) return { parsed: {}, error: 'not_character_png', fileName: file.name };
        let json: any; try { json = JSON.parse(jsonStr); } catch { try { json = JSON.parse(atob(jsonStr)); } catch { json = null; } }
        const parsed = parseCharacterCard(json);
        const avatarId = await dm.saveImage(file.dataUrl);
        return { parsed, avatarPath: avatarId, fileName: file.name, isPng: true };
      }
      const text = atob(file.dataUrl.split(',')[1] || '');
      const parsed = parseCharacterCardText(text);
      let raw: any = null; try { raw = JSON.parse(text); } catch { const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) { try { raw = JSON.parse(fence[1]); } catch { raw = null; } } }
      const d = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
      let avatarPath: string | undefined;
      if (d && typeof d.avatar === 'string' && d.avatar) avatarPath = (await dm.saveImage(d.avatar.startsWith('data:') ? d.avatar : `data:image/png;base64,${d.avatar}`)) ?? undefined;
      return { parsed, avatarPath, fileName: file.name, isPng: false };
    } catch (e) {
      console.error('导入角色卡失败', e);
      return { parsed: {}, error: 'read_failed', fileName: file.name };
    }
  },

  // ---------- 备份（Web 端无文件系统，改用浏览器下载 / 文件选择） ----------
  // 前端流程：pickBackupTarget() → createBackup(dest)；pickRestoreFile() → restoreBackup(zip)。
  // 这里把"路径"语义替换为：备份目标返回一个默认文件名，导入时由文件选择器读取内容后透传。
  pickBackupTarget: async () => 'nianyu-backup.json',
  createBackup: async (dest?: string) => { downloadText(dest && dest.trim() ? dest : 'nianyu-backup.json', serializeAll()); },
  pickRestoreFile: async () => {
    const files = await pickFilesViaInput('.json,.txt,.zip', false);
    if (!files || !files.length) return null;
    try { return atob(files[0].dataUrl.split(',')[1] || ''); } catch { return null; }
  },
  restoreBackup: async (content: string) => { await importAll(content); },
  pickBackupDir: async () => null,
  exportBackup: async () => { downloadText('nianyu-backup.json', serializeAll()); return 'nianyu-backup.json'; },

  // ---------- 模型 / 语音 ----------
  listModels: (cfg: ModelConfig) => listModels(cfg),
  testModel: (cfg: ModelConfig) => testConnection(cfg),
  transcribeAudio: (data: Uint8Array) => {
    const s = dm.getSettings(); const v = s.voice;
    if (!v?.asrBaseUrl || !v?.asrApiKey) throw new Error('未配置语音输入 API（请在设置中填写 ASR 专用 Base URL 与 API Key）');
    return transcribeAudio({ baseUrl: v.asrBaseUrl, apiKey: v.asrApiKey }, data, v.asrModel || 'whisper-1');
  },
  textToSpeech: async (text: string) => {
    const s = dm.getSettings(); const v = s.voice;
    if (!v?.ttsBaseUrl || !v?.ttsApiKey) throw new Error('未配置 TTS 专用 API，请在设置中填写独立的 Base URL 与 API Key');
    const buf = await textToSpeech({ baseUrl: v.ttsBaseUrl, apiKey: v.ttsApiKey }, text, v.ttsModel || 'tts-1', v.ttsVoice || 'alloy');
    const b64 = await blobToBase64(buf);
    return `data:audio/mpeg;base64,${b64}`;
  },

  // ---------- 迷你窗（Web 端单窗口，置为安全空实现） ----------
  miniOpen: async () => { /* 移动端无独立迷你窗 */ },
  miniGetInitial: async () => null,
  miniHide: async () => { /* noop */ },
  miniSetOnTop: async () => { /* noop */ },
  miniSetOpacity: async () => { /* noop */ },
  onMiniSwitch: (cb: any) => on('mini:switch', cb),
  offMiniSwitch: (cb: any) => off('mini:switch', cb),
  showMainWindow: async () => { /* noop */ },

  // ---------- 窗口控制（Web 端无操作系统窗口） ----------
  windowControl: (_action: string) => { /* noop */ },
  windowDragTo: (_x: number, _y: number) => { /* noop */ },
  onWindowStateChange: (cb: any) => on('window-state-change', cb),
  offWindowStateChange: (cb: any) => off('window-state-change', cb),
  onShowAbout: (cb: any) => on('app:showAbout', cb),
  offShowAbout: (cb: any) => off('app:showAbout', cb),

  // ---------- 世界书 ----------
  listWorldBooks: () => dm.listWorldBooks(),
  getWorldBook: (id: string) => dm.getWorldBook(id),
  saveWorldBook: (wb: WorldBook) => dm.saveWorldBook(wb),
  deleteWorldBook: (id: string) => dm.deleteWorldBook(id),
  copyWorldBook: (id: string) => dm.copyWorldBook(id) || null,
  importWorldBook: (content: string, name: string) => { const wb = parseWorldBook(content, name); wb.id = uid('wb'); dm.saveWorldBook(wb); return wb; },
  getEffectiveWorldBookId: (chatType: string, chatId: string) => getEffectiveWorldBookId(chatType, chatId),

  // ---------- 规则 ----------
  listRules: () => dm.listRules(),
  saveRule: (rule: Rule) => dm.saveRule(rule),
  deleteRule: (id: string) => dm.deleteRule(id),
  copyRule: (id: string) => dm.copyRule(id) || null,
  importRule: (content: string, name: string) => { const rule = parseRule(content, name); rule.id = uid('rule'); dm.saveRule(rule); return rule; },

  // ---------- 记忆 ----------
  listMemories: (roleId?: string) => dm.listMemories(roleId),
  addMemory: (m: any) => dm.addMemory(m),
  updateMemory: (id: string, content: string) => dm.updateMemory(id, content),
  deleteMemory: (id: string) => dm.deleteMemory(id),
  extractMemories: (chatType: string, chatId: string) => extractMemories(chatType, chatId),

  // ---------- 插件导入 ----------
  importPlugin: (content: string, name: string) => importPluginLogic(content, name),

  // ---------- 确认对话框 ----------
  showConfirm: async (message: string) => { try { return window.confirm(message); } catch { return false; } },

  // ---------- 后台消息提醒（Web 端无系统托盘通知，置安全空实现） ----------
  notifyCard: async () => { /* noop */ },
  onNotifyData: (cb: any) => on('notify:data', cb),
  notifyOpen: async () => { /* noop */ },
  notifyClose: async () => { /* noop */ },
  notifyIgnoreMouse: async () => { /* noop */ },
  onAppOpenChat: (cb: any) => on('app:openChat', cb),

  // ---------- 主进程错误推送 ----------
  onAppError: (cb: any) => on('app:error', cb),
  offAppError: (cb: any) => off('app:error', cb),
});

function blobToBase64(buf: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([buf]));
  });
}

// ===================== 初始化 =====================
let idleTickTimer: any = null;
export async function initNianyuWeb(): Promise<void> {
  await dm.whenReady();
  // 单窗口下，每秒广播一次空闲计时，供前端 onIdleTick 渲染倒计时
  if (!idleTickTimer && typeof window !== 'undefined') {
    idleTickTimer = setInterval(() => {
      const obj: Record<string, number> = {};
      idleState.forEach((v, k) => { obj[k] = v; });
      emit('idle:tick', obj);
    }, 1000);
  }
}

export async function exportBackupString(): Promise<string> {
  return serializeAll();
}
