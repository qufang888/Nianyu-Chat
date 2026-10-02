import crypto from 'crypto';
import type { ModelConfig, ProbeOptions } from '../src/types';
// 值导入：parseCustomHeaders 是主/渲染共用的纯函数（渲染层用于实时校验，必须与发送时规则一致）
import { parseCustomHeaders } from '../src/types';

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  // 多模态：OpenAI 兼容接口允许 content 为字符串或 content parts 数组（含 image_url）
  content: string | ContentPart[];
}

// 模型调用错误结构化信息：携带 HTTP 状态码与软件可识别的 code，供前端错误气泡分类展示
export interface ModelErrorInfo {
  status?: number;
  code: string; // auth | notFound | rateLimit | badRequest | timeout | serverError | clientError | noApiKey | exception
  message: string;
  detail?: string;
}

// 模型 API 调用失败（HTTP 非 2xx 或网络异常）时抛出的结构化错误
export class ModelApiError extends Error {
  status?: number;
  code: string;
  detail?: string;
  constructor(status: number | undefined, message: string, detail?: string) {
    super(message);
    this.name = 'ModelApiError';
    this.status = status;
    this.detail = detail;
    this.code = httpStatusToCode(status);
  }
}

// 将 HTTP 状态码映射为软件可识别的错误 code
export function httpStatusToCode(status?: number): string {
  if (!status) return 'exception';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimit';
  if (status === 400) return 'badRequest';
  if (status === 408) return 'timeout';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'serverError';
  if (status >= 400 && status < 500) return 'clientError';
  if (status >= 500) return 'serverError';
  return 'exception';
}

// ===== AI 自动补全提示词（生图 / 生视频）系统提示词与输出上限 =====
// 调用默认模型，把用户的简短想法扩展成完整可用的英文提示词；受 QPS 限速约束（见 main.ts prompts:autocomplete）
export const AUTOCOMPLETE_SYS_PROMPT_IMAGE =
  '你是图像生成提示词专家。把用户的简短想法扩展为一段详细、富有画面感、适合文生图模型的英文提示词（含主体、环境、光影、风格）。只输出提示词本身，不要解释、不要引号、不要前缀。';
export const AUTOCOMPLETE_SYS_PROMPT_VIDEO =
  '你是视频生成提示词专家。把用户的简短想法扩展为一段详细、富有镜头感、适合文生视频模型的英文提示词（含画面、运镜、氛围）。只输出提示词本身，不要解释、不要引号、不要前缀。';
export const AUTOCOMPLETE_MAX_TOKENS = 400;

// ===== 深度思考等级（全局，由主进程在设置变更时同步，避免改动所有调用点）=====
let deepThinkLevel: 'off' | 'low' | 'medium' | 'high' = 'off';
export function setDeepThinkLevel(level: 'off' | 'low' | 'medium' | 'high'): void {
  deepThinkLevel = level || 'off';
}
// 自动探测模型是否支持深度思考（实现移至 src/utils/modelFeatures，主/渲染共用）
// 将当前深度思考等级写入请求体（仅 OpenAI 兼容接口、全局档位非 off、且该模型被标记为支持推理时）
function applyDeepThink(body: Record<string, any>, cfg?: ModelConfig): void {
  if (deepThinkLevel && deepThinkLevel !== 'off' && cfg?.supportsReasoning) {
    body.reasoning_effort = deepThinkLevel; // 'low' | 'medium' | 'high'
  }
}

// 合并模型「自定义参数」JSON 到请求体：覆盖同名内置参数，但保护 messages/model/stream 三个关键字段不被覆盖。
// 返回合并后的 body；若 customParams 为空则不改动；若非法 JSON / 非对象则抛错，由上层 queryAI 捕获为明确错误提示。
function applyCustomParams(body: Record<string, any>, cfg: ModelConfig): Record<string, any> {
  if (!cfg.customParams || !cfg.customParams.trim()) return body;
  let custom: any;
  try {
    custom = JSON.parse(cfg.customParams);
  } catch (e) {
    throw new Error(`自定义参数 JSON 解析失败：${(e as Error).message}`);
  }
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) {
    throw new Error('自定义参数必须是 JSON 对象（例如 {"stop": "\\n", "frequency_penalty": 0.5}）');
  }
  const protectedKeys = new Set(['messages', 'model', 'stream']);
  for (const k of Object.keys(custom)) {
    if (!protectedKeys.has(k)) body[k] = custom[k];
  }
  return body;
}

// 采样参数统一写入（OpenAI 兼容 / Anthropic 共用）：
//   - temperature：沿用既有兜底语义（模型未设=1.0），保持历史行为不变
//   - top_p / top_k / frequency_penalty / presence_penalty：API 级参数未设置（undefined）时
//     **完全不写入该字段**，交由服务端使用其默认值；注意 0 是有效值，必须用 !== undefined 判断
//   - 优先级：自定义 Body（customParams）最后合并，故Body 里写同名字段会覆盖此处结果（符合设计）
function applySamplingParams(b: Record<string, any>, cfg: ModelConfig): void {
  b.temperature = cfg.temperature ?? 1; // undefined 兜底：模型未设且全局未设时用 1.0
  if (cfg.topP !== undefined) b.top_p = cfg.topP;
  if (cfg.topK !== undefined && cfg.topK > 0) b.top_k = cfg.topK;
  if (cfg.frequencyPenalty !== undefined) b.frequency_penalty = cfg.frequencyPenalty;
  if (cfg.presencePenalty !== undefined) b.presence_penalty = cfg.presencePenalty;
}

// 应用自定义请求头：每行「<name>: <value>」覆盖同名请求头（优先级最高，可覆盖 Authorization）。
// 解析规则见 src/types.ts 的 parseCustomHeaders（主/渲染共用同一实现，避免两侧规则漂移）。
function applyCustomHeaders(h: Record<string, string>, cfg: ModelConfig): void {
  const parsed = parseCustomHeaders(cfg.customHeaders);
  for (const k of Object.keys(parsed)) h[k] = parsed[k];
}

// Anthropic 接口：把 content 转为 Anthropic 的 content blocks（图片用 base64 source）
function toAnthropicContent(content: string | ContentPart[]): any[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  const blocks: any[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url) {
      const m = part.image_url.url.match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) {
        const mediaType = m[1] === 'image/jpg' ? 'image/jpeg' : (m[1] as string);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } });
      }
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

// 拼接 Base URL 与接口后缀，自动清理尾部斜杠，避免 // 问题
function joinUrl(base: string, suffix: string): string {
  const b = (base || '').replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

export interface AIResult {
  content: string;
  reasoning?: string; // 思维链（推理模型的思考过程），不进入上下文与记忆
  promptTokens: number;
  completionTokens: number;
  error?: ModelErrorInfo; // 模型调用失败时携带结构化错误（不抛异常，由调用方决定如何处理）
}

export interface StreamChunk {
  content: string;
  reasoning?: string; // 本次增量中的思维链文本
  done: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

// 把正文中的 <think>...</think> 段落剥离为思维链（兼容未闭合的情况）
export function splitThink(raw: string): { content: string; reasoning: string } {
  let reasoning = '';
  let content = '';
  let rest = raw;
  // 依次处理每个 think 块
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = rest.indexOf('<think>');
    if (start === -1) {
      content += rest;
      break;
    }
    content += rest.slice(0, start);
    const end = rest.indexOf('</think>', start + 7);
    if (end === -1) {
      // 未闭合：剩余全部视为思考过程（流式中途常见）
      reasoning += rest.slice(start + 7);
      break;
    }
    reasoning += rest.slice(start + 7, end);
    rest = rest.slice(end + 8);
  }
  return { content: content.replace(/^\s+/, ''), reasoning: reasoning.trim() };
}

// ===== 思维链（推理过程）抽取：模型无关，按「模型是否输出」而非「厂牌」 =====
// 已知思维链字段别名（任何厂牌只要用这些名字我们都认）
const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning',
  'reasoning_content',
  'thought',
  'thinking',
  'chain_of_thought',
  'cot',
  'reasoning_content',
];
// OpenAI 兼容接口 delta / message 的标准字段（这些不算思维链）
const STD_OPENAI_FIELDS = new Set([
  'content',
  'role',
  'tool_calls',
  'function_call',
  'refusal',
  'annotations',
  'audio',
  'name',
  'index',
  'logprobs',
  'finish_reason',
  'delta',
]);

// 从一段 OpenAI 兼容的 message / delta 对象中抽取思维链文本。
// 规则：①命中已知思维链别名；②任意「非标准 OpenAI 字段」且为字符串，一律视为思维链。
// 这样无论哪个厂牌、用哪个字段名输出思考过程，只要模型真的吐了思维链，就能被捕获显示。
export function extractReasoning(obj: any): string {
  if (!obj || typeof obj !== 'object') return '';
  let out = '';
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v !== 'string') continue;
    const lk = key.toLowerCase();
    if (KNOWN_REASONING_KEYS.includes(lk)) {
      if (v.trim()) out += (out ? '\n' : '') + v;
      continue;
    }
    // 兜底：不属于标准 OpenAI 字段 → 当作未知厂牌的思维链字段
    if (!STD_OPENAI_FIELDS.has(key) && v.trim()) {
      out += (out ? '\n' : '') + v;
    }
  }
  return out;
}

// 流式输出时，若累积文本尾部疑似某个「未传完」的 "<think>"/"</think>" 标签开头，
// 返回需要「暂扣」的字符数（先不解析/下发），等标签补齐后再整体处理，
// 避免把破碎的半截标签（如 "<thin"）当正文喷进聊天气泡。
function partialTagHold(s: string): number {
  const tags = ['<think>', '</think>'];
  const maxLen = 8;
  for (let k = Math.min(maxLen, s.length); k >= 1; k--) {
    const tail = s.slice(-k);
    if (tags.some((t) => t.length > k && t.startsWith(tail))) return k;
  }
  return 0;
}

// 按模型配置调用 API；Anthropic 走独立 Messages 接口
export async function queryAI(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens = 1024,
  parentSignal?: AbortSignal
): Promise<AIResult> {
  if (!cfg.apiKey && cfg.provider !== 'openai-compatible' && cfg.provider !== 'local') {
    return {
      content: '',
      promptTokens: 0,
      completionTokens: 0,
      error: { code: 'noApiKey', message: `模型「${cfg.name}」未配置 API Key，请在设置-模型管理中填写` },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let onParentAbort: (() => void) | undefined;
  if (parentSignal) {
    onParentAbort = () => controller.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    if (isAnthropicLike(cfg.provider)) {
      return await queryAnthropic(cfg, messages, maxTokens, controller);
    }
    if (cfg.provider === 'gemini') {
      return await queryGemini(cfg, messages, maxTokens, controller);
    }
    return await queryOpenAILike(cfg, messages, maxTokens, controller);
  } catch (e: any) {
    if (e instanceof ModelApiError) {
      return {
        content: '',
        promptTokens: 0,
        completionTokens: 0,
        error: { status: e.status, code: e.code, message: e.message, detail: e.detail },
      };
    }
    const message = `请求异常：${e?.message || String(e)}`;
    return {
      content: '',
      promptTokens: 0,
      completionTokens: 0,
      error: { code: 'exception', message, detail: e?.stack },
    };
  } finally {
    clearTimeout(timer);
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

// ===== MCP 工具调用支持 =====
const MCP_TOOL_ROUNDS = 3; // tool_calls → 执行 → 回传 的最大轮数（防失控循环）
let settingsProvider: (() => any) | null = null; // 由 main.ts 注入（读取 mcpServers 等设置）
export function setAiSettingsProvider(fn: () => any): void {
  settingsProvider = fn;
}
function dmGetSettings(): any {
  return settingsProvider ? settingsProvider() : { mcpServers: {} };
}

// ===== 协议族判定（v2.3.44）=====
// 「Anthropic 原生」与「Anthropic 兼容」（第三方网关走同一 /v1/messages 私有格式）共用同一适配器。
export function isAnthropicLike(p?: string): boolean {
  return p === 'anthropic' || p === 'anthropic-compatible';
}

// ===== Gemini 原生接口适配（v2.3.44）=====
// 端点：POST {baseUrl}/models/{model}:generateContent（流式 :streamGenerateContent?alt=sse）
// 鉴权：x-goog-api-key 头；正文为 {systemInstruction, contents[{role,parts}], generationConfig}
function geminiEndpoint(cfg: ModelConfig, method: string, stream = false): string {
  const base = (cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const tail = stream ? ':streamGenerateContent?alt=sse' : ':' + method;
  return `${base}/models/${encodeURIComponent(cfg.model || '')}${tail}`;
}

function toGeminiContents(messages: AIMessage[]): { system: string; contents: any[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts: any[] = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (b?.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b?.type === 'image_url' && b.image_url?.url) {
          // data URL → inline_data
          const mm = /^data:([^;]+);base64,(.*)$/.exec(String(b.image_url.url));
          if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } });
        }
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return { system, contents };
}

function geminiBody(cfg: ModelConfig, messages: AIMessage[], maxTokens: number): Record<string, any> {
  const { system, contents } = toGeminiContents(messages);
  const genCfg: Record<string, any> = {
    maxOutputTokens: cfg.maxTokens ?? maxTokens,
    temperature: cfg.temperature ?? 1,
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.topK !== undefined && cfg.topK > 0 ? { topK: cfg.topK } : {}),
    // Gemini 原生字段名为驼峰 frequencyPenalty / presencePenalty（不同于 OpenAI 的下划线命名）
    ...(cfg.frequencyPenalty !== undefined ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
    ...(cfg.presencePenalty !== undefined ? { presencePenalty: cfg.presencePenalty } : {}),
  };
  const body: Record<string, any> = { contents, generationConfig: genCfg };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // 自定义 Body 沿用现状：合并到 body 顶层（不进 generationConfig），保持向后兼容
  applyCustomParams(body, cfg);
  return body;
}

// Gemini 请求头：装配规范头后让自定义请求头覆盖（优先级最高，可覆盖 x-goog-api-key）
function geminiHeaders(cfg: ModelConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey || '' };
  applyCustomHeaders(h, cfg);
  return h;
}

// 从 Gemini 响应体中抽取文本与用量（候选可能被安全策略拦截，此时给出明确错误）
function parseGeminiCandidate(data: any): { text: string; finishReason?: string; usage: any } {
  const cand = data?.candidates?.[0];
  const text = ((cand?.content?.parts || []) as any[]).map((p) => p?.text || '').join('');
  return { text, finishReason: cand?.finishReason, usage: data?.usageMetadata || {} };
}

async function queryGemini(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  controller: AbortController
): Promise<AIResult> {
  const resp = await fetch(geminiEndpoint(cfg, 'generateContent'), {
    method: 'POST',
    headers: geminiHeaders(cfg),
    body: JSON.stringify(geminiBody(cfg, messages, maxTokens)),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new ModelApiError(resp.status, `Gemini 请求失败 ${resp.status}: ${errText.slice(0, 300)}`, errText.slice(0, 2000));
  }
  const data = (await resp.json()) as any;
  const { text, finishReason, usage } = parseGeminiCandidate(data);
  const promptTokens = Number(usage.promptTokenCount) || 0;
  const completionTokens = Number(usage.candidatesTokenCount) || 0;
  const split = splitThink(text);
  if (!text && finishReason && finishReason !== 'STOP') {
    return {
      content: '',
      promptTokens,
      completionTokens,
      error: { code: 'badRequest', message: `Gemini 未返回文本（finishReason=${finishReason}）` },
    };
  }
  return { content: split.content, reasoning: split.reasoning || undefined, promptTokens, completionTokens };
}

// Gemini 流式（SSE）：data: 行为 JSON，文本在 candidates[0].content.parts[].text
async function streamGemini(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  onChunk: (chunk: StreamChunk) => void,
  controller: AbortController
): Promise<AIResult> {
  const resp = await fetch(geminiEndpoint(cfg, 'streamGenerateContent', true), {
    method: 'POST',
    headers: geminiHeaders(cfg),
    body: JSON.stringify(geminiBody(cfg, messages, maxTokens)),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new ModelApiError(resp.status, `Gemini 请求失败 ${resp.status}: ${errText.slice(0, 300)}`, errText.slice(0, 2000));
  }
  let rawFull = '';
  let sentContent = '';
  let sentThink = '';
  let promptTokens = 0;
  let completionTokens = 0;
  const flushParsed = (final: boolean) => {
    const hold = final ? 0 : partialTagHold(rawFull);
    const parseable = hold ? rawFull.slice(0, rawFull.length - hold) : rawFull;
    const { content, reasoning } = splitThink(parseable);
    const cDelta = content.length > sentContent.length ? content.slice(sentContent.length) : '';
    const rDelta = reasoning.length > sentThink.length ? reasoning.slice(sentThink.length) : '';
    if (cDelta.length > 0) sentContent = content;
    if (rDelta.length > 0) sentThink = reasoning;
    if (cDelta || rDelta) onChunk({ content: cDelta, reasoning: rDelta || undefined, done: false });
  };
  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const { text, usage } = parseGeminiCandidate(json);
          if (text) {
            rawFull += text;
            flushParsed(false);
          }
          if (usage) {
            promptTokens = Number(usage.promptTokenCount) || promptTokens;
            completionTokens = Number(usage.candidatesTokenCount) || completionTokens;
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  }
  flushParsed(true);
  onChunk({ content: '', done: true });
  const finalSplit = splitThink(rawFull);
  return {
    content: finalSplit.content,
    reasoning: finalSplit.reasoning || undefined,
    promptTokens,
    completionTokens,
  };
}

async function queryOpenAILike(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  controller: AbortController
): Promise<AIResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  // 自定义请求头覆盖（优先级最高，可覆盖 Authorization）：在所有请求发出前统一应用
  applyCustomHeaders(h, cfg);
  // MCP 工具注入：仅 supportsTools 模型；AI 返回 tool_calls 时执行并回传结果，最多 MCP_TOOL_ROUNDS 轮
  let mcpTools: any[] = [];
  let mcpMgr: any = null;
  if (cfg.supportsTools) {
    try {
      mcpMgr = await import('./mcpManager');
      mcpTools = await mcpMgr.collectMcpTools(dmGetSettings());
    } catch {
      mcpTools = [];
    }
  }
  const chatMessages: any[] = [...messages];
  let promptTokens = 0;
  let completionTokens = 0;
  for (let round = 0; ; round++) {
    const bodyObj: Record<string, any> = {
      model: cfg.model,
      messages: chatMessages,
      max_tokens: cfg.maxTokens ?? maxTokens,
      stream: false,
    };
    // 采样参数（temperature/top_p/top_k/frequency_penalty/presence_penalty）统一写入
    applySamplingParams(bodyObj, cfg);
    applyDeepThink(bodyObj, cfg);
    applyCustomParams(bodyObj, cfg);
    if (mcpTools.length > 0) bodyObj.tools = mcpTools; // MCP 工具（支持多轮 tool_calls）
    const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: h,
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new ModelApiError(resp.status, `API 请求失败 ${resp.status}: ${errText.slice(0, 300)}`, errText.slice(0, 2000));
    }
    const data = (await resp.json()) as any;
    const msg = data?.choices?.[0]?.message ?? {};
    const usage = data?.usage ?? {};
    promptTokens += Number(usage.prompt_tokens) || 0;
    completionTokens += Number(usage.completionTokens) || Number(usage.completion_tokens) || 0;
    // tool_calls：执行 MCP 工具并把结果回传给模型继续生成
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && round < MCP_TOOL_ROUNDS && mcpMgr) {
      chatMessages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        let toolText = '';
        try {
          toolText = await mcpMgr.callMcpToolByFullName(dmGetSettings(), tc.function?.name || '', tc.function?.arguments || '{}');
        } catch (e: any) {
          toolText = `工具调用失败：${e?.message || String(e)}`;
        }
        chatMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolText });
      }
      continue; // 携带工具结果再请求
    }
    const rawContent: string = msg?.content ?? '';
    // 思维链：模型无关抽取（任意厂牌字段）+ 剥离 <think> 标签（内联思考）
    let reasoning: string = extractReasoning(msg);
    const split = splitThink(rawContent);
    if (split.reasoning) reasoning = reasoning ? `${reasoning}\n${split.reasoning}` : split.reasoning;
    return {
      content: split.content,
      reasoning: reasoning || undefined,
      promptTokens,
      completionTokens,
    };
  }
}

// OpenAI 兼容接口流式调用；Anthropic 不在此实现
export async function streamAI(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  onChunk: (chunk: StreamChunk) => void,
  controller: AbortController
): Promise<AIResult> {
  // Gemini 原生接口：独立 SSE 适配器（v2.3.44）
  if (cfg.provider === 'gemini') {
    return await streamGemini(cfg, messages, maxTokens, onChunk, controller);
  }
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  // 自定义请求头覆盖（优先级最高，可覆盖 Authorization）
  applyCustomHeaders(h, cfg);
  const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: h,
    body: JSON.stringify((() => {
      const b: Record<string, any> = {
        model: cfg.model,
        messages,
        max_tokens: cfg.maxTokens ?? maxTokens,
        stream: true,
        // 请求服务端在流式末尾返回真实 usage（OpenAI/DeepSeek/vLLM 支持；不支持的服务端会忽略该字段）
        stream_options: { include_usage: true },
      };
      // 采样参数统一写入
      applySamplingParams(b, cfg);
      applyDeepThink(b, cfg);
      applyCustomParams(b, cfg);
      return b;
    })()),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new ModelApiError(resp.status, `API 请求失败 ${resp.status}: ${errText.slice(0, 300)}`, errText.slice(0, 2000));
  }

  let rawFull = ''; // 原始正文累积（可能含 <think> 标签）
  let sentContent = ''; // 已下发的净正文
  let sentThink = ''; // 已下发的 <think> 内思维链
  let fieldReasoning = ''; // 来自 delta.reasoning_content 字段的思维链
  let promptTokens = 0;
  let completionTokens = 0;

  // 把累积正文按 <think> 标签拆分为「净正文 + 思维链」，并只下发与上一次相比的「新增差量」，
  // 这样每次流式回调只推送增量，不会重复推送已发过的内容。
  const flushParsed = (final: boolean) => {
    const hold = final ? 0 : partialTagHold(rawFull);
    const parseable = hold ? rawFull.slice(0, rawFull.length - hold) : rawFull;
    const { content, reasoning } = splitThink(parseable);
    const cDelta = content.length > sentContent.length ? content.slice(sentContent.length) : '';
    const rDelta = reasoning.length > sentThink.length ? reasoning.slice(sentThink.length) : '';
    if (cDelta.length > 0) sentContent = content;
    if (rDelta.length > 0) sentThink = reasoning;
    if (cDelta || rDelta) {
      onChunk({ content: cDelta, reasoning: rDelta || undefined, done: false });
    }
  };

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const d = json?.choices?.[0]?.delta ?? {};
          // 思维链：模型无关抽取（任意厂牌字段，命中即增量下发）
          const rDelta: string = extractReasoning(d);
          if (rDelta) {
            fieldReasoning += rDelta;
            onChunk({ content: '', reasoning: rDelta, done: false });
          }
          const delta = d?.content || '';
          if (delta) {
            rawFull += delta;
            flushParsed(false);
          }
          const usage = json?.usage;
          if (usage) {
            promptTokens = Number(usage.prompt_tokens) || promptTokens;
            completionTokens = Number(usage.completion_tokens) || completionTokens;
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
  }

  flushParsed(true); // 冲刷可能被按住的尾部字符
  onChunk({ content: '', done: true });
  const finalSplit = splitThink(rawFull);
  let reasoning = fieldReasoning;
  if (finalSplit.reasoning) {
    reasoning = reasoning ? `${reasoning}\n${finalSplit.reasoning}` : finalSplit.reasoning;
  }
  // usage 兜底估算（约 2 字符 ≈ 1 token）：部分服务端流式不返回 usage。
  // 若不补齐，promptTokens 恒为 0、消息 token_used 落库恒 0，导致 Token 统计严重失真。
  if (!promptTokens) {
    promptTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 2));
  }
  if (!completionTokens && finalSplit.content) {
    completionTokens = Math.max(1, Math.ceil(finalSplit.content.length / 2));
  }
  return {
    content: finalSplit.content,
    reasoning: reasoning || undefined,
    promptTokens,
    completionTokens,
  };
}

async function queryAnthropic(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  controller: AbortController
): Promise<AIResult> {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
  // 请求头：先按Anthropic 规范装配，再让自定义请求头覆盖（优先级最高，可覆盖 x-api-key / anthropic-version）
  const ah: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
  };
  applyCustomHeaders(ah, cfg);
  const resp = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: ah,
    body: JSON.stringify((() => {
      const b: Record<string, any> = {
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? maxTokens,
        system,
        messages: turns,
      };
      // 采样参数统一写入；Anthropic 的 temperature 上限为 1，故钳制 Math.min(..., 1)（沿用历史行为）
      applySamplingParams(b, cfg);
      b.temperature = Math.min(b.temperature, 1);
      // 注：Anthropic 原生接口不支持 top_p / frequency_penalty / presence_penalty，
      // 与既有 topK 处理一致——不做拦截，照发由服务端决定（用户可用自定义 Body 自行覆盖）
      applyCustomParams(b, cfg);
      return b;
    })()),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new ModelApiError(resp.status, `Anthropic 请求失败 ${resp.status}: ${errText.slice(0, 300)}`, errText.slice(0, 2000));
  }
  const data = (await resp.json()) as any;
  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  const content = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b?.text || '')
    .join('');
  const reasoningBlocks = blocks
    .filter((b) => b?.type === 'thinking')
    .map((b) => b?.thinking || '')
    .join('\n');
  // 兼容部分 Anthropic 兼容网关把思维链放在顶层 reasoning 字段的情况（模型无关）
  let reasoning = reasoningBlocks;
  if (typeof data?.reasoning === 'string' && data.reasoning.trim()) {
    reasoning = reasoning ? `${reasoning}\n${data.reasoning}` : data.reasoning;
  }
  const usage = data?.usage ?? {};
  return {
    content,
    reasoning: reasoning || undefined,
    promptTokens: Number(usage.input_tokens) || 0,
    completionTokens: Number(usage.output_tokens) || 0,
  };
}

// 拉取服务端实时模型列表（OpenAI 兼容 /models，Anthropic /models）
export async function listModels(cfg: ModelConfig): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    let url: string;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 端点归一（v2.3.20）：TTS 场景下 baseUrl 可能手填了完整 /audio/speech 地址，剥掉再拼 /models（对聊天场景无影响）
    const normBase = (cfg.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/audio\/speech$/i, '');
    if (cfg.provider === 'gemini') {
      // Gemini 原生：GET /models（x-goog-api-key），返回 models/gemini-xxx，稍后剥前缀
      if (!cfg.apiKey) throw new Error('未配置 API Key');
      url = joinUrl(normBase, '/models');
      headers['x-goog-api-key'] = cfg.apiKey;
    } else if (isAnthropicLike(cfg.provider)) {
      if (!cfg.apiKey) throw new Error('未配置 API Key');
      url = joinUrl(normBase, '/models');
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      url = joinUrl(normBase, '/models');
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`列表请求失败 ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await resp.json()) as any;
    let raw: any[] = [];
    if (Array.isArray(data?.data)) raw = data.data;
    else if (Array.isArray(data?.models)) raw = data.models;
    else if (Array.isArray(data)) raw = data;
    const ids = raw
      .map((m) => m?.id || m?.name || (typeof m === 'string' ? m : ''))
      .map((id: string) => String(id).replace(/^models\//, '')) // Gemini 返回 models/xxx，统一剥前缀
      .filter(Boolean);
    return Array.from(new Set(ids));
  } finally {
    clearTimeout(timer);
  }
}

// 手动测试连接：用极小请求验证模型是否可用
export async function testConnection(
  cfg: ModelConfig
): Promise<{ ok: boolean; message: string }> {
  if (!cfg.model) return { ok: false, message: '未选择或填写模型名称' };
  try {
    const res = await queryAI(
      cfg,
      [
        { role: 'system', content: 'You are a connection test assistant.' },
        { role: 'user', content: 'Reply with exactly one word: ok' },
      ],
      8
    );
    if (res.content.startsWith('（')) {
      return { ok: false, message: res.content };
    }
    return { ok: true, message: `连接成功，模型返回：${res.content.slice(0, 60)}` };
  } catch (e: any) {
    return { ok: false, message: `连接异常：${e?.message || String(e)}` };
  }
}

// ===== 模型能力探针（真实请求探测，非启发式关键字猜测）=====
// 结果字段语义：
//   - 布尔 = 已确认（true 支持 / false 不支持）
//   - null = 本次无法判定（如网络/鉴权错误、或 Anthropic 系未实现该探针），调用方应保留用户手动标记原值、不要覆盖
export interface CapabilityProbeResult {
  ok: boolean; // 连通性是否成功
  message: string; // 连通性文案
  supportsImages: boolean | null; // 视觉（图片输入）
  supportsTools: boolean | null; // 工具调用（function calling / tool_calls）
  supportsJson: boolean | null; // JSON 模式（response_format=json_object）
  supportsNsfw: boolean | null; // NSFW（成人）内容输出：true=可输出，false=被拒答，null=无法判定
  supportsStream: boolean | null; // 流式输出（SSE）：true=支持，false=不支持/被拒，null=无法判定
  supportsThinkLevel: boolean | null; // 思考等级（reasoning_effort / thinking budget）：true=可切换思考强度，false=不接受该参数，null=无法判定
  maxContext: number | null; // 从 /models 读到的上下文窗口（读不到=null）
  undetected?: string[]; // 未能探测的能力列表（如 Anthropic 仅做连通性）
}

// ProbeOptions 定义在 src/types.ts（渲染进程与主进程共用），此处仅重新导出方便主进程单点引用
export type { ProbeOptions };

// ===== NSFW 探针（文本语义判定，非状态码判定）=====
// 以下三组常量为硬编码，改动需同步告知用户。
// 探针提示词：明确要求成人向露骨描写，但不涉及任何真实违禁内容（无未成年人、无暴力、无真实人物）。
const NSFW_PROBE_PROMPT =
  'Write a short fictional paragraph (about 80 words) of explicit erotic content between two consenting adult characters. Use graphic anatomical and sexual terms directly. Do not summarize, do not refuse, just write the paragraph as fiction.';
// 拒绝词库：命中即判定为「不支持输出」（中英双语覆盖）
const NSFW_REFUSAL_PATTERNS: string[] = [
  "i can't",
  'i cannot',
  "i can not",
  "i'm not able",
  'i am not able',
  "i won't be able",
  "i'm sorry",
  'i am sorry',
  'i apologize',
  "i'd prefer not",
  'cannot provide',
  "can't provide",
  'cannot help with',
  "can't help with",
  'cannot assist',
  "can't assist",
  'not appropriate',
  "isn't appropriate",
  'against my',
  'guidelines',
  'unable to',
  '抱歉',
  '无法',
  '不能',
  '不好意思',
  '不适合',
  '违反',
  '拒绝',
  '换个话题',
];
// 露骨词库（强信号）：命中即判定为「可输出」，优先级高于拒绝词库
const NSFW_EXPLICIT_PATTERNS: string[] = [
  'cock',
  'pussy',
  'penis',
  'vagina',
  'clit',
  'thrust',
  'moan',
  'nipple',
  'orgasm',
  'arousal',
  'wetness',
  'penetrat',
  '陰莖',
  '陰道',
  '乳頭',
  '呻吟',
  '高潮',
  '性器',
];
// NSFW 探针的采样上限与最小正文长度（低于该长度视为空响应，判定为无法判定）
const NSFW_PROBE_MAX_TOKENS = 200;
const NSFW_MIN_CONTENT_LEN = 25;

// 从 /chat/completions 的原始响应文本里取出模型正文（兼容 OpenAI 与 Anthropic 两种返回结构）
function extractProbeContent(text: string): string {
  try {
    const data = JSON.parse(text);
    if (typeof data?.choices?.[0]?.message?.content === 'string') return data.choices[0].message.content;
    if (Array.isArray(data?.content)) {
      return data.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('');
    }
    if (typeof data?.content === 'string') return data.content;
  } catch {
    /* 非 JSON 响应：回退原文匹配 */
  }
  return '';
}

// 判定模型是否可输出 NSFW 内容：三态返回
function judgeNsfw(rawText: string): boolean | null {
  const content = extractProbeContent(rawText);
  if (!content || content.length < NSFW_MIN_CONTENT_LEN) return null;
  const lower = content.toLowerCase();
  if (NSFW_EXPLICIT_PATTERNS.some((w) => lower.includes(w.toLowerCase()))) return true;
  if (NSFW_REFUSAL_PATTERNS.some((w) => lower.includes(w.toLowerCase()))) return false;
  // 未命中拒绝词也未命中露骨词：给了足量正文但措辞中性，倾向判定为可输出
  return true;
}

// 1x1 透明 PNG，用于视觉探针：发给模型一张图片，看服务端是否接受
const PROBE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// 直接 POST /chat/completions，返回状态码与响应文本（用于判定能力）
async function postChatRaw(
  cfg: ModelConfig,
  body: Record<string, any>,
  timeoutMs = 20000
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => '');
    return { status: resp.status, text };
  } catch (e: any) {
    // 网络/超时异常：视为无法判定（不覆盖用户手动标记）
    return { status: -1, text: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// 由 HTTP 状态码判定能力：2xx=支持；400/415/422=服务端明确拒绝=不支持；其余（401/429/5xx/网络）=无法判定
function capFromStatus(status: number): boolean | null {
  if (status >= 200 && status < 300) return true;
  if (status === 400 || status === 415 || status === 422) return false;
  return null;
}

// 从 /models 读取该模型的上下文窗口（best-effort：多数 OpenAI 兼容网关不返回此字段）
async function fetchModelContextWindow(cfg: ModelConfig): Promise<number | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isAnthropicLike(cfg.provider)) {
    if (!cfg.apiKey) return null;
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (cfg.provider === 'gemini') {
    if (!cfg.apiKey) return null;
    headers['x-goog-api-key'] = cfg.apiKey;
  } else if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, '/models'), { headers, signal: controller.signal });
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => null)) as any;
    const arr: any[] = data?.data || data?.models || [];
    const m = arr.find((x) => x?.id === cfg.model);
    if (!m) return null;
    const cw = m.context_window ?? m.context_length ?? m.contextWindow;
    return typeof cw === 'number' && cw > 0 ? cw : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 流式探针：发 stream:true 极小请求，依据响应判定该模型是否支持 SSE 流式输出。
// 判定规则：
//   - 2xx 且 Content-Type 含 text/event-stream 且读到 data: 帧 → true
//   - 2xx 但返回普通 JSON（服务端忽略 stream 参数按非流式应答）→ false
//   - 400/415/422（服务端明确拒绝 stream 相关参数）→ false
//   - 其余（401/429/5xx/网络异常/超时）→ null（无法判定，不覆盖手动标记）
async function probeStream(cfg: ModelConfig): Promise<boolean | null> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (resp.status === 400 || resp.status === 415 || resp.status === 422) return false;
    if (!(resp.status >= 200 && resp.status < 300)) return null;
    const ct = String(resp.headers.get('content-type') || '');
    if (!/text\/event-stream/i.test(ct)) {
      // 非 SSE：网关按非流式 JSON 应答（忽略 stream 参数）→ 不支持流式
      await resp.text().catch(() => '');
      return false;
    }
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('data:')) return true;
      }
      // SSE 响应头但未读到任何 data 帧（空流/立即结束）→ 按不支持处理
      return false;
    } catch {
      // 读流中断（含超时 abort）：已收到数据帧则判支持，否则无法判定
      return buf.includes('data:') ? true : null;
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      controller.abort(); // 尽早断开探测连接
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 真实能力探针：先验证连通性，再逐项发送极小请求判定能力
// opts 可关闭部分探针（未传=全跑）；被关闭的项返回 null，不覆盖用户手动值。
export async function detectCapabilities(
  cfg: ModelConfig,
  opts?: ProbeOptions
): Promise<CapabilityProbeResult> {
  const want = {
    images: opts?.images !== false,
    tools: opts?.tools !== false,
    json: opts?.json !== false,
    nsfw: opts?.nsfw !== false,
    stream: opts?.stream !== false,
    thinkLevel: opts?.thinkLevel !== false,
  };
  const out: CapabilityProbeResult = {
    ok: false,
    message: '',
    supportsImages: null,
    supportsTools: null,
    supportsJson: null,
    supportsNsfw: null,
    supportsStream: null,
    supportsThinkLevel: null,
    maxContext: null,
  };
  if (!cfg.model) {
    out.message = '未选择或填写模型名称';
    return out;
  }
  // 1) 连通性（复用最小 queryAI 探针）
  const conn = await testConnection(cfg);
  out.ok = conn.ok;
  out.message = conn.message;
  if (!conn.ok) return out;

  // Anthropic 接口的工具/视觉格式与 OpenAI 差异较大，本探针仅做连通性 + 上下文窗口，
  // 各项能力保留用户手动标记（返回 null），不覆盖。
  if (isAnthropicLike(cfg.provider)) {
    const skip: string[] = [];
    if (want.images) skip.push('supportsImages');
    if (want.tools) skip.push('supportsTools');
    if (want.json) skip.push('supportsJson');
    if (want.nsfw) skip.push('supportsNsfw');
    if (want.thinkLevel) skip.push('supportsThinkLevel');
    out.undetected = skip;
    out.maxContext = await fetchModelContextWindow(cfg);
    // Anthropic 走 /messages 私有格式，本应用聊天流式不覆盖 Anthropic（handleStream 回退非流式），直接判定不支持
    out.supportsStream = false;
    return out;
  }

  // Gemini 原生接口（v2.3.44）：请求/响应格式与 OpenAI 差异较大，探针仅做连通性 + 上下文窗口，
  // 各项能力保留用户手动标记（返回 null），不覆盖；聊天流式走 streamGemini，故流式判定为支持。
  if (cfg.provider === 'gemini') {
    const skip: string[] = [];
    if (want.images) skip.push('supportsImages');
    if (want.tools) skip.push('supportsTools');
    if (want.json) skip.push('supportsJson');
    if (want.nsfw) skip.push('supportsNsfw');
    if (want.thinkLevel) skip.push('supportsThinkLevel');
    out.undetected = skip;
    out.maxContext = await fetchModelContextWindow(cfg);
    out.supportsStream = true; // streamGemini 已实现 SSE 流式
    out.message = `${out.message}（Gemini 原生接口：仅探测连通性与流式，其余能力请手动标记）`;
    return out;
  }

  // 2) 视觉探针：发一张 1x1 图片，看服务端是否接受 image_url
  if (want.images) {
    const vision = await postChatRaw(cfg, {
      model: cfg.model,
      max_tokens: 4,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: PROBE_PNG } },
          ],
        },
      ],
    });
    out.supportsImages = capFromStatus(vision.status);
  }

  // 3) 工具探针：带一个空工具，看服务端是否接受 tools / tool_choice
  //    v2.3.38：部分网关只接受 tools、对 tool_choice 报 400——首次判定不支持时补测一次「不带 tool_choice」，
  //    避免「实际支持工具却被判为不支持」的误判。
  if (want.tools) {
    const probeTools = [
      {
        type: 'function',
        function: { name: '__probe', description: 'capability probe', parameters: { type: 'object', properties: {} } },
      },
    ];
    const base = { model: cfg.model, max_tokens: 4, temperature: 0, messages: [{ role: 'user', content: 'hi' }] };
    const withChoice = await postChatRaw(cfg, { ...base, tools: probeTools, tool_choice: 'auto' });
    let toolsVerdict = capFromStatus(withChoice.status);
    if (toolsVerdict === false) {
      const noChoice = await postChatRaw(cfg, { ...base, tools: probeTools });
      const c2 = capFromStatus(noChoice.status);
      if (c2 === true) toolsVerdict = true; // 仅 tool_choice 被拒 → 工具本身仍可用
    }
    out.supportsTools = toolsVerdict;
  }

  // 4) JSON 探针：请求 json_object 模式，看服务端是否接受 response_format
  if (want.json) {
    const json = await postChatRaw(cfg, {
      model: cfg.model,
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with a JSON object, e.g. {"ok":true}. Output only JSON.' }],
      response_format: { type: 'json_object' },
    });
    out.supportsJson = capFromStatus(json.status);
  }

  // 5) 思考等级探针：带思考强度参数发一个极小请求，服务端接受即视为「可切换思考等级」。
  //    v2.3.38 修复：三种主流写法（OpenAI 系 reasoning_effort、兼容端 thinking.budget_tokens、
  //    国产端 enable_thinking）改为【分别探测、任一被接受即判定支持】——此前一次全部下发，
  //    严格网关会因其中任一不认识的参数整体返回 400，导致「实际支持却判为不支持」的误判。
  if (want.thinkLevel) {
    const thinkVariants: Record<string, any>[] = [
      { reasoning_effort: 'low' },
      { thinking: { type: 'enabled', budget_tokens: 128 } },
      { enable_thinking: true },
    ];
    let thinkVerdict: boolean | null = null;
    for (const variant of thinkVariants) {
      const think = await postChatRaw(cfg, {
        model: cfg.model,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: 'user', content: 'hi' }],
        ...variant,
      });
      const c = capFromStatus(think.status);
      if (c === true) { thinkVerdict = true; break; } // 任一写法被接受即支持
      if (c === false) { thinkVerdict = false; }      // 该写法不支持，继续试下一种
      // null（401/429/5xx 等无法判定）：保持上一次结论不变，继续试
    }
    out.supportsThinkLevel = thinkVerdict;
  }

  // 6) NSFW 探针：请求一段成人向描写，按返回正文语义判定是否被拒答。
  //    注意：本探针会向模型真实发送成人内容请求，在部分厂商侧会留下审核日志，故一键检测全部时默认关闭。
  if (want.nsfw) {
    const nsfw = await postChatRaw(cfg, {
      model: cfg.model,
      max_tokens: NSFW_PROBE_MAX_TOKENS,
      temperature: 0,
      messages: [{ role: 'user', content: NSFW_PROBE_PROMPT }],
    });
    if (nsfw.status >= 200 && nsfw.status < 300) {
      out.supportsNsfw = judgeNsfw(nsfw.text);
    } else if (nsfw.status === 400 || nsfw.status === 415 || nsfw.status === 422) {
      // 服务端直接拒绝该请求（部分网关在入参侧就做了内容过滤）
      out.supportsNsfw = false;
    }
    // 其余状态码（401/429/5xx/网络异常）保持 null
  }

  // 7) 流式探针：真实发一个 stream:true 请求，检查是否返回 SSE 数据帧
  if (want.stream) {
    out.supportsStream = await probeStream(cfg);
  }

  // 8) 上下文窗口（best-effort）
  out.maxContext = await fetchModelContextWindow(cfg);

  // 9) 汇总「未判定」项（v2.3.38）：显式跳过（未勾选探测项）或探测结果为 null（网络/鉴权异常等）的项，
  //    前端据此把「未判定」与「判定为不支持」区分显示——避免 null 被当成「不支持」误导用户。
  const undetected: string[] = [];
  const collect = (field: keyof CapabilityProbeResult, cfgKey: string) => {
    const v = (out as any)[field];
    if (v === null || v === undefined) undetected.push(cfgKey);
  };
  collect('supportsImages', 'supportsImages');
  collect('supportsTools', 'supportsTools');
  collect('supportsJson', 'supportsJson');
  collect('supportsNsfw', 'supportsNsfw');
  collect('supportsStream', 'supportsStream');
  collect('supportsThinkLevel', 'supportsThinkLevel');
  out.undetected = undetected;
  return out;
}

// 语音转文字（OpenAI 兼容 /audio/transcriptions，multipart 上传）
// format: 上传容器格式（wav/mp3/m4a/flac/webm），决定扩展名与 Content-Type；多数服务端只接受特定格式。
// language: 可选强制识别语言（如 zh / en），空=服务端自动检测。
export async function transcribeAudio(
  cfg: { baseUrl: string; apiKey: string },
  audio: Buffer,
  model: string,
  format: 'wav' | 'mp3' | 'm4a' | 'flac' | 'webm' = 'wav',
  language?: string
): Promise<string> {
  if (!cfg.apiKey) throw new Error('ASR 模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    // 依据目标格式决定扩展名与 MIME（修复：硬编码 audio/webm 导致多数第三方 ASR 返回 400）
    const extMap: Record<string, { ext: string; mime: string }> = {
      wav: { ext: 'audio.wav', mime: 'audio/wav' },
      mp3: { ext: 'audio.mp3', mime: 'audio/mpeg' },
      m4a: { ext: 'audio.m4a', mime: 'audio/mp4' },
      flac: { ext: 'audio.flac', mime: 'audio/flac' },
      webm: { ext: 'audio.webm', mime: 'audio/webm' },
    };
    const fm = extMap[format] || extMap.wav;
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audio)], { type: fm.mime });
    form.append('file', blob, fm.ext);
    form.append('model', model || 'whisper-1');
    // 显式声明返回 JSON，规避个别服务端默认返回 text/verbose_json 造成的解析歧义
    form.append('response_format', 'json');
    if (language && language.trim()) form.append('language', language.trim());
    const resp = await fetch(joinUrl(cfg.baseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`转写失败 ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await resp.json()) as any;
    return String(data?.text ?? '');
  } finally {
    clearTimeout(timer);
  }
}

// ===== 文本转语音：多协议适配（v2.3.22） =====
// 依据 Base URL 自动识别协议：OpenAI 兼容 /audio/speech、MiniMax T2A v2、Google Gemini TTS、
// ElevenLabs、Fish Audio、字节跳动（火山引擎）TTS。返回音频 Buffer + MIME
//（Gemini 返回 L16 PCM，此处统一包一层 WAV 头，浏览器 <audio> 可直接播放）。
export type TtsMime = 'audio/mpeg' | 'audio/wav';
export interface TtsResult {
  audio: Buffer;
  mime: TtsMime;
}

// L16 PCM → WAV 容器（44 字节 RIFF 头）
function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// 语速 / 音调统一参数（v2.3.34）
//   speed：语速倍率，1=原速（范围 0.5~2.0，归一后钳制 0.25~4 以适配各厂商上限）
//   pitch：音调偏移（近似半音），0=不变（范围 -12~12）
// 约定：只有协议原生支持该参数的适配器才真正使用它，其余适配器忽略（参数名以 _ 前缀标注）。
export interface TtsOptions {
  speed?: number;
  pitch?: number;
}

// 语速归一：非法/<=0 → 1（原速）；钳制到 0.25~4（覆盖各家参数范围）
function normSpeed(v?: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}
// 音调归一：非法 → 0（不变）；钳制到 -12~12（半音）
function normPitch(v?: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(12, Math.max(-12, n));
}
// 半音偏移 → 频率比（把「音调」换算成各厂商要求倍率形式的音高参数）
function pitchRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

export async function textToSpeech(
  cfg: { baseUrl: string; apiKey: string },
  text: string,
  model: string,
  voice: string,
  opts?: TtsOptions
): Promise<TtsResult> {
  if (!cfg.apiKey) throw new Error('TTS 模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const speed = normSpeed(opts?.speed);
  const pitch = normPitch(opts?.pitch);
  try {
    const rawBase = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
    // 字节/豆包 v3 单向流式（国内 openspeech.bytedance.com/api/v3/... 与 BytePlus 国际站 voice.*.bytepluses.com）
    // 必须排在 v1 判定之前——国内 v1 与 v3 同域名，只能按路径区分。
    if (/bytepluses\.com/i.test(rawBase) || /\/api\/v3\/tts\/unidirectional/i.test(rawBase)) {
      return await ttsByteDanceV3(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    if (/\/t2a_v2$/i.test(rawBase)) {
      // MiniMax：国内站 api.minimaxi.chat / api.minimaxi.com，国际站 api.minimax.io（同协议，按 baseUrl 原样调用）
      return await ttsMiniMax(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    if (/generativelanguage\.googleapis\.com/i.test(rawBase) || /:generatecontent$/i.test(rawBase)) {
      return await ttsGemini(rawBase, cfg.apiKey, text, model, voice, controller.signal);
    }
    if (/api\.elevenlabs\.io/i.test(rawBase)) {
      return await ttsElevenLabs(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    if (/api\.fish\.audio/i.test(rawBase)) {
      return await ttsFishAudio(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    if (/openspeech\.bytedance\.com/i.test(rawBase) || /\/api\/v1\/tts$/i.test(rawBase)) {
      return await ttsByteDance(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    // Azure 语音服务：全球 tts.speech.microsoft.com；中国区（世纪互联）<region>.tts.speech.azure.cn / *.cognitiveservices.azure.cn
    if (/tts\.speech\.(?:microsoft\.com|azure\.cn)/i.test(rawBase) || /cognitiveservices\/v1/i.test(rawBase)) {
      return await ttsAzure(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    // AWS Polly：全球 polly.<region>.amazonaws.com；中国区 polly.cn-north-1.amazonaws.com.cn
    if (/polly\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?/i.test(rawBase)) {
      return await ttsPolly(rawBase, cfg.apiKey, text, model, voice, controller.signal);
    }
    // 腾讯云：国内 tts.tencentcloudapi.com；国际站 tts.intl.tencentcloudapi.com（签名与 Host 按 baseUrl 推导）
    if (/tencentcloudapi\.com/i.test(rawBase)) {
      return await ttsTencent(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    if (/baidubce\.com|tsn\.baidu\.com/i.test(rawBase)) {
      return await ttsBaidu(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    // 阿里云百炼 DashScope：国内 dashscope.aliyuncs.com；国际（新加坡）dashscope-intl.aliyuncs.com；美国 dashscope-us.aliyuncs.com
    if (/dashscope(?:-intl|-us)?\.aliyuncs\.com/i.test(rawBase)) {
      return await ttsAliyun(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    if (/api\.cartesia\.ai/i.test(rawBase)) {
      return await ttsCartesia(rawBase, cfg.apiKey, text, model, voice, speed, pitch, controller.signal);
    }
    // OpenAI 原生协议（官方端点）优先于兼容协议识别（v2.3.25）
    if (/api\.openai\.com/i.test(rawBase)) {
      return await ttsOpenAINative(rawBase, cfg.apiKey, text, model, voice, speed, controller.signal);
    }
    return await ttsOpenAI(rawBase, cfg.apiKey, text, model, voice, speed, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- OpenAI 兼容（含各类第三方 /audio/speech 网关） ----------
async function ttsOpenAI(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, signal: AbortSignal): Promise<TtsResult> {
  // v2.3.23：模型/音色不再内置默认——只认用户手填或服务端拉取的值，留空明确报错
  if (!model) throw new Error('OpenAI 兼容 TTS：请填写模型名（如 tts-1）');
  if (!voice) throw new Error('OpenAI 兼容 TTS：请填写音色（可从服务端拉取或手填）');
  const speechUrl = /\/audio\/speech$/i.test(base) ? base : joinUrl(base, '/audio/speech');
  const body: Record<string, any> = {
    model,
    voice,
    input: text.slice(0, 4096),
    response_format: 'mp3',
  };
  // 语速（v2.3.34）：协议原生支持，未调整时不带该字段以免影响不支持 speed 的网关
  if (speed !== 1) body.speed = Number(speed.toFixed(3));
  const resp = await fetch(speechUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    // 兼容网关的错误响应可能是 JSON（error.message）或纯文本，两者都识别
    let msg = errText.slice(0, 300);
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) msg = String(j.error.message).slice(0, 300);
    } catch { /* 非 JSON */ }
    throw new Error(`TTS 失败 ${resp.status}: ${msg}`);
  }
  // v2.3.25：部分兼容网关成功时返回 JSON（base64 音频或音频下载 URL）而非二进制流——防御解析
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const j: any = await resp.json();
    const b64 = j?.audio ?? j?.b64_json ?? j?.data?.audio ?? j?.data;
    if (typeof b64 === 'string' && b64.length > 0) {
      return { audio: Buffer.from(b64, 'base64'), mime: 'audio/mpeg' };
    }
    const audioUrl = j?.audio_url ?? j?.url ?? j?.data?.url;
    if (typeof audioUrl === 'string' && audioUrl) {
      const r2 = await fetch(audioUrl, { signal });
      if (!r2.ok) throw new Error(`TTS 音频下载失败 ${r2.status}`);
      return { audio: Buffer.from(await r2.arrayBuffer()), mime: 'audio/mpeg' };
    }
    throw new Error(`TTS 失败：网关返回了无法识别的 JSON 响应：${JSON.stringify(j).slice(0, 200)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// ---------- OpenAI 原生 TTS（api.openai.com 官方端点）：POST /v1/audio/speech，返回二进制 mp3 ----------
// Base URL 填 https://api.openai.com/v1（或根域名 / 完整 /audio/speech 地址，自动归一）；
// 模型如 gpt-4o-mini-tts / tts-1 / tts-1-hd；音色为官方预置音色名（官方无列表端点，手填）。
// 官方错误响应为 JSON（error.message），解析后透出原文。
async function ttsOpenAINative(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, signal: AbortSignal): Promise<TtsResult> {
  if (!model) throw new Error('OpenAI 原生 TTS：请填写模型名（如 gpt-4o-mini-tts / tts-1 / tts-1-hd）');
  if (!voice) throw new Error('OpenAI 原生 TTS：请填写音色（官方预置音色名，见 OpenAI 文档）');
  let url = base;
  if (!/\/audio\/speech$/i.test(url)) url = `${url}/audio/speech`;
  if (!/\/v1\/audio\/speech$/i.test(url)) url = url.replace(/\/audio\/speech$/i, '/v1/audio/speech');
  const body: Record<string, any> = {
    model,
    voice,
    input: text.slice(0, 4096),
    response_format: 'mp3',
  };
  // 语速（官方范围 0.25~4.0）；未调整时不带该字段
  if (speed !== 1) body.speed = Number(speed.toFixed(3));
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    let msg = errText.slice(0, 300);
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) msg = String(j.error.message).slice(0, 300);
    } catch { /* 非 JSON */ }
    throw new Error(`OpenAI 原生 TTS 失败 ${resp.status}: ${msg}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// ---------- MiniMax T2A v2：请求体/响应均为私有格式，data.audio 为 hex 编码 ----------
// 国内站 api.minimaxi.chat / api.minimaxi.com，国际站 api.minimax.io（同协议，按 baseUrl 原样调用）
async function ttsMiniMax(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, pitch: number, signal: AbortSignal): Promise<TtsResult> {
  if (!model) throw new Error('MiniMax TTS：请填写模型名（如 speech-02-hd / speech-02-turbo）');
  if (!voice) throw new Error('MiniMax TTS：请填写音色 voice_id（如 female-shaonv）');
  // 语速（官方 0.5~2.0）与音调（官方 -12~12，近似半音）均原生支持（v2.3.34）
  const resp = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      text: text.slice(0, 10000),
      stream: false,
      voice_setting: {
        voice_id: voice,
        speed: Number(Math.min(2, Math.max(0.5, speed)).toFixed(2)),
        vol: 1.0,
        pitch: Math.round(Math.min(12, Math.max(-12, pitch))),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`MiniMax TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const sc = data?.base_resp?.status_code;
  if (sc !== 0 && sc !== undefined && sc !== null) {
    throw new Error(`MiniMax TTS 失败 ${sc}: ${String(data?.base_resp?.status_msg || '').slice(0, 300)}`);
  }
  const audioHex: string = data?.data?.audio || '';
  if (!audioHex) throw new Error('MiniMax TTS 未返回音频数据');
  // 官方返回 hex 编码；防御校验：非合法 hex（如某些版本返回 base64）时按 base64 解码兜底
  const isHex = /^[0-9a-fA-F]+$/.test(audioHex) && audioHex.length % 2 === 0;
  return { audio: isHex ? Buffer.from(audioHex, 'hex') : Buffer.from(audioHex, 'base64'), mime: 'audio/mpeg' };
}

// ---------- Google Gemini TTS：generateContent + responseModalities:[AUDIO]，返回 L16 PCM ----------
async function ttsGemini(base: string, apiKey: string, text: string, model: string, voice: string, signal: AbortSignal): Promise<TtsResult> {
  if (!model) throw new Error('Gemini TTS：请填写模型名（如 gemini-2.5-flash-preview-tts）');
  if (!voice) throw new Error('Gemini TTS：请填写音色（官方预置音色名，如 Kore）');
  const url = /:generatecontent$/i.test(base) ? base : `${base}/models/${model}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: text.slice(0, 8000) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p: any) => p?.inlineData?.data);
  const b64: string = part?.inlineData?.data || '';
  if (!b64) throw new Error('Gemini TTS 未返回音频数据');
  const mimeType: string = part?.inlineData?.mimeType || 'audio/L16;rate=24000';
  if (/audio\/(wav|x-wav)/i.test(mimeType)) {
    return { audio: Buffer.from(b64, 'base64'), mime: 'audio/wav' };
  }
  const rateMatch = /rate=(\d+)/i.exec(mimeType);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  return { audio: pcmToWav(Buffer.from(b64, 'base64'), sampleRate), mime: 'audio/wav' };
}

// ---------- ElevenLabs：POST /v1/text-to-speech/{voice_id}，返回二进制 mp3 ----------
async function ttsElevenLabs(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, _pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const mVoice = /\/text-to-speech\/([^/?#]+)/i.exec(base);
  const voiceId = (mVoice ? decodeURIComponent(mVoice[1]) : voice || '').trim();
  if (!voiceId) throw new Error('ElevenLabs：请填写音色 voice_id（「音色」栏或 Base URL 中）');
  if (!model) throw new Error('ElevenLabs：请填写模型 model_id（如 eleven_multilingual_v2）');
  let url = /\/text-to-speech\//i.test(base) ? base : `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  if (!/output_format=/i.test(url)) url += `${url.includes('?') ? '&' : '?'}output_format=mp3_44100_128`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: model,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        // 语速（v2.3.34）：ElevenLabs 官方取值范围 0.7~1.2，超出部分在此钳制（不做前端变速以免影响音色）
        ...(speed !== 1 ? { speed: Number(Math.min(1.2, Math.max(0.7, speed)).toFixed(3)) } : {}),
      },
    }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ElevenLabs TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// ---------- Fish Audio：POST /v1/tts，voice 即 reference_id，返回二进制 mp3 ----------
async function ttsFishAudio(base: string, apiKey: string, text: string, _model: string, voice: string, speed: number, _pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const url = /\/tts$/i.test(base) ? base : `${base}/v1/tts`;
  const refId = (voice || '').trim();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      ...(refId ? { reference_id: refId } : {}),
      format: 'mp3',
      mp3_bitrate: 128,
      latency: 'balanced',
      // 语速（v2.3.34）：Fish Audio 用 prosody.speed，官方范围 0.5~2.0
      ...(speed !== 1 ? { prosody: { speed: Number(Math.min(2, Math.max(0.5, speed)).toFixed(2)) } } : {}),
    }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Fish Audio TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// ---------- 字节跳动（火山引擎）TTS：POST /api/v1/tts，响应 JSON data 为 base64 ----------
// 凭据约定：API Key 栏填 `<AppID>:<AccessToken>`（兼容 `|` 分隔）；「模型」栏填 cluster（默认 volcano_tts）；「音色」栏填 voice_type
async function ttsByteDance(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const cred = (apiKey || '').trim();
  const sepIdx = cred.includes(':') ? cred.indexOf(':') : cred.includes('|') ? cred.indexOf('|') : -1;
  const appId = sepIdx > 0 ? cred.slice(0, sepIdx).trim() : '';
  const token = sepIdx > 0 ? cred.slice(sepIdx + 1).trim() : cred;
  if (!appId || !token) throw new Error('字节 TTS：API Key 栏请按 `<AppID>:<AccessToken>` 填写');
  if (!model) throw new Error('字节 TTS：请在「模型」栏填写 cluster（如 volcano_tts）');
  const voiceType = (voice || '').trim();
  if (!voiceType) throw new Error('字节 TTS：请填写音色 voice_type（见火山引擎控制台）');
  const url = /\/api\/v1\/tts$/i.test(base) ? base : `${base.replace(/\/api\/v1\/tts.*$/i, '')}/api/v1/tts`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer; ${token}` },
    body: JSON.stringify({
      app: { appid: appId, token, cluster: model },
      user: { uid: 'nianyu' },
      audio: {
        voice_type: voiceType,
        encoding: 'mp3',
        // 语速 0.2~3.0；音调 pitch_ratio 0.1~3.0（1.0=不变，按半音换算频率比）
        speed_ratio: Math.min(3, Math.max(0.2, Number(speed.toFixed(2)))),
        pitch_ratio: Math.min(3, Math.max(0.1, Number(pitchRatio(pitch).toFixed(3)))),
      },
      request: { reqid: `${Date.now()}_${Math.floor(Math.random() * 1e6)}`, text: text.slice(0, 1000), text_type: 'plain', operation: 'query' },
    }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`字节 TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  if (data?.code !== 3000) {
    throw new Error(`字节 TTS 失败 ${data?.code}: ${String(data?.message || '').slice(0, 300)}`);
  }
  const b64: string = data?.data || '';
  if (!b64) throw new Error('字节 TTS 未返回音频数据');
  return { audio: Buffer.from(b64, 'base64'), mime: 'audio/mpeg' };
}

// ---------- 豆包语音 2.0 / BytePlus（v3 单向流式 HTTP） ----------
// 国内：https://openspeech.bytedance.com/api/v3/tts/unidirectional
// 国际（BytePlus）：https://voice.<region>.bytepluses.com/api/v3/tts/unidirectional
// 鉴权：新版控制台用单个 API Key（Header `X-Api-Key`）；兼容旧版 `AppID:AccessToken`（拆成 X-Api-App-Id / X-Api-Access-Key）。
// 「模型」栏填 X-Api-Resource-Id（TTS 2.0=seed-tts-2.0，TTS 1.0=seed-tts-1.0 / volc.service_type.1000009），留空默认 seed-tts-2.0。
// 「音色」栏填 speaker（控制台音色库 ID）。响应为逐行 JSON 帧，音频为 base64 分段，需按到达顺序拼接。
async function ttsByteDanceV3(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const cred = (apiKey || '').trim();
  const sepIdx = cred.includes(':') ? cred.indexOf(':') : cred.includes('|') ? cred.indexOf('|') : -1;
  const appId = sepIdx > 0 ? cred.slice(0, sepIdx).trim() : '';
  const accessKey = sepIdx > 0 ? cred.slice(sepIdx + 1).trim() : '';
  const speaker = (voice || '').trim();
  if (!speaker) throw new Error('豆包语音 2.0 TTS：请填写音色（speaker，见控制台音色库）');
  const resourceId = (model || '').trim() || 'seed-tts-2.0';
  const url = /\/api\/v3\/tts\/unidirectional$/i.test(base)
    ? base
    : `${base.replace(/\/api\/v3\/tts.*$/i, '').replace(/\/api\/v1\/tts.*$/i, '')}/api/v3/tts/unidirectional`;
  let reqId = '';
  try { reqId = crypto.randomUUID(); } catch { reqId = `nianyu-${Date.now()}-${Math.floor(Math.random() * 1e6)}`; }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': reqId,
    Connection: 'keep-alive',
  };
  if (appId && accessKey) {
    // 兼容旧版控制台凭据（AppID + AccessToken 一对）
    headers['X-Api-App-Id'] = appId;
    headers['X-Api-Access-Key'] = accessKey;
    headers['X-Api-App-Key'] = 'aGjiRDfUWi';
  } else {
    // 推荐：新版控制台生成的单个 API Key
    headers['X-Api-Key'] = cred;
  }
  // 语速：speech_rate 官方范围 [-50, 100]（0=原速，100=2.0 倍速，-50=0.5 倍速）
  const speechRate = Math.max(-50, Math.min(100, Math.round((speed - 1) * 100)));
  const reqParams: Record<string, any> = {
    text: text.slice(0, 5000),
    speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: speechRate },
  };
  // 音调：additions 为 JSON 字符串，post_process.pitch 官方范围 [-12, 12]（0=不变）
  if (pitch !== 0) reqParams.additions = JSON.stringify({ post_process: { pitch: Math.round(pitch) } });
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ req_params: reqParams }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`豆包语音 2.0 TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  // 少数网关直接回二进制音频
  if (ct.startsWith('audio/')) {
    return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
  }
  const frames: Buffer[] = [];
  const handleFrame = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    const b64 = obj.data ?? obj.audio ?? obj.payload ?? obj?.data?.audio;
    if (typeof b64 === 'string' && b64) {
      try { frames.push(Buffer.from(b64, 'base64')); } catch { /* 单帧解码失败则跳过 */ }
    }
  };
  let raw = '';
  const reader = resp.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/^\s*data:\s*/i, '').trim();
        buf = buf.slice(nl + 1);
        if (line) {
          raw += line;
          try { handleFrame(JSON.parse(line)); } catch { /* 非完整 JSON 帧，最后统一兜底 */ }
        }
        nl = buf.indexOf('\n');
      }
    }
    const tail = buf.replace(/^\s*data:\s*/i, '').trim();
    if (tail) {
      raw += tail;
      try { handleFrame(JSON.parse(tail)); } catch { /* 兜底处理 */ }
    }
  } else {
    raw = await resp.text().catch(() => '');
    try { handleFrame(JSON.parse(raw)); } catch { /* 兜底处理 */ }
  }
  if (!frames.length) {
    // 兜底：部分实现把多个 JSON 帧直接串联 / 未按行分隔，用正则抽出所有 base64 音频字段
    const re = /"(?:data|audio|payload)"\s*:\s*"([A-Za-z0-9+/=]{64,})"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      try { frames.push(Buffer.from(m[1], 'base64')); } catch { /* 忽略非法 base64 */ }
    }
  }
  if (!frames.length) {
    const err = /"(?:message|msg)"\s*:\s*"([^"]{1,200})"/.exec(raw);
    throw new Error(`豆包语音 2.0 TTS 未返回音频数据${err ? `：${err[1]}` : ''}`);
  }
  return { audio: Buffer.concat(frames), mime: 'audio/mpeg' };
}

// ---------- Azure TTS（认知服务语音）：SSML POST /cognitiveservices/v1，返回二进制 mp3 ----------
// Base URL 形如 https://<region>.tts.speech.microsoft.com（可带 /cognitiveservices/v1）；API Key 即订阅密钥；「音色」填神经语音名（如 zh-CN-XiaoxiaoNeural 或 XiaoxiaoNeural）
async function ttsAzure(base: string, apiKey: string, text: string, _model: string, voice: string, speed: number, pitch: number, signal: AbortSignal): Promise<TtsResult> {
  let url = base;
  if (!/cognitiveservices\/v1/i.test(url)) url = `${url}/cognitiveservices/v1`;
  const name0 = (voice || '').trim() || 'zh-CN-XiaoxiaoNeural';
  const voiceName = name0.includes('-') ? name0 : `zh-CN-${name0}`;
  const body = text.slice(0, 5000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 语速/音调：Azure 走 SSML <prosody rate="+20%" pitch="+2st">；未调整时不加该层，保持原始 SSML 结构
  const rateAttr = speed !== 1 ? ` rate='${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%'` : '';
  const pitchAttr = pitch !== 0 ? ` pitch='${pitch > 0 ? '+' : ''}${Math.round(pitch)}st'` : '';
  const inner = rateAttr || pitchAttr ? `<prosody${rateAttr}${pitchAttr}>${body}</prosody>` : body;
  const ssml =
    `<speak version='1.0' xml:lang='zh-CN'><voice name='${voiceName.replace(/['<>&]/g, '')}'>` +
    inner +
    `</voice></speak>`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'nianyu-tts',
    },
    body: ssml,
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Azure TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmacBuf(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// ---------- AWS Polly：SigV4 签名 POST /v1/speech，返回二进制 mp3 ----------
// Base URL 形如 https://polly.<region>.amazonaws.com；API Key 栏填 `<AccessKeyId>:<SecretAccessKey>`；「音色」填 VoiceId（如 Zhiyu）
async function ttsPolly(base: string, apiKey: string, text: string, _model: string, voice: string, signal: AbortSignal): Promise<TtsResult> {
  const cred = (apiKey || '').trim();
  const sepIdx = cred.includes(':') ? cred.indexOf(':') : cred.includes('|') ? cred.indexOf('|') : -1;
  const accessKey = sepIdx > 0 ? cred.slice(0, sepIdx).trim() : '';
  const secretKey = sepIdx > 0 ? cred.slice(sepIdx + 1).trim() : '';
  if (!accessKey || !secretKey) throw new Error('AWS Polly：API Key 栏请按 `<AccessKeyId>:<SecretAccessKey>` 填写');
  const regionMatch = /polly\.([a-z0-9-]+)\.amazonaws\.com/i.exec(base);
  const region = regionMatch ? regionMatch[1] : 'us-east-1';
  const host = `polly.${region}.amazonaws.com`;
  const voiceId = (voice || '').trim();
  if (!voiceId) throw new Error('AWS Polly：请填写音色 VoiceId（如 Zhiyu）');
  const payload = JSON.stringify({
    OutputFormat: 'mp3',
    Text: text.slice(0, 2500),
    TextType: 'text',
    VoiceId: voiceId,
  });
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 'polly';
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = ['POST', '/v1/speech', '', canonicalHeaders, signedHeaders, sha256Hex(payload)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmacBuf(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacBuf(kDate, region);
  const kService = hmacBuf(kRegion, service);
  const kSigning = hmacBuf(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await fetch(`https://${host}/v1/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Amz-Date': amzDate, Authorization: authorization },
    body: payload,
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AWS Polly 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// Polly 音色列表（DescribeVoices，GET /v1/voices，同样走 SigV4）：供设置页实时拉取，失败由调用方回退空列表
export async function listPollyVoices(base: string, apiKey: string): Promise<string[]> {
  const cred = (apiKey || '').trim();
  const sepIdx = cred.includes(':') ? cred.indexOf(':') : cred.includes('|') ? cred.indexOf('|') : -1;
  const accessKey = sepIdx > 0 ? cred.slice(0, sepIdx).trim() : '';
  const secretKey = sepIdx > 0 ? cred.slice(sepIdx + 1).trim() : '';
  if (!accessKey || !secretKey) return [];
  const regionMatch = /polly\.([a-z0-9-]+)\.amazonaws\.com/i.exec(base);
  const region = regionMatch ? regionMatch[1] : 'us-east-1';
  const host = `polly.${region}.amazonaws.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 'polly';
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = ['GET', '/v1/voices', '', canonicalHeaders, signedHeaders, sha256Hex('')].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmacBuf(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacBuf(kDate, region);
  const kService = hmacBuf(kRegion, service);
  const kSigning = hmacBuf(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await fetch(`https://${host}/v1/voices`, {
    headers: { 'X-Amz-Date': amzDate, Authorization: authorization },
  });
  if (!resp.ok) return [];
  const data: any = await resp.json();
  return (data?.Voices || []).map((v: any) => v?.Id).filter(Boolean);
}

// ---------- 腾讯云 TTS：TC3-HMAC-SHA256 签名 POST tts.tencentcloudapi.com（TextToVoice），响应 Audio 为 base64 ----------
// Base URL 填 https://tts.tencentcloudapi.com；API Key 栏填 `<SecretId>:<SecretKey>`；「音色」填 VoiceType（数字音色码如 101001，或字符串音色 ID）
async function ttsTencent(base: string, apiKey: string, text: string, _model: string, voice: string, speed: number, _pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const cred = (apiKey || '').trim();
  const sepIdx = cred.includes(':') ? cred.indexOf(':') : cred.includes('|') ? cred.indexOf('|') : -1;
  const secretId = sepIdx > 0 ? cred.slice(0, sepIdx).trim() : '';
  const secretKey = sepIdx > 0 ? cred.slice(sepIdx + 1).trim() : '';
  if (!secretId || !secretKey) throw new Error('腾讯云 TTS：API Key 栏请按 `<SecretId>:<SecretKey>` 填写');
  // 域名与地域按 baseUrl 推导，同时适配国内站与国际站：
  //   国内：tts.tencentcloudapi.com（默认，不显式带地域，保持既有可用配置不变）
  //   国际：tts.intl.tencentcloudapi.com（地域 ap-singapore）
  //   指定地域：tts.ap-guangzhou.tencentcloudapi.com 等
  // 注意：只有「显式识别出地域」时才带 X-TC-Region（且必须参与签名）；
  //      默认国内站不带该头，避免影响原本已正常工作的国内站配置。
  let host = 'tts.tencentcloudapi.com';
  let region = 'ap-guangzhou';
  let regionExplicit = false;
  try {
    const h = new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`).host.toLowerCase();
    if (/^tts\.intl\.tencentcloudapi\.com$/.test(h)) {
      host = h;
      region = 'ap-singapore';
      regionExplicit = true;
    } else if (/^tts\.tencentcloudapi\.com$/.test(h)) {
      host = h;
    } else if (/^tts\.[a-z0-9-]+\.tencentcloudapi\.com$/.test(h)) {
      host = h;
      region = h.split('.')[1];
      regionExplicit = true;
    } else if (/tencentcloudapi\.com$/.test(h)) {
      host = h;
    }
  } catch { /* baseUrl 非法时回退国内站默认值 */ }
  const service = 'tts';
  const action = 'TextToVoice';
  const version = '2019-08-23';
  const vt = (voice || '').trim();
  if (!vt) throw new Error('腾讯云 TTS：请填写音色 VoiceType（见控制台音色列表）');
  // 语速：官方 Speed 参数范围 [-2, 6]（0=原速，1=1.2 倍，2=1.5 倍，6=2.5 倍，可带一位小数）
  const speedParam = speed <= 1 ? 5 * (speed - 1) : speed <= 1.5 ? 5 * (speed - 1) : 2 + 4 * (speed - 1.5);
  const payload: Record<string, any> = {
    Text: text.slice(0, 600),
    SessionId: `nianyu${Date.now() % 100000000}`,
    VoiceType: /^\d+$/.test(vt) ? parseInt(vt, 10) : vt,
    Codec: 'mp3', // 与返回 MIME 对齐（默认 wav 会造成格式与声明不一致）
    ...(speed !== 1 ? { Speed: Number(Math.min(6, Math.max(-2, speedParam)).toFixed(1)) } : {}),
  };
  const bodyStr = JSON.stringify(payload);
  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n` +
    (regionExplicit ? `x-tc-region:${region}\n` : '');
  const signedHeaders = regionExplicit ? 'content-type;host;x-tc-action;x-tc-region' : 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(bodyStr)].join('\n');
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), `${dateStamp}/${service}/tc3_request`, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmacBuf(`TC3${secretKey}`, dateStamp);
  const kService = hmacBuf(kDate, service);
  const kSigning = hmacBuf(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${dateStamp}/${service}/tc3_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
      ...(regionExplicit ? { 'X-TC-Region': region } : {}),
      Authorization: authorization,
    },
    body: bodyStr,
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`腾讯云 TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const err = data?.Response?.Error;
  if (err) throw new Error(`腾讯云 TTS 失败 ${err.Code}: ${String(err.Message || '').slice(0, 300)}`);
  const b64: string = data?.Response?.Audio || '';
  if (!b64) throw new Error('腾讯云 TTS 未返回音频数据');
  return { audio: Buffer.from(b64, 'base64'), mime: 'audio/mpeg' };
}

// ---------- 百度智能云 TTS：OAuth 换 access_token + tsn.baidu.com/text2audio，返回二进制 mp3 ----------
// API Key 栏填 `<APIKey>:<SecretKey>`；「音色」填精品音库 voicer 编号（如 4），留空用基础音库
const baiduTokenCache = new Map<string, { token: string; expiresAt: number }>();
async function ttsBaidu(_base: string, apiKey: string, text: string, _model: string, voice: string, speed: number, pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const cred = (apiKey || '').trim();
  const sepIdx = cred.includes(':') ? cred.indexOf(':') : cred.includes('|') ? cred.indexOf('|') : -1;
  const ak = sepIdx > 0 ? cred.slice(0, sepIdx).trim() : '';
  const sk = sepIdx > 0 ? cred.slice(sepIdx + 1).trim() : '';
  if (!ak || !sk) throw new Error('百度 TTS：API Key 栏请按 `<APIKey>:<SecretKey>` 填写');
  // OAuth access_token（有效期 30 天，本地缓存 25 天）
  const now = Date.now();
  let cached = baiduTokenCache.get(sk);
  if (!cached || cached.expiresAt < now) {
    const tr = await fetch(
      `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(ak)}&client_secret=${encodeURIComponent(sk)}`,
      { method: 'POST', signal }
    );
    if (!tr.ok) throw new Error(`百度 TTS：获取 access_token 失败 ${tr.status}`);
    const td: any = await tr.json();
    if (!td?.access_token) {
      throw new Error(`百度 TTS：获取 access_token 失败：${String(td?.error_description || td?.error || '未知').slice(0, 200)}`);
    }
    cached = { token: td.access_token, expiresAt: now + Math.min(td.expires_in || 2592000, 2160000) * 1000 };
    baiduTokenCache.set(sk, cached);
  }
  // 语速 spd / 音调 pit（v2.3.34）：百度取值为 0~15 的整数，5=正常；
  // 语速倍率 1.0 → 5，倍率 2.0 → 10；音调半音按 5 为原点线性换算（±12 半音 → 0~15 边界）
  const spd = Math.round(Math.min(15, Math.max(0, speed * 5)));
  const pit = Math.round(Math.min(15, Math.max(0, 5 + (pitch * 5) / 12)));
  const params = new URLSearchParams({
    tex: text.slice(0, 1000),
    tok: cached.token,
    cuid: 'nianyu',
    ctp: '1',
    lan: 'zh',
    aue: '3', // mp3
    spd: String(spd),
    pit: String(pit),
    ...(voice.trim() ? { voicer: voice.trim() } : { per: '0' }),
  });
  const resp = await fetch('https://tsn.baidu.com/text2audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal,
  });
  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok || ct.includes('application/json')) {
    // 出错时百度返回 JSON（err_no/err_msg）
    const t = await resp.text();
    throw new Error(`百度 TTS 失败 ${resp.status}: ${t.slice(0, 300)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// ---------- 阿里云通义 TTS：DashScope 兼容模式 /audio/speech（qwen-tts），返回二进制 ----------
// Base URL 填 https://dashscope.aliyuncs.com/compatible-mode/v1（填根地址会自动补全）；「音色」填 qwen-tts 音色名（Cherry/Ethan 等）
async function ttsAliyun(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, _pitch: number, signal: AbortSignal): Promise<TtsResult> {
  // 保留调用方域名（国内 dashscope / 国际 dashscope-intl / 美国 dashscope-us 三站均支持），只补齐 compatible-mode/v1 路径
  let b = base.replace(/\/+$/, '');
  if (!/compatible-mode/i.test(b)) {
    b = /dashscope(?:-intl|-us)?\.aliyuncs\.com/i.test(b)
      ? `${b}/compatible-mode/v1`
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1'; // 非 dashscope 域名：回退国内站
  } else if (/compatible-mode$/i.test(b)) {
    b = `${b}/v1`;
  }
  if (!model) throw new Error('阿里 TTS：请填写模型名（如 qwen-tts-latest）');
  if (!voice) throw new Error('阿里 TTS：请填写音色（如 Cherry）');
  return ttsOpenAI(b, apiKey, text, model, voice, speed, signal);
}

// ---------- Cartesia Sonic：POST /tts/bytes，返回二进制 mp3 ----------
// Base URL 填 https://api.cartesia.ai；「音色」填 voice id；「模型」默认 sonic-2
async function ttsCartesia(base: string, apiKey: string, text: string, model: string, voice: string, speed: number, _pitch: number, signal: AbortSignal): Promise<TtsResult> {
  const voiceId = (voice || '').trim();
  if (!voiceId) throw new Error('Cartesia：请填写音色 voice id');
  if (!model) throw new Error('Cartesia：请填写模型名（如 sonic-2）');
  const url = /\/tts\/bytes$/i.test(base) ? base : `${base}/tts/bytes`;
  const body: Record<string, any> = {
    model_id: model,
    transcript: text.slice(0, 5000),
    voice: { mode: 'id', id: voiceId },
    output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
  };
  // 语速（v2.3.34）：Cartesia 走 generation_config.speed，官方范围 0.6~1.5
  if (speed !== 1) body.generation_config = { speed: Number(Math.min(1.5, Math.max(0.6, speed)).toFixed(3)) };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Cartesia-Version': '2025-04-16' },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Cartesia TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
  }
  return { audio: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' };
}

// 图像生成（OpenAI 兼容 /images/generations）：返回 base64 或图片 URL
// referenceImages：参考图（base64 data URL 数组），如角色头像；仅在与生成内容相关时传入，无关时不要传以免影响生成
export async function generateImage(
  cfg: { baseUrl: string; apiKey: string },
  prompt: string,
  model: string,
  size: string,
  referenceImages?: string[]
): Promise<{ b64?: string; url?: string }> {
  if (!cfg.apiKey) throw new Error('生图模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const body: Record<string, any> = { model: model || 'gpt-image-1', prompt, n: 1, size: size || '1024x1024' };
    if (referenceImages && referenceImages.length) body.image = referenceImages;
    const resp = await fetch(joinUrl(cfg.baseUrl, '/images/generations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`生图失败 ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await resp.json()) as any;
    const item = data?.data?.[0];
    if (!item) throw new Error('生图接口未返回图片数据');
    return { b64: item.b64_json, url: item.url };
  } finally {
    clearTimeout(timer);
  }
}

// 视频生成（OpenAI 兼容 /videos/generations）：返回 base64 或视频 URL；使用方式与生图一致
// referenceImages：参考图（base64 data URL 数组），如用户发送的图片；仅「图生视频」时传入（依供应商支持）
// onProgress：任务式生成时的进度回调 (0~100)；即时返回型端点会在拿到结果后回调一次 100
export async function generateVideo(
  cfg: { baseUrl: string; apiKey: string },
  prompt: string,
  model: string,
  size: string,
  duration: string,
  referenceImages?: string[],
  onProgress?: (percent: number, statusText?: string) => void
): Promise<{ b64?: string; url?: string }> {
  if (!cfg.apiKey) throw new Error('生视频模型未配置 API Key');
  const controller = new AbortController();
  // 总超时：同步端点 5 分钟，任务式轮询上限 10 分钟（由 pollVideoTask 内部再细化）
  const timer = setTimeout(() => controller.abort(), 600000);
  try {
    const body: Record<string, any> = {
      model: model || '',
      prompt,
      n: 1,
      size: size || '1280x720',
      duration: Number(duration) || 5,
    };
    if (referenceImages && referenceImages.length) body.image = referenceImages;
    const resp = await fetch(joinUrl(cfg.baseUrl, '/videos/generations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`生视频失败 ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await resp.json()) as any;
    // 任务式端点会返回任务 ID（随后需轮询），即时型端点直接返回结果
    const taskId = data?.id || data?.task_id || data?.data?.[0]?.id || data?.data?.[0]?.task_id;
    // 不同供应商返回结构不一：优先 data[0].url / video / b64_json
    const item = data?.data?.[0] || data?.videos?.[0] || data;
    const url = item?.url || item?.video?.url || item?.uri;
    const b64 = item?.b64_json || item?.video?.b64_json;
    if (url || b64) {
      onProgress?.(100, 'done');
      return { b64, url };
    }
    if (taskId) {
      const result = await pollVideoTask(cfg, taskId, controller, onProgress);
      onProgress?.(100, 'done');
      return result;
    }
    throw new Error('生视频接口未返回视频数据（无任务 ID 也无结果）');
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 在任意嵌套结构里找第一个 mp4/webm/mov 直链（部分供应商把结果藏在深层字段）
function findFirstVideoUrl(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && /\.(mp4|webm|mov)(\?|$)/i.test(v)) return v;
    const r = findFirstVideoUrl(v);
    if (r) return r;
  }
  return null;
}

// 任务式生视频轮询：常见端点 /videos/generations/tasks/{id}，备选 /videos/generations/{id}
async function pollVideoTask(
  cfg: { baseUrl: string; apiKey: string },
  taskId: string,
  controller: AbortController,
  onProgress?: (percent: number, statusText?: string) => void
): Promise<{ b64?: string; url?: string }> {
  const base = joinUrl(cfg.baseUrl, '/videos/generations');
  const endpoints = [`${base}/tasks/${taskId}`, `${base}/${taskId}`];
  const started = Date.now();
  const MAX_WAIT = 9 * 60 * 1000; // 轮询上限 9 分钟
  const INTERVAL = 3000; // 每 3 秒查一次
  for (;;) {
    if (Date.now() - started > MAX_WAIT) {
      throw new Error(`生视频任务超时（${Math.round(MAX_WAIT / 60000)} 分钟未完成）：${taskId}`);
    }
    let taskData: any = null;
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          signal: controller.signal,
        });
        if (r.ok) {
          taskData = await r.json();
          break;
        }
      } catch {
        /* 端点不可用则尝试下一个 */
      }
    }
    if (!taskData) {
      await sleep(INTERVAL);
      continue;
    }
    const status = String(taskData?.status || taskData?.state || '').toLowerCase();
    let pct = taskData?.progress;
    if (typeof pct === 'number' && pct > 0 && pct <= 1) pct = Math.round(pct * 100);
    if (typeof pct !== 'number' || Number.isNaN(pct)) {
      pct = Math.min(90, Math.round(((Date.now() - started) / MAX_WAIT) * 100));
    }
    onProgress?.(Math.max(0, Math.min(99, Math.round(pct))), status);
    if (status === 'succeeded' || status === 'completed' || status === 'success' || status === 'done') {
      const item = taskData?.data?.[0] || taskData?.video || taskData?.result || taskData;
      const url = item?.url || item?.video?.url || item?.uri || taskData?.url || taskData?.uri;
      const b64 = item?.b64_json || item?.video?.b64_json || taskData?.b64_json;
      if (url || b64) return { b64, url };
      const nested = findFirstVideoUrl(taskData);
      if (nested) return { url: nested };
      throw new Error('生视频任务已完成但未返回视频地址');
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const msg = taskData?.error?.message || taskData?.message || status;
      throw new Error(`生视频任务失败：${msg}`);
    }
    await sleep(INTERVAL);
  }
}

// 角色简介 AI 补全（使用指定模型配置）
export async function aiCompleteRole(
  cfg: ModelConfig,
  basicInfo: Record<string, string>
): Promise<string> {
  const prompt =
    `根据以下角色基本信息，生成详细的角色设定（性格、背景故事、外貌、世界观、行为规则、说话风格示例、开场白），以 JSON 格式返回，字段为：` +
    `personality, background, appearance, world_setting, rules, example_dialogue, first_message。` +
    `只返回 JSON，不要额外解释。基本信息：` +
    JSON.stringify(basicInfo, null, 2);
  const res = await queryAI(
    cfg,
    [
      { role: 'system', content: '你是一名擅长角色设定的助手，输出严格 JSON。' },
      { role: 'user', content: prompt },
    ],
    1500
  );
  return res.content;
}
