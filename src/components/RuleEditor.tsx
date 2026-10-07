// 规则（提示词）编辑器（v2.3.97 从 Library.tsx 原样抽离）
//
// 与 WorldBookEditor 同理：拖拽导入的「导入并编辑」需要在 Library 之外复用，
// 避免出现两套字段映射/校验逻辑。本文件内容与抽离前逐字一致，Library 侧行为零变化。
//
// 对外契约保持 `{ rule, onClose, onSaved }`。
import React, { useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { Rule } from '../types';
import { useToast } from './Toast';

export const RuleEditor: React.FC<{ rule: Rule; onClose: () => void; onSaved: () => void }> = ({
  rule,
  onClose,
  onSaved,
}) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<Rule>({ ...rule });

  const save = async () => {
    if (!draft.name.trim()) {
      showToast(t('library.nameRequired'), { error: true });
      return;
    }
    const shared = (await api.getSettings()).sharedRuleIds || [];
    const nextShared = shared.includes(draft.id) ? shared : [...shared, draft.id];
    await api.saveRule({ ...draft, name: draft.name.trim(), updated_at: new Date().toISOString() });
    // 新建的规则默认加入共用规则
    if (!shared.includes(draft.id)) await api.saveSettings({ sharedRuleIds: nextShared });
    showToast(t('toast.ruleSaved'));
    onSaved();
  };

  return (
    <div>
      <div className="field">
        <label>{t('library.name')}</label>
        <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </div>
      <div className="field">
        <label>{t('library.content')}</label>
        <textarea
          value={draft.content}
          onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
          rows={6}
        />
      </div>
      <div className="lib-toolbar">
        <button className="btn-primary" onClick={save}>
          {t('library.save')}
        </button>
        <button className="btn-ghost" onClick={onClose}>
          {t('library.cancel')}
        </button>
      </div>
    </div>
  );
};

export default RuleEditor;