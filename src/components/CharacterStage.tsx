// 角色舞台（V3）—— 聊天/表演容器。
//
// 能力：
// - 角色立绘可拖拽旋转（CSS 3D）、滚轮缩放；
// - 语音以气泡呈现：复用主聊天已有的 TTS（api.textToSpeech 返回 dataURL 音频）；
// - 口型同步：Web Audio AnalyserNode 取音量驱动嘴型；TTS 未配置时回退 Web Speech API 并做简易口型动画。
//
// v3.0.3 变更（舞台 ⇄ 桌面双向同步 + 高清渲染）：
// - 缩放语义从「视口内放大」改为「**角色真实大小**」：舞台里的模型大小 = 桌面桌宠的大小，
//   拖动滑块会实时同步到桌面桌宠，桌面滚轮改大小也会反向同步回舞台滑块；
// - 唯一真值是 settings.desktopCharacters[].scale，舞台只保留一份**本地镜像 state**（跟手用）；
// - 渲染路径改为「按 zoom 放大布局盒子」而非「transform: scale() 插值」，
//   消除合成层纹理放大导致的模糊（详见 css 注释）。
//
// v3.0.3 QA P1-1（一次拖动只落盘一次）：
// - pointerup 提交过一次后，浏览器还会派发 blur（focusout）⇒ React onBlur 再触发一次 flushCommit；
//   拖动中途停顿 >200ms 时去抖也会先提交一次。两者若不判重 ⇒ 一次拖动落盘 2 次 + 广播 2 次，
//   违反 PRD A5 / R1-AC5（「同一轮操作内 saveSettings 只发生 1 次」）。
//   修法：commitZoom 内用**独立的** lastCommittedZoomRef 判重（值未变 ⇒ 直接 return）。
//   ⚠️ 不可复用 lastWrittenZoomRef —— 后者承担「回声抑制」语义（用完即清空），两者语义不同、不可混用。
//
// 合规：舞台配色/布局为念语自有样式，与任何商业产品的视觉稿无关；Live2D/VRM/GLB 本版不内置
// 专有运行时，仅对图片/原创占位角色提供原生渲染，其余格式在舞台内明确提示。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { AppSettings, DesktopCharacter } from '../types';
import type { CharacterExpression } from '../character/PlaceholderCharacter';
import { ModelView } from '../character/ModelView';
import { isGroupEnabled } from '../utils/animControl';

/**
 * 视线归一化除数基准（与角色窗 CharacterApp 的 DC_EYE_DIVISOR 同值：角色中心 ±170px ⇒ eye ±1）。
 * v3.0.11：实际除数须乘当前 zoom —— 舞台模型盒按 --stage-zoom 真实放大，光标扫过全宽的
 * 像素距离同比增大；除数不跟随会放大后眼球转角变小（「眼神跟不上手」）。
 */
const STAGE_EYE_DIVISOR = 170;

const STAGE_LINES = ['今天想聊点什么？', '我在这里，慢慢说就好。', '你笑的时候，我也跟着开心。', '要不要一起发会儿呆？'];
/** 舞台缩放范围与步长（集中定义：滚轮与滑块共用，避免两处阈值漂移）。
 *  v3.0.3：上限由 1.9 收窄到 1.6（与当时桌面滚轮一致）。
 *  v3.0.9：应「人物调到最大仍偏小」反馈放宽到 2.0。
 *  v3.0.10：用户要求最大 500% 且不损失分辨率，桌面与舞台**同步**放宽到 5.0；
 *  渲染分辨率同步支持（pixelRatio 上限 12），步长 0.05 与下限 0.6 不变。 */
const STAGE_ZOOM_MIN = 0.6;
const STAGE_ZOOM_MAX = 5.0;
const STAGE_ZOOM_STEP = 0.05;
/** 滚轮像素 → 缩放增量系数：常规鼠标一格 deltaY≈100 → 约 0.12。 */
const STAGE_WHEEL_SENSITIVITY = 0.0012;
/** 拖动滑块时的提交去抖（毫秒）：拖动过程中只发预览，停下来这么久才落盘一次。 */
const STAGE_SCALE_COMMIT_DEBOUNCE_MS = 200;
/** 缩放值比较容差：滑块步长 0.05，用 1e-6 判定「同一个值」（与回声抑制口径一致）。 */
const STAGE_ZOOM_EPS = 1e-6;
/** 本次 zoom 变化来源：user=用户手势（允许写回）；external=外部同步（只读）。 */
type ZoomSource = 'user' | 'external';

export const CharacterStage: React.FC<{ character: DesktopCharacter; onClose: () => void }> = ({
  character,
  onClose,
}) => {
  const { t } = useI18n();
  const [rotX, setRotX] = useState(-4);
  const [rotY, setRotY] = useState(0);
  /** 缩放的本地镜像：拖动时立即跟手；外部变化也会对齐到权威值。 */
  const [zoom, setZoom] = useState(character.scale ?? 1);
  const [bubble, setBubble] = useState<string | null>(null);
  const [expression, setExpression] = useState<CharacterExpression>('neutral');
  const [mouth, setMouth] = useState(0);
  /** v3.0.8：主窗 mousemove 换算出的角色视线（-1~1） */
  const [eye, setEye] = useState({ x: 0, y: 0 });
  /** v3.0.8：设置快照（子开关 + character 三档门禁） */
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** v3.0.8：舞台拖动旋转时动作让位（与角色窗拖拽同语义） */
  const [stageDragging, setStageDragging] = useState(false);
  const [stageError, setStageError] = useState('');
  /** v3.0.8：视线归一化的参考盒子（.stage-model） */
  const modelBoxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const speakTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 本次 zoom 变化的来源：区分「用户手势」与「外部同步」，只有前者才允许写回。 */
  const zoomSourceRef = useRef<ZoomSource>('external');
  /** 最后一次**已提交**（落盘）的 zoom：用于回声抑制，避免自己写的广播又触发一次 setZoom。 */
  const lastWrittenZoomRef = useRef<number | null>(null);
  /** QA D1：最后一次真正发给主进程的 zoom。判重用——与 lastWrittenZoomRef 的「用完即清」语义不同，
   *  本 ref 生命周期内只增不减，确保 pointerup→blur、去抖→pointerup 同值路径只落盘一次。 */
  const lastCommittedZoomRef = useRef<number | null>(null);
  /** 落盘提交的去抖计时器。 */
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最新 zoom 的 ref：滚轮与手势末提交都要读「当前值」，用 ref 避免读到过期的闭包值。 */
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const stopMouth = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (speakTimer.current) clearInterval(speakTimer.current);
    speakTimer.current = null;
    setMouth(0);
  }, []);

  useEffect(() => () => {
    stopMouth();
    audioCtxRef.current?.close().catch(() => {});
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
  }, [stopMouth]);

  // ===== v3.0.8：舞台窗视线跟随（主窗可交互，直接收 window.mousemove，零 IPC 改动）=====
  // 角色窗走主进程 30Hz dc:cursor；舞台在主窗里，mousemove 现成可用。
  // 注意：这里只写 state，ThreeModelView 内部全部走 ref，不会重建 WebGL 场景。
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = modelBoxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      setEye({
        x: Math.max(-1, Math.min(1, (e.clientX - cx) / (STAGE_EYE_DIVISOR * zoom))),
        y: Math.max(-1, Math.min(1, (e.clientY - cy) / (STAGE_EYE_DIVISOR * zoom))),
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [zoom]);

  useEffect(() => {
    let alive = true;
    const apply = (s: AppSettings | null) => {
      if (alive) setSettings(s);
    };
    void api.getSettings().then((s: any) => apply(s as AppSettings | null));
    const off = api.onSettingsChanged(() => {
      void api.getSettings().then((s: any) => apply(s as AppSettings | null));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // ===== v3.0.3：外部缩放同步（桌面滚轮 → 舞台滑块）=====
  // 桌面滚轮改大小 → 主进程落盘并广播 settings:changed → 舞台订阅到后按 id 找到角色 → 更新滑块。
  // ⚠️ 这一路**只读**：绝不回调 dcSetScale（否则会与桌面形成回环、反复写盘）。
  useEffect(() => {
    const off = api.onSettingsChanged((_e: any, patch: any) => {
      const list = patch?.desktopCharacters;
      if (!Array.isArray(list)) return;
      const c = list.find((x: any) => x?.id === character.id);
      if (!c || typeof c.scale !== 'number') return;
      const v = Math.max(STAGE_ZOOM_MIN, Math.min(STAGE_ZOOM_MAX, c.scale));
      // 回声抑制：我们自己刚提交的值，广播回来时无需再 setZoom（避免无意义的重渲染）。
      if (lastWrittenZoomRef.current !== null && Math.abs(lastWrittenZoomRef.current - v) < 1e-6) {
        lastWrittenZoomRef.current = null;
        return;
      }
      zoomSourceRef.current = 'external';
      setZoom(v);
    });
    return off;
  }, [character.id]);

  // 打开舞台时拉一次权威值（props 里的 character 可能是打开瞬间的旧快照）。
  useEffect(() => {
    let alive = true;
    api.dcGetState(character.id).then((s: any) => {
      if (!alive) return;
      const v = s?.character?.scale;
      if (typeof v !== 'number') return;
      const next = Math.max(STAGE_ZOOM_MIN, Math.min(STAGE_ZOOM_MAX, v));
      zoomSourceRef.current = 'external';
      setZoom(next);
    });
    return () => {
      alive = false;
    };
  }, [character.id]);

  /**
   * 提交缩放到桌面（落盘 + 广播）。
   * 只在手势结束时调用一次 ⇒ 一次拖动 = 一次 settings:changed 广播。
   */
  const commitZoom = useCallback(
    (v: number) => {
      // O2：外部同步路径绝不回写。applyZoom 打的是 'user' 标记，外部 setZoom 不打标记；
      // 这里作为最后一道闸门，防止后续改动误把外部值送进提交链路造成桌面↔舞台回环。
      if (zoomSourceRef.current !== 'user') return;
      const next = Math.max(STAGE_ZOOM_MIN, Math.min(STAGE_ZOOM_MAX, v));
      if (lastCommittedZoomRef.current !== null && Math.abs(lastCommittedZoomRef.current - next) < STAGE_ZOOM_EPS) {
        return;
      }
      lastCommittedZoomRef.current = next;
      lastWrittenZoomRef.current = next;
      api.dcSetScale(character.id, next);
    },
    [character.id]
  );

  /**
   * 手势内的实时预览 + 延迟提交（v3.0.12 单通道）。
   * - 预览：只 setZoom 改舞台本地 1:1 布局盒 ⇒ 手势期桌宠窗不再被 resize（双通道是闪动根因）；
   * - 提交（dcSetScale）：去抖 200ms 后落盘一次；指针抬起时立即提交（不等去抖）。
   *   主进程落盘后广播一次，桌宠窗与舞台在同一语义下各自同步，无互相追帧。
   */
  const scheduleCommit = useCallback(
    (v: number) => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null;
        commitZoom(v);
      }, STAGE_SCALE_COMMIT_DEBOUNCE_MS);
    },
    [commitZoom]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, rx: rotX, ry: rotY };
    setStageDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setRotY(Math.max(-70, Math.min(70, d.ry + (e.clientX - d.x) * 0.35)));
    setRotX(Math.max(-40, Math.min(40, d.rx - (e.clientY - d.y) * 0.3)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    setStageDragging(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  /**
   * 缩放值变化入口：统一在这里打「用户手势」标记并做预览 + 提交排程。
   * 外部同步走 setZoom（不经本函数），因此不会误触发写回。
   */
  const applyZoom = useCallback(
    (raw: number) => {
      const v = Math.max(STAGE_ZOOM_MIN, Math.min(STAGE_ZOOM_MAX, raw));
      zoomSourceRef.current = 'user';
      setZoom(v);
      // v3.0.12：删除 api.dcSetScaleLive —— 手势期只动舞台自己的 1:1 布局盒，
      // 不再并行 resize 桌宠窗（两条缩放通道互相追帧才是「舞台放大闪动」的根因）。
      // P3 拍板：舞台拖动时桌宠不实时跟随，提交后一次同步。
      scheduleCommit(v);
    },
    [character.id, scheduleCommit]
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    applyZoom(zoomRef.current - e.deltaY * STAGE_WHEEL_SENSITIVITY);
  };

  /** 滑块拖动结束（pointerup / keyup）时立即提交，不再等去抖。 */
  const flushCommit = useCallback(() => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    commitZoom(zoomRef.current);
  }, [commitZoom]);

  const speak = async () => {
    const text = STAGE_LINES[Math.floor(Math.random() * STAGE_LINES.length)];
    setBubble(text);
    setExpression('happy');
    stopMouth();
    try {
      const url = await api.textToSpeech(text);
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
      }
      await ctx.resume();
      const audio = new Audio(url);
      const src = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setMouth(Math.min(1, (sum / data.length / 255) * 2.6));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      audio.onended = () => {
        stopMouth();
        setExpression('neutral');
        setTimeout(() => setBubble(null), 1600);
      };
      await audio.play();
    } catch {
      // TTS 未配置 / 失败：回退浏览器语音合成，并用简易口型动画
      setExpression('happy');
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.onend = () => {
          stopMouth();
          setExpression('neutral');
        };
        window.speechSynthesis.speak(u);
        const start = Date.now();
        speakTimer.current = setInterval(() => {
          const s = (Date.now() - start) / 1000;
          setMouth(0.12 + 0.36 * Math.abs(Math.sin(s * 9)));
        }, 60);
        setTimeout(stopMouth, Math.min(12000, 1200 + text.length * 220));
      } else {
        setTimeout(() => {
          setExpression('neutral');
          setBubble(null);
        }, 2200);
      }
    }
  };

  const openChat = () => {
    if (character.boundChat) {
      api.dcOpenChat(character.boundChat);
      onClose();
    }
  };

  const charGroupOn = settings ? isGroupEnabled(settings, 'character') : true;
  const idleOn = charGroupOn && settings?.animCharacterIdle !== false;
  const gazeOn = charGroupOn && settings?.animCharacterGaze !== false;

  // 渲染失败提示：区分「缺运行时」与「模型本身加载失败」，前者给一键打开运行库目录
  const needRuntime = stageError === 'missing-cubism4' || stageError === 'missing-cubism2';
  const errText = needRuntime
    ? stageError === 'missing-cubism4'
      ? t('characters.errCubism4')
      : t('characters.errCubism2')
    : stageError
      ? t('characters.errModel')
      : '';

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal stage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="stage-title">{t('characters.stageTitle')} · {character.name}</span>
          <span className="modal-close" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body stage-body">
          <div
            className="stage-viewport"
            // --stage-zoom 写在**视口**上（而不是 .stage-model）：
            // CSS 自定义属性只向下继承，写在子元素上父元素读不到 ——
            // 视口要用它算 perspective、模型要用它算盒子尺寸，两者必须是同一个值。
            // （与 v3.0.2 的 --dc-scale 必须写在 .dc-character 自身同理）
            style={{ ['--stage-zoom' as string]: String(zoom) } as React.CSSProperties}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            title={t('characters.dragRotate')}
          >
            {/* v3.0.3：新增内层容器 —— 放大后的模型要能撑出滚动区（overflow:auto）。
                外层 .stage-viewport 负责裁剪与滚动，内层负责居中。 */}
            <div className="stage-inner">
              {/* v3.0.3 高清渲染关键：模型盒子按 --stage-zoom 真实放大（CSS 侧 calc），
                  transform 只保留旋转，**不再有 scale()** ——
                  有 scale() 时浏览器会先按原尺寸栅格化再插值放大 ⇒ 模糊；
                  盒子直接变大则由浏览器按最终尺寸重采样 ⇒ 清晰（与桌面桌宠同一条渲染路径）。
                  旋转仍是舞台专属的纯预览姿态，不写回桌面。
                  透视距离随 zoom 同步放大 ⇒ 相对畸变不变，旋转手感与 v3.0.2 一致。 */}
              <div
                ref={modelBoxRef}
                className="stage-model"
                style={{ transform: `rotateX(${rotX}deg) rotateY(${rotY}deg)` }}
              >
                <ModelView
                  character={character}
                  expression={expression}
                  blink={false}
                  dragging={false}
                  mouth={mouth}
                  eyeX={eye.x}
                  eyeY={eye.y}
                  motionAmplitude={character.motionAmplitude ?? 1}
                  motionEnabled={idleOn}
                  gazeEnabled={gazeOn}
                  gestureHold={stageDragging}
                  zoom={zoom}
                  onError={(m) => setStageError(m)}
                />
                {character.kind === 'placeholder' && (
                  <span
                    className="stage-mouth"
                    style={{ transform: `translate(-50%, 0) scaleY(${0.25 + mouth * 1.9})` }}
                  />
                )}
              </div>
            </div>
            {bubble && <div className="stage-bubble">{bubble}</div>}
          </div>

          {errText && (
            <div className="stage-note">
              {errText}
              {needRuntime && (
                <button className="btn-ghost stage-note-btn" onClick={() => void api.dcOpenRuntimeDir()}>
                  {t('characters.openRuntimeDir')}
                </button>
              )}
            </div>
          )}

          <div className="stage-toolbar">
            <button className="btn-primary" onClick={() => void speak()}>
              {t('characters.say')}
            </button>
            <button className="btn-ghost" onClick={openChat} disabled={!character.boundChat}>
              {t('characters.newChat')}
            </button>
            <button className="btn-ghost" onClick={openChat} disabled={!character.boundChat}>
              {t('characters.record')}
            </button>
            <label className="stage-zoom">
              <span>{t('characters.stageZoom')}</span>
              <input
                className="stage-zoom-range"
                type="range"
                min={STAGE_ZOOM_MIN}
                max={STAGE_ZOOM_MAX}
                step={STAGE_ZOOM_STEP}
                value={zoom}
                aria-label={t('characters.stageZoom')}
                onChange={(e) => applyZoom(Number(e.target.value))}
                onPointerUp={flushCommit}
                onKeyUp={flushCommit}
                onBlur={flushCommit}
              />
              <span className="stage-zoom-value">{Math.round(zoom * 100)}%</span>
            </label>
            {/* v3.0.3：说明「模型大小」会同步到桌面桌宠，避免用户以为只是舞台预览 */}
            <span className="muted stage-hint">{t('characters.stageSyncHint')}</span>
            <span className="muted stage-hint">{t('characters.dragRotate')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CharacterStage;
