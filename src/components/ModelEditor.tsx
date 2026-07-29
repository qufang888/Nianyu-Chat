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
    if (!cfg.baseUrl) {
      setListError(t('model.listFail', { msg: '请先填写 API Base URL' }));
      return;
    }
    setListLoading(true);
    setListError('');
    setModelList([]);
    try {
      const list = await api.listModels({ ...cfg });
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
      showToast(t('model.testFailToast'), true);
    } finally {
      setTesting(false);
    }
  };

  const onProvider = (p: Provider) => {
    const d = PROVIDER_DEFAULTS[p];
    setCfg((c) => ({ ...c, provider: p, baseUrl: d.baseUrl, model: d.model, maxContext: d.maxContext }));
  };

  const save = () => {
    if (!cfg.name.trim()) return setMsg(t('model.needName'));
    if (!cfg.baseUrl.trim()) return setMsg(t('model.needBaseUrl'));
    if (!cfg.model.trim()) return setMsg(t('model.needModelId'));
    onSave({ ...cfg, name: cfg.name.trim(), model: cfg.model.trim() });
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
                  disabled={listLoading || !cfg.baseUrl}
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
            <Field label={t('model.maxContext')}>
              <input
                type="number"
                value={cfg.maxContext}
                onChange={(e) => set('maxContext', Number(e.target.value) || 0)}
              />
            </Field>
            <Field label={t('model.temperature', { value: cfg.temperature.toFixed(1) })}>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={cfg.temperature}
                onChange={(e) => set('temperature', Number(e.target.value))}
                style={{ width: '100%' }}
              />
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
