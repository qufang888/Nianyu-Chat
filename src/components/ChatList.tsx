import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { localeOf } from '../i18n/translations';
import { useTheme } from '../theme/ThemeContext';
import type { AppSettings, ChatListItem } from '../types';
import { sortChats, togglePinnedChat, applyDragOrder, chatKeyOf } from '../utils/chatOrdering';
import {
  clampInactiveDays,
  moveChatOutOfInactive,
  moveChatToInactive,
  partitionByInactive,
} from '../utils/inactiveChats';
import { MAX_SUGGESTIONS } from '../utils/fuzzySearch';
import SearchSuggest from './SearchSuggest';
import { useRetract } from '../hooks/useRetract';
import { useToast, ToastView } from './Toast';
import { flashElement } from '../utils/flash';

export const ChatList: React.FC<{
  selectedId: string | null;
  onSelect: (item: ChatListItem) => void;
  onNewGroup: () => void;
  onDelete: (item: ChatListItem) => void;
  onToggleCollapse?: () => void;
}> = ({ selectedId, onSelect, onNewGroup, onDelete, onToggleCollapse }) => {
  const { t, lang } = useI18n();
  const { settings, reloadSettings } = useTheme();
  // 需求 11：「快捷设置为最喜爱人物」的结果提示
  const { toast, showToast } = useToast();
  const [items, setItems] = useState<ChatListItem[]>([]);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  // v2.3.90：关闭时先播缩入动画再卸载（此前为 setState(null) 直接消失，与弹出不对称）
  const listMenu = useRetract(menuOpen);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // 拖拽排序状态：dragKey=被拖动聊天，overKey=当前悬停目标（用于高亮指示）
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // ===== 需求 13：聊天名搜索（模糊 + 最多 5 候选 + 跳转高亮）=====
  const [searchQ, setSearchQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // ===== 需求 14：不常用聊天文件夹 =====
  const [folderOpen, setFolderOpen] = useState(false);

  const pinned = settings?.pinnedChats;
  const order = settings?.chatOrder;
  const manualInactive = settings?.inactiveChats;
  const inactiveDays = clampInactiveDays(settings?.inactiveChatDays);

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
  // 拆成「常用」与「不常用」两组（各自保持上面的排序结果）
  const { active: normalChats, inactive: inactiveChats } = useMemo(
    () => partitionByInactive(sorted, manualInactive, inactiveDays, pinned),
    [sorted, manualInactive, inactiveDays, pinned]
  );
  // 搜索候选取**全部**聊天（含不常用文件夹内的），保证「搜得到 = 点得到」
  const searchItems = useMemo(() => [...normalChats, ...inactiveChats], [normalChats, inactiveChats]);

  const fmtTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const loc = localeOf(lang);
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

  // ===== 需求 11：右键「快捷设置为最喜爱人物」=====
  // 统计页板块三（最突出位置）消费 settings.favoriteRoleId，这里是它的快捷入口。
  // 群聊没有唯一角色（成员多人），故只在单聊卡片上出现；复制出的单聊 chat_id 与 roleId 解绑，
  // 必须让主进程用 resolveSingleRoleId 解真实 roleId，前端不猜。
  const handleSetFavorite = async (it: ChatListItem) => {
    setMenuOpen(null);
    try {
      const roleId = await api.resolveChatRoleId(it.chat_type, it.chat_id);
      if (!roleId) {
        showToast(t('chats.favSetFailed'));
        return;
      }
      await api.saveSettings({
        favoriteRoleId: roleId,
        favoriteSetAt: Date.now(),
        // 换人时清掉上一位的性别/签名，避免把 A 的签名显示到 B 头上
        favoriteGender: undefined,
        favoriteSignature: '',
      } as Partial<AppSettings>);
      reloadSettings();
      showToast(t('chats.favSetDone', { name: it.chat_name || it.name }));
    } catch {
      showToast(t('chats.favSetFailed'));
    }
  };

  // ===== 需求 14：手动移入 / 移出不常用聊天文件夹 =====
  const handleMoveInactive = async (it: ChatListItem) => {
    setMenuOpen(null);
    const key = chatKeyOf(it);
    // 移入后置顶状态消失（moveChatToInactive 内部从 pinnedChats 删 key）
    const next = moveChatToInactive(key, manualInactive, pinned);
    await api.saveSettings(next);
    reloadSettings();
    refresh();
  };

  const handleMoveOutInactive = async (it: ChatListItem) => {
    setMenuOpen(null);
    const key = chatKeyOf(it);
    // 移出只删手动标记，不恢复置顶（需求明确：移出后不恢复）
    await api.saveSettings({ inactiveChats: moveChatOutOfInactive(key, manualInactive) });
    reloadSettings();
    refresh();
  };

  // 拖拽排序：把被拖动卡片插入目标卡片位置，保存完整显示顺序
  const handleDrop = async (targetKey: string) => {
    setOverKey(null);
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null);
      return;
    }
    // 参与排序的是「常用 + 不常用」的完整可见序列，避免拖拽后把另一组的相对顺序弄丢
    const visibleKeys = [...normalChats, ...inactiveChats].map(chatKeyOf);
    const next = applyDragOrder(visibleKeys, dragKey, targetKey);
    setDragKey(null);
    await api.saveSettings({ chatOrder: next });
    reloadSettings();
  };

  // ===== 需求 13：选中搜索候选 → 跳转 + 高亮闪动 =====
  // 目标若在不常用文件夹内且文件夹处于收起态，必须先展开，否则元素不在 DOM 里闪动无从谈起
  const pickFromSearch = (it: ChatListItem) => {
    const key = chatKeyOf(it);
    const inFolder = inactiveChats.some((c) => chatKeyOf(c) === key);
    if (inFolder) setFolderOpen(true);
    setSearchQ('');
    setSearchOpen(false);
    onSelect(it);
    window.setTimeout(() => {
      const el = document.getElementById(`chat-item-${key}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // v2.3.102 需求 4：统一走 flashElement（时长/去抖/清类都在工具里），删除本地重复的 FLASH_MS 常量
      flashElement(el);
    }, 120);
  };

  /** 单个聊天卡片（含右键/「⋯」菜单）。inFolder=true 时菜单里给的是「移出」。 */
  const renderChatItem = (it: ChatListItem, inFolder: boolean) => {
    const key = chatKeyOf(it);
    const pinnedHere = isPinned(key);
    return (
      <div
        key={key}
        id={`chat-item-${key}`}
        className={[
          'list-item',
          selectedId === it.chat_id ? 'active' : '',
          pinnedHere ? 'pinned' : '',
          dragKey === key ? 'dragging' : '',
          overKey === key && dragKey !== key ? 'drag-over' : '',
          inFolder ? 'in-inactive-folder' : '',
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
            {listMenu.shown === it.chat_id && (
              <div
                className={`list-menu${listMenu.leaving ? ' leaving' : ''}`}
                onClick={(e) => e.stopPropagation()}
              >
                <button onClick={() => handleTogglePin(it)}>
                  {pinnedHere ? t('chats.unpin') : t('chats.pin')}
                </button>
                <button onClick={() => handleCopy(it)}>{t('chats.copy')}</button>
                <button onClick={() => startRename(it)}>{t('chats.rename')}</button>
                {/* 需求 11：单聊卡片才提供「快捷设置为最喜爱人物」（群聊无唯一角色） */}
                {it.chat_type === 'single' && (
                  <button onClick={() => handleSetFavorite(it)}>{t('chats.setFavorite')}</button>
                )}
                {/* 需求 14：文件夹内给「移出」，文件夹外给「移入」 */}
                {inFolder ? (
                  <button onClick={() => handleMoveOutInactive(it)}>{t('chats.moveOutInactive')}</button>
                ) : (
                  <button onClick={() => handleMoveInactive(it)}>{t('chats.moveInInactive')}</button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
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
      {/* ===== 需求 13：聊天搜索框（模糊搜索 · 最多 5 候选 · 点击跳转并高亮闪动） ===== */}
      <div className="list-search-row">
        <span className="list-search-icon" aria-hidden>🔍</span>
        <input
          ref={searchRef}
          type="text"
          className="list-search-input"
          placeholder={t('chats.searchPlaceholder')}
          value={searchQ}
          aria-label={t('chats.searchPlaceholder')}
          onChange={(e) => {
            setSearchQ(e.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
        />
        {searchQ && (
          <button
            className="list-search-clear"
            title={t('common.clear')}
            aria-label={t('common.clear')}
            onClick={() => {
              setSearchQ('');
              searchRef.current?.focus();
            }}
          >
            ✕
          </button>
        )}
      </div>
      <SearchSuggest
        open={searchOpen}
        query={searchQ}
        items={searchItems}
        max={MAX_SUGGESTIONS}
        anchorRef={searchRef}
        emptyHint={t('chats.searchEmpty')}
        getText={(c) => ({
          label: c.chat_name || c.name || '',
          // 附加关键词：聊天 id + 「群聊/单聊」类型词（同档排序时降权，不喧宾夺主）
          keywords: [c.chat_id, c.chat_type === 'group' ? t('chats.groupKeyword') : t('chats.singleKeyword')],
        })}
        itemKey={(c) => chatKeyOf(c)}
        renderItem={(c, ctx) => {
          const label = c.chat_name || c.name || '';
          const inFolder = inactiveChats.some((x) => chatKeyOf(x) === chatKeyOf(c));
          return (
            <span className="list-search-rowline">
              <span className="list-search-name">
                {highlightName(label, ctx.query)}
              </span>
              {inFolder && (
                <span className="list-search-badge" title={t('chats.inactiveFolder')}>
                  {t('chats.inactiveBadge')}
                </span>
              )}
            </span>
          );
        }}
        onPick={pickFromSearch}
        onClose={() => setSearchOpen(false)}
      />
      <div className="list-scroll" onClick={() => menuOpen && setMenuOpen(null)}>
        {items.length === 0 && (
          <div style={{ padding: 24, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            {t('chats.empty')}
          </div>
        )}
        {normalChats.map((it) => renderChatItem(it, false))}
        {/* ===== 需求 14：不常用聊天文件夹（放最后，可折叠，显示数量） ===== */}
        {inactiveChats.length > 0 && (
          <>
            <div
              className={`inactive-folder-head${folderOpen ? ' open' : ''}`}
              role="button"
              tabIndex={0}
              aria-expanded={folderOpen}
              onClick={() => setFolderOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setFolderOpen((v) => !v);
                }
              }}
            >
              <span className="inactive-folder-caret" aria-hidden>
                {folderOpen ? '▾' : '▸'}
              </span>
              <span className="inactive-folder-name">{t('chats.inactiveFolder')}</span>
              <span className="inactive-folder-count">{inactiveChats.length}</span>
            </div>
            {folderOpen && inactiveChats.map((it) => renderChatItem(it, true))}
          </>
        )}
      </div>
      {/* 需求 11：「快捷设置为最喜爱人物」的站内提示 */}
      <ToastView toast={toast} />
    </div>
  );
};

/** 候选文本的关键词高亮（与 Settings 的 renderSearchHL 同一套 `<mark class="search-hl">` 样式） */
function highlightName(text: string, query: string): React.ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return text;
  const escaped = tokens.map((tk) => tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text.split(re).map((part, i) =>
    tokens.includes(part.toLowerCase()) ? (
      <mark key={i} className="search-hl">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export const AvatarImg: React.FC<{ path: string }> = ({ path }) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    api.getImage(path).then(setSrc);
  }, [path]);
  if (!src) return null;
  return <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
};