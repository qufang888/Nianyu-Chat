import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { Role } from '../types';

/**
 * 新手引导（v2.3.90，可跳过）
 * ---------------------------------------------------------------------------
 * 与「初始设置向导」（OnboardingWizard，不可跳过、必须配模型）互斥：本组件只在
 * settings.firstRunDone === true 且 settings.tutorialDone !== true 且人物卡数为 0 时
 * 由 App.tsx 挂载，因此两者永远不会同时出现。
 *
 * 两个步骤，都是「真交互」——高亮真实 UI 元素，并在用户真正完成动作后自动推进：
 *   步骤 1「添加第一个人物卡」：高亮联系人页的 ＋ 按钮；roles.length > 0 即自动进入下一步。
 *   步骤 2「开启第一个聊天」：高亮该人物卡的「💬 聊天」按钮；发出第一条消息即自动完成。
 *
 * 遮罩只挡住高亮区域以外的部分（用 4 块面板围出「spotlight 洞」），高亮的按钮本身保持可点击。
 * 找不到目标元素（例如用户已点进聊天页、联系人页已卸载）时不渲染遮罩，只显示一张悬浮卡片，
 * 页面其余部分仍可正常操作——绝不挡住用户下一步要点的控件。
 */

type Step = 0 | 1;

/** 高亮目标元素在视口中的位置（已放大 padding，用于围出遮罩洞）。 */
interface SpotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TutorialOverlayProps {
  /** 是否展示（触发条件由 App.tsx 计算，保证与初始设置向导互斥）。 */
  show: boolean;
  /** 用户跳过 / 完成 → 父组件停止渲染本组件。 */
  onClose: () => void;
  /** 请求父组件切到联系人页，保证被高亮的元素已挂载。 */
  onGoToContacts?: () => void;
}

const CARD_WIDTH = 320;
const CARD_ESTIMATED_HEIGHT = 232;
const VIEWPORT_PADDING = 16;
const SPOT_PADDING = 8;
/** 轮询间隔：人物卡 / 消息都是异步落库，只能轮询感知。 */
const POLL_INTERVAL = 1500;

export const TutorialOverlay: React.FC<TutorialOverlayProps> = ({ show, onClose, onGoToContacts }) => {
  const { t } = useI18n();

  const [step, setStep] = useState<Step>(0);
  const [roles, setRoles] = useState<Role[]>([]);
  const [rect, setRect] = useState<SpotRect | null>(null);
  const [finished, setFinished] = useState(false);

  // 关闭后是否已经写过 tutorialDone，避免重复写库
  const persistedRef = useRef(false);
  // 步骤 1 是否已经请求过跳转联系人页（只请求一次，避免与用户手动切页打架）
  const goContactsRef = useRef(false);
  // onClose 存进 ref：保证下面的轮询 effect 不会因为父组件重建回调而反复重置定时器
  const onCloseRef = useRef(onClose);
  // 「完成卡片」自动关闭的延时器句柄
  const doneTimerRef = useRef(0);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /** 记录「已跳过/已完成」，写入 settings.tutorialDone，保证不再打扰。 */
  const persistDone = useCallback(() => {
    if (persistedRef.current) return;
    persistedRef.current = true;
    void api.saveSettings({ tutorialDone: true }).catch(() => {});
  }, []);

  /** 结束引导：可选先展示一小会儿「完成」卡片，再交给父组件卸载。 */
  const finish = useCallback(
    (showDoneCard: boolean) => {
      persistDone();
      if (!showDoneCard) {
        onCloseRef.current();
        return;
      }
      setFinished(true);
      doneTimerRef.current = window.setTimeout(() => onCloseRef.current(), 1800);
    },
    [persistDone]
  );

  // 卸载时清理「完成卡片」的延时器
  useEffect(() => () => window.clearTimeout(doneTimerRef.current), []);

  // 关闭时复位内部状态，便于下次重新运行
  useEffect(() => {
    if (show) return;
    setStep(0);
    setRoles([]);
    setRect(null);
    setFinished(false);
    persistedRef.current = false;
    goContactsRef.current = false;
  }, [show]);

  // ===== 步骤 1：轮询人物卡数量，> 0 即自动进入步骤 2 =====
  useEffect(() => {
    if (!show || finished) return;
    if (step !== 0) return;
    let alive = true;
    const load = () => {
      void api
        .getRoles()
        .then((list) => {
          if (!alive) return;
          setRoles(list);
          // 真的加上人物卡了 → 自动推进
          if (list.length > 0) setStep(1);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, POLL_INTERVAL);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [show, step, finished]);

  // ===== 步骤 2：轮询首条消息，发出即自动完成 =====
  useEffect(() => {
    if (!show || finished) return;
    if (step !== 1) return;
    const role = roles[0];
    // 人物卡被删光 → 退回步骤 1
    if (!role) {
      setStep(0);
      return;
    }
    let alive = true;
    const load = () => {
      void api
        .getMessages('single', role.id)
        .then((list) => {
          if (!alive) return;
          // 单聊 chat_id === role_id；聊天只有在发出第一条消息后才会落库
          if (list.length > 0) finish(true);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, POLL_INTERVAL);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [show, step, roles, finished, finish]);

  // ===== 步骤 1 需要联系人页在场，否则高亮目标不存在 =====
  useEffect(() => {
    if (!show || finished) return;
    if (step !== 0) return;
    if (goContactsRef.current) return;
    if (document.querySelector('[data-tutorial="add-role"]')) return;
    goContactsRef.current = true;
    onGoToContacts?.();
  }, [show, step, finished, onGoToContacts]);

  // ===== 目标元素定位：滚动 / 缩放 / DOM 变化时重算矩形 =====
  useEffect(() => {
    if (!show) return;
    const roleId = roles[0]?.id || '';

    const selector =
      step === 0
        ? '[data-tutorial="add-role"]'
        : roleId
          ? `[data-tutorial="start-chat"][data-tutorial-role="${roleId}"]`
          : '';

    const measure = () => {
      if (!selector) {
        setRect(null);
        return;
      }
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el || !el.isConnected) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      // 元素不可见（宽高为 0）时视为找不到，退化为居中卡片
      if (r.width <= 0 || r.height <= 0) {
        setRect(null);
        return;
      }
      setRect({
        top: r.top - SPOT_PADDING,
        left: r.left - SPOT_PADDING,
        width: r.width + SPOT_PADDING * 2,
        height: r.height + SPOT_PADDING * 2,
      });
    };

    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    // 兜底轮询：列表异步渲染完成、页面切换等情况未必触发上面两个事件
    const timer = window.setInterval(measure, 400);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.clearInterval(timer);
    };
  }, [show, step, roles]);

  if (!show) return null;

  // ===== 完成态：不再高亮任何元素，只展示 congratulations =====
  if (finished) {
    return (
      <div className="tutorial-root">
        <div className="tutorial-mask tutorial-mask-full" />
        <div className="tutorial-card tutorial-card-center">
          <div className="tutorial-done-emoji">🎉</div>
          <div className="tutorial-title">{t('tutorial.doneTitle')}</div>
          <div className="tutorial-body">{t('tutorial.doneBody')}</div>
        </div>
      </div>
    );
  }

  const isFirst = step === 0;
  const canAdvance = isFirst ? roles.length > 0 : true;
  const hasSpot = rect !== null;
  /* 「去联系人页」只在第 1 步出现：
     第 2 步找不到高亮目标，通常说明用户已经点进聊天页（联系人页已卸载），此时不该再让他跳回去。 */
  const showGoto = !hasSpot && isFirst;

  // ===== 卡片位置：贴着高亮区域下方；放不下则翻到上方；再兜底居中 =====
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
  let cardLeft = (vw - CARD_WIDTH) / 2;
  let cardTop: number;
  if (hasSpot && rect) {
    cardLeft = rect.left + rect.width / 2 - CARD_WIDTH / 2;
    cardTop = rect.top + rect.height + 14;
    if (cardTop + CARD_ESTIMATED_HEIGHT > vh - VIEWPORT_PADDING) {
      cardTop = rect.top - CARD_ESTIMATED_HEIGHT - 14;
    }
  } else {
    cardTop = (vh - CARD_ESTIMATED_HEIGHT) / 2;
  }
  cardLeft = Math.min(Math.max(cardLeft, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, vw - CARD_WIDTH - VIEWPORT_PADDING));
  cardTop = Math.min(Math.max(cardTop, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, vh - CARD_ESTIMATED_HEIGHT - VIEWPORT_PADDING));

  // ===== spotlight 洞：上下左右 4 块遮罩面板围出高亮区；洞内元素保持可点击 =====
  const hole = rect ?? { top: 0, left: 0, width: 0, height: 0 };
  const maskPanels = hasSpot
    ? [
        { key: 'top', style: { top: 0, left: 0, right: 0, height: Math.max(0, hole.top) } },
        {
          key: 'bottom',
          style: {
            top: hole.top + hole.height,
            left: 0,
            right: 0,
            bottom: 0,
          },
        },
        {
          key: 'left',
          style: { top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height },
        },
        {
          key: 'right',
          style: {
            top: hole.top,
            left: hole.left + hole.width,
            right: 0,
            height: hole.height,
          },
        },
      ]
    : [];

  return (
    <div className="tutorial-root">
      {/* 遮罩只在「spotlight 洞」存在时渲染：4 块面板围出高亮区，洞内元素保持可点击。
          找不到目标元素时不渲染任何遮罩——否则整屏遮罩会挡住用户下一步要操作的地方
          （例如第 2 步点进聊天后联系人页已卸载，遮罩会盖住聊天输入框）。 */}
      {hasSpot && (
        <>
          {maskPanels.map((p) => (
            <div key={p.key} className="tutorial-mask" style={p.style} />
          ))}
          <div
            className="tutorial-ring"
            style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
          />
        </>
      )}

      <div className="tutorial-card" style={{ left: cardLeft, top: cardTop, width: CARD_WIDTH }}>
        <div className="tutorial-head">
          <span className="tutorial-step">
            {t('tutorial.step', { cur: step + 1, total: 2 })}
          </span>
          <span className="tutorial-close" title={t('tutorial.close')} onClick={() => finish(false)}>
            ×
          </span>
        </div>
        <div className="tutorial-title">
          {isFirst ? t('tutorial.step1Title') : t('tutorial.step2Title')}
        </div>
        <div className="tutorial-body">
          {isFirst ? t('tutorial.step1Body') : t('tutorial.step2Body')}
        </div>
        <div className="tutorial-hint">
          {isFirst ? t('tutorial.step1Hint') : t('tutorial.step2Hint')}
        </div>
        {showGoto && (
          <button className="btn-primary tutorial-goto" onClick={() => onGoToContacts?.()}>
            {t('tutorial.gotoContacts')}
          </button>
        )}
        <div className="tutorial-actions">
          {!isFirst && (
            <button className="btn-ghost" onClick={() => setStep(0)}>
              {t('tutorial.back')}
            </button>
          )}
          <button className="btn-ghost tutorial-skip" onClick={() => finish(false)}>
            {t('tutorial.skip')}
          </button>
          <button
            className="btn-primary"
            disabled={!canAdvance}
            title={!canAdvance ? t('tutorial.step1Hint') : undefined}
            onClick={() => (isFirst ? setStep(1) : finish(true))}
          >
            {isFirst ? t('tutorial.next') : t('tutorial.finish')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TutorialOverlay;