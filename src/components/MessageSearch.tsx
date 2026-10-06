import { useMemo, useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nContext';
import type { ChatMessage } from '../types';
import { MAX_SUGGESTIONS, rankCandidates } from '../utils/fuzzySearch';

// 消息查找：主窗与小窗共用的搜索条。
// 需求 12：改走 fuzzySearch —— 模糊匹配 + 按关联程度排序（相关度高的排前面），
// 命中列表最多展示 MAX_SUGGESTIONS(5) 条，剩余通过列表滚动条查看；
// 上一条/下一条仍在**全部命中项**之间跳转（总数照常显示 `idx/total`），
// 因此「最多展示 5 个」不会让用户失去遍历全部结果的能力。
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

  // 全部命中项（按相关度降序）：排序真源，供跳转导航使用
  const allMatches = useMemo(() => rankCandidates(q, messages, (m) => ({ label: m.content || '' })), [
    q,
    messages,
  ]);
  // 列表只展示前 5 条（用户铁律：候选项最多 5 个），其余靠滚动条
  const matches = useMemo(
    () => allMatches.slice(0, MAX_SUGGESTIONS).map((r) => r.item),
    [allMatches]
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setIdx(0);
  }, [q]);

  const total = allMatches.length;

  const go = (i: number) => {
    if (!total) return;
    const next = (i + total) % total;
    setIdx(next);
    onJump(allMatches[next].item.id);
  };

  const fmt = (ts?: string) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // 命中片段（截断 + 高亮）：先用模糊查询的首个 token 定位，定位不到再退回首部
  const snippet = (text: string) => {
    const s = q.trim();
    if (!s) return text.slice(0, 60);
    const lower = text.toLowerCase();
    const needle = s.toLowerCase().split(/\s+/)[0] || s.toLowerCase();
    const at = lower.indexOf(needle);
    if (at < 0) return text.slice(0, 60);
    const start = Math.max(0, at - 20);
    const end = Math.min(text.length, at + needle.length + 40);
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
          {total > matches.length && (
            <div className="msg-search-more">{t('search.moreItems', { n: total - matches.length })}</div>
          )}
        </div>
      )}
      {q.trim() && total === 0 && <div className="msg-search-empty">{t('search.noResult')}</div>}
    </div>
  );
}