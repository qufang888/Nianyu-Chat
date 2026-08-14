import React, { useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeName, ModelConfig, SelfRole, Role } from '../types';
import { THEMES } from './Settings';
import { ModelEditor } from './ModelEditor';
import { SelfRoleEditor } from './SelfRoleEditor';
import { type ParsedCharacter } from '../utils/characterCard';
import { useToast, ToastView } from './Toast';

const TOTAL = 5;

function cardToRole(p: ParsedCharacter, defaultName: string): Role {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: p.name || defaultName,
    avatar_path: '',
    gender: p.gender || '',
    age: p.age ?? null,
    occupation: p.occupation || '',
    short_intro: p.short_intro || '',
    personality: p.personality || '',
    background: p.background || '',
    appearance: p.appearance || '',
    world_setting: p.world_setting || '',
    key_memories: p.key_memories || '',
    rules: p.rules || '',
    example_dialogue: p.example_dialogue || '',
    first_message: p.first_message || '',
    model_config_id: '',
    affinity: 50,
    affinity_factor: 1.0,
    worldBookId: '',
    ruleIds: [],
    created_at: now,
    updated_at: now,
  };
}

// 首次启动向导：主题 → 模型(必填) → 世界书 → 角色卡导入 → 自我身份
export const OnboardingWizard: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const { settings, setTheme: applyTheme } = useTheme();

  const [step, setStep] = useState(1);
  const [theme, setTheme] = useState<ThemeName>(settings?.theme || 'wechat');
  const [models, setModels] = useState<ModelConfig[]>(settings?.models || []);
  const [worldBook, setWorldBook] = useState<string>(settings?.worldBook || '');
  const [selfRoles, setSelfRoles] = useState<SelfRole[]>(settings?.selfRoles || []);
  const [currentSelfRoleId, setCurrentSelfRoleId] = useState<string>(settings?.currentSelfRoleId || '');

  const [modelEditorOpen, setModelEditorOpen] = useState(false);
  const [modelInitial, setModelInitial] = useState<ModelConfig | undefined>(undefined);
  const [selfEditorOpen, setSelfEditorOpen] = useState(false);
  const [selfInitial, setSelfInitial] = useState<SelfRole | undefined>(undefined);
  const [importedCount, setImportedCount] = useState(0);

  // ===== 模型（必填）=====
  const onModelSave = (cfg: ModelConfig) => {
    const exists = models.find((m) => m.id === cfg.id);
    const next = exists ? models.map((m) => (m.id === cfg.id ? cfg : m)) : [...models, cfg];
    setModels(next);
    setModelEditorOpen(false);
  };
  const onModelDelete = async (id: string) => {
    if (!(await api.showConfirm!(t('settings.confirmDeleteModel')))) return;
    setModels(models.filter((m) => m.id !== id));
  };

  // ===== 世界书导入 =====
  const importWb = async () => {
    const f = await api.pickTextFile();
    if (!f) return;
    setWorldBook(f.content);
  };

  // ===== 角色卡导入（兼容 SillyTavern JSON / PNG） =====
  const importCard = async () => {
    const res = await api.importCharacterCard();
    if (!res || res.error || !res.parsed || !res.parsed.name) {
      showToast(t('role.importCardFail'), { error: true });
      return;
    }
    const role = cardToRole(res.parsed, t('role.importedFallbackName'));
    if (res.avatarPath) role.avatar_path = res.avatarPath;
    await api.saveRole(role);
    setImportedCount((c) => c + 1);
  };

  // ===== 自我身份 =====
  const onSelfSaved = (role: SelfRole) => {
    const exists = selfRoles.find((r) => r.id === role.id);
    const next = exists ? selfRoles.map((r) => (r.id === role.id ? role : r)) : [...selfRoles, role];
    setSelfRoles(next);
    if (!currentSelfRoleId) setCurrentSelfRoleId(role.id);
    setSelfEditorOpen(false);
  };

  const finish = async () => {
    if (models.length === 0) {
      showToast(t('onboarding.needModel'), { error: true });
      setStep(2);
      return;
    }
    await api.saveSettings({
      theme,
      models,
      defaultModel: settings?.defaultModel || (models[0]?.id || ''),
      worldBook,
      selfRoles,
      currentSelfRoleId: currentSelfRoleId || (selfRoles[0]?.id || ''),
      firstRunDone: true,
    });
    onDone();
  };

  const canNext = step !== 2 || models.length > 0;

  // 从备份恢复：选择备份 zip 后由主进程还原数据并重启（还原后备份中的 firstRunDone 为真，自动跳过向导）
  const restoreFromBackup = async () => {
    const zip = await api.pickRestoreFile();
    if (!zip) return;
    try {
      await api.restoreBackup(zip);
    } catch (e: any) {
      showToast(t('onboarding.restoreFailed', { err: e?.message || String(e) }), { error: true });
    }
  };

  return (
    <div className="modal-mask" style={{ alignItems: 'stretch', justifyContent: 'center' }}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: '94vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-head" style={{ flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{t('onboarding.title')}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              {t('onboarding.subtitle')}
            </div>
          </div>
          <span className="modal-close" onClick={() => showToast(t('onboarding.needModel'), { error: true })} title={t('onboarding.needModel')}>
            ×
          </span>
        </div>

        {/* 步骤指示器 */}
        <div style={{ display: 'flex', gap: 6, padding: '10px 16px', flexShrink: 0 }}>
          {Array.from({ length: TOTAL }, (_, i) => i + 1).map((n) => (
            <div
              key={n}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 4,
                background: n <= step ? 'var(--color-primary)' : 'var(--color-border)',
              }}
            />
          ))}
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>
          {step === 1 && (
            <div>
              <div className="section-title">{t('onboarding.theme')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                {t('onboarding.themeDesc')}
              </div>
              <div className="theme-options">
                {THEMES.map((ti) => (
                  <div
                    key={ti.key}
                    className={`theme-card ${theme === ti.key ? 'active' : ''}`}
                    onClick={() => {
                      setTheme(ti.key);
                      applyTheme(ti.key);
                    }}
                  >
                    <div className="theme-swatch" style={{ background: ti.swatch }} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{t(ti.nameKey)}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {theme === ti.key ? t('settings.current') : t('settings.clickSwitch')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="section-title">{t('onboarding.model')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                {t('onboarding.modelDesc')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                {models.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '8px 12px',
                      minWidth: 200,
                      background: 'var(--color-panel-alt)',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{m.model}</div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                      <button
                        className="btn-ghost"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                        onClick={() => {
                          setModelInitial(m);
                          setModelEditorOpen(true);
                        }}
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        className="btn-ghost"
                        style={{ padding: '3px 10px', fontSize: 12, color: '#e06c75' }}
                        onClick={() => onModelDelete(m.id)}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                ))}
                {models.length === 0 && (
                  <div style={{ color: '#e06c75', fontSize: 13 }}>{t('onboarding.modelRequired')}</div>
                )}
              </div>
              <button
                className="btn-primary"
                onClick={() => {
                  setModelInitial(undefined);
                  setModelEditorOpen(true);
                }}
              >
                {t('settings.addModel')}
              </button>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="section-title">{t('onboarding.worldBook')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                {t('onboarding.worldBookDesc')}
              </div>
              <textarea
                value={worldBook}
                onChange={(e) => setWorldBook(e.target.value)}
                placeholder={t('worldbook.placeholder')}
                style={{
                  width: '100%',
                  minHeight: 160,
                  background: 'var(--color-input-bg)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 10,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
              />
              <div style={{ marginTop: 8 }}>
                <button className="btn-ghost" onClick={importWb}>
                  {t('worldbook.import')}
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <div className="section-title">{t('onboarding.cards')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                {t('onboarding.cardsDesc')}
              </div>
              <button className="btn-primary" onClick={importCard}>
                {t('onboarding.cardsImport')}
              </button>
              {importedCount > 0 && (
                <div style={{ marginTop: 10, fontSize: 13, color: 'var(--color-primary)' }}>
                  {t('onboarding.cardsImported', { n: importedCount })}
                </div>
              )}
            </div>
          )}

          {step === 5 && (
            <div>
              <div className="section-title">{t('onboarding.selfRole')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                {t('onboarding.selfRoleDesc')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {selfRoles.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      border: currentSelfRoleId === r.id ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '8px 12px',
                      minWidth: 180,
                      background: 'var(--color-panel-alt)',
                    }}
                  >
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{r.name}</span>
                      {currentSelfRoleId === r.id && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: '#fff',
                            background: 'var(--color-primary)',
                            borderRadius: 8,
                            padding: '1px 7px',
                          }}
                        >
                          {t('self.defaultBadge')}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                      <button
                        className="btn-ghost"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                        onClick={() => {
                          setSelfInitial(r);
                          setSelfEditorOpen(true);
                        }}
                      >
                        {t('self.edit')}
                      </button>
                      <button
                        className="btn-ghost"
                        style={{
                          padding: '3px 10px',
                          fontSize: 12,
                          color: currentSelfRoleId === r.id ? 'var(--color-text-secondary)' : 'var(--color-primary)',
                        }}
                        onClick={() => setCurrentSelfRoleId(currentSelfRoleId === r.id ? '' : r.id)}
                      >
                        {currentSelfRoleId === r.id ? t('self.unsetDefault') : t('self.setDefault')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => { setSelfInitial(undefined); setSelfEditorOpen(true); }}>
                {t('onboarding.selfAdd')}
              </button>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            borderTop: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn-ghost" onClick={restoreFromBackup} title={t('onboarding.restoreBackupDesc')}>
              📦 {t('onboarding.restoreBackup')}
            </button>
            {step > 1 && (
              <button className="btn-ghost" onClick={() => setStep((s) => Math.max(1, s - 1))}>
                {t('onboarding.back')}
              </button>
            )}
            {step < TOTAL ? (
              <button className="btn-primary" disabled={!canNext} onClick={() => setStep((s) => Math.min(TOTAL, s + 1))}>
                {t('onboarding.next')}
              </button>
            ) : (
              <button className="btn-primary" onClick={finish}>
                {t('onboarding.finish')}
              </button>
            )}
          </div>
        </div>

        {modelEditorOpen && (
          <ModelEditor
            initial={modelInitial}
            onClose={() => setModelEditorOpen(false)}
            onSave={onModelSave}
          />
        )}
        {selfEditorOpen && (
          <SelfRoleEditor
            initial={selfInitial}
            title={selfInitial ? t('self.edit') : t('self.new')}
            onClose={() => setSelfEditorOpen(false)}
            onSaved={onSelfSaved}
          />
        )}
      <ToastView toast={toast} />
      </div>
    </div>
  );
};
