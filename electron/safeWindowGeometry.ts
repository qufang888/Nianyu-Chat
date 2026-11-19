/**
 * 原生窗口几何调用的数值护栏（v3.0.15+ IPC 坐标转换失败根治）。
 *
 * 背景：Electron 32 的 `BrowserWindow#setPosition(x, y)` 走 gin 原生绑定，
 * 任一参数不是有限 number 时会同步抛
 *   `Error processing argument at index 1, conversion failure from `
 * （NaN / 非数字对象 / Infinity 的 ToDetailString 均为空串，故错误串末尾为空）。
 * 该异常冒泡到 electron/main.ts 的 `uncaughtException` → 原生错误框 + app.quit()。
 *
 * 与 IPC 结构化克隆无关：`webContents.send` 传不可克隆值只会打印
 * `Failed to serialize arguments` 日志并丢弃消息，不会抛这个错（Electron 32 实测）。
 * 真正的风险是「渲染层上报的屏幕坐标 / 窗口几何计算结果」未经校验进入原生 API。
 *
 * 这里只做一件事：把「非有限数」挡在原生调用之外，且**跳过本次移动**而不是回退到 0,0
 * ——窗口突然跳到屏幕左上角比不动一帧更糟。
 */
import type { BrowserWindow } from 'electron';

/** 坐标是否为可用于原生窗口 API 的有限数。 */
export function isFiniteCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 安全调用 `BrowserWindow#setPosition`。
 *
 * @param win 目标窗口；为空或已销毁时静默跳过（退出竞态）
 * @param x 屏幕 X（DIP）；非有限数时整次调用跳过
 * @param y 屏幕 Y（DIP）；非有限数时整次调用跳过（gin 报错正是 index 1）
 */
export function safeSetPosition(
  win: BrowserWindow | null | undefined,
  x: number,
  y: number,
): void {
  if (!win || win.isDestroyed()) return;
  if (!isFiniteCoord(x) || !isFiniteCoord(y)) {
    console.warn('[nianyu] skip setPosition with non-finite coords:', String(x), String(y));
    return;
  }
  win.setPosition(x, y);
}
