/**
 * 念语 v3.0.22 日记视图（单一当前身份 · 无分册/无切换器 · 内联大输入框）。
 * 所有可见文案走 i18n（本文件无裸中文）；正文使用主题变量，适配 14 套主题。
 * 身份只读跟随设置；无身份时引导去设置创建。正文永远不在此处拼 prompt。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { api } from '../ipc';
import type { DiaryEntry, Role } from '../types';
import {
  DIARY_ERROR_NO_SELF_ROLE,
  resolveDiaryIdentity,
  type DiaryIdentity,
} from '../utils/diaryIdentity';
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

function emptyEditor(selfRoleId: string): EditorState {
  return {
    id: null,
    selfRoleId,
    date: new Date().toISOString().slice(0, 10),
    title: '',
    content: '',
    allowAi: false,
    visibleRoleIds: [],
  };
}

export const DiaryView: React.FC<{
  /** 无身份空状态入口：由 App 切到设置页身份分区并触发高亮。 */
  onGoToIdentitySettings?: () => void;
}> = ({ onGoToIdentitySettings }) => {
  const { t } = useI18n();
  const [identity, setIdentity] = useState<DiaryIdentity | null>(null);
  const identityRef = useRef<DiaryIdentity | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadEntries = useCallback(async (selfRoleId: string): Promise<void> => {
    try {
      const list = await api.diaryList(selfRoleId);
      setEntries(list || []);
    } catch (e) {
      setNotice(String(e));
    }
  }, []);

  /** 主进程抛带 code 的 Error；只在无效身份时映射为 i18n，其余沿用原字符串。 */
  const errorText = (e: unknown): string => {
    const code = (e as { code?: string } | null)?.code;
    return code === DIARY_ERROR_NO_SELF_ROLE ? t('diary.errInvalidIdentity') : String(e);
  };

  // 首次进入日记页：先做幂等兼容迁移，再解析当前身份并加载该身份的日记。
  useEffect(() => {
    let alive = true;
    const resolveSettings = async (): Promise<void> => {
      const settings = await api.getSettings();
      if (!alive) return;
      const next = resolveDiaryIdentity(settings);
      identityRef.current = next;
      setIdentity(next);
      setEditor(null);
      setQuery('');
      if (next) await loadEntries(next.id);
      else setEntries([]);
    };
    (async () => {
      try {
        const migrated = await api.diaryEnsureMigrated();
        if (!alive) return;
        if (migrated && migrated.migratedDiaries > 0) setNotice(t('diary.migratedHint'));
        const roleList = await api.getRoles();
        if (!alive) return;
        setRoles(roleList || []);
        await resolveSettings();
      } catch (e) {
        if (alive) setNotice(String(e));
      }
    })();

    // 设置里切换当前身份后回日记页即跟随；列表与编辑器绑定新身份，不回写设置。
    const offSettings = api.onSettingsChanged(() => { void resolveSettings(); });
    const offDiary = api.onDiaryChanged(() => {
      const id = identityRef.current?.id;
      if (id) void loadEntries(id);
    });
    return () => {
      alive = false;
      offSettings();
      offDiary();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEntries, t]);

  const currentId = identity?.id || '';

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
      setNotice(errorText(e));
    }
  };

  const remove = async (entry: DiaryEntry): Promise<void> => {
    // 项目铁律：禁止原生弹窗，统一走自绘确认框。
    if (!(await api.showConfirm!(t('diary.confirmDelete')))) return;
    try {
      await api.diaryDelete(entry.id);
      await loadEntries(currentId);
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
      await loadEntries(currentId);
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
      await loadEntries(currentId);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const deleteComment = async (entry: DiaryEntry, commentId: string): Promise<void> => {
    try {
      await api.diaryUpdate(entry.id, {
        aiComments: entry.aiComments.filter((c) => c.id !== commentId),
      });
      await loadEntries(currentId);
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

  const identityLabel = identity ? t('diary.currentIdentity', { name: identity.name }) : '';

  return (
    <div className="diary-panel">
      <div className="diary-toolbar">
        <h2 className="diary-heading">{t('diary.title')}</h2>
        <div className="diary-toolbar-right">
          {identityLabel && <span className="diary-identity">{identityLabel}</span>}
          {identity && (
            <button
              type="button"
              className="diary-primary"
              onClick={() => setEditor(emptyEditor(identity.id))}
            >
              + {t('diary.newEntry')}
            </button>
          )}
        </div>
      </div>

      <div className="diary-layout">
        <div className="diary-main">
          {notice && <div className="diary-hint">{notice}</div>}

          {!identity ? (
            <div className="diary-empty-state">
              <div className="diary-empty-icon" aria-hidden="true">📔</div>
              <div className="diary-empty-title">{t('diary.noIdentity')}</div>
              <div className="diary-hint">{t('diary.noIdentityHint')}</div>
              <button type="button" className="diary-primary" onClick={() => onGoToIdentitySettings?.()}>
                {t('diary.goCreateIdentity')}
              </button>
            </div>
          ) : (
            <>
              <div className="diary-search">
                <input
                  className="diary-input"
                  value={query}
                  placeholder={t('diary.searchPlaceholderCurrent')}
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
              <div className="diary-hint">{t('diary.identityHint')}</div>

              {editor && (
                <div className="diary-editor">
                  <div className="diary-editor-head">{t('diary.currentIdentity', { name: identity.name })}</div>
                  <div className="diary-field-row">
                    <div className="diary-field">
                      <label>{t('diary.date')}</label>
                      <input
                        className="diary-input"
                        type="date"
                        value={editor.date}
                        onChange={(e) => setEditor({ ...editor, date: e.target.value })}
                      />
                    </div>
                    <div className="diary-field">
                      <label>{t('diary.titleField')}</label>
                      <input
                        className="diary-input"
                        value={editor.title}
                        onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="diary-field diary-field--content">
                    <label>{t('diary.content')}</label>
                    <textarea
                      className="diary-input diary-content-input"
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

              {!editor && (
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
              )}
            </>
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
