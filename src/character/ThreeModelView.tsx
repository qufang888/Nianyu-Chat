// 3D 角色渲染（V3）—— GLB / GLTF / VRM。
//
// 为什么用动态 import：three 与 three-vrm 体积不小，主界面只在「捉宠角色」里用到，
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
  onError?: (message: string) => void;
}

/** 表情 → VRM 预设表情名（VRM0 的旧名一并尝试，取到哪个用哪个） */
const EXPRESSION_MAP: Record<CharacterExpression, string[]> = {
  neutral: [],
  happy: ['happy', 'joy'],
  angry: ['angry'],
  shy: ['relaxed', 'fun'],
  surprised: ['surprised'],
  thinking: ['relaxed'],
  wave: ['happy', 'joy'],
  nod: [],
  shake: [],
  yawn: ['aa'],
  greet: ['happy', 'joy'],
  dragged: ['surprised'],
};

export const ThreeModelView: React.FC<Props> = ({ url, kind, expression, mouth, blink, onError }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 用 ref 把「当前状态」喂给动画循环，避免每次 props 变化重建 WebGL 场景
  const stateRef = useRef({ expression, mouth, blink });
  stateRef.current = { expression, mouth, blink };
  const errRef = useRef(onError);
  errRef.current = onError;

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
      scene = null;
      camera = null;
      root = null;
      vrm = null;
      mixer = null;
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
      group.scale.setScalar(2 / h);
      scene.add(group);
    }

    function startLoop() {
      let last = performance.now();
      const tick = (now: number) => {
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
        last = now;
        try {
          mixer?.update(dt);
          // 表情 / 眨眼 / 口型：向目标值平滑逼近，避免弹跳
          const st = stateRef.current;
          const mgr = vrm?.expressionManager;
          if (mgr) {
            const targets: Record<string, number> = {};
            (EXPRESSION_MAP[st.expression] || []).forEach((n) => (targets[n] = 1));
            targets.blink = st.blink ? 1 : 0;
            if (st.mouth > 0.02) targets.aa = Math.min(1, st.mouth);
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
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
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
            mixer = new THREE.AnimationMixer(root);
            mixer.clipAction(gltf.animations[0]).play();
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

  return <div className="dc-model3d" ref={hostRef} />;
};

export default ThreeModelView;
