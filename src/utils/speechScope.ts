// 朗读范围：把消息文本按「对话 / 旁白 / 人物心理」切分，并按全局设置过滤出需要朗读的部分。
// 分类约定与渲染层 markdown.tsx 保持一致：
//   - 对话 dialogue：普通文本
//   - 旁白 narration：（）包裹（渲染为斜体灰字）
//   - 人物心理 psyche：「」包裹（渲染为斜体次要色）
export type SpeechKind = 'dialogue' | 'narration' | 'psyche';

export interface SpeechScopes {
  dialogue?: boolean;
  narration?: boolean;
  psyche?: boolean;
}

/** 把一段消息文本切成带类别标签的片段（与 markdown.tsx 的旁白/心理渲染共用同一正则约定） */
export function splitSpeechSegments(text: string): { text: string; kind: SpeechKind }[] {
  const re = /（[^（）]*）|「[^「」]*」|“[^”]*”|＂[^＂]*＂|"[^"]*"/g;
  const out: { text: string; kind: SpeechKind }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), kind: 'dialogue' });
    const kind: SpeechKind = m[0].startsWith('「') ? 'psyche' : 'narration';
    out.push({ text: m[0].slice(1, -1), kind });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'dialogue' });
  return out;
}

/**
 * 按朗读范围过滤文本：只保留勾选类别的内容，类别间用空格衔接保证朗读停顿自然。
 * scopes 缺省时视为「仅对话」（与设置默认一致）。
 */
export function filterSpeechText(text: string, scopes?: SpeechScopes): string {
  if (!text) return '';
  const s = {
    dialogue: scopes?.dialogue !== false,
    narration: !!scopes?.narration,
    psyche: !!scopes?.psyche,
  };
  const parts: string[] = [];
  for (const seg of splitSpeechSegments(text)) {
    const t = seg.text.trim();
    if (!t) continue;
    if (seg.kind === 'dialogue' && s.dialogue) parts.push(t);
    else if (seg.kind === 'narration' && s.narration) parts.push(t);
    else if (seg.kind === 'psyche' && s.psyche) parts.push(t);
  }
  return parts.join('　');
}
