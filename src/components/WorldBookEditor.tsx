// 世界书编辑器（v2.3.97 从 Library.tsx 原样抽离）
//
// 抽离原因：拖拽导入的「导入并编辑」需要在 Library 之外（App.tsx 的预检确认弹窗里）
// 复用同一个编辑器 —— 否则会出现两套字段映射/校验逻辑，改一处漏一处。
// 本文件内容与抽离前**逐字一致**（含 className、i18n key、保存前 name 非空校验），
// Library.tsx 改为 import 使用，两侧行为零变化。
//
// 对外契约保持 `{ wb, onClose, onSaved }`：
//   - wb      初始值（会被拷贝成内部草稿；本组件不修改入参）
//   - onClose 用户放弃编辑（不保存）
//   - onSaved 用户点了保存且保存成功（调用方负责刷新列表 / 关弹窗）
import React, { useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { WorldBook, WorldBookEntry } from '../types';
import { useToast } from './Toast';

export const WorldBookEditor: React.FC<{
  wb: WorldBook;
  onClose: () => void;
  onSaved: () => void;
}> = ({ wb, onClose, onSaved }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<WorldBook>({ ...wb });

  const setField = (k: keyof WorldBook, v: any) => setDraft((d) => ({ ...d, [k]: v }));
  const setEntry = (i: number, k: keyof WorldBookEntry, v: any) =>
    setDraft((d) => ({
      ...d,
      entries: d.entries.map((e, idx) => (idx === i ? { ...e, [k]: v } : e)),
    }));
  const addEntry = () =>
    setDraft((d) => ({
      ...d,
      entries: [...d.entries, { id: crypto.randomUUID(), key: '', content: '' }],
    }));
  const delEntry = (i: number) =>
    setDraft((d) => ({ ...d, entries: d.entries.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!draft.name.trim()) {
      showToast(t('library.nameRequired'), { error: true });
      return;
    }
    await api.saveWorldBook({ ...draft, name: draft.name.trim(), updated_at: new Date().toISOString() });
    showToast(t('toast.worldbookSaved'));
    onSaved();
  };

  return (
    <div>
      <div className="field">
        <label>{t('library.name')}</label>
        <input value={draft.name} onChange={(e) => setField('name', e.target.value)} />
      </div>
      <div className="field">
        <label>{t('library.description')}</label>
        <input value={draft.description || ''} onChange={(e) => setField('description', e.target.value)} />
      </div>
      <div className="field">
        <label>{t('library.content')}</label>
        <textarea value={draft.content} onChange={(e) => setField('content', e.target.value)} rows={6} />
      </div>
      <div className="field">
        <label>{t('library.entries')}</label>
        {draft.entries.map((e, i) => (
          <div className="entry-row" key={e.id}>
            <input
              placeholder={t('library.entryKey')}
              value={e.key}
              onChange={(ev) => setEntry(i, 'key', ev.target.value)}
            />
            <textarea
              placeholder={t('library.entryContent')}
              value={e.content}
              onChange={(ev) => setEntry(i, 'content', ev.target.value)}
              rows={2}
            />
            <button className="btn-ghost" onClick={() => delEntry(i)}>
              {t('library.delete')}
            </button>
          </div>
        ))}
        <button className="btn-ghost" onClick={addEntry}>
          + {t('library.addEntry')}
        </button>
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

export default WorldBookEditor;