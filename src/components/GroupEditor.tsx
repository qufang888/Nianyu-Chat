import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useToast, ToastView } from './Toast';
import type { Role, Group } from '../types';

export const GroupEditor: React.FC<{
  onClose: () => void;
  onSaved?: () => void;
  onUpdated?: () => void;
  group?: Group; // 传入则为「编辑群成员」模式
}> = ({ onClose, onSaved, onUpdated, group }) => {
  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const isEdit = !!group;
  const [roles, setRoles] = useState<Role[]>([]);
  const [name, setName] = useState(group?.group_name || '');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(group ? group.member_ids.split(',').map((s) => s.trim()).filter(Boolean) : [])
  );
  // 观察模式（对局）状态：仅编辑已有群时可用
  const [obs, setObs] = useState<{
    observerMode: boolean;
    freezeMemory: boolean;
    publicWriteMemory: boolean;
    observerNoEmotion: boolean;
    privateWriteMemory: boolean;
    privateAffectsEmotion: boolean;
  } | null>(null);
  const [aiMentionEnabled, setAiMentionEnabled] = useState(false);

  useEffect(() => {
    api.getRoles().then(setRoles);
    if (group) {
      api.getGroup(group.group_id).then((g) => {
        if (!g) return;
        setObs({
          observerMode: !!g.observerMode,
          freezeMemory: !!g.freezeMemory,
          publicWriteMemory: g.publicWriteMemory !== false,
          observerNoEmotion: g.observerNoEmotion !== false,
          privateWriteMemory: !!g.privateWriteMemory,
          privateAffectsEmotion: !!g.privateAffectsEmotion,
        });
        setAiMentionEnabled(!!g.aiMentionEnabled);
      });
    }
  }, []);

  // ESC 关闭（仅叉号 / ESC 可退出，点空白不关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // 观察模式（对局）相关操作
  const toggleObsMode = async (v: boolean) => {
    if (!group) return;
    setObs((o) => (o ? { ...o, observerMode: v } : o));
    await api.observerSetMode({ groupId: group.group_id, on: v, applyPreset: v });
    if (v) showToast(t('observer.presetApplied'));
  };
  const toggleObsCfg = async (
    key: 'freezeMemory' | 'publicWriteMemory' | 'observerNoEmotion' | 'privateWriteMemory' | 'privateAffectsEmotion',
    v: boolean
  ) => {
    if (!group) return;
    setObs((o) => (o ? { ...o, [key]: v } : o));
    await api.observerSetConfig({ groupId: group.group_id, patch: { [key]: v } as any });
  };

  const save = async () => {
    if (!name.trim()) return showToast(t('group.needName'), { error: true });
    if (selected.size < 1) return showToast(t('group.needMember'), { error: true });
    // 编辑模式下若重新凑齐 ≥2 人，清除「保持群聊」忽略标记，使其后若再减回 1 人可重新提示
    const existing = group ? await api.getGroup(group.group_id) : undefined;
    const g: Group = {
      group_id: group?.group_id || crypto.randomUUID(),
      group_name: name.trim(),
      member_ids: Array.from(selected).join(','),
      created_at: group?.created_at || new Date().toISOString(),
      ignoreConvert: selected.size >= 2 ? false : (existing?.ignoreConvert ?? false),
      aiMentionEnabled,
    };
    await api.saveGroup(g);
    if (isEdit) onUpdated?.();
    else onSaved?.();
  };

  return (
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{isEdit ? t('group.editTitle') : t('group.newTitle')}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body">
          <div className="field full" style={{ marginBottom: 16 }}>
            <label>{t('group.name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('group.namePh')} />
          </div>
          <div className="section-title">{t('group.selectMembers')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {roles.map((r) => (
              <label
                key={r.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  padding: '8px 10px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                <span>{r.name}</span>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                  {r.short_intro}
                </span>
              </label>
            ))}
            {roles.length === 0 && (
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                {t('group.noRoles')}
              </div>
            )}
          </div>
          {/* AI 互 @ 开关 */}
          <label className="obs-toggle" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={aiMentionEnabled}
              onChange={(e) => setAiMentionEnabled(e.target.checked)}
            />
            <span>
              <b>{t('group.aiMention')}</b>
              <em>{t('group.aiMentionDesc')}</em>
            </span>
          </label>
          {/* 观察模式（对局）：仅编辑已有群时出现 */}
          {isEdit && obs && (
            <div className="obs-editor-section">
              <div className="section-title" style={{ marginTop: 16 }}>
                🔭 {t('observer.mode')}
              </div>
              <label className="obs-toggle obs-toggle-main">
                <input
                  type="checkbox"
                  checked={obs.observerMode}
                  onChange={(e) => toggleObsMode(e.target.checked)}
                />
                <span>
                  <b>{t('observer.enter')} / {t('observer.exit')}</b>
                  <em>{obs.observerMode ? t('observer.active') : t('observer.enterTip')}</em>
                </span>
              </label>
              {obs.observerMode && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  <label className="obs-toggle">
                    <input
                      type="checkbox"
                      checked={obs.freezeMemory}
                      onChange={(e) => toggleObsCfg('freezeMemory', e.target.checked)}
                    />
                    <span>
                      <b>{t('observer.freezeMemory')}</b>
                      <em>{t('observer.freezeMemoryDesc')}</em>
                    </span>
                  </label>
                  <label className="obs-toggle">
                    <input
                      type="checkbox"
                      checked={obs.publicWriteMemory}
                      onChange={(e) => toggleObsCfg('publicWriteMemory', e.target.checked)}
                    />
                    <span>
                      <b>{t('observer.publicWriteMemory')}</b>
                      <em>{t('observer.publicWriteMemoryDesc')}</em>
                    </span>
                  </label>
                  <label className="obs-toggle">
                    <input
                      type="checkbox"
                      checked={obs.observerNoEmotion}
                      onChange={(e) => toggleObsCfg('observerNoEmotion', e.target.checked)}
                    />
                    <span>
                      <b>{t('observer.pureObserver')}</b>
                      <em>{t('observer.pureObserverDesc')}</em>
                    </span>
                  </label>
                  <label className="obs-toggle">
                    <input
                      type="checkbox"
                      checked={obs.privateWriteMemory}
                      onChange={(e) => toggleObsCfg('privateWriteMemory', e.target.checked)}
                    />
                    <span>
                      <b>{t('observer.privateWriteMemory')}</b>
                      <em>{t('observer.privateWriteMemoryDesc')}</em>
                    </span>
                  </label>
                  <label className="obs-toggle">
                    <input
                      type="checkbox"
                      checked={obs.privateAffectsEmotion}
                      onChange={(e) => toggleObsCfg('privateAffectsEmotion', e.target.checked)}
                    />
                    <span>
                      <b>{t('observer.privateAffectsEmotion')}</b>
                      <em>{t('observer.privateAffectsEmotionDesc')}</em>
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}
          <div className="row-actions">
            <button className="btn-primary" onClick={save}>
              {isEdit ? t('group.update') : t('group.create')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
      <ToastView toast={toast} />
    </div>
  );
};
