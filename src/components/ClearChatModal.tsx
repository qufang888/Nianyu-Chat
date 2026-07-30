import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nContext';

interface Props {
  open: boolean;
  onConfirm: (withMemories: boolean) => void;
  onCancel: () => void;
}

// 清空当前聊天消息确认弹窗：可选是否连同自动记忆一起删除（手动记忆始终保留）
export function ClearChatModal({ open, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  const [withMem, setWithMem] = useState(false);
  if (!open) return null;

  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483645,
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, maxWidth: '90vw', background: 'var(--color-panel)',
          color: 'var(--color-text)', borderRadius: 12, padding: 20,
          border: '1px solid var(--color-border)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{t('chat.clearMessages')}</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-text-secondary)', marginBottom: 14 }}>
          {t('chat.clearMessagesConfirm')}
        </div>
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            marginBottom: 18, cursor: 'pointer', userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={withMem}
            onChange={(e) => setWithMem(e.target.checked)}
          />
          {t('chat.clearMessagesWithMem')}
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            className="btn"
            style={{ padding: '6px 16px', fontSize: 13 }}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            style={{ padding: '6px 16px', fontSize: 13 }}
            onClick={() => onConfirm(withMem)}
          >
            {t('chat.clearMessages')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
