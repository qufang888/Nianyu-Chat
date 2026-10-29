// 桌面角色主界面（V3）
//
// 分层职责：
// - 命中/穿透路由：窗口默认整体穿透（主进程 setIgnoreMouseEvents(true,{forward:true})），
//   本组件在 pointermove 时用 elementFromPoint 判定光标是否落在 drag/interactive 命中区，
//   落在命中区 → 请求切可交互；离开 → 恢复穿透。透明区永远穿透，不产生「空气墙」。
// - 拖拽：只有角色命中箱 pointerdown 才算抓取；越 5px 门槛后通知主进程开始弹簧跟随
//   （主进程轮询设备光标 + K200/C30 + 1/120 子步），松手由主进程做惯性滑停。
// - 行为：呼吸/眨眼/视线跟随 + 加权随机动作 + 定时主动气泡 + 自主游走。
// - 右键菜单：穿透锁定 / 置顶人物 / 绑定跳转 / 舞台 / 隐藏 / 管理（配色走主题变量，全主题可读）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { CharacterRuntimeSettings, DesktopCharacter } from '../types';
import type { CharacterExpression } from './PlaceholderCharacter';
import { ModelView } from './ModelView';
import { CLICK_TEXTS, DRAG_TEXTS, IDLE_TEXTS, pickIdleAction, pickText } from './behaviors';
import { applyAnimControl, type AnimSettingsLike } from '../utils/animControl';

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

export const CharacterApp: React.FC = () => {
  const { t } = useI18n();
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
  const dragRef = useRef<{ started: boolean; sx: number; sy: number; gdx: number; gdy: number } | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const menuOpenRef = useRef(false);
  const charRefState = useRef<DesktopCharacter | null>(null);

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
          if (a.text) showBubble(a.text, 2600);
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

  // ===== 主动开口（本地定时，不依赖联网） =====
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        const c = charRefState.current;
        if (!draggingRef.current && !menuOpenRef.current && c?.behavior !== false && c?.bubble !== false) {
          showBubble(pickText(IDLE_TEXTS), 4200);
          setExpression('happy');
          setTimeout(() => setExpression((e) => (e === 'happy' ? 'neutral' : e)), 1800);
        }
        loop();
      }, 22000 + Math.random() * 30000);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [showBubble]);

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

  // 菜单打开时保持可交互；关闭后若光标不在命中区则恢复穿透
  useEffect(() => {
    if (menuOpen) applyInteractive(true);
  }, [menuOpen, applyInteractive]);

  // ===== 拖拽 =====
  const beginPointer = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (runtime.passThroughLocked) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      started: false,
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
    if (Math.random() < 0.6) showBubble(pickText(DRAG_TEXTS), 1600);
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
    // 未越过门槛 = 单击：先给角色反馈；若已绑定对话再跳转（未绑定左键不跳转）
    onCharacterClick();
  };

  const onCharacterClick = () => {
    setExpression('happy');
    showBubble(pickText(CLICK_TEXTS), 2000);
    setTimeout(() => setExpression('neutral'), 1400);
    const bound = charRefState.current?.boundChat;
    if (bound) {
      setTimeout(() => api.dcOpenChat(bound), 260);
    }
  };

  // ===== 视线跟随 =====
  const onMouseMoveEye = (e: React.MouseEvent) => {
    const el = charRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    setEye({
      x: Math.max(-1, Math.min(1, (e.clientX - cx) / 170)),
      y: Math.max(-1, Math.min(1, (e.clientY - cy) / 170)),
    });
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
    <div className="dc-root" onMouseMove={onMouseMoveEye}>
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
