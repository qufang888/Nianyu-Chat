// 「桌宠角色」面板（V3）
//
// 职责：管理桌面角色（添加 / 导入 / 删除 / 桌面显示 / 自主行为 / 气泡 / 绑定对话 / 舞台入口）。
//
// 素材链路的落点：
// - 导入走主进程（解压 zip、递归复制文件夹、识别入口文件），素材存到 <数据目录>/characters/<id>/；
// - 渲染统一走 nychar:// 私有协议，界面只认 DesktopCharacter.entry；
// - Live2D / 3D 的真实渲染由 ModelView 分发（图片与原创占位直接渲染，3D/Live2D 按需加载运行时）。
//
// 合规：默认角色为原创几何占位；软件不内置任何第三方角色素材，导入内容由用户自备并自负授权。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './Toast';
import type { CharacterRuntimeSettings, ChatListItem, DesktopCharacter } from '../types';
import { PlaceholderCharacter } from '../character/PlaceholderCharacter';
import { CharacterStage } from './CharacterStage';
import {
  normalizeSpeakRate,
  normalizeSpeakRateUnit,
  rateForUnit,
  rateMaxForUnit,
  rateToPerMinute,
  type SpeakRateUnit,
} from '../utils/lineSchedule';

/** 频率达到该值时数值转警示色并追加成本提示（只讲成本，不讲"实际速率"）。 */
const SPEAK_RATE_WARN_THRESHOLD = 20;

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

interface CharacterCollectionProps {
  /** 角色窗右键「打开角色舞台」带来的请求（含 nonce：同一角色可重复打开）。 */
  stageRequest?: { id: string; nonce: number } | null;
}

export const CharacterCollection: React.FC<CharacterCollectionProps> = ({ stageRequest }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [snap, setSnap] = useState<Snapshot>({ runtime: DEFAULT_RUNTIME, characters: [], active: null });
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [stageChar, setStageChar] = useState<DesktopCharacter | null>(null);
  const [rtStatus, setRtStatus] = useState<{ dir: string; cubism4: boolean; cubism2: boolean } | null>(null);
  const lastStageNonceRef = useRef(0);
  /** v3.0.4：频率单位（分钟/小时/天）为视图偏好，真源仍是条/分钟；缺省分钟，存量行为不变。 */
  const [rateUnit, setRateUnit] = useState<SpeakRateUnit>('min');

  const refresh = useCallback(async () => {
    const s = await api.dcGetState();
    setSnap({ runtime: s.runtime || DEFAULT_RUNTIME, characters: s.characters || [], active: s.active });
    setRtStatus(await api.dcRuntimeStatus().catch(() => null));
  }, []);

  useEffect(() => {
    void refresh();
    api.getChatList().then((list) => setChats(list || []));
    const off = api.onDcState(() => void refresh());
    // v3.0.4：舞台拖动时的「仅 scale 变化」广播无需刷新整个快照（舞台已本地回声同步），
    // 跳过它能避免高频重渲染，进一步降低缩放期间舞台被误关/闪烁的概率。
    const offSettings = api.onSettingsChanged((_e: any, patch: any) => {
      const keys = patch && typeof patch === 'object' ? Object.keys(patch) : [];
      if (keys.length === 1 && keys[0] === 'desktopCharacters') {
        const list = patch.desktopCharacters;
        if (Array.isArray(list) && list.length > 0 && list.every((c: any) => c && typeof c === 'object')) {
          const changed = Object.keys(list[0]).filter((k) => k !== 'id');
          if (changed.length === 1 && changed[0] === 'scale') return;
        }
      }
      void refresh();
    });
    return () => {
      off();
      offSettings();
    };
  }, [refresh]);

  // Bug 1：角色窗右键「打开角色舞台」→ 本面板自动打开该角色的 CharacterStage。
  // 依赖 nonce（而非 id）保证同一角色重复点击也能再次打开；用 ref 去重避免 refresh 重跑时
  // 反复重置用户已手动关闭的舞台。角色列表异步到达时，snap.characters 变化会重试直至命中。
  //
  // P2-1：stageRequest 被清空（如右键「管理角色」，App.tsx 会 setDcStageRequest(null)）时，
  // 必须同时关掉已打开的 CharacterStage。否则面板不重挂载、stageChar 仍非 null，
  // 舞台会继续盖在面板上，表现为「点管理角色却停在角色舞台」。
  // v3.0.4 P1：把「撤销即关闭」与「列表到达才打开」拆成两个 effect。
  // 旧实现把两者塞进同一个 [stageRequest, snap.characters] effect，
  // 而缩放提交会全局广播 settings:changed ⇒ refresh() ⇒ snap.characters 换新数组 ⇒ effect 重跑，
  // 于是「拖动舞台滑块」竟会执行 setStageChar(null) ⇒ 舞台窗口突然消失。
  // 拆开后：关闭只认 stageRequest（不再被 snap.characters 碰动）；打开由 pending ref 承接异步列表。
  const pendingStageIdRef = useRef<string | null>(null);

  // (a) 只负责「撤销请求 → 关闭舞台」，只依赖 stageRequest
  useEffect(() => {
    if (!stageRequest || !stageRequest.id) {
      lastStageNonceRef.current = 0; // 允许同 nonce 之后重开
      pendingStageIdRef.current = null;
      setStageChar(null);
    } else if (stageRequest.nonce !== lastStageNonceRef.current) {
      // (b) 只负责登记待打开的新请求
      pendingStageIdRef.current = stageRequest.id;
    }
  }, [stageRequest]);

  // (c) 只负责「快照到达 → 兑现待打开」，依赖 snap.characters 但绝不 setStageChar(null)
  useEffect(() => {
    const id = pendingStageIdRef.current;
    if (!id) return;
    const c = snap.characters.find((x) => x.id === id);
    if (!c) return; // 快照还没到，等下次 refresh
    pendingStageIdRef.current = null;
    lastStageNonceRef.current = stageRequest?.nonce ?? 0;
    setStageChar(c);
  }, [snap.characters, stageRequest?.nonce]);

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
            // 频率缺省回落 2 条/分（与主进程护栏同值），保证老角色升级后行为不回退
            const rate = normalizeSpeakRate(c.speakRate);
            // v3.0.4：按当前单位换算显示值；真源 rate 恒为条/分钟
            const displayRate = rateForUnit(rate, rateUnit);
            const displayMax = rateMaxForUnit(rateUnit);
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
                      <input
                        type="checkbox"
                        checked={c.enabled && snap.runtime.enabled}
                        disabled={!snap.runtime.enabled}
                        onChange={(e) => void patchCharacter(c.id, { enabled: e.target.checked })}
                      />
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
                  {/* v3.0.4：主动说话频率，支持分钟/小时/天三种单位。
                      真源仍是条/分钟（DesktopCharacter.speakRate），单位只是视图换算；
                      0 = 完全不主动说话。写入走 patchCharacter（整数组覆盖）。 */}
                  <div className="dc-coll-rate">
                    <div className="dc-coll-rate-head">
                      <span className="dc-coll-rate-label">{t('characters.speakRate')}</span>
                      <select
                        className="dc-coll-rate-unit"
                        value={rateUnit}
                        aria-label={t('characters.speakRateUnitLabel')}
                        onChange={(e) => setRateUnit(normalizeSpeakRateUnit(e.target.value))}
                      >
                        <option value="min">{t('characters.speakRateUnitMin')}</option>
                        <option value="hour">{t('characters.speakRateUnitHour')}</option>
                        <option value="day">{t('characters.speakRateUnitDay')}</option>
                      </select>
                      <span
                        className={`dc-coll-rate-value${rate >= SPEAK_RATE_WARN_THRESHOLD ? ' warn' : ''}`}
                      >
                        {rate === 0
                          ? t('characters.speakRateOff')
                          : t('characters.speakRateUnit', { n: String(displayRate), unit: t(`characters.speakRateUnit${rateUnit === 'min' ? 'Min' : rateUnit === 'hour' ? 'Hour' : 'Day'}`) })}
                      </span>
                    </div>
                    <input
                      className="dc-coll-rate-range"
                      type="range"
                      min={0}
                      max={displayMax}
                      step={1}
                      value={displayRate}
                      aria-label={t('characters.speakRate')}
                      // 滚轮在滑块上不得改数值（避免与页面滚动打架）
                      onWheel={(e) => e.preventDefault()}
                      onChange={(e) =>
                        void patchCharacter(c.id, {
                          // 把当前单位下的整数值换算回条/分钟真源（共享函数，精度归一）
                          speakRate: rateToPerMinute(Number(e.target.value), rateUnit),
                        })
                      }
                    />
                    <div className="dc-coll-rate-hint">{t('characters.speakRateHint')}</div>
                    {rate >= SPEAK_RATE_WARN_THRESHOLD && (
                      <div className="dc-coll-rate-warn">{t('characters.speakRateWarn')}</div>
                    )}
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
