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

  return (
    <div className="list-pane">
      <div className="list-header">
        <span>{t('chats.title')}</span>
        <button className="btn-add" title={t('chats.newGroup')} onClick={onNewGroup}>
          ＋
        </button>
      </div>
      <div className="list-scroll">
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
                {it.name} {it.member_count ? `(${it.member_count})` : ''}
              </div>
              <div className="preview">{it.last_message}</div>
            </div>
            <div className="time">{fmtTime(it.last_time)}</div>
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
