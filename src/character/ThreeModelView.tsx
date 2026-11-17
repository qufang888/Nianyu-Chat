// 3D 角色渲染（V3）—— GLB / GLTF / VRM。
//
// 为什么用动态 import：three 与 three-vrm 体积不小，主界面只在「桌宠角色」里用到，
// 静态引入会让首屏 bundle 多出近 1MB。这里按需加载，加载失败也不影响其它功能。
//
// 合规：不内置任何第三方模型；用户导入的模型只在其本机渲染，不上传、不打包。
import React, { useEffect, useRef } from 'react';
import type { CharacterExpression } from './PlaceholderCharacter';

interface Props {
  url: string;
  kind: 'vrm' | 'glb';
  expression: CharacterExpression;
  /** 0~1 口型开合（由舞台的语音分析驱动；桌面窗恒为 0） */
  mouth: number;
  blink: boolean;
  /**
   * 舞台缩放倍率（v3.0.3）。缺省 1 ⇒ 桌宠窗行为与改动前逐字等价。
   *
   * 用途：舞台里 3D 模型的盒子会随 zoom 变大，若渲染分辨率不变，放大后就是「一张 1× 截图放大」。
   * 因此这里同时做两件事：
   *   ① 画布本身随盒子变大（CSS 100% + ResizeObserver 自动跟随）；
   *   ② 渲染像素比再乘一个 zoom，让后备缓冲的像素数随放大同步增长 ⇒ 真正的高分辨率。
   */
  zoom?: number;
  /**
   * 纯渲染分辨率倍率（v3.0.6）：**只抬高 WebGL 后备缓冲，不改变模型几何尺寸**。
   * 桌宠窗传 `max(1.5, scale)` —— 它的画布被 CSS `transform: scale(--dc-scale)` 放大，
   * 若缓冲仍按 1× 分配，放大后就是插值模糊；舞台不传（=1），沿用盒子放大方案即可。
   * 与 zoom 的区别：zoom 会同时缩放 modelGroup（模型真的变大），resolutionScale 只影响像素密度。
   */
  resolutionScale?: number;
  onError?: (message: string) => void;
}

/** 表情 → VRM 预设表情名（VRM0 的旧名一并尝试，取到哪个用哪个） */
const EXPRESSION_MAP: Record<CharacterExpression, string[]> = {
  neutral: [],
  happy: ['happy', 'joy', 'fun'],
  angry: ['angry', 'anger'],
  shy: ['relaxed', 'fun', 'shy'],
  surprised: ['surprised', 'surprise'],
  thinking: ['relaxed', 'think'],
  wave: ['happy', 'joy'],
  nod: [],
  shake: [],
  yawn: ['aa', 'jawOpen', 'yawn'],
  greet: ['happy', 'joy'],
  dragged: ['surprised', 'surprise'],
};

/**
 * 把期望的表情名映射到**模型里真实存在的名字**（v3.0.6）。
 *
 * 为什么必须做这一步：three-vrm v3 对 VRM0 模型会把 `presetName: unknown` 的自定义表情
 * 按原始大小写保留（实测早濑优香模型是 `Blink` / `Joy` / `Angry`，而不是规范 preset 的
 * `blink` / `happy`）。直接 `getExpression('blink')` 会返回 null ⇒ 自动眨眼永远不触发，
 * 这正是用户「导入后像贴图一样不动」的直接原因之一。
 *
 * 这里只做**大小写不敏感的名字匹配**（不猜语义），命中哪个用哪个；模型没定义就返回空数组，
 * 由调用方静默降级（呼吸/待机仍生效）。
 *
 * ⚠️ QA P0（v3.0.6）：three-vrm v3 的 `VRMExpression.name` **不是**表情名，
 * 而是 `VRMExpression_${expressionName}`（见 lib/three-vrm.module.js:76）；
 * 真实名字在 `.expressionName`。此前用裸对象 mock `{name:'Blink'}` 验证导致假阳性，
 * 用真实 manager 时 blink/happy/angry/口型全部解析为空 ⇒ 眨眼永不触发。
 * 这里优先读 `.expressionName`，`.name` 仅作兜底并剥掉 `VRMExpression_` 前缀。
 */
function resolveExpressionNames(mgr: any, candidates: string[]): string[] {
  if (!mgr || !Array.isArray(mgr.expressions)) return [];
  const available: string[] = mgr.expressions
    .map((e: any) => {
      const real = typeof e?.expressionName === 'string' ? e.expressionName : '';
      if (real) return real;
      const legacy = typeof e?.name === 'string' ? e.name : '';
      return legacy.startsWith('VRMExpression_') ? legacy.slice('VRMExpression_'.length) : legacy;
    })
    .filter(Boolean);
  const out: string[] = [];
  for (const c of candidates) {
    const hit = available.find((n) => n.toLowerCase() === c.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** 眨眼表情名解析：优先整体眨眼；VRM0 若只有左右眼分开的表情则两个一起驱动 */
function resolveBlinkNames(mgr: any): string[] {
  const whole = resolveExpressionNames(mgr, ['blink']);
  if (whole.length) return whole;
  const left = resolveExpressionNames(mgr, ['blink_l', 'eyeBlinkLeft', 'eye_blink_l']);
  const right = resolveExpressionNames(mgr, ['blink_r', 'eyeBlinkRight', 'eye_blink_r']);
  return [...left, ...right];
}

/** VRM 自驱动生命感参数（v3.0.6）——都是短周期、低幅度，不抢外部表情控制 */
/** 两次自动眨眼的间隔区间（毫秒）：2.2s ~ 5.2s，接近真人无意识眨眼频率 */
const VRM_BLINK_MIN_GAP_MS = 2200;
const VRM_BLINK_RANDOM_MS = 3000;
/** 一次眨眼的时长（毫秒）：闭合+张开共 130ms */
const VRM_BLINK_DURATION_MS = 130;
/** 呼吸周期（秒）：4.2s 一轮，与原创占位形象的 dcBreathe 同节奏 */
const VRM_BREATH_PERIOD_SEC = 4.2;
/** 呼吸时胸腔最大前倾角（弧度）：约 1.1°，轻微到不会显得夸张 */
const VRM_BREATH_ANGLE = 0.019;
/** 待机时头部左右微摆周期（秒）与幅度（弧度）：约 7.5s / 1.3° */
const VRM_IDLE_PERIOD_SEC = 7.5;
const VRM_IDLE_ANGLE = 0.023;
/** 桌宠窗最低超采样倍率：即使 scale=1 也按 1.5× 渲染，避免「舞台清晰桌面糊」 */
export const DESKTOP_RESOLUTION_SCALE_MIN = 1.5;
/** pixelRatio 硬上限：190×228 的画布 4× 也只有 760×912，成本可控 */
const MAX_PIXEL_RATIO = 4;

export const ThreeModelView: React.FC<Props> = ({
  url,
  kind,
  expression,
  mouth,
  blink,
  zoom = 1,
  resolutionScale = 1,
  onError,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 用 ref 把「当前状态」喂给动画循环，避免每次 props 变化重建 WebGL 场景
  const stateRef = useRef({ expression, mouth, blink });
  stateRef.current = { expression, mouth, blink };
  const errRef = useRef(onError);
  errRef.current = onError;
  // zoom 放进 ref：改缩放时**不重建** WebGL 场景，只更新渲染分辨率与模型缩放。
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // v3.0.6：纯分辨率倍率同样走 ref，避免改桌面缩放时重建 WebGL 场景。
  const resolutionScaleRef = useRef(resolutionScale);
  resolutionScaleRef.current = resolutionScale;
  /** 渲染器/模型组的跨渲染引用：供 zoom 变化时在不重建场景的前提下更新分辨率与缩放。 */
  const rendererRef = useRef<any>(null);
  const modelGroupRef = useRef<any>(null);
  const baseScaleRef = useRef(1);

  /**
   * 渲染分辨率随舞台缩放提升：后备缓冲的像素数 = CSS 尺寸 × pixelRatio。
   * 放大时若 pixelRatio 不变，3D 就是「1× 渲染结果被放大」⇒ 模糊。
   * 上限 MAX_PIXEL_RATIO=4（v3.0.6 由 3 上调：桌宠画布仅 190×228，4× 也只有 760×912，
   * 成本可控；见硬编码清单），避免高倍缩放把 GPU 压垮。
   */
  const applyPixelRatio = (r: any) => {
    if (!r) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 舞台：pixelRatio 只在放大时提升；缩小时保持 dpr 下限，避免 0.6 档把缓冲降到 1px 以下。
    const z = Math.max(0.6, zoomRef.current);
    // 桌宠：画布被 CSS scale(--dc-scale) 放大，缓冲必须同步放大才不糊。
    // 桌宠传入 max(1.5, scale)，所以 scale=1 也有 1.5× 超采样；舞台不传（=1），行为不变。
    const rs = Math.max(1, Math.min(1.6, resolutionScaleRef.current));
    const pr = Math.max(1, Math.min(MAX_PIXEL_RATIO, Math.round(dpr * z * rs * 100) / 100));
    if (typeof r.getPixelRatio === 'function' && r.getPixelRatio() === pr) return;
    r.setPixelRatio(pr);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;
    let renderer: any = null;
    let scene: any = null;
    let camera: any = null;
    let root: any = null;
    let mixer: any = null;
    let vrm: any = null;
    let ro: ResizeObserver | null = null;
    const exprCur: Record<string, number> = {};
    /** v3.0.6：VRM 生命感驱动用的骨骼引用（normalized bone，vrm.update 会同步到原始骨骼） */
    let breathBone: any = null;
    let idleBone: any = null;
    let breathRestX = 0;
    let idleRestY = 0;
    /** v3.0.6：模型里真实存在的表情名（VRM0 自定义名大小写不定，需运行时解析一次） */
    let blinkNames: string[] = [];
    let expressionNames: Record<string, string[]> = {};

    const fail = (msg: string) => {
      if (!disposed) errRef.current?.(msg);
    };

    const cleanup = () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      try {
        ro?.disconnect();
      } catch {
        /* 忽略 */
      }
      try {
        mixer?.stopAllAction?.();
      } catch {
        /* 忽略 */
      }
      try {
        root?.traverse?.((o: any) => {
          o.geometry?.dispose?.();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((mm: any) => mm?.dispose?.());
          else m?.dispose?.();
        });
      } catch {
        /* 忽略 */
      }
      try {
        renderer?.dispose?.();
        if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      } catch {
        /* 忽略 */
      }
      renderer = null;
      rendererRef.current = null;
      modelGroupRef.current = null;
      scene = null;
      camera = null;
      root = null;
      vrm = null;
      mixer = null;
      breathBone = null;
      idleBone = null;
      blinkNames = [];
      expressionNames = {};
    };

    /** 把模型归一化到相机前：包围盒居中，最高边缩放到 2 个单位高 */
    function mount(THREE: any, obj: any) {
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      obj.position.x -= center.x;
      obj.position.y -= center.y;
      obj.position.z -= center.z;
      const group = new THREE.Group();
      group.add(obj);
      const h = Math.max(size.y, 0.001);
      // 基准缩放记下来：舞台放大时按 zoom 乘上去（模型本身变大，而不是拉伸画面）。
      baseScaleRef.current = 2 / h;
      group.scale.setScalar(baseScaleRef.current * Math.max(0.6, zoomRef.current));
      modelGroupRef.current = group;
      scene.add(group);
    }

    function startLoop() {
      let last = performance.now();
      // v3.0.6：自驱动眨眼调度（与外部的 blink prop 取并集，互不覆盖）
      let nextBlinkAt = last + VRM_BLINK_MIN_GAP_MS + Math.random() * VRM_BLINK_RANDOM_MS;
      let blinkStartedAt = -1;
      const tick = (now: number) => {
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
        last = now;
        try {
          mixer?.update(dt);
          const st = stateRef.current;

          // ===== v3.0.6：VRM 自驱动生命感 =====
          // ③ 待机微动：头部缓慢左右摆（基于 rest 角度，绝不累加，避免长跑漂移）
          if (idleBone) {
            idleBone.rotation.y =
              idleRestY + Math.sin((now / 1000) * ((2 * Math.PI) / VRM_IDLE_PERIOD_SEC)) * VRM_IDLE_ANGLE;
          }
          // ② 呼吸：胸腔轻微前倾-回正。以 rest 姿态为基准做正弦位移，
          //    必须在 vrm.update(dt) 之前写，update 才会把 normalized bone 同步到原始骨骼。
          if (breathBone) {
            const breath = (Math.sin((now / 1000) * ((2 * Math.PI) / VRM_BREATH_PERIOD_SEC)) + 1) / 2;
            breathBone.rotation.x = breathRestX - breath * VRM_BREATH_ANGLE;
          }
          // ① 自动眨眼：随机间隔触发一次「闭合→张开」的正弦脉冲；
          //    仅在模型确实有 blink preset 时才驱动（否则 setValue 会被 catch 吞掉白费 CPU）。
          let autoBlink = 0;
          if (blinkNames.length) {
            if (now >= nextBlinkAt) {
              blinkStartedAt = now;
              nextBlinkAt = now + VRM_BLINK_MIN_GAP_MS + Math.random() * VRM_BLINK_RANDOM_MS;
            }
            if (blinkStartedAt >= 0) {
              const p = (now - blinkStartedAt) / VRM_BLINK_DURATION_MS;
              if (p >= 1) blinkStartedAt = -1;
              else autoBlink = Math.sin(Math.PI * p);
            }
          }

          // 表情 / 眨眼 / 口型：向目标值平滑逼近，避免弹跳
          const mgr = vrm?.expressionManager;
          if (mgr) {
            const targets: Record<string, number> = {};
            (expressionNames[st.expression] || []).forEach((n) => (targets[n] = 1));
            // 外部 blink 与自动眨眼取并集：主动眨一下不会压制自然的下一次眨眼
            const blinkValue = Math.max(st.blink ? 1 : 0, autoBlink);
            blinkNames.forEach((n) => (targets[n] = blinkValue));
            if (st.mouth > 0.02) {
              const mouthNames = resolveExpressionNames(mgr, ['aa', 'a', 'jawOpen']);
              mouthNames.forEach((n) => (targets[n] = Math.min(1, st.mouth)));
            }
            Object.keys(targets).forEach((n) => {
              const next = (exprCur[n] || 0) + (targets[n] - (exprCur[n] || 0)) * 0.28;
              exprCur[n] = next;
              try {
                mgr.setValue(n, next);
              } catch {
                /* 该模型没有这个表情，忽略 */
              }
            });
            Object.keys(exprCur).forEach((n) => {
              if (targets[n] !== undefined) return;
              const next = exprCur[n] * 0.75;
              exprCur[n] = next;
              try {
                mgr.setValue(n, next);
              } catch {
                /* 忽略 */
              }
            });
          }
          vrm?.update?.(dt);
          if (renderer && scene && camera) renderer.render(scene, camera);
        } catch {
          /* 单帧异常不中断循环 */
        }
      };
      raf = requestAnimationFrame(tick);
    }

    void (async () => {
      const THREE = await import('three');
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      if (disposed) return;

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      rendererRef.current = renderer;
      applyPixelRatio(renderer);
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      host.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
      camera.position.set(0, 0.12, 4.3);
      camera.lookAt(0, 0.02, 0);
      scene.add(new THREE.AmbientLight(0xffffff, 1.7));
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
      keyLight.position.set(1.2, 2, 2.6);
      scene.add(keyLight);
      const rimLight = new THREE.DirectionalLight(0x9fb6ff, 0.5);
      rimLight.position.set(-1.6, 1.2, -1.4);
      scene.add(rimLight);

      const resize = () => {
        if (!renderer || !camera) return;
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        // 画布尺寸随盒子变化（CSS 100%），像素比随 zoom 提升 ⇒ 后备缓冲像素数同步增长
        applyPixelRatio(renderer);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      ro = new ResizeObserver(resize);
      ro.observe(host);

      const loader = new GLTFLoader();
      if (kind === 'vrm') {
        try {
          const vrmMod: any = await import('@pixiv/three-vrm');
          if (disposed) return;
          loader.register((parser: any) => new vrmMod.VRMLoaderPlugin(parser));
          loader.load(
            url,
            (gltf: any) => {
              if (disposed) return;
              root = gltf.scene;
              vrm = gltf.userData.vrm;
              if (vrm) {
                // VRM0 的模型朝 -Z，转 180° 才面向镜头
                try {
                  if (vrm.meta?.metaVersion === '0') vrmMod.VRMUtils.rotateVRM0(vrm);
                } catch {
                  /* meta 缺失时忽略 */
                }
                try {
                  vrmMod.VRMUtils.removeUnnecessaryVertices?.(root);
                  vrmMod.VRMUtils.combineSkeletons?.(root);
                } catch {
                  /* 忽略 */
                }
                // v3.0.6：找到可用于生命感的 normalized 骨骼。
                // 用 normalized 而非 raw：three-vrm 会在 update() 里把 normalized 姿态同步到原始骨骼，
                // 且不同 VRM 的骨骼层级差异被规范化，同一套角度对所有模型语义一致。
                try {
                  const hm = vrm?.humanoid;
                  breathBone =
                    hm?.getNormalizedBoneNode?.('chest') ||
                    hm?.getNormalizedBoneNode?.('upperChest') ||
                    hm?.getNormalizedBoneNode?.('spine') ||
                    null;
                  idleBone = hm?.getNormalizedBoneNode?.('head') || null;
                  if (breathBone) breathRestX = breathBone.rotation.x;
                  if (idleBone) idleRestY = idleBone.rotation.y;
                } catch {
                  breathBone = null;
                  idleBone = null;
                }
                // v3.0.6：解析模型里真实存在的表情名（VRM0 自定义名如 Blink/Joy 与规范名不同）
                try {
                  const mgr = vrm?.expressionManager;
                  blinkNames = resolveBlinkNames(mgr);
                  expressionNames = {};
                  Object.keys(EXPRESSION_MAP).forEach((key) => {
                    expressionNames[key] = resolveExpressionNames(mgr, EXPRESSION_MAP[key as CharacterExpression]);
                  });
                } catch {
                  blinkNames = [];
                  expressionNames = {};
                }
              }
              mount(THREE, root);
              startLoop();
            },
            undefined,
            (err: any) => fail(String(err?.message || err || 'load failed'))
          );
        } catch (e: any) {
          fail(String(e?.message || e));
        }
        return;
      }

      loader.load(
        url,
        (gltf: any) => {
          if (disposed) return;
          root = gltf.scene || gltf.scenes?.[0];
          if (!root) {
            fail('empty scene');
            return;
          }
          mount(THREE, root);
          if (gltf.animations?.length) {
            // v3.0.6：市面 GLB 常带多段动画（idle / talk / walk…），旧实现只播 [0]，
            // 若第一段是 T-pose 或极短动作，用户就会觉得「导入后不会动」。
            // 这里按常见命名挑一个最适合桌宠待机的 clip：idle/loop/breath/stand 优先，
            // 其次取**时长最长**的一段（通常就是待机循环），避免选到瞬时动作。
            const clips: any[] = gltf.animations;
            // 用单词边界避免 "standard" 误命中 "stand"；兼容日文模型常见命名。
            const prefers = /(?:^|[_/\s-])(idle|loop|breath|stand|taiki|待機|アイドル)(?:[_/\s-]|$)/i;
            const named = clips.find((c: any) => prefers.test(c?.name || ''));
            const longest = clips.reduce((a: any, b: any) => ((b?.duration || 0) > (a?.duration || 0) ? b : a), clips[0]);
            const chosen = named || longest;
            mixer = new THREE.AnimationMixer(root);
            mixer.clipAction(chosen).play();
          }
          startLoop();
        },
        undefined,
        (err: any) => fail(String(err?.message || err || 'load failed'))
      );
    })().catch((e) => fail(String(e?.message || e)));

    return cleanup;
    // onError 每次渲染都是新函数，不放进依赖，避免重建 WebGL 场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);

  /**
   * v3.0.3/v3.0.6：舞台缩放或桌宠分辨率倍率变化时**不重建** WebGL 场景，只做两件事：
   *   ① 提升渲染分辨率（pixelRatio × zoom × resolutionScale）—— 否则放大后就是「1× 渲染结果被放大」；
   *   ② 按 zoom 缩放模型组 —— 放大的模型本身，而不是拉伸画面（resolutionScale 不参与，纯像素密度）。
   * 舞台不传 resolutionScale（=1），本 effect 对它仍等价于 v3.0.3 行为。
   */
  useEffect(() => {
    const r = rendererRef.current;
    const g = modelGroupRef.current;
    if (!r && !g) return;
    applyPixelRatio(r);
    if (g) g.scale.setScalar(baseScaleRef.current * Math.max(0.6, zoom));
  }, [zoom, resolutionScale]);

  return <div className="dc-model3d" ref={hostRef} />;
};

export default ThreeModelView;
