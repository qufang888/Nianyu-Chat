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
import type { AppSettings, CharacterRuntimeSettings, DesktopCharacter } from '../types';
import type { CharacterExpression } from './PlaceholderCharacter';
import { ModelView } from './ModelView';
import { pickIdleAction } from './behaviors';
import { applyAnimControl, getGroupAnimSpeed, type AnimSettingsLike } from '../utils/animControl';
import { playSoundSync } from '../utils/sound';
// v3.0.3：频率派生的唯一真源（与主进程共用同一份 ⇒ 护栏与调度不可能漂移）。
import { deriveLineScheduleForCharacter, type LineSchedule } from '../utils/lineSchedule';
// v3.0.3：气泡停留时长 / 动画时长的唯一真源（角色窗与设置页共用同一份 ⇒ 示例与实测一致）。
import { bubbleHoldMs, readCharacterAnimParams } from '../utils/bubbleTiming';

interface DcState {
  runtime: CharacterRuntimeSettings;
  character: DesktopCharacter | null;
}

/**
 * 历史数据 boundChat.name 可能为空串/缺失（甚至字面量 "undefined"），
 * 会让右键菜单渲染成「回到「」」/「回到「undefined」」。写入 state 前统一用 chat id 兜底。
 */
function normalizeBoundChat(ch: DesktopCharacter | null | undefined): DesktopCharacter | null {
  if (!ch) return null;
  const b = ch.boundChat;
  if (b && typeof b === 'object' && (!b.name || b.name === 'undefined')) {
    return { ...ch, boundChat: { ...b, name: b.id } };
  }
  return ch;
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

// ===== 桌宠互动语句生成参数（v3.0.1-beta.9；v3.0.3 频率改为按设置派生）=====
// 这些值只控制「触发节奏 / 展示形态」，不参与任何文案内容；文案一律由模型输出。
// v3.0.3：原先的「试探周期 15s / 最小间隔 45s」两个硬编码常量已删除，
// 改由 deriveLineSchedule(speakRate) 统一派生（见 src/utils/lineSchedule.ts）。
/** 单次生成请求的软超时（毫秒）：超时后静默放弃并释放并发锁，不显示任何气泡。 */
const CHARACTER_LINE_TIMEOUT_MS = 20_000;
/** 气泡展示的最大字符数：仅裁剪展示文本，写入绑定对话的仍是模型原文。 */
const CHARACTER_BUBBLE_MAX_CHARS = 80;
/** applyAnimControl 在 all-off/自定义档写到 documentElement 上的分组黑名单属性名。 */
const ANIM_OFF_ATTR = 'data-anim-off';

/**
 * 菜单收回动画的 JS 侧等待时长（毫秒）—— 与 CSS 端严格同源。
 *
 * 同源要点（三处必须一致，缺一即出现「闪一下消失 / 卡住不消失」）：
 *   CSS:  animation: dcMenuOut calc(var(--dc-menu-anim, 0.20s) * var(--anim-speed, 1)) linear forwards
 *   JS :  menuSec * 1000 * getGroupAnimSpeed(settings, 'character')
 *   变量: --dc-menu-anim 由本窗写入 = readCharacterAnimParams(settings).menuSec
 *
 * ⚠️ 倍率必须取 **character 分组倍率**（getGroupAnimSpeed），不能用 readAnimSpeed(document)：
 *    后者读的是 documentElement 上的全局倍率，而自定义档下 CSS 实际生效的是分组倍率，
 *    两者不一致 ⇒ 速度调快/调慢时菜单动画会与卸载计时错位。
 */
function menuAnimMs(s: AppSettings | null): number {
  const base = readCharacterAnimParams(s).menuSec;
  return Math.round(base * 1000 * getGroupAnimSpeed(s, 'character'));
}

/**
 * 气泡收回动画的 JS 侧等待时长（毫秒）—— 与 CSS 端 --dc-bubble-anim × --anim-speed 同源。
 * 换算口径与 menuAnimMs 完全一致（同一个分组倍率、同一个钳制后的参数）。
 */
function bubbleAnimMs(s: AppSettings | null): number {
  const base = readCharacterAnimParams(s).bubbleSec;
  return Math.round(base * 1000 * getGroupAnimSpeed(s, 'character'));
}

/**
 * 只裁剪「气泡展示」文本；写入绑定对话的仍是模型原文，不做任何改写。
 * 合并空白、去掉模型偶尔包裹的成对引号、超长截断，避免气泡被撑出角色窗。
 */
function sanitizeBubbleText(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'「『“‘]+|["'」』”’]+$/g, '').trim();
  // 按码点截断，避免 UTF-16 slice 把 emoji 代理对切成半个乱码。
  const cps = [...s];
  if (cps.length > CHARACTER_BUBBLE_MAX_CHARS) {
    s = `${cps.slice(0, CHARACTER_BUBBLE_MAX_CHARS).join('')}…`;
  }
  return s;
}

export const CharacterApp: React.FC = () => {
  const { t } = useI18n();
  // 多窗口（v3.0.1-beta.13）：每个角色窗由 ?id=<角色id> 独立打开，本窗只负责自己的角色；
  // 面板（无 id）仍走无参 dcGetState 拿 active 用于高亮。
  const charId = new URLSearchParams(location.search).get('id') || '';

  // v3.0.1-beta.4：角色气泡文案原先是中文原文（src/character/behaviors.ts 现只存 i18n 键），
  // 导致非中文界面下角色仍说中文 → 统一用 t() 解析，台词随界面语言切换。
  const [state, setState] = useState<DcState>({ runtime: DEFAULT_RUNTIME, character: null });
  const [expression, setExpression] = useState<CharacterExpression>('neutral');
  const [blink, setBlink] = useState(false);
  const [eye, setEye] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  /** 气泡正在播放收回动画：此时仍挂载 .dc-bubble.closing，动画结束才卸载。 */
  const [bubbleClosing, setBubbleClosing] = useState(false);
  /** 气泡序号：每次新气泡自增，作为 React key ⇒ DOM 重挂 ⇒ 弹入动画必定重播（不闪烁）。 */
  const [bubbleSeq, setBubbleSeq] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 菜单正在播放收回动画：此时仍挂载 .dc-menu.closing，动画结束/动画被关后立刻卸载。 */
  const [menuClosing, setMenuClosing] = useState(false);
  const [modelError, setModelError] = useState<string>('');

  const charRef = useRef<HTMLDivElement | null>(null);
  const interactiveRef = useRef(false);
  // from：这次按下发生在角色本体还是气泡上。只有角色本体的「点一下」才等于点角色
  //（气泡是中性可拖拽区，点气泡不该顺手跳转绑定的对话）。
  const dragRef = useRef<{ started: boolean; from: 'character' | 'bubble'; sx: number; sy: number; gdx: number; gdy: number } | null>(null);
  /** 气泡停留计时器：到点后进入「收回动画」阶段。 */
  const bubbleHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 气泡收回动画计时器：到点后真正卸载气泡 DOM。 */
  const bubbleOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 角色窗最新 settings 快照：动画时长/停留参数的读取源（改设置后立即生效）。 */
  const settingsRef = useRef<AppSettings | null>(null);
  /**
   * 舞台缩放预览的临时缩放值（未落盘）。
   * 预览值优先于 dc:state 带来的持久化值，避免拖动途中被别的 dc:state 推送"跳回"旧尺寸；
   * 舞台提交（dc:set-scale）后，落盘值与预览值一致 ⇒ 预览自动结束。
   */
  const previewScaleRef = useRef<number | null>(null);
  /** 预览兜底过期计时器：舞台异常关闭（未提交）时，预览值不能永久留在桌宠上。 */
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const menuOpenRef = useRef(false);
  const menuClosingRef = useRef(false);
  const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 菜单项动作的延迟执行计时器（v3.0.3）。
   * 点菜单项时先播完收回动画再执行该项业务动作，让用户「看得到收回」——
   * 否则收回动画会被业务动作（打开窗口 / 隐藏角色）瞬间盖过，表现为「菜单啪地消失」。
   */
  const menuActionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  /** 角色数据是否已加载（用于调度器的依赖：避免用对象身份做依赖导致每次 dc:state 都重置定时器）。 */
  const hasCharacter = !!state.character;

  /**
   * 角色窗当前是否处于「动画被关掉」状态。
   *
   * 两种情况都会让 CSS 动画不播：
   *   ① 全关档（html.anim-off）；
   *   ② 自定义档且 character 分组被关（html[data-anim-off~="character"]）。
   * 这时 JS 侧必须**立即卸载**元素，不能等动画时长 —— 否则动画不播 ⇒ 元素永远等在
   * 「收回态」上，表现为菜单/气泡「关不掉」。
   */
  const isAnimOff = useCallback((): boolean => {
    const root = document.documentElement;
    return (
      root.classList.contains('anim-off') ||
      (root.getAttribute(ANIM_OFF_ATTR) || '').split(' ').includes('character')
    );
  }, []);

  /**
   * 显示一条气泡（四阶段状态机）：
   *   显示 → 按字数计算的停留 → 收回动画 → 卸载。
   *
   * - 停留时长由 bubbleHoldMs(text, params) 按**展示文本的码点数**算出
   *   （与设置页的换算示例同一个函数 ⇒ 示例与实测必然一致）；
   * - 新气泡到来时会清掉旧的两个计时器 + 重置 closing + 自增 seq（key 变化 ⇒ DOM 重挂），
   *   于是旧气泡立即退场、新气泡立即弹入，不会被旧气泡的收回动画吞掉；
   * - 动画被关掉时直接卸载（功能完整，只是没有动画）。
   */
  const showBubble = useCallback(
    (text: string) => {
      if (charRefState.current && charRefState.current.bubble === false) return;
      const params = readCharacterAnimParams(settingsRef.current);
      const holdMs = bubbleHoldMs(text, {
        baseSec: params.holdBaseSec,
        stepSec: params.holdStepSec,
        maxSec: params.holdMaxSec,
      });
      // 清掉旧的停留/收回计时器：新气泡立即接管，绝不被旧气泡的收回动画吞掉。
      if (bubbleHoldTimer.current) {
        clearTimeout(bubbleHoldTimer.current);
        bubbleHoldTimer.current = null;
      }
      if (bubbleOutTimer.current) {
        clearTimeout(bubbleOutTimer.current);
        bubbleOutTimer.current = null;
      }
      setBubbleClosing(false);
      setBubbleSeq((n) => n + 1);
      setBubble(text);
      bubbleHoldTimer.current = setTimeout(() => {
        bubbleHoldTimer.current = null;
        // 停留到期 → 进入收回动画阶段
        if (isAnimOff()) {
          setBubble(null);
          return;
        }
        setBubbleClosing(true);
        bubbleOutTimer.current = setTimeout(() => {
          bubbleOutTimer.current = null;
          setBubble(null);
          setBubbleClosing(false);
        }, bubbleAnimMs(settingsRef.current));
      }, holdMs);
    },
    [isAnimOff]
  );

  /**
   * 主动关闭气泡（点气泡文字）：与「停留到期」走同一条收回动画路径，
   * 而不是瞬间消失（v3.0.3 R5-AC6）。
   */
  const closeBubble = useCallback(() => {
    if (bubbleHoldTimer.current) {
      clearTimeout(bubbleHoldTimer.current);
      bubbleHoldTimer.current = null;
    }
    if (bubbleOutTimer.current) {
      clearTimeout(bubbleOutTimer.current);
      bubbleOutTimer.current = null;
    }
    if (isAnimOff()) {
      setBubble(null);
      setBubbleClosing(false);
      return;
    }
    setBubbleClosing(true);
    bubbleOutTimer.current = setTimeout(() => {
      bubbleOutTimer.current = null;
      setBubble(null);
      setBubbleClosing(false);
    }, bubbleAnimMs(settingsRef.current));
  }, [isAnimOff]);

  /**
   * 向绑定对话请求一句由模型按该对话人物人设生成的互动语句。
   * 复用 api.proactive（→ chats:proactive → handleProactive）：主进程会把原句以
   * from_proactive 消息写入绑定对话，并把内容通过返回值回传给桌宠气泡。
   * 失败 / 超时 / 无内容一律静默降级，绝不使用固定文案兜底。
   *
   * @param bound 目标对话
   * @param sch 该角色当前的调度方案（intervalMs 由 speakRate 派生，与主进程护栏同源）
   */
  const requestCharacterLine = useCallback(
    async (bound: { type: 'single' | 'group'; id: string }, sch: LineSchedule) => {
      const now = Date.now();
      // 并发锁 + 最小间隔：重复触发 / 多定时器叠加 / 窗口重建都不会造成 QPS 风暴。
      if (lineInFlightRef.current) return;
      if (now - lineLastAtRef.current < sch.intervalMs) return;
      lineInFlightRef.current = true;
      lineLastAtRef.current = now;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        // 软超时：模型长时间无响应不会把后续语句永久堵死；到点静默放弃本次结果。
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CHARACTER_LINE_TIMEOUT_MS);
        });
        const res = await Promise.race([
          // 带上派生好的最小间隔：主进程护栏据此兜底，避免固定 30s 把高频率压死。
          api.proactive({
            chatType: bound.type,
            chatId: bound.id,
            source: 'character',
            targetIntervalMs: sch.intervalMs,
          }),
          timeout,
        ]);
        if (!res || !res.ok) return;
        const text = sanitizeBubbleText(res.content || '');
        if (!text) return;
        showBubble(text);
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
    api.dcGetState(charId).then((s) => {
      if (!alive) return;
      // 角色窗走 id 拿自身角色；面板（无 id）回退到 active 用于高亮
      setState({ runtime: s.runtime || DEFAULT_RUNTIME, character: normalizeBoundChat(s.character || s.active) });
    });
    const off = api.onDcState((d) => {
      // 舞台预览期间的缩放值是**未落盘的临时值**：若此时有别的 dc:state 推送（改频率、
      // 拖拽结束等都会推），不能让它把预览值冲掉，否则桌宠会在拖动过程中"跳回"旧尺寸。
      // 故预览值单独记在 previewScaleRef 里，优先于 dc:state 的持久化值。
      const c = normalizeBoundChat(d.character);
      const pv = previewScaleRef.current;
      if (c && pv !== null && typeof c.scale === 'number' && Math.abs(c.scale - pv) < 1e-6) {
        // 落盘值与预览值一致 ⇒ 舞台的提交已生效，预览结束，恢复以持久化值为准。
        previewScaleRef.current = null;
        if (previewTimerRef.current) {
          clearTimeout(previewTimerRef.current);
          previewTimerRef.current = null;
        }
      }
      setState({
        runtime: d.runtime || DEFAULT_RUNTIME,
        character: c && pv !== null ? { ...c, scale: pv } : c,
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // ===== v3.0.3：舞台缩放预览 =====
  // 舞台拖动「模型大小」滑块时，主进程把中间值推过来，让本窗的 --dc-scale 立即跟随。
  // 这里**只更新本地状态**，不落盘、不广播：落盘由舞台在手势结束时统一走 dc:set-scale 一次。
  useEffect(() => {
    if (typeof api.onDcScalePreview !== 'function') return;
    const off = api.onDcScalePreview((d) => {
      if (!d || d.id !== charId) return;
      previewScaleRef.current = d.scale;
      // 兜底过期：舞台异常关闭（没走到提交）时，预览值最多保留 3 秒，之后拉回持久化值。
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        if (previewScaleRef.current !== d.scale) return; // 已被提交/新预览取代
        previewScaleRef.current = null;
        api.dcGetState(charId).then((s) => {
          const c = normalizeBoundChat(s?.character || s?.active);
          if (c) setState((st) => ({ ...st, character: c }));
        });
      }, 3000);
      setState((s) => (s.character ? { ...s, character: { ...s.character, scale: d.scale } } : s));
    });
    return off;
  }, [charId]);

  // ===== 绑定对话来了新消息 → 实时弹到桌宠头顶气泡 =====
  // 主进程在 DataManager.addMessage（所有新消息的唯一落库入口）挂钩，按本角色 boundChat
  // 匹配后定向推到该角色窗（electron/desktopCharacter.ts 的 pushChatMessageToCharacters）。
  // 主进程已过滤 proactive 自造句（from_proactive），故此处不会与主动消息气泡重复弹。
  useEffect(() => {
    if (typeof api.onDcChatMessage !== 'function') return;
    const off = api.onDcChatMessage((d) => {
      const text = sanitizeBubbleText(d?.content || '');
      if (!text) return;
      // 拖拽中 / 菜单打开时不弹气泡，避免打断操作与遮挡菜单
      if (draggingRef.current || menuOpenRef.current) return;
      showBubble(text);
      setExpression('happy');
      setTimeout(() => setExpression((e) => (e === 'happy' ? 'neutral' : e)), 1800);
    });
    return off;
  }, [showBubble]);

  // ===== 动效总开关（角色窗是独立 document，走统一的 applyAnimControl('character')）=====
  // 角色窗不加载 index.css，所以「全关档」的全局 kill 规则不存在于本文档；
  // applyAnimControl 会按 kind='character' 注入本窗自己的门禁样式（含 character 分组的独立开关）。
  useEffect(() => {
    const apply = (s: AnimSettingsLike | null) => {
      // 记住最新设置：菜单/气泡的 JS 侧卸载计时与 CSS 变量都从这里取，
      // 保证「改设置后下一次开合菜单/弹气泡立即生效」。
      settingsRef.current = s as AppSettings | null;
      applyAnimControl(document, s, 'character');
      // 把桌宠动画的基准时长写进 CSS 变量（写在角色窗 documentElement 上）。
      // CSS 侧一律写成 calc(var(--dc-*-anim, 默认) * var(--anim-speed, 1))，
      // 这样「基准秒数」只有一个真值（设置），CSS 与 JS 都从它派生。
      const p = readCharacterAnimParams(s as AppSettings | null);
      const root = document.documentElement;
      root.style.setProperty('--dc-menu-anim', `${p.menuSec}s`);
      root.style.setProperty('--dc-bubble-anim', `${p.bubbleSec}s`);
    };
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

  // ===== 桌宠互动语句（绑定对话后由模型生成，v3.0.1-beta.9；v3.0.3 频率可调）=====
  // 固定句子池已全部移除：未绑定对话时完全不生成语句、也不显示任何文案气泡；
  // 绑定后按该对话人物的人设，复用主动消息链路 api.proactive 生成，原句同时
  // 作为 from_proactive 消息写入绑定对话（在该对话的消息列表里可以看到）。
  // 点击 / 拖拽不触发模型请求：它们是高频即时反馈，模型有秒级延迟且会放大 QPS，
  // 只保留表情 / 动作 / 音效等非语言反馈，不显示任何文案气泡。
  //
  // v3.0.3：频率由角色设置 speakRate（条/分钟）派生，调度器改为**自续期 setTimeout**：
  //   - 每次到期后按**当前**频率重新算出下一轮 tick ⇒ 改频率后无需重启即可生效；
  //   - speakRate = 0 ⇒ 整个调度器不启动（连定时器都不创建）⇒ 零请求 / 零气泡 / 零写库；
  //   - tick 只负责「到点检查」，是否真的发起由「距上次发起 ≥ intervalMs」判定；
  //   - 拖拽中 / 菜单打开 / 未绑定 等跳过情形**不更新** lineLastAtRef ⇒ 不重排后续节奏。
  useEffect(() => {
    // 角色尚未加载（首帧 state.character 为 null）时不启动调度器 ——
    // 否则会在「用户已把频率设为 0」与「角色数据还没到」之间短暂地跑起一个默认频率的定时器。
    const c = state.character;
    if (!c) return;
    const sch = deriveLineScheduleForCharacter(c);
    // 频率为 0：完全不主动说话 —— 连调度定时器都不创建（PRD R3-AC16）。
    if (!sch.enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        const cur = charRefState.current;
        const bound = cur?.boundChat;
        // 未绑定 / 关闭自主行为 / 关闭气泡 / 拖拽中 / 菜单打开 → 不发起任何模型请求。
        // 注意：这些跳过情形**不**更新 lineLastAtRef ⇒ 不重排后续节奏（R3-AC11）。
        if (bound?.id && cur?.behavior !== false && cur?.bubble !== false && !draggingRef.current && !menuOpenRef.current) {
          void requestCharacterLine(bound, sch);
        }
        // 自续期：按当前频率重算下一轮间隔（改频率后即时生效，无需重启）。
        schedule();
      }, sch.tickMs);
    };
    schedule();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // 依赖 speakRate（频率）与「角色是否已加载」两个**标量**：
    // 用 state.character 对象本身做依赖会让每次 dc:state 推送都重置定时器。
  }, [requestCharacterLine, state.character?.speakRate, hasCharacter]);

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

  /**
   * 统一收尾：右键菜单弹出/收回都要走这里，保证 outside-pointerdown、Escape、菜单项点击
   * 三条路径行为一致。播放 dcMenuOut 后延迟卸载；若动画被三档开关关掉则立刻卸载，
   * 不依赖 animationend（animation:none 时该事件不会触发，菜单会卡住不消失）。
   *
   * 卸载等待时长与 CSS 端同源（menuAnimMs）：基准秒数来自设置，
   * 倍率取 character 分组倍率 ⇒ 速度调快/调慢时两侧始终一致。
   */
  const closeMenu = useCallback(() => {
    if (!menuOpenRef.current || menuClosingRef.current) return;
    if (isAnimOff()) {
      setMenuOpen(false);
      setMenuClosing(false);
      menuClosingRef.current = false;
      return;
    }
    menuClosingRef.current = true;
    setMenuClosing(true);
    if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = setTimeout(() => {
      setMenuOpen(false);
      setMenuClosing(false);
      menuClosingRef.current = false;
      menuCloseTimer.current = null;
    }, menuAnimMs(settingsRef.current));
  }, [isAnimOff]);

  /** 打开菜单：取消可能还在排队的收回定时器，避免刚点开就被上一次关闭的 timer 卸载。 */
  const openMenu = useCallback(() => {
    if (menuCloseTimer.current) {
      clearTimeout(menuCloseTimer.current);
      menuCloseTimer.current = null;
    }
    // 同样要取消「上一轮菜单项动作」的延迟执行：否则快速「点菜单项 → 重新右键」时，
    // 上一次的菜单动作会在新菜单打开后才执行（表现为点 A 却执行了 B）。
    if (menuActionTimer.current) {
      clearTimeout(menuActionTimer.current);
      menuActionTimer.current = null;
    }
    menuClosingRef.current = false;
    setMenuClosing(false);
    setMenuOpen(true);
    applyInteractive(true);
  }, [applyInteractive]);

  // 组件卸载时清掉收回定时器与菜单项动作定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current);
      if (menuActionTimer.current) clearTimeout(menuActionTimer.current);
      if (bubbleHoldTimer.current) clearTimeout(bubbleHoldTimer.current);
      if (bubbleOutTimer.current) clearTimeout(bubbleOutTimer.current);
    },
    []
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // 穿透锁定/拖拽期间不改路由（拖拽由主进程锁定可交互）
      if (runtime.passThroughLocked || draggingRef.current) return;
      // Bug 1：右键菜单打开期间，光标从角色移向菜单项途中会掠过「透明缝隙」（不在 HIT_SELECTOR 内）。
      // 旧逻辑此处 applyInteractive(false)+setMenuOpen(false)：窗口一旦变穿透就再也收不到 mousemove，
      // 菜单被卸载，菜单项 onClick 根本不触发（=「绑定/舞台/管理点了没反应」）。
      // 修正：菜单打开时整窗保持可交互、不关闭菜单；关闭只走下方显式 outside-pointerdown / Escape。
      if (menuOpenRef.current) {
        applyInteractive(true);
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const hit = !!el?.closest(HIT_SELECTOR);
      applyInteractive(hit);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [applyInteractive, runtime.passThroughLocked]);

  // Bug 1：菜单关闭只走显式路径——点击菜单外部 / Escape，不再由 mousemove 误判关闭。
  // 捕获期监听保证即使菜单项阻止冒泡也能先判断目标是否在 .dc-menu 内；菜单内部点击交给按钮 onClick。
  useEffect(() => {
    if (!menuOpen) return;
    const onOutsideDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dc-menu')) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('pointerdown', onOutsideDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutsideDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, closeMenu]);

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
    // Bug 3：capture 设在稳定的监听元素（currentTarget）而非e.target。窗口随光标快速移动时，
    // e.target（子元素/文本节点）可能被重建或不再是命中元素，导致 pointerup/cancel 丢失。
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
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
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
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

  // Bug 3：window 级兜底——pointerup/pointercancel/blur 任一发生都确保「一次拖动必定且仅一次」
  // 发出 dc:drag-end。窗口随光标快速移动时元素级 pointer capture 可能丢失、pointerup 收不到，
  // 导致主进程 st.dragging 恒 true、窗口永久跟随光标。元素级 onPointerUp 先于本监听触发
  // （React 事件挂在根节点，冒泡到 window 之前已把 dragRef 清空），故不会重复发送；
  // 主进程 handler 也有 if(!st.dragging) return 幂等保护，双保险。
  useEffect(() => {
    const forceEnd = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (d.started) {
        setDragging(false);
        api.dcDragEnd();
        setTimeout(() => setExpression('neutral'), 260);
      }
      // 未越过门槛的「单击」语义交给元素级 endPointer，此处不重复触发 onCharacterClick。
    };
    window.addEventListener('pointerup', forceEnd);
    window.addEventListener('pointercancel', forceEnd);
    window.addEventListener('blur', forceEnd);
    return () => {
      window.removeEventListener('pointerup', forceEnd);
      window.removeEventListener('pointercancel', forceEnd);
      window.removeEventListener('blur', forceEnd);
    };
  }, []);

  // ===== 滚轮缩放（悬停在角色本体上时调节桌面角色大小；钳制 0.6~1.6，步长 0.05）=====
  // 触发链：窗口默认整体穿透 → 光标进入角色命中区时主进程转发的 mousemove 命中
  // .dc-character → applyInteractive(true) 把窗口切可交互 → 滚轮事件才会到 DOM。
  // 穿透锁定（passThroughLocked）时窗口恒穿透，滚轮本就不该被捕获，属预期行为。
  const onCharacterWheel = (e: React.WheelEvent) => {
    const c = charRefState.current;
    if (!c || runtime.passThroughLocked) return;
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    const cur = c.scale ?? 1;
    // 四舍五入到两位小数，避免浮点累积误差（0.05 步长在二进制下不精确）
    const next = Math.max(0.6, Math.min(1.6, Math.round((cur + step) * 100) / 100));
    if (next === cur) return;
    // 本地先更新，保证缩放手感跟手；持久化交给主进程广播回写。
    // 注意 --dc-scale 必须写在 .dc-character 自身：CSS 自定义属性只向下继承，
    // 写在子元素 .dc-stage 上不会改变父元素的 transform（这正是「滚轮无反应」的根因）。
    setState((s) => (s.character ? { ...s, character: { ...s.character, scale: next } } : s));
    api.dcSetScale(c.id, next);
  };

  // React 17+ 的 onWheel 挂的是 passive 监听器，里面 preventDefault() 会被忽略并告警。
  // 这里用原生 passive:false 监听只负责阻止默认滚动；缩放仍由上面唯一的 onWheel 处理，
  // 避免两套逻辑重复放大。body 已是 overflow:hidden，此举只是双保险。
  useEffect(() => {
    const el = charRef.current;
    if (!el || !state.character) return;
    const preventScroll = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', preventScroll, { passive: false });
    return () => el.removeEventListener('wheel', preventScroll);
  }, [state.character?.id]);

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
    openMenu();
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
        label: bound ? t('characters.menuBackTo', { name: bound.name || bound.id }) : t('characters.menuBind'),
        onClick: () => {
          if (bound) api.dcOpenChat(bound);
          else api.dcOpenCollection();
        },
      },
      // Bug 1「打开角色舞台」：带 id 唤起主窗并直接进入该角色的 CharacterStage，
      // 不再只 dcOpenCollection 停在列表页（面板无跨窗舞台机制，故新增 dc:open-stage 通道）。
      { key: 'stage', label: t('characters.menuStage'), onClick: () => api.dcOpenStage(state.character?.id || charId) },
      { key: 'manage', label: t('characters.menuManage'), onClick: () => api.dcOpenCollection() },
      { key: 'hide', label: t('characters.menuHide'), onClick: () => api.dcHideCharacter(charId) },
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
          // key 随 bubbleSeq 变化 ⇒ 每次新气泡都是全新 DOM 节点 ⇒ 弹入动画必定重播，
          // 不会出现「旧气泡的收回动画还没结束，新气泡就被吞掉」。
          key={bubbleSeq}
          className={`dc-bubble${bubbleClosing ? ' closing' : ''}`}
          onPointerDown={beginPointer}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
        >
          <span
            className="dc-bubble-text"
            onClick={(e) => {
              e.stopPropagation();
              // 点文字关闭也走收回动画（不是瞬间消失）
              closeBubble();
            }}
          >
            {bubble}
          </span>
          <span className="dc-bubble-tail" aria-hidden="true" />
        </div>
      )}

      {/* 缩放变量必须落在 .dc-character 自身（其 transform 才消费它），不能写在 .dc-stage 上 */}
      <div
        ref={charRef}
        className={`dc-character${dragging ? ' dragging' : ''}`}
        style={{ ['--dc-scale' as string]: String(scale) } as React.CSSProperties}
        onPointerDown={beginPointer}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onCharacterWheel}
        onContextMenu={onContextMenu}
        title={state.character.name}
      >
        <div className="dc-stage">
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
        <div
          className={`dc-menu${menuClosing ? ' closing' : ''}`}
          onPointerDown={(e) => {
            // 收回期间不再吃指针事件，也不再阻止外部关闭判定
            if (!menuClosing) e.stopPropagation();
          }}
        >
          {menu.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`dc-menu-item${m.checked ? ' checked' : ''}`}
              onClick={() => {
                // v3.0.3：先播完收回动画，再执行该项业务动作 ——
                // 否则业务动作（打开舞台 / 隐藏角色）会瞬间把收回动画盖过，用户看不到收回。
                closeMenu();
                if (menuActionTimer.current) clearTimeout(menuActionTimer.current);
                const delay = isAnimOff() ? 0 : menuAnimMs(settingsRef.current);
                menuActionTimer.current = setTimeout(() => {
                  menuActionTimer.current = null;
                  m.onClick();
                }, delay);
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
