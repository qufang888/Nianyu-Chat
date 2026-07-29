import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { SelfRole } from '../types';
import { ImageCropper } from './ImageCropper';
import { AvatarImg } from './ChatList';
import { useToast, ToastView } from './Toast';

function emptySelfRole(): SelfRole {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: '',
    avatar_path: '',
    gender: '',
    age: null,
    short_intro: '',
    personality: '',
    background: '',
    world_setting: '',
    created_at: now,
    updated_at: now,
  };
}

// 单张「我的角色卡」编辑器（模态）
export const SelfRoleEditor: React.FC<{
  initial?: SelfRole;
  title: string;
  onClose: () => void;
  onSaved: (role: SelfRole) => void;
}> = ({ initial, title, onClose, onSaved }) => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const [role, setRole] = useState<SelfRole>(initial ? { ...initial } : emptySelfRole());
  const [msg, setMsg] = useState('');
  const [crop, setCrop] = useState<{ open: boolean; src: string }>({ open: false, src: '' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k: keyof SelfRole, v: any) => setRole((r) => ({ ...r, [k]: v }));

  const pickAvatar = async () => {
    const paths = await api.pickImage();
    if (paths && paths.length) {
      const src = await api.getImage(paths[0]);
      if (src) setCrop({ open: true, src });
    }
  };

  const save = () => {
    if (!role.name.trim()) {
      setMsg(t('self.needName'));
      return;
    }
    onSaved({
      ...role,
      name: role.name.trim(),
      updated_at: new Date().toISOString(),
    });
  };

  return (
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body">
          {msg && (
            <div style={{ marginBottom: 12, color: 'var(--color-primary)', fontSize: 13 }}>{msg}</div>
          )}
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
            <div
              className="avatar"
              style={{ width: 64, height: 64, fontSize: 28, background: 'var(--color-panel-alt)' }}
            >
              {role.avatar_path ? (
                <AvatarImg path={role.avatar_path} />
              ) : (
                '🙂'
              )}
            </div>
            <button className="btn-ghost" onClick={pickAvatar}>
              {t('self.chooseAvatar')}
            </button>
            {role.avatar_path && (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('self.avatarChosen')}</span>
            )}
          </div>
          <div className="form-grid">
            <Field label={t('self.name')} full>
              <input value={role.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label={t('self.gender')}>
              <input value={role.gender} onChange={(e) => set('gender', e.target.value)} placeholder={t('role.genderPh')} />
            </Field>
            <Field label={t('self.age')}>
              <input
                type="number"
                value={role.age ?? ''}
                onChange={(e) => set('age', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label={t('self.shortIntro')} full>
              <input value={role.short_intro} onChange={(e) => set('short_intro', e.target.value)} />
            </Field>
            <Field label={t('self.personality')} full>
              <textarea value={role.personality} onChange={(e) => set('personality', e.target.value)} />
            </Field>
            <Field label={t('self.background')} full>
              <textarea value={role.background} onChange={(e) => set('background', e.target.value)} />
            </Field>
            <Field label={t('self.worldSetting')} full>
              <textarea value={role.world_setting} onChange={(e) => set('world_setting', e.target.value)} />
            </Field>
          </div>
          <div className="row-actions">
            <button className="btn-primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
      {crop.open && (
        <ImageCropper
          src={crop.src}
          outputSize={256}
          title={t('role.cropAvatar')}
          hint={t('role.avatarCropHint')}
          onClose={() => setCrop({ open: false, src: '' })}
          onCrop={async (dataUrl) => {
            const saved = await api.saveImage(dataUrl);
            if (saved) {
              set('avatar_path', saved);
              showToast(t('role.avatarSavedTip'));
            }
            setCrop({ open: false, src: '' });
          }}
        />
      )}
      <ToastView toast={toast} />
    </div>
  );
};

const Field: React.FC<{ label: string; full?: boolean; children: React.ReactNode }> = ({
  label,
  full,
  children,
}) => (
  <div className={`field ${full ? 'full' : ''}`}>
    <label>{label}</label>
    {children}
  </div>
);
