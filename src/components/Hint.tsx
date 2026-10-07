import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 设置项说明提示（v2.3.34）
// 设计目标：设置界面不再大面积铺灰色小字说明，改为在「要说明的内容」旁边放一个「！」图标，
// 只有鼠标悬停（或键盘聚焦）在该图标上时才弹出说明。浮层用 Portal 挂到 body + fixed 定位，
// 避免被设置面板的滚动容器裁剪。
export const Hint: React.FC<{ text?: React.ReactNode; label?: string }> = ({ text, label }) => {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  if (text === undefined || text === null || text === '') return null;

  const show = () => {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 水平居中于图标，并夹在视口内，避免贴边溢出
    const left = Math.min(Math.max(r.left + r.width / 2, 150), Math.max(150, window.innerWidth - 150));
    // 图标位于屏幕下半部分时向上弹出，否则向下弹出
    if (r.top > window.innerHeight * 0.55) {
      setAnchor({ left, bottom: window.innerHeight - r.top + 8 });
    } else {
      setAnchor({ left, top: r.bottom + 8 });
    }
  };
  const hide = () => setAnchor(null);

  return (
    <>
      <span
        ref={iconRef}
        className="hint-icon"
        role="button"
        tabIndex={0}
        aria-label={label || '说明'}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // 图标常被放在 <label> 内部（说明紧跟开关）——必须拦掉点击的默认行为，
        // 否则点「!」会连带切换同一个 label 里的复选框/单选框；stopPropagation 不足以阻止
        // 浏览器的 label→control 原生激活。
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        !
      </span>
      {anchor &&
        createPortal(
          <span
            className="hint-tip"
            role="tooltip"
            style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}
          >
            {text}
          </span>,
          document.body
        )}
    </>
  );
};

export default Hint;
