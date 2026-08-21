import React, { useState, useEffect } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { PROVIDER_DEFAULTS, type ModelConfig, type Provider } from '../types';
import { useToast, ToastView } from './Toast';
import SelectMenu from './SelectMenu';

export const ModelEditor: React.FC<{
  initial?: ModelConfig;
  onClose: () => void;
  onSave: (cfg: ModelConfig) => void;
}> = ({ initial, onClose, onSave }) => {
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
  const [modelList, setModelList] = useState<string[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const set = (k: keyof ModelConfig, v: any) => setCfg((c) => ({ ...c, [k]: v }));

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
                  placeholder={cfg.provider === 'openai-compatible' ? '' : 'https://api.openai.com/v1'}
                />
                {cfg.provider === 'openai-compatible' && (
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                    {t('model.baseUrlHint')}
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
            <Field label={t('model.qps')}>
              <input
                type="number"
                min={0}
                placeholder={t('model.qpsDesc')}
                value={cfg.qps ?? ''}
                onChange={(e) => set('qps', e.target.value === '' ? undefined : Number(e.target.value) || 0)}
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
