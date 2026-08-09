import React from 'react';

// 轻量 Markdown 渲染：支持代码块、行内代码、粗体、换行
export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
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
    blocks.push(<p key={key++} style={{ margin: '2px 0' }}>{inline(line)}</p>);
    i++;
  }
  return <>{blocks}</>;
}

function inline(line: string): React.ReactNode {
  // 先按旁白分隔（（）与 “”/"" 包裹）切分，再对普通片段做行内代码/粗体处理
  const segments = splitNarration(line);
  const parts: React.ReactNode[] = [];
  let k = 0;
  for (const seg of segments) {
    if (seg.narration) {
      parts.push(
        <span key={k++} className="narration">
          {seg.text}
        </span>
      );
    } else {
      const fmt = formatInline(seg.text, k);
      fmt.forEach((n) => parts.push(n));
      k += fmt.length;
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

// 处理行内代码与粗体
function formatInline(line: string, kStart: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = kStart;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      parts.push(
        <code
          key={k++}
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
        <strong key={k++} style={{ fontWeight: 700 }}>
          {token.slice(2, -2)}
        </strong>
      );
    }
    last = m.index + token.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}
