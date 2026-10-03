import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { MemoryEntry, ChatListItem } from '../types';
import { useToast, ToastView } from './Toast';

// 记忆面板：展示并手动编辑某角色的记忆（AI 自动提炼的记忆也会出现在列表中，可手动修改/删除）
export const MemoryPanel: React.FC<{ roleId: string }> = ({ roleId }) => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const [mems, setMems] = useState<MemoryEntry[]>([]);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [draft, setDraft] = useState('');
  const [chatNames, setChatNames] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);

  const load = () => {
    api.listMemories(roleId).then(setMems);
    api
      .getChatList()
      .then((list: ChatListItem[]) => {
        const map: Record<string, string> = {};
        for (const c of list) map[c.chat_id] = c.chat_name || c.name;
        setChatNames(map);
      })
      .catch(() => {});
  };
  useEffect(() => {
    setEditing(null);
    setDraft('');
    setQ('');
    setIdx(0);
    load();
  }, [roleId]);

  const save = async () => {
    const c = draft.trim();
    if (!c) return;
    if (editing) {
      await api.updateMemory(editing.id, c);
    } else {
      await api.addMemory({ roleId, content: c, source: 'manual' });
    }
    showToast(t('toast.memorySaved'));
    setDraft('');
    setEditing(null);
    load();
  };

  const del = async (id: string) => {
    await api.deleteMemory(id);
    showToast(t('toast.memoryDeleted'));
    load();
  };

  const edit = (m: MemoryEntry) => {
    setEditing(m);
    setDraft(m.content);
  };

  // 搜索 haystack：拼接所有可检索字段（内容 / 聊天名 / 来源 / 原始 id / 时间），不区分大小写
  const searchableText = (m: MemoryEntry): string => {
    const parts: string[] = [m.content];
    if (m.chatId) {
      parts.push(chatNames[m.chatId] || m.chatId);
      parts.push(m.chatId);
    }
    parts.push(m.source === 'auto' ? t('library.auto') : t('library.manual'));
    if (m.created_at) parts.push(m.created_at);
    if (m.updated_at) parts.push(m.updated_at);
    return parts.join(' ');
  };

  const ql = q.trim().toLowerCase();
  const matches = useMemo(
    () => (ql ? mems.filter((m) => searchableText(m).toLowerCase().includes(ql)) : mems),
    [mems, ql, chatNames],
  );

  // 在命中项之间跳转：滚动定位 + 闪烁高亮 + 打开顶部编辑器，便于立即修改
  const go = (i: number) => {
    const total = matches.length;
    if (!total) return;
    const next = ((i % total) + total) % total;
    setIdx(next);
    const m = matches[next];
    const el = document.getElementById('mem-' + m.id);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('setting-flash');
      void el.offsetWidth;
      el.classList.add('setting-flash');
    }
    edit(m);
  };

  // 高亮命中子串：按查询词拆分成段，命中段用 <mark> 包裹
  const highlight = (text: string): React.ReactNode => {
    if (!ql) return text;
    const escaped = ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escaped + ')', 'ig');
    const segments = text.split(re);
    return segments.map((part, i) =>
      i % 2 === 1 ? (
        <mark className="search-hl" key={i}>
          {part}
        </mark>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    );
  };

  return (
    <div>
      <div className="field">
        <label>{editing ? t('library.editMemory') : t('library.addMemory')}</label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder={t('memory.empty')}
        />
      </div>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={save}>
          {t('memory.add')}
        </button>
        {editing && (
          <button
            className="btn-ghost"
            onClick={() => {
              setEditing(null);
              setDraft('');
            }}
          >
            {t('library.cancel')}
          </button>
        )}
      </div>
      {mems.length > 0 && (
        <div className="mem-search">
          <input
            className="lib-input"
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            placeholder={t('memory.searchPlaceholder')}
          />
          {ql && (
            <>
              <span className="mem-search-count">
                {matches.length ? `${idx + 1} / ${matches.length}` : '0 / 0'}
              </span>
              <span className="mem-search-nav">
                <button className="btn-ghost" onClick={() => go(idx - 1)} title={t('search.prev')}>
                  {t('search.prev')}
                </button>
                <button className="btn-ghost" onClick={() => go(idx + 1)} title={t('search.next')}>
                  {t('search.next')}
                </button>
              </span>
              <button
                className="btn-ghost"
                onClick={() => {
                  setQ('');
                  setIdx(0);
                }}
                aria-label="clear"
              >
                ✕
              </button>
            </>
          )}
        </div>
      )}
      {mems.length === 0 ? (
        <div className="empty-state">{t('memory.empty')}</div>
      ) : ql && matches.length === 0 ? (
        <div className="empty-state">{t('search.noResult')}</div>
      ) : (
        <div className="mem-list">
          {matches.map((m) => (
            <div className="mem-item" key={m.id} id={`mem-${m.id}`}>
              {m.image_path ? (
                <img
                  src={m.image_path}
                  alt={m.content || 'image memory'}
                  className="mem-image"
                  style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 6, display: 'block' }}
                />
              ) : null}
              <div className="mem-text">{highlight(m.content)}</div>
              <div className="mem-foot">
                <span className={`badge ${m.source === 'auto' ? 'auto' : 'manual'}`}>
                  {m.source === 'auto' ? t('library.auto') : t('library.manual')}
                </span>
                {m.chatId ? (
                  <span className="badge chat" title={m.chatId}>
                    {t('memory.chatSpecific', { name: chatNames[m.chatId] || m.chatId })}
                  </span>
                ) : (
                  <span className="badge shared">{t('memory.shared')}</span>
                )}
                <div>
                  <button className="btn-ghost" onClick={() => edit(m)}>
                    {t('memory.edit')}
                  </button>
                  <button className="btn-ghost" onClick={() => del(m.id)}>
                    {t('memory.delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <ToastView toast={toast} />
    </div>
  );
};
