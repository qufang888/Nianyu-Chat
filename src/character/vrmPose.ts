// VRM 自然姿态引擎（v3.0.8，纯函数模块）。
//
// 背景（根因）：three-vrm 3.x 的 getNormalizedBoneNode() 返回的是**新建的归一化骨骼对象**，
// 其 quaternion 恒为单位四元数，因此所谓 "rest" 其实是 VRM 规范 T-pose 基准系
// （面朝 +Z、上臂沿 ±X 水平）。旧实现只在 rest 上叠加 ±0.16rad 的正弦摆动，
// 手臂永远在水平线附近 ⇒ 用户看到「手平放」。
//
// 本模块把姿态拆成三层，职责单一：
//   restPose  —— 加载时冻结的归一化基准（只读，绝不污染）
//   basePose  —— 一次性探测出的自然站姿静态偏置（上臂下垂 + 前屈 + 肘微屈）
//   delta     —— 每帧重算的正弦/凝视增量（幅度倍率只作用在这一层）
//
// 合规：不引入任何新依赖；three 对象只通过调用方传入的 Object3D 实例方法操作，
// 本文件不 import three 运行时（类型 import 会被 TS 擦除），便于行为级验证直接转译执行。
import type { Object3D } from 'three';

/** 骨骼基准快照（rotation 弧度 + scale 倍率）。 */
export interface PoseSnapshot {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

/** 单侧手臂的绑定姿态探测结果。 */
export interface ArmRestProbe {
  /** 臂干与竖直向下方向的夹角（度）：T-pose≈90°，A-pose≈20~45° */
  armAngleDeg: number;
  /** 臂干在规范化局部系的 X 符号：左/右与 VRM0/VRM1 自动适配 */
  sideSign: number;
  /** 是否成功探测（缺骨骼 / 异常 → false，走保守默认） */
  detected: boolean;
  /** 需要施加的 Z 旋转（度），已按目标角钳制 */
  correctionDeg: number;
}

/** 姿态骨架运行时（加载后 rest/base 只读，baseBlend 与 gaze 每帧推进）。 */
export interface VRMPoseRig {
  bones: Record<string, Object3D | null>;
  restPose: Record<string, PoseSnapshot>;
  basePose: Record<string, Partial<PoseSnapshot>>;
  /** 0→1，自然站姿淡入用（VRM_BASE_BLEND_SEC） */
  baseBlend: number;
  armProbes: { left: ArmRestProbe; right: ArmRestProbe };
  /** 平滑后的头部凝视分量（弧度），由 applyGazeHead 写入 */
  gaze: { yaw: number; pitch: number };
}

/** 自然站姿目标：臂干离竖直 15°（T-pose 需修正 −75°；选 15° 避免手臂插进身体）。 */
export const VRM_BASE_ARM_SLOPE_DEG = 15;
/** 探测角 <25° 视为已经自然（坐姿 / A-pose 导出模型），不修正。 */
export const VRM_ARM_NATURAL_THRESHOLD_DEG = 25;
/** 单次 Z 修正上限 80°，挡住极端绑定数据。 */
export const VRM_BASE_ARM_MAX_CORRECT_DEG = 80;
/** 上臂前屈 / 肘微屈（frontSign 自动适配 VRM0/VRM1 的 faceFront）。 */
export const VRM_BASE_ARM_FORWARD_DEG = 10;
export const VRM_BASE_ELBOW_BEND_DEG = 12;
/** 缺前臂骨骼时，上臂前屈退到保守的 6°。 */
export const VRM_BASE_ARM_FORWARD_FALLBACK_DEG = 6;
/** 探测失败时的保守修正（近似 T-pose）。 */
export const VRM_BASE_ARM_FALLBACK_DEG = -70;
/** 眼球最大左右/上下角（与 eye 的 ±1 饱和值对应；再大眼球会翻白）。 */
export const VRM_GAZE_MAX_YAW_DEG = 30;
export const VRM_GAZE_MAX_PITCH_DEG = 22;
/** 头部跟随比例（眼球全量、头 35% 才自然）与平滑时常数（30Hz 光标靠 τ 抹平）。 */
export const VRM_GAZE_HEAD_RATIO = 0.35;
export const VRM_GAZE_SMOOTH_TAU = 0.08;
/** 视线目标距头部的世界单位（模型高 2 单位，5 单位足够远避免视差抖动）。 */
export const VRM_GAZE_DISTANCE = 5;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const ZERO_BASE: Partial<PoseSnapshot> = Object.freeze({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

/** 钳到 0~1（幅度 / baseBlend 共用）。 */
export function clamp01(v: number | undefined | null): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 抓取骨骼并冻结 rest 快照。
 *
 * v3.0.8 起额外抓取 leftLowerArm / rightLowerArm（旧实现完全没抓前臂，微屈无从谈起）。
 * 调用方可传入已抓好的 bones/restPose —— ThreeModelView 为保留 K17 字面量断言，
 * 在组件内完成抓取与快照后再把两个 map 传进来（行为完全等价）。
 */
export function capturePoseRig(
  humanoid: any,
  bones?: Record<string, Object3D | null>,
  rest?: Record<string, PoseSnapshot>
): VRMPoseRig {
  const get = (name: string): Object3D | null => humanoid?.getNormalizedBoneNode?.(name) || null;
  const usedBones: Record<string, Object3D | null> = bones || {
    chest: get('chest'),
    upperChest: get('upperChest'),
    spine: get('spine'),
    head: get('head'),
    hips: get('hips'),
    leftUpperArm: get('leftUpperArm'),
    rightUpperArm: get('rightUpperArm'),
    leftLowerArm: get('leftLowerArm'),
    rightLowerArm: get('rightLowerArm'),
  };
  const usedRest: Record<string, PoseSnapshot> = rest || {};
  if (!rest) {
    for (const [key, bone] of Object.entries(usedBones)) {
      if (!bone) continue;
      usedRest[key] = {
        x: bone.rotation.x, y: bone.rotation.y, z: bone.rotation.z,
        sx: bone.scale.x, sy: bone.scale.y, sz: bone.scale.z,
      };
    }
  }
  const unknown: ArmRestProbe = { armAngleDeg: 90, sideSign: 1, detected: false, correctionDeg: VRM_BASE_ARM_FALLBACK_DEG };
  return {
    bones: usedBones,
    restPose: usedRest,
    basePose: {},
    baseBlend: 0,
    armProbes: { left: { ...unknown }, right: { ...unknown, sideSign: -1 } },
    gaze: { yaw: 0, pitch: 0 },
  };
}

/** 单侧探测：世界坐标量臂角 → 逆根旋转还原到规范化局部系 → 换算 Z 修正与前后屈。 */
function probeArm(vrm: any, side: 'left' | 'right', rig: VRMPoseRig): ArmRestProbe {
  const keyU = `${side}UpperArm`;
  const keyL = `${side}LowerArm`;
  const fallbackSign = side === 'left' ? 1 : -1;
  const upper = rig.bones[keyU] || null;
  const lower = rig.bones[keyL] || null;
  const frontSign = Math.sign(vrm?.lookAt?.faceFront?.z ?? 1) || 1;
  const setBase = (angleDeg: number, sign: number, correctionDeg: number, detected: boolean) => {
    const probe: ArmRestProbe = { armAngleDeg: angleDeg, sideSign: sign, correctionDeg, detected };
    rig.armProbes[side] = probe;
    // θ = sideSign · (target − detected)，clamp 已在 correctionDeg 完成 ⇒ 左臂为 −75°、右臂为 +75°。
    rig.basePose[keyU] = {
      x: -frontSign * (lower ? VRM_BASE_ARM_FORWARD_DEG : VRM_BASE_ARM_FORWARD_FALLBACK_DEG) * DEG2RAD,
      z: sign * correctionDeg * DEG2RAD,
    };
    if (lower) {
      // Rx(θ) 作用于竖直向下 (0,−1,0) 得 (0,−cosθ,−sinθ)；VRM1 局部 +Z 在前 ⇒ θ<0 才前屈。
      rig.basePose[keyL] = { x: -frontSign * VRM_BASE_ELBOW_BEND_DEG * DEG2RAD };
    }
    return probe;
  };

  if (!upper) return setBase(90, fallbackSign, VRM_BASE_ARM_FALLBACK_DEG, false);
  if (!lower) return setBase(90, fallbackSign, VRM_BASE_ARM_FALLBACK_DEG, false);

  try {
    // 复用骨骼自身属性作为向量/四元数容器，避免运行时 import three 与每帧分配。
    const v1 = upper.position.clone();
    const v2 = lower.position.clone();
    upper.updateWorldMatrix(true, true);
    lower.updateWorldMatrix(true, false);
    upper.getWorldPosition(v1);
    lower.getWorldPosition(v2);
    const dirWorld = v2.sub(v1);
    if (dirWorld.lengthSq() < 1e-8) return setBase(90, fallbackSign, VRM_BASE_ARM_FALLBACK_DEG, false);

    const root: Object3D | null = vrm?.scene || upper.parent || null;
    if (root) {
      root.updateWorldMatrix(true, false);
      const invRootQ = root.quaternion.clone();
      root.getWorldQuaternion(invRootQ);
      invRootQ.invert();
      dirWorld.applyQuaternion(invRootQ);
    }
    dirWorld.normalize();

    const armAngleDeg = Math.atan2(Math.abs(dirWorld.x), -dirWorld.y) * RAD2DEG;
    const sideSign = Math.sign(dirWorld.x) || fallbackSign;
    const correctionDeg = armAngleDeg < VRM_ARM_NATURAL_THRESHOLD_DEG
      ? 0
      : Math.max(-VRM_BASE_ARM_MAX_CORRECT_DEG, Math.min(0, VRM_BASE_ARM_SLOPE_DEG - armAngleDeg));
    return setBase(armAngleDeg, sideSign, correctionDeg, true);
  } catch {
    return setBase(90, fallbackSign, VRM_BASE_ARM_FALLBACK_DEG, false);
  }
}

/**
 * 运行时探测模型真实臂角并写入 rig.basePose（只算一次）。
 * 兼容 T-pose（≈90° ⇒ 修 −75°）、A-pose（20~45° ⇒ 视阈值修或不修）与 VRM0 局部轴翻转。
 */
export function detectNaturalBase(vrm: any, rig: VRMPoseRig): void {
  probeArm(vrm, 'left', rig);
  probeArm(vrm, 'right', rig);
}

/**
 * 统一写入口：三层合成，绝不修改 restPose / basePose。
 * rotation = rest + base*blend + delta；scale = rest.scale × scaleMul。
 */
export function writeBone(
  rig: VRMPoseRig,
  key: string,
  dx = 0,
  dy = 0,
  dz = 0,
  scaleMul = 1
): void {
  const bone = rig.bones[key];
  const r = rig.restPose[key];
  if (!bone || !r) return;
  const partial = rig.basePose[key] || ZERO_BASE;
  const b: PoseSnapshot = {
    x: partial.x ?? 0, y: partial.y ?? 0, z: partial.z ?? 0,
    sx: partial.sx ?? 1, sy: partial.sy ?? 1, sz: partial.sz ?? 1,
  };
  const blend = clamp01(rig.baseBlend);
  bone.rotation.x = r.x + b.x * blend + dx;
  bone.rotation.y = r.y + b.y * blend + dy;
  bone.rotation.z = r.z + b.z * blend + dz;
  const s = Number.isFinite(scaleMul) ? scaleMul : 1;
  bone.scale.set(r.sx * s, r.sy * s, r.sz * s);
}

/**
 * eye(-1..1) → yaw/pitch（弧度），钳在 ±30° / ±22°。
 *
 * v3.0.9 修复「光标往上头却往下」：调用方传入的 eye.y 来自屏幕坐标（**向下为正**），
 * 而 gazeMarker 用的是 three.js 世界坐标（**向上为正**）
 *   marker.y = head.y + tan(pitchRad) * distance  ⇒  pitch>0 意味着 marker 在上方 = 抬头。
 * 所以这里必须把屏幕 Y 反转：光标往上(eye.y<0) ⇒ pitchRad>0 ⇒ 抬头。
 * 旧实现直接 `y * MAX` 导致光标往上时 marker 被放到头下方 ⇒ 眼睛/头都向下看（用户实测 bug）。
 *
 * yaw 不反转：屏幕 X 向右为正，世界 X 也向右为正，方向一致。
 */
export function mapEyeToAngles(eyeX: number, eyeY: number): { yawRad: number; pitchRad: number } {
  const x = Math.max(-1, Math.min(1, Number(eyeX) || 0));
  const y = Math.max(-1, Math.min(1, Number(eyeY) || 0));
  return {
    yawRad: x * VRM_GAZE_MAX_YAW_DEG * DEG2RAD,
    pitchRad: -y * VRM_GAZE_MAX_PITCH_DEG * DEG2RAD,
  };
}

/** 指数平滑：alpha = 1 - exp(-dt / tau)，与帧率无关。 */
export function smooth(prev: number, next: number, dt: number, tau: number): number {
  if (tau <= 0) return next;
  const alpha = 1 - Math.exp(-Math.max(0, dt) / tau);
  return prev + (next - prev) * alpha;
}

/**
 * 头部凝视分量平滑（不覆盖 idle 的 head sine，ThreeModelView 会把它加在 writeBone 的 dx/dy 上）。
 * ratio 已含「开关 + gestureHold + 头部 35%」语义；幅度=0 时仍传 ratio，故眼神不受幅度影响。
 *
 * ⚠️ v3.0.9 pitch 符号：入参 pitchRad 是「抬头为正」的 gaze 目标角（marker 用 tan(pitchRad) 放在头上方，
 * 已由 mapEyeToAngles 修好）。但 head bone 的 `rotation.x` 是「正值=低头」（VRM0/VRM1 一致，见 QA 实测），
 * 因此写入 rig.gaze.pitch（作为 rotation.x 增量）时**必须取反**：抬头 ⇒ rotation.x 为负。
 * 不取反会导致「光标往上、眼球看上但头往下」的分裂观感（用户 v3.0.8 实测 bug）。
 * yaw 无需取反：rotation.y 正值与屏幕右向一致。
 */
export function applyGazeHead(
  rig: VRMPoseRig,
  yawRad: number,
  pitchRad: number,
  ratio: number,
  dt: number
): void {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  rig.gaze.yaw = smooth(rig.gaze.yaw, yawRad * r, dt, VRM_GAZE_SMOOTH_TAU);
  rig.gaze.pitch = smooth(rig.gaze.pitch, -pitchRad * r, dt, VRM_GAZE_SMOOTH_TAU);
}
