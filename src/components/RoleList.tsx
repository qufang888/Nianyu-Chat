import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { Role, RoleStat } from '../types';
import { RoleEditor } from './RoleEditor';
import { AvatarImg } from './ChatList';

export const RoleList: React.FC<{ onStartChat: (role: Role) => void }> = ({ onStartChat }) => {
  const { t } = useI18n();
  const [roles, setRoles] = useState<Role[]>([]);
  const [stats, setStats] = useState<Record<string, RoleStat>>({});
  const [editing, setEditing] = useState<Role | null | undefined>(undefined); // null=新建, Role=编辑, undefined=关闭

  const refresh = () => {
    api.getRoles().then(setRoles);
    api.getRoleStats().then((list) => {
      const map: Record<string, RoleStat> = {};
      for (const s of list) map[s.roleId] = s;
      setStats(map);
    });
  };
  useEffect(() => {
    refresh();
  }, []);

  // 复制数字人：克隆全部配置，生成新 ID 并加「副本」后缀
  const duplicateRole = async (r: Role) => {
    const now = new Date().toISOString();
    const copy: Role = {
      ...r,
      id: crypto.randomUUID(),
      name: `${r.name}${t('contacts.copySuffix')}`,
      created_at: now,
      updated_at: now,
    };
    await api.saveRole(copy);
    refresh();
  };

  return (
    <div className="main-pane">
      <div className="list-header">
        <span>{t('contacts.title', { n: roles.length })}</span>
        <button className="btn-add" title={t('contacts.new')} onClick={() => setEditing(null)}>
          ＋
        </button>
      </div>
      <div className="list-scroll">
        <div className="panel" style={{ paddingTop: 8 }}>
          {roles.length === 0 && (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
              {t('contacts.empty')}
            </div>
          )}
          <div className="role-cards">
            {roles.map((r) => (
              <div key={r.id} className="role-card" onClick={() => setEditing(r)}>
                <div className="rc-head">
                  <div className="avatar" style={{ width: 40, height: 40 }}>
                    {r.avatar_path ? <AvatarImg path={r.avatar_path} /> : '🤖'}
                  </div>
                  <div>
                    <div className="rc-name">{r.name}</div>
                    <div className="affinity-tag">{t('contacts.affinity', { n: r.affinity })}</div>
                  </div>
                </div>
                <div className="rc-intro">{r.short_intro || t('contacts.noIntro')}</div>
                <div className="rc-tokens">
                  {t('contacts.tokens', { n: stats[r.id]?.tokens ?? 0 })}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <button
                    className="btn-ghost"
                    style={{ padding: '5px 12px', fontSize: 13 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartChat(r);
                    }}
                  >
                    {t('common.chat')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '5px 12px', fontSize: 13 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(r);
                    }}
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '5px 12px', fontSize: 13 }}
                    title={t('contacts.copyHint')}
                    onClick={(e) => {
                      e.stopPropagation();
                      duplicateRole(r);
                    }}
                  >
                    {t('common.copy')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '5px 12px', fontSize: 13, color: '#e06c75' }}
                    title={t('contacts.deleteHint')}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await api.showConfirm!(t('contacts.confirmDelete', { name: r.name }))) {
                        await api.deleteRole(r.id);
                        refresh();
                        // 删除后归还焦点到聊天输入框，避免原生确认框关闭导致的输入框锁死
                        window.dispatchEvent(new CustomEvent('nianyu:restore-focus'));
                      }
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {editing !== undefined && (
        <RoleEditor
          initial={editing || undefined}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            refresh();
          }}
        />
      )}
    </div>
  );
};
