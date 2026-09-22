import React, { useState, useEffect } from 'react';
import { api } from '../ipc';
import ComboBox from './ComboBox';
import { useI18n } from '../i18n/I18nContext';
import {
  PROVIDER_DEFAULTS,
  MODEL_TAG_LEN_MAX,
  MODEL_TAG_MAX,
  type ModelConfig,
  type ModelGroup,
  type Provider,
} from '../types';
import { useToast, ToastView } from './Toast';
import SelectMenu from './SelectMenu';
import Hint from './Hint';

// 能力徽章：探测结果为布尔时显示「支持/不支持」，为 undefined/null 时显示「未探测」
const CapBadge: React.FC<{ label: string; on?: boolean | null }> = ({ label, on }) => {
  let bg = 'rgba(128,128,128,0.18)';
  let color = 'var(--color-text-secondary)';
  let text = '—';
  if (on === true) {
    // v2.3.43 主题适配：改用语义色变量（各主题对比度一致），避免暗色主题下绿字发暗看不清
    bg = 'rgba(16,185,129,0.18)';
    color = 'var(--color-success)';
    text = '✓';
  } else if (on === false) {
    bg = 'rgba(255,77,79,0.18)';
    color = 'var(--color-danger)';
    text = '✕';
  }
  return (
    <span
      title={on === true ? '支持' : on === false ? '不支持' : '未探测'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 10,
        background: bg,
        color,
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
    >
      {label} {text}
    </span>
  );
};

export const ModelEditor: React.FC<{
  initial?: ModelConfig;
  onClose: () => void;
  onSave: (cfg: ModelConfig) => void;
  groups?: ModelGroup[]; // 全局分组（用于归属多选）
  knownTags?: string[]; // 已有标签（用于输入联想）
  // 全局模型参数（用于「跟随全局」显示；streamEnabled=全局流式开关当前值）
  globalParams?: { temperature?: number; topP?: number; topK?: number; streamEnabled?: boolean };
}> = ({ initial, onClose, onSave, groups = [], knownTags = [], globalParams }) => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const g = globalParams || {};
  const [cfg, setCfg] = useState<ModelConfig>(
    initial || {
      id: crypto.randomUUID(),
      name: '',
      provider: 'openai',
      baseUrl: '',
      apiKey: '',
      model: '',
      maxContext: PROVIDER_DEFAULTS.openai.maxContext,
      // 温度/topP/topK 默认不写独立值 → 跟随全局参数（globalModelParams）
      memReadLimit: 0,
      customParams: '',
      enabled: true,
    }
  );
  const [msg, setMsg] = useState('');
  // API Key 显隐切换（v2.3.38）：false=密码态（点点点），true=明文
  const [showApiKey, setShowApiKey] = useState(false);
  // QPS 输入中间态：受控 number 输入若直接 Number() 回写会吃掉「0.」这类中间输入，
  // 导致小数 QPS 根本打不进去，故单独用字符串保存输入原文。
  const [qpsText, setQpsText] = useState(
    initial?.qps !== undefined && initial?.qps !== null ? String(initial.qps) : ''
  );
  const [tagDraft, setTagDraft] = useState('');
  const [modelList, setModelList] = useState<string[]>([]);
  // 刷新列表成功后自增 → 通知组合框自动展开（v2.3.39：原生 datalist 无法加滚动条，改为自定义下拉）
  const [listOpenSeq, setListOpenSeq] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // 测试范围（v2.3.39）：与上方「能力标记」完全解耦——这里决定「检测能力」按钮实际探测哪些项。
  // 默认除 NSFW 外全开（NSFW 探针会真实发送成人内容请求，与设置页「一键检测」口径一致，默认关闭）。
  const [probeScope, setProbeScope] = useState<{
    images: boolean;
    tools: boolean;
    json: boolean;
    stream: boolean;
    nsfw: boolean;
    thinkLevel: boolean;
  }>({ images: true, tools: true, json: true, stream: true, nsfw: false, thinkLevel: true });
  const probeScopeCount = Object.values(probeScope).filter(Boolean).length;
  // 测试范围选项（顺序=展示顺序）：键名与 ProbeOptions 一一对应
  const scopeItems: [keyof typeof probeScope, string][] = [
    ['images', t('model.capImages')],
    ['tools', t('model.capTools')],
    ['json', t('model.capJson')],
    ['stream', t('model.capStream')],
    ['nsfw', t('model.capNsfw')],
    ['thinkLevel', t('model.capThinkLevel')],
  ];

  const set = (k: keyof ModelConfig, v: any) => setCfg((c) => ({ ...c, [k]: v }));

  // 「跟随全局」提示后缀：该参数未单独设置（undefined）时显示，生效值取全局默认
  const followTag = (v: unknown) => (v === undefined ? ` · ${t('model.followGlobal')}` : '');
  const tempEff = cfg.temperature ?? g.temperature ?? 1;
  const topPEff = cfg.topP ?? g.topP ?? 0.95;
  const topKEff = cfg.topK ?? g.topK ?? 50;
  // 跟随全局 = 四项（温度/TopP/TopK/流式）均无独立值（纯派生：新建模型默认勾选，调任一参数自动取消）
  const followAll =
    cfg.temperature === undefined && cfg.topP === undefined && cfg.topK === undefined && cfg.streamEnabled === undefined;
  const setFollowAll = (follow: boolean) => {
    if (follow) {
      // 勾选：清空全部独立值 → 完全跟随全局
      setCfg((c) => ({ ...c, temperature: undefined, topP: undefined, topK: undefined, streamEnabled: undefined }));
    } else {
      // 取消勾选：把当前显示的全局值固化为独立值（滑块/开关保持不变，之后调整才真正独立）
      setCfg((c) => ({
        ...c,
        temperature: c.temperature ?? g.temperature ?? 1,
        topP: c.topP ?? g.topP ?? 0.95,
        topK: c.topK ?? g.topK ?? 50,
        streamEnabled: c.streamEnabled ?? g.streamEnabled ?? false,
      }));
    }
  };

  // ===== QPS：字符串输入 + 失焦归一化，支持 0~1 等小数 =====
  const onQpsChange = (raw: string) => {
    setQpsText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') return set('qps', undefined);
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0) set('qps', n);
  };
  const onQpsBlur = () => {
    const trimmed = qpsText.trim();
    if (trimmed === '') {
      set('qps', undefined);
      setQpsText('');
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      set('qps', undefined);
      setQpsText('');
      return;
    }
    set('qps', n);
    setQpsText(String(n));
  };

  // ===== 标签：回车添加，超长截断并提示，超出数量上限拒绝 =====
  const addTag = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text.length > MODEL_TAG_LEN_MAX) setMsg(t('model.tagTooLong', { n: MODEL_TAG_LEN_MAX }));
    const v = text.slice(0, MODEL_TAG_LEN_MAX);
    const cur = cfg.tags || [];
    if (cur.includes(v)) {
      setTagDraft('');
      return;
    }
    if (cur.length >= MODEL_TAG_MAX) {
      setMsg(t('model.tagLimitReached', { n: MODEL_TAG_MAX }));
      return;
    }
    set('tags', [...cur, v]);
    setTagDraft('');
  };
  const removeTag = (v: string) => set('tags', (cfg.tags || []).filter((x) => x !== v));

  // ===== 分组归属（多归属）：勾选即加入/移出 =====
  const toggleGroup = (gid: string) => {
    const cur = cfg.groupIds || [];
    set('groupIds', cur.includes(gid) ? cur.filter((x) => x !== gid) : [...cur, gid]);
  };

  // ESC 关闭（仅叉号 / ESC 可退出，点空白不关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refreshModels = async () => {
    const effBase = isHiddenBase ? PROVIDER_DEFAULTS[cfg.provider].baseUrl : cfg.baseUrl;
    if (!effBase) {
      setListError(t('model.listFail', { msg: '请先填写 API Base URL' }));
      return;
    }
    setListLoading(true);
    setListError('');
    setModelList([]);
    try {
      const list = await api.listModels({ ...cfg, baseUrl: effBase });
      if (list.length === 0) setListError(t('model.listEmpty'));
      else {
        setModelList(list);
        setListOpenSeq((s) => s + 1); // 拉取成功后自动展开可滚动列表，便于挑选目标模型
      }
    } catch (e: any) {
      setListError(t('model.listFail', { msg: e?.message || String(e) }));
    } finally {
      setListLoading(false);
    }
  };

  const testConn = async () => {
    setTesting(true);
    setTestState(null);
    try {
      const res = await api.testModel({ ...cfg });
      setTestState(res);
      showToast(res.ok ? t('model.testOkToast') : t('model.testFailToast'), { error: !res.ok });
    } catch (e: any) {
      setTestState({ ok: false, message: e?.message || String(e) });
      showToast(t('model.testFailToast'), { error: true });
    } finally {
      setTesting(false);
    }
  };

  // 能力探针：向模型发送极小请求，真实探测视觉/工具/JSON 能力与上下文窗口（非启发式）
  // 已保存模型按 id 探测并落库；新增/未保存模型直接用当前草稿探测（不落库），结果合并回表单。
  // v2.3.31 修复：新增时草稿也会预生成随机 id（crypto.randomUUID），不能以 id 是否存在判断——
  // 改为以 initial 是否传入区分「编辑已保存模型」与「新增草稿」，新增时走草稿探测通道（models:detectConfig）。
  // v2.3.39：探测范围由下方独立「测试范围」决定（probeScope），与上方能力标记无关。
  const isSavedModel = !!initial?.id;
  const [detecting, setDetecting] = useState(false);
  // 本次探针「未能判定」的能力项键（images/tools/json/nsfw/thinkLevel）——
  // 与「探针判定为不支持」区分显示（v2.3.38 修复：此前 null 被显示成「否」，用户误以为全部不支持）
  const [capUndetected, setCapUndetected] = useState<string[]>([]);
  const detectModel = async () => {
    if (probeScopeCount === 0) {
      showToast(t('model.probeScopeNone'), { error: true });
      return;
    }
    setDetecting(true);
    try {
      const res = isSavedModel
        ? await api.detectModel(cfg.id, probeScope, cfg.qps) // v2.3.40 传表单当前 qps：未保存的限速修改也立即生效
        : await api.detectModelConfig({ ...cfg, id: cfg.id || '__draft__' }, probeScope);
      if (res.config) {
        // 把探测结果同步进本地草稿，便于用户查看/手动微调后保存
        setCfg((c) => ({
          ...c,
          supportsImages: res.config!.supportsImages,
          supportsTools: res.config!.supportsTools,
          supportsJson: res.config!.supportsJson,
          supportsNsfw: res.config!.supportsNsfw,
          // 思考等级探测结果由主进程回写到 supportsReasoning（null 时保留原手动标记）
          supportsReasoning: res.config!.supportsReasoning,
          maxContext: res.config!.maxContext || c.maxContext,
          lastDetectedAt: res.config!.lastDetectedAt,
        }));
      }
      const undet = res.undetected || [];
      setCapUndetected(undet);
      // 未判定项的中文标签（主进程返回的是配置字段名，需映射为界面名称）
      const undetLabel = (k: string): string =>
        ({
          supportsImages: t('model.capImages'),
          supportsTools: t('model.capTools'),
          supportsJson: t('model.capJson'),
          supportsNsfw: t('model.capNsfw'),
          supportsStream: t('model.capStream'),
          supportsThinkLevel: t('model.capThinkLevel'),
        } as Record<string, string>)[k] || k;
      // 三态显示：支持 / 不支持 / 未判定（未判定绝不显示为「否」）
      const tri = (v: boolean | null | undefined) =>
        v === true ? t('model.capYes') : v === false ? t('model.capNo') : t('model.capUnknown');
      const caps: string[] = [];
      caps.push(`${t('model.capImages')}:${tri(res.config?.supportsImages)}`);
      caps.push(`${t('model.capTools')}:${tri(res.config?.supportsTools)}`);
      caps.push(`${t('model.capJson')}:${tri(res.config?.supportsJson)}`);
      caps.push(`${t('model.capNsfw')}:${tri(res.config?.supportsNsfw)}`);
      caps.push(`${t('model.capThinkLevel')}:${tri(res.config?.supportsReasoning)}`);
      const undetText = undet.length ? `（${t('model.capUnknownAt', { items: undet.map(undetLabel).join('、') })}）` : '';
      showToast(
        (res.ok ? t('model.detectOk', { msg: caps.join('  ') }) : t('model.detectFail', { msg: res.message })) + undetText,
        { error: !res.ok }
      );
    } catch (e: any) {
      showToast(t('model.detectFail', { msg: e?.message || String(e) }), { error: true });
    } finally {
      setDetecting(false);
    }
  };

  const onProvider = (p: Provider) => {
    const d = PROVIDER_DEFAULTS[p];
    setCfg((c) => ({ ...c, provider: p, baseUrl: d.baseUrl, model: d.model, maxContext: d.maxContext }));
  };

  const isHiddenBase = cfg.provider === 'openai' || cfg.provider === 'deepseek' || cfg.provider === 'anthropic';

  const save = () => {
    if (!cfg.name.trim()) return setMsg(t('model.needName'));
    if (!isHiddenBase && !cfg.baseUrl.trim()) return setMsg(t('model.needBaseUrl'));
    if (!cfg.model.trim()) return setMsg(t('model.needModelId'));
    // 自定义参数：仅当非空时校验 JSON 合法性，非法则阻止保存并提示
    if (cfg.customParams && cfg.customParams.trim()) {
      try {
        const parsed = JSON.parse(cfg.customParams);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return setMsg(t('model.customParamsInvalid'));
        }
      } catch (e: any) {
        return setMsg(t('model.customParamsInvalid') + `：${e?.message || String(e)}`);
      }
    }
    // OpenAI / DeepSeek / Anthropic 由各厂商官方 Base URL 直连，前端不暴露输入框，仅用默认地址
    const baseUrl = isHiddenBase ? PROVIDER_DEFAULTS[cfg.provider].baseUrl : cfg.baseUrl.trim();
    onSave({ ...cfg, name: cfg.name.trim(), model: cfg.model.trim(), baseUrl });
  };

  return (
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{initial ? t('model.editTitle') : t('model.newTitle')}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body">
          {msg && (
            <div style={{ marginBottom: 12, color: 'var(--color-primary)', fontSize: 13 }}>{msg}</div>
          )}
          <div className="form-grid">
            <Field label={t('model.name')} full>
              <input
                value={cfg.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('model.namePh')}
              />
            </Field>
            <Field label={t('model.provider')}>
              <SelectMenu
                value={cfg.provider}
                onChange={(v) => onProvider(v as Provider)}
                options={[
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'local', label: t('model.providerLocal') },
                  { value: 'custom', label: t('model.providerCustom') },
                  { value: 'openai-compatible', label: t('model.providerOaiComp') },
                ]}
              />
            </Field>
            <Field label={t('model.enabled')} hint={t('model.enabledNote')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => set('enabled', e.target.checked)}
                />
                {cfg.enabled ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
            </Field>
            {!isHiddenBase && (
              <Field
                label={t('model.baseUrl')}
                full
                hint={
                  cfg.provider === 'local'
                    ? t('model.localBaseUrlHint')
                    : cfg.provider === 'openai-compatible'
                      ? t('model.baseUrlHint')
                      : t('model.baseUrlNote')
                }
              >
                <input
                  value={cfg.baseUrl}
                  onChange={(e) => set('baseUrl', e.target.value)}
                  placeholder={cfg.provider === 'openai-compatible' || cfg.provider === 'local' ? '' : 'https://api.openai.com/v1'}
                />
              </Field>
            )}
            <Field
              label={t('model.apiKey')}
              hint={cfg.provider === 'local' ? t('model.localApiKeyHint') : undefined}
            >
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={cfg.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder={t('model.apiKeyPh')}
                  style={{ paddingRight: 40 }}
                />
                {/* 显隐切换（v2.3.38）：眼睛图标切换密码/明文，便于确认当前使用哪个 Key */}
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowApiKey((v) => !v)}
                  title={showApiKey ? t('model.apiKeyHide') : t('model.apiKeyShow')}
                  style={{
                    position: 'absolute',
                    right: 6,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 14,
                    color: 'var(--color-text-secondary)',
                    padding: '2px 6px',
                    lineHeight: 1,
                  }}
                >
                  {showApiKey ? '🙈' : '👁'}
                </button>
              </div>
            </Field>
            <Field
              label={t('model.modelId')}
              hint={modelList.length > 0 ? t('model.pickFromList') : undefined}
            >
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <ComboBox
                  value={cfg.model}
                  onChange={(v) => set('model', v)}
                  options={modelList}
                  placeholder={t('model.customModel')}
                  openSignal={listOpenSeq}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={refreshModels}
                  disabled={listLoading}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {listLoading ? t('model.refreshing') : t('model.refreshModels')}
                </button>
              </div>
              {listError && (
                <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 4 }}>{listError}</div>
              )}
            </Field>
            <RangeField
              label={t('model.maxContext')}
              value={cfg.maxContext ?? 0}
              min={0}
              max={1000000}
              step={1000}
              onChange={(v) => set('maxContext', v)}
              presets={[
                { label: '不限制', value: 0 },
                { label: '64K', value: 64000 },
                { label: '128K', value: 128000 },
                { label: '256K', value: 256000 },
                { label: '512K', value: 512000 },
                { label: '768K', value: 768000 },
              ]}
              format={(v) => (v === 0 ? t('model.unlimited') : v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)}
            />
            <RangeField
              label={t('model.temperature', { value: tempEff.toFixed(2) }) + followTag(cfg.temperature)}
              value={tempEff}
              min={0}
              max={2}
              step={0.01}
              onChange={(v) => set('temperature', v)}
            />
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {/* 跟随全局：勾选=参数+流式全部随全局（派生态）；调任一参数自动取消 */}
                <input
                  type="checkbox"
                  checked={followAll}
                  onChange={(e) => setFollowAll(e.target.checked)}
                />
                {t('model.followGlobalAll')}
              </label>
              {/* 一键对齐全局（与勾选跟随全局等效） */}
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '2px 10px', fontSize: 12 }}
                onClick={() => {
                  setFollowAll(true);
                  showToast(t('model.resetToGlobalDone'));
                }}
              >
                {t('model.resetToGlobal')}
              </button>
            </div>
            <Field label={t('model.streamMode')} full hint={t('model.streamModeDesc')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  disabled={cfg.streamEnabled === undefined}
                  checked={cfg.streamEnabled ?? g.streamEnabled ?? false}
                  onChange={(e) => set('streamEnabled', e.target.checked)}
                />
                <span>
                  {cfg.streamEnabled === undefined
                    ? `${t('model.followGlobal')}（${(g.streamEnabled ?? false) ? t('common.on') : t('common.off')}）`
                    : cfg.streamEnabled
                      ? t('common.on')
                      : t('common.off')}
                </span>
              </label>
            </Field>
            <RangeField
              label={t('model.topP') + followTag(cfg.topP)}
              value={topPEff}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => set('topP', v)}
            />
            <RangeField
              label={t('model.topK') + followTag(cfg.topK)}
              value={topKEff}
              min={0}
              max={50}
              step={1}
              onChange={(v) => set('topK', v)}
            />
            <RangeField
              label={t('model.memReadLimit')}
              value={cfg.memReadLimit ?? 0}
              min={0}
              max={100}
              step={1}
              onChange={(v) => set('memReadLimit', v)}
              format={(v) => (v === 0 ? t('model.unlimited') : t('model.lastN', { n: v }))}
            />
            <Field label={t('model.maxTokens')} hint={t('model.maxTokensHint')}>
              <input
                type="number"
                min={0}
                placeholder={t('model.maxTokensDesc')}
                value={cfg.maxTokens ?? ''}
                onChange={(e) => set('maxTokens', e.target.value === '' ? undefined : Number(e.target.value) || 0)}
              />
            </Field>
            <Field label={t('model.customParams')} full hint={t('model.customParamsDesc')}>
              <textarea
                value={cfg.customParams ?? ''}
                onChange={(e) => set('customParams', e.target.value)}
                placeholder={t('model.customParamsPlaceholder')}
                rows={4}
                spellCheck={false}
                style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              />
            </Field>
            {/* 能力标记区（v2.3.39）：以下开关仅标记模型固有能力，不决定探针测试范围 */}
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, marginBottom: -2, fontSize: 13, fontWeight: 600 }}>
              {t('model.capMarksTitle')}
              <Hint text={t('model.capMarksNote')} />
            </div>
            <Field label={t('model.supportsImages')} hint={t('model.supportsImagesDesc')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsImages}
                  onChange={(e) => set('supportsImages', e.target.checked)}
                />
                {cfg.supportsImages ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
            </Field>
            <Field label={t('model.supportsReasoning')} hint={t('model.supportsReasoningDesc')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsReasoning}
                  onChange={(e) => set('supportsReasoning', e.target.checked)}
                />
                {cfg.supportsReasoning ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
            </Field>
            <Field label={t('model.supportsTools')} hint={t('model.supportsToolsDesc')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsTools}
                  onChange={(e) => set('supportsTools', e.target.checked)}
                />
                {cfg.supportsTools ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
            </Field>
            <Field label={t('model.supportsJson')} hint={t('model.supportsJsonDesc')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsJson}
                  onChange={(e) => set('supportsJson', e.target.checked)}
                />
                {cfg.supportsJson ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
            </Field>
            <Field label={t('model.supportsNsfw')} hint={t('model.supportsNsfwDesc')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsNsfw}
                  onChange={(e) => set('supportsNsfw', e.target.checked)}
                />
                {cfg.supportsNsfw ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
            </Field>
            <Field label={t('model.groups')} full hint={t('model.groupsDesc')}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                {(groups || []).length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('model.groupsEmpty')}</span>
                )}
                {(groups || []).map((g) => {
                  const active = (cfg.groupIds || []).includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleGroup(g.id)}
                      style={{
                        padding: '3px 10px',
                        fontSize: 12,
                        borderRadius: 14,
                        cursor: 'pointer',
                        border: `1px solid ${g.color}`,
                        background: active ? g.color : 'transparent',
                        color: active ? '#fff' : 'var(--color-text)',
                      }}
                    >
                      {g.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label={t('model.tags')} full hint={t('model.tagsDesc', { max: MODEL_TAG_MAX, len: MODEL_TAG_LEN_MAX })}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                {(cfg.tags || []).map((v) => (
                  <span
                    key={v}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: 'var(--color-input-bg)',
                      border: '1px solid var(--color-border)',
                      fontSize: 12,
                    }}
                  >
                    {v}
                    <span
                      onClick={() => removeTag(v)}
                      style={{ cursor: 'pointer', color: 'var(--color-text-secondary)' }}
                    >
                      ×
                    </span>
                  </span>
                ))}
              </div>
              <ComboBox
                value={tagDraft}
                onChange={setTagDraft}
                options={knownTags || []}
                placeholder={t('model.tagsPh')}
                enterToSelect={false}
                onKeyDown={(e) => {
                  // 回车仍是「添加标签」：enterToSelect=false 让组合框不吞回车，这里照旧处理
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag(tagDraft);
                  }
                }}
              />
            </Field>
            <Field label={t('model.qps')} hint={t('model.qpsHint')}>
              <input
                type="number"
                min={0}
                step={0.1}
                placeholder={t('model.qpsDesc')}
                value={qpsText}
                onChange={(e) => onQpsChange(e.target.value)}
                onBlur={onQpsBlur}
              />
            </Field>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" className="btn-primary" onClick={testConn} disabled={testing}>
              {testing ? t('model.testing') : t('model.testConnection')}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={detectModel}
              disabled={detecting || probeScopeCount === 0}
            >
              {detecting ? t('model.detecting') : t('model.detectCapabilities')}
            </button>
            {testState && (
              <span
                style={{
                  fontSize: 13,
                  color: testState.ok ? 'var(--color-primary)' : 'var(--color-danger)',
                }}
              >
                {testState.ok
                  ? t('model.testOk', { msg: testState.message })
                  : t('model.testFail', { msg: testState.message })}
              </span>
            )}
          </div>

          {/* 测试范围（v2.3.39）：独立于上方「能力标记」，决定「检测能力」实际探测哪些项 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
            <span style={{ color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
              {t('model.probeScope')}
              <Hint text={t('model.probeScopeHint')} />
            </span>
            {scopeItems.map(([k, label]) => {
              const on = probeScope[k];
              return (
                <label
                  key={k}
                  title={k === 'nsfw' ? t('settings.detectNsfwWarn') : undefined}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 12,
                    // 检测进行中冻结测试范围：不可改、灰显、光标禁用（避免探测途中误改造成结果与选择不一致）
                    cursor: detecting ? 'not-allowed' : 'pointer',
                    opacity: detecting ? 0.55 : 1,
                    border: `1px solid ${on ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: on ? 'var(--color-input-bg)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={detecting}
                    onChange={(e) => setProbeScope((p) => ({ ...p, [k]: e.target.checked }))}
                  />
                  {label}
                </label>
              );
            })}
          </div>
          {probeScopeCount === 0 && (
            <div style={{ fontSize: 12, color: 'var(--color-danger, #e06c75)', marginTop: 4 }}>
              {t('model.probeScopeNone')}
            </div>
          )}

          {/* 能力探针结果徽章（✓ 支持 / ✕ 未启用或判定不支持 / — 本次未判定） */}
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
            {t('model.detectResult')}
            <Hint text={t('model.capBadgeNote')} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 12, alignItems: 'center' }}>
            <CapBadge label={t('model.capImages')} on={capUndetected.includes('supportsImages') ? undefined : cfg.supportsImages} />
            <CapBadge label={t('model.capTools')} on={capUndetected.includes('supportsTools') ? undefined : cfg.supportsTools} />
            <CapBadge label={t('model.capJson')} on={capUndetected.includes('supportsJson') ? undefined : cfg.supportsJson} />
            <CapBadge label={t('model.capStream')} on={capUndetected.includes('supportsStream') ? undefined : cfg.supportsStream} />
            <CapBadge label={t('model.capNsfw')} on={capUndetected.includes('supportsNsfw') ? undefined : cfg.supportsNsfw} />
            {cfg.lastDetectedAt ? (
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {t('model.capDetectedAt', { time: new Date(cfg.lastDetectedAt).toLocaleString() })}
              </span>
            ) : null}
          </div>

          <div className="row-actions">
            <button className="btn-primary" onClick={save}>
              {t('model.save')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
      <ToastView toast={toast} />
    </div>
  );
};

const Field: React.FC<{ label: string; full?: boolean; hint?: React.ReactNode; children: React.ReactNode }> = ({
  label,
  full,
  hint,
  children,
}) => (
  <div className={`field ${full ? 'full' : ''}`}>
    <label>
      {label}
      {hint ? (
        <>
          {' '}
          <Hint text={hint} />
        </>
      ) : null}
    </label>
    {children}
  </div>
);

// 无极滑动 + 输入框直输：滑块与数字输入框双向同步；presets 提供快捷档位；format 自定义显示文案
const RangeField: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  presets?: { label: string; value: number }[];
  format?: (v: number) => string;
  full?: boolean;
  hint?: React.ReactNode;
}> = ({ label, value, min, max, step, onChange, presets, format, full, hint }) => (
  <Field label={label} full={full} hint={hint}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        style={{ width: 92 }}
      />
    </div>
    {presets && (
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        {presets.map((p) => (
          <button
            type="button"
            key={p.label}
            className="btn-ghost"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
    )}
    {format && (
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>{format(value)}</div>
    )}
  </Field>
);
