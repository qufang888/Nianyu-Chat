/**
 * 念语 v3.0.23 日记视图（页内身份切换 · 无分册 · 内联大输入框）。
 * 所有可见文案走 i18n（本文件无裸中文）；正文使用主题变量，适配 14 套主题。
 * 身份默认跟随设置；可在页内临时切到任一自我身份（会话内有效，不写设置），
 * 切换即清草稿，防止串册。无身份时引导去设置创建。正文永远不在此处拼 prompt。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { api } from '../ipc';
import type { DiaryComment, DiaryEntry, Role } from '../types';
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
  // v3.0.23：页内身份选择器（Q1 非持久化）——组件 state/refs，绝不写回 settings。
  type PickerMode = 'current' | 'specific';
  const [pickerMode, setPickerMode] = useState<PickerMode>('current');
  const [specificRoleId, setSpecificRoleId] = useState<string | null>(null);
  const [selfRoles, setSelfRoles] = useState<Array<{ id: string; name: string }>>([]);
  const pickerModeRef = useRef<PickerMode>('current');
  const specificRoleIdRef = useRef<string | null>(null);
  const effectiveRoleIdRef = useRef<string>('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const listRef = useRef<HTMLDivElement | null>(null);
  // v3.0.24：回复串的每帖独立草稿 / 生成中 / 失败态（失败不清草稿，可点重试）。
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyBusy, setReplyBusy] = useState<Record<string, boolean>>({});
  const [replyErrors, setReplyErrors] = useState<Record<string, string>>({});

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
      // 只读解析：resolveDiaryIdentity 绝不回写设置；下拉数据源是自我身份而非全部角色卡。
      const next = resolveDiaryIdentity(settings);
      const nextSelfRoles = (settings.selfRoles || []).map((r) => ({ id: r.id, name: r.name }));
      identityRef.current = next;
      setIdentity(next);
      setSelfRoles(nextSelfRoles);
      // specific 模式下所选身份仍存在 → 保持列表与草稿，只刷新第一项标签/选项。
      if (pickerModeRef.current === 'specific') {
        const sid = specificRoleIdRef.current;
        if (sid && nextSelfRoles.some((r) => r.id === sid)) return;
        pickerModeRef.current = 'current';
        specificRoleIdRef.current = null;
        setPickerMode('current');
        setSpecificRoleId(null);
      }
      // current 跟随新设置身份 / specific 身份被删回落：按 Q2 清草稿。
      setEditor(null);
      setQuery('');
      const eid = next?.id ?? '';
      effectiveRoleIdRef.current = eid;
      if (eid) await loadEntries(eid);
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
      // v3.0.23：留言/摘要变更刷新的是当前所选身份（specific 模式下不是设置里的当前身份）。
      const id = effectiveRoleIdRef.current;
      if (id) void loadEntries(id);
    });
    // v3.0.24：通知卡片点击日记 → 置前主窗并跳到该篇（不误当聊天打开）。
    const offOpen = api.onDiaryOpen(({ diaryId }) => {
      setQuery('');
      window.setTimeout(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-diary-id="${diaryId}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center' });
          flashElement(el, 'setting-flash');
        }
      }, 60);
    });
    return () => {
      alive = false;
      offSettings();
      offDiary();
      offOpen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEntries, t]);

  // 派生有效身份：current 跟随设置解析结果；specific 只在本次会话内覆盖。
  const effectiveRoleId =
    pickerMode === 'current' ? (identity?.id ?? '') : (specificRoleId ?? identity?.id ?? '');

  /** 页内切换身份：真正换人时清草稿（Q2），列表/新建/刷新全部绑定新 effective。 */
  const handleIdentityChange = (value: string): void => {
    const nextMode: PickerMode = value === 'current' ? 'current' : 'specific';
    const nextSpecificId = value === 'current' ? null : value;
    const nextEffective = value === 'current' ? (identity?.id ?? '') : value;
    const switched = (effectiveRoleIdRef.current || '') !== nextEffective;
    pickerModeRef.current = nextMode;
    specificRoleIdRef.current = nextSpecificId;
    setPickerMode(nextMode);
    setSpecificRoleId(nextSpecificId);
    if (switched) {
      setEditor(null);
      setQuery('');
    }
    effectiveRoleIdRef.current = nextEffective;
    if (nextEffective) void loadEntries(nextEffective);
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
      setNotice(errorText(e));
    }
  };

  const remove = async (entry: DiaryEntry): Promise<void> => {
    // 项目铁律：禁止原生弹窗，统一走自绘确认框。
    if (!(await api.showConfirm!(t('diary.confirmDelete')))) return;
    try {
      await api.diaryDelete(entry.id);
      await loadEntries(effectiveRoleId);
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
    // 项目铁律：强制重生成必须自绘二次确认，禁止 window.confirm。
    if (!(await api.showConfirm!(t('diary.confirmRegenerateComment')))) return;
    try {
      const res = await api.diaryRegenerateComments(entry.id, entry.visibleRoleIds);
      setNotice(
        res.generatedRoleIds.length > 0
          ? t('diary.aiDone').replace('{roles}', res.generatedRoleIds.join(', '))
          : t(res.reason ? `diary.reason.${res.reason}` : 'diary.aiSkipped').replace('{roles}', res.skippedRoleIds.join(', '))
      );
      await loadEntries(effectiveRoleId);
    } catch (e) {
      setNotice(String(e));
    }
  };

  /** 单条留言强制重生成：同样走自绘确认 + 主进程 force 软撤旧串。 */
  const regenerateOne = async (entry: DiaryEntry, roleId: string): Promise<void> => {
    if (!(await api.showConfirm!(t('diary.confirmRegenerateComment')))) return;
    try {
      const res = await api.diaryCommentRegenerateOne(entry.id, roleId);
      setNotice(
        res.generatedRoleIds.length > 0
          ? t('diary.aiDone').replace('{roles}', res.generatedRoleIds.join(', '))
          : t(res.reason ? `diary.reason.${res.reason}` : 'diary.aiSkipped').replace('{roles}', res.skippedRoleIds.join(', '))
      );
      await loadEntries(effectiveRoleId);
    } catch (e) {
      setNotice(String(e));
    }
  };

  /** 用户回复由事件驱动立即触发一轮 AI 回复；失败保留草稿可重试。 */
  const sendReply = async (entry: DiaryEntry, comment: DiaryComment): Promise<void> => {
    const text = (replyDrafts[comment.id] || '').trim();
    if (!text || replyBusy[comment.id]) return;
    setReplyBusy((prev) => ({ ...prev, [comment.id]: true }));
    setReplyErrors((prev) => ({ ...prev, [comment.id]: '' }));
    try {
      const res = await api.diaryReplyAdd(entry.id, comment.id, text);
      if (!res.ok) {
        setReplyErrors((prev) => ({ ...prev, [comment.id]: res.error || t('diary.replyFailed') }));
      } else {
        setReplyDrafts((prev) => ({ ...prev, [comment.id]: '' }));
      }
      await loadEntries(effectiveRoleId);
    } catch (e) {
      setReplyErrors((prev) => ({ ...prev, [comment.id]: String(e) }));
    } finally {
      setReplyBusy((prev) => ({ ...prev, [comment.id]: false }));
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
      await loadEntries(effectiveRoleId);
    } catch (e) {
      setNotice(String(e));
    }
  };

  const deleteComment = async (entry: DiaryEntry, commentId: string): Promise<void> => {
    try {
      await api.diaryUpdate(entry.id, {
        aiComments: entry.aiComments.filter((c) => c.id !== commentId),
      });
      await loadEntries(effectiveRoleId);
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
  const effectiveLabel = pickerMode === 'current'
    ? identityLabel
    : (selfRoles.find((r) => r.id === effectiveRoleId)?.name || identityLabel);

  return (
    <div className="diary-panel">
      <div className="diary-toolbar">
        <h2 className="diary-heading">{t('diary.title')}</h2>
        <div className="diary-toolbar-right">
          {/* v3.0.23：原只读 span 收敛为下拉；第一项复用「当前身份（name）」文案，其后列出 settings.selfRoles。
              current 是保留 value（自我身份 id 为 UUID），选项数 = selfRoles.length + 1。 */}
          {identity && selfRoles.length > 0 && (
            <label className="diary-identity-picker">
              <span className="diary-identity-label">{t('diary.identityPickerLabel')}</span>
              <select
                className="diary-identity-select"
                aria-label={t('diary.identityPickerLabel')}
                value={pickerMode === 'current' ? 'current' : (specificRoleId ?? 'current')}
                onChange={(e) => handleIdentityChange(e.target.value)}
              >
                <option value="current">{identityLabel}</option>
                {selfRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          {identity && (
            <button
              type="button"
              className="diary-primary"
              onClick={() => setEditor(emptyEditor(effectiveRoleId))}
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
                  <div className="diary-editor-head">{effectiveLabel}</div>
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
                        {/* 全选/清空固定在滚动容器之外，不随人物列表滚动 */}
                        <div className="diary-bulk">
                          <button type="button" onClick={() => setEditor({ ...editor, visibleRoleIds: roles.map((r) => r.id) })}>
                            {t('diary.selectAll')}
                          </button>
                          <button type="button" onClick={() => setEditor({ ...editor, visibleRoleIds: [] })}>
                            {t('diary.clearAll')}
                          </button>
                        </div>
                        {roles.length === 0 && <div className="diary-hint">{t('diary.noRoles')}</div>}
                        <div className="diary-role-list">
                          {roles.map((r) => (
                            <label key={r.id} className="diary-check" title={r.name}>
                              <input
                                type="checkbox"
                                checked={editor.visibleRoleIds.includes(r.id)}
                                onChange={() => toggleRole(r.id)}
                              />
                              <span className="diary-role-name">{r.name}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </fieldset>
                  <div className="diary-hint">{t('diary.scheduleHint')}</div>
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
                          {entry.aiComments.filter((c) => !c.revoked).map((c) => {
                            const roleName = roles.find((r) => r.id === c.roleId)?.name || c.roleId;
                            const thread = (c.replies || []).filter((r) => !r.revoked);
                            const busy = replyBusy[c.id] === true;
                            return (
                              <div className="diary-comment" key={c.id} data-comment-id={c.id}>
                                <div className="diary-meta">
                                  <span>{roleName}</span>
                                  <span>{t(`diary.tone.${c.tone}`)}</span>
                                  <span>{t('diary.commentMeta').replace('{mood}', c.moodAt).replace('{affinity}', String(c.affinityAt))}</span>
                                  {busy && <span className="diary-badge diary-reply-badge">{t('diary.replyGenerating')}</span>}
                                  {!busy && c.awaitingUserReply !== false && (
                                    <span className="diary-badge">{t('diary.awaitingReply')}</span>
                                  )}
                                </div>
                                <div className="diary-text">{c.text}</div>
                                {thread.length > 0 && (
                                  <div className="diary-comment-thread">
                                    {thread.map((r) => (
                                      <div className={`diary-reply diary-reply--${r.author}`} key={r.id}>
                                        <span className="diary-reply-author">
                                          {r.author === 'user' ? t('diary.replyFromMe') : `${t('diary.replyFromAi')} · ${roleName}`}
                                        </span>
                                        <span className="diary-reply-time">{r.created_at}</span>
                                        <div className="diary-text">{r.text}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className="diary-reply-compose">
                                  <input
                                    className="diary-input diary-reply-input"
                                    value={replyDrafts[c.id] || ''}
                                    disabled={busy}
                                    placeholder={t('diary.replyPlaceholder')}
                                    aria-label={t('diary.replyPlaceholder')}
                                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') { e.preventDefault(); void sendReply(entry, c); }
                                    }}
                                  />
                                  <button type="button" disabled={busy || !(replyDrafts[c.id] || '').trim()} onClick={() => void sendReply(entry, c)}>
                                    {busy ? t('diary.replyGenerating') : t('diary.replySend')}
                                  </button>
                                  <button type="button" disabled={busy} onClick={() => void regenerateOne(entry, c.roleId)}>
                                    {t('diary.regenerateComments')}
                                  </button>
                                  <button type="button" onClick={() => void deleteComment(entry, c.id)}>{t('diary.deleteComment')}</button>
                                </div>
                                {replyErrors[c.id] && (
                                  <button
                                    type="button"
                                    className="diary-reply-error"
                                    title={replyErrors[c.id]}
                                    onClick={() => void sendReply(entry, c)}
                                  >
                                    {t('diary.replyFailed')}
                                  </button>
                                )}
                              </div>
                            );
                          })}
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
