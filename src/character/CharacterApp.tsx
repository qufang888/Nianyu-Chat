// 桌面角色主界面（V3）
//
// 分层职责：
// - 命中/穿透路由：窗口默认整体穿透（主进程 setIgnoreMouseEvents(true,{forward:true})），
//   本组件在 pointermove 时用 elementFromPoint 判定光标是否落在 drag/interactive 命中区，
//   落在命中区 → 请求切可交互；离开 → 恢复穿透。透明区永远穿透，不产生「空气墙」。
// - 拖拽：只有角色命中箱 pointerdown 才算抓取；越 5px 门槛后通知主进程开始弹簧跟随
//   （主进程轮询设备光标 + K200/C30 + 1/120 子步），松手由主进程做惯性滑停。
// - 行为：呼吸/眨眼/视线跟随 + 加权随机动作 + 自主游走；互动语句由绑定对话的模型生成。
// - 右键菜单：穿透锁定 / 置顶人物 / 绑定跳转 / 舞台 / 隐藏 / 管理（配色走主题变量，全主题可读）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { CharacterRuntimeSettings, DesktopCharacter } from '../types';
import type { CharacterExpression } from './PlaceholderCharacter';
import { ModelView } from './ModelView';
import { pickIdleAction } from './behaviors';
import { applyAnimControl, type AnimSettingsLike } from '../utils/animControl';
import { playSoundSync } from '../utils/sound';

interface DcState {
  runtime: CharacterRuntimeSettings;
  character: DesktopCharacter | null;
}

const DEFAULT_RUNTIME: CharacterRuntimeSettings = {
  enabled: false,
  x: 0,
  y: 0,
  alwaysOnTop: true,
  passThroughLocked: false,
  activeId: '',
};

const HIT_SELECTOR = '.dc-character, .dc-bubble, .dc-menu';
const DRAG_THRESHOLD = 5;

// ===== 桌宠互动语句生成参数（v3.0.1-beta.9）=====
// 这些值只控制「触发节奏 / 展示形态」，不参与任何文案内容；文案一律由模型输出。
/** 试探周期（毫秒）：每次到期才检查是否满足生成条件，未绑定时不发任何请求。 */
const CHARACTER_LINE_TICK_MS = 15_000;
/** 两次生成请求之间的最小间隔（毫秒）：防止高频模型调用造成 QPS 风暴。 */
const CHARACTER_LINE_MIN_INTERVAL_MS = 45_000;
/** 单次生成请求的软超时（毫秒）：超时后静默放弃并释放并发锁，不显示任何气泡。 */
const CHARACTER_LINE_TIMEOUT_MS = 20_000;
/** 气泡展示的最大字符数：仅裁剪展示文本，写入绑定对话的仍是模型原文。 */
const CHARACTER_BUBBLE_MAX_CHARS = 80;
/** 模型语句气泡的停留时长（毫秒）。 */
const CHARACTER_BUBBLE_MS = 4200;

/**
 * 只裁剪「气泡展示」文本；写入绑定对话的仍是模型原文，不做任何改写。
 * 合并空白、去掉模型偶尔包裹的成对引号、超长截断，避免气泡被撑出角色窗。
 */
function sanitizeBubbleText(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'「『“‘]+|["'」』”’]+$/g, '').trim();
  if (s.length > CHARACTER_BUBBLE_MAX_CHARS) {
    s = `${s.slice(0, CHARACTER_BUBBLE_MAX_CHARS)}…`;
  }
  return s;
}

export const CharacterApp: React.FC = () => {
  const { t } = useI18n();

  // v3.0.1-beta.4：角色气泡文案原先是中文原文（src/character/behaviors.ts 现只存 i18n 键），
  // 导致非中文界面下角色仍说中文 → 统一用 t() 解析，台词随界面语言切换。
  const [state, setState] = useState<DcState>({ runtime: DEFAULT_RUNTIME, character: null });
  const [expression, setExpression] = useState<CharacterExpression>('neutral');
  const [blink, setBlink] = useState(false);
  const [eye, setEye] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelError, setModelError] = useState<string>('');

  const charRef = useRef<HTMLDivElement | null>(null);
  const interactiveRef = useRef(false);
  // from：这次按下发生在角色本体还是气泡上。只有角色本体的「点一下」才等于点角色
  //（气泡是中性可拖拽区，点气泡不该顺手跳转绑定的对话）。
  const dragRef = useRef<{ started: boolean; from: 'character' | 'bubble'; sx: number; sy: number; gdx: number; gdy: number } | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const menuOpenRef = useRef(false);
  const charRefState = useRef<DesktopCharacter | null>(null);
  /** 桌宠语句生成的并发锁：同一时刻只允许一个模型请求在途。 */
  const lineInFlightRef = useRef(false);
  /** 上次发起桌宠语句生成的时间戳（毫秒），用于最小间隔节流。 */
  const lineLastAtRef = useRef(0);

  draggingRef.current = dragging;
  menuOpenRef.current = menuOpen;
  charRefState.current = state.character;

  const scale = state.character?.scale ?? 1;
  const runtime = state.runtime;

  const showBubble = useCallback((text: string, ms = 3800) => {
    if (charRefState.current && charRefState.current.bubble === false) return;
    setBubble(text);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setBubble(null), ms);
  }, []);

  /**
   * 向绑定对话请求一句由模型按该对话人物人设生成的互动语句。
   * 复用 api.proactive（→ chats:proactive → handleProactive）：主进程会把原句以
   * from_proactive 消息写入绑定对话，并把内容通过返回值回传给桌宠气泡。
   * 失败 / 超时 / 无内容一律静默降级，绝不使用固定文案兜底。
   */
  const requestCharacterLine = useCallback(
    async (bound: { type: 'single' | 'group'; id: string }) => {
      const now = Date.now();
      // 并发锁 + 最小间隔：重复触发 / 多定时器叠加 / 窗口重建都不会造成 QPS 风暴。
      if (lineInFlightRef.current) return;
      if (now - lineLastAtRef.current < CHARACTER_LINE_MIN_INTERVAL_MS) return;
      lineInFlightRef.current = true;
      lineLastAtRef.current = now;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        // 软超时：模型长时间无响应不会把后续语句永久堵死；到点静默放弃本次结果。
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CHARACTER_LINE_TIMEOUT_MS);
        });
        const res = await Promise.race([
          api.proactive({ chatType: bound.type, chatId: bound.id, source: 'character' }),
          timeout,
        ]);
        if (!res || !res.ok) return;
        const text = sanitizeBubbleText(res.content || '');
        if (!text) return;
        showBubble(text, CHARACTER_BUBBLE_MS);
        setExpression('happy');
        setTimeout(() => setExpression((e) => (e === 'happy' ? 'neutral' : e)), 1800);
      } catch {
        // 静默降级：模型未配置 / 调用失败 / 离线时不显示气泡、不报错弹窗，
        // 绝不使用固定文案兜底冒充模型输出。
      } finally {
        if (timer) clearTimeout(timer);
        lineInFlightRef.current = false;
      }
    },
    [showBubble],
  );

  // ===== 状态同步 =====
  useEffect(() => {
    let alive = true;
    api.dcGetState().then((s) => {
      if (!alive) return;
      setState({ runtime: s.runtime || DEFAULT_RUNTIME, character: s.active });
    });
    const off = api.onDcState((d) => {
      setState({ runtime: d.runtime || DEFAULT_RUNTIME, character: d.character });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // ===== 动效总开关（角色窗是独立 document，走统一的 applyAnimControl('character')）=====
  // 角色窗不加载 index.css，所以「全关档」的全局 kill 规则不存在于本文档；
  // applyAnimControl 会按 kind='character' 注入本窗自己的门禁样式（含 character 分组的独立开关）。
  useEffect(() => {
    const apply = (s: AnimSettingsLike | null) => applyAnimControl(document, s, 'character');
    api.getSettings().then((s) => apply(s as AnimSettingsLike));
    const off = api.onSettingsChanged(() => {
      api.getSettings().then((s) => apply(s as AnimSettingsLike));
    });
    return off;
  }, []);

  // ===== 眨眼 =====
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      const wait = 2600 + Math.random() * 3200;
      timer = setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        setTimeout(() => setBlink(false), 130);
        loop();
      }, wait);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // ===== 随机待机动作 =====
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        const c = charRefState.current;
        if (!draggingRef.current && !menuOpenRef.current && c?.behavior !== false) {
          const a = pickIdleAction();
          setExpression(a.expression);
          // v3.0.1-beta.9：待机动作只切换表情，不再弹出任何本地文案气泡。
          if (actionTimer.current) clearTimeout(actionTimer.current);
          actionTimer.current = setTimeout(() => {
            if (!draggingRef.current) setExpression('neutral');
          }, a.holdMs);
        }
        loop();
      }, 8000 + Math.random() * 14000);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
      if (actionTimer.current) clearTimeout(actionTimer.current);
    };
  }, [showBubble]);

  // ===== 桌宠互动语句（绑定对话后由模型生成，v3.0.1-beta.9）=====
  // 固定句子池已全部移除：未绑定对话时完全不生成语句、也不显示任何文案气泡；
  // 绑定后按该对话人物的人设，复用主动消息链路 api.proactive 生成，原句同时
  // 作为 from_proactive 消息写入绑定对话（在该对话的消息列表里可以看到）。
  // 点击 / 拖拽不触发模型请求：它们是高频即时反馈，模型有秒级延迟且会放大 QPS，
  // 只保留表情 / 动作 / 音效等非语言反馈，不显示任何文案气泡。
  useEffect(() => {
    const timer = setInterval(() => {
      const c = charRefState.current;
      const bound = c?.boundChat;
      // 未绑定 / 关闭自主行为 / 关闭气泡 / 拖拽中 / 菜单打开 → 不发起任何模型请求。
      if (!bound?.id) return;
      if (c?.behavior === false || c?.bubble === false) return;
      if (draggingRef.current || menuOpenRef.current) return;
      void requestCharacterLine(bound);
    }, CHARACTER_LINE_TICK_MS);
    return () => clearInterval(timer);
  }, [requestCharacterLine]);

  // ===== 自主游走（时长触发，窗口小幅位移） =====
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        const c = charRefState.current;
        if (!draggingRef.current && !menuOpenRef.current && c?.behavior !== false) {
          const dx = (Math.random() - 0.5) * 90;
          const dy = (Math.random() - 0.5) * 40;
          api.dcReposition(window.screenX + dx, window.screenY + dy);
          setExpression('nod');
          setTimeout(() => setExpression('neutral'), 1200);
        }
        loop();
      }, 32000 + Math.random() * 40000);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // ===== 命中/穿透路由 =====
  const applyInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return;
    interactiveRef.current = next;
    api.dcSetIgnore(!next);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // 穿透锁定/拖拽期间不改路由（拖拽由主进程锁定可交互）
      if (runtime.passThroughLocked || draggingRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const hit = !!el?.closest(HIT_SELECTOR);
      applyInteractive(hit);
      if (!hit && menuOpenRef.current) setMenuOpen(false);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [applyInteractive, runtime.passThroughLocked]);

  // ===== 视线全屏跟随（主进程轮询全局光标，约 30Hz 推送；窗口整体穿透，窗内 mousemove 收不到屏外光标）=====
  useEffect(() => {
    const off = api.onDcCursor(({ x, y }) => {
      const el = charRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      setEye({
        x: Math.max(-1, Math.min(1, (x - cx) / 170)),
        y: Math.max(-1, Math.min(1, (y - cy) / 170)),
      });
    });
    return off;
  }, []);

  // 菜单打开时保持可交互；关闭后若光标不在命中区则恢复穿透
  useEffect(() => {
    if (menuOpen) applyInteractive(true);
  }, [menuOpen, applyInteractive]);

  // ===== 拖拽 =====
  const beginPointer = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (runtime.passThroughLocked) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const from: 'character' | 'bubble' = (e.currentTarget as HTMLElement).classList.contains('dc-character')
      ? 'character'
      : 'bubble';
    dragRef.current = {
      started: false,
      from,
      sx: e.screenX,
      sy: e.screenY,
      gdx: e.screenX - window.screenX,
      gdy: e.screenY - window.screenY,
    };
  };

  const movePointer = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.started) return;
    if (Math.hypot(e.screenX - d.sx, e.screenY - d.sy) < DRAG_THRESHOLD) return;
    d.started = true;
    setDragging(true);
    setExpression('dragged');
    // v3.0.1-beta.9：拖拽只给表情反馈，不触发模型请求、不显示文案气泡。
    api.dcDragStart(d.gdx, d.gdy);
  };

  const endPointer = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d?.started) {
      setDragging(false);
      api.dcDragEnd();
      setTimeout(() => setExpression('neutral'), 260);
      return;
    }
    // 未越过门槛 = 单击：只有点在角色本体上才算「点角色」——
    // 点在气泡上只由气泡自身处理（文字区点击即收起），不触发跳转。
    if (d?.from === 'character') onCharacterClick();
  };

  // ===== 滚轮缩放（悬停在角色本体上时调节桌面角色大小；钳制 0.6~1.6，步长 0.05）=====
  const onCharacterWheel = (e: React.WheelEvent) => {
    const c = charRefState.current;
    if (!c) return;
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    const cur = c.scale ?? 1;
    // 四舍五入到两位小数，避免浮点累积误差（0.05 步长在二进制下不精确）
    const next = Math.max(0.6, Math.min(1.6, Math.round((cur + step) * 100) / 100));
    if (next === cur) return;
    // 本地先更新，保证缩放手感跟手；持久化交给主进程广播回写
    setState((s) => (s.character ? { ...s, character: { ...s.character, scale: next } } : s));
    api.dcSetScale(c.id, next);
  };

  const onCharacterClick = () => {
    // 角色本体是 div，不被 CLICK_SOUND_SELECTOR 命中，需手动补点击音
    playSoundSync('click');
    setExpression('happy');
    // v3.0.1-beta.9：点击只给表情 / 音效反馈，不触发模型请求、不显示文案气泡。
    setTimeout(() => setExpression('neutral'), 1400);
    const bound = charRefState.current?.boundChat;
    if (bound) {
      setTimeout(() => api.dcOpenChat(bound), 260);
    }
  };

  // ===== 右键菜单 =====
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(true);
    applyInteractive(true);
  };

  const menu = useMemo(() => {
    const bound = state.character?.boundChat || null;
    return [
      {
        key: 'lock',
        label: runtime.passThroughLocked ? t('characters.menuUnlockPass') : t('characters.menuLockPass'),
        checked: runtime.passThroughLocked,
        onClick: () => api.dcSetPassThroughLock(!runtime.passThroughLocked),
      },
      {
        key: 'aot',
        label: t('characters.menuOnTop'),
        checked: runtime.alwaysOnTop,
        onClick: () => api.dcSetAlwaysOnTop(!runtime.alwaysOnTop),
      },
      {
        key: 'chat',
        label: bound ? t('characters.menuBackTo', { name: bound.name }) : t('characters.menuBind'),
        onClick: () => {
          if (bound) api.dcOpenChat(bound);
          else api.dcOpenCollection();
        },
      },
      { key: 'stage', label: t('characters.menuStage'), onClick: () => api.dcOpenCollection() },
      { key: 'manage', label: t('characters.menuManage'), onClick: () => api.dcOpenCollection() },
      { key: 'hide', label: t('characters.menuHide'), onClick: () => api.dcHideWindow() },
    ];
  }, [runtime.passThroughLocked, runtime.alwaysOnTop, state.character?.boundChat, t]);

  // 角色未启用时不留可见内容（窗口本身会由主进程销毁，这里只是兜底）
  if (!state.character) {
    return <div className="dc-root" />;
  }

  return (
    <div className="dc-root">
      {bubble && (
        <div
          className="dc-bubble"
          onPointerDown={beginPointer}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
        >
          <span
            className="dc-bubble-text"
            onClick={(e) => {
              e.stopPropagation();
              setBubble(null);
            }}
          >
            {bubble}
          </span>
          <span className="dc-bubble-tail" aria-hidden="true" />
        </div>
      )}

      <div
        ref={charRef}
        className={`dc-character${dragging ? ' dragging' : ''}`}
        onPointerDown={beginPointer}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onCharacterWheel}
        onContextMenu={onContextMenu}
        title={state.character.name}
      >
        <div className="dc-stage" style={{ ['--dc-scale' as string]: String(scale) } as React.CSSProperties}>
          <ModelView
            character={state.character}
            expression={expression}
            blink={blink}
            dragging={dragging}
            eyeX={eye.x}
            eyeY={eye.y}
            onError={(m) => setModelError(m)}
          />
        </div>
        <div className="dc-name">{state.character.name}</div>
        {modelError && (
          <div className="dc-err" title={modelError}>
            {modelError === 'missing-cubism4'
              ? t('characters.errCubism4')
              : modelError === 'missing-cubism2'
                ? t('characters.errCubism2')
                : t('characters.errModel')}
          </div>
        )}
      </div>

      {menuOpen && (
        <div className="dc-menu" onPointerDown={(e) => e.stopPropagation()}>
          {menu.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`dc-menu-item${m.checked ? ' checked' : ''}`}
              onClick={() => {
                setMenuOpen(false);
                m.onClick();
              }}
            >
              <span className="dc-menu-check">{m.checked ? '✓' : ''}</span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CharacterApp;
