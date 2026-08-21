import React, { useEffect, useState } from 'react';
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
      {mems.length === 0 ? (
        <div className="empty-state">{t('memory.empty')}</div>
      ) : (
        <div className="mem-list">
          {mems.map((m) => (
            <div className="mem-item" key={m.id}>
              {m.image_path ? (
                <img
                  src={m.image_path}
                  alt={m.content || 'image memory'}
                  className="mem-image"
                  style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 6, display: 'block' }}
                />
              ) : null}
              <div className="mem-text">{m.content}</div>
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
