import React from 'react';

// 轻量 Markdown 渲染：支持代码块、行内代码、粗体、换行
export interface RenderOptions {
  // 引用映射：序号 n -> 网页 URL；配合 onCite 将正文中的 [n] 渲染为可点击徽标
  citations?: Record<number, string>;
  // 点击引用徽标时的回调（通常拉起系统浏览器打开网页）
  onCite?: (url: string) => void;
  // 点击「越界引用徽标」（模型标了编号但该编号没有对应搜索结果）时的回调，
  // 通常用于展开本条回复下方的联网搜索结果列表，让用户看到全部来源
  onCiteMiss?: () => void;
}

export function renderMarkdown(text: string, options?: RenderOptions): React.ReactNode {
  if (!text) return null;
  const citations = options?.citations;
  const onCite = options?.onCite;
  const onCiteMiss = options?.onCiteMiss;
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push(
        <pre
          key={key++}
          style={{
            background: 'var(--color-panel-alt)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: '10px 12px',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            maxWidth: '100%',
            fontSize: 13,
            margin: '4px 0',
          }}
        >
          <code>{code.join('\n')}</code>
          {lang ? <span style={{ opacity: 0.5, fontSize: 11 }}> · {lang}</span> : null}
        </pre>
      );
      continue;
    }
    // 普通段落（合并连续非空行）
    blocks.push(<p key={key++} style={{ margin: '2px 0' }}>{inline(line, citations, onCite, onCiteMiss)}</p>);
    i++;
  }
  return <>{blocks}</>;
}

function inline(line: string, citations?: Record<number, string>, onCite?: (url: string) => void, onCiteMiss?: () => void): React.ReactNode {
  // 先按旁白分隔（（）与 “”/"" 包裹）切分，再对普通片段做行内代码/粗体处理
  const segments = splitNarration(line);
  const parts: React.ReactNode[] = [];
  const keyRef = { k: 0 };
  for (const seg of segments) {
    if (seg.narration) {
      // 旁白（（）/「」/"" 内）里的 [n] 也解析为可点击引用，消除「有些不可点」的问题
      const inner = withCitations(seg.text, keyRef, citations, onCite, onCiteMiss);
      parts.push(
        <span key={keyRef.k++} className="narration">
          {inner}
        </span>
      );
    } else {
      const fmt = formatInline(seg.text, keyRef, citations, onCite, onCiteMiss);
      fmt.forEach((n) => parts.push(n));
    }
  }
  return parts;
}

// 旁白分隔：（）与 “”/"" 内的内容标记为旁白（斜体+灰字），定界符本身不显示
function splitNarration(text: string): { text: string; narration: boolean }[] {
  const re = /（[^（）]*）|“[^”]*”|＂[^＂]*＂|"[^"]*"/g;
  const out: { text: string; narration: boolean }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), narration: false });
    out.push({ text: m[0].slice(1, -1), narration: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), narration: false });
  return out;
}

// 处理行内代码与粗体，并将 [n] 引用透传给 withCitations
function formatInline(line: string, keyRef: { k: number }, citations?: Record<number, string>, onCite?: (url: string) => void, onCiteMiss?: () => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) parts.push(...withCitations(line.slice(last, m.index), keyRef, citations, onCite, onCiteMiss));
    const token = m[0];
    if (token.startsWith('`')) {
      parts.push(
        <code
          key={keyRef.k++}
          style={{
            background: 'var(--color-panel-alt)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else {
      parts.push(
        <strong key={keyRef.k++} style={{ fontWeight: 700 }}>
          {token.slice(2, -2)}
        </strong>
      );
    }
    last = m.index + token.length;
  }
  if (last < line.length) parts.push(...withCitations(line.slice(last), keyRef, citations, onCite, onCiteMiss));
  return parts;
}

// 全角数字转半角（０-９ -> 0-9），避免模型输出全角序号时解析失败
function toAsciiDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// 将正文中的引用序号渲染为可点击徽标（n 对应 citations 中的序号）。
// 兼容多种模型输出形态：[1]、【1】、［1］（全角括号/全角数字），以及并列标注
// [1][3]、[1,3]、[1，3]、[1、3]、[1 3]（拆成逐个徽标）——
// 此前仅匹配半角 [n]，模型混用全角/并列写法时其余序号会退化为不可点的灰色文本。
// 有对应 URL：点击打开网页；越界编号（citations 中不存在）：渲染为弱化徽标，
// 点击触发 onCiteMiss（展开本条回复的搜索结果列表）；完全无引用上下文时保留原样文本。
function withCitations(text: string, keyRef: { k: number }, citations?: Record<number, string>, onCite?: (url: string) => void, onCiteMiss?: () => void): React.ReactNode[] {
  if (!citations || !onCite) return [text];
  const parts: React.ReactNode[] = [];
  // 半角 [] / 全角 ［］【】 括住「纯数字（允许并列分隔符）」的组合
  const regex = /[\[［【]([0-9０-９]+(?:[\s,，、]+[0-9０-９]+)*)[\]］】]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (s: string) => { if (s) parts.push(s); };
  const pushBadge = (n: number) => {
    const url = citations[n];
    if (url) {
      parts.push(
        <span
          key={keyRef.k++}
          className="cite-badge"
          role="button"
          tabIndex={0}
          title={url}
          onClick={(e) => { e.stopPropagation(); onCite!(url); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCite!(url); } }}
        >[{n}]</span>
      );
    } else if (onCiteMiss) {
      // 越界编号：仍可点击（展开搜索结果列表），但视觉弱化
      parts.push(
        <span
          key={keyRef.k++}
          className="cite-badge cite-badge-miss"
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onCiteMiss(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCiteMiss(); } }}
        >[{n}]</span>
      );
    } else {
      pushText('[' + n + ']');
    }
  };
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) pushText(text.slice(last, m.index));
    const nums = toAsciiDigits(m[1]).split(/[\s,，、]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
    for (const n of nums) pushBadge(n);
    last = m.index + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return parts;
}
