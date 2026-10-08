import React, { useEffect, useMemo, useState } from 'react';
import { TTS_PROVIDERS, type MediaApiConfig } from '../types';
import { useI18n } from '../i18n/I18nContext';
import ComboBox from './ComboBox';
import { Hint } from './Hint';

/**
 * 多媒体 API 配置编辑器（TTS / ASR / 生图 / 生视频共用，需求 7 / v2.3.94）
 * ============================================================================
 * 背景：此前四类服务的 API 端点都是「扁平字段 + 单份表单」，用户只能填一套
 * Base URL / API Key / 模型，想同时挂两个（主号 + 备用、或两个不同厂商）就必须
 * 来回改写、改了 A 就丢了 B。本组件把这四类统一成与「文本模型」一致的
 * 「多条配置 + 标记当前使用项」交互。
 *
 * 设计约定（与 electron/db.ts 的迁移逻辑严格对齐，**不要单方面改**）：
 *   1. **多配置数组是唯一真源**。主进程每次 saveSettings 后都会调
 *      syncActiveMediaConfigs()，把「当前启用项」回写进扁平兼容字段
 *      （voice.ttsBaseUrl / imageGen.baseUrl …），因此后端调用点无需改动。
 *   2. `activeId` 指向的那一条就是当前生效配置；删除该项后自动回落到第一条。
 *   3. 生图 / 生视频的 provider 固定 'custom'（无协议识别需求）；
 *      TTS / ASR 用下拉选 TTS_PROVIDERS（Base URL 命中哪个协议由主进程识别，
 *      这里只是给用户一个「我以为在用谁」的显式标注）。
 *
 * 可访问性 / 主题约束（用户铁律）：
 *   - 颜色一律走 `var(--color-*)` 变量，14 套主题下都由 variables.css 兜底，
 *     对比度随主题走，不在此处硬编码任何色值；
 *   - 展开/收起的过渡与入场动画走 CSS 类 `.media-cfg-card` / `.media-cfg-body`，
 *     已登记到 src/utils/animControl.ts 的 `theme` 分组，受三档动效开关统一管控，
 *     **不写裸 inline transition**；
 *   - 关键操作（设为当前 / 展开编辑 / 删除）都是真正的 <button> / <input>，
 *     带 title 与 aria-label，键盘可达。
 */

/** 四类服务的类型标识 */
export type MediaApiKind = 'tts' | 'asr' | 'image' | 'video';

/**
 * 各服务的配置 id 前缀 —— 必须与 electron/db.ts 的 newMediaConfigId() 口径一致
 * （db 侧迁移老配置时也用这些前缀，肉眼可辨、便于排查 settings.json）。
 */
const ID_PREFIX: Record<MediaApiKind, string> = {
  tts: 'tts',
  asr: 'asr',
  image: 'img',
  video: 'vid',
};

/** 生成配置 id：`前缀_时间戳36进制_随机数36进制`（与 db.ts newMediaConfigId 同构） */
function newConfigId(kind: MediaApiKind): string {
  return `${ID_PREFIX[kind]}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 四类服务新建配置时的出厂默认值（用户只需改 Base URL / Key / 模型） */
function blankConfig(kind: MediaApiKind): MediaApiConfig {
  const base: MediaApiConfig = {
    id: newConfigId(kind),
    name: '',
    provider: 'custom',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  };
  if (kind === 'tts') base.voice = '';
  if (kind === 'image') base.size = '1024x1024';
  if (kind === 'video') {
    base.size = '1280x720';
    base.duration = 5;
  }
  return base;
}

/** 复制配置：字段全带走，仅换 id 与名称后缀（用于「主号 → 备用」） */
function duplicateConfig(src: MediaApiConfig, kind: MediaApiKind, copySuffix: string): MediaApiConfig {
  return { ...src, id: newConfigId(kind), name: `${src.name || copySuffix}` };
}

/**
 * 取「该展示给用户的多配置列表」。
 *
 * 正常情况下直接返回多配置数组；但**数组为空而扁平兼容字段有内容**时
 * （老版本从未迁移、或用户只在别的入口改过扁平字段），合成一条临时项展示，
 * 否则用户会看到空列表，以为自己的配置丢了。合成项的 id 用 'legacy' ——
 * 与 electron/db.ts 的 resolveMediaConfig() 兜底口径一致，两边不会各造一个 id。
 *
 * 合成项的 name 故意留空：UI 会用 i18n 默认名渲染，避免把中文写进 settings.json。
 */
export function resolveMediaConfigs(
  list: MediaApiConfig[] | undefined,
  flat: Partial<MediaApiConfig>,
  activeId: string | undefined
): MediaApiConfig[] {
  if (Array.isArray(list) && list.length > 0) return list;
  if (!(flat.baseUrl || flat.apiKey || flat.model)) return [];
  return [
    {
      id: activeId || 'legacy',
      name: '',
      provider: flat.provider || 'custom',
      baseUrl: flat.baseUrl || '',
      apiKey: flat.apiKey || '',
      model: flat.model || '',
      enabled: true,
      voice: flat.voice,
      size: flat.size,
      duration: flat.duration,
    },
  ];
}

export interface MediaApiConfigEditorProps {
  /** 服务类型：决定 id 前缀、默认值、可选字段（音色 / 尺寸 / 时长）与 provider 是否可选 */
  kind: MediaApiKind;
  /** 区块锚点 id（供设置搜索跳转用；通常传 'sec-tts' / 'sec-asr' / 'sec-imgcfg' / 'sec-vidcfg'） */
  sectionId?: string;
  /** 区块标题 i18n key */
  titleKey: string;
  /** 区块说明（Hint 气泡）i18n key */
  hintKey?: string;
  /** 当前配置列表（受控） */
  configs: MediaApiConfig[];
  /** 当前启用项 id；空=用列表第一条 */
  activeId?: string;
  /** 变更回调：一次性回传整个列表与新的activeId */
  onChange: (next: { configs: MediaApiConfig[]; activeId: string }) => void;
  /** 是否显示「默认音色」字段（仅 TTS） */
  showVoiceList?: boolean;
  /** 是否显示「时长（秒）」字段（仅生视频） */
  showDuration?: boolean;
  /** 「生成尺寸」字段的标题 key（生图 / 生视频） */
  sizeLabelKey?: string;
  /** 「生成尺寸」字段的说明 key */
  sizeHintKey?: string;
  /** 模型名输入框的占位 i18n key */
  modelPlaceholderKey?: string;
  /** 模型名下拉建议（由「刷新模型列表」按钮拉取后传入） */
  modelOptions?: string[];
  /** 点「刷新模型列表」时回调（由父组件发起 IPC） */
  onRefreshModels?: (cfg: MediaApiConfig) => void;
  /** 刷新中（按钮转圈 / 禁用） */
  refreshing?: boolean;
  /** 音色下拉建议（TTS） */
  voiceOptions?: string[];
  /** 可选的绑定来源（TTS 按角色音色时用：列出全部 TTS 配置供人物绑定） */
  roleBind?: boolean;
}

/**
 * 多配置编辑器主体。
 *
 * 受控组件：自身只持有「哪一条处于展开编辑态」这一份 UI 状态，
 * 所有数据变更都通过 onChange 上抛，由 Settings.tsx 负责落盘。
 */
export const MediaApiConfigEditor: React.FC<MediaApiConfigEditorProps> = ({
  kind,
  sectionId,
  titleKey,
  hintKey,
  configs,
  activeId,
  onChange,
  showVoiceList = false,
  showDuration = false,
  sizeLabelKey,
  sizeHintKey,
  modelPlaceholderKey,
  modelOptions = [],
  onRefreshModels,
  refreshing = false,
  voiceOptions = [],
  roleBind = false,
}) => {
  const { t } = useI18n();
  /** 展开编辑中的配置 id；null=全部收起 */
  const [editingId, setEditingId] = useState<string | null>(null);

  // 列表被外部替换（如重置设置 / 导入）后，若正在编辑的那条已不存在，自动收起，
  // 否则展开态会挂在一条看不见的行上，用户以为「编辑按钮坏了」。
  useEffect(() => {
    if (editingId && !configs.some((c) => c.id === editingId)) setEditingId(null);
  }, [configs, editingId]);

  /** 当前生效项：优先 activeId 命中的那条，否则回落到第一条 */
  const currentId = useMemo(() => {
    if (activeId && configs.some((c) => c.id === activeId)) return activeId;
    return configs[0]?.id || '';
  }, [activeId, configs]);

  /** 以「列表 + 当前项」为单位回抛，保证父组件永远拿到一致的一对数据 */
  const emit = (nextConfigs: MediaApiConfig[], nextActiveId?: string) => {
    const list = nextConfigs.filter((c) => !!c && !!c.id);
    const resolvedActive =
      nextActiveId && list.some((c) => c.id === nextActiveId) ? nextActiveId : list[0]?.id || '';
    onChange({ configs: list, activeId: resolvedActive });
  };

  /** 按 id 局部更新一条配置（其余字段与顺序原样保留） */
  const patchOne = (id: string, patch: Partial<MediaApiConfig>) => {
    emit(
      configs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      currentId
    );
  };

  /** 新增一条并立即展开编辑、设为当前使用（新增即「正在配」，少一次点击） */
  const handleAdd = () => {
    const cfg = blankConfig(kind);
    const list = [...configs, cfg];
    emit(list, cfg.id);
    setEditingId(cfg.id);
  };

  /** 复制一条：插到原条目之后，字段全带过来，命名为「xxx 副本」 */
  const handleDuplicate = (src: MediaApiConfig) => {
    const copy = duplicateConfig(src, kind, t('settings.mcfg.copySuffix'));
    const idx = configs.findIndex((c) => c.id === src.id);
    const list = [...configs];
    list.splice(idx + 1, 0, copy);
    emit(list, copy.id);
    setEditingId(copy.id);
  };

  /** 删除一条：删掉的若是当前项，自动回落到第一条（emit 内部已处理） */
  const handleDelete = (id: string) => {
    emit(configs.filter((c) => c.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const showSize = kind === 'image' || kind === 'video';
  const providerSelectable = kind === 'tts' || kind === 'asr';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
      {/* ===== 区块标题（带锚点，供设置搜索跳转 + 高亮闪动） ===== */}
      <div id={sectionId} className="section-title">
        {t(titleKey)}
        {hintKey ? <Hint text={t(hintKey)} /> : null}
      </div>

      {/* 交互说明：把「多条配置 + 切换」这件事说清楚，避免用户以为只能填一条 */}
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
        {t('settings.mcfg.hint')}
      </div>

      {/* ===== 顶部工具条：配置条数 + 添加按钮 ===== */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn-primary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={handleAdd}>
          {t('settings.mcfg.add')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {t('settings.mcfg.count', { n: configs.length })}
        </span>
      </div>

      {/* ===== 空态==== */}
      {configs.length === 0 && (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-panel-alt)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 10px',
          }}
        >
          {t('settings.mcfg.empty')}
        </div>
      )}

      {/* ===== 配置列表 ===== */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {configs.map((c) => {
          const isCurrent = c.id === currentId;
          const isEditing = c.id === editingId;
          const rowId = `media-cfg-${kind}-${c.id}`;
          return (
            <div
              key={c.id}
              className="media-cfg-card"
              style={{
                border: isCurrent ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-panel-alt)',
                padding: '8px 10px',
              }}
            >
              {/* ---- 列表行：当前使用标记 + 名称 + 模型 + 操作 ---- */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* 设为当前使用：真正的 radio（同组name 互斥），既是状态显示也是操作入口 */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: isCurrent ? 600 : 400,
                    color: isCurrent ? 'var(--color-primary-ink)' : 'var(--color-text)',
                    flex: '0 0 auto',
                  }}
                  title={t('settings.mcfg.setActive')}
                >
                  <input
                    type="radio"
                    name={`media-cfg-active-${kind}`}
                    checked={isCurrent}
                    aria-label={t('settings.mcfg.setActive')}
                    onChange={() => emit(configs, c.id)}
                  />
                  <span>{c.name || t('settings.mcfg.defaultName')}</span>
                </label>

                {isCurrent && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--color-primary-text)',
                      background: 'var(--color-primary)',
                      borderRadius: 8,
                      padding: '1px 7px',
                      flex: '0 0 auto',
                    }}
                  >
                    {t('settings.mcfg.active')}
                  </span>
                )}

                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--color-text-secondary)',
                    flex: 1,
                    minWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={c.baseUrl || undefined}
                >
                  {c.model || t('settings.mcfg.noModel')}
                </span>

                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '2px 8px', fontSize: 12, flex: '0 0 auto' }}
                  aria-expanded={isEditing}
                  onClick={() => setEditingId(isEditing ? null : c.id)}
                >
                  {isEditing ? t('settings.mcfg.collapse') : t('settings.mcfg.expand')}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '2px 8px', fontSize: 12, flex: '0 0 auto' }}
                  title={t('settings.mcfg.copy')}
                  onClick={() => handleDuplicate(c)}
                >
                  {t('common.copy')}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '2px 8px', fontSize: 12, flex: '0 0 auto', color: 'var(--color-danger)' }}
                  onClick={() => handleDelete(c.id)}
                >
                  {t('common.delete')}
                </button>
              </div>

              {/* 「已停用」提示：停用只影响「是否推荐使用」，已绑定该配置的人物音色仍可用 */}
              {c.enabled === false && (
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  {t('settings.mcfg.disabledHint')}
                </div>
              )}

              {/* ---- 展开编辑表单 ---- */}
              {isEditing && (
                <div
                  className="media-cfg-body"
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid var(--color-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {/* 名称 */}
                  <div className="field" style={{ maxWidth: 360 }}>
                    <label htmlFor={`${rowId}-name`}>{t('settings.mcfg.name')}</label>
                    <input
                      id={`${rowId}-name`}
                      type="text"
                      placeholder={t('settings.mcfg.namePh')}
                      value={c.name}
                      onChange={(e) => patchOne(c.id, { name: e.target.value })}
                    />
                  </div>

                  {/* 提供商 / 协议：生图生视频固定 custom，不给用户选错的机会 */}
                  {providerSelectable && (
                    <div className="field" style={{ maxWidth: 360 }}>
                      <label htmlFor={`${rowId}-provider`}>{t('settings.mcfg.provider')}</label>
                      <select
                        id={`${rowId}-provider`}
                        value={c.provider || 'custom'}
                        onChange={(e) => patchOne(c.id, { provider: e.target.value })}
                      >
                        <option value="custom">{t('settings.mcfg.providerCustom')}</option>
                        {TTS_PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.nameKey ? t(p.nameKey) : p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Base URL + API Key */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <div className="field" style={{ flex: 2, minWidth: 200 }}>
                      <label htmlFor={`${rowId}-base`}>{t('settings.mcfg.baseUrl')}</label>
                      <input
                        id={`${rowId}-base`}
                        type="text"
                        placeholder="https://api.openai.com/v1"
                        value={c.baseUrl}
                        onChange={(e) => patchOne(c.id, { baseUrl: e.target.value })}
                      />
                    </div>
                    <div className="field" style={{ flex: 1, minWidth: 140 }}>
                      <label htmlFor={`${rowId}-key`}>{t('settings.apiKey')}</label>
                      <input
                        id={`${rowId}-key`}
                        type="password"
                        placeholder={t('settings.apiKey')}
                        value={c.apiKey}
                        onChange={(e) => patchOne(c.id, { apiKey: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* 模型名（可手填也可从拉取列表里选） */}
                  <div className="field" style={{ maxWidth: 360 }}>
                    <label htmlFor={`${rowId}-model`}>{t('settings.mcfg.model')}</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <ComboBox
                        value={c.model}
                        style={{ flex: 1, minWidth: 140 }}
                        options={modelOptions}
                        placeholder={modelPlaceholderKey ? t(modelPlaceholderKey) : undefined}
                        onChange={(v) => patchOne(c.id, { model: v })}
                      />
                      {onRefreshModels && (
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '3px 10px', fontSize: 12 }}
                          disabled={refreshing}
                          onClick={() => onRefreshModels(c)}
                        >
                          {refreshing ? t('model.refreshing') : t('model.refreshModels')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 默认音色（仅 TTS） */}
                  {showVoiceList && (
                    <div className="field" style={{ maxWidth: 360 }}>
                      <label htmlFor={`${rowId}-voice`}>{t('settings.mcfg.defaultVoice')}</label>
                      <ComboBox
                        value={c.voice || ''}
                        style={{ width: '100%' }}
                        options={voiceOptions}
                        placeholder={t('settings.ttsVoicePh')}
                        onChange={(v) => patchOne(c.id, { voice: v })}
                      />
                    </div>
                  )}

                  {/* 生成尺寸（生图 / 生视频） */}
                  {showSize && (
                    <div className="field" style={{ maxWidth: 360 }}>
                      <label htmlFor={`${rowId}-size`}>{t(sizeLabelKey || 'settings.imageGenSize')}</label>
                      <input
                        id={`${rowId}-size`}
                        type="text"
                        placeholder={kind === 'image' ? '1024x1024' : '1280x720'}
                        value={c.size || ''}
                        onChange={(e) => patchOne(c.id, { size: e.target.value })}
                      />
                      {sizeHintKey ? (
                        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 3 }}>
                          {t(sizeHintKey)}
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* 时长（仅生视频） */}
                  {showDuration && (
                    <div className="field" style={{ maxWidth: 360 }}>
                      <label htmlFor={`${rowId}-duration`}>{t('settings.videoGenDuration')}</label>
                      <input
                        id={`${rowId}-duration`}
                        type="number"
                        min={1}
                        max={60}
                        step={1}
                        placeholder="5"
                        value={c.duration ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          // 留空 = 不限/沿用服务端默认，故用 undefined 而不是 0（0 会被 db 当成 falsy 丢弃）
                          patchOne(c.id, { duration: raw === '' ? undefined : Number(raw) });
                        }}
                      />
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 3 }}>
                        {t('settings.videoGenDurationDesc')}
                      </div>
                    </div>
                  )}

                  {/* 启用开关 */}
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={c.enabled !== false}
                      onChange={(e) => patchOne(c.id, { enabled: e.target.checked })}
                    />
                    <span>{t('settings.mcfg.enabled')}</span>
                  </label>

                  {/* 人物绑定来源提示（当前配置会被哪些人物使用） */}
                  {roleBind && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                      {t('settings.mcfg.roleBindHint')}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MediaApiConfigEditor;