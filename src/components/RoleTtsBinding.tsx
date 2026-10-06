import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { MediaApiConfig, RoleTtsConfig, VoiceListResult } from '../types';
import {
  TTS_SPEED_MIN,
  TTS_SPEED_MAX,
  TTS_PITCH_MIN,
  TTS_PITCH_MAX,
  TTS_PROVIDERS,
  clampTtsSpeed,
  clampTtsPitch,
} from '../types';
import SelectMenu from './SelectMenu';
import { ComboBox } from './ComboBox';
import { useToast, ToastView } from './Toast';

// 试听用的固定文本（短句，覆盖中英文均能被各协议正常合成；用户不必先输入内容就能听到效果）
const PREVIEW_TEXT = '你好，这是我的声音。Hello, this is my voice.';

/** 角色音色绑定组件对外的绑定数据（与 RoleTtsConfig 同形，便于直接写入 voice.ttsVoices[roleId]） */
export type RoleTtsDraft = RoleTtsConfig;

/**
 * 把任意历史格式的 ttsVoices[roleId] 归一化成 RoleTtsConfig 对象。
 * 兼容三种来源：
 *   ① 旧版纯音色名字符串（v2.3.19 之前）—— 变成 { voice: '<名字>' }，语义不变；
 *   ② undefined / 空 —— 返回空对象（= 完全回退全局）；
 *   ③ 已经是对象 —— 原样浅拷贝（不改动传入对象，避免污染 settings 引用）。
 */
export function normalizeRoleTts(raw: string | RoleTtsConfig | undefined): RoleTtsDraft {
  if (typeof raw === 'string') return { voice: raw };
  if (raw && typeof raw === 'object') return { ...raw };
  return {};
}

/**
 * 判断一份角色 TTS 配置是否「完全为空」。
 * 为空时上层应删除 ttsVoices[roleId] 这个键（而不是留一个空对象），
 * 否则语义上「绑过音色但全空」和「从未绑过」在设置界面里会表现不一致。
 */
export function isEmptyRoleTts(cfg: RoleTtsDraft): boolean {
  return (
    !cfg.configId &&
    !cfg.voice &&
    !cfg.baseUrl &&
    !cfg.apiKey &&
    !cfg.model &&
    cfg.speed === undefined &&
    cfg.pitch === undefined
  );
}

interface Props {
  /** 角色 id（写入 settings.voice.ttsVoices[roleId] 的 key） */
  roleId: string;
  /** 当前绑定值（已归一化） */
  value: RoleTtsDraft;
  /** 变更回调（传 null 表示「清除绑定」） */
  onChange: (next: RoleTtsDraft | null) => void;
}

/**
 * 人物音色绑定 + 音色自定义（v2.3.94 需求 8 / 需求 9）。
 *
 * 绑定数据落在 settings.voice.ttsVoices[roleId]（RoleTtsConfig），旧格式纯音色名字符串自动兼容。
 * 能力：
 *   ① 选 TTS 配置（从用户自己的 ttsConfigs 里选，含「跟随当前启用配置」这一默认项）；
 *   ② 点「拉取音色列表」按**所选配置**（而不是全局）向该提供商实时拉取；
 *   ③ 拉到的音色进可输入下拉（ComboBox）——既能选也能手填音色 ID；
 *   ④ 语速 / 音调各自独立可调，留空 = 用全局值；
 *   ⑤ 「试听」按钮立刻用当前草稿合成一段并播放（不落盘也能听）。
 *
 * 拉取失败**分类提示**（这是需求明确要求）：
 *   - 该提供商没有音色列表端点（VoiceListResult.reason==='no-endpoint'）→ 引导手填，不是错误；
 *   - 网络 / 密钥错误（'auth' / 'network' / 'empty'）→ 提示检查配置后重试。
 */
export const RoleTtsBinding: React.FC<Props> = ({ roleId, value, onChange }) => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();

  // 用户自己的 TTS 多配置（需求 7 的地基）。停用的配置也列出（绑定不影响已绑音色），
  // 但默认不选中它 —— 让用户清楚当前用的是哪一条。
  const [ttsConfigs, setTtsConfigs] = useState<MediaApiConfig[]>([]);
  const [activeTtsId, setActiveTtsId] = useState('');
  const [configsLoading, setConfigsLoading] = useState(true);

  // 音色列表（按所选配置拉取）
  const [voices, setVoices] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  // 自增信号：置为「请手填音色 ID」时把焦点送进可输入下拉（ComboBox.focusSignal）
  const [manualFocusTick, setManualFocusTick] = useState(0);

  // 试听
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 试听序号：await 期间用户可能又点了一次别的试听，回来时若序号已变则丢弃本次结果，避免重叠播放
  const previewSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setTtsConfigs(s?.voice?.ttsConfigs || []);
        setActiveTtsId(s?.voice?.activeTtsId || '');
      })
      .catch(() => { /* 忽略：读不到就用空列表，界面提示先去设置里配置 */ })
      .finally(() => {
        if (!cancelled) setConfigsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载时务必停掉正在播放的试听音频，否则弹窗关闭后声音仍在放
  useEffect(
    () => () => {
      const a = audioRef.current;
      if (a) {
        try {
          a.onended = null;
          a.pause();
          a.currentTime = 0;
        } catch { /* 忽略 */ }
      }
      audioRef.current = null;
    },
    []
  );

  const selectedConfig = useMemo(
    () => ttsConfigs.find((c) => c.id === value.configId),
    [ttsConfigs, value.configId]
  );

  /**
   * 该配置的提供商是否声明支持音色列表端点（TTS_PROVIDERS[].voiceList）。
   * 直接读types.ts 里的 TTS_PROVIDERS 表（与设置页「提供商能力」列表同一份数据），
   * 不在渲染层另写一份正则 —— 上一版曾在这里硬编码一堆域名判断，
   * 结果与设置页的提供商表各说各话（比如新增提供商时这里不会跟着更新）。
   * 返回 null = 无法判定（如 OpenAI 兼容的第三方实现），此时不预判、让用户直接点拉取按钮试。
   */
  const providerSupportsList = useCallback((cfg?: MediaApiConfig): boolean | null => {
    if (!cfg) return null;
    const u = (cfg.baseUrl || '').toLowerCase().trim();
    if (!u) return null;
    // 与主进程 electron/db.ts 的 guessProviderByUrl 同一套匹配：子串命中即算该提供商。
    // 表里排在前面的是更具体的提供商，命中即停（顺序即优先级）。
    const hit = TTS_PROVIDERS.find((p) => p.match && u.includes(p.match.toLowerCase()));
    return hit ? hit.voiceList : null;
  }, []);

  const patch = (p: Partial<RoleTtsDraft>) => {
    const merged: RoleTtsDraft = { ...value, ...p };
    // 空字符串 / undefined 一律视为「删除该键」，避免存进 settings 里一堆空字段
    for (const k of Object.keys(p) as (keyof RoleTtsDraft)[]) {
      const val = p[k];
      if (val === undefined || val === '') delete merged[k];
    }
    onChange(isEmptyRoleTts(merged) ? null : merged);
  };

  /** 拉取音色列表：按所选 configId 走多配置；没选则让主进程用当前启用配置 */
  const fetchVoices = async () => {
    setFetching(true);
    setFetchNote(null);
    try {
      const res: VoiceListResult = await api.listVoicesDetailed(
        value.configId ? { configId: value.configId } : undefined
      );
      if (res.ok && res.voices.length) {
        setVoices(res.voices);
        setFetchNote({ kind: 'ok', text: t('roleTts.fetched', { n: res.voices.length }) });
        return;
      }
      setVoices([]);
      // 「该提供商没有音色列表端点」不是错误 —— 明确引导手填，并把焦点送到手填框
      if (res.reason === 'no-endpoint') {
        setFetchNote({ kind: 'warn', text: t('roleTts.noEndpoint') });
        setManualFocusTick((n) => n + 1);
      } else if (res.reason === 'no-config') {
        setFetchNote({ kind: 'error', text: t('roleTts.noConfig') });
      } else {
        // 网络 / 密钥 / 空列表等：给出主进程带回的具体信息，便于用户判断是配置还是网络问题
        setFetchNote({ kind: 'error', text: res.message || t('roleTts.fetchFailed') });
      }
    } catch (e: any) {
      setVoices([]);
      setFetchNote({ kind: 'error', text: `${t('roleTts.fetchFailed')}${e?.message ? `：${e.message}` : ''}` });
    } finally {
      setFetching(false);
    }
  };

  /** 试听：用当前草稿合成一句并播放。草稿未保存也能听 —— 做法是临时写入再还原，不污染用户的设置。 */
  const preview = async () => {
    if (previewing) return;
    // 先停掉正在播的（试听切试听也不允许重叠）
    const prev = audioRef.current;
    if (prev) {
      try { prev.onended = null; prev.pause(); prev.currentTime = 0; } catch { /* 忽略 */ }
      audioRef.current = null;
    }
    const seq = ++previewSeqRef.current;
    setPreviewing(true);
    // 备份该角色当前的绑定（可能是旧格式字符串，也可能压根没有键），试听结束后原样写回
    let backup: { had: boolean; value: string | RoleTtsConfig | undefined } = { had: false, value: undefined };
    try {
      const s = await api.getSettings();
      const cur = s?.voice?.ttsVoices || {};
      backup = { had: Object.prototype.hasOwnProperty.call(cur, roleId), value: cur[roleId] };
      // 草稿先落盘，主进程才能按它合成（否则只会用已保存的旧绑定）
      await api.saveSettings({
        voice: { ...(s?.voice || {}), ttsVoices: { ...cur, [roleId]: value } } as any,
      });

      const src = await api.textToSpeech(PREVIEW_TEXT, roleId, true);
      if (seq !== previewSeqRef.current) return; // 期间又点了别的试听 → 丢弃本次
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => {
        audioRef.current = null;
        setPreviewing(false);
      };
      await audio.play();
    } catch (e: any) {
      showToast(t('roleTts.previewFailed', { msg: e?.message || String(e) }), { error: true });
    } finally {
      if (seq === previewSeqRef.current) setPreviewing(false);
      // 还原绑定：试听是「试一下」，不该悄悄改掉用户的设置（点「保存」才真正生效）
      try {
        const s = await api.getSettings();
        const cur = { ...(s?.voice?.ttsVoices || {}) };
        if (backup.had && backup.value !== undefined) cur[roleId] = backup.value;
        else delete cur[roleId];
        await api.saveSettings({ voice: { ...(s?.voice || {}), ttsVoices: cur } as any });
      } catch {
        /* 还原失败不打扰用户：真正的保存仍以点「保存」为准 */
      }
    }
  };

  // 提供商配置下拉选项：「跟随当前启用配置」（空 configId）+ 全部 ttsConfigs
  const configOptions = [
    { value: '', label: activeTtsId
      ? `${t('roleTts.followActive')}（${ttsConfigs.find((c) => c.id === activeTtsId)?.name || '…'}）`
      : t('roleTts.followActive') },
    ...ttsConfigs.map((c) => ({
      value: c.id,
      label: c.enabled === false ? `${c.name}（${t('roleTts.disabled')}）` : c.name,
      tooltip: <div style={{ fontSize: 12 }}><div>{c.baseUrl || '—'}</div><div>{c.model || '—'}</div></div>,
    })),
  ];

  const supportsList = providerSupportsList(selectedConfig);

  return (
    <div className="role-tts">
      {/* ① 选 TTS 配置 */}
      <div className="field full">
        <label>{t('roleTts.config')}</label>
        {configsLoading ? (
          <div className="muted">{t('common.loading')}</div>
        ) : ttsConfigs.length === 0 ? (
          <div className="muted">{t('roleTts.noConfigs')}</div>
        ) : (
          <SelectMenu
            value={value.configId || ''}
            onChange={(v) => {
              // 换配置后旧的音色 id 必然失效（不同提供商的音色命名完全不同）→ 一并清掉，避免脏绑定
              const nextCfg = ttsConfigs.find((c) => c.id === v);
              patch({ configId: v || undefined, voice: undefined });
              setVoices([]);
              setFetchNote(null);
              // 选中一个「静态就已知没有音色列表端点」的提供商时，直接把焦点送到手填框
              if (providerSupportsList(nextCfg) === false) setManualFocusTick((n) => n + 1);
            }}
            options={configOptions}
          />
        )}
        <div className="field-hint">{t('roleTts.configHint')}</div>
      </div>

      {/* ②③ 拉取音色列表 + 可输入下拉（也允许手填音色 ID） */}
      <div className="field full">
        <label>{t('roleTts.voice')}</label>
        <div className="role-tts-row">
          <ComboBox
            style={{ flex: 1, minWidth: 140 }}
            value={value.voice || ''}
            onChange={(v) => patch({ voice: v })}
            options={voices}
            placeholder={t('roleTts.voicePh')}
            focusSignal={manualFocusTick}
            aria-label={t('roleTts.voice')}
          />
          <button className="btn-ghost" onClick={fetchVoices} disabled={fetching}>
            {fetching ? t('roleTts.fetching') : t('roleTts.fetch')}
          </button>
        </div>
        <div className="field-hint">
          {t('roleTts.voiceHint')}
          {selectedConfig && supportsList === false ? ` ${t('roleTts.providerNoList')}` : ''}
        </div>
        {fetchNote ? (
          <div className={`role-tts-note ${fetchNote.kind}`} role="status">
            {fetchNote.text}
          </div>
        ) : null}
      </div>

      {/* ④ 语速 / 音调（留空 = 用全局值） */}
      <div className="role-tts-row" style={{ marginTop: 4 }}>
        <div className="role-tts-param">
          <label>{t('roleTts.speed')}</label>
          <div className="role-tts-row">
            <input
              type="range"
              min={TTS_SPEED_MIN}
              max={TTS_SPEED_MAX}
              step={0.05}
              value={value.speed ?? 1}
              onChange={(e) => patch({ speed: clampTtsSpeed(Number(e.target.value)) })}
            />
            <span className="role-tts-num">{value.speed === undefined ? t('roleTts.useGlobal') : value.speed.toFixed(2)}</span>
            <button
              className="btn-ghost"
              style={{ padding: '2px 8px', fontSize: 12 }}
              disabled={value.speed === undefined}
              onClick={() => patch({ speed: undefined })}
            >
              {t('roleTts.clear')}
            </button>
          </div>
        </div>
        <div className="role-tts-param">
          <label>{t('roleTts.pitch')}</label>
          <div className="role-tts-row">
            <input
              type="range"
              min={TTS_PITCH_MIN}
              max={TTS_PITCH_MAX}
              step={1}
              value={value.pitch ?? 0}
              onChange={(e) => patch({ pitch: clampTtsPitch(Number(e.target.value)) })}
            />
            <span className="role-tts-num">{value.pitch === undefined ? t('roleTts.useGlobal') : value.pitch}</span>
            <button
              className="btn-ghost"
              style={{ padding: '2px 8px', fontSize: 12 }}
              disabled={value.pitch === undefined}
              onClick={() => patch({ pitch: undefined })}
            >
              {t('roleTts.clear')}
            </button>
          </div>
        </div>
      </div>
      <div className="field-hint" style={{ marginTop: 2 }}>{t('roleTts.paramHint')}</div>

      {/* ⑤ 试听 + 清除绑定 */}
      <div className="role-tts-row" style={{ marginTop: 8 }}>
        <button className="btn-ghost" onClick={preview} disabled={previewing}>
          {previewing ? t('roleTts.previewing') : t('roleTts.preview')}
        </button>
        <button className="btn-ghost" onClick={() => onChange(null)} disabled={isEmptyRoleTts(value)}>
          {t('roleTts.clearAll')}
        </button>
      </div>
      <ToastView toast={toast} />
    </div>
  );
};
