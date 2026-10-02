import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { playNodeBannerSound } from '../utils/sound';

export interface NodeBannerData {
  title: string; // 横幅主文案（剧情节点名称）
  subtitle?: string; // 副文案（如「跳转到剧情节点」「已从该节点开始新剧情」）
}

/**
 * 剧情节点横幅（v2.3.37）：屏幕上方居中弹出，
 * 时间线 = 1s 弹入 → 停留 3.5s → 0.6s 渐隐 → 卸载（onDone 回调清 state）。
 * 弹出瞬间播放 achievement-unlock 音效（跟随音效总开关/音量）。
 */
export const NodeBanner: React.FC<{ banner: NodeBannerData | null; onDone: () => void }> = ({
  banner,
  onDone,
}) => {
  const [visible, setVisible] = useState(false); // 已渲染实例（用于渐隐离场动画）
  const [phase, setPhase] = useState<'hidden' | 'in' | 'hold' | 'out'>('hidden');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!banner) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setVisible(true);
    setPhase('in');
    playNodeBannerSound();
    // 1s 弹入完成 → 进入停留期
    timers.current.push(setTimeout(() => setPhase('hold'), 1000));
    // 1s 弹入 + 3.5s 停留 → 渐隐
    timers.current.push(setTimeout(() => setPhase('out'), 4500));
    // 渐隐 0.6s 后彻底卸载
    timers.current.push(
      setTimeout(() => {
        setVisible(false);
        setPhase('hidden');
        onDone();
      }, 5100)
    );
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banner?.title, banner?.subtitle, banner]);

  if (!banner || !visible) return null;
  return createPortal(
    <div className={`node-banner phase-${phase}`} role="status">
      <div className="node-banner-card">
        <div className="node-banner-sub">{banner.subtitle || '\u00A0'}</div>
        <div className="node-banner-title">{banner.title}</div>
      </div>
    </div>,
    document.body
  );
};
