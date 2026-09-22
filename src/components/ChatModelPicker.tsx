import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { ModelConfig } from '../types';
import { PROVIDER_DEFAULTS } from '../types';

// 聊天模型切换（v2.3.41，仅单聊）：
// 人物编辑中绑定的模型 = 该人物聊天的默认模型；其他操作菜单可勾选「跟随人物（或默认）模型」——
// 勾选时使用人物绑定模型（无则默认模型）且不可更改；取消勾选后可仅为本聊天选择其他模型，
// 覆盖存 settings.chatModels["single:roleId"]，该人物的其他聊天不受影响。群聊成员各有模型，不提供覆盖。
export const ChatModelPicker: React.FC<{ chatType: string; chatId: string }> = ({ chatType, chatId }) => {
  const { t } = useI18n();
  const key = `${chatType}:${chatId}`;
  const [map, setMap] = useState<Record<string, { follow?: boolean; modelId?: string }>>({});
  const [follow, setFollow] = useState(true);
  const [modelId, setModelId] = useState<string>('');
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [list, setList] = useState<ModelConfig[]>([]);
  const [q, setQ] = useState('');
  const [loaded, setLoaded] = useState(false);

  // 载入本聊天的覆盖记录与模型列表（切换聊天时重新载入）
  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        const m = s.chatModels || {};
        const ov = m[key];
        setMap(m);
        setFollow(ov ? ov.follow !== false : true);
        setModelId(ov && ov.follow === false ? ov.modelId || '' : '');
        setModels(s.models || []);
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);

  // 提供方显示名（与设置页 providerLabel 一致）
  const providerLabel = (p: string) =>
    p === 'custom' ? t('model.providerCustom') : PROVIDER_DEFAULTS[p as keyof typeof PROVIDER_DEFAULTS]?.label || p;

  // 勾选=删除覆盖记录（回退人物绑定模型）；取消勾选=本聊天固定用自选模型
  const save = async (nextFollow: boolean, nextId?: string) => {
    const next = { ...map };
    if (nextFollow) delete next[key];
    else next[key] = { follow: false, modelId: nextId };
    setMap(next);
    setFollow(nextFollow);
    setModelId(nextFollow ? '' : nextId || '');
    await api.saveSettings({ chatModels: next });
  };

  const openPicker = async (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 320)),
      top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 360)),
    });
    setQ('');
    try {
      const s = await api.getSettings();
      setList((s.models || []).filter((m) => m.enabled));
    } catch {
      setList([]);
    }
    setOpen(true);
  };

  // 模糊搜索：多词 AND，前缀命中 > 包含命中 > 全词组命中；大小写不敏感。
  // 匹配 API 配置名称（name）与模型名称（model），另附提供方名（与设置页模型搜索同口径）。
  const results = (() => {
    const raw = q.toLowerCase().trim();
    if (!raw) return [];
    const tokens = raw.split(/\s+/).filter(Boolean);
    return list
      .map((m) => {
        const hay = [m.name, m.model, providerLabel(m.provider)].join(' ').toLowerCase();
        let score = -1;
        if (m.name.toLowerCase().startsWith(raw)) score = 100;
        else if (hay.includes(raw)) score = 80;
        if (score < 0 && tokens.every((tk) => hay.includes(tk))) score = 60;
        return { m, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name))
      .slice(0, 8)
      .map((x) => x.m);
  })();

  // 与设置内搜索一致：点击搜索结果 → 关闭搜索、列表滚动到对应模型并高亮闪动约 3 秒
  const jumpTo = (id: string) => {
    setQ('');
    requestAnimationFrame(() => {
      const el = document.getElementById(`chat-model-item-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.classList.remove('model-flash');
        void el.offsetWidth; // 触发重排以重启动画
        el.classList.add('model-flash');
        window.setTimeout(() => el.classList.remove('model-flash'), 3200);
      }
    });
  };

  if (chatType !== 'single') return null;

  return (
    <>
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
        title={t('chat.followRoleModelHint')}
      >
        <input type="checkbox" checked={follow} disabled={!loaded} onChange={(e) => save(e.target.checked)} />
        🧩 {t('chat.followRoleModel')}
      </label>
      {!follow && (
        <button
          className="tool-btn"
          style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
          onClick={(e) => openPicker(e)}
        >
          🤖 {t('chat.chatModel')}
          {modelId ? `：${models.find((m) => m.id === modelId)?.name || modelId}` : ''}
        </button>
      )}
      {open &&
        createPortal(
          <div style={{ position: 'fixed', inset: 0, zIndex: 2147483645 }} onMouseDown={() => setOpen(false)}>
            <div
              style={{
                position: 'fixed', left: pos.left, top: pos.top, width: 300,
                zIndex: 2147483646, background: 'var(--color-background-primary)',
                border: '1px solid var(--color-border)', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 8, color: 'var(--color-text)',
                display: 'flex', flexDirection: 'column', maxHeight: 340, boxSizing: 'border-box',
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('chat.modelSearchPlaceholder')}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13, marginBottom: 6,
                  border: '1px solid var(--color-border)', borderRadius: 6,
                  background: 'var(--color-background-secondary)', color: 'var(--color-text)',
                }}
              />
              {q.trim() && (
                <div
                  style={{
                    border: '1px solid var(--color-border)', borderRadius: 6, maxHeight: 150,
                    overflowY: 'auto', marginBottom: 6, background: 'var(--color-background-secondary)',
                  }}
                >
                  {results.map((m) => (
                    <div
                      key={m.id}
                      className="ctx-menu-item"
                      style={{ fontSize: 12, padding: '5px 8px', cursor: 'pointer' }}
                      onClick={() => jumpTo(m.id)}
                      title={`${m.name} · ${providerLabel(m.provider)} · ${m.model}`}
                    >
                      <b>{m.name}</b> <span style={{ opacity: 0.6 }}>· {m.model}</span>
                    </div>
                  ))}
                  {results.length === 0 && (
                    <div style={{ fontSize: 12, padding: '6px 8px', opacity: 0.6 }}>{t('chat.noMatchModel')}</div>
                  )}
                </div>
              )}
              <div style={{ overflowY: 'auto', maxHeight: 220 }}>
                {list.map((m) => (
                  <div
                    key={m.id}
                    id={`chat-model-item-${m.id}`}
                    className="ctx-menu-item"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 8px',
                      cursor: 'pointer', borderRadius: 6, fontWeight: m.id === modelId ? 600 : 400,
                    }}
                    onClick={() => { save(false, m.id); setOpen(false); }}
                    title={`${m.name} · ${providerLabel(m.provider)} · ${m.model}`}
                  >
                    <span style={{ flexShrink: 0, width: 14 }}>{m.id === modelId ? '✓' : ''}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.name} <span style={{ opacity: 0.55 }}>· {providerLabel(m.provider)}</span>
                    </span>
                  </div>
                ))}
                {list.length === 0 && (
                  <div style={{ fontSize: 12, padding: '6px 8px', opacity: 0.6 }}>{t('chat.noMatchModel')}</div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
