import { useMemo, useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nContext';
import type { ChatMessage } from '../types';

// 消息查找：主窗与小窗共用的搜索条。
// 按内容子串过滤，列出命中结果并可逐条跳转（调用方传入 onJump 负责滚动定位）。
export function MessageSearch({
  messages,
  onJump,
  compact,
  onClose,
}: {
  messages: ChatMessage[];
  onJump: (msgId: number | string) => void;
  compact?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [] as ChatMessage[];
    return messages.filter((m) => (m.content || '').toLowerCase().includes(s));
  }, [q, messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setIdx(0);
  }, [q]);

  const total = matches.length;

  const go = (i: number) => {
    if (!total) return;
    const next = (i + total) % total;
    setIdx(next);
    onJump(matches[next].id);
  };

  const fmt = (ts?: string) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // 命中片段（截断 + 高亮）
  const snippet = (text: string) => {
    const s = q.trim();
    if (!s) return text.slice(0, 60);
    const lower = text.toLowerCase();
    const at = lower.indexOf(s.toLowerCase());
    if (at < 0) return text.slice(0, 60);
    const start = Math.max(0, at - 20);
    const end = Math.min(text.length, at + s.length + 40);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  };

  return (
    <div className={`msg-search${compact ? ' compact' : ''}`}>
      <div className="msg-search-bar">
        <span className="msg-search-icon">🔍</span>
        <input
          ref={inputRef}
          className="msg-search-input"
          placeholder={t('search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(idx + (e.shiftKey ? -1 : 1));
            if (e.key === 'Escape') onClose();
          }}
        />
        {total > 0 && (
          <span className="msg-search-count">
            {idx + 1}/{total}
          </span>
        )}
        <button className="msg-search-nav" disabled={!total} onClick={() => go(idx - 1)} title={t('search.prev')}>
          ↑
        </button>
        <button className="msg-search-nav" disabled={!total} onClick={() => go(idx + 1)} title={t('search.next')}>
          ↓
        </button>
        <button className="msg-search-close" onClick={onClose} title={t('search.close')}>
          ×
        </button>
      </div>
      {total > 0 && (
        <div className="msg-search-list">
          {matches.map((m, i) => (
            <div
              key={m.id}
              className={`msg-search-item${i === idx ? ' active' : ''}`}
              onClick={() => go(i)}
            >
              <div className="msg-search-meta">
                <span className="msg-search-sender">{m.sender_name || (m.sender_type === 'user' ? t('chat.me') : '')}</span>
                <span className="msg-search-time">{fmt(m.timestamp)}</span>
              </div>
              <div className="msg-search-snip">{snippet(m.content || '')}</div>
            </div>
          ))}
        </div>
      )}
      {q.trim() && total === 0 && <div className="msg-search-empty">{t('search.noResult')}</div>}
    </div>
  );
}
