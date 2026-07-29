import React from 'react';
import { api } from '../ipc';
import { FONT_FAMILIES, type AppSettings } from '../types';
import { useI18n } from '../i18n/I18nContext';
import SelectMenu from './SelectMenu';

interface Props {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  onBack: () => void;
}

export const FontSettings: React.FC<Props> = ({ draft, patch, onBack }) => {
  const { t } = useI18n();
  return (
    <div style={{ paddingBottom: 20 }}>
      <button className="btn-ghost" onClick={onBack} style={{ marginBottom: 14 }}>
        ← {t('settings.back')}
      </button>

      {/* 字体大小 */}
      <div className="section-title">{t('settings.fontSize', { n: draft.fontSize ?? 14 })}</div>
      <input
        type="range"
        min={11}
        max={30}
        step={1}
        value={draft.fontSize ?? 14}
        style={{ width: '100%', maxWidth: 480 }}
        onChange={(e) => {
          const v = Number(e.target.value);
          patch({ fontSize: v });
          document.documentElement.style.setProperty('--font-size', `${v}px`);
          document.documentElement.style.setProperty('--font-scale', String(v / 14));
          api.saveSettings({ fontSize: v });
        }}
      />

      {/* 字体样式 */}
      <div className="section-title" style={{ marginTop: 18 }}>
        {t('settings.fontFamily')}
      </div>
      <div className="field" style={{ maxWidth: 320 }}>
        <SelectMenu
          value={draft.fontFamily || 'system'}
          onChange={(key) => {
            patch({ fontFamily: key });
            const ff = FONT_FAMILIES[key] || FONT_FAMILIES.system;
            document.documentElement.style.setProperty('--font-family', ff);
            api.saveSettings({ fontFamily: key });
          }}
          options={Object.keys(FONT_FAMILIES).map((k) => ({
            value: k,
            label: t(`settings.font.${k}`),
          }))}
        />
      </div>

      <div
        style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 8, maxWidth: 480 }}
      >
        {t('settings.fontDesc')}
      </div>
    </div>
  );
};
