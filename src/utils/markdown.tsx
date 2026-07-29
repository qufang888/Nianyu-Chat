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
  // 处理行内代码与粗体
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
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
