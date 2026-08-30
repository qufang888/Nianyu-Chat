import React from 'react';
import { useI18n } from '../i18n/I18nContext';

type View = 'chats' | 'contacts' | 'compare' | 'settings' | 'stats' | 'library' | 'moments';

const items: { key: View; icon: string; labelKey: string }[] = [
  { key: 'chats', icon: '💬', labelKey: 'nav.chats' },
  { key: 'contacts', icon: '👥', labelKey: 'nav.contacts' },
  { key: 'moments', icon: '🌟', labelKey: 'nav.moments' },
  { key: 'compare', icon: '⚔️', labelKey: 'nav.compare' },
  { key: 'stats', icon: '📊', labelKey: 'nav.stats' },
  { key: 'library', icon: '📚', labelKey: 'library.title' },
  { key: 'settings', icon: '⚙️', labelKey: 'nav.settings' },
];

export const Sidebar: React.FC<{ view: View; onChange: (v: View) => void }> = ({
  view,
  onChange,
}) => {
  const { t } = useI18n();
  return (
    <div className="sidebar">
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
    </div>
  );
};
