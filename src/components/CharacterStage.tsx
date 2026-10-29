// 角色舞台（V3）—— 聊天/表演容器。
//
// 能力：
// - 角色立绘可拖拽旋转（CSS 3D）、滚轮缩放；
// - 语音以气泡呈现：复用主聊天已有的 TTS（api.textToSpeech 返回 dataURL 音频）；
// - 口型同步：Web Audio AnalyserNode 取音量驱动嘴型；TTS 未配置时回退 Web Speech API 并做简易口型动画。
//
// 合规：舞台配色/布局为念语自有样式，与任何商业产品的视觉稿无关；Live2D/VRM/GLB 本版不内置
// 专有运行时，仅对图片/原创占位角色提供原生渲染，其余格式在舞台内明确提示。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { DesktopCharacter } from '../types';
import type { CharacterExpression } from '../character/PlaceholderCharacter';
import { ModelView } from '../character/ModelView';

const STAGE_LINES = ['今天想聊点什么？', '我在这里，慢慢说就好。', '你笑的时候，我也跟着开心。', '要不要一起发会儿呆？'];

export const CharacterStage: React.FC<{ character: DesktopCharacter; onClose: () => void }> = ({
  character,
  onClose,
}) => {
  const { t } = useI18n();
  const [rotX, setRotX] = useState(-4);
  const [rotY, setRotY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [bubble, setBubble] = useState<string | null>(null);
  const [expression, setExpression] = useState<CharacterExpression>('neutral');
  const [mouth, setMouth] = useState(0);
  const [stageError, setStageError] = useState('');
  const dragRef = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const speakTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
  }, [stopMouth]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, rx: rotX, ry: rotY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setRotY(Math.max(-70, Math.min(70, d.ry + (e.clientX - d.x) * 0.35)));
    setRotX(Math.max(-40, Math.min(40, d.rx - (e.clientY - d.y) * 0.3)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.6, Math.min(1.9, z - e.deltaY * 0.0012)));
  };

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
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            title={t('characters.dragRotate')}
          >
            <div
              className="stage-model"
              style={{ transform: `perspective(900px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${zoom})` }}
            >
              <ModelView
                character={character}
                expression={expression}
                blink={false}
                dragging={false}
                mouth={mouth}
                onError={(m) => setStageError(m)}
              />
              {character.kind === 'placeholder' && (
                <span
                  className="stage-mouth"
                  style={{ transform: `translate(-50%, 0) scaleY(${0.25 + mouth * 1.9})` }}
                />
              )}
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
            <span className="muted stage-hint">{t('characters.dragRotate')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CharacterStage;
