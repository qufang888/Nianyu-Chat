import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useToast, ToastView } from './Toast';

/**
 * 翻译弹窗 + 朗读（v2.3.94 需求 10）
 * ============================================================================
 * 需求要点逐条对应：
 *   ① 调用**该人物绑定的音色**朗读翻译后的文字 → 主进程 audio:tts 已认 RoleTtsConfig.configId，
 *      这里只需把当前聊天的 roleId 传下去（单聊=该角色；群聊=发言人，取不到时留空用全局默认）。
 *   ② 原文（未翻译文字）与译文各有一个朗读图标，且**图标不同**（原文 ▶ / 译文 🔊）——
 *      用户明确要求「未翻译的文字也可在翻译界面手动点击朗读图标（和翻译后的不是同一个图标）」。
 *   ③ 可删掉不想翻译的文字，删完手动点「翻译」重新翻译剩余内容。
 *   ④ 原文处与译文处**各有一个**「重新生成」按钮。
 *   ⑤ 防重叠与防重复：
 *      - 同一时刻只允许一条语音播放（新请求先停掉正在播的）；
 *      - 音频**生成中**时，生成与重新生成按钮都 disabled（loading 态）；
 *      - 遇到错误、或上一条播完后，才允许重新生成；
 *      - 「重新生成」= 传 forceRegenerate=true 绕过磁盘缓存（settings.voice.ttsRegenerate 同义）。
 *
 * 主窗与快捷小窗**共用这一个组件**，从结构上保证两边能力完全一致（小窗同步铁律）。
 */

/** 当前正在合成/播放的语音归属：'source' = 原文朗读，'target' = 译文朗读 */
type SpeakSlot = 'source' | 'target';

/** 单个可删除的原文段落 */
interface Segment {
  id: number;
  text: string;
}
/**
 * 把原文切成可独立删除的段落。
 * 规则：按空行优先分段；整段没有空行时退化为按行切（长段落也能逐句删）。
 * 空白行不产出段落（用户删完后重排也不会留空洞）。
 */
function splitSegments(source: string): string[] {
  const byBlock = source
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (byBlock.length > 1) return byBlock;
  const byLine = source
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return byLine.length ? byLine : source.trim() ? [source.trim()] : [];
}

interface Props {
  /** 原文（从消息右键「翻译文本」带过来） */
  source: string;
  /** 朗读用的角色 id：主进程按它解析绑定的音色；留空则用全局默认音色 */
  roleId?: string;
  onClose: () => void;
}

export const TranslateModal: React.FC<Props> = ({ source, roleId, onClose }) => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();

  // —— 段落（可删除）——
  // 刻意用「全量段落 + 已删 id 集合」建模，而不是直接往数组里 splice：
  //   ① 删除 O(1)，且天然保留原始顺序（撤销时无需重建、不会错位）；
  //   ② 段落文本可重复（同一句在原文里出现两次）时，按 id 操作不会误删/误恢复同名段落。
  // 全量段落由 source 派生且**永不修改**（source 在本弹窗生命周期内是常量），故用 useMemo 而非 state。
  const allSegments = useMemo<Segment[]>(
    () => splitSegments(source).map((text, i) => ({ id: i, text })),
    [source]
  );
  const [deletedIds, setDeletedIds] = useState<number[]>([]);

  // —— 翻译结果 ——
  const [result, setResult] = useState('');
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');

  // —— 朗读状态机 ——
  // speaking: 正在播放的归属；synthesizing: 正在合成的归属（生成期间所有按钮禁用）
  const [speaking, setSpeaking] = useState<SpeakSlot | null>(null);
  const [synthesizing, setSynthesizing] = useState<SpeakSlot | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 挂载标记：await 期间弹窗可能被关闭，落定后用它判断是否还要继续播放
  const mountedRef = useRef(true);
  // 单调自增序号：await 期间用户可能又点了另一条，返回时序号不一致就丢弃本次结果（防重叠/防错位）
  const seqRef = useRef(0);
  // 已生成过的音频缓存（key = slot + 文本 + 是否强制重生成），点「朗读」时命中则直接重播，不再调 API
  const cacheRef = useRef<Record<string, string>>({});

  /** 彻底停掉当前语音并断开回调（幂等，可反复调用） */
  const stopAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        a.onended = null;
        a.onerror = null;
        a.pause();
        a.currentTime = 0;
        a.removeAttribute('src');
        a.load();
      } catch { /* 忽略：部分环境 removeAttribute 可能抛 */ }
      audioRef.current = null;
    }
  }, []);

  // 关闭弹窗 / 卸载时必须停声，否则弹窗关了还在念
  useEffect(() => {
    return () => {
      stopAudio();
      mountedRef.current = false;
    };
  }, [stopAudio]);

  const segments = allSegments.filter((s) => !deletedIds.includes(s.id));
  const remainingText = segments.map((s) => s.text).join('\n');

  /** 翻译剩余段落（删完可手动再点一次） */
  const doTranslate = useCallback(async () => {
    const text = segments.map((s) => s.text).join('\n').trim();
    if (!text) {
      setError(t('msg.trEmptyToTranslate'));
      return;
    }
    setTranslating(true);
    setError('');
    try {
      const res = await api.translate(text);
      if (res.ok) {
        setResult(res.text || '');
        // 段落变了 → 译文对应的是旧文本，作废已合成的译文音频缓存（强制重生成时会重新合成）
        cacheRef.current = {};
      } else {
        setError(res.error || t('msg.translateFailed'));
      }
    } catch (e: any) {
      setError(e?.message || t('msg.translateFailed'));
    } finally {
      setTranslating(false);
    }
  }, [segments, t]);

  // 打开即自动翻译一次（保持 v2.3.22 起的原有体验：右键翻译直接出结果）
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    void doTranslate();
  }, [doTranslate]);

  /**
   * 朗读一段文本。
   * force=true = 「重新生成」：绕过磁盘缓存强制重新合成（forceRegenerate）。
   */
  const speak = useCallback(
    async (slot: SpeakSlot, text: string, force: boolean) => {
      const body = text.trim();
      if (!body) {
        showToast(t('msg.trNothingToSpeak'));
        return;
      }
      // 生成中：直接忽略本次点击（按钮已 disabled，这里是双保险，防止竞态连点）
      if (synthesizing) return;

      const cacheKey = `${slot}:${force ? 'r' : 'c'}:${body}`;
      // 先停掉正在播的 —— 这是「同一时刻只允许一条语音」的关键：新请求到来即静音旧的
      stopAudio();
      setSpeaking(null);

      const cached = force ? undefined : cacheRef.current[cacheKey];
      if (cached) {
        // 命中本页缓存：直接播，不合成、不闪 loading
        if (!mountedRef.current) return;
        const audio = new Audio(cached);
        audioRef.current = audio;
        audio.onended = () => {
          audioRef.current = null;
          setSpeaking(null);
        };
        try {
          await audio.play();
          setSpeaking(slot);
        } catch (e: any) {
          showToast(t('msg.trSpeakFailed', { msg: e?.message || String(e) }), { error: true });
        }
        return;
      }

      const seq = ++seqRef.current;
      setSynthesizing(slot);
      try {
        // roleId 传下去 → 主进程解析该人物绑定的音色（configId / voice / speed / pitch）
        const src = await api.textToSpeech(body, roleId, force);
        // 卸载后不再播放：避免弹窗已关、promise 落定仍 play() 导致音频继续响
        if (!mountedRef.current) return;
        // 期间可能又点了别的（守卫只挡生成中，但播放中可点另一条）→ 序号不符则丢弃本次结果
        if (seq !== seqRef.current) return;
        setSynthesizing(null);
        if (!force) cacheRef.current[cacheKey] = src;
        const audio = new Audio(src);
        // 双保险：显式再停一次（若期间别的路径塞了新实例）
        const prev = audioRef.current as HTMLAudioElement | null;
        if (prev && prev !== audio) {
          try { prev.onended = null; prev.pause(); prev.removeAttribute('src'); prev.load(); } catch { /* 忽略 */ }
        }
        audioRef.current = audio;
        audio.onended = () => {
          audioRef.current = null;
          setSpeaking(null);
        };
        audio.onerror = () => {
          audioRef.current = null;
          setSpeaking(null);
          showToast(t('msg.trSpeakFailed', { msg: t('msg.trAudioError') }), { error: true });
        };
        await audio.play();
        setSpeaking(slot);
      } catch (e: any) {
        if (seq === seqRef.current) {
          setSynthesizing(null);
          setSpeaking(null);
          showToast(t('msg.trSpeakFailed', { msg: e?.message || String(e) }), { error: true });
        }
      }
    },
    [roleId, synthesizing, showToast, stopAudio, t]
  );

  const removeSegment = (id: number) => {
    setDeletedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    // 段落变了 → 已合成的译文音频不再对应，缓存作废
    cacheRef.current = {};
  };

  const restoreAll = () => {
    setDeletedIds([]);
    cacheRef.current = {};
  };

  // 生成中：两个朗读按钮与两个重新生成按钮**全部**禁用（需求硬要求）
  const busy = synthesizing !== null;
  const sourceText = remainingText;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-card tr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('msg.translate')}</div>

        {/* ---------------- 原文（未翻译文字）---------------- */}
        <div className="tr-sec-head">
          <span className="tr-sec-label">{t('msg.translateSource')}</span>
          <div className="tr-sec-actions">
            {/* 原文朗读图标：▶（与译文的 🔊 刻意不同，用户明确要求）。
                aria-pressed 让「正在朗读这一条」不靠颜色也能感知（WCAG AA）。 */}
            <button
              className="btn-ghost tr-btn"
              onClick={() => speak('source', sourceText, false)}
              disabled={busy || !sourceText.trim()}
              aria-pressed={speaking === 'source'}
              aria-label={t('msg.trSpeakSource')}
              title={t('msg.trSpeakSource')}
            >
              <span aria-hidden="true">▶</span>
              <span className="tr-btn-text">{t('msg.trSpeakSource')}</span>
            </button>
            <button
              className="btn-ghost tr-btn"
              onClick={() => speak('source', sourceText, true)}
              disabled={busy || !sourceText.trim()}
              aria-label={t('msg.trRegenSource')}
              title={t('msg.trRegenSource')}
            >
              <span aria-hidden="true">↻</span>
              <span className="tr-btn-text">{t('msg.trRegenSource')}</span>
            </button>
          </div>
        </div>

        <div className="tr-seg-list">
          {segments.length === 0 ? (
            <div className="muted" style={{ padding: 8 }}>{t('msg.trAllDeleted')}</div>
          ) : (
            segments.map((s) => (
              <div className="tr-seg" key={s.id}>
                <span className="tr-seg-text">{s.text}</span>
                <button
                  className="tr-seg-del"
                  onClick={() => removeSegment(s.id)}
                  aria-label={t('msg.trDeleteSeg')}
                  title={t('msg.trDeleteSeg')}
                  disabled={busy}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            ))
          )}
        </div>
        <div className="tr-foot-row">
          <span className="muted">
            {deletedIds.length > 0 ? t('msg.trDeleted', { n: deletedIds.length }) : t('msg.trDeleteHint')}
          </span>
          {deletedIds.length > 0 ? (
            <button className="btn-ghost" onClick={restoreAll} disabled={busy}>
              {t('msg.trRestore')}
            </button>
          ) : null}
          {/* 删完后手动点「翻译」重新翻译剩余内容 */}
          <button className="btn-primary" onClick={doTranslate} disabled={translating || busy || segments.length === 0}>
            {translating ? t('chat.transcribing') : t('msg.trTranslateNow')}
          </button>
        </div>

        {/* ---------------- 译文（翻译后的文字）---------------- */}
        <div className="tr-sec-head" style={{ marginTop: 12 }}>
          <span className="tr-sec-label">{t('msg.translateResult')}</span>
          <div className="tr-sec-actions">
            {/* 译文朗读图标：🔊（与原文的 ▶ 不同图标，用户明确要求） */}
            <button
              className="btn-ghost tr-btn"
              onClick={() => speak('target', result, false)}
              disabled={busy || !result.trim()}
              aria-pressed={speaking === 'target'}
              aria-label={t('msg.trSpeakTarget')}
              title={t('msg.trSpeakTarget')}
            >
              <span aria-hidden="true">🔊</span>
              <span className="tr-btn-text">{t('msg.trSpeakTarget')}</span>
            </button>
            <button
              className="btn-ghost tr-btn"
              onClick={() => speak('target', result, true)}
              disabled={busy || !result.trim()}
              aria-label={t('msg.trRegenTarget')}
              title={t('msg.trRegenTarget')}
            >
              <span aria-hidden="true">↻</span>
              <span className="tr-btn-text">{t('msg.trRegenTarget')}</span>
            </button>
          </div>
        </div>

        {translating ? (
          <div style={{ padding: 8 }}>{t('chat.transcribing')}</div>
        ) : error ? (
          <div className="tr-err" role="alert">{error}</div>
        ) : (
          <div className="tr-result">{result}</div>
        )}

        {/* 生成中提示：让用户知道为什么按钮全灰。
            顺带说明朗读用的是该人物绑定的音色（需求 10 的核心语义）。 */}
        <div className="tr-busy" role="status">
          {busy
            ? synthesizing === 'source'
              ? t('msg.trSynthSource')
              : t('msg.trSynthTarget')
            : t('msg.trReadAloudHint')}
        </div>

        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button className="btn-primary" onClick={onClose}>
            {t('common.ok')}
          </button>
        </div>
      </div>
      <ToastView toast={toast} />
    </div>
  );
};
