// 「捉宠角色」面板（V3）
//
// 职责：管理桌面角色（添加 / 导入 / 删除 / 桌面显示 / 自主行为 / 气泡 / 绑定对话 / 舞台入口）。
//
// 素材链路的落点：
// - 导入走主进程（解压 zip、递归复制文件夹、识别入口文件），素材存到 <数据目录>/characters/<id>/；
// - 渲染统一走 nychar:// 私有协议，界面只认 DesktopCharacter.entry；
// - Live2D / 3D 的真实渲染由 ModelView 分发（图片与原创占位直接渲染，3D/Live2D 按需加载运行时）。
//
// 合规：默认角色为原创几何占位；软件不内置任何第三方角色素材，导入内容由用户自备并自负授权。
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './Toast';
import type { CharacterRuntimeSettings, ChatListItem, DesktopCharacter } from '../types';
import { PlaceholderCharacter } from '../character/PlaceholderCharacter';
import { CharacterStage } from './CharacterStage';

interface Snapshot {
  runtime: CharacterRuntimeSettings;
  characters: DesktopCharacter[];
  active: DesktopCharacter | null;
}

const DEFAULT_RUNTIME: CharacterRuntimeSettings = {
  enabled: false,
  x: 0,
  y: 0,
  alwaysOnTop: true,
  passThroughLocked: false,
  activeId: '',
};

export const CharacterCollection: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [snap, setSnap] = useState<Snapshot>({ runtime: DEFAULT_RUNTIME, characters: [], active: null });
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [stageChar, setStageChar] = useState<DesktopCharacter | null>(null);
  const [rtStatus, setRtStatus] = useState<{ dir: string; cubism4: boolean; cubism2: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.dcGetState();
    setSnap({ runtime: s.runtime || DEFAULT_RUNTIME, characters: s.characters || [], active: s.active });
    setRtStatus(await api.dcRuntimeStatus().catch(() => null));
  }, []);

  useEffect(() => {
    void refresh();
    api.getChatList().then((list) => setChats(list || []));
    const off = api.onDcState(() => void refresh());
    const offSettings = api.onSettingsChanged(() => void refresh());
    return () => {
      off();
      offSettings();
    };
  }, [refresh]);

  const persist = useCallback(
    async (next: DesktopCharacter[]) => {
      await api.saveSettings({ desktopCharacters: next });
      await refresh();
    },
    [refresh]
  );

  const addPlaceholder = useCallback(async () => {
    const c: DesktopCharacter = {
      id: `dc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: t('characters.placeholderName'),
      kind: 'placeholder',
      files: [],
      boundChat: null,
      enabled: true,
      scale: 1,
      behavior: true,
      bubble: true,
    };
    await persist([...snap.characters, c]);
    showToast(t('characters.added', { name: c.name }));
  }, [persist, snap.characters, showToast, t]);

  const patchCharacter = useCallback(
    async (id: string, patch: Partial<DesktopCharacter>) => {
      await persist(snap.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    },
    [persist, snap.characters]
  );

  const removeCharacter = useCallback(
    async (id: string) => {
      // 主进程一并删掉磁盘上的素材目录，避免留孤儿文件
      await api.dcDeleteCharacter(id);
      await refresh();
    },
    [refresh]
  );

  /** 导入：文件（zip/模型/图片，可多选）或整个文件夹 */
  const doImport = async (mode: 'file' | 'folder') => {
    const res = await api.dcPickImport(mode);
    if (res.canceled) return;
    const ok = res.results.filter((r) => r.ok);
    const bad = res.results.filter((r) => !r.ok);
    if (ok.length) showToast(t('characters.importOk', { n: String(ok.length) }));
    if (bad.length) {
      const reason = bad[0].error === 'no_model' ? t('characters.errNoModel') : t('characters.errImport');
      showToast(`${bad[0].name}：${reason}`, { error: true, duration: 5000 });
    }
    await refresh();
  };

  const bindValue = (c: DesktopCharacter): string => (c.boundChat ? `${c.boundChat.type}:${c.boundChat.id}` : '');

  const onBind = (c: DesktopCharacter, value: string) => {
    if (!value) {
      void patchCharacter(c.id, { boundChat: null });
      return;
    }
    const [type, ...rest] = value.split(':');
    const id = rest.join(':');
    const chat = chats.find((x) => x.chat_type === type && x.chat_id === id);
    void patchCharacter(c.id, {
      boundChat: { type: type === 'group' ? 'group' : 'single', id, name: chat?.chat_name || chat?.name || id },
    });
  };

  const kindLabel = (k: DesktopCharacter['kind']): string => {
    if (k === 'placeholder') return t('characters.kindPlaceholder');
    if (k === 'image' || k === 'sprite') return t('characters.kindImage');
    if (k === 'live2d') return t('characters.kindLive2d');
    return t('characters.kindVrm');
  };

  return (
    <div className="main-pane dc-coll">
      <div className="dc-coll-head">
        <div className="dc-coll-head-text">
          <div className="dc-coll-title">{t('characters.title')}</div>
          <div className="dc-coll-desc">{t('characters.desc')}</div>
        </div>
        <div className="dc-coll-actions">
          <button className="btn-primary" onClick={() => void addPlaceholder()}>
            ＋ {t('characters.addPlaceholder')}
          </button>
          <button className="btn-ghost" onClick={() => void doImport('file')}>
            {t('characters.importFile')}
          </button>
          <button className="btn-ghost" onClick={() => void doImport('folder')}>
            {t('characters.importFolder')}
          </button>
        </div>
      </div>

      <div className="dc-coll-runtime">
        <label className="dc-coll-switch">
          <input
            type="checkbox"
            checked={snap.runtime.enabled}
            onChange={(e) => api.dcSetEnabled(e.target.checked)}
          />
          {t('characters.showOnDesktop')}
        </label>
        {snap.runtime.passThroughLocked && (
          <button className="btn-ghost dc-coll-unlock" onClick={() => api.dcSetPassThroughLock(false)}>
            {t('characters.lockUnlock')}
          </button>
        )}
        <span className="dc-coll-hint">{t('characters.importHint')}</span>
      </div>

      <div className="dc-coll-runtime dc-coll-runtime-tight">
        <span className="muted">
          {t('characters.runtimeLabel')}：
          {rtStatus?.cubism4 ? t('characters.runtimeOk') : t('characters.runtimeMissing')}
        </span>
        <button className="btn-ghost dc-coll-unlock" onClick={() => void api.dcOpenRuntimeDir()}>
          {t('characters.openRuntimeDir')}
        </button>
        {!rtStatus?.cubism4 && <span className="dc-coll-hint">{t('characters.runtimeHint')}</span>}
      </div>

      {snap.characters.length === 0 ? (
        <div className="dc-coll-empty">{t('characters.empty')}</div>
      ) : (
        <div className="dc-coll-grid">
          {snap.characters.map((c) => {
            const isActive = snap.runtime.activeId ? snap.runtime.activeId === c.id : snap.active?.id === c.id;
            // 网格里只有占位/图片直接渲染；3D 与 Live2D 放进舞台预览，避免一屏几十个 WebGL 上下文
            const lightPreview = c.kind === 'placeholder' || c.kind === 'image' || c.kind === 'sprite';
            return (
              <div className={`dc-coll-card${isActive ? ' active' : ''}`} key={c.id}>
                <div className="dc-coll-preview">
                  {lightPreview ? (
                    <div className="dc-coll-mini">
                      {c.kind === 'placeholder' ? (
                        <PlaceholderCharacter expression="neutral" blink={false} eyeX={0} eyeY={0} dragging={false} />
                      ) : (
                        <img
                          src={`nychar://model/${c.id}/${(c.entry || c.files?.[0] || '')
                            .split('/')
                            .filter(Boolean)
                            .map(encodeURIComponent)
                            .join('/')}`}
                          alt={c.name}
                          draggable={false}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="dc-coll-format">
                      <span className="dc-coll-format-icon">◈</span>
                      <span>{kindLabel(c.kind)}</span>
                    </div>
                  )}
                  <span className="dc-coll-badge">{kindLabel(c.kind)}</span>
                </div>
                <div className="dc-coll-body">
                  <input
                    className="dc-coll-name"
                    value={c.name}
                    onChange={(e) => void patchCharacter(c.id, { name: e.target.value })}
                  />
                  <div className="dc-coll-toggles">
                    <label>
                      <input type="checkbox" checked={c.enabled} onChange={(e) => void patchCharacter(c.id, { enabled: e.target.checked })} />
                      {t('characters.enabled')}
                    </label>
                    <label>
                      <input type="checkbox" checked={c.behavior} onChange={(e) => void patchCharacter(c.id, { behavior: e.target.checked })} />
                      {t('characters.behavior')}
                    </label>
                    <label>
                      <input type="checkbox" checked={c.bubble} onChange={(e) => void patchCharacter(c.id, { bubble: e.target.checked })} />
                      {t('characters.bubble')}
                    </label>
                  </div>
                  <div className="dc-coll-bind">
                    <span className="muted">{t('characters.bind')}</span>
                    <select value={bindValue(c)} onChange={(e) => onBind(c, e.target.value)}>
                      <option value="">{t('characters.unbound')}</option>
                      {chats.map((ch) => (
                        <option key={`${ch.chat_type}:${ch.chat_id}`} value={`${ch.chat_type}:${ch.chat_id}`}>
                          {ch.chat_name || ch.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="dc-coll-foot">
                    <button className="btn-ghost" onClick={() => api.dcSetActive(c.id)} disabled={isActive}>
                      {isActive ? t('characters.active') : t('characters.setActive')}
                    </button>
                    <button className="btn-ghost" onClick={() => setStageChar(c)}>
                      {t('characters.stage')}
                    </button>
                    <button className="btn-ghost dc-coll-del" onClick={() => void removeCharacter(c.id)}>
                      {t('characters.delete')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="dc-coll-legal">{t('characters.legal')}</div>

      {stageChar && <CharacterStage character={stageChar} onClose={() => setStageChar(null)} />}
    </div>
  );
};

export default CharacterCollection;
