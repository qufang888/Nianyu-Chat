/**
 * 全局窗口置顶层级（v3.0.1-beta.9）。
 *
 * ── Electron level 语义：macOS 与 Windows 不同 ───────────────────────
 * BrowserWindow#setAlwaysOnTop(flag, level) 的 `level` 语义**依平台而异**：
 * · macOS：level 决定同为置顶窗口之间的相对 Z 序，由低到高
 *     normal < floating < torn-off-menu < modal-panel < main-menu
 *            < status < pop-up-menu < screen-saver
 *   level 越高越靠上；level 相同时 Z 序由创建顺序 / 焦点决定。
 * · Windows（electron 32.x 源码实测）：`level` **完全不参与** z_order 计算。
 *   electron_api_base_window.cc 的 BaseWindow::SetAlwaysOnTop 中
 *   `ui::ZOrderLevel z_order = top ? kFloatingWindow : kNormal;`，所有 top=true
 *   的窗口同属一个 topmost band；native_window_views.cc 的 Windows 分支只用
 *   `level` 判定 `behind_task_bar_`（是否置于任务栏后）。
 *   故同 band 内 Z 序仍由创建顺序 / 焦点决定 —— 这正是 Bug 1 的根因，
 *   **只改 level 在 Windows 上无法修复**。
 *
 * ── 本项目的层级契约 ─────────────────────────────────────────────────
 *   悬浮球（球窗 / 面板窗 / 菜单窗）  >  桌面角色  >  小窗 / 普通窗口
 *   screen-saver                        pop-up-menu   floating / 不置顶
 *
 * 保留三个**不同** level：macOS 上由系统按 level 排序、语义清晰；同时把 5+ 处
 * 散落的字面量收归本文件，避免漂移。桌宠取 pop-up-menu：仅低于 screen-saver
 * 一档，仍高于 main-menu / status / floating。
 *
 * ⚠️ Windows 上**必须**由 electron/floatingBall.ts 的
 *    `reassertFloatingBallOnTop()` 对悬浮球三窗调用 `win.moveTop()` 显式提到
 *    同层 Z 序顶部，并覆盖「窗口创建 / 置顶开关 / 唤回」等关键路径 + 低频轮询
 *    兜住「用户点击桌宠导致焦点提升」这类动态情形。
 *    **不要把本文件的 level 当作跨平台的 Z 序保证。**
 *
 * 构造参数 `alwaysOnTop: boolean` 不支持 level，所以所有窗口都在创建后显式
 * 调用 setAlwaysOnTop(flag, level) 重申一次（统一走 applyAlwaysOnTop）。
 *
 * 本环境无法做真机 GUI 验证（无可见 Electron 桌面），Windows 实际 Z 序建议实机确认。
 */
import type { BrowserWindow } from 'electron';

/** Electron setAlwaysOnTop 支持的 level 字面量集合。 */
export type AlwaysOnTopLevel =
  | 'normal'
  | 'floating'
  | 'torn-off-menu'
  | 'modal-panel'
  | 'main-menu'
  | 'status'
  | 'pop-up-menu'
  | 'screen-saver';

/** 悬浮球三窗：level 契约中的最高层；Windows 上还需 moveTop() 兜底才真正居上。 */
export const FLOATING_BALL_LEVEL: AlwaysOnTopLevel = 'screen-saver';
/** 桌宠窗：level 契约中的中间层。 */
export const DESKTOP_CHARACTER_LEVEL: AlwaysOnTopLevel = 'pop-up-menu';
/** 小窗：常规浮动层（Windows 上会命中 behind_task_bar_ 列表，属既有行为）。 */
export const MINI_WINDOW_LEVEL: AlwaysOnTopLevel = 'floating';

/**
 * 统一应用置顶状态与层级。
 *
 * flag=false 时仍传入 level：Electron 会记住最近一次 setAlwaysOnTop 的 level，
 * 这样下次重新置顶时层级与首次一致，不会静默退回默认的 'floating'。
 * 注意：Windows 上本函数只决定「是否 topmost / 是否置于任务栏后」，**不决定**
 * 与桌宠窗的相对 Z 序 —— 那由 reassertFloatingBallOnTop() 负责。
 *
 * @param win 目标窗口；已销毁时静默跳过（窗口重建 / 唤回路径可能遇到空引用）
 * @param flag 是否置顶
 * @param level 该窗口类型对应的固定 level（见上方层级契约）
 */
export function applyAlwaysOnTop(
  win: BrowserWindow,
  flag: boolean,
  level: AlwaysOnTopLevel,
): void {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(!!flag, level);
}
