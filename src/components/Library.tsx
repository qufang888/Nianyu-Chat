import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { WorldBook, WorldBookEntry, Rule, Role, AppSettings, ChatListItem } from '../types';
import { useToast, ToastView } from './Toast';
import { MemoryPanel } from './MemoryPanel';
import SelectMenu from './SelectMenu';

// 世界书排序：按 settings.worldBookOrder（拖拽顺序）排，缺失的按原顺序追加在末尾
function sortWorldBooks(list: WorldBook[], order?: string[]): WorldBook[] {
  const idx = new Map<string, number>();
  (order || []).forEach((id, i) => idx.set(id, i));
  return list
    .map((wb, i) => ({ wb, i }))
    .sort((a, b) => {
      const oa = idx.has(a.wb.id) ? (idx.get(a.wb.id) as number) : Number.MAX_SAFE_INTEGER;
      const ob = idx.has(b.wb.id) ? (idx.get(b.wb.id) as number) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((x) => x.wb);
}

type Tab = 'worldbook' | 'rule' | 'memory' | 'plugin';

export const Library: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('worldbook');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 760, maxWidth: '94vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>📚 {t('library.title')}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body">
          <div className="tabs">
            <div
              className={`tab ${tab === 'worldbook' ? 'active' : ''}`}
              onClick={() => setTab('worldbook')}
            >
              {t('library.worldbook')}
            </div>
            <div className={`tab ${tab === 'rule' ? 'active' : ''}`} onClick={() => setTab('rule')}>
              {t('library.rule')}
            </div>
            <div
              className={`tab ${tab === 'memory' ? 'active' : ''}`}
              onClick={() => setTab('memory')}
            >
              {t('library.memory')}
            </div>
            <div
              className={`tab ${tab === 'plugin' ? 'active' : ''}`}
              onClick={() => setTab('plugin')}
            >
              {t('library.plugin')}
            </div>
          </div>
          {tab === 'worldbook' && <WorldBookTab />}
          {tab === 'rule' && <RuleTab />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'plugin' && <PluginTab />}
        </div>
      </div>
      <ToastView toast={toast} />
    </div>
  );
};

// ===================== 世界书 =====================
const WorldBookTab: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [list, setList] = useState<WorldBook[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [editing, setEditing] = useState<WorldBook | null>(null);
  // 拖拽排序状态
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 「应用到聊天」选择器
  const [pickerWb, setPickerWb] = useState<WorldBook | null>(null);
  const [chats, setChats] = useState<ChatListItem[]>([]);

  const load = async () => {
    const [wbs, s] = await Promise.all([api.listWorldBooks(), api.getSettings()]);
    setList(wbs);
    setSettings(s);
  };
  useEffect(() => {
    load();
  }, []);

  const onImport = async () => {
    const f = await api.pickTextFile([
      { name: 'World Book', extensions: ['json', 'txt', 'md', 'text'] },
    ]);
    if (!f) return;
    const name = f.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '导入的世界书';
    await api.importWorldBook(f.content, name);
    showToast(t('toast.worldbookImported'));
    load();
  };
  const onNew = () => {
    const now = new Date().toISOString();
    setEditing({
      id: crypto.randomUUID(),
      name: '',
      description: '',
      content: '',
      entries: [],
      created_at: now,
      updated_at: now,
    });
  };
  const onCopy = async (id: string) => {
    await api.copyWorldBook(id);
    showToast(t('toast.copied'));
    load();
  };
  const onDelete = async (id: string) => {
    await api.deleteWorldBook(id);
    showToast(t('toast.worldbookDeleted'));
    load();
  };
  const onSetDefault = async (id: string) => {
    await api.saveSettings({ defaultWorldBookId: id });
    showToast(t('toast.worldbookDefault'));
    load();
  };

  // ===== 拖拽排序：仅调整展示顺序（settings.worldBookOrder），不影响注入逻辑 =====
  const ordered = sortWorldBooks(list, settings?.worldBookOrder);
  const handleDrop = async (targetId: string) => {
    setOverId(null);
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const visible = ordered.map((w) => w.id);
    const arr = visible.filter((x) => x !== dragId);
    const ti = arr.indexOf(targetId);
    if (ti >= 0) arr.splice(ti, 0, dragId);
    setDragId(null);
    await api.saveSettings({ worldBookOrder: arr });
    load();
  };

  // ===== 应用到指定聊天：读写 settings.chatWorldBooks（优先级：聊天 > 角色 > 全局默认）=====
  const openPicker = async (wb: WorldBook) => {
    const cl = await api.getChatList();
    setChats(cl || []);
    setPickerWb(wb);
  };
  const chatAppliedCount = (wbId: string) =>
    Object.values(settings?.chatWorldBooks || {}).filter((v) => v === wbId).length;
  const toggleChatApply = async (wbId: string, chatType: string, chatId: string) => {
    const key = `${chatType}:${chatId}`;
    const cur = { ...(settings?.chatWorldBooks || {}) };
    if (cur[key] === wbId) delete cur[key];
    else cur[key] = wbId;
    setSettings((s) => (s ? { ...s, chatWorldBooks: cur } : s));
    await api.saveSettings({ chatWorldBooks: cur });
  };

  if (editing) {
    return (
      <WorldBookEditor wb={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    );
  }

  return (
    <>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={onNew}>
          + {t('library.new')}
        </button>
        <button className="btn-ghost" onClick={onImport}>
          📥 {t('library.importWorldbook')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginLeft: 'auto', alignSelf: 'center' }}>
          {t('library.dragHint')}
        </span>
      </div>
      {list.length === 0 ? (
        <div className="empty-state">{t('library.noWorldbook')}</div>
      ) : (
        <div className="lib-list">
          {ordered.map((wb) => {
            const applied = chatAppliedCount(wb.id);
            return (
            <div
              className={[
                'lib-item',
                dragId === wb.id ? 'dragging' : '',
                overId === wb.id && dragId !== wb.id ? 'drag-over' : '',
              ].join(' ')}
              key={wb.id}
              draggable
              onDragStart={(e) => {
                setDragId(wb.id);
                try {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', wb.id);
                } catch { /* 忽略 */ }
              }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragId && dragId !== wb.id) setOverId(wb.id);
              }}
              onDragLeave={() => setOverId((v) => (v === wb.id ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                void handleDrop(wb.id);
              }}
            >
              <div className="li-head">
                <div className="li-title">
                  {wb.name}
                  {settings?.defaultWorldBookId === wb.id && (
                    <span className="badge primary">{t('library.default')}</span>
                  )}
                  {applied > 0 && (
                    <span className="badge" style={{ background: 'var(--color-hover)', color: 'var(--color-primary)' }}>
                      {t('library.appliedCount', { n: applied })}
                    </span>
                  )}
                </div>
                <div className="muted">
                  {wb.entries.length ? `${wb.entries.length} ${t('library.entries')}` : ''}
                </div>
              </div>
              {wb.description && <div className="li-desc">{wb.description}</div>}
              <div className="li-actions">
                <button className="btn-ghost" onClick={() => setEditing(wb)}>
                  {t('library.edit')}
                </button>
                <button className="btn-ghost" onClick={() => openPicker(wb)}>
                  {t('library.applyToChats')}
                </button>
                <button className="btn-ghost" onClick={() => onCopy(wb.id)}>
                  {t('library.copy')}
                </button>
                <button className="btn-ghost" onClick={() => onSetDefault(wb.id)}>
                  {t('library.setDefault')}
                </button>
                <button className="btn-ghost" onClick={() => onDelete(wb.id)}>
                  {t('library.delete')}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* 应用到指定聊天：勾选即写入该聊天的世界书覆盖（chatWorldBooks），取消勾选即恢复继承 */}
      {pickerWb && (
        <div className="modal-mask" onClick={() => setPickerWb(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-head">
              <span>{t('library.pickChatsTitle', { name: pickerWb.name })}</span>
              <span className="modal-close" onClick={() => setPickerWb(null)}>×</span>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                {t('library.pickChatsDesc')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
                {chats.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', padding: '10px 4px' }}>
                    {t('library.noChats')}
                  </div>
                )}
                {chats.map((c) => {
                  const key = `${c.chat_type}:${c.chat_id}`;
                  const checked = (settings?.chatWorldBooks || {})[key] === pickerWb.id;
                  return (
                    <label
                      key={key}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 8, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChatApply(pickerWb.id, c.chat_type, c.chat_id)}
                      />
                      <span style={{ fontSize: 13 }}>
                        {c.chat_type === 'group' ? '👥' : '👤'} {c.chat_name || c.name}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="row-actions" style={{ marginTop: 10 }}>
                <button className="btn-primary" onClick={() => { setPickerWb(null); showToast(t('toast.worldbookSaved')); }}>
                  {t('common.done')}
                </button>
                <button className="btn-ghost" onClick={() => setPickerWb(null)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const WorldBookEditor: React.FC<{
  wb: WorldBook;
  onClose: () => void;
  onSaved: () => void;
}> = ({ wb, onClose, onSaved }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<WorldBook>({ ...wb });

  const setField = (k: keyof WorldBook, v: any) => setDraft((d) => ({ ...d, [k]: v }));
  const setEntry = (i: number, k: keyof WorldBookEntry, v: any) =>
    setDraft((d) => ({
      ...d,
      entries: d.entries.map((e, idx) => (idx === i ? { ...e, [k]: v } : e)),
    }));
  const addEntry = () =>
    setDraft((d) => ({
      ...d,
      entries: [...d.entries, { id: crypto.randomUUID(), key: '', content: '' }],
    }));
  const delEntry = (i: number) =>
    setDraft((d) => ({ ...d, entries: d.entries.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!draft.name.trim()) {
      showToast(t('library.nameRequired'), { error: true });
      return;
    }
    await api.saveWorldBook({ ...draft, name: draft.name.trim(), updated_at: new Date().toISOString() });
    showToast(t('toast.worldbookSaved'));
    onSaved();
  };

  return (
    <div>
      <div className="field">
        <label>{t('library.name')}</label>
        <input value={draft.name} onChange={(e) => setField('name', e.target.value)} />
      </div>
      <div className="field">
        <label>{t('library.description')}</label>
        <input value={draft.description || ''} onChange={(e) => setField('description', e.target.value)} />
      </div>
      <div className="field">
        <label>{t('library.content')}</label>
        <textarea value={draft.content} onChange={(e) => setField('content', e.target.value)} rows={6} />
      </div>
      <div className="field">
        <label>{t('library.entries')}</label>
        {draft.entries.map((e, i) => (
          <div className="entry-row" key={e.id}>
            <input
              placeholder={t('library.entryKey')}
              value={e.key}
              onChange={(ev) => setEntry(i, 'key', ev.target.value)}
            />
            <textarea
              placeholder={t('library.entryContent')}
              value={e.content}
              onChange={(ev) => setEntry(i, 'content', ev.target.value)}
              rows={2}
            />
            <button className="btn-ghost" onClick={() => delEntry(i)}>
              {t('library.delete')}
            </button>
          </div>
        ))}
        <button className="btn-ghost" onClick={addEntry}>
          + {t('library.addEntry')}
        </button>
      </div>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={save}>
          {t('library.save')}
        </button>
        <button className="btn-ghost" onClick={onClose}>
          {t('library.cancel')}
        </button>
      </div>
    </div>
  );
};

// ===================== 规则库 =====================
const RuleTab: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [list, setList] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);

  const load = async () => {
    const [rs, s] = await Promise.all([api.listRules(), api.getSettings()]);
    setList(rs);
    setSettings(s);
  };
  useEffect(() => {
    load();
  }, []);

  const onImport = async () => {
    const f = await api.pickTextFile([
      { name: 'Rule / Prompt pack', extensions: ['json', 'txt', 'md', 'text'] },
    ]);
    if (!f) return;
    const name = f.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '导入的规则';
    await api.importRule(f.content, name);
    showToast(t('toast.ruleImported'));
    load();
  };
  const onNew = () =>
    setEditing({
      id: crypto.randomUUID(),
      name: '',
      content: '',
      scope: 'character',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  const onCopy = async (id: string) => {
    await api.copyRule(id);
    showToast(t('toast.copied'));
    load();
  };
  const onDelete = async (id: string) => {
    await api.deleteRule(id);
    showToast(t('toast.ruleDeleted'));
    load();
  };
  const toggleShared = async (r: Rule) => {
    const cur = settings?.sharedRuleIds || [];
    const next = cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id];
    await api.saveSettings({ sharedRuleIds: next });
    load();
  };

  if (editing) {
    return (
      <RuleEditor rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    );
  }

  return (
    <>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={onNew}>
          + {t('library.new')}
        </button>
        <button className="btn-ghost" onClick={onImport}>
          📥 {t('library.importRule')}
        </button>
      </div>
      {list.length === 0 ? (
        <div className="empty-state">{t('library.noRule')}</div>
      ) : (
        <div className="lib-list">
          {list.map((r) => {
            const shared = (settings?.sharedRuleIds || []).includes(r.id);
            return (
              <div className="lib-item" key={r.id}>
                <div className="li-head">
                  <div className="li-title">
                    {r.name}
                    {shared && <span className="badge shared">{t('library.shared')}</span>}
                    {r.source === 'plugin' && <span className="badge plugin">{t('library.fromPlugin')}</span>}
                  </div>
                </div>
                {r.content && <div className="li-desc">{r.content}</div>}
                <div className="li-actions">
                  <button className="btn-ghost" onClick={() => setEditing(r)}>
                    {t('library.edit')}
                  </button>
                  <button className="btn-ghost" onClick={() => onCopy(r.id)}>
                    {t('library.copy')}
                  </button>
                  <button className="btn-ghost" onClick={() => toggleShared(r)}>
                    {t('library.setShared')}
                    {shared ? ' ✓' : ''}
                  </button>
                  <button className="btn-ghost" onClick={() => onDelete(r.id)}>
                    {t('library.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};

const RuleEditor: React.FC<{ rule: Rule; onClose: () => void; onSaved: () => void }> = ({
  rule,
  onClose,
  onSaved,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<Rule>({ ...rule });

  const save = async () => {
    if (!draft.name.trim()) {
      showToast(t('library.nameRequired'), { error: true });
      return;
    }
    const shared = (await api.getSettings()).sharedRuleIds || [];
    const nextShared = shared.includes(draft.id)
      ? shared
      : [...shared, draft.id];
    await api.saveRule({ ...draft, name: draft.name.trim(), updated_at: new Date().toISOString() });
    // 新建的规则默认加入共用规则
    if (!shared.includes(draft.id)) await api.saveSettings({ sharedRuleIds: nextShared });
    showToast(t('toast.ruleSaved'));
    onSaved();
  };

  return (
    <div>
      <div className="field">
        <label>{t('library.name')}</label>
        <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </div>
      <div className="field">
        <label>{t('library.content')}</label>
        <textarea
          value={draft.content}
          onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
          rows={6}
        />
      </div>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={save}>
          {t('library.save')}
        </button>
        <button className="btn-ghost" onClick={onClose}>
          {t('library.cancel')}
        </button>
      </div>
    </div>
  );
};

// ===================== 记忆 =====================
const MemoryTab: React.FC = () => {
  const { t } = useI18n();
  const [roles, setRoles] = useState<Role[]>([]);
  const [roleId, setRoleId] = useState<string>('');

  useEffect(() => {
    api.getRoles().then((rs) => {
      setRoles(rs);
      if (rs.length && !roleId) setRoleId(rs[0].id);
    });
  }, []);

  return (
    <div>
      <div className="field">
        <label>{t('library.selectRole')}</label>
        <SelectMenu
          value={roleId}
          onChange={(v) => setRoleId(v)}
          options={roles.map((r) => ({ value: r.id, label: r.name }))}
        />
      </div>
      {roleId ? <MemoryPanel roleId={roleId} /> : <div className="empty-state">{t('library.noMemory')}</div>}
    </div>
  );
};

// ===================== 插件导入 =====================
const PluginTab: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();

  const onImport = async () => {
    const f = await api.pickTextFile([
      { name: 'Plugin', extensions: ['json', 'txt', 'md', 'text', 'png', 'character'] },
    ]);
    if (!f) return;
    const name = f.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '插件';
    const res = await api.importPlugin(f.content, name);
    const msg =
      res.kind === 'worldbook'
        ? t('library.pluginResultWB', { name: res.name })
        : res.kind === 'rule'
          ? t('library.pluginResultRule', { name: res.name })
          : t('library.pluginResultRole', { name: res.name });
    showToast(msg);
  };

  return (
    <div>
      <p className="muted">{t('library.pluginHint')}</p>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={onImport}>
          📥 {t('library.pluginImport')}
        </button>
      </div>
    </div>
  );
};
