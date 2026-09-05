import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { Role, RoleStat } from '../types';
import { AvatarImg } from './ChatList';
import { normalizeRelation, RELATION_LABELS } from '../types';

export const StatsView: React.FC = () => {
  const { t } = useI18n();
  const [stats, setStats] = useState<RoleStat[]>([]);
  const [global, setGlobal] = useState(0);
  const [roles, setRoles] = useState<Record<string, { avatar: string; affinity: number; mood: string; relation: string }>>({});
  const [modelStats, setModelStats] = useState<{ modelId: string; name: string; tokens: number; calls: number }[]>([]);

  const refresh = () => {
    api.getRoleStats().then(setStats);
    api.getGlobalTokens().then(setGlobal);
    api.getModelStats().then(setModelStats);
    api.getRoles().then((rs: Role[]) => {
      const map: Record<string, { avatar: string; affinity: number; mood: string; relation: string }> = {};
      for (const r of rs) {
        map[r.id] = { avatar: r.avatar_path, affinity: r.affinity || 0, mood: r.mood || '', relation: r.relation || '' };
      }
      setRoles(map);
    });
  };
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  const maxTokens = Math.max(1, ...stats.map((s) => s.tokens));
  const maxModelTokens = Math.max(1, ...modelStats.map((m) => m.tokens));

  return (
    <div className="main-pane">
      <div className="list-header">
        <span>{t('stats.title')}</span>
      </div>
      <div className="list-scroll">
        <div className="panel" style={{ padding: 16 }}>
          <div style={{ marginBottom: 16, fontSize: 14 }}>
            {t('stats.global', { n: global })}
          </div>
          {stats.length === 0 && (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
              {t('stats.empty')}
            </div>
          )}
          {stats.map((s) => {
            const ri = roles[s.roleId];
            return (
            <div key={s.roleId} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <div className="avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 13 }}>
                  {ri?.avatar ? <AvatarImg path={ri.avatar} /> : '🤖'}
                </div>
                <div style={{ fontWeight: 600, minWidth: 80 }}>{s.roleName}</div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 12, flex: 1, lineHeight: 1.5 }}>
                  {t('stats.tokens')}：{s.tokens} · {t('stats.messages')}：{s.messages}
                  {ri !== undefined && (
                    <span>
                      <br />{t('stats.affinity')}：{ri.affinity}{ri.mood ? ` · ${t('stats.mood')}：${ri.mood}` : ''}
                      {ri.relation ? ` · ${t('stats.relation')}：${RELATION_LABELS[normalizeRelation(ri.relation) as keyof typeof RELATION_LABELS] || ri.relation}` : ''}
                    </span>
                  )}
                </div>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: 'var(--color-panel-alt)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${(s.tokens / maxTokens) * 100}%`,
                    height: '100%',
                    background: 'var(--color-primary)',
                    transition: 'width var(--transition)',
                  }}
                />
              </div>
            </div>
          )})}

          {/* ===== 聊天模型调用量排名（按 token 从高到低）===== */}
          <div style={{ marginTop: 24, marginBottom: 8, fontWeight: 700, fontSize: 14 }}>{t('stats.modelRank')}</div>
          {modelStats.length === 0 ? (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
              {t('stats.modelEmpty')}
            </div>
          ) : (
            modelStats.map((m) => (
              <div key={m.modelId} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <div style={{ fontWeight: 600, minWidth: 80, fontSize: 13 }}>{m.name}</div>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 12, flex: 1, lineHeight: 1.5 }}>
                    {t('stats.tokens')}：{m.tokens} · {t('stats.modelCalls', { n: m.calls })}
                  </div>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: 'var(--color-panel-alt)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${(m.tokens / maxModelTokens) * 100}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #7c6cf0, #4fc3f7)',
                      transition: 'width var(--transition)',
                    }}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
