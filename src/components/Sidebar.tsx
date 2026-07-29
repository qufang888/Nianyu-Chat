import React from 'react';
import { useI18n } from '../i18n/I18nContext';

type View = 'chats' | 'contacts' | 'settings' | 'stats' | 'library';

const items: { key: View; icon: string; labelKey: string }[] = [
  { key: 'chats', icon: '💬', labelKey: 'nav.chats' },
  { key: 'contacts', icon: '👥', labelKey: 'nav.contacts' },
  { key: 'stats', icon: '📊', labelKey: 'nav.stats' },
  { key: 'library', icon: '📚', labelKey: 'library.title' },
  { key: 'settings', icon: '⚙️', labelKey: 'nav.settings' },
];

export const Sidebar: React.FC<{ view: View; onChange: (v: View) => void; onAbout?: () => void; onRefresh?: () => void }> = ({
  view,
  onChange,
  onAbout,
  onRefresh,
}) => {
  const { t } = useI18n();
  return (
    <div className="sidebar">
      <div className="nav-logo">念</div>
      {items.map((it) => (
        <div
          key={it.key}
          className={`nav-item ${view === it.key ? 'active' : ''}`}
          role="button"
          title={t(it.labelKey)}
          onClick={() => onChange(it.key)}
        >
          {it.icon}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div
        className="nav-item"
        role="button"
        title={t('nav.refreshUI')}
        onClick={() => onRefresh?.()}
      >
        🔄
      </div>
      <div
        className="nav-item"
        role="button"
        title={t('about.open')}
        onClick={() => onAbout?.()}
      >
        ℹ️
      </div>
    </div>
  );
};
