import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import type { MemoryEntry, ChatListItem } from '../types';
import { useToast, ToastView } from './Toast';
import { rankCandidates } from '../utils/fuzzySearch';
import { flashElement } from '../utils/flash';

// 记忆面板：展示并手动编辑某角色的记忆（AI 自动提炼的记忆也会出现在列表中，可手动修改/删除）
export const MemoryPanel: React.FC<{ roleId: string }> = ({ roleId }) => {
  const { t, lang } = useI18n();
  const { settings } = useTheme();
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

  // 把时间戳格式化为本地 YYYY-MM-DD：显示与检索统一用这一格式，做到「所见即所搜」，
  // 这样按时间命中时日期本身也能被 highlight() 正确包裹。
  const fmtDay = (s?: string): string => {
    if (!s) return '';
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    return s.slice(0, 10);
  };

  // 搜索 haystack：拼接所有可检索字段（内容 / 聊天名 / 来源 / 原始 id / 日期），不区分大小写
  const searchableText = (m: MemoryEntry): string => {
    const parts: string[] = [m.content];
    if (m.chatId) {
      parts.push(chatNames[m.chatId] || m.chatId);
      parts.push(m.chatId);
    }
    parts.push(m.source === 'auto' ? t('library.auto') : t('library.manual'));
    if (m.created_at) parts.push(fmtDay(m.created_at));
    if (m.updated_at) parts.push(fmtDay(m.updated_at));
    return parts.join(' ');
  };

  // 需求 12：记忆搜索改走 fuzzySearch —— 模糊匹配 + 按关联程度排序（相关度高的排前面）。
  // 记忆列表本身是「结果区」而非候选项下拉，故不截断到 5 条（否则用户会以为只有 5 条记忆命中）；
  // 真正受「最多 5 个」铁律约束的是候选面板，见 components/SearchSuggest.tsx。
  const ql = q.trim();
  const matches = useMemo(
    () => (ql ? rankCandidates(ql, mems, (m) => ({ label: searchableText(m) })).map((r) => r.item) : mems),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mems, ql, chatNames, lang]
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
      // v2.3.102 需求 4：统一走 flashElement —— 旧实现在此只 add 类、且完全没有移除定时器，
      // 导致类永久残留，第二次跳到同一项不会再闪。flashElement 内含去抖 + 5000ms 后清类。
      flashElement(el);
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
      {/* v2.3.94 需求 6：记忆为空时**说清原因**，而不是只丢一句「暂无记忆」。
        背景（已实测用户真实数据坐实）：自动记忆是三重门控 ——
          ① 全局 settings.enableAutoMemory（出厂默认 false）
          ② per-chat settings.longMemory[key]（每聊天独立，默认全关，且入口藏在聊天「⋯」菜单里）
          ③ 每累计 10 轮用户消息才提炼一次
        任一不满足就静默返回 0，界面毫无提示 —— 用户只能看到「暂无记忆」，完全无从下手。
        这里把当前真实状态读出来告诉用户，并给出可点击的操作指引。 */}
      {mems.length === 0 && settings?.memoryVisibilityNotice !== false && (() => {
        const onChats = Object.values(settings?.longMemory || {}).filter(Boolean).length;
        const autoOn = settings?.enableAutoMemory === true;
        const reasons: string[] = [];
        if (!autoOn) reasons.push(t('memory.why.autoOff'));
        if (onChats === 0) reasons.push(t('memory.why.longOffAll'));
        else reasons.push(t('memory.why.longOnSome', { n: onChats }));
        if (autoOn && onChats > 0) reasons.push(t('memory.why.needRounds'));
        return (
          <div
            className="memory-why"
            style={{
              padding: 10,
              marginBottom: 10,
              fontSize: 12,
              lineHeight: 1.7,
              color: 'var(--color-text-secondary)',
              background: 'var(--color-panel-alt)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
            }}
          >
            <div style={{ color: 'var(--color-text)', fontWeight: 600, marginBottom: 4 }}>
              {t('memory.whyTitle')}
            </div>
            <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div>{t('memory.whyHowto')}</div>
          </div>
        );
      })()}

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
                  {highlight(m.source === 'auto' ? t('library.auto') : t('library.manual'))}
                </span>
                {m.chatId ? (
                  <span className="badge chat" title={m.chatId}>
                    {highlight(t('memory.chatSpecific', { name: chatNames[m.chatId] || m.chatId }))}
                  </span>
                ) : (
                  <span className="badge shared">{highlight(t('memory.shared'))}</span>
                )}
                {fmtDay(m.created_at) ? (
                  <span className="mem-date">{highlight(fmtDay(m.created_at))}</span>
                ) : null}
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
