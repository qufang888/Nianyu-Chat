/**
 * CursorSettings —— 动态光标设置区块（v2.3.126 重做）
 * ============================================================================
 * 覆盖用户诉求的 7 条验收点：
 *   · 总开关（可在设置里打开）+ 搜索可搜到（Settings.tsx 的 sec-cursor 锚点与搜索索引）；
 *   · 光标图片可上传替换 / 恢复默认；
 *   · 点击位置（热点）可在预览框里拖动红点调整，**拖动中实时生效、松手才落盘**；
 *   · 拖尾与粒子特效可分别开关；
 *   · 热点语义为**比例**（0~1），换图不失准。
 *
 * 样式约定：复用 Settings.tsx 既有的行布局（label + range + 数值列）与
 * `.btn-ghost` 按钮样式，不新造视觉体系；文字颜色一律走 CSS 变量以满足 WCAG AA。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useTheme } from '../theme/ThemeContext';
import { useI18n } from '../i18n/I18nContext';
import { DEFAULT_SETTINGS } from '../types';
import cursorPngUrl from '../assets/cursor/cursor.png';
import {
  computeContainedRect,
  pointerToHotspotRatio,
  processCursorImageFile,
} from '../cursor/cursorImage';
import {
  DEFAULT_CURSOR_SIZE,
  DEFAULT_HOTSPOT_X,
  DEFAULT_HOTSPOT_Y,
  HOTSPOT_PREVIEW_EVENT,
  MAX_CURSOR_SIZE,
  MIN_CURSOR_SIZE,
} from '../cursor/types';

/** 预览框边长（正方形） */
const PREVIEW_SIZE = 120;

/** 上传失败的原因 → i18n 键 */
type UploadError = 'not-image' | 'too-large' | 'decode-failed';

/** 读取图片的原始尺寸（用于 letterbox 精确换算） */
function useImageNaturalSize(src: string): { w: number; h: number } {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    let alive = true;
    if (!src) {
      setSize({ w: 0, h: 0 });
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (alive) setSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      if (alive) setSize({ w: 0, h: 0 });
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return size;
}

/** 热点预览框（正方形 + 可拖动红点） */
const HotspotPreview: React.FC<{
  imageSrc: string;
  natural: { w: number; h: number };
  hotspotX: number;
  hotspotY: number;
  onPreview: (x: number, y: number) => void;
  onCommit: (x: number, y: number) => void;
}> = ({ imageSrc, natural, hotspotX, hotspotY, onPreview, onCommit }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const latestRef = useRef({ x: hotspotX, y: hotspotY });
  const [boxSize, setBoxSize] = useState(PREVIEW_SIZE);

  // 预览框实际尺寸（应用可能有 UI 缩放，用实测值而非常量更准）
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setBoxSize(r.width);
    };
    measure();
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    } catch {
      ro = null;
    }
    return () => {
      if (ro) ro.disconnect();
    };
  }, []);

  // 图片实际呈现矩形（考虑 object-fit: contain 的 letterbox）
  const contained = useMemo(
    () => computeContainedRect(natural.w, natural.h, boxSize, boxSize),
    [natural.w, natural.h, boxSize]
  );

  const markerLeft = contained.x + hotspotX * contained.w;
  const markerTop = contained.y + hotspotY * contained.h;

  const applyPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = boxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const rect = computeContainedRect(natural.w, natural.h, r.width, r.height);
      const ratio = pointerToHotspotRatio(clientX - r.left, clientY - r.top, rect);
      latestRef.current = ratio;
      onPreview(ratio.x, ratio.y);
    },
    [natural.w, natural.h, onPreview]
  );

  return (
    <div
      ref={boxRef}
      data-cursor-preview
      style={{
        position: 'relative',
        width: PREVIEW_SIZE,
        height: PREVIEW_SIZE,
        borderRadius: 10,
        overflow: 'hidden',
        background: 'var(--color-input-bg)',
        border: '1px solid var(--color-border)',
        touchAction: 'none',
        userSelect: 'none',
        cursor: 'none',
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 某些环境不支持指针捕获，忽略 */
        }
        applyPointer(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        applyPointer(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* 忽略 */
        }
        // 松手才落盘
        onCommit(latestRef.current.x, latestRef.current.y);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      <img
        src={imageSrc}
        alt="cursor"
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          objectFit: 'contain',
          pointerEvents: 'none',
        }}
      />
      {/* 红色十字 + 圆点：标记鼠标实际点击位置 */}
      <div
        style={{
          position: 'absolute',
          left: markerLeft,
          top: markerTop,
          pointerEvents: 'none',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ position: 'absolute', width: 14, height: 1, background: 'var(--color-danger)' }} />
        <div style={{ position: 'absolute', width: 1, height: 14, background: 'var(--color-danger)' }} />
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'color-mix(in srgb, var(--color-danger) 18%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-danger) 60%, transparent)',
          }}
        />
      </div>
    </div>
  );
};

/** 一行「标签 + 滑块 + 数值」 */
const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  onCommit: () => void;
}> = ({ label, value, min, max, step, display, onChange, onCommit }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
      style={{ flex: 1 }}
    />
    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 44, textAlign: 'right' }}>
      {display}
    </span>
  </div>
);

/** 动态光标设置区块主体 */
const CursorSettings: React.FC = () => {
  const { settings, reloadSettings } = useTheme();
  const { t } = useI18n();

  const cursor = useMemo(
    () => ({ ...DEFAULT_SETTINGS.customCursor, ...(settings?.customCursor || {}) }),
    [settings?.customCursor]
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<UploadError | null>(null);
  /** 拖动过程中生效的热点（不落盘） */
  const [dragHotspot, setDragHotspot] = useState<{ x: number; y: number } | null>(null);

  const imageSrc = (cursor.image || '').trim() || cursorPngUrl;
  const natural = useImageNaturalSize(imageSrc);

  /** 当前展示的热点值：拖动中用拖动值，否则用已保存值 */
  const shownX = dragHotspot ? dragHotspot.x : (cursor.hotspotX ?? DEFAULT_HOTSPOT_X);
  const shownY = dragHotspot ? dragHotspot.y : (cursor.hotspotY ?? DEFAULT_HOTSPOT_Y);

  /** 落盘（并广播到其它窗口） */
  const save = useCallback(
    (patch: Partial<typeof cursor>) => {
      return api
        .saveSettings({ customCursor: { ...cursor, ...patch } })
        .then(() => reloadSettings())
        .catch((e) => console.error('[cursor-settings] 保存失败', e));
    },
    [cursor, reloadSettings]
  );

  /** 拖动中：只派发窗口内事件让光标引擎即时更新（不写盘） */
  const previewHotspot = useCallback((x: number, y: number) => {
    setDragHotspot({ x, y });
    window.dispatchEvent(
      new CustomEvent(HOTSPOT_PREVIEW_EVENT, { detail: { hotspotX: x, hotspotY: y } })
    );
  }, []);

  /** 松手：落盘并广播 */
  const commitHotspot = useCallback(
    (x: number, y: number) => {
      setDragHotspot(null);
      void save({ hotspotX: x, hotspotY: y });
    },
    [save]
  );

  /** 上传自定义光标图片 */
  const handleImageChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // 允许重复选同一文件
      if (!file) return;
      setUploadError(null);
      const result = await processCursorImageFile(file);
      if (!result.ok) {
        setUploadError(result.reason);
        return;
      }
      // 上传成功 → 热点重置到图像中心（可预期、可拖动微调），立刻生效
      await save({ image: result.dataUrl, hotspotX: 0.5, hotspotY: 0.5 });
    },
    [save]
  );

  const errorText = uploadError
    ? uploadError === 'too-large'
      ? t('settings.cursorImageTooLarge')
      : uploadError === 'not-image'
        ? t('settings.cursorImageInvalid')
        : t('settings.cursorImageDecodeFailed')
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
      {/* ===== 总开关 ===== */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={!!cursor.enabled}
          onChange={(e) => {
            void save({ enabled: e.target.checked });
          }}
        />
        <span style={{ fontSize: 13 }}>{t('settings.cursorEnabled')}</span>
      </label>

      {cursor.enabled && (
        <>
          {/* ===== 光标图片 ===== */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.cursorImage')}</span>
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={handleImageChange}
              />
              <button type="button" className="btn-ghost" onClick={() => fileInputRef.current?.click()}>
                {cursor.image ? t('settings.cursorImageChange') : t('settings.cursorImageUpload')}
              </button>
              {cursor.image && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setUploadError(null);
                    void save({ image: '', hotspotX: DEFAULT_HOTSPOT_X, hotspotY: DEFAULT_HOTSPOT_Y });
                  }}
                >
                  {t('settings.cursorImageReset')}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <img
                src={imageSrc}
                alt="custom cursor"
                style={{
                  width: 48,
                  height: 48,
                  objectFit: 'contain',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                }}
              />
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, minWidth: 180 }}>
                {t('settings.cursorImageDesc')}
              </div>
            </div>
            {errorText && (
              <div style={{ fontSize: 11, color: 'var(--color-danger)' }} role="alert">
                {errorText}
              </div>
            )}
          </div>

          {/* ===== 点击位置（热点）===== */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
            <div style={{ flexShrink: 0 }}>
              <HotspotPreview
                imageSrc={imageSrc}
                natural={natural}
                hotspotX={shownX}
                hotspotY={shownY}
                onPreview={previewHotspot}
                onCommit={commitHotspot}
              />
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-secondary)',
                  marginTop: 4,
                  textAlign: 'center',
                }}
              >
                {t('settings.hotspotPreview')}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.hotspot')}</div>
              <SliderRow
                label={t('settings.hotspotX')}
                value={shownX}
                min={0}
                max={1}
                step={0.005}
                display={`${(shownX * 100).toFixed(1)}%`}
                onChange={(v) => previewHotspot(v, shownY)}
                onCommit={() => commitHotspot(shownX, shownY)}
              />
              <SliderRow
                label={t('settings.hotspotY')}
                value={shownY}
                min={0}
                max={1}
                step={0.005}
                display={`${(shownY * 100).toFixed(1)}%`}
                onChange={(v) => previewHotspot(shownX, v)}
                onCommit={() => commitHotspot(shownX, shownY)}
              />
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('settings.hotspotDesc')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('settings.cursorHotspotHint')}
              </div>
            </div>
          </div>

          {/* ===== 光标大小 ===== */}
          <SliderRow
            label={t('settings.cursorSize')}
            value={cursor.cursorSize ?? DEFAULT_CURSOR_SIZE}
            min={MIN_CURSOR_SIZE}
            max={MAX_CURSOR_SIZE}
            step={1}
            display={`${cursor.cursorSize ?? DEFAULT_CURSOR_SIZE}px`}
            onChange={(v) => void save({ cursorSize: v })}
            onCommit={() => undefined}
          />
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {t('settings.cursorSizeDesc')}
          </div>

          {/* ===== 跟随手感（只影响拖尾，不影响字形精度）===== */}
          <SliderRow
            label={t('settings.cursorLerpSpeed')}
            value={cursor.lerpSpeed ?? 0.25}
            min={0.05}
            max={0.5}
            step={0.01}
            display={(cursor.lerpSpeed ?? 0.25).toFixed(2)}
            onChange={(v) => void save({ lerpSpeed: v })}
            onCommit={() => undefined}
          />
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {t('settings.cursorLerpSpeedDesc')}
          </div>

          {/* ===== 拖尾 / 粒子特效 ===== */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cursor.trailEnabled !== false}
              onChange={(e) => void save({ trailEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.cursorTrail')}</span>
          </label>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 24 }}>
            {t('settings.cursorTrailDesc')}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cursor.particlesEnabled !== false}
              onChange={(e) => void save({ particlesEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.cursorParticles')}</span>
          </label>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 24 }}>
            {t('settings.cursorParticlesDesc')}
          </div>

          {/* ===== 悬浮放大 / 空闲保留 ===== */}
          <SliderRow
            label={t('settings.cursorHoverScale')}
            value={Math.round((cursor.hoverScale ?? 1.25) * 100)}
            min={100}
            max={150}
            step={5}
            display={`${((cursor.hoverScale ?? 1.25) * 100).toFixed(0)}%`}
            onChange={(v) => void save({ hoverScale: v / 100 })}
            onCommit={() => undefined}
          />
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {t('settings.cursorHoverScaleDesc')}
          </div>
          <SliderRow
            label={t('settings.cursorIdleHide')}
            value={Math.max(1, Math.round((cursor.idleHideMs ?? 5000) / 1000))}
            min={1}
            max={300}
            step={1}
            display={`${Math.max(1, Math.round((cursor.idleHideMs ?? 5000) / 1000))}s`}
            onChange={(v) => void save({ idleHideMs: v * 1000 })}
            onCommit={() => undefined}
          />
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {t('settings.cursorIdleHideDesc')}
          </div>
        </>
      )}
    </div>
  );
};

export default CursorSettings;
