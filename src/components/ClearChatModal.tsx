import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nContext';

interface Props {
  open: boolean;
  onConfirm: (withMemories: boolean) => void;
  onCancel: () => void;
}

/**
 * 清空当前聊天消息确认弹窗：可选是否连同自动记忆一起删除（手动记忆始终保留）
 *
 * v2.3.97：原先整块遮罩 + 面板都是**内联 style**，既拿不到入场动画
 * （用户要求所有弹窗都有线性弹出动画），也不受动效开关的custom 档管控，
 * 还不便于统一玻璃主题的加深规则。现改用通用模态三件套
 * `.modal-mask` + `.modal`（index.css），动画与门禁一次性全部生效。
 * 仅保留「宽度 360px」这一个必须内联的差异值。
 */
export function ClearChatModal({ open, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  const [withMem, setWithMem] = useState(false);
  if (!open) return null;

  return createPortal(
    <div className="modal-mask" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 360 }}
      >
        <div className="modal-title">{t('chat.clearMessages')}</div>
        <div className="modal-desc">{t('chat.clearMessagesConfirm')}</div>
        <label className="clear-chat-mem-option">
          <input
            type="checkbox"
            checked={withMem}
            onChange={(e) => setWithMem(e.target.checked)}
          />
          {t('chat.clearMessagesWithMem')}
        </label>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={() => onConfirm(withMem)}>
            {t('chat.clearMessages')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}