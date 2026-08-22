import type { ModelConfig } from '../src/types';

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
  if (!cfg.apiKey && cfg.provider !== 'openai-compatible') {
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
    if (cfg.provider === 'anthropic') {
      return await queryAnthropic(cfg, messages, maxTokens, controller);
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

async function queryOpenAILike(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  controller: AbortController
): Promise<AIResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: h,
    body: JSON.stringify((() => {
      const b: Record<string, any> = {
        model: cfg.model,
        messages,
        max_tokens: cfg.maxTokens ?? maxTokens,
        temperature: cfg.temperature,
        stream: false,
      };
      if (cfg.topP !== undefined) b.top_p = cfg.topP;
      if (cfg.topK !== undefined && cfg.topK > 0) b.top_k = cfg.topK;
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
  const data = (await resp.json()) as any;
  const msg = data?.choices?.[0]?.message ?? {};
  const rawContent: string = msg?.content ?? '';
  // 思维链：模型无关抽取（任意厂牌字段）+ 剥离 <think> 标签（内联思考）
  let reasoning: string = extractReasoning(msg);
  const split = splitThink(rawContent);
  if (split.reasoning) reasoning = reasoning ? `${reasoning}\n${split.reasoning}` : split.reasoning;
  const usage = data?.usage ?? {};
  return {
    content: split.content,
    reasoning: reasoning || undefined,
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
  };
}

// OpenAI 兼容接口流式调用；Anthropic 不在此实现
export async function streamAI(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  onChunk: (chunk: StreamChunk) => void,
  controller: AbortController
): Promise<AIResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: h,
    body: JSON.stringify((() => {
      const b: Record<string, any> = {
        model: cfg.model,
        messages,
        max_tokens: cfg.maxTokens ?? maxTokens,
        temperature: cfg.temperature,
        stream: true,
      };
      if (cfg.topP !== undefined) b.top_p = cfg.topP;
      if (cfg.topK !== undefined && cfg.topK > 0) b.top_k = cfg.topK;
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
  // 流式接口通常不返回 usage，按字符粗略估算作为 fallback
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
  const resp = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify((() => {
      const b: Record<string, any> = {
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? maxTokens,
        temperature: Math.min(cfg.temperature, 1),
        system,
        messages: turns,
      };
      if (cfg.topP !== undefined) b.top_p = cfg.topP;
      if (cfg.topK !== undefined && cfg.topK > 0) b.top_k = cfg.topK;
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
    if (cfg.provider === 'anthropic') {
      if (!cfg.apiKey) throw new Error('未配置 API Key');
      url = joinUrl(cfg.baseUrl, '/models');
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      url = joinUrl(cfg.baseUrl, '/models');
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

// 语音转文字（OpenAI 兼容 /audio/transcriptions，multipart 上传）
export async function transcribeAudio(
  cfg: { baseUrl: string; apiKey: string },
  audio: Buffer,
  model: string,
  fileName = 'audio.webm'
): Promise<string> {
  if (!cfg.apiKey) throw new Error('ASR 模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audio)], { type: 'audio/webm' });
    form.append('file', blob, fileName);
    form.append('model', model || 'whisper-1');
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

// 文本转语音（OpenAI 兼容 /audio/speech），返回 mp3 音频 Buffer
export async function textToSpeech(
  cfg: { baseUrl: string; apiKey: string },
  text: string,
  model: string,
  voice: string
): Promise<Buffer> {
  if (!cfg.apiKey) throw new Error('TTS 模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'tts-1',
        voice: voice || 'alloy',
        input: text.slice(0, 4096),
        response_format: 'mp3',
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`TTS 失败 ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(timer);
  }
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
