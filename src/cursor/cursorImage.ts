/**
 * 动态光标 —— 图片处理与几何换算（v2.3.126 重做）
 * ============================================================================
 * 本模块负责三件事：
 *   1) **热点比例 ↔ 屏幕偏移换算**：热点存的是「图像宽/高的比例（0~1）」，
 *      绘制时按「长边 = cursorSize、保持宽高比」的实际显示尺寸换算成屏幕偏移。
 *      —— 这是 v2.3.126 修掉「换图后热点彻底失准」旧缺陷的关键。
 *   2) **上传图片处理**：dataURL 解码 → 等比缩小到最长边 ≤ 128px → toDataURL('image/png')。
 *   3) **预览区几何**：把「预览框内的指针坐标」换算成「图像比例坐标」，
 *      必须考虑 object-fit: contain 的 letterbox（图片未铺满预览框时的留白）。
 *
 * ⚠️ 本模块**刻意不 import 任何图片资源**（内置 cursor.png 由调用方注入），
 *    这样它可以被 Node 直接转译求值（scripts/verify-cursor-engine.mjs），
 *    几何换算逻辑得以被**行为级**校验，而不是靠源码正则匹配。
 */

import {
  MAX_CURSOR_SIZE,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_IMAGE_EDGE,
  MIN_CURSOR_SIZE,
} from './types';

// ===== 类型 =====

/** 光标的实际显示尺寸（CSS 像素）：长边 = cursorSize，另一边按原图宽高比缩放 */
export interface CursorDrawSize {
  /** 显示宽度（像素） */
  Dw: number;
  /** 显示高度（像素） */
  Dh: number;
}

/** 热点在屏幕上的偏移量（像素） */
export interface HotspotOffset {
  /** 水平偏移（图像左上角 → 热点） */
  offX: number;
  /** 垂直偏移（图像左上角 → 热点） */
  offY: number;
}

/** 图片在预览框内「实际呈现」的矩形（考虑 object-fit: contain 的 letterbox） */
export interface ContainedRect {
  /** 呈现矩形左上角（相对预览框） */
  x: number;
  y: number;
  /** 呈现宽度 */
  w: number;
  /** 呈现高度 */
  h: number;
}

/** 上传处理结果 */
export type CursorImageProcessResult =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; reason: 'not-image' | 'too-large' | 'decode-failed' };

// ===== 基础工具 =====

/** 把任意数值夹到 [min, max]；非法值（NaN / Infinity）回落到 fallback */
export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** 把任意数值夹到 [0, 1]（热点比例语义） */
export function clampRatio(value: number, fallback = 0): number {
  return clampNumber(value, 0, 1, fallback);
}

// ===== 几何换算 =====

/**
 * 计算光标的实际显示尺寸。
 *
 * 规则：**长边 = cursorSize**（保持原图宽高比）。
 * 例：512×512 → 28×28；512×256 → 28×14；256×512 → 14×28。
 * 这样热点比例（相对图像自身尺寸）在任何显示尺寸下都保持同一语义。
 */
export function computeCursorDrawSize(
  naturalWidth: number,
  naturalHeight: number,
  cursorSize: number
): CursorDrawSize {
  const base = clampNumber(cursorSize, MIN_CURSOR_SIZE, MAX_CURSOR_SIZE, MIN_CURSOR_SIZE);
  const w = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : 0;
  const h = Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : 0;
  if (!w || !h) return { Dw: base, Dh: base };
  const ratio = w / h;
  if (ratio >= 1) return { Dw: base, Dh: base / ratio };
  return { Dw: base * ratio, Dh: base };
}

/**
 * 热点比例 → 屏幕偏移。
 *
 * offX = hotspotX × Dw，offY = hotspotY × Dh。
 * （热点是「图像自身尺寸的比例」，与图像原始分辨率、cursorSize 均无关。）
 */
export function hotspotToOffset(
  hotspotX: number,
  hotspotY: number,
  Dw: number,
  Dh: number
): HotspotOffset {
  return {
    offX: clampRatio(hotspotX, 0) * Dw,
    offY: clampRatio(hotspotY, 0) * Dh,
  };
}

/**
 * 反向换算：屏幕偏移 → 热点比例（供预览区把指针坐标换算回比例）。
 */
export function offsetToHotspot(offX: number, offY: number, Dw: number, Dh: number): { x: number; y: number } {
  return {
    x: Dw > 0 ? clampRatio(offX / Dw, 0) : 0,
    y: Dh > 0 ? clampRatio(offY / Dh, 0) : 0,
  };
}

/**
 * 计算图片在「正方形预览框」内的实际呈现矩形（object-fit: contain 的 letterbox）。
 *
 * 预览框尺寸为 boxW × boxH，图片按 contain 缩放后居中：
 *   scale = min(boxW / natW, boxH / natH)
 *   呈现矩形 = (natW×scale) × (natH×scale)，左上角居中偏移。
 */
export function computeContainedRect(
  naturalWidth: number,
  naturalHeight: number,
  boxW: number,
  boxH: number
): ContainedRect {
  const w = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : 0;
  const h = Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : 0;
  if (!w || !h || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / w, boxH / h);
  const cw = w * scale;
  const ch = h * scale;
  return { x: (boxW - cw) / 2, y: (boxH - ch) / 2, w: cw, h: ch };
}

/**
 * 预览框内的指针坐标 → 热点比例。
 *
 * 必须基于「图片实际呈现矩形」而非外框：正方形预览框里放非正方形图片时，
 * 上下（或左右）会有留白（letterbox），按外框换算会让红点与实际图像错位。
 */
export function pointerToHotspotRatio(
  pointerX: number,
  pointerY: number,
  rect: ContainedRect
): { x: number; y: number } {
  const x = rect.w > 0 ? clampRatio((pointerX - rect.x) / rect.w, 0) : 0;
  const y = rect.h > 0 ? clampRatio((pointerY - rect.y) / rect.h, 0) : 0;
  return { x, y };
}

// ===== 图片加载与上传处理 =====

/**
 * 加载一张图片（dataURL 或资源 URL）。
 * 失败时 reject，调用方负责回退内置光标。
 */
export function loadCursorImage(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    if (!src) {
      reject(new Error('empty image src'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve(img);
      else reject(new Error('image has no pixels'));
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/** 判定一个 File 是否是「看起来像图片」的类型 */
export function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  // 部分系统不给 MIME，靠扩展名兜底
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
}

/**
 * 处理用户上传的光标图片：
 *   1) 体积校验（> 4MB 直接拒绝）；
 *   2) FileReader 读 dataURL → Image 解码（解码失败直接拒绝）；
 *   3) 等比缩小到**最长边 ≤ 128px**；
 *   4) canvas.toDataURL('image/png') 保留透明通道。
 *
 * 缩小是为了控制 settings.json 体积（dataURL 会随 settings 广播到所有窗口）。
 */
export async function processCursorImageFile(file: File): Promise<CursorImageProcessResult> {
  if (!file) return { ok: false, reason: 'decode-failed' };
  if (file.size > MAX_UPLOAD_FILE_BYTES) return { ok: false, reason: 'too-large' };
  if (!isImageFile(file)) return { ok: false, reason: 'not-image' };

  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return { ok: false, reason: 'decode-failed' };

  let img: HTMLImageElement;
  try {
    img = await loadCursorImage(dataUrl);
  } catch {
    return { ok: false, reason: 'decode-failed' };
  }

  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  if (!natW || !natH) return { ok: false, reason: 'decode-failed' };

  // 等比缩小到最长边 ≤ MAX_UPLOAD_IMAGE_EDGE
  const scale = Math.min(1, MAX_UPLOAD_IMAGE_EDGE / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: 'decode-failed' };
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  // PNG 保留 alpha（透明背景光标必需）
  const out = canvas.toDataURL('image/png');
  return { ok: true, dataUrl: out, width: w, height: h };
}

/** FileReader → dataURL 的 Promise 封装 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    } catch {
      resolve('');
    }
  });
}
