import React, { useState, useEffect } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import {
  PROVIDER_DEFAULTS,
  MODEL_GROUP_COLORS,
  MODEL_GROUP_NAME_MAX,
  MODEL_TAG_LEN_MAX,
  MODEL_TAG_MAX,
  type ModelConfig,
  type ModelGroup,
  type Provider,
} from '../types';
import { useToast, ToastView } from './Toast';
import SelectMenu from './SelectMenu';

// 能力徽章：探测结果为布尔时显示「支持/不支持」，为 undefined/null 时显示「未探测」
const CapBadge: React.FC<{ label: string; on?: boolean | null }> = ({ label, on }) => {
  let bg = 'rgba(128,128,128,0.18)';
  let color = 'var(--color-text-secondary)';
  let text = '—';
  if (on === true) {
    bg = 'rgba(80,180,120,0.22)';
    color = '#4caf72';
    text = '✓';
  } else if (on === false) {
    bg = 'rgba(224,108,117,0.20)';
    color = '#e06c75';
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
}> = ({ initial, onClose, onSave, groups = [], knownTags = [] }) => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const [cfg, setCfg] = useState<ModelConfig>(
    initial || {
      id: crypto.randomUUID(),
      name: '',
      provider: 'openai',
      baseUrl: '',
      apiKey: '',
      model: '',
      maxContext: PROVIDER_DEFAULTS.openai.maxContext,
      temperature: 1.0,
      topP: 1,
      topK: 0,
      memReadLimit: 0,
      customParams: '',
      enabled: true,
    }
  );
  const [msg, setMsg] = useState('');
  // QPS 输入中间态：受控 number 输入若直接 Number() 回写会吃掉「0.」这类中间输入，
  // 导致小数 QPS 根本打不进去，故单独用字符串保存输入原文。
  const [qpsText, setQpsText] = useState(
    initial?.qps !== undefined && initial?.qps !== null ? String(initial.qps) : ''
  );
  const [tagDraft, setTagDraft] = useState('');
  const [modelList, setModelList] = useState<string[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const set = (k: keyof ModelConfig, v: any) => setCfg((c) => ({ ...c, [k]: v }));

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
      else setModelList(list);
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
      showToast(res.ok ? t('model.testOkToast') : t('model.testFailToast'), !res.ok);
    } catch (e: any) {
      setTestState({ ok: false, message: e?.message || String(e) });
      showToast(t('model.testFailToast'), { error: true });
    } finally {
      setTesting(false);
    }
  };

  // 能力探针：向模型发送极小请求，真实探测视觉/工具/JSON 能力与上下文窗口（非启发式）
  const [detecting, setDetecting] = useState(false);
  const detectModel = async () => {
    if (!cfg.id) {
      showToast(t('model.needModelIdBeforeDetect'), true);
      return;
    }
    setDetecting(true);
    try {
      const res = await api.detectModel(cfg.id);
      if (res.config) {
        // 把探测结果同步进本地草稿，便于用户查看/手动微调后保存
        setCfg((c) => ({
          ...c,
          supportsImages: res.config!.supportsImages,
          supportsTools: res.config!.supportsTools,
          supportsJson: res.config!.supportsJson,
          supportsNsfw: res.config!.supportsNsfw,
          maxContext: res.config!.maxContext || c.maxContext,
          lastDetectedAt: res.config!.lastDetectedAt,
        }));
      }
      const caps: string[] = [];
      caps.push(`${t('model.capImages')}: ${res.config?.supportsImages ? t('model.capYes') : t('model.capNo')}`);
      caps.push(`${t('model.capTools')}: ${res.config?.supportsTools ? t('model.capYes') : t('model.capNo')}`);
      caps.push(`${t('model.capJson')}: ${res.config?.supportsJson ? t('model.capYes') : t('model.capNo')}`);
      caps.push(`${t('model.capNsfw')}: ${res.config?.supportsNsfw ? t('model.capYes') : t('model.capNo')}`);
      const undetected = res.undetected && res.undetected.length ? `（${t('model.capUnknown')}）` : '';
      showToast(
        (res.ok ? t('model.detectOk', { msg: caps.join('  ') }) : t('model.detectFail', { msg: res.message })) + undetected,
        !res.ok
      );
    } catch (e: any) {
      showToast(t('model.detectFail', { msg: e?.message || String(e) }), true);
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
            <Field label={t('model.enabled')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => set('enabled', e.target.checked)}
                />
                {cfg.enabled ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.enabledNote')}
              </div>
            </Field>
            {!isHiddenBase && (
              <Field label={t('model.baseUrl')} full>
                <input
                  value={cfg.baseUrl}
                  onChange={(e) => set('baseUrl', e.target.value)}
                  placeholder={cfg.provider === 'openai-compatible' || cfg.provider === 'local' ? '' : 'https://api.openai.com/v1'}
                />
                {(cfg.provider === 'openai-compatible' || cfg.provider === 'local') && (
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                    {cfg.provider === 'local' ? t('model.localBaseUrlHint') : t('model.baseUrlHint')}
                  </div>
                )}
              </Field>
            )}
            <Field label={t('model.apiKey')}>
              <input
                type="password"
                value={cfg.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
                placeholder={t('model.apiKeyPh')}
              />
              {cfg.provider === 'local' && (
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  {t('model.localApiKeyHint')}
                </div>
              )}
            </Field>
            <Field label={t('model.modelId')}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <input
                  list="nianyu-model-list"
                  value={cfg.model}
                  onChange={(e) => set('model', e.target.value)}
                  placeholder={t('model.customModel')}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <datalist id="nianyu-model-list">
                  {modelList.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
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
              {modelList.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {t('model.pickFromList')}
                </div>
              )}
              {listError && (
                <div style={{ fontSize: 12, color: '#e06c75', marginTop: 4 }}>{listError}</div>
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
              label={t('model.temperature', { value: cfg.temperature.toFixed(2) })}
              value={cfg.temperature}
              min={0}
              max={2}
              step={0.01}
              onChange={(v) => set('temperature', v)}
            />
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, marginBottom: 2 }}>
              {t('model.advanced')}
            </div>
            <RangeField
              label={t('model.topP')}
              value={cfg.topP ?? 1}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => set('topP', v)}
            />
            <RangeField
              label={t('model.topK')}
              value={cfg.topK ?? 0}
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
            <Field label={t('model.maxTokens')}>
              <input
                type="number"
                min={0}
                placeholder={t('model.maxTokensDesc')}
                value={cfg.maxTokens ?? ''}
                onChange={(e) => set('maxTokens', e.target.value === '' ? undefined : Number(e.target.value) || 0)}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.maxTokensHint')}
              </div>
            </Field>
            <Field label={t('model.customParams')} full>
              <textarea
                value={cfg.customParams ?? ''}
                onChange={(e) => set('customParams', e.target.value)}
                placeholder={t('model.customParamsPlaceholder')}
                rows={4}
                spellCheck={false}
                style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.customParamsDesc')}
              </div>
            </Field>
            <Field label={t('model.supportsImages')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsImages}
                  onChange={(e) => set('supportsImages', e.target.checked)}
                />
                {cfg.supportsImages ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.supportsImagesDesc')}
              </div>
            </Field>
            <Field label={t('model.supportsReasoning')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsReasoning}
                  onChange={(e) => set('supportsReasoning', e.target.checked)}
                />
                {cfg.supportsReasoning ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.supportsReasoningDesc')}
              </div>
            </Field>
            <Field label={t('model.supportsTools')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsTools}
                  onChange={(e) => set('supportsTools', e.target.checked)}
                />
                {cfg.supportsTools ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.supportsToolsDesc')}
              </div>
            </Field>
            <Field label={t('model.supportsJson')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsJson}
                  onChange={(e) => set('supportsJson', e.target.checked)}
                />
                {cfg.supportsJson ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.supportsJsonDesc')}
              </div>
            </Field>
            <Field label={t('model.supportsNsfw')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!!cfg.supportsNsfw}
                  onChange={(e) => set('supportsNsfw', e.target.checked)}
                />
                {cfg.supportsNsfw ? t('model.enabledOn') : t('model.enabledOff')}
              </label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.supportsNsfwDesc')}
              </div>
            </Field>
            <Field label={t('model.groups')} full>
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
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.groupsDesc')}
              </div>
            </Field>
            <Field label={t('model.tags')} full>
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
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag(tagDraft);
                  }
                }}
                placeholder={t('model.tagsPh')}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.tagsDesc', { max: MODEL_TAG_MAX, len: MODEL_TAG_LEN_MAX })}
              </div>
            </Field>
            <Field label={t('model.qps')}>
              <input
                type="number"
                min={0}
                step={0.1}
                placeholder={t('model.qpsDesc')}
                value={qpsText}
                onChange={(e) => onQpsChange(e.target.value)}
                onBlur={onQpsBlur}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('model.qpsHint')}
              </div>
            </Field>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" className="btn-primary" onClick={testConn} disabled={testing}>
              {testing ? t('model.testing') : t('model.testConnection')}
            </button>
            <button type="button" className="btn-ghost" onClick={detectModel} disabled={detecting || !cfg.id}>
              {detecting ? t('model.detecting') : t('model.detectCapabilities')}
            </button>
            {testState && (
              <span
                style={{
                  fontSize: 13,
                  color: testState.ok ? 'var(--color-primary)' : '#e06c75',
                }}
              >
                {testState.ok
                  ? t('model.testOk', { msg: testState.message })
                  : t('model.testFail', { msg: testState.message })}
              </span>
            )}
          </div>

          {/* 能力探针结果徽章 */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
            <CapBadge label={t('model.capImages')} on={cfg.supportsImages} />
            <CapBadge label={t('model.capTools')} on={cfg.supportsTools} />
            <CapBadge label={t('model.capJson')} on={cfg.supportsJson} />
            <CapBadge label={t('model.capNsfw')} on={cfg.supportsNsfw} />
            {cfg.lastDetectedAt ? (
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {t('model.capDetectedAt', { time: new Date(cfg.lastDetectedAt).toLocaleString() })}
              </span>
            ) : null}
          </div>

          <div
            style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              background: 'var(--color-input-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '8px 10px',
              marginTop: 4,
            }}
          >
            {t('model.baseUrlNote')}
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

const Field: React.FC<{ label: string; full?: boolean; children: React.ReactNode }> = ({
  label,
  full,
  children,
}) => (
  <div className={`field ${full ? 'full' : ''}`}>
    <label>{label}</label>
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
}> = ({ label, value, min, max, step, onChange, presets, format, full }) => (
  <Field label={label} full={full}>
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
