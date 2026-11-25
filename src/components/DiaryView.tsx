/**
 * 念语 v3.0.18 分册日记视图。
 * 所有可见文案走 i18n（本文件无裸中文）；正文使用 --color-text，适配 14 套主题。
 * 日记正文永远不在此处拼 prompt —— AI 注入只在主进程按产物门控完成。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { api } from '../ipc';
import type { DiaryBook, DiaryEntry, Role, SelfRole } from '../types';
import { MAX_SUGGESTIONS, highlightParts, suggest } from '../utils/fuzzySearch';
import { flashElement } from '../utils/flash';

interface EditorState {
  id: string | null;
  selfRoleId: string;
  date: string;
  title: string;
  content: string;
  allowAi: boolean;
  visibleRoleIds: string[];
}

function emptyEditor(bookId: string): EditorState {
  return {
    id: null,
    selfRoleId: bookId,
    date: new Date().toISOString().slice(0, 10),
    title: '',
    content: '',
    allowAi: false,
    visibleRoleIds: [],
  };
}

export const DiaryView: React.FC = () => {
  const { t } = useI18n();
  const [books, setBooks] = useState<DiaryBook[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [currentBook, setCurrentBook] = useState<string>('none');
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [orphans, setOrphans] = useState<DiaryEntry[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [reassignTarget, setReassignTarget] = useState<string>('none');
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadEntries = useCallback(async (bookId: string) => {
    try {
      const [list, orphanList] = await Promise.all([api.diaryList(bookId), api.diaryListOrphans()]);
      setEntries(list || []);
      setOrphans(orphanList || []);
    } catch (e) {
      setNotice(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getSettings(), api.getRoles()])
      .then(([settings, roleList]) => {
        if (!alive) return;
        const selfRoles: SelfRole[] = settings.selfRoles || [];
        const all: DiaryBook[] = [
          ...selfRoles.map((r) => ({ id: r.id, name: r.name })),
          { id: 'none', name: t('diary.bookNone') },
        ];
        setBooks(all);
        setRoles(roleList || []);
        const book = selfRoles.some((r) => r.id === settings.currentSelfRoleId)
          ? (settings.currentSelfRoleId as string)
          : 'none';
        setCurrentBook(book);
        void loadEntries(book);
      })
      .catch((e) => setNotice(String(e)));
    const off = api.onDiaryChanged(() => { void loadEntries(currentBook); });
    return () => { alive = false; off(); };
  }, [loadEntries, currentBook, t]);

  const switchBook = (id: string): void => {
    setCurrentBook(id);
    setEditor(null);
    setQuery('');
    void loadEntries(id);
  };

  const save = async (): Promise<void> => {
    if (!editor) return;
    try {
      let entry: DiaryEntry;
      if (editor.id) {
        entry = await api.diaryUpdate(editor.id, {
          date: editor.date,
          title: editor.title,
          content: editor.content,
          allowAi: editor.allowAi,
          visibleRoleIds: editor.visibleRoleIds,
        });
      } else {
        entry = await api.diaryCreate({
          selfRoleId: editor.selfRoleId,
          date: editor.date,
          title: editor.title,
          content: editor.content,
        });
        if (editor.allowAi || editor.visibleRoleIds.length > 0) {
          entry = await api.diaryUpdate(entry.id, {
            allowAi: editor.allowAi,
            visibleRoleIds: editor.visibleRoleIds,
          });
        }
      }
      setEditor(null);
      setNotice('');
      await loadEntries(entry.selfRoleId);
      if (entry.allowAi && entry.visibleRoleIds.length === 0) {
        setNotice(t('diary.allowAiHintFirst'));
      }
    } catch (e) {
      setNotice(String(e));
    }
  };

  const remove = async (entry: DiaryEntry): Promise<void> => {
    // 项目铁律：禁止原生弹窗，统一走自绘确认框（Settings.tsx 既有写法）。
    if (!(await api.showConfirm!(t('diary.confirmDelete')))) return;
    try {
      await api.diaryDelete(entry.id);
      await loadEntries(currentBook);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const toggleRole = (roleId: string): void => {
    setEditor((prev) => {
      if (!prev) return prev;
      const has = prev.visibleRoleIds.includes(roleId);
      const next = has
        ? prev.visibleRoleIds.filter((r) => r !== roleId)
        : [...prev.visibleRoleIds, roleId];
      return { ...prev, visibleRoleIds: next };
    });
  };

  const regenerate = async (entry: DiaryEntry): Promise<void> => {
    try {
      const res = await api.diaryRegenerateComments(entry.id);
      setNotice(
        res.generatedRoleIds.length > 0
          ? t('diary.aiDone').replace('{roles}', res.generatedRoleIds.join(', '))
          : t(res.reason ? `diary.reason.${res.reason}` : 'diary.aiSkipped').replace('{roles}', res.skippedRoleIds.join(', '))
      );
      await loadEntries(currentBook);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const summarize = async (entry: DiaryEntry): Promise<void> => {
    try {
      const res = await api.diarySummarize(entry.id);
      setNotice(
        res.generatedRoleIds.length > 0
          ? t('diary.aiDone').replace('{roles}', res.generatedRoleIds.join(', '))
          : t(res.reason ? `diary.reason.${res.reason}` : 'diary.aiSkipped').replace('{roles}', res.skippedRoleIds.join(', '))
      );
      await loadEntries(currentBook);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const deleteComment = async (entry: DiaryEntry, commentId: string): Promise<void> => {
    try {
      await api.diaryUpdate(entry.id, {
        aiComments: entry.aiComments.filter((c) => c.id !== commentId),
      });
      await loadEntries(currentBook);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const suggestions = useMemo(
    () => suggest(query, entries, (e) => ({
      label: `${e.date} ${e.title || ''} ${e.content}`.trim(),
      keywords: [e.date, e.title || ''],
    }), MAX_SUGGESTIONS),
    [query, entries]
  );

  const jumpTo = (entry: DiaryEntry): void => {
    setQuery('');
    window.setTimeout(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-diary-id="${entry.id}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        flashElement(el, 'setting-flash');
      }
    }, 30);
  };

  return (
    <div className="diary-panel">
      <div className="diary-toolbar">
        <h2 className="diary-heading">{t('diary.title')}</h2>
        <button
          type="button"
          className="diary-primary"
          onClick={() => setEditor(emptyEditor(currentBook))}
        >
          + {t('diary.newEntry')}
        </button>
      </div>

      <div className="diary-layout">
        <aside className="diary-books">
          <div className="diary-section-title">{t('diary.books')}</div>
          {books.map((b) => (
            <button
              type="button"
              key={b.id}
              className={`diary-book ${currentBook === b.id ? 'active' : ''}`}
              onClick={() => switchBook(b.id)}
            >
              {b.name}
            </button>
          ))}
        </aside>

        <div className="diary-main">
          <div className="diary-search">
            <input
              value={query}
              placeholder={t('diary.searchPlaceholder')}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() && suggestions.length > 0 && (
              <div className="diary-suggest">
                {suggestions.map((s) => (
                  <button type="button" key={s.id} onClick={() => jumpTo(s)}>
                    {highlightParts(`${s.date} ${s.title || ''}`, query).map((p, i) =>
                      p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {notice && <div className="diary-hint">{notice}</div>}

          {editor && (
            <div className="diary-editor">
              <div className="diary-field">
                <label>{t('diary.date')}</label>
                <input type="date" value={editor.date} onChange={(e) => setEditor({ ...editor, date: e.target.value })} />
              </div>
              <div className="diary-field">
                <label>{t('diary.titleField')}</label>
                <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
              </div>
              <div className="diary-field">
                <label>{t('diary.content')}</label>
                <textarea
                  rows={10}
                  value={editor.content}
                  onChange={(e) => setEditor({ ...editor, content: e.target.value })}
                />
              </div>
              <label className="diary-check">
                <input
                  type="checkbox"
                  checked={editor.allowAi}
                  onChange={(e) => setEditor({
                    ...editor,
                    allowAi: e.target.checked,
                    visibleRoleIds: e.target.checked ? editor.visibleRoleIds : [],
                  })}
                />
                <span>{t('diary.allowAi')}</span>
              </label>
              <div className="diary-hint">{t('diary.allowAiHint')}</div>
              <fieldset className="diary-role-pick" disabled={!editor.allowAi}>
                <legend>{t('diary.visibleRoles')}</legend>
                {!editor.allowAi && <div className="diary-hint">{t('diary.visibleRolesHint')}</div>}
                {editor.allowAi && (
                  <>
                    <div className="diary-bulk">
                      <button type="button" onClick={() => setEditor({ ...editor, visibleRoleIds: roles.map((r) => r.id) })}>
                        {t('diary.selectAll')}
                      </button>
                      <button type="button" onClick={() => setEditor({ ...editor, visibleRoleIds: [] })}>
                        {t('diary.clearAll')}
                      </button>
                    </div>
                    {roles.length === 0 && <div className="diary-hint">{t('diary.noRoles')}</div>}
                    {roles.map((r) => (
                      <label key={r.id} className="diary-check">
                        <input
                          type="checkbox"
                          checked={editor.visibleRoleIds.includes(r.id)}
                          onChange={() => toggleRole(r.id)}
                        />
                        <span>{r.name}</span>
                      </label>
                    ))}
                  </>
                )}
              </fieldset>
              <div className="diary-actions">
                <button type="button" className="diary-primary" onClick={() => void save()}>{t('diary.save')}</button>
                <button type="button" onClick={() => setEditor(null)}>{t('diary.cancel')}</button>
              </div>
            </div>
          )}

          <div className="diary-entries" ref={listRef}>
            {entries.length === 0 && <div className="diary-empty">{t('diary.noEntries')}</div>}
            {entries.map((entry) => (
              <article className="diary-card" key={entry.id} data-diary-id={entry.id}>
                <div className="diary-card-head">
                  <div>
                    <div className="diary-date">{entry.date}</div>
                    <h3>{entry.title || entry.date}</h3>
                  </div>
                  <div className="diary-card-actions">
                    {!entry.allowAi && <span className="diary-badge">🔒 {t('diary.localOnly')}</span>}
                    <button type="button" onClick={() => setEditor({
                      id: entry.id,
                      selfRoleId: entry.selfRoleId,
                      date: entry.date,
                      title: entry.title || '',
                      content: entry.content,
                      allowAi: entry.allowAi,
                      visibleRoleIds: [...entry.visibleRoleIds],
                    })}>{t('diary.edit')}</button>
                    <button type="button" onClick={() => void remove(entry)}>{t('diary.delete')}</button>
                  </div>
                </div>
                <div className="diary-content">{entry.content}</div>
                {entry.allowAi && (
                  <>
                    <div className="diary-actions">
                      <button type="button" onClick={() => void regenerate(entry)}>{t('diary.regenerateComments')}</button>
                      <button type="button" onClick={() => void summarize(entry)}>{t('diary.summarize')}</button>
                    </div>
                    <div className="diary-section-title">{t('diary.comments')}</div>
                    {entry.aiComments.filter((c) => !c.revoked).length === 0 && (
                      <div className="diary-hint">{t('diary.noComments')}</div>
                    )}
                    {entry.aiComments.filter((c) => !c.revoked).map((c) => (
                      <div className="diary-comment" key={c.id}>
                        <div className="diary-meta">
                          <span>{roles.find((r) => r.id === c.roleId)?.name || c.roleId}</span>
                          <span>{t(`diary.tone.${c.tone}`)}</span>
                          <span>{t('diary.commentMeta').replace('{mood}', c.moodAt).replace('{affinity}', String(c.affinityAt))}</span>
                        </div>
                        <div className="diary-text">{c.text}</div>
                        <button type="button" onClick={() => void deleteComment(entry, c.id)}>{t('diary.deleteComment')}</button>
                      </div>
                    ))}
                    <div className="diary-section-title">{t('diary.summaries')}</div>
                    {entry.visibleRoleIds.length === 0 && <div className="diary-hint">{t('diary.noVisible')}</div>}
                    {entry.visibleRoleIds.map((rid) => (
                      <DiarySummaryLine key={rid} diary={entry} roleId={rid} roles={roles} />
                    ))}
                  </>
                )}
              </article>
            ))}
          </div>

          {orphans.length > 0 && (
            <div className="diary-orphans">
              <div className="diary-section-title">{t('diary.orphans')}</div>
              <div className="diary-hint">{t('diary.orphanHint')}</div>
              {orphans.map((o) => (
                <div className="diary-orphan-row" key={o.id}>
                  <span>{o.title || o.date}</span>
                  <select value={reassignTarget} onChange={(e) => setReassignTarget(e.target.value)}>
                    {books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <button type="button" onClick={() => {
                    void api.diaryReassignOrphans(o.selfRoleId, reassignTarget).then(() => loadEntries(currentBook));
                  }}>{t('diary.reassignOrphans')}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** 摘要区按角色渲染：只显示当前仍可见角色的、未撤销且游标匹配的摘要。 */
const DiarySummaryLine: React.FC<{
  diary: DiaryEntry;
  roleId: string;
  roles: Role[];
}> = ({ diary, roleId, roles }) => {
  const raw = ((diary as DiaryEntry & { diary_summaries?: Array<{
    diaryId: string; roleId: string; text: string; revoked: boolean;
    selfRoleId: string; sourceUpdatedAt: string; visibleRoleIdsSnapshot: string[];
  }> }).diary_summaries) || [];
  const texts = raw
    .filter((s) => s.diaryId === diary.id && s.roleId === roleId && !s.revoked &&
      s.selfRoleId === diary.selfRoleId && s.sourceUpdatedAt === diary.updated_at &&
      s.visibleRoleIdsSnapshot.every((r) => diary.visibleRoleIds.includes(r)))
    .map((s) => s.text);
  if (texts.length === 0) return null;
  return (
    <div className="diary-summary">
      <div className="diary-meta">{roles.find((r) => r.id === roleId)?.name || roleId}</div>
      {texts.map((text, i) => <div className="diary-text" key={i}>{text}</div>)}
    </div>
  );
};
