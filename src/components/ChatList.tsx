import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { ChatListItem } from '../types';

export const ChatList: React.FC<{
  selectedId: string | null;
  onSelect: (item: ChatListItem) => void;
  onNewGroup: () => void;
  onDelete: (item: ChatListItem) => void;
}> = ({ selectedId, onSelect, onNewGroup, onDelete }) => {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<ChatListItem[]>([]);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  const refresh = () => api.getChatList().then(setItems);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, []);

  const fmtTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const loc = lang === 'en' ? 'en-US' : 'zh-CN';
    if (sameDay) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' });
  };

  const handleCopy = async (it: ChatListItem) => {
    setMenuOpen(null);
    const res = await api.copyChat(it.chat_type, it.chat_id);
    refresh();
    void res;
  };

  const startRename = (it: ChatListItem) => {
    setMenuOpen(null);
    setRenaming(it.chat_id);
    setRenameVal(it.chat_name || it.name);
  };

  const commitRename = async (it: ChatListItem) => {
    const v = renameVal.trim();
    if (v) await api.renameChat(it.chat_type, it.chat_id, v);
    setRenaming(null);
    refresh();
  };

  return (
    <div className="list-pane">
      <div className="list-header">
        <span>{t('chats.title')}</span>
        <button className="btn-add" title={t('chats.newGroup')} onClick={onNewGroup}>
          ＋
        </button>
      </div>
      <div className="list-scroll" onClick={() => menuOpen && setMenuOpen(null)}>
        {items.length === 0 && (
          <div style={{ padding: 24, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            {t('chats.empty')}
          </div>
        )}
        {items.map((it) => (
          <div
            key={it.chat_type + it.chat_id}
            className={`list-item ${selectedId === it.chat_id ? 'active' : ''}`}
            onClick={() => onSelect(it)}
          >
            {renaming === it.chat_id ? (
              <input
                className="rename-input"
                autoFocus
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(it)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(it);
                  else if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <>
                <button
                  className="list-del"
                  title={t('chats.delete')}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await api.showConfirm!(t('chats.confirmDelete'))) onDelete(it);
                  }}
                >
                  🗑
                </button>
                <div className="avatar">
                  {it.avatar_path ? (
                    <AvatarImg path={it.avatar_path} />
                  ) : it.chat_type === 'group' ? (
                    '👥'
                  ) : (
                    '🤖'
                  )}
                </div>
                <div className="meta">
                  <div className="name">
                    {it.chat_name || it.name} {it.member_count ? `(${it.member_count})` : ''}
                  </div>
                  <div className="preview">{it.last_message}</div>
                </div>
                <div className="time">{fmtTime(it.last_time)}</div>
                <button
                  className="list-more"
                  title={t('chats.more')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(menuOpen === it.chat_id ? null : it.chat_id);
                  }}
                >
                  ⋯
                </button>
                {menuOpen === it.chat_id && (
                  <div className="list-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => handleCopy(it)}>{t('chats.copy')}</button>
                    <button onClick={() => startRename(it)}>{t('chats.rename')}</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export const AvatarImg: React.FC<{ path: string }> = ({ path }) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    api.getImage(path).then(setSrc);
  }, [path]);
  if (!src) return null;
  return <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
};
