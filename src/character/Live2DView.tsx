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

export const Live2DView: React.FC<Props> = ({ url, expression, mouth, blink, onError }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ expression, mouth, blink });
  stateRef.current = { expression, mouth, blink };
  const errRef = useRef(onError);
  errRef.current = onError;

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
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoStart: true,
      });
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
        try { app?.renderer?.resize(cw, ch); } catch { /* 忽略 */ }
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return <div className="dc-modell2d" ref={hostRef} />;
};

export default Live2DView;
