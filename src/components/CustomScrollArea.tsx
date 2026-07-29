import React, { useRef, useState, useEffect, useCallback } from 'react';

/**
 * CustomScrollArea — JS 自定义滚动条
 *
 * 替换原生 overflow-y:auto 滚动条，避免拖拽时原生光标覆盖自定义光标。
 * 通过 mousedown/mousemove/mouseup 实现拖拽滚动，确保动态光标全程可用。
 *
 * 用法：<CustomScrollArea style={{ flex: 1 }}><YourContent /></CustomScrollArea>
 */
const CustomScrollArea: React.FC<{
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** 滚动条宽度（px，默认 8） */
  barWidth?: number;
  /** 拇指最小高度（px，默认 30） */
  thumbMinHeight?: number;
  /** 外部传入的 scroll ref（用于自动滚动到底部等） */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}> = ({ children, className, style, barWidth = 8, thumbMinHeight = 30, scrollRef }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbHeight, setThumbHeight] = useState(0);
  const [thumbTop, setThumbTop] = useState(0);
  const [showBar, setShowBar] = useState(false);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartScroll = useRef(0);

  const updateThumb = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const ch = c.clientHeight;
    const sh = c.scrollHeight;
    if (sh <= ch) {
      setThumbHeight(0);
      setShowBar(false);
      return;
    }
    const ratio = ch / sh;
    const th = Math.max(ch * ratio, thumbMinHeight);
    setThumbHeight(th);
    const maxTop = ch - th;
    const scrollRatio = c.scrollTop / (sh - ch);
    setThumbTop(scrollRatio * maxTop);
    setShowBar(true);
  }, [thumbMinHeight]);

  // 内容滚动或尺寸变化时更新拇指位置
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => updateThumb());
    ro.observe(c);
    c.addEventListener('scroll', updateThumb, { passive: true });
    updateThumb();
    return () => {
      ro.disconnect();
      c.removeEventListener('scroll', updateThumb);
    };
  }, [updateThumb]);

  // 拖拽逻辑
  const onThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const c = containerRef.current;
    if (!c) return;
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartScroll.current = c.scrollTop;
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
  }, []);

  const onDocMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const c = containerRef.current;
    if (!c) return;
    const dy = e.clientY - dragStartY.current;
    const ch = c.clientHeight;
    const sh = c.scrollHeight;
    const ratio = (sh - ch) / (ch - thumbHeight);
    c.scrollTop = dragStartScroll.current + dy * ratio;
  }, [thumbHeight]);

  const onDocMouseUp = useCallback(() => {
    dragging.current = false;
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
  }, [onDocMouseMove]);

  // 清理
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
    };
  }, [onDocMouseMove, onDocMouseUp]);

  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...style }} className={className}>
      <div
        ref={(el) => {
          (containerRef as any).current = el;
          if (scrollRef) (scrollRef as any).current = el;
        }}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'auto',
          scrollbarWidth: 'none',
        }}
        className="custom-scroll-content"
      >
        {/* 样式用于隐藏原生滚动条 */}
        <style>{`.custom-scroll-content::-webkit-scrollbar { display: none; }`}</style>
        <div ref={contentRef} className="scroll-content">{children}</div>
      </div>
      {showBar && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: barWidth,
            height: '100%',
            pointerEvents: 'none',
          }}
        >
          <div
            ref={thumbRef}
            style={{
              position: 'absolute',
              top: thumbTop,
              left: 0,
              width: '100%',
              height: thumbHeight,
              background: 'var(--color-border)',
              borderRadius: barWidth / 2,
              cursor: 'default',
              pointerEvents: 'auto',
              transition: dragging.current ? 'none' : 'opacity 0.15s ease',
              opacity: 0.6,
            }}
            onMouseDown={onThumbMouseDown}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { if (!dragging.current) e.currentTarget.style.opacity = '0.6'; }}
          />
        </div>
      )}
    </div>
  );
};

export default CustomScrollArea;
