/**
 * 动态光标 —— 类型与常量（v2.3.126 重做）
 * ============================================================================
 * 本文件是「动态光标」系统的**唯一常量源**。引擎、设置 UI、校验脚本都从这里取，
 * 杜绝「引擎上限改了、UI 还按旧上限显示」这类漂移。
 *
 * 设计要点（对应用户需求「粒子拖动特效的动态光标」）：
 *   · 字形层与特效层彻底分离：字形是 DOM（transform 同步定位，零帧延迟），
 *     特效层是 Canvas（拖尾 + 粒子，走 rAF）。→ 「显示位置 == 点击位置」构造性成立。
 *   · 热点（点击位置）语义是**比例**（0~1，相对图像自身尺寸），
 *     与图像原始分辨率、光标显示大小均无关 → 换图不失准。
 *   · 统一粒子池（上限 64），分 ribbon（拖尾）/ spark（粒子）两类。
 */

/** 粒子种类：ribbon = 拖尾柔性圆点；spark = 细碎粒子（带速度继承） */
export type CursorParticleKind = 'ribbon' | 'spark';

/** 悬停态：normal 普通 / hover 悬停可交互控件 / grabbing 拖拽中 */
export type CursorHoverState = 'normal' | 'hover' | 'grabbing';

/** 淡入淡出状态：none 无过渡 / in 淡入 / out 淡出 */
export type CursorFadeState = 'none' | 'in' | 'out';

/** 单个粒子（拖尾点位与细碎粒子共用同一结构，便于统一池管理） */
export interface CursorParticle {
  /** 粒子种类 */
  kind: CursorParticleKind;
  /** 是否在用（对象池槽位复用标记） */
  active: boolean;
  /** 屏幕坐标（CSS 像素） */
  x: number;
  y: number;
  /** 每帧位移（spark 用；ribbon 恒为 0） */
  vx: number;
  vy: number;
  /** 基础半径（像素） */
  radius: number;
  /** 当前透明度 0~1 */
  alpha: number;
  /** 剩余生命（帧） */
  life: number;
  /** 总生命（帧） */
  maxLife: number;
  /** 生成序号（越大越新）——用于回收最旧的 ribbon */
  seq: number;
}

/**
 * 引擎配置（由 React 层从 settings 归一化后注入）。
 * 引擎本身不读 settings、不 import React → 保持框架无关、可单测。
 */
export interface CursorConfig {
  /** 总开关：false = 完全不接管光标 */
  enabled: boolean;
  /** 动画门控：isGroupEnabled(settings, 'cursor')。false → 拖尾/粒子停发、淡入淡出一步到位 */
  animEnabled: boolean;
  /** 动效速度倍率（getAnimSpeed）：语义是**时长倍率**（1.5 = 更慢） */
  animSpeed: number;
  /** 跟随手感系数（0.05~0.5）：**只作用于拖尾**，字形本体永不 lerp */
  lerpSpeed: number;
  /** 拖尾开关 */
  trailEnabled: boolean;
  /** 拖尾点位上限（≤ MAX_TRAIL_POINTS） */
  trailMaxLength: number;
  /** 粒子开关 */
  particlesEnabled: boolean;
  /** 粒子上限（≤ MAX_PARTICLES） */
  maxParticles: number;
  /** 悬停可交互控件时的放大倍率（1.0~1.5） */
  hoverScale: number;
  /** 空闲隐藏时长（毫秒）：超时隐藏字形并恢复系统原生光标 */
  idleHideMs: number;
  /** 光标显示尺寸（长边像素，16~64） */
  cursorSize: number;
  /** 热点水平比例（0~1，相对图像宽度） */
  hotspotX: number;
  /** 热点垂直比例（0~1，相对图像高度） */
  hotspotY: number;
  /** 自定义光标图片 dataURL（空字符串 = 用内置 cursor.png） */
  image: string;
}

// ===== 硬性上限与常量 =====

/** 统一粒子池上限（ribbon + spark 共用，总数不超过此值） */
export const MAX_PARTICLES = 64;
/** 拖尾（ribbon）点位上限 */
export const MAX_TRAIL_POINTS = 24;
/** FPS 低于此值触发自动降级 */
export const FPS_DEGRADE_THRESHOLD = 52;
/** 恢复 FPS 的判定阈值（略高于降级阈值，形成迟滞，避免反复横跳） */
export const FPS_RECOVER_THRESHOLD = 58;
/** 每多少帧统计一次 FPS */
export const FPS_CHECK_INTERVAL = 60;
/** 静止超过此毫秒数停止 rAF（保留静态字形，降 CPU） */
export const IDLE_STOP_MS = 300;
/** 拖尾静止后不再新增点位（毫秒） */
export const TRAIL_IDLE_MS = 200;
/** 右/下边缘带迟滞宽度（像素），防边界反复横跳导致双光标闪烁 */
export const EDGE_BAND_HYSTERESIS_PX = 4;
/** 脏区域扩展边距（像素） */
export const DIRTY_MARGIN = 44;
/** 元素交互检测节流间隔（毫秒） */
export const INTERACTION_CHECK_THROTTLE_MS = 80;

/** 上传图片的最长边上限（像素）——超过则等比缩小，避免 settings.json 膨胀 */
export const MAX_UPLOAD_IMAGE_EDGE = 128;
/** 上传文件体积上限（字节）——超过则拒绝并提示 */
export const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024;

/** 光标显示尺寸默认值（长边像素） */
export const DEFAULT_CURSOR_SIZE = 28;
export const MIN_CURSOR_SIZE = 16;
export const MAX_CURSOR_SIZE = 64;

/**
 * 内置 cursor.png 箭头尖端的热点比例。
 * cursor.png 是 512×512 调色板 PNG，顶行（y=0）alpha 梯度实测为
 * x=34→7、x=35→71、x=36→119…，轮廓可见起点（箭头尖端）在 x=35。
 * → 比例 = 35 / 512 = 0.06836（纵向尖端在顶行 → hotspotY = 0）。
 */
export const DEFAULT_HOTSPOT_X = 0.06836;
export const DEFAULT_HOTSPOT_Y = 0;

/**
 * 旧版热点的基准尺寸（像素）。
 * 旧实现把 hotspotX/Y 存成「28px 基准尺寸下的绝对像素」，只对内置 512×512 图成立；
 * v2.3.126 改为比例语义后，这个常量只用于**存量数据迁移**（像素 → 比例）。
 */
export const LEGACY_HOTSPOT_BASE_SIZE = 28;

/** 淡入时长基准（毫秒，1× 速度）；实际时长 = 基准 × 速度倍率 */
export const FADE_IN_MS = 200;
/** 淡出时长基准（毫秒，1× 速度） */
export const FADE_OUT_MS = 150;

/** 悬停放大倍率上下限 */
export const MIN_HOVER_SCALE = 1;
export const MAX_HOVER_SCALE = 1.5;
/** 空闲隐藏时长上下限（毫秒） */
export const MIN_IDLE_HIDE_MS = 500;
export const MAX_IDLE_HIDE_MS = 300000;

/** 离屏哨兵值（表示「本窗当前没有指针位置」） */
export const OFFSCREEN = -9000;

/** body 类：隐藏系统原生光标（与 styles/index.css 的 `.cursor-hidden` 规则对应） */
export const HIDDEN_CLASS = 'cursor-hidden';
/** body 类：单光标仲裁门控（主进程 covered 时由 App/MiniChat/floating-ball 添加） */
export const GATE_CLASS = 'cursor-gate-off';

/** 设置页拖动热点时派发的窗口内事件（用于「拖动中实时生效、松手才落盘」） */
export const HOTSPOT_PREVIEW_EVENT = 'ny-cursor-hotspot-preview';

/** 字形层 z-index（最高，绝不被弹窗/Toast 盖住） */
export const GLYPH_Z_INDEX = 2147483647;
/** 特效层 z-index（略低于字形层） */
export const FX_Z_INDEX = 2147483646;

/** spark 粒子的速度继承系数：粒子初速 = -光标速度 × 该系数 + 抖动 */
export const SPARK_VELOCITY_INHERIT = 0.15;
