import React, { useState } from 'react';
import { useI18n } from '../i18n/I18nContext';

/**
 * 思维链折叠块：显示推理模型的思考过程。
 * - defaultOpen=false（设置「隐藏思维链」开启）时默认折叠，点击箭头展开
 * - 思考过程可一键复制（不会进入 AI 上下文与自动记忆，用户可手动复制到记忆）
 */
export const ReasoningBlock: React.FC<{
  reasoning: string;
  defaultOpen: boolean;
  streaming?: boolean;
  onCopied?: () => void;
}> = ({ reasoning, defaultOpen, streaming, onCopied }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard
      .writeText(reasoning)
      .then(() => onCopied?.())
      .catch(() => {});
  };
  return (
    <div className={`reasoning-block ${open ? 'open' : ''}`}>
      <div
        className="reasoning-head"
        onClick={() => setOpen((v) => !v)}
        title={open ? t('chat.reasoningCollapse') : t('chat.reasoningExpand')}
      >
        <span className={`reasoning-arrow ${open ? 'open' : ''}`}>▶</span>
        <span className="reasoning-label">
          {streaming ? t('chat.reasoningThinking') : t('chat.reasoningTitle')}
        </span>
        <a className="reasoning-copy" onClick={copy} title={t('chat.reasoningCopy')}>
          ⧉
        </a>
      </div>
      {open && <div className="reasoning-body">{reasoning}</div>}
    </div>
  );
};

export default ReasoningBlock;
