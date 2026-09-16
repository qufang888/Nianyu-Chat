// ===== 伪流式输出（v2.3.34）=====
// 目标：界面上「看上去像流式输出」，实际上并不是——模型全部输出完毕后，前端再按固定间隔
// （每字 PSEUDO_SPEED_DEFAULT 秒，可调 0.05~1 秒）逐字渐显正文。思维链（reasoning）不受影响。
//
// 组件协作：
//   1. 流式进行中：伪流式开启时气泡内不渲染正文（只显示「正在回复」动效与实时思维链），
//      营造「还没开始输出」的观感；
//   2. 流式完成 / 非流式回复落库：调用方对该消息调用 markPseudoPending(key) 打标；
//   3. 气泡渲染时命中标记 → usePseudoReveal 从头逐字放出，放完自动清除标记（避免切聊天回来重播）。
import { useEffect, useRef, useState } from 'react';
import { clampPseudoSpeed } from '../types';

// 待逐字放出的消息标记。key = `${chat_id}:${msg.id}`；模块级保存，跨组件重挂载保持进度语义
// （切换聊天导致气泡卸载再挂载时，标记若仍在则继续放完；放完即删，故不会二次重播）。
const pendingReveal = new Set<string>();
// 安全上限：极端情况下（消息一直未被打开查看）避免集合无限增长
const PENDING_MAX = 500;

export function markPseudoPending(key: string): void {
  if (!key) return;
  if (pendingReveal.size > PENDING_MAX) pendingReveal.clear();
  pendingReveal.add(key);
}

export function isPseudoPending(key: string): boolean {
  return !!key && pendingReveal.has(key);
}

export function clearPseudoPending(key: string): void {
  if (key) pendingReveal.delete(key);
}

export interface PseudoRevealState {
  text: string; // 当前应显示的正文片段
  revealing: boolean; // 是否仍在逐字放出（末字渐显动画据此启用）
}

/**
 * 伪流式逐字渐显 hook。
 * @param fullText 完整正文
 * @param active   是否启用（缓存队列 / 目标消息 / 非思考气泡等前置条件都满足时传 true）
 * @param speedSec 每字间隔（秒），运行时会被钳制到 0.05~1
 */
export function usePseudoReveal(fullText: string, active: boolean, speedSec: number): PseudoRevealState {
  const total = (fullText || '').length;
  const [n, setN] = useState(active ? 0 : total);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!active || total === 0) {
      setN(total);
      return;
    }
    setN(0);
    // 每字间隔（毫秒）：下限 20ms 兜底，避免极端值把浏览器计时器压爆
    const step = Math.max(20, Math.round(clampPseudoSpeed(speedSec) * 1000));
    timerRef.current = setInterval(() => {
      setN((prev) => {
        if (prev + 1 >= total) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return total;
        }
        return prev + 1;
      });
    }, step);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fullText, active, speedSec, total]);

  const shown = Math.min(n, total);
  return { text: (fullText || '').slice(0, shown), revealing: active && shown < total };
}
