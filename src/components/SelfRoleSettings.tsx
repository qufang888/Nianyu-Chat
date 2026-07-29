import React, { useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { SelfRole } from '../types';
import { SelfRoleEditor } from './SelfRoleEditor';

// 我的角色卡管理页（设置内子页）
export const SelfRoleSettings: React.FC<{
  selfRoles: SelfRole[];
  currentSelfRoleId: string;
  onPersist: (p: { selfRoles: SelfRole[]; currentSelfRoleId: string }) => void;
  onBack: () => void;
}> = ({ selfRoles, currentSelfRoleId, onPersist, onBack }) => {
  const { t } = useI18n();
  const [editing, setEditing] = useState<SelfRole | undefined>(undefined);
  const [editorOpen, setEditorOpen] = useState(false);
  // 头像预览缓存
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});

  const openNew = () => {
    setEditing(undefined);
    setEditorOpen(true);
  };
  const openEdit = (r: SelfRole) => {
    setEditing(r);
    setEditorOpen(true);
  };

  const onSaved = (role: SelfRole) => {
    const exists = selfRoles.find((r) => r.id === role.id);
    const next = exists ? selfRoles.map((r) => (r.id === role.id ? role : r)) : [...selfRoles, role];
    // 若此前没有默认身份，新角色自动成为默认
    const nextDefault = currentSelfRoleId || (exists ? currentSelfRoleId : role.id);
    onPersist({ selfRoles: next, currentSelfRoleId: nextDefault });
    setEditorOpen(false);
  };

  const setDefault = (id: string) => {
    onPersist({ selfRoles, currentSelfRoleId: currentSelfRoleId === id ? '' : id });
  };

  const del = async (r: SelfRole) => {
    if (!(await api.showConfirm!(t('self.confirmDelete', { name: r.name })))) return;
    const next = selfRoles.filter((x) => x.id !== r.id);
    const nextDefault = currentSelfRoleId === r.id ? '' : currentSelfRoleId;
    onPersist({ selfRoles: next, currentSelfRoleId: nextDefault });
    // 删除后归还焦点到聊天输入框，避免原生确认框关闭导致的输入框锁死
    window.dispatchEvent(new CustomEvent('nianyu:restore-focus'));
    if (r.avatar_path && avatars[r.id] === undefined) {
      // 无需额外处理
    }
  };

  const loadAvatar = (r: SelfRole) => {
    if (avatars[r.id] !== undefined || !r.avatar_path) return;
    api.getImage(r.avatar_path).then((src) => setAvatars((a) => ({ ...a, [r.id]: src })));
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button className="btn-ghost" onClick={onBack} style={{ padding: '4px 12px' }}>
          ← {t('settings.back')}
        </button>
        <strong style={{ fontSize: 15 }}>{t('self.manage')}</strong>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {selfRoles.map((r) => {
          loadAvatar(r);
          const isDefault = currentSelfRoleId === r.id;
          return (
            <div
              key={r.id}
              style={{
                width: 240,
                border: isDefault ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding: 12,
                background: 'var(--color-panel-alt)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  className="avatar"
                  style={{ width: 44, height: 44, fontSize: 20, background: 'var(--color-panel)' }}
                >
                  {avatars[r.id] ? (
                    <img src={avatars[r.id]!} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                  ) : (
                    '🙂'
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    {isDefault && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: '#fff',
                          background: 'var(--color-primary)',
                          borderRadius: 8,
                          padding: '1px 7px',
                        }}
                      >
                        {t('self.defaultBadge')}
                      </span>
                    )}
                  </div>
                  {r.short_intro && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.short_intro}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => openEdit(r)}>
                  {t('self.edit')}
                </button>
                <button
                  className="btn-ghost"
                  style={{
                    padding: '3px 10px',
                    fontSize: 12,
                    color: isDefault ? 'var(--color-text-secondary)' : 'var(--color-primary)',
                  }}
                  onClick={() => setDefault(r.id)}
                >
                  {isDefault ? t('self.unsetDefault') : t('self.setDefault')}
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: '3px 10px', fontSize: 12, color: '#e06c75' }}
                  onClick={() => del(r)}
                >
                  {t('self.delete')}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button className="btn-primary" style={{ marginTop: 16 }} onClick={openNew}>
        {t('self.new')}
      </button>

      {editorOpen && (
        <SelfRoleEditor
          initial={editing}
          title={editing ? t('self.edit') : t('self.new')}
          onClose={() => setEditorOpen(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
};
