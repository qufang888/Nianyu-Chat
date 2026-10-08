import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { Role, ModelConfig, WorldBook, Rule } from '../types';
import { useToast, ToastView } from './Toast';
import { MemoryPanel } from './MemoryPanel';
import { ImageCropper } from './ImageCropper';
import { previewSound } from '../utils/sound';
import SelectMenu from './SelectMenu';
import { RoleTtsBinding, normalizeRoleTts, isEmptyRoleTts, type RoleTtsDraft } from './RoleTtsBinding';

function emptyRole(): Role {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: '',
    avatar_path: '',
    gender: '',
    age: null,
    occupation: '',
    short_intro: '',
    personality: '',
    background: '',
    appearance: '',
    world_setting: '',
    key_memories: '',
    rules: '',
    example_dialogue: '',
    first_message: '',
    model_config_id: '',
    affinity: 50,
    affinity_factor: 1.0,
    worldBookId: '',
    ruleIds: [],
    memoryIsolation: true, // 记忆隔离默认开启
    created_at: now,
    updated_at: now,
  };
}

export const RoleEditor: React.FC<{
  initial?: Role;
  onClose: () => void;
  onSaved: () => void;
}> = ({ initial, onClose, onSaved }) => {
  const { t } = useI18n();
  const [role, setRole] = useState<Role>(initial ? { ...initial } : emptyRole());
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const { toast, showToast } = useToast();
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => {
    api.listWorldBooks().then(setWorldBooks);
    api.listRules().then(setRules);
  }, []);

  useEffect(() => {
    api.getSettings().then((s) => setModels(s.models || []));
  }, []);

  // ===== 人物音色绑定 + 音色自定义（v2.3.94 需求 8 / 9）=====
  // 绑定数据存在 settings.voice.ttsVoices[roleId]，与设置页「按角色配置音色」共用同一份数据，
  // 两处互为镜像：这里改完保存，设置页立刻能看到；反之亦然。
  // roleId 用 state 里的 role.id（新角色在 emptyRole() 里就生成了 uuid），故新建时也能绑。
  const [ttsDraft, setTtsDraft] = useState<RoleTtsDraft>(() => normalizeRoleTts(undefined));
  // 打开已有角色时载入其音色绑定（旧格式纯音色名由 normalizeRoleTts 自动兼容）
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setTtsDraft(normalizeRoleTts(s?.voice?.ttsVoices?.[role.id]));
      })
      .catch(() => { /* 忽略：读不到就当作未绑定 */ });
    return () => {
      cancelled = true;
    };
    // 仅在打开另一个角色时重新载入；角色 id 在本弹窗生命周期内不变（新建时也是一次性 uuid）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id]);

  // 模型能力摘要（用于下拉选项悬停提示与选择器 title）
  const modelCapText = (m: ModelConfig): string => {
    const caps: string[] = [];
    if (m.supportsImages) caps.push(t('model.capImages'));
    if (m.supportsTools) caps.push(t('model.capTools'));
    if (m.supportsJson) caps.push(t('model.capJson'));
    if (m.supportsReasoning) caps.push(t('model.supportsReasoning'));
    const c = caps.length ? caps.join(' / ') : t('model.capUnknown');
    const ctx = m.maxContext ? ` · ${t('model.maxContext')}：${m.maxContext}` : '';
    return `${m.name}：${c}${ctx}`;
  };
  const modelCapTip = (m: ModelConfig) => (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{m.name}</div>
      <div>{`${t('model.capImages')}：${m.supportsImages ? t('model.capYes') : t('model.capNo')}`}</div>
      <div>{`${t('model.capTools')}：${m.supportsTools ? t('model.capYes') : t('model.capNo')}`}</div>
      <div>{`${t('model.capJson')}：${m.supportsJson ? t('model.capYes') : t('model.capNo')}`}</div>
      <div>{`${t('model.supportsReasoning')}：${m.supportsReasoning ? t('model.capYes') : t('model.capNo')}`}</div>
      {m.maxContext ? <div style={{ marginTop: 4 }}>{`${t('model.maxContext')}：${m.maxContext}`}</div> : null}
    </div>
  );

  // 必须在 currentModel 之前声明，避免 render 期 find 回调引用未初始化的 const（TDZ）
  const enabledModels = models.filter((m) => m.enabled);
  const selectedModel = role.model_config_id || enabledModels[0]?.id || '';
  const currentModel = models.find((m) => m.id === selectedModel);

  // ESC 关闭（仅叉号 / ESC 可退出，点空白不关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);


  const set = (k: keyof Role, v: any) => setRole((r) => ({ ...r, [k]: v }));

  const pickAvatar = async () => {
    const paths = await api.pickImage();
    if (paths && paths.length) {
      const src = await api.getImage(paths[0]);
      if (src) setCrop({ open: true, src, path: paths[0] });
    }
  };

  const [crop, setCrop] = useState<{ open: boolean; src: string; path: string }>({
    open: false,
    src: '',
    path: '',
  });

  // 角色自定义消息音效（选文件 -> 复制到 userData，存文件名）
  const pickRoleSound = async () => {
    const src = await api.pickAudioFile();
    if (!src) return;
    const fname = await api.setCustomSound({ key: `role:${role.id}`, srcPath: src });
    if (!fname) {
      showToast(t('common.failed'));
      return;
    }
    set('soundPath', fname);
  };
  const clearRoleSound = () => set('soundPath', null);
  const previewRoleSound = () => {
    if (role.soundPath) void previewSound('notification', role.soundPath);
  };

  const aiComplete = async () => {
    if (!role.name && !role.short_intro) {
      setMsg(t('role.aiNeedName'));
      return;
    }
    setBusy(true);
    setMsg(t('role.aiGenerating'));
    try {
      const raw = await api.aiCompleteRole(
        {
          name: role.name,
          gender: role.gender,
          age: String(role.age ?? ''),
          occupation: role.occupation,
          short_intro: role.short_intro,
        },
        selectedModel
      );
      const json = extractJSON(raw);
      if (json) {
        setRole((r) => ({
          ...r,
          personality: json.personality || r.personality,
          background: json.background || r.background,
          appearance: json.appearance || r.appearance,
          world_setting: json.world_setting || r.world_setting,
          rules: json.rules || r.rules,
          example_dialogue: json.example_dialogue || r.example_dialogue,
          first_message: json.first_message || r.first_message,
        }));
        setMsg(t('role.aiFilled'));
      } else {
        setMsg(t('role.aiParseFail'));
      }
    } catch (e: any) {
      setMsg(t('role.aiFail', { msg: e?.message || e }));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!role.name.trim()) {
      setMsg(t('role.needName'));
      return;
    }
    if (!selectedModel) {
      setMsg(t('role.needModel'));
      return;
    }
    await api.saveRole({
      ...role,
      model_config_id: selectedModel,
      updated_at: new Date().toISOString(),
    });
    // 音色绑定单独存 settings（与设置页共用 voice.ttsVoices），故角色保存成功后再写一次。
    // 全部字段为空 → 删除该角色的键（而不是留空对象），保持与设置页一致的数据卫生。
    try {
      const s = await api.getSettings();
      const map = { ...(s?.voice?.ttsVoices || {}) };
      if (isEmptyRoleTts(ttsDraft)) delete map[role.id];
      else map[role.id] = ttsDraft;
      await api.saveSettings({ voice: { ...(s?.voice || {}), ttsVoices: map } as any });
    } catch {
      showToast(t('roleTts.saveFailed'));
    }
    showToast(t('role.saved'));
    onSaved();
  };

  // 从文件导入角色卡（兼容本软件、SillyTavern JSON 以及 SillyTavern PNG 角色卡），
  // 解析后填充到当前表单；PNG 角色卡会自动以图本身作为头像
  const importCard = async () => {
    const res = await api.importCharacterCard();
    if (!res || res.error || !res.parsed || !res.parsed.name) {
      setMsg(t('role.importCardFail'));
      return;
    }
    const p = res.parsed;
    setRole((r) => ({
      ...r,
      name: p.name || r.name,
      gender: p.gender || r.gender,
      age: p.age ?? r.age,
      occupation: p.occupation || r.occupation,
      short_intro: p.short_intro || r.short_intro,
      personality: p.personality || r.personality,
      background: p.background || r.background,
      appearance: p.appearance || r.appearance,
      world_setting: p.world_setting || r.world_setting,
      key_memories: p.key_memories || r.key_memories,
      rules: p.rules || r.rules,
      example_dialogue: p.example_dialogue || r.example_dialogue,
      first_message: p.first_message || r.first_message,
      avatar_path: res.avatarPath || r.avatar_path,
    }));
    setMsg(t('role.importCardDone', { name: p.name || '' }));
  };

  return (
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{initial ? t('role.editTitle') : t('role.newTitle')}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body">
          {msg && (
            <div style={{ marginBottom: 12, color: 'var(--color-primary-ink)', fontSize: 13 }}>{msg}</div>
          )}
          <div className="form-grid">
            <Field label={t('role.name')} full>
              <input value={role.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label={t('role.gender')}>
              <input
                value={role.gender}
                onChange={(e) => set('gender', e.target.value)}
                placeholder={t('role.genderPh')}
              />
            </Field>
            <Field label={t('role.age')}>
              <input
                type="number"
                value={role.age ?? ''}
                onChange={(e) => set('age', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label={t('role.occupation')}>
              <input value={role.occupation} onChange={(e) => set('occupation', e.target.value)} />
            </Field>
            <Field label={t('role.shortIntro')} full>
              <input value={role.short_intro} onChange={(e) => set('short_intro', e.target.value)} />
            </Field>
            <Field label={t('role.personality')} full>
              <textarea value={role.personality} onChange={(e) => set('personality', e.target.value)} />
            </Field>
            <Field label={t('role.background')} full>
              <textarea value={role.background} onChange={(e) => set('background', e.target.value)} />
            </Field>
            <Field label={t('role.appearance')} full>
              <textarea value={role.appearance} onChange={(e) => set('appearance', e.target.value)} />
            </Field>
            <Field label={t('role.worldSetting')} full>
              <textarea
                value={role.world_setting}
                onChange={(e) => set('world_setting', e.target.value)}
              />
            </Field>
            <Field label={t('role.keyMemories')} full>
              <textarea
                value={role.key_memories}
                onChange={(e) => set('key_memories', e.target.value)}
              />
            </Field>
            <Field label={t('role.rules')} full>
              <textarea value={role.rules} onChange={(e) => set('rules', e.target.value)} />
            </Field>
            <Field label={t('role.exampleDialogue')} full>
              <textarea
                value={role.example_dialogue}
                onChange={(e) => set('example_dialogue', e.target.value)}
              />
            </Field>
            <Field label={t('role.firstMessage')} full>
              <textarea
                value={role.first_message}
                onChange={(e) => set('first_message', e.target.value)}
              />
            </Field>
            <div className="section-title" style={{ gridColumn: '1 / -1', margin: '6px 0 4px' }}>
              {t('role.interaction')}
            </div>
            <Field label={t('role.model')} full>
              {enabledModels.length === 0 ? (
                <span style={{ color: '#e06c75', fontSize: 13 }}>{t('role.noModel')}</span>
              ) : (
                <SelectMenu
                  value={selectedModel}
                  onChange={(v) => set('model_config_id', v)}
                  title={currentModel ? modelCapText(currentModel) : undefined}
                  options={enabledModels.map((m) => ({
                    value: m.id,
                    label: `${m.name}（${m.model}）`,
                    tooltip: modelCapTip(m),
                  }))}
                />
              )}
            </Field>
            <Field label={t('role.initAffinity')}>
              <input
                type="number"
                min={0}
                max={100}
                value={role.affinity}
                onChange={(e) => set('affinity', Math.max(0, Math.min(100, Number(e.target.value))))}
              />
            </Field>
            <Field label={t('role.affinityFactor')}>
              <input
                type="number"
                step={0.1}
                value={role.affinity_factor}
                onChange={(e) => set('affinity_factor', Number(e.target.value) || 1.0)}
              />
            </Field>
            <Field label={t('role.momentDailyLimit')} hint={t('role.momentDailyLimitHint')}>
              <input
                type="number"
                min={0}
                placeholder={t('role.momentDailyLimitPlaceholder')}
                value={role.momentDailyLimit ?? ''}
                onChange={(e) =>
                  set('momentDailyLimit', e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))
                }
              />
            </Field>
            <Field label={t('role.worldbook')} full>
              <SelectMenu
                value={role.worldBookId || ''}
                onChange={(v) => set('worldBookId', v)}
                options={[
                  { value: '', label: t('worldbook.inherit') },
                  { value: 'none', label: t('worldbook.none') },
                  ...worldBooks.map((wb) => ({ value: wb.id, label: wb.name })),
                ]}
              />
            </Field>
            <Field label={t('role.rulesLib')} full>
              <div className="check-list">
                {rules.length === 0 ? (
                  <span className="muted">{t('library.noRule')}</span>
                ) : (
                  rules.map((r) => (
                    <label className="check-item" key={r.id}>
                      <input
                        type="checkbox"
                        checked={(role.ruleIds || []).includes(r.id)}
                        onChange={(e) => {
                          const cur = role.ruleIds || [];
                          set('ruleIds', e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id));
                        }}
                      />
                      <span>{r.name}</span>
                    </label>
                  ))
                )}
              </div>
            </Field>
            <Field label={t('role.memoryIsolation')} hint={t('role.memoryIsolationHint')}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={role.memoryIsolation ?? true}
                  onChange={(e) => set('memoryIsolation', e.target.checked)}
                />
                {(role.memoryIsolation ?? true) ? t('role.enabledOn') : t('role.enabledOff')}
              </label>
            </Field>
            <Field label={t('role.sound')} full>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                {t('role.soundTip', { name: role.name || t('role.name') })}
              </div>
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                {role.soundPath ? role.soundPath : t('role.soundDefault')}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-ghost" onClick={pickRoleSound}>
                  {t('settings.soundPick')}
                </button>
                <button className="btn-ghost" onClick={previewRoleSound} disabled={!role.soundPath}>
                  {t('settings.soundPreview')}
                </button>
                <button className="btn-ghost" onClick={clearRoleSound} disabled={!role.soundPath}>
                  {t('role.soundClear')}
                </button>
              </div>
            </Field>
            {/* ===== 人物音色绑定 + 语速/音调自定义（v2.3.94 需求 8 / 9）===== */}
            <div className="section-title" style={{ gridColumn: '1 / -1', margin: '6px 0 4px' }}>
              {t('roleTts.title')}
            </div>
            <RoleTtsBinding
              roleId={role.id}
              value={ttsDraft}
              // 组件用 null 表示「清除绑定」，state 里统一存成空对象（保存时再判断是否删键）
              onChange={(next) => setTtsDraft(next ?? {})}
            />
          </div>
          <div className="section-title" style={{ margin: '8px 0 6px' }}>
            {t('memory.title')}
          </div>
          <MemoryPanel roleId={role.id} />
          <div className="row-actions">
            <button className="btn-primary" onClick={aiComplete} disabled={busy}>
              {busy ? t('role.generating') : t('role.aiComplete')}
            </button>
            <button className="btn-ghost" onClick={importCard}>
              {t('role.importCard')}
            </button>
            <button className="btn-ghost" onClick={pickAvatar}>
              {t('role.chooseAvatar')}
            </button>
            {role.avatar_path && (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', alignSelf: 'center' }}>
                {t('role.avatarChosen')}
              </span>
            )}
          </div>
          <div className="row-actions">
            <button className="btn-primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>

      {crop.open && (
        <ImageCropper
          src={crop.src}
          outputSize={256}
          title={t('role.cropAvatar')}
          hint={t('role.avatarCropHint')}
          onClose={() => setCrop({ open: false, src: '', path: '' })}
          onCrop={async (dataUrl) => {
            const savedPath = await api.saveImage(dataUrl);
            if (savedPath) {
              set('avatar_path', savedPath);
              showToast(t('role.avatarSavedTip'));
            }
            setCrop({ open: false, src: '', path: '' });
          }}
        />
      )}
      <ToastView toast={toast} />
    </div>
  );
};

const Field: React.FC<{ label: string; full?: boolean; hint?: string; children: React.ReactNode }> = ({
  label,
  full,
  hint,
  children,
}) => (
  <div className={`field ${full ? 'full' : ''}`}>
    <label>{label}</label>
    {children}
    {hint ? <div className="field-hint">{hint}</div> : null}
  </div>
);

function extractJSON(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------- 下面用独立的 ImageCropper 组件（不再内联 AvatarCropper） ----------
