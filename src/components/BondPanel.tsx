import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './Toast';
import { api } from '../ipc';
import type { Role, RelationType } from '../types';
import { RELATION_LABELS } from '../types';

// 关系值（bond）统计展示，由 AI 依据聊天内容自动判定，纯展示不影响剧情。
// 任一端经主进程广播 role:bond 后同步刷新，避免「主窗变了小窗没显示」。
export function BondPanel({
  roleId,
  roleName,
  onClose,
}: {
  roleId: string;
  roleName?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [role, setRole] = useState<Role | undefined>();
  const [triggering, setTriggering] = useState(false);

  const load = () => {
    api.getRole(roleId).then(setRole).catch(() => {});
  };
  useEffect(() => {
    load();
  }, [roleId]);

  useEffect(() => {
    const off = api.onRoleBond((_e, d: { roleId?: string }) => {
      if (d && d.roleId === roleId) load();
    });
    return off;
  }, [roleId]);

  const bond = role?.bond ?? 0;
  const relation = role?.relation;
  const level = role?.level ?? 1;
  const inLevel = ((bond % 100) + 100) % 100; // 当前等级内进度（0~99）
  const pct = Math.min(100, Math.max(0, inLevel));

  // 关系类别标签：优先取 i18n 翻译（含中文），缺失时回退 RELATION_LABELS，保证中文且可翻译
  const relationLabel = (() => {
    if (!relation) return '';
    const key = `relation.${relation}`;
    const tr = t(key);
    if (tr && tr !== key) return tr;
    return RELATION_LABELS[relation as RelationType] ?? relation;
  })();

  const handleTrigger = async () => {
    if (triggering) return;
    setTriggering(true);
    try {
      const res = await api.triggerRelationship('single', roleId, roleId, false);
      if (res?.noNewContent) {
        showToast(t('bond.noNewContent'));
        return;
      }
      if (res?.ok) {
        const parts: string[] = [];
        if (res.relation) parts.push(t('bond.relationUpdated'));
        if (res.moments > 0) parts.push(t('bond.momentsPosted', { n: res.moments }));
        showToast(parts.length ? parts.join('，') : t('bond.analyzed'));
      } else {
        showToast(t('bond.triggerFailed'));
      }
    } catch {
      showToast(t('bond.triggerFailed'));
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal bond-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>
            💞 {t('bond.title')}
            {roleName ? ` · ${roleName}` : ''}
          </span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body bond-body">
          <div className="bond-level">Lv.{level}</div>
          <div className="bond-value">
            {t('bond.value')} <b>{bond}</b>
          </div>
          {relation ? (
            <div className="bond-relation">
              {t('bond.relation')} <b>{relationLabel}</b>
            </div>
          ) : null}
          <div className="bond-trigger-row">
            <button className="btn-primary" onClick={handleTrigger} disabled={triggering}>
              {triggering ? t('bond.analyzing') : t('bond.triggerAnalyze')}
            </button>
            <span className="bond-trigger-hint">{t('bond.triggerHint')}</span>
          </div>
          <div className="bond-bar">
            <div className="bond-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="bond-bar-label">
            {inLevel}/100 → Lv.{level + 1}
          </div>
        </div>
      </div>
    </div>
  );
}
