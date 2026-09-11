import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import type { ChatListItem } from '../types';
import { sortChats, togglePinnedChat, applyDragOrder, chatKeyOf } from '../utils/chatOrdering';

export const ChatList: React.FC<{
  selectedId: string | null;
  onSelect: (item: ChatListItem) => void;
  onNewGroup: () => void;
  onDelete: (item: ChatListItem) => void;
  onToggleCollapse?: () => void;
}> = ({ selectedId, onSelect, onNewGroup, onDelete, onToggleCollapse }) => {
  const { t, lang } = useI18n();
  const { settings, reloadSettings } = useTheme();
  const [items, setItems] = useState<ChatListItem[]>([]);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // 拖拽排序状态：dragKey=被拖动聊天，overKey=当前悬停目标（用于高亮指示）
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const pinned = settings?.pinnedChats;
  const order = settings?.chatOrder;

  const refresh = () => api.getChatList().then(setItems);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, []);

  // 置顶/手动顺序来自设置：设置变更（另一窗口/悬浮球拖动）后实时刷新
  useEffect(() => {
    const off = api.onSettingsChanged?.(() => reloadSettings());
    return off;
  }, [reloadSettings]);

  // 排序：置顶优先 → 手动拖动顺序 → 后端默认（最近活跃）
  const sorted = sortChats(items, pinned, order);

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

  const isPinned = (key: string) => (pinned || []).includes(key);

  // 置顶 / 取消置顶
  const handleTogglePin = async (it: ChatListItem) => {
    setMenuOpen(null);
    const key = chatKeyOf(it);
    const next = togglePinnedChat(pinned, key);
    await api.saveSettings({ pinnedChats: next });
    reloadSettings();
  };

  // 拖拽排序：把被拖动卡片插入目标卡片位置，保存完整显示顺序
  const handleDrop = async (targetKey: string) => {
    setOverKey(null);
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null);
      return;
    }
    const visibleKeys = sorted.map(chatKeyOf);
    const next = applyDragOrder(visibleKeys, dragKey, targetKey);
    setDragKey(null);
    await api.saveSettings({ chatOrder: next });
    reloadSettings();
  };

  return (
    <div className="list-pane">
      <div className="list-header">
        <button className="btn-collapse" title={t('chats.collapseSidebar')} onClick={onToggleCollapse}>
          «
        </button>
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
        {sorted.map((it) => {
          const key = chatKeyOf(it);
          const pinnedHere = isPinned(key);
          return (
          <div
            key={key}
            className={[
              'list-item',
              selectedId === it.chat_id ? 'active' : '',
              pinnedHere ? 'pinned' : '',
              dragKey === key ? 'dragging' : '',
              overKey === key && dragKey !== key ? 'drag-over' : '',
            ].join(' ')}
            onClick={() => onSelect(it)}
            onContextMenu={(e) => {
              // 右键聊天卡片：弹出与「⋯」一致的操作菜单（含置顶）
              e.preventDefault();
              setMenuOpen(menuOpen === it.chat_id ? null : it.chat_id);
            }}
            draggable={!renaming}
            onDragStart={(e) => {
              setDragKey(key);
              try {
                (e.target as HTMLElement).classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', key);
              } catch { /* 部分环境无 dataTransfer，忽略 */ }
            }}
            onDragEnd={(e) => {
              (e.target as HTMLElement).classList.remove('dragging');
              setDragKey(null);
              setOverKey(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragKey && dragKey !== key) setOverKey(key);
            }}
            onDragLeave={() => setOverKey((v) => (v === key ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              void handleDrop(key);
            }}
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
                {pinnedHere && (
                  <span className="list-pin" title={t('chats.unpin')}>
                    📌
                  </span>
                )}
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
                    <button onClick={() => handleTogglePin(it)}>
                      {pinnedHere ? t('chats.unpin') : t('chats.pin')}
                    </button>
                    <button onClick={() => handleCopy(it)}>{t('chats.copy')}</button>
                    <button onClick={() => startRename(it)}>{t('chats.rename')}</button>
                  </div>
                )}
              </>
            )}
          </div>
          );
        })}
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
