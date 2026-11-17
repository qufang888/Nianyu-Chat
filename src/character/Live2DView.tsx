// Live2D 角色渲染（V3）—— 支持 Cubism 4（.model3.json）与 Cubism 2（.model.json）。
//
// 重要合规说明：Cubism Core（live2dcubismcore.min.js）与 Cubism 2 runtime（live2d.min.js）
// 的版权归 Live2D 公司所有，**不随本软件分发**。用户需自行从 Live2D 官方取得并放入
// 「角色运行库」目录（设置里可一键打开该目录）。缺失时本组件会给出明确提示，而不是白屏。
//
// 渲染由 pixi.js + pixi-live2d-display 完成（两者均为 MIT 许可），模型资源只从本机读取。
import React, { useEffect, useRef } from 'react';
import { api } from '../ipc';
import type { CharacterExpression } from './PlaceholderCharacter';

interface Props {
  url: string;
  expression: CharacterExpression;
  mouth: number;
  blink: boolean;
  /**
   * 舞台缩放倍率（v3.0.3）。缺省 1 ⇒ 桌宠窗行为与改动前逐字等价。
   *
   * Live2D 是**运行时渲染**的：舞台里画布随盒子变大后，若渲染分辨率不变，
   * 放大结果就是「1× 渲染被拉伸」⇒ 模糊。故这里把渲染分辨率上限随 zoom 提升。
   */
  zoom?: number;
  /**
   * 纯渲染分辨率倍率（v3.0.6 引入，v3.0.12 桌面恒 1）：只抬后备缓冲，不改模型尺寸。
   * 桌宠窗传 1（1:1 布局盒 + 物理窗口放大，pr=dpr 即 1:1）；舞台不传（=1）。
   */
  resolutionScale?: number;
  onError?: (message: string) => void;
}

/** 表情名 → 依次尝试的 Live2D 表情文件/组名（不同模型命名不一，命中即用） */
const EXPRESSION_KEYS: Record<CharacterExpression, string[]> = {
  neutral: [],
  happy: ['happy', 'joy', 'smile', 'F01', 'exp_01'],
  angry: ['angry', 'anger', 'F03', 'exp_03'],
  shy: ['shy', 'blush', 'F02', 'exp_02'],
  surprised: ['surprised', 'surprise', 'F04', 'exp_04'],
  thinking: ['thinking', 'think', 'F05'],
  wave: ['happy', 'smile', 'F01'],
  nod: [],
  shake: [],
  yawn: ['yawn', 'sleep', 'F06'],
  greet: ['happy', 'smile', 'F01'],
  dragged: ['surprised', 'surprise', 'F04'],
};

/** 已加载过的运行时脚本（同一页面只加载一次） */
const loadedScripts = new Set<string>();

function loadScript(src: string): Promise<void> {
  if (loadedScripts.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => {
      loadedScripts.add(src);
      resolve();
    };
    el.onerror = () => reject(new Error(`runtime script failed: ${src}`));
    document.head.appendChild(el);
  });
}

const runtimeUrl = (file: string) => `nychar://model/__runtime__/${encodeURIComponent(file)}`;

export const Live2DView: React.FC<Props> = ({
  url,
  expression,
  mouth,
  blink,
  zoom = 1,
  resolutionScale = 1,
  onError,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ expression, mouth, blink });
  stateRef.current = { expression, mouth, blink };
  const errRef = useRef(onError);
  errRef.current = onError;
  // zoom 放进 ref：改缩放时**不重建** Live2D 场景，只更新渲染分辨率。
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // v3.0.6：纯分辨率倍率同样走 ref。
  const resolutionScaleRef = useRef(resolutionScale);
  resolutionScaleRef.current = resolutionScale;
  /** PIXI Application 引用：供 zoom 变化时调整渲染分辨率（不重建模型）。 */
  const appRef = useRef<any>(null);

  /**
   * Live2D 的渲染分辨率（等价于 three 的 pixelRatio）——v3.0.12 与 ThreeModelView 同步：
   * 桌宠画布已是 1:1 布局盒（190S×228S，窗口物理变大）⇒ resolutionScale 恒 1、pr=dpr 即清晰；
   * 舞台盒子已按 zoom 放大 ⇒ 同样只要 pr=dpr，不再把 zoom 乘进 pr（否则 5× 时 25 倍浪费）。
   * v3.0.11 及更早按 scale 抬 rs 会在每档滚轮时重建后备缓冲，是闪动首因，已移除。
   * 上限 12 仅作极端 dpr 兜底。
   */
  const targetResolution = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 不再对 rs 设 1.6 上限；桌面恒传 1 ⇒ pr=dpr 不再随 scale 变化。
    const rs = Math.max(1, resolutionScaleRef.current);
    return Math.max(1, Math.min(12, Math.round(dpr * rs * 100) / 100));
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let app: any = null;
    let model: any = null;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let exprTimer: ReturnType<typeof setInterval> | null = null;
    const fail = (m: string) => {
      if (!disposed) errRef.current?.(m);
    };

    void (async () => {
      const cubism4 = /model3\.json$/i.test(url);
      const status = await api.dcRuntimeStatus().catch(() => null);
      // 运行库缺失：不加载任何脚本，先给出人类可读的原因
      if (!status || (!cubism4 && !status.cubism2) || (cubism4 && !status.cubism4)) {
        fail(cubism4 ? 'missing-cubism4' : 'missing-cubism2');
        return;
      }
      if (disposed) return;

      // ① 运行时脚本必须先于 pixi-live2d-display 就位（它初始化时会读取全局对象）
      if (cubism4 && !(window as any).Live2DCubismCore) {
        const file = status.cubism4 ? 'live2dcubismcore.min.js' : 'live2dcubismcore.js';
        await loadScript(runtimeUrl(file));
      }
      if (!cubism4 && !(window as any).Live2D) {
        await loadScript(runtimeUrl('live2d.min.js'));
      }
      if (disposed) return;

      // ② 按 Cubism 版本加载对应模块（pixi-live2d-display 的两个入口互不兼容）
      const PIXI: any = await import('pixi.js');
      const mod: any = await import(cubism4 ? 'pixi-live2d-display/cubism4' : 'pixi-live2d-display/cubism2');
      if (disposed) return;

      const w = host.clientWidth || 320;
      const h = host.clientHeight || 380;
      app = new PIXI.Application({
        width: w,
        height: h,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        // v3.0.12：pr 恒为 dpr（桌宠 resolutionScale=1 / 舞台不传），不再随 scale 重分配缓冲
        resolution: targetResolution(),
        autoStart: true,
      });
      appRef.current = app;
      const canvas = app.view as HTMLCanvasElement;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      host.appendChild(canvas);

      model = await mod.Live2DModel.from(url, { autoInteract: false, autoUpdate: true });
      if (disposed) {
        try {
          model.destroy();
        } catch {
          /* 忽略 */
        }
        return;
      }
      app.stage.addChild(model);

      /** 等比铺满容器并底部对齐 */
      const fit = () => {
        if (!model) return;
        const cw = host.clientWidth || w;
        const ch = host.clientHeight || h;
        // 分辨率变化时先同步 renderer.resolution，再 resize，让后备缓冲按新分辨率重建
        const wantRes = targetResolution();
        try {
          if (app?.renderer && app.renderer.resolution !== wantRes) {
            app.renderer.resolution = wantRes;
          }
          app?.renderer?.resize(cw, ch);
        } catch { /* 忽略 */ }
        const mw = model.width || 1;
        const mh = model.height || 1;
        const k = Math.min(cw / mw, ch / mh) * 0.98;
        model.scale.set(k);
        model.x = (cw - mw * k) / 2;
        model.y = ch - mh * k;
      };
      fit();

      const ro2 = new ResizeObserver(fit);
      ro2.observe(host);
      ro = ro2;

      // ③ 参数驱动：口型 / 眨眼 / 轻微呼吸摆动（Cubism 2 与 4 的参数 API 不同，逐个 try）
      const setParam = (id4: string, id2: string, v: number) => {
        const core = model?.internalModel?.coreModel;
        if (!core) return;
        try {
          if (typeof core.setParameterValueById === 'function') core.setParameterValueById(id4, v);
          else if (typeof core.setParamFloat === 'function') core.setParamFloat(id2, v);
        } catch {
          /* 忽略：模型可能没有该参数 */
        }
      };

      const start = performance.now();
      const tick = () => {
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        const st = stateRef.current;
        const t = (performance.now() - start) / 1000;
        setParam('ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', Math.min(1, st.mouth));
        const eye = st.blink ? 0 : 1;
        setParam('ParamEyeLOpen', 'PARAM_EYE_L_OPEN', eye);
        setParam('ParamEyeROpen', 'PARAM_EYE_R_OPEN', eye);
        // 呼吸：角度参数做低幅正弦，让静止时也有生命感（不依赖模型自带动作）
        setParam('ParamAngleZ', 'PARAM_ANGLE_Z', Math.sin(t * 0.9) * 2.5);
        setParam('ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z', Math.sin(t * 0.9 + 0.6) * 1.6);
        setParam('ParamBreath', 'PARAM_BREATH', (Math.sin(t * 1.6) + 1) / 2);
      };
      raf = requestAnimationFrame(tick);

      // ④ 表情：模型自带的 expression 定义里按名字模糊匹配，找不到就跳过（不报错）
      const defs: any[] = [];
      try {
        const em = model.internalModel?.motionManager?.expressionManager;
        if (em?.definitions) defs.push(...em.definitions);
      } catch {
        /* 忽略 */
      }
      const applyExpression = (name: string) => {
        const keys = EXPRESSION_KEYS[name as CharacterExpression] || [];
        if (!keys.length || !defs.length) return;
        const hit = defs.find((d: any) =>
          keys.some((k) => String(d.Name || d.name || '').toLowerCase().includes(k.toLowerCase()))
        );
        if (hit) {
          try {
            model.expression(String(hit.Name || hit.name));
          } catch {
            /* 忽略 */
          }
        }
      };
      applyExpression(stateRef.current.expression);
      let lastExpr = stateRef.current.expression;
      exprTimer = setInterval(() => {
        const cur = stateRef.current.expression;
        if (cur !== lastExpr) {
          lastExpr = cur;
          applyExpression(cur);
        }
      }, 220);
    })().catch((e) => fail(String(e?.message || e)));

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (exprTimer) clearInterval(exprTimer);
      try {
        ro?.disconnect();
      } catch {
        /* 忽略 */
      }
      try {
        model?.destroy?.();
      } catch {
        /* 忽略 */
      }
      try {
        app?.destroy?.(true, { children: true });
      } catch {
        /* 忽略 */
      }
      model = null;
      app = null;
      appRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  /**
   * v3.0.3/v3.0.6：舞台缩放或桌宠分辨率倍率变化时**不重建** Live2D 模型，只把渲染分辨率调上去，
   * 让放大后的模型是按更高分辨率渲染的（而不是拉伸 1× 的旧帧）。
   * 舞台不传 resolutionScale（=1），行为仍等价于 v3.0.3。
   */
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const want = targetResolution();
    try {
      if (app.renderer && app.renderer.resolution !== want) {
        app.renderer.resolution = want;
        app.renderer.resize(app.renderer.width / want, app.renderer.height / want);
      }
    } catch {
      /* 忽略：个别运行库可能不支持运行时改分辨率 */
    }
  }, [zoom, resolutionScale]);

  return <div className="dc-modell2d" ref={hostRef} />;
};

export default Live2DView;
