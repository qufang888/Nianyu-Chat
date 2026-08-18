import React from 'react';

// 轻量 Markdown 渲染：支持代码块、行内代码、粗体、换行
export interface RenderOptions {
  // 引用映射：序号 n -> 网页 URL；配合 onCite 将正文中的 [n] 渲染为可点击徽标
  citations?: Record<number, string>;
  // 点击引用徽标时的回调（通常拉起系统浏览器打开网页）
  onCite?: (url: string) => void;
}

export function renderMarkdown(text: string, options?: RenderOptions): React.ReactNode {
  if (!text) return null;
  const citations = options?.citations;
  const onCite = options?.onCite;
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
    blocks.push(<p key={key++} style={{ margin: '2px 0' }}>{inline(line, citations, onCite)}</p>);
    i++;
  }
  return <>{blocks}</>;
}

function inline(line: string, citations?: Record<number, string>, onCite?: (url: string) => void): React.ReactNode {
  // 先按旁白分隔（（）与 “”/"" 包裹）切分，再对普通片段做行内代码/粗体处理
  const segments = splitNarration(line);
  const parts: React.ReactNode[] = [];
  const keyRef = { k: 0 };
  for (const seg of segments) {
    if (seg.narration) {
      // 旁白（（）/「」/"" 内）里的 [n] 也解析为可点击引用，消除「有些不可点」的问题
      const inner = withCitations(seg.text, keyRef, citations, onCite);
      parts.push(
        <span key={keyRef.k++} className="narration">
          {inner}
        </span>
      );
    } else {
      const fmt = formatInline(seg.text, keyRef, citations, onCite);
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
function formatInline(line: string, keyRef: { k: number }, citations?: Record<number, string>, onCite?: (url: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) parts.push(...withCitations(line.slice(last, m.index), keyRef, citations, onCite));
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
  if (last < line.length) parts.push(...withCitations(line.slice(last), keyRef, citations, onCite));
  return parts;
}

// 将正文中的 [n] 渲染为可点击引用徽标（n 对应 citations 中的序号）；无对应 URL 时保留原样文本
function withCitations(text: string, keyRef: { k: number }, citations?: Record<number, string>, onCite?: (url: string) => void): React.ReactNode[] {
  if (!citations || !onCite) return [text];
  const parts: React.ReactNode[] = [];
  const regex = /\[(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (s: string) => { if (s) parts.push(s); };
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) pushText(text.slice(last, m.index));
    const n = parseInt(m[1], 10);
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
    } else {
      pushText('[' + n + ']');
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return parts;
}
