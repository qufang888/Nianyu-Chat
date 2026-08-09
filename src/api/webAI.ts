// Web 版 AI 调用层（浏览器/WebView 环境）
// 移植自 electron/ai.ts：保留全部纯 fetch 逻辑（OpenAI 兼容流式、Anthropic、思维链抽取、
// 模型列表、连接测试、角色补全、生图），仅把 Node 特有的 Buffer 改为浏览器 Uint8Array/ArrayBuffer。
import type { ModelConfig } from '../types';

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
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
  reasoning?: string;
  promptTokens: number;
  completionTokens: number;
}

export interface StreamChunk {
  content: string;
  reasoning?: string;
  done: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

// 把正文中的 <think>...</think> 段落剥离为思维链（兼容未闭合的情况）
export function splitThink(raw: string): { content: string; reasoning: string } {
  let reasoning = '';
  let content = '';
  let rest = raw;
  while (true) {
    const start = rest.indexOf('<think>');
    if (start === -1) {
      content += rest;
      break;
    }
    content += rest.slice(0, start);
    const end = rest.indexOf('</think>', start + 7);
    if (end === -1) {
      reasoning += rest.slice(start + 7);
      break;
    }
    reasoning += rest.slice(start + 7, end);
    rest = rest.slice(end + 8);
  }
  return { content: content.replace(/^\s+/, ''), reasoning: reasoning.trim() };
}

const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning',
  'thought',
  'thinking',
  'chain_of_thought',
  'cot',
];
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
    if (!STD_OPENAI_FIELDS.has(key) && v.trim()) {
      out += (out ? '\n' : '') + v;
    }
  }
  return out;
}

function partialTagHold(s: string): number {
  const tags = ['<think>', '</think>'];
  const maxLen = 8;
  for (let k = Math.min(maxLen, s.length); k >= 1; k--) {
    const tail = s.slice(-k);
    if (tags.some((t) => t.length > k && t.startsWith(tail))) return k;
  }
  return 0;
}

// ===================== A+B 混合 CORS 策略 =====================
// 默认走浏览器 fetch（A 路径，支持真·逐字流式）。若 fetch 抛错（典型为 CORS / "Failed to fetch"），
// 自动回退到 Capacitor 原生 HTTP 插件（B 路径，由 Java 层发请求，不受 CORS 限制，但非流式）。
// 通过动态 import @capacitor/core 检测是否在原生壳内，避免在非 Capacitor 环境报错。
let _capHttp: any = null;
let _capProbeDone = false;
async function getCapHttp(): Promise<any> {
  if (_capProbeDone) return _capHttp;
  _capProbeDone = true;
  try {
    const cap = await import('@capacitor/core');
    if (cap && cap.Capacitor && cap.Capacitor.isNativePlatform && cap.Capacitor.isNativePlatform()) {
      try {
        const mod = await import('@capacitor/http');
        _capHttp = mod;
      } catch {
        _capHttp = null;
      }
    }
  } catch {
    _capHttp = null;
  }
  return _capHttp;
}

// 标记：最近一次请求是否走了原生回退（供 UI 提示"已降级为非流式"）
export const capFallbackState = { used: false };

// 通用 POST（带 B 回退）。返回解析后的 JSON 与状态码。
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: any,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    capFallbackState.used = false;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    // CORS / 网络失败 → 回退原生 HTTP
    const capHttp = await getCapHttp();
    if (capHttp && capHttp.Http) {
      capFallbackState.used = true;
      const r = await capHttp.Http.post({
        url,
        headers,
        data: JSON.stringify(body),
      });
      return { ok: (r as any).status >= 200 && (r as any).status < 300, status: (r as any).status, text: (r as any).data || '' };
    }
    throw e;
  }
}

export async function queryAI(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens = 1024,
  parentSignal?: AbortSignal
): Promise<AIResult> {
  if (!cfg.apiKey && cfg.provider !== 'openai-compatible') {
    return {
      content: `（模型「${cfg.name}」未配置 API Key，请在设置-模型管理中填写）`,
      promptTokens: 0,
      completionTokens: 0,
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
    return {
      content: `（请求异常：${e?.message || String(e)}）`,
      promptTokens: 0,
      completionTokens: 0,
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
  const { ok, status, text } = await postJson(joinUrl(cfg.baseUrl, '/chat/completions'), h, {
    model: cfg.model,
    messages,
    max_tokens: maxTokens,
    temperature: cfg.temperature,
    stream: false,
  }, controller.signal);
  if (!ok) {
    return {
      content: `（API 请求失败 ${status}: ${text.slice(0, 300)}）`,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  const data = JSON.parse(text || '{}') as any;
  const msg = data?.choices?.[0]?.message ?? {};
  const rawContent: string = msg?.content ?? '';
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

// OpenAI 兼容接口流式调用（A 路径）；Anthropic 不走流式。
// 若 fetch 失败（CORS），回退到原生 HTTP（B 路径）：一次性拿整段，按字切片模拟流式，保证内容不丢。
export async function streamAI(
  cfg: ModelConfig,
  messages: AIMessage[],
  maxTokens: number,
  onChunk: (chunk: StreamChunk) => void,
  controller: AbortController
): Promise<AIResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;

  // 先尝试 fetch 流式（A）
  try {
    capFallbackState.used = false;
    const resp = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        temperature: cfg.temperature,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return {
        content: `（API 请求失败 ${resp.status}: ${errText.slice(0, 300)}）`,
        promptTokens: 0,
        completionTokens: 0,
      };
    }
    return await consumeSseStream(resp, onChunk, controller);
  } catch (e: any) {
    // CORS / "Failed to fetch" → 回退原生 HTTP（B）：整段返回后按字揭示
    const capHttp = await getCapHttp();
    if (capHttp && capHttp.Http) {
      capFallbackState.used = true;
      const r: any = await capHttp.Http.post({
        url: joinUrl(cfg.baseUrl, '/chat/completions'),
        headers: h,
        data: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: maxTokens,
          temperature: cfg.temperature,
          stream: false,
        }),
      });
      const data = JSON.parse((r.data as string) || '{}') as any;
      const msg = data?.choices?.[0]?.message ?? {};
      const rawContent: string = msg?.content ?? '';
      let reasoning: string = extractReasoning(msg);
      const split = splitThink(rawContent);
      if (split.reasoning) reasoning = reasoning ? `${reasoning}\n${split.reasoning}` : split.reasoning;
      const full = split.content;
      // 按句切片揭示，模拟流式
      const sentences = full.match(/[^。！？\n]*[。！？\n]?/g) || [full];
      let acc = '';
      for (const s of sentences) {
        if (controller.signal.aborted) break;
        acc += s;
        onChunk({ content: s, reasoning: '', done: false });
        await new Promise((res) => setTimeout(res, 12));
      }
      onChunk({ content: '', done: true });
      const usage = data?.usage ?? {};
      return {
        content: full,
        reasoning: reasoning || undefined,
        promptTokens: Number(usage.prompt_tokens) || 0,
        completionTokens: Number(usage.completion_tokens) || 0,
      };
    }
    return {
      content: `（请求异常：${e?.message || String(e)}）`,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
}

async function consumeSseStream(
  resp: Response,
  onChunk: (chunk: StreamChunk) => void,
  _controller: AbortController
): Promise<AIResult> {
  let rawFull = '';
  let sentContent = '';
  let sentThink = '';
  let fieldReasoning = '';
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
    if (cDelta || rDelta) {
      onChunk({ content: cDelta, reasoning: rDelta || undefined, done: false });
    }
  };

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
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

  flushParsed(true);
  onChunk({ content: '', done: true });
  const finalSplit = splitThink(rawFull);
  let reasoning = fieldReasoning;
  if (finalSplit.reasoning) {
    reasoning = reasoning ? `${reasoning}\n${finalSplit.reasoning}` : finalSplit.reasoning;
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
  try {
    const { ok, status, text } = await postJson(
      `${cfg.baseUrl}/messages`,
      {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: Math.min(cfg.temperature, 1),
        system,
        messages: turns,
      },
      controller.signal
    );
    if (!ok) {
      return { content: `（Anthropic 请求失败 ${status}: ${text.slice(0, 300)}）`, promptTokens: 0, completionTokens: 0 };
    }
    const data = JSON.parse(text || '{}') as any;
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const content = blocks.filter((b) => b?.type === 'text').map((b) => b?.text || '').join('');
    const reasoningBlocks = blocks.filter((b) => b?.type === 'thinking').map((b) => b?.thinking || '').join('\n');
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
  } catch (e: any) {
    return { content: `（Anthropic 请求异常：${e?.message || String(e)}）`, promptTokens: 0, completionTokens: 0 };
  }
}

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
    const { ok, status, text } = await postJson(url, headers, undefined, controller.signal);
    if (!ok) throw new Error(`列表请求失败 ${status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text || '{}') as any;
    let raw: any[] = [];
    if (Array.isArray(data?.data)) raw = data.data;
    else if (Array.isArray(data?.models)) raw = data.models;
    else if (Array.isArray(data)) raw = data;
    const ids = raw.map((m) => m?.id || m?.name || (typeof m === 'string' ? m : '')).filter(Boolean);
    return Array.from(new Set(ids));
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(cfg: ModelConfig): Promise<{ ok: boolean; message: string }> {
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

// 语音转文字（Web 版）：audio 为 Uint8Array（来自 MediaRecorder 录制）
export async function transcribeAudio(
  cfg: { baseUrl: string; apiKey: string },
  audio: Uint8Array,
  model: string,
  fileName = 'audio.webm'
): Promise<string> {
  if (!cfg.apiKey) throw new Error('ASR 模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const form = new FormData();
    const blob = new Blob([audio as unknown as BlobPart], { type: 'audio/webm' });
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

// 文本转语音（Web 版）：返回音频 ArrayBuffer（调用方自行创建 Blob URL 播放）
export async function textToSpeech(
  cfg: { baseUrl: string; apiKey: string },
  text: string,
  model: string,
  voice: string
): Promise<ArrayBuffer> {
  if (!cfg.apiKey) throw new Error('TTS 模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
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
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

// 图像生成（OpenAI 兼容 /images/generations）：返回 base64 或图片 URL
export async function generateImage(
  cfg: { baseUrl: string; apiKey: string },
  prompt: string,
  model: string,
  size: string
): Promise<{ b64?: string; url?: string }> {
  if (!cfg.apiKey) throw new Error('生图模型未配置 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, '/images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-image-1', prompt, n: 1, size: size || '1024x1024' }),
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
