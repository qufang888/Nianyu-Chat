import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';

export interface RandomEventData {
  roleId: string;
  roleName: string;
  event: string;
  options: { text: string; affinity: number; mood: string }[];
}

interface Props {
  event?: RandomEventData | null;
  loading?: boolean;
  onChoose: (opt: { text: string; affinity: number; mood: string }) => void;
  onClose: () => void;
  onAutoChoose?: (opt: { text: string; affinity: number; mood: string }) => void;
}

const TIMEOUT_SECONDS = 60;

const RandomEventModal: React.FC<Props> = ({ event, loading, onChoose, onClose, onAutoChoose }) => {
  const { t } = useI18n();
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);
  const modalRef = useRef<HTMLDivElement>(null);
  const autoTriggered = useRef(false);
  const choosingRef = useRef(false); // loading 或 choice 阶段

  // 计算当前阶段：loading 还是 choice
  const isChoice = Boolean(event && !loading);
  const isLoad = loading || (!event && loading !== false);

  // 重置 countdown on mount/event change
  useEffect(() => {
    setCountdown(TIMEOUT_SECONDS);
    autoTriggered.current = false;
  }, [loading, event]);

  // 倒计时逻辑
  useEffect(() => {
    if (!isLoad && !isChoice) return;
    choosingRef.current = true;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(timer);
      choosingRef.current = false;
    };
  }, [isLoad, isChoice]);

  // 超时处理
  useEffect(() => {
    if (countdown > 0) return;
    if (autoTriggered.current) return;
    autoTriggered.current = true;

    if (isLoad) {
      // loading 超时 - 关闭弹窗
      onClose();
    } else if (isChoice && event && event.options.length > 0 && onAutoChoose) {
      // 选择超时 - 自动选第一个（按好感度排序后）
      const sorted = [...event.options].sort((a, b) => b.affinity - a.affinity);
      onAutoChoose(sorted[0]);
    }
  }, [countdown, isLoad, isChoice, event, onClose, onAutoChoose]);

  // 弹窗卸载时归还焦点给聊天输入框：避免焦点留在 body（关闭按钮/遮罩点击后），
  // 无需用户再手动点输入框。由聊天窗口监听后按需聚焦（无其他模态时）。
  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent('nianyu:restore-focus'));
    };
  }, []);

  const isUrgent = countdown <= 10;

  const sortedOptions = event?.options
    ? [...event.options].sort((a, b) => b.affinity - a.affinity)
    : [];

  return (
    <div className="event-overlay" onContextMenu={(e) => e.preventDefault()}>
      <div className="event-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <div className="event-modal-inner">
          {/* 标题栏 */}
          <div className="event-title">
            <span>🎲 {t('chat.randomEvent')}</span>
            {event && <span className="event-role">{event.roleName}</span>}
          </div>

          {/* 右上角关闭按钮 */}
          <button className="event-close-top" onClick={onClose}>✕</button>

          {/* 加载中 */}
          {isLoad && (
            <div className="event-loading">
              <span className="event-loading-spinner">⏳</span>
              <span>{t('chat.eventGenerating')}</span>
            </div>
          )}

          {/* 事件描述 + 选项 */}
          {event && (
            <>
              <div className="event-desc">{event.event}</div>
              <div className="event-prompt">{t('chat.eventChoosePrompt')}</div>
              <div className="event-options">
                {sortedOptions.map((opt, i) => {
                  const pos = opt.affinity >= 0;
                  const change = pos ? `+${opt.affinity}` : `${opt.affinity}`;
                  return (
                    <button
                      key={i}
                      className="event-option"
                      onClick={() => onChoose(opt)}
                    >
                      <span className="event-opt-text">{opt.text}</span>
                      <span className="event-opt-tags">
                        <span className={`event-aff ${pos ? 'pos' : 'neg'}`}>
                          {t('chat.eventAffinity', { change })}
                        </span>
                        <span className="event-mood">
                          {t('chat.eventMood', { mood: opt.mood })}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* 底部倒计时 */}
          <div className={`event-countdown${isUrgent ? ' urgent' : ''}`}>
            {isLoad
              ? t('chat.eventGeneratingTimeout', { sec: countdown })
              : t('chat.eventChoiceTimeout', { sec: countdown })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RandomEventModal;
