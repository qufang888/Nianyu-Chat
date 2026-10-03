// 念语 · 异步场景生图状态条（v2.3.81）
//
// 用途：异步场景生图（主进程 triggerSceneImage）开始后，在**当前会话内**显示一条轻量内联状态条
// 「正在生图中…」，成功 / 失败后自动消失。成功与失败的**提醒**由本模块一并处理：
//   - 当前窗口正在看该会话 → 站内 Toast（低噪音，不打断输入）
//   - 当前窗口不在该会话 / 不可见 → 交给主进程的后台提醒卡片（showNotifyCard），此处不重复打扰
//
// 设计要点：
// 1) **单一数据源**：主界面与小窗共用本文件的 useSceneImageStatus，避免两端逻辑漂移。
// 2) **超时兜底**：生图请求若挂起（网络无响应 / 进程卡住），started 之后收不到 success/failed，
//    状态条会永久卡住。故设 SCENE_IMAGE_TIMEOUT_MS 上限，到点自动清除。
// 3) **并发**：同一 chatType+chatId 只有一条进行中状态（重复 started 覆盖起始时间）；
//    每个窗口只显示自己当前所在会话的状态，多会话互不干扰。
// 4) **动效**：动画全部走 CSS class（.scene-image-bar 子树内的 animation），
//    不使用内联 transition —— 全局「动效开关」关闭时根元素挂 .anim-off，
//    其 `.anim-off *` 规则带 !important，可直接压制本组件全部动画，无需内联判定。
// 5) **可访问性**：文案用 --color-text（各主题下与面板底色对比度 ≥ 7:1，远超 WCAG AA 正文 4.5:1）；
//    主色 --color-primary 仅用于左侧色条与光点等**非文字**元素，不承载信息，避免浅色主题下
//    #07c160 这类中绿文字对比度不足（约 2.2:1）的问题。
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { SceneImageStatusEvent } from '../types';

// ===== 新增常量（值 / 位置 / 用途）=====
// 值：120_000ms（120 秒）/ 位置：本文件 SCENE_IMAGE_TIMEOUT_MS / 用途：
//   「正在生图中」状态的最长存活时间。生图 API 正常应在数十秒内返回；超过 120s 视为挂起，
//   主动清除状态条，避免界面永久卡在「正在生图中」。取 120s 是为了给慢速生图模型留足余量
//   （多数生图接口最慢约 60~90s），同时不会让用户等太久。
const SCENE_IMAGE_TIMEOUT_MS = 120_000;
// 值：2000ms / 位置：SUCCESS_TOAST_DURATION_MS / 用途：成功 Toast 停留时长。
//   比默认 1500ms 略长，让「图片已生成」这一结果有被看清的时间，又不至于打断输入。
const SUCCESS_TOAST_DURATION_MS = 2000;
// 值：3000ms / 位置：FAIL_TOAST_DURATION_MS / 用途：失败 Toast 停留时长。
//   失败文案含原因（生图失败：xxx），需要更长停留时间供用户读完，故取 3000ms。
const FAIL_TOAST_DURATION_MS = 3000;
// 值：1000ms / 位置：ELAPSED_TICK_MS / 用途：已进行秒数的刷新间隔（仅在进行中时存在定时器）。
const ELAPSED_TICK_MS = 1000;

export interface SceneImageState {
  /** 当前会话是否正在生图（决定状态条是否显示） */
  generating: boolean;
  /** 触发本次生图的角色名（用于状态条副文案，可为空） */
  roleName: string;
  /** 本次生图的起始时间戳（ms）；未进行中为 0 */
  startedAt: number;
}

/** Toast 调用签名（与 useToast().showToast 保持一致，此处只声明用到的部分） */
type ShowToast = (msg: string, opts?: { error?: boolean; duration?: number }) => void;

/**
 * 订阅异步场景生图三态，维护「当前会话是否正在生图」状态，并对成功 / 失败弹出站内 Toast。
 *
 * @param chatType 当前窗口正在看的会话类型（'single' | 'group'）
 * @param chatId   当前窗口正在看的会话 id
 * @param showToast 站内 Toast 触发函数（来自 useToast）
 * @param enabled  是否启用订阅（小窗未打开会话时传 false，避免无谓监听）
 */
export function useSceneImageStatus(
  chatType: string,
  chatId: string,
  showToast: ShowToast,
  enabled = true
): SceneImageState {
  const { t } = useI18n();
  const [generating, setGenerating] = useState<boolean>(false);
  const [roleName, setRoleName] = useState<string>('');
  const [startedAt, setStartedAt] = useState<number>(0);
  // showToast 每次渲染都是新函数（useToast 内未 memo），放进 ref 供事件回调稳定引用，
  // 这样订阅的 useEffect 只依赖 chatType/chatId，不会每次渲染解绑重绑。
  const toastRef = useRef<ShowToast>(showToast);
  toastRef.current = showToast;
  // 语言切换时 t 会变，用 ref 让事件回调始终读到最新语言而不必重新订阅。
  const tRef = useRef(t);
  tRef.current = t;

  // 订阅 / 退订：返回退订函数，组件卸载时由 React 自动调用，防止监听泄漏
  useEffect(() => {
    if (!enabled || !chatType || !chatId) return;
    const off = api.onSceneImageStatus((_e, data: SceneImageStatusEvent) => {
      // 只处理「当前窗口正在看的这个会话」，其余会话的事件忽略（多会话各自独立显示）
      if (!data || data.chatType !== chatType || data.chatId !== chatId) return;
      const translate = tRef.current;
      if (data.status === 'started') {
        // 重复 started 视为重新开始，覆盖起始时间（并发下同会话只保留一条）
        setGenerating(true);
        setRoleName(data.roleName || '');
        setStartedAt(data.ts || Date.now());
        return;
      }
      // success / failed：先清状态条，再按需提示
      setGenerating(false);
      setStartedAt(0);
      // 窗口不可见（最小化 / 隐藏到托盘 / 被遮挡）时不弹站内 Toast，
      // 交由主进程的后台提醒卡片处理，避免「看不见的 Toast」与卡片重复打扰。
      if (typeof document !== 'undefined' && document.hidden) return;
      if (data.status === 'success') {
        toastRef.current(translate('sceneImage.success'), { duration: SUCCESS_TOAST_DURATION_MS });
      } else {
        toastRef.current(translate('sceneImage.failed', { msg: data.error || '' }), {
          error: true,
          duration: FAIL_TOAST_DURATION_MS,
        });
      }
    });
    return off;
  }, [chatType, chatId, enabled]);

  // 超时兜底：进行中超过 SCENE_IMAGE_TIMEOUT_MS 自动清除（防止生图挂起导致状态条永久卡住）
  useEffect(() => {
    if (!generating) return;
    const timer = window.setTimeout(() => {
      setGenerating(false);
      setStartedAt(0);
    }, SCENE_IMAGE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [generating, startedAt]);

  return { generating, roleName, startedAt };
}

/** 已进行秒数（用于状态条「已进行 N 秒」副文案；不进行中时返回 0） */
function useElapsedSec(startedAt: number, active: boolean): number {
  const [sec, setSec] = useState<number>(0);
  useEffect(() => {
    if (!active || !startedAt) {
      setSec(0);
      return;
    }
    // 立即算一次，避免挂载后第一秒显示 0
    setSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = window.setInterval(() => {
      setSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt, active]);
  return sec;
}

export interface SceneImageStatusBarProps {
  /** 是否显示（一般传 useSceneImageStatus().generating） */
  active: boolean;
  /** 起始时间戳（ms），用于计算「已进行 N 秒」 */
  startedAt?: number;
  /** 触发本次生图的角色名（可空） */
  roleName?: string;
  /** 紧凑模式：小窗空间紧张，隐藏副文案、缩小内边距 */
  compact?: boolean;
}

/**
 * 异步生图「正在生图中…」内联状态条。
 * 纯展示组件，不订阅任何事件 —— 状态由 useSceneImageStatus 提供，便于两个窗口复用同一份逻辑。
 */
export const SceneImageStatusBar: React.FC<SceneImageStatusBarProps> = ({
  active,
  startedAt = 0,
  roleName = '',
  compact = false,
}) => {
  const { t } = useI18n();
  const elapsed = useElapsedSec(startedAt, active);

  if (!active) return null;

  return (
    <div
      className={`scene-image-bar${compact ? ' compact' : ''}`}
      role="status"
      aria-live="polite"
      // title 里带上角色名，便于悬浮时看清是谁在生图（小窗紧凑模式省略副文案，此处仍保留）
      title={roleName || undefined}
      aria-label={t('sceneImage.generating')}
    >
      <span className="scene-image-dot" aria-hidden="true" />
      <span className="scene-image-text">{t('sceneImage.generating')}</span>
      {/* 紧凑模式（小窗）省略副文案，只留主文案，避免多行挤压消息区 */}
      {!compact && elapsed > 0 && (
        <span className="scene-image-sub">{t('sceneImage.elapsed', { sec: elapsed })}</span>
      )}
    </div>
  );
};
