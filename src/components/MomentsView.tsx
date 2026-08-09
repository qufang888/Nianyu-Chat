import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './Toast';
import { AvatarImg } from './ChatList';
import ImageGrid from './ImageGrid';
import type { Role, SelfRole } from '../types';

interface MomentItem {
  id: number;
  roleId: string;
  content: string;
  images: string[];
  created_at: string;
  scheduledAt?: string | null;
  published: boolean;
  liked?: boolean;
  favorited?: boolean;
}

function fmtDateTime(ts?: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function countdownText(scheduledAt: string | undefined | null, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (!scheduledAt) return '';
  const ms = new Date(scheduledAt).getTime() - Date.now();
  if (ms <= 0) return t('moments.soon');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return t('moments.inHours', { h, m });
  return t('moments.inMinutes', { m });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const ComposeModal: React.FC<{
  roles: Role[];
  selfRoles: SelfRole[];
  defaultSelfRoleId: string;
  onClose: () => void;
  onPublished: (scheduled: boolean) => void;
  showToast: (msg: string) => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}> = ({ roles, selfRoles, defaultSelfRoleId, onClose, onPublished, showToast, t }) => {
  const [roleId, setRoleId] = useState(roles[0]?.id || '');
  const [selfRoleId, setSelfRoleId] = useState(defaultSelfRoleId || '');
  const [content, setContent] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const pickImages = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const dataUrl = await readFileAsDataURL(f);
        const saved = await api.saveImage(dataUrl);
        if (saved) setImages((prev) => [...prev, saved]);
      } catch {
        /* 单张失败忽略，继续 */
      }
    }
  };

  const submit = async () => {
    if (!roleId) {
      showToast(t('moments.needRole'));
      return;
    }
    if (!content.trim() && images.length === 0) {
      showToast(t('moments.needContent'));
      return;
    }
    setSubmitting(true);
    try {
      // datetime-local 为本地时间（无时区），转 ISO；留空=立即发布
      const iso = scheduledAt ? new Date(scheduledAt).toISOString() : null;
      await api.addMoment(roleId, content.trim(), images, iso, selfRoleId || undefined);
      onPublished(!!iso);
    } catch (e: any) {
      showToast(t('common.failed') + (e?.message ? ': ' + e.message : ''));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('moments.compose')}</span>
          <span className="modal-close" onClick={onClose}>×</span>
        </div>
        <div className="modal-body">
          <div className="compose-row">
            <label>{t('moments.poster')}</label>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="compose-row">
            <label>{t('moments.selfRole')}</label>
            <select value={selfRoleId} onChange={(e) => setSelfRoleId(e.target.value)}>
              <option value="">{t('moments.allSelfRoles')}</option>
              {selfRoles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="compose-row">
            <textarea
              className="compose-text"
              placeholder={t('moments.contentPlaceholder')}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
            />
          </div>
          <div className="compose-row">
            <label>{t('moments.schedule')}</label>
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            <span className="compose-hint">{t('moments.scheduleHint')}</span>
          </div>
          <div className="compose-row">
            <label>{t('moments.images')}</label>
            <input type="file" accept="image/*" multiple onChange={(e) => pickImages(e.target.files)} />
            {images.length > 0 && (
              <div className="compose-imgs">
                {images.map((p, i) => (
                  <div className="compose-img" key={i}>
                    <img src={p} alt="" />
                    <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" onClick={submit} disabled={submitting}>{t('moments.publish')}</button>
        </div>
      </div>
    </div>
  );
};

export const MomentsView: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [selfRoles, setSelfRoles] = useState<SelfRole[]>([]);
  const [roleMap, setRoleMap] = useState<Record<string, Role>>({});
  const [filterRole, setFilterRole] = useState<string>('');
  const [filterSelf, setFilterSelf] = useState<string>('');
  const [tab, setTab] = useState<'published' | 'pending' | 'favorites'>('published');
  const [moments, setMoments] = useState<MomentItem[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [dailyMomentLimit, setDailyMomentLimit] = useState<number>(5);

  const load = useCallback(async () => {
    try {
      await api.publishDueMoments();
    } catch {
      /* 忽略：发布到点动态异常不影响展示 */
    }
    const favoritedOnly = tab === 'favorites';
    const includeUnpublished = tab === 'pending' || favoritedOnly;
    const list = await api.listMoments(filterRole || undefined, includeUnpublished, filterSelf || undefined, favoritedOnly);
    const filtered = tab === 'pending' ? list.filter((m) => !m.published) : list;
    setMoments(filtered as MomentItem[]);
  }, [filterRole, filterSelf, tab]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.getRoles().then((rs) => {
      setRoles(rs);
      const m: Record<string, Role> = {};
      rs.forEach((r) => (m[r.id] = r));
      setRoleMap(m);
    });
    api.getSettings().then((s) => {
      setSelfRoles(s.selfRoles || []);
      setDailyMomentLimit(s.dailyMomentLimit ?? 5);
    }).catch(() => {});
  }, []);

  // AI 自动发动态或手动增删后，主进程广播 moments:changed，自动刷新列表（尊重当前筛选）
  useEffect(() => {
    const off = api.onMomentsChanged(() => {
      load();
    });
    return off;
  }, [load]);

  // 定时轮询（后端每 60s 自动发布到点动态）+ 窗口聚焦刷新，保证待发布动态到点后及时转入已发布
  useEffect(() => {
    const id = setInterval(() => {
      load();
    }, 30000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const handleDelete = async (id: number) => {
    await api.removeMoment(id);
    showToast(t('moments.deleted'));
    load();
  };

  // 点赞 / 收藏：布尔切换，乐观更新本地，再落盘并广播刷新
  const handleToggle = async (id: number, field: 'liked' | 'favorited') => {
    const cur = moments.find((m) => m.id === id);
    if (!cur) return;
    const next = !cur[field];
    setMoments((prev) => prev.map((m) => (m.id === id ? { ...m, [field]: next } : m)));
    try {
      await api.updateMoment(id, { [field]: next });
    } catch {
      setMoments((prev) => prev.map((m) => (m.id === id ? { ...m, [field]: !next } : m)));
      showToast(t('common.failed'));
    }
    // 在「收藏」tab 取消收藏时，立即从列表移除
    if (field === 'favorited' && !next && tab === 'favorites') {
      setMoments((prev) => prev.filter((m) => m.id !== id));
    }
  };

  return (
    <div className="main-pane moments-view">
      <div className="moments-head">
        <div className="moments-title">{t('nav.moments')}</div>
        <div className="moments-head-actions">
          <button
            className="btn-primary"
            disabled={triggering || !filterRole}
            title={filterRole ? t('moments.triggerHint') : t('moments.triggerNeedRole')}
            onClick={async () => {
              if (!filterRole || triggering) return;
              setTriggering(true);
              try {
                const res = await api.triggerRelationship('single', filterRole, filterRole, true, false);
                if (res?.ok) {
                  if (res.moments > 0) showToast(t('bond.momentsPosted', { n: res.moments }));
                  else showToast(t('bond.analyzed'));
                } else {
                  showToast(t('bond.triggerFailed'));
                }
              } catch {
                showToast(t('bond.triggerFailed'));
              } finally {
                setTriggering(false);
              }
            }}
          >
            {triggering ? t('bond.analyzing') : t('moments.triggerAI')}
          </button>
          <button className="btn-primary" onClick={() => setComposeOpen(true)}>{t('moments.compose')}</button>
        </div>
      </div>

      <div className="moments-toolbar">
        <select
          className="moments-filter"
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value)}
        >
          <option value="">{t('moments.allRoles')}</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <select
          className="moments-filter"
          value={filterSelf}
          onChange={(e) => setFilterSelf(e.target.value)}
          title={t('moments.selfRoleFilter')}
        >
          <option value="">{t('moments.allSelfRoles')}</option>
          {selfRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 13 }}>{t('moments.globalDailyLimit')}</span>
          <select
            className="moments-filter"
            style={{ width: 'auto' }}
            value={dailyMomentLimit}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDailyMomentLimit(v);
              api.saveSettings({ dailyMomentLimit: v });
            }}
            title={t('moments.globalDailyLimitHint')}
          >
            {![1, 3, 5, 10, 20, 0].includes(dailyMomentLimit) && (
              <option value={dailyMomentLimit}>{dailyMomentLimit}</option>
            )}
            <option value={1}>1</option>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={0}>{t('moments.unlimited')}</option>
          </select>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('moments.globalDailyLimitHint')}
          </span>
        </div>
        <div className="tabs">
          <div
            className={`tab ${tab === 'published' ? 'active' : ''}`}
            onClick={() => setTab('published')}
          >
            {t('moments.published')}
          </div>
          <div
            className={`tab ${tab === 'pending' ? 'active' : ''}`}
            onClick={() => setTab('pending')}
          >
            {t('moments.pending')}
          </div>
          <div
            className={`tab ${tab === 'favorites' ? 'active' : ''}`}
            onClick={() => setTab('favorites')}
          >
            {t('moments.favorites')}
          </div>
        </div>
      </div>

      <div className="moments-feed">
        {moments.length === 0 ? (
          <div className="empty-state">
            <div style={{ fontSize: 40 }}>🌟</div>
            <div>{tab === 'pending' ? t('moments.emptyPending') : t('moments.empty')}</div>
          </div>
        ) : (
          moments.map((m) => {
            const role = roleMap[m.roleId];
            return (
              <div className="moment-card" key={m.id}>
                <div className="moment-head">
                  <div className="moment-avatar">
                    {role?.avatar_path ? <AvatarImg path={role.avatar_path} /> : '🤖'}
                  </div>
                  <div className="moment-meta">
                    <div className="moment-name">{role?.name || t('moments.unknown')}</div>
                    <div className="moment-time">
                      {m.published
                        ? fmtDateTime(m.created_at)
                        : t('moments.pendingIn', { time: countdownText(m.scheduledAt, t) })}
                    </div>
                  </div>
                  <button
                    className="moment-del"
                    title={t('common.delete')}
                    onClick={() => handleDelete(m.id)}
                  >
                    🗑
                  </button>
                </div>
                {m.content && <div className="moment-content">{m.content}</div>}
                {m.images && m.images.length > 0 && (
                  <ImageGrid paths={m.images} onImage={(src) => setPreviewImg(src)} failed={false} />
                )}
                <div className="moment-actions">
                  <button
                    className={`moment-act ${m.liked ? 'on' : ''}`}
                    title={t('moments.like')}
                    onClick={() => handleToggle(m.id, 'liked')}
                  >
                    {m.liked ? '❤️' : '🤍'} {m.liked ? t('moments.liked') : t('moments.like')}
                  </button>
                  <button
                    className={`moment-act ${m.favorited ? 'on' : ''}`}
                    title={t('moments.favorite')}
                    onClick={() => handleToggle(m.id, 'favorited')}
                  >
                    {m.favorited ? '⭐' : '☆'} {m.favorited ? t('moments.favorited') : t('moments.favorite')}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {composeOpen && (
        <ComposeModal
          roles={roles}
          selfRoles={selfRoles}
          defaultSelfRoleId={filterSelf}
          onClose={() => setComposeOpen(false)}
          onPublished={(scheduled) => {
            setComposeOpen(false);
            if (scheduled) setTab('pending');
            load();
          }}
          showToast={showToast}
          t={t}
        />
      )}

      {previewImg && !composeOpen && (
        <div className="modal-mask" onClick={() => setPreviewImg(null)}>
          <img className="image-preview" src={previewImg} alt="" />
        </div>
      )}
    </div>
  );
};
