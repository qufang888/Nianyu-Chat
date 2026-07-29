import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';

interface ImageCropperProps {
  src: string;
  onClose: () => void;
  onCrop: (dataUrl: string) => void;
  title?: string;
  hint?: string;
  outputSize?: number;
  previewShape?: 'circle' | 'square';
}

export const ImageCropper: React.FC<ImageCropperProps> = ({
  src, onClose, onCrop, title, hint, outputSize = 256, previewShape = 'circle',
}) => {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ x: 0, y: 0, s: 160 });
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const onImgLoad = () => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    const w = img.clientWidth;
    const h = img.clientHeight;
    setSize({ w, h });
    const s = Math.min(w, h, Math.max(outputSize, 160));
    setBox({ x: (w - s) / 2, y: (h - s) / 2, s });
  };

  // 鼠标滚轮：放大或缩小裁剪框
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setBox((b) => {
      const delta = e.deltaY > 0 ? -20 : 20;
      const s = Math.max(40, Math.min(Math.min(size.w, size.h), b.s + delta));
      // 保持裁剪框中心不变
      const cx = b.x + b.s / 2;
      const cy = b.y + b.s / 2;
      const nx = Math.max(0, Math.min(size.w - s, cx - s / 2));
      const ny = Math.max(0, Math.min(size.h - s, cy - s / 2));
      return { x: nx, y: ny, s };
    });
  };

  // 拖拽裁剪框移动
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startBox = { ...box };
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setBox((b) => {
        const nx = Math.max(0, Math.min(size.w - b.s, startBox.x + dx));
        const ny = Math.max(0, Math.min(size.h - b.s, startBox.y + dy));
        return { ...b, x: nx, y: ny };
      });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 拖拽裁剪框右下角缩放
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startBox = { ...box };
    const onMove = (ev: MouseEvent) => {
      const delta = Math.max(ev.clientX - startX, ev.clientY - startY);
      setBox(() => {
        const s = Math.max(40, Math.min(Math.min(size.w, size.h), startBox.s + delta));
        const nx = Math.max(0, Math.min(size.w - s, startBox.x));
        const ny = Math.max(0, Math.min(size.h - s, startBox.y));
        return { x: nx, y: ny, s };
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const confirm = () => {
    const img = imgRef.current;
    if (!img || size.w === 0) return;
    const scaleX = img.naturalWidth / size.w;
    const scaleY = img.naturalHeight / size.h;
    const sx = box.x * scaleX;
    const sy = box.y * scaleY;
    const ss = Math.min(box.s * scaleX, box.s * scaleY);
    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, ss, ss, 0, 0, outputSize, outputSize);
    setPreview(canvas.toDataURL('image/png'));
  };

  return (
    <div className="modal-mask" style={{ zIndex: 200 }} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '94vw' }}>
        <div className="modal-head">
          <span>{title || t('role.cropAvatar')}</span>
          <span className="modal-close" onClick={onClose}>x</span>
        </div>
        <div className="modal-body">
          {hint && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>{hint}</div>}
          <div
            ref={wrapRef}
            onWheel={onWheel}
            style={{
              position: 'relative',
              display: 'inline-block',
              maxWidth: '100%',
              cursor: dragging ? 'grabbing' : 'grab',
              background: 'var(--color-input-bg, #eee)',
              overflow: 'hidden',
            }}
          >
            <img
              ref={imgRef}
              src={src}
              alt="crop"
              onLoad={onImgLoad}
              style={{ maxWidth: '100%', maxHeight: '50vh', display: 'block', userSelect: 'none' }}
              draggable={false}
            />
            {size.w > 0 && (
              <>
                {/* 四边半透明遮罩：只覆盖图片区域，不覆盖模态 */}
                <div style={{ position: 'absolute', left: 0, top: 0, width: size.w, height: box.y, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: 0, top: box.y + box.s, width: size.w, height: size.h - box.y - box.s, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: 0, top: box.y, width: box.x, height: box.s, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: box.x + box.s, top: box.y, width: size.w - box.x - box.s, height: box.s, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
                {/* 裁剪框 */}
                <div
                  onMouseDown={onMouseDown}
                  style={{
                    position: 'absolute',
                    left: box.x, top: box.y,
                    width: box.s, height: box.s,
                    border: '2px dashed var(--color-primary)',
                    background: 'rgba(255,255,255,0.12)',
                  }}
                >
                  {/* 右下角缩放手柄 */}
                  <div
                    onMouseDown={onResizeStart}
                    style={{
                      position: 'absolute', right: -5, bottom: -5, width: 14, height: 14,
                      cursor: 'nwse-resize', zIndex: 10,
                    }}
                  />
                </div>
              </>
            )}
          </div>
          {size.w > 0 && (
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4, textAlign: 'center' }}>
              {t('chat.cropWheelHint')}
            </div>
          )}
          <div className="row-actions">
            <button className="btn-primary" onClick={confirm}>{t('role.cropConfirm')}</button>
            <button className="btn-ghost" onClick={onClose}>{t('role.cropCancel')}</button>
          </div>
          {preview && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>{t('chat.preview')}</div>
              <img
                src={preview}
                alt="preview"
                style={{
                  width: previewShape === 'circle' ? 128 : 'auto',
                  height: previewShape === 'circle' ? 128 : 300,
                  maxWidth: '100%',
                  borderRadius: previewShape === 'circle' ? '50%' : 'var(--radius-sm)',
                  objectFit: 'cover',
                }}
              />
              <div className="row-actions" style={{ justifyContent: 'center' }}>
                <button className="btn-primary" onClick={() => onCrop(preview)}>{t('common.save')}</button>
                <button className="btn-ghost" onClick={() => setPreview(null)}>{t('common.cancel')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
