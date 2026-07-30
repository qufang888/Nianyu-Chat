import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { ChatListItem, ChatMessage, ChatType, Role, SelfRole, WorldBook } from '../types';
import { renderMarkdown } from '../utils/markdown';
import { AvatarImg } from './ChatList';
import { GroupEditor } from './GroupEditor';
import { useToast, ToastView } from './Toast';
import { ReasoningBlock } from './ReasoningBlock';
import RandomEventModal, { RandomEventData } from './RandomEventModal';
import PendingImageThumb from './PendingImageThumb';
import ImageGrid from './ImageGrid';
import { ImageCropper } from './ImageCropper';
import SelectMenu from './SelectMenu';
import { previewSound, playSoundSync } from '../utils/sound';
import { EVENT_COOLDOWN_MS, EVENT_TRIGGER_THRESHOLD } from '../eventThemes';
import { getEventStore, setEventStore } from '../utils/eventStore';
import { getIdleActivity, setIdleActivity } from '../utils/idleTimerStore';
import CustomScrollArea from './CustomScrollArea';
import { ClearChatModal } from './ClearChatModal';

export const ChatWindow: React.FC<{
  chatType: string;
  chatId: string;
  name: string;
  members: Role[]; // 群聊成员（用于 @ 提及）
  onSent: () => void;
  onChatDeleted?: (chatId: string) => void;
  onConvertedToSingle?: (roleId: string) => void;
  onGroupUpdated?: () => void;
}> = ({ chatType, chatId, name, members, onSent, onChatDeleted, onConvertedToSingle, onGroupUpdated }) => {
  const { t, lang } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [affinityPop, setAffinityPop] = useState<string | null>(null);
  const [showMention, setShowMention] = useState(false);
  const [globalTokens, setGlobalTokens] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [modelMap, setModelMap] = useState<Record<string, string>>({});
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  const [enableStreaming, setEnableStreaming] = useState(false);
  const autoMemoryRef = useRef(false);
  const [hideReasoning, setHideReasoning] = useState(true);
  // 随机事件
  const chatKey = `${chatType}:${chatId}`;
  const [eventState, setEventState] = useState<RandomEventData | null>(() => {
    const saved = getEventStore(chatKey);
    // 清理失效的 loading 状态：只有 loading 没有 event → 视为无事件
    if (saved.loading && !saved.event) {
      setEventStore(chatKey, { event: null, loading: false });
      return null;
    }
    return saved.event;
  });
  const [eventLoading, setEventLoading] = useState(false);
  const eventStateRef = useRef(eventState);
  const eventLoadingRef = useRef(eventLoading);
  eventStateRef.current = eventState;
  eventLoadingRef.current = eventLoading;
  // 事件状态持久化：更新时同步 + 卸载时保存
  useEffect(() => {
    setEventStore(chatKey, { event: eventState, loading: eventLoading });
  }, [chatKey, eventState, eventLoading]);
  useEffect(() => {
    return () => {
      setEventStore(chatKey, { event: eventStateRef.current, loading: eventLoadingRef.current });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [enableRandomEvents, setEnableRandomEvents] = useState(true);
  // 用 ref 持有最新开关值，避免流式回调 onDone 闭包捕获旧值导致「关闭后仍然弹出」
  const enableRandomEventsRef = useRef(true);
  enableRandomEventsRef.current = enableRandomEvents;
  const [roleMood, setRoleMood] = useState(''); // 当前角色心情徽标（单聊）
  const lastEventRef = useRef(0);
  // 空闲主动回复：默认开启；idleSeconds 为静默多久后角色主动开口
  const [idleReplyOn, setIdleReplyOn] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePos, setMorePos] = useState({ right: 0, top: 0 });
  const [groupAutoChain, setGroupAutoChain] = useState(false);
  const [idleCountdown, setIdleCountdown] = useState(0); // 主动消息触发倒计时（秒）
  const idleSwitchActionRef = useRef<'pause' | 'reset' | 'continue'>('pause'); // 切换聊天时的计时模式

// 随机事件快捷主题见 ../eventThemes（主窗/小窗共用）
  const [chatBg, setChatBg] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 刷新 UI 计数器：自增可强制重建输入框并重新聚焦，作为「输入框无法输入」的应急恢复手段
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [streamingMsgs, setStreamingMsgs] = useState<Record<string, ChatMessage>>({});
  // 角色/成员删除后的状态提示
  const [roleMissing, setRoleMissing] = useState(false); // 单聊：角色已删除
  const [membersMissing, setMembersMissing] = useState(0); // 群聊：已删除成员数
  const [convertPrompt, setConvertPrompt] = useState(false); // 群聊仅剩 1 人 → 转单聊提示
  const [showGroupEditor, setShowGroupEditor] = useState(false);
  // ===== 观察者模式（对局） =====
  const [observerMode, setObserverMode] = useState(false);
  const observerModeRef = useRef(false);
  const [observerConfig, setObserverConfig] = useState({
    freezeMemory: false,
    publicWriteMemory: true,
    observerNoEmotion: true,
    privateWriteMemory: false,
    privateAffectsEmotion: false,
  });
  const [showObserverPanel, setShowObserverPanel] = useState(false);
  const [showObserverConfig, setShowObserverConfig] = useState(false);
  const [showPrivateMenu, setShowPrivateMenu] = useState(false);
  const [configAnchor, setConfigAnchor] = useState<DOMRect | null>(null);
  const [privateAnchor, setPrivateAnchor] = useState<DOMRect | null>(null);
  const [observerMembers, setObserverMembers] = useState<Role[]>([]);
  // 群聊内各角色当前心情（头像旁小字显示）
  const [groupMoods, setGroupMoods] = useState<Record<string, string>>({});
  // 消息操作：转发/修改
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [editMsg, setEditMsg] = useState<ChatMessage | null>(null);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [forwardChats, setForwardChats] = useState<ChatListItem[]>([]);
  // 聊天背景裁剪
  const [bgCrop, setBgCrop] = useState<{ open: boolean; src: string }>({ open: false, src: '' });
  // 自我身份（用户自己的角色卡）：用于本对话的身份覆盖
  const [selfRoles, setSelfRoles] = useState<SelfRole[]>([]);
  const [defaultSelfId, setDefaultSelfId] = useState('');
  const [selfRoleId, setSelfRoleId] = useState('default');
  // 当前生效的自我身份（用户自己的角色卡）
  const activeSelfRole = selfRoleId !== 'none' && selfRoleId !== 'default'
    ? selfRoles.find((r) => r.id === selfRoleId)
    : (defaultSelfId ? selfRoles.find((r) => r.id === defaultSelfId) : undefined);
  const userAvatarPath = activeSelfRole?.avatar_path;

  // 本对话的世界书选择（''=继承全局/角色默认；'none'=不使用；其它=具体世界书ID）
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [chatWorldBookId, setChatWorldBookId] = useState('');
  // 轻提示（自动出现又自动缩回，无需手动关闭）
  const { toast, showToast } = useToast();
  const openMini = async () => {
    try {
      await api.miniOpen();
      showToast(t('chat.miniOpened'));
    } catch (e) {
      showToast(t('chat.miniOpenFail'));
    }
  };

  // ===== 群成员编辑：单窗口锁 =====
  // 点击 👥✎ 先向主进程申请锁,获得才能打开编辑器,被另一窗口占用则提示并拒绝
  const openGroupEditorLocked = async () => {
    const res = await api.openGroupEditor(chatId);
    if (!res.ok) {
      showToast(t('group.editLockedTip'), true);
      return;
    }
    setShowGroupEditor(true);
  };
  const closeGroupEditorLocked = () => {
    setShowGroupEditor(false);
    api.closeGroupEditor(chatId);
  };
  const onGroupEditorUpdatedLocked = () => {
    setShowGroupEditor(false);
    api.closeGroupEditor(chatId);
    onGroupUpdated?.();
    api.notifyGroupEditorSaved(chatId);
  };

  // 监听其他窗口编辑群成员事件：saved 时刷新成员列表
  useEffect(() => {
    if (chatType !== 'group') return;
    const off = api.onGroupEditorState((data) => {
      if (data.groupId !== chatId) return;
      if (data.action === 'saved') {
        reload();
        showToast(t('group.editSavedSync'));
      }
    });
    return off;
  }, [chatType, chatId]);
  // ===== 随机事件 =====
  const triggerEvent = async (theme?: string) => {
    if (eventLoading || eventState) return;
    setEventLoading(true);
    try {
      const ev = await api.randomEvent({ chatType, chatId, theme, window: 'main' });
      if ('busy' in ev) {
        const win = (ev as any).window;
        if (win && win !== 'main') showToast(t('chat.eventBusyAt', { window: t('chat.window' + win) }));
        return;
      }
      setEventState(ev);
      playSoundSync('popup');
    } catch (e: any) {
      showToast(t('toast.eventFail', { msg: e?.message || String(e) }));
    } finally {
      setEventLoading(false);
    }
  };
  const chooseOption = async (opt: { text: string; affinity: number; mood: string }, auto = false) => {
    if (!eventState) return;
    const ev = eventState;
    setEventState(null);
    try {
      const res = await api.chooseEvent({
        chatType,
        chatId,
        roleId: ev.roleId,
        change: opt.affinity,
        choiceText: opt.text,
        eventText: ev.event,
        mood: opt.mood,
      });
      const change = res.change >= 0 ? `+${res.change}` : `${res.change}`;
      const msg = t('chat.eventApplied', { change, name: res.roleName });
      if (auto) {
        showToast(msg + ' (' + t('chat.eventAutoSelected') + ')');
      } else {
        showToast(msg);
      }
      // 事件会影响角色情绪：刷新心情徽标
      const r = await api.getRole(chatType === 'single' ? chatId : ev.roleId);
      if (r) setRoleMood(r.mood || '');
      void api.eventClosed({ chatType, chatId });
      // 立即拉取最新消息，显示后端已写入的「好感/心情」系统消息
      api.getMessages(chatType, chatId).then(setMessages);
    } catch (e: any) {
      showToast(t('toast.eventFail', { msg: e?.message || String(e) }));
    }
  };
  // 一轮对话完成后，按设置 + 冷却 + 概率自动触发（关闭开关则不自动弹）
  const maybeRandomEvent = () => {
    if (!enableRandomEventsRef.current) return;
    if (eventState || eventLoading) return;
    const now = Date.now();
    if (now - lastEventRef.current < EVENT_COOLDOWN_MS) return; // 冷却，避免刷屏
    lastEventRef.current = now;
    if (Math.random() > EVENT_TRIGGER_THRESHOLD) return; // 约 45% 概率真正触发
    triggerEvent();
  };
  // 同步供空闲轮询读取的最新值
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    roleMissingRef.current = roleMissing;
  }, [roleMissing]);
  useEffect(() => {
    membersMissingRef.current = membersMissing;
  }, [membersMissing]);

  // 点击 More 下拉外部时关闭
  useEffect(() => {
    if (!moreOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      const wrap = document.querySelector('.more-wrap');
      const drop = document.querySelector('.more-dropdown');
      if (wrap && wrap.contains(t)) return;
      if (drop && drop.contains(t)) return;
      setMoreOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [moreOpen]);

  // 空闲主动回复：用户在线但一段时间无操作时，角色主动发一条贴合语境与心情的消息
  const triggerProactive = useCallback(async () => {
    if (proactiveBusyRef.current) return;
    if (roleMissingRef.current || membersMissingRef.current > 0) return;
    proactiveBusyRef.current = true;
    try {
      const res = await api.proactive({ chatType, chatId });
      if (!res.ok && res.error) showToast(t('chat.proactiveError', { error: res.error }));
    } catch (e: any) {
      showToast(t('chat.proactiveError', { error: e?.message || String(e) }));
    } finally {
      proactiveBusyRef.current = false;
      // 一条主动消息后，需再次静默整段时长才会触发下一条（避免连续刷屏）
      const now = Date.now();
      lastActivityRef.current = now;
      api.idleSet(chatKey, now);
    }
  }, [chatType, chatId, t, showToast]);

  // 主动消息空闲检测：基于消息发送时间，而非鼠标/键盘事件
  useEffect(() => {
    let cancelled = false;
    // 进入聊天时，从主进程读取全局权威计时基准（跨窗口唯一数据源）
    (async () => {
      const saved = await api.idleGet(chatKey);
      if (cancelled) return;
      let initTime: number;
      if (idleSwitchActionRef.current === 'reset') {
        // reset：重新计时
        initTime = Date.now();
        api.idleSet(chatKey, initTime);
      } else if (saved != null) {
        // pause / continue：继承主进程权威值
        initTime = saved;
      } else {
        // 无值，首次进入：以当前时刻为基准并写入主进程供其他窗口继承
        initTime = Date.now();
        api.idleSet(chatKey, initTime);
      }
      lastActivityRef.current = initTime;
    })();

    const iv = setInterval(() => {
      if (!idleReplyOnRef.current) return;
      if (proactiveBusyRef.current) return;
      if (sendingRef.current || streamingCountRef.current > 0) return;
      if (roleMissingRef.current || membersMissingRef.current > 0) return;
      const msgs = messagesRef.current;
      if (!msgs || msgs.length === 0) return;
      const idleMs = (idleSecondsRef.current || 60) * 1000;
      if (Date.now() - lastActivityRef.current < idleMs) return;
      triggerProactive();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatType, chatId, triggerProactive]);

  // 主动消息倒计时：订阅主进程每秒广播的 elapsed，保证多窗口完全一致
  useEffect(() => {
    const offTick = api.onIdleTick((_e, payload) => {
      if (!idleReplyOnRef.current || document.visibilityState !== 'visible') {
        setIdleCountdown(0);
        return;
      }
      const elapsed = payload[chatKey];
      const totalMs = (idleSecondsRef.current || 600) * 1000;
      if (elapsed === undefined) {
        // 本聊天尚未进入主进程计时，显示完整时长
        setIdleCountdown(Math.ceil(totalMs / 1000));
        return;
      }
      const remaining = totalMs - elapsed;
      setIdleCountdown(remaining > 0 ? Math.ceil(remaining / 1000) : 0);
    });
    return offTick;
  }, [chatKey]);

  // 发送失败重发：phase='full' 需整条重发；phase='ai' 用户消息已入库，仅重发 AI 回复
  const [failed, setFailed] = useState<{
    content: string;
    imagePaths: string[];
    phase: 'full' | 'ai';
    error: string;
  } | null>(null);
  // 语音输入 / TTS
  const [voiceCfg, setVoiceCfg] = useState({ asr: false, tts: false, auto: false });
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const doneStreamIds = useRef(new Set<string>());
  const seenSeqRef = useRef<Record<string, number>>({});
  const lastSentRef = useRef<{ content: string; imagePaths: string[] }>({
    content: '',
    imagePaths: [],
  });
  const recentlySentRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 群聊连续对话：continuing=单轮接话进行中；autoChat=自动接话循环开启
  const [continuing, setContinuing] = useState(false);
  const [autoChat, setAutoChat] = useState(false);
  const [autoRound, setAutoRound] = useState(0);
  const autoRef = useRef(false);
  const pendingAutoChain = useRef(false); // 发消息后是否自动进入多轮接话（AI 主动续聊）
  const scrollRef = useRef<HTMLDivElement>(null);
  const bgKey = `${chatType}:${chatId}`;
  // 空闲主动回复：refs 供定时轮询读取最新值，避免每次渲染都重建监听器
  const lastActivityRef = useRef(Date.now()); // 最近一次用户操作时间
  const proactiveBusyRef = useRef(false); // 正在生成主动消息，防止重复触发
  const idleReplyOnRef = useRef(true);
  const idleSecondsRef = useRef(60);
  const sendingRef = useRef(false); // 与 setSending 同步，供轮询读取
  const replyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 回复超时检测
  const streamingCountRef = useRef(0); // 当前进行中的流式数量
  const activeStreamsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessage[]>([]);
  const roleMissingRef = useRef(false);
  const membersMissingRef = useRef(0);

  const load = () => {
    api.getMessages(chatType, chatId).then(setMessages);
    api.getGlobalTokens().then(setGlobalTokens);
    api.listWorldBooks().then(setWorldBooks).catch(() => {});
    Promise.all([api.getRoles(), api.getSettings()]).then(([roles, settings]) => {
      const map: Record<string, string> = {};
      const avatars: Record<string, string> = {};
      for (const r of roles) {
        const cfg = (settings.models || []).find((m) => m.id === r.model_config_id);
        if (cfg) map[r.name] = cfg.name;
        if (r.avatar_path) avatars[r.name] = r.avatar_path;
      }
      setModelMap(map);
      setAvatarMap(avatars);
      // 初始化群聊各成员心情
      if (chatType === 'group') {
        const moods: Record<string, string> = {};
        for (const r of roles) {
          if (r.mood) moods[r.name] = r.mood;
        }
        setGroupMoods(moods);
      }
      setEnableStreaming(!!settings.enableStreaming);
      autoMemoryRef.current = !!settings.enableAutoMemory;
      setHideReasoning(settings.hideReasoning !== false);
      setEnableRandomEvents(settings.enableRandomEvents !== false);
      // 主动消息：全局主开关 × 当前聊天单独开关
      const globalOn = settings.idleEnabled !== false;
      const perChat = (settings.chatIdleEnabled || {})[bgKey];
      const eff = globalOn && (perChat === undefined ? true : perChat);
      setIdleReplyOn(eff);
      idleReplyOnRef.current = eff;
      idleSecondsRef.current = settings.idleInterval || 600;
      idleSwitchActionRef.current = settings.idleSwitchAction || 'pause';
      setGroupAutoChain(settings.groupAutoChain !== false);
      setVoiceCfg({
        asr: !!settings.voice?.asrModelId,
        tts: !!settings.voice?.ttsModelId,
        auto: !!settings.voice?.ttsModelId && !!settings.voice?.ttsAutoPlay,
      });
      // 载入自我身份列表与当前对话的身份覆盖
      const sRoles = settings.selfRoles || [];
      setSelfRoles(sRoles);
      const curDef = settings.currentSelfRoleId || '';
      setDefaultSelfId(curDef);
      const override = settings.chatSelfRoles?.[bgKey];
      setSelfRoleId(override ?? 'default');
      // 本对话世界书
      setChatWorldBookId(settings.chatWorldBooks?.[bgKey] ?? '');
      const bgPath = settings.chatBackgrounds?.[bgKey];
      if (bgPath) {
        api.getImage(bgPath).then((src) => setChatBg(src));
      } else {
        setChatBg(null);
      }
    });
    // 观察者状态（仅群聊有对局）
    if (chatType === 'group') {
      api.getGroup(chatId).then((g) => {
        if (!g) return;
        setObserverMode(!!g.observerMode);
        observerModeRef.current = !!g.observerMode;
        setObserverConfig({
          freezeMemory: !!g.freezeMemory,
          publicWriteMemory: g.publicWriteMemory !== false,
          observerNoEmotion: g.observerNoEmotion !== false,
          privateWriteMemory: !!g.privateWriteMemory,
          privateAffectsEmotion: !!g.privateAffectsEmotion,
        });
      }).catch(() => {});
    } else {
      setObserverMode(false);
      observerModeRef.current = false;
    }
  };

  const reload = () => { load(); };

  // 消息列表更新后聚焦输入框（回滚/撤回等操作导致 messages 变化后自动恢复焦点）
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    // 若焦点已在其它输入框/可编辑区（如角色编辑弹窗、用户正在输入），不要抢走焦点
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [messages]);

  // 窗口重新获得操作系统焦点时，若没有任何可编辑元素获焦（偶发焦点丢失导致无法输入），
  // 且当前没有随机事件遮罩，则把焦点还给输入框，无需靠发图片等方式手动恢复。
  useEffect(() => {
    const onFocus = () => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('.event-overlay')) return;
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // 全局键盘安全网：用户敲键盘时若焦点不在任何输入框（偶发焦点丢失），
  // 自动将焦点归还聊天输入框。这是「发图恢复」之外的自动修复手段，
  // 覆盖复制角色后切聊、通知弹窗偷焦、随机事件遮罩残留等所有场景。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 忽略功能键/修饰键单独按下（F1-F12、Ctrl/Alt/Shift/Meta 单独按）
      if (e.key.length > 1 && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'Enter') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // 已在输入框中 → 正常，不干预
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // 输入框不可用（角色缺失等）→ 不抢焦
      if (!inputRef.current || inputRef.current.readOnly) return;
      // 有模态对话框打开 → 不抢焦
      if (document.querySelector('.modal-backdrop, .dialog-overlay, [role="dialog"]')) return;
      // 归还焦点
      e.preventDefault();
      inputRef.current.focus();
      // 将按键重新派发给 textarea（让首字不丢失）
      const fakeEvent = new KeyboardEvent('keydown', {
        key: e.key, code: e.code, keyCode: e.keyCode,
        bubbles: true, cancelable: true,
      });
      inputRef.current.dispatchEvent(fakeEvent);
    };
    window.addEventListener('keydown', onKeyDown, true); // capture 阶段拦截
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // 随机事件弹窗关闭后，若当前无其他模态/遮罩打开，立即把焦点归还聊天输入框
  useEffect(() => {
    const onRestore = () => {
      if (document.querySelector('.modal-backdrop, .dialog-overlay, [role="dialog"], .event-overlay')) return;
      if (!inputRef.current || inputRef.current.readOnly) return;
      inputRef.current.focus();
    };
    window.addEventListener('nianyu:restore-focus', onRestore);
    return () => window.removeEventListener('nianyu:restore-focus', onRestore);
  }, []);

  useEffect(() => {
    load();
    setInput('');
    setPendingImages([]);
    setStreamingMsgs({});
    setFailed(null);
    setRoleMissing(false);
    setMembersMissing(0);
    setConvertPrompt(false);
    setShowGroupEditor(false);
    doneStreamIds.current.clear();
    seenSeqRef.current = {};
    // 切换聊天后自动聚焦输入框
    setTimeout(() => inputRef.current?.focus(), 100);
    // 切换聊天时终止自动接话
    autoRef.current = false;
    pendingAutoChain.current = false;
    setAutoChat(false);
    setAutoRound(0);
    setContinuing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatType, chatId]);

  // 会话切换 / 刷新 UI 后，使用 requestAnimationFrame 在下一帧可靠地把焦点交回输入框。
  // 直接依赖 autoFocus 在「删除会话后切换/小窗就地切换」等场景下不可靠（节点挂载时机/窗口焦点问题），
  // 会导致输入框看似存在却无法输入，故改为程序化聚焦。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [chatKey, refreshNonce]);

  // 卸载时终止自动接话循环
  useEffect(() => {
    return () => {
      autoRef.current = false;
    };
  }, []);

  // 检测角色/成员删除状态：单聊角色被删、群聊部分成员被删、群聊仅剩 1 人
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (chatType === 'single') {
        const r = await api.getRole(chatId);
        if (!cancelled) {
          setRoleMissing(!r);
          setRoleMood(r?.mood || '');
        }
      } else if (chatType === 'group') {
        const g = await api.getGroup(chatId);
        const existingIds = new Set(members.map((m) => m.id));
        const allIds = g ? g.member_ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const missing = allIds.filter((id) => !existingIds.has(id)).length;
        if (!cancelled) {
          setMembersMissing(missing);
          // 仅剩 1 位现存成员时提示转为单聊（若该群已设置「保持群聊」忽略标记则不提示）
          const ignored = !!(g && g.ignoreConvert);
          setConvertPrompt(existingIds.size === 1 && allIds.length >= 1 && !ignored);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 依赖 members：群聊编辑成员后刷新提示
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatType, chatId, members]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      setShowScrollBtn(!nearBottom);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingMsgs]);

  // 流式事件监听
  useEffect(() => {
    const belongs = (streamId: string) => {
      // streamId = `${chatId}:${roleId}`，按最后一个 ':' 精确解析出 chatId 再比较，
      // 避免 chatId 互为字符串前缀时（如 "1" 与 "12"）回复串到无关聊天
      const sep = streamId.lastIndexOf(':');
      const sid = sep >= 0 ? streamId.slice(0, sep) : streamId;
      return sid === chatId;
    };
    const onChunk = (_e: any, data: any) => {
      if (!belongs(data.streamId)) return;
      // 按 seq 去重：同一 chunk 被多个监听器/窗口重复处理时只追加一次
      if (typeof data.seq === 'number') {
        const last = seenSeqRef.current[data.streamId] || 0;
        if (data.seq <= last) return;
        seenSeqRef.current[data.streamId] = data.seq;
      }
      // 流式出错：撤下打字中的气泡，显示重发（用户消息已入库，重发仅补 AI 回复）
      if (data.error) {
        setStreamingMsgs((prev) => {
          const copy = { ...prev };
          delete copy[data.streamId];
          return copy;
        });
        setFailed({
          content: lastSentRef.current.content,
          imagePaths: lastSentRef.current.imagePaths,
          phase: 'ai',
          error: String(data.error),
        });
        return;
      }
      setStreamingMsgs((prev) => {
        const existing = prev[data.streamId];
        const next: ChatMessage = existing
          ? {
              ...existing,
              content: existing.content + (data.content || ''),
              reasoning: (existing.reasoning || '') + (data.reasoning || '') || undefined,
            }
          : {
              id: -Date.now(),
              chat_type: chatType as any,
              chat_id: chatId,
              sender_type: 'ai',
              sender_name: name,
              content: data.content || '',
              reasoning: data.reasoning || undefined,
              image_path: null,
              token_used: 0,
              timestamp: new Date().toISOString(),
            };
        return { ...prev, [data.streamId]: next };
      });
    };
    const onDone = (_e: any, data: any) => {
      // 非本聊天（如观察者私密小窗 obs:群:角色）的流式完成事件不在此窗口渲染，避免回复串到公屏
      if (!belongs(data.streamId)) return;
      let remaining = 0;
      activeStreamsRef.current.delete(data.streamId);
      streamingCountRef.current = activeStreamsRef.current.size;
      setStreamingMsgs((prev) => {
        const copy = { ...prev };
        delete copy[data.streamId];
        remaining = Object.keys(copy).length;
        return copy;
      });
      if (data.message && !doneStreamIds.current.has(data.streamId)) {
        doneStreamIds.current.add(data.streamId);
        setMessages((prev) => {
          if (prev.find((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
        onSent();
        // 后台消息提醒：主窗/小窗均隐藏且软件在后台时，弹出 Steam 风格卡片
        if (data.message.sender_type === 'ai' && data.message.content) {
          if (typeof api.notifyCard === 'function') {
            api.notifyCard({
              chatType,
              chatId,
              name,
              roleName: data.message.sender_name,
              content: data.message.content,
            }).catch(() => {});
          }
        }
        // 全局 TTS：流式完成后自动播报
        if (voiceCfg.auto && data.message.content) speak(data.message);
      }
      // 流式全部完成 → 自动提炼记忆（若开启）
      if (remaining === 0) maybeAutoMemory();
      // 注意：AI 主动续聊（maybeChain）由主进程 roundDone 广播触发，避免群聊串行时首个成员 done 即触发。
      // 一轮对话完成 → 按设置自动触发随机事件（仅发送消息的窗口触发）
      if (remaining === 0) {
        if (recentlySentRef.current) {
          recentlySentRef.current = false;
          maybeRandomEvent();
        }
      }
    };
    const onStart = (_e: any, data: any) => {
      // 非本聊天的流式开始事件（如观察者私密小窗）跳过，避免在主窗公屏生成空占位气泡
      if (!belongs(data.streamId)) return;
      // 同一 streamId 可能被复用（继续对话/重发）：重置 seq 与完成标记，避免新一轮 chunk 被误丢弃
      delete seenSeqRef.current[data.streamId];
      doneStreamIds.current.delete(data.streamId);
      activeStreamsRef.current.add(data.streamId);
      streamingCountRef.current = activeStreamsRef.current.size;
      setStreamingMsgs((prev) => {
        if (prev[data.streamId]) return prev;
        const placeholder: ChatMessage = {
          id: -Date.now() - Math.floor(Math.random() * 1000),
          chat_type: chatType as any,
          chat_id: chatId,
          sender_type: 'ai',
          sender_name: data.roleName,
          content: '',
          image_path: null,
          token_used: 0,
          timestamp: new Date().toISOString(),
        };
        return { ...prev, [data.streamId]: placeholder };
      });
    };
    const onUser = (_e: any, data: ChatMessage) => {
      if (!data || data.chat_id !== chatId) return;
      const idKey = String(data.id);
      if (!doneStreamIds.current.has(idKey)) {
        doneStreamIds.current.add(idKey);
        setMessages((prev) => {
          if (prev.find((m) => m.id === data.id)) return prev;
          return [...prev, data];
        });
      }
    };
    const offUser = api.onStreamUser(onUser);
    const offEvent = api.onEventChosen((_e, data) => {
      if (!data || data.chatId !== chatId) return;
      setEventState(null);
      setEventLoading(false);
      // 另一窗口选择了事件选项 → 关闭本窗口事件弹窗，同步显示系统消息
      if (data.message) {
        setMessages((prev) => {
          if (prev.find((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
      }
    });
    const offChunk = api.onStreamChunk(onChunk);
    const offDone = api.onStreamDone(onDone);
    const offStart = api.onStreamStart(onStart);
    // 整轮（用户消息 → 所有 AI 回复）结束后由主进程广播 stream:roundDone 触发 AI 主动续聊，
    // 避免群聊串行时首个成员 done 即误触发可能链。
    const offRoundDone = api.onStreamRoundDone((data) => {
      if (!data || data.chatId !== chatId) return;
      if (pendingAutoChain.current) {
        pendingAutoChain.current = false;
        setTimeout(() => maybeChain(), 250);
      }
    });
    // 空闲活动同步：另一窗口发送消息后重置本窗口的 idle 计时
    const offIdle = api.onIdleActivity((_e, data) => {
      if (data && data.chatKey === chatKey) {
        const ts = data.timestamp || Date.now();
        setIdleActivity(chatKey, ts);
        lastActivityRef.current = ts;
        // 立即刷新倒计时显示，避免等下次 setInterval 造成短暂不一致
        const total = (idleSecondsRef.current || 600) * 1000;
        setIdleCountdown(Math.ceil(total / 1000));
      }
    });
    return () => {
      offUser();
      offEvent();
      offChunk();
      offDone();
      offStart();
      offRoundDone();
      offIdle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatType, chatId, name, onSent, voiceCfg.auto]);

  // 心情实时同步：AI 判定或事件选择后，主进程广播 role:mood，两窗口同步刷新
  useEffect(() => {
    const off = api.onRoleMood((_e, d) => {
      if (!d || !d.chatId) return;
      if (d.chatId === chatId) {
        if (chatType === 'single') {
          setRoleMood(d.mood || '');
        } else if (chatType === 'group') {
          // 群聊：更新对应角色的心情（用于头像旁小字显示）
          const role = members.find((m) => m.id === d.roleId);
          if (role) {
            setGroupMoods((prev) => ({ ...prev, [role.name]: d.mood || '' }));
          }
        }
      }
    });
    return off;
  }, [chatId, chatType, members]);

  // 观察者模式广播同步：开启/关闭/配置变更时，所有群聊窗口一致刷新
  useEffect(() => {
    if (chatType !== 'group') return;
    const off = api.onGroupObserver((_e, d) => {
      if (!d || d.groupId !== chatId) return;
      setObserverMode(!!d.observerMode);
      observerModeRef.current = !!d.observerMode;
      if (d.config) {
        setObserverConfig((prev) => ({ ...prev, ...d.config }));
      }
    });
    return off;
  }, [chatId, chatType]);

  // 设置变更广播同步：主窗与小窗的世界书/身份/背景/开关保持一致
  useEffect(() => {
    const off = api.onSettingsChanged(async (_e, patch: Record<string, any>) => {
      if (!patch) return;
      const settings = await api.getSettings();
      // 按聊天覆盖的设置（以 bgKey 为维度）
      if (patch.chatWorldBooks) {
        const wbId = (settings.chatWorldBooks || {})[bgKey] ?? '';
        setChatWorldBookId(wbId);
      }
      if (patch.chatSelfRoles) {
        const override = (settings.chatSelfRoles || {})[bgKey];
        setSelfRoleId(override ?? 'default');
      }
      if (patch.chatBackgrounds) {
        const bgPath = (settings.chatBackgrounds || {})[bgKey];
        if (bgPath) {
          api.getImage(bgPath).then((src) => setChatBg(src));
        } else {
          setChatBg(null);
        }
      }
      // 全局设置
      if (patch.enableStreaming !== undefined) setEnableStreaming(!!patch.enableStreaming);
      if (patch.hideReasoning !== undefined) setHideReasoning(patch.hideReasoning !== false);
      if (patch.enableAutoMemory !== undefined) autoMemoryRef.current = !!patch.enableAutoMemory;
      if (patch.enableRandomEvents !== undefined) setEnableRandomEvents(patch.enableRandomEvents !== false);
      // 主动消息：取最新 settings 重算 effective
      if (patch.idleEnabled !== undefined || patch.chatIdleEnabled !== undefined) {
        const ns = await api.getSettings();
        const globalOn = ns.idleEnabled !== false;
        const perChat = (ns.chatIdleEnabled || {})[bgKey];
        const eff = globalOn && (perChat === undefined ? true : perChat);
        setIdleReplyOn(eff);
        idleReplyOnRef.current = eff;
      }
      if (patch.idleInterval !== undefined) idleSecondsRef.current = patch.idleInterval || 600;
      if (patch.voice) {
        setVoiceCfg({
          asr: !!patch.voice.asrModelId,
          tts: !!patch.voice.ttsModelId,
          auto: !!patch.voice.ttsModelId && !!patch.voice.ttsAutoPlay,
        });
      }
    });
    return off;
  }, [bgKey]);

  // 窗口间同步：自动接话 driver 事件
  // - start: 同聊天时其他窗口的 driver 已启动 → 本窗口同步显示状态（不驱动循环）
  // - round: 同步轮数显示
  // - stop: 本窗口退出显示（若本地也在驱动，autoRef 由 forceStopAutoChat 的本地调用清掉）
  useEffect(() => {
    const off = api.onAutoChatDriver((data) => {
      if (data.chatId !== chatId) return;
      if (data.action === 'start') {
        // 另一窗口的 driver 已启动（或本地刚启动 claim 成功），同步显示
        setAutoChat(true);
        // 轮数交给 round 事件更新，此处保留 0
      } else if (data.action === 'round') {
        if (typeof data.round === 'number') setAutoRound(data.round);
      } else if (data.action === 'stop') {
        setAutoChat(false);
        setAutoRound(0);
        setContinuing(false);
        // driver 已被主进程释放，若本窗口误以为自己在驱动，让循环下一次检查时退出
        if (data.reason === 'forced') autoRef.current = false;
      }
    });
    return off;
  }, [chatId]);

  // 清空发送失败状态（由 forceStopAutoChat / 新 driver claim 触发）
  useEffect(() => {
    const off = api.onClearFailed((data) => {
      if (data.chatId === chatId) setFailed(null);
    });
    return off;
  }, [chatId]);

  // 窗口间同步：消息变更（清空/撤回/回滚后其他窗口重载）
  useEffect(() => {
    const off = api.onMessagesSync((data) => {
      if (data.chatType !== chatType || data.chatId !== chatId) return;
      reload();
    });
    return off;
  }, [chatType, chatId]);

  // ===== 观察者模式操作 =====
  const enterObserver = async () => {
    const res = await api.observerSetMode({ groupId: chatId, on: true, applyPreset: true });
    if (res.ok) {
      setObserverMode(true);
      observerModeRef.current = true;
      showToast(t('observer.presetApplied'));
    }
  };
  const exitObserver = async () => {
    const res = await api.observerSetMode({ groupId: chatId, on: false });
    if (res.ok) {
      setObserverMode(false);
      observerModeRef.current = false;
      setShowObserverPanel(false);
      setShowObserverConfig(false);
      setConfigAnchor(null);
      if (res.archivePath) showToast(t('observer.archived', { path: res.archivePath }));
    }
  };
  const openPrivateWindow = async (roleId: string, roleName: string) => {
    setShowPrivateMenu(false);
    setPrivateAnchor(null);
    try {
      await api.miniOpen({
        initialChat: { chatType: 'single', chatId: `obs:${chatId}:${roleId}`, isObserverPrivate: true },
      });
      showToast(t('observer.openPrivate', { name: roleName }));
    } catch (e: any) {
      showToast(t('chat.miniOpenFail'));
    }
  };
  const toggleObserverConfig = async (key: keyof typeof observerConfig, value: boolean) => {
    const next = { ...observerConfig, [key]: value };
    setObserverConfig(next);
    await api.observerSetConfig({ groupId: chatId, patch: { [key]: value } as any });
    showToast(t('observer.configApplied'));
  };

  // 观察者下拉菜单（私密小窗 / 对局设置）通过 portal 渲染到 body，脱离 .chat-header-actions 的 overflow 裁剪。
  // 此处统一处理外部点击 / 滚动 / 缩放时关闭菜单。
  useEffect(() => {
    if (!showPrivateMenu && !showObserverConfig) return;
    const close = () => {
      setShowPrivateMenu(false);
      setShowObserverConfig(false);
      setPrivateAnchor(null);
      setConfigAnchor(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [showPrivateMenu, showObserverConfig]);

  // ===== 消息操作：快捷记忆 / 回滚 / 撤回 / 转发 =====
  const handleQuickMemory = async (m: ChatMessage, text: string) => {
    let roleId = '';
    if (chatType === 'single') {
      roleId = chatId;
    } else if (m.sender_type === 'ai') {
      const r = members.find((x) => x.name === m.sender_name);
      roleId = r?.id || '';
    }
    if (!roleId) return;
    await api.addQuickMemory({ roleId, content: text.trim().slice(0, 500) });
    const rname = members.find((x) => x.id === roleId)?.name || roleId;
    showToast(t('msg.quickMemoryDone', { name: rname }));
  };

  const handleRollback = async (msgId: number) => {
    if (!(await api.showConfirm!(t('msg.rollbackConfirm')))) return;
    const res = await api.rollbackMessages({ chatType, chatId, fromMsgId: msgId });
    showToast(t('msg.rollbackDone', { n: res.deletedMsgs, m: res.deletedMems }));
    reload();
    api.syncMessages({ chatType, chatId, action: 'rolledBack' });
  };

  const handleRecall = async (msgId: number) => {
    if (!(await api.showConfirm!(t('msg.recallConfirm')))) return;
    const res = await api.recallMessage(msgId);
    showToast(res.deletedMems > 0 ? t('msg.recallDone', { n: res.deletedMems }) : t('msg.recallDoneNone'));
    reload();
    api.syncMessages({ chatType, chatId, action: 'recalled' });
  };

  // 清空当前聊天消息（可选是否连同自动记忆一起删除）
  const handleClearChat = async (withMemories: boolean) => {
    setClearOpen(false);
    const res = await api.clearChatMessages(chatType, chatId, withMemories);
    showToast(
      withMemories
        ? t('chat.clearMessagesDoneWithMem', { n: res.deletedMsgs, m: res.deletedMems })
        : t('chat.clearMessagesDone', { n: res.deletedMsgs })
    );
    reload();
    api.syncMessages({ chatType, chatId, action: 'cleared' });
  };

  const handleForward = async (targetChatType: string, targetChatId: string, targetName: string) => {
    if (!forwardMsg) return;
    const prefix = `「转发自 ${name || chatId}」\n`;
    try {
      const settings = await api.getSettings();
      if (settings.enableStreaming) {
        await api.startStream({ chatType: targetChatType as ChatType, chatId: targetChatId, content: prefix + forwardMsg.content, imagePath: '' });
      } else {
        await api.sendMessage({ chatType: targetChatType as ChatType, chatId: targetChatId, content: prefix + forwardMsg.content, imagePath: '' });
      }
      showToast(t('msg.forwardDone', { name: targetName }));
    } catch (e: any) {
      showToast(t('chat.sendFail'), true);
    }
    setForwardMsg(null);
    setShowForwardPicker(false);
  };

  const openForwardPicker = (msg: ChatMessage) => {
    setForwardMsg(msg);
    api.getChatList().then((list) => {
      const filtered = list.filter((c) => {
        const key = `${c.chat_type}:${c.chat_id}`;
        return key !== `${chatType}:${chatId}` && !c.chat_id.startsWith('obs:');
      });
      setForwardChats(filtered);
      setShowForwardPicker(true);
    });
  };

  const pickImage = async () => {
    const paths = await api.pickImage();
    if (paths && paths.length) setPendingImages((prev) => [...prev, ...paths]);
  };

  const setBg = async () => {
    const paths = await api.pickImage();
    if (!paths || !paths.length) return;
    const src = await api.getImage(paths[0]);
    if (src) setBgCrop({ open: true, src });
  };

  const onBgCrop = async (dataUrl: string) => {
    const savedPath = await api.saveImage(dataUrl);
    if (!savedPath) return;
    const settings = await api.getSettings();
    const next = { ...settings.chatBackgrounds, [bgKey]: savedPath };
    await api.saveSettings({ chatBackgrounds: next });
    const src = await api.getImage(savedPath);
    if (src) setChatBg(src);
    setBgCrop({ open: false, src: '' });
  };

  const clearBg = async () => {
    const settings = await api.getSettings();
    const next = { ...settings.chatBackgrounds };
    delete next[bgKey];
    await api.saveSettings({ chatBackgrounds: next });
    setChatBg(null);
  };

  // 聊天级通知铃声：读取当前聊天的自定义路径
  const [chatSoundPath, setChatSoundPath] = useState<string | null>(null);
  useEffect(() => {
    api.getSettings().then((s) => setChatSoundPath(s.chatSoundPaths?.[chatKey] || null));
  }, [chatKey]);
  const setChatSound = async () => {
    const srcPath = await api.pickAudioFile();
    if (!srcPath) return;
    // 通过 setCustomSound 复制到 custom-sounds 目录,获取可被 nysound:// 协议解析的文件名
    const fname = await api.setCustomSound({ key: `chat:${chatKey}`, srcPath });
    if (!fname) { showToast(t('common.failed'), true); return; }
    const cur = (await api.getSettings()).chatSoundPaths || {};
    await api.saveSettings({ chatSoundPaths: { ...cur, [chatKey]: fname } });
    setChatSoundPath(fname);
    showToast(t('chat.soundSetDone', { name: fname }));
    void previewSound('notification', fname);
  };
  const previewChatSound = () => {
    if (chatSoundPath) void previewSound('notification', chatSoundPath);
  };
  const clearChatSound = async () => {
    const cur = { ...((await api.getSettings()).chatSoundPaths || {}) };
    delete cur[chatKey];
    await api.saveSettings({ chatSoundPaths: cur });
    setChatSoundPath(null);
    showToast(t('chat.soundCleared'));
  };

  // 切换当前对话使用的「自我身份」：写入按会话覆盖 chatSelfRoles[bgKey]
  const changeSelfRole = async (val: string) => {
    setSelfRoleId(val);
    const settings = await api.getSettings();
    const next = { ...(settings.chatSelfRoles || {}) };
    if (val === 'default') delete next[bgKey];
    else next[bgKey] = val;
    await api.saveSettings({ chatSelfRoles: next });
    const name = val === 'default'
      ? t('chat.selfRoleDefault')
      : (selfRoles.find((r) => r.id === val)?.name || val);
    showToast(t('chat.selfRoleSwitched', { name }));
  };

  const changeChatWorldBook = async (val: string) => {
    setChatWorldBookId(val);
    const settings = await api.getSettings();
    const next = { ...(settings.chatWorldBooks || {}) };
    if (val === '') delete next[bgKey];
    else next[bgKey] = val;
    await api.saveSettings({ chatWorldBooks: next });
    const name = val === ''
      ? t('worldbook.inherit')
      : val === 'none'
        ? t('worldbook.none')
        : (worldBooks.find((w) => w.id === val)?.name || val);
    showToast(t('toast.worldbookSwitched', { name }));
  };

  // AI 自动提炼记忆（仅在设置开启时触发，静默执行，失败不打扰用户）
  const maybeAutoMemory = () => {
    if (!autoMemoryRef.current) return;
    api.extractMemories(chatType, chatId).catch(() => {});
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  // 构建一条「正在回复」占位气泡（id 为负，真实消息入库后移除）
  const makePlaceholder = (roleName: string): ChatMessage => ({
    id: -Date.now() - Math.floor(Math.random() * 100000),
    chat_type: chatType as any,
    chat_id: chatId,
    sender_type: 'ai',
    sender_name: roleName,
    content: '',
    image_path: null,
    token_used: 0,
    timestamp: new Date().toISOString(),
  });

  // 统一发送逻辑；phase='ai' 表示用户消息已入库，仅需补发 AI 回复
  const performSend = async (content: string, imagePaths: string[], phase: 'full' | 'ai') => {
    // 用户插话：停止自动接话循环
    autoRef.current = false;
    setAutoChat(false);
    setSending(true);
    sendingRef.current = true;
    recentlySentRef.current = true;
    playSoundSync('messageSend');
    setFailed(null);
    // 回复超时检测：120 秒内无 AI 回复则标记失败
    if (replyTimeoutRef.current) clearTimeout(replyTimeoutRef.current);
    replyTimeoutRef.current = setTimeout(() => {
      if (sendingRef.current) {
        setStreamingMsgs({});
        setSending(false);
        sendingRef.current = false;
        setFailed({ content, imagePaths, phase: 'full', error: t('msg.timeout') });
      }
    }, 120000);
    lastSentRef.current = { content, imagePaths };
    // 发送消息即视为用户主动活动，重置空闲计时
    lastActivityRef.current = Date.now();
    setIdleActivity(chatKey, Date.now());
    api.sendIdleActivity(chatKey);
    // 每轮发送都重新计数，确保同一聊天内重复发送也能按完成顺序逐步显示
    doneStreamIds.current.clear();
    seenSeqRef.current = {};
    let userSent = phase === 'ai';
    try {
      if (enableStreaming && phase === 'full') {
        const { userMessage, members: streamMembers } = await api.startStream({
          chatType,
          chatId,
          content,
          imagePaths,
        });
        setMessages((prev) => [...prev, userMessage]);
        // 用后端 streamId 立即落占位，保证气泡在首字到达前就出现
        const init: Record<string, ChatMessage> = {};
        for (const mb of streamMembers) init[mb.streamId] = makePlaceholder(mb.roleName);
        setStreamingMsgs((prev) => ({ ...prev, ...init }));
      } else {
        if (phase === 'full') {
          const userMessage = await api.sendUserMessage({ chatType, chatId, content, imagePaths });
          setMessages((prev) => [...prev, userMessage]);
          userSent = true;
        }
        // 非流式：后端按每个模型完成时机广播 stream:start/done，
        // 前端收到即创建占位并逐步显示，无需在此预置 local 占位（避免重复气泡）。
        const res = await api.sendAIMessages({ chatType, chatId, content, imagePaths });
        setStreamingMsgs({});
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const newMsgs = res.aiMessages.filter((m) => !seen.has(m.id));
          return [...prev, ...newMsgs];
        });
        onSent();
        maybeRandomEvent();
        const changed = res.affinityChanges.find((a) => a.change !== 0);
        if (changed) {
          const sign = changed.change > 0 ? '+' : '';
          setAffinityPop(t('chat.affinityPop', { change: `${sign}${changed.change}` }));
          setTimeout(() => setAffinityPop(null), 1500);
        }
        // 全局 TTS：自动播报最后一条 AI 回复
        const lastAI = res.aiMessages[res.aiMessages.length - 1];
        if (voiceCfg.auto && lastAI?.content) speak(lastAI);
        maybeAutoMemory();
      }
    } catch (e: any) {
      setStreamingMsgs({});
      setFailed({
        content,
        imagePaths,
        phase: userSent && !enableStreaming ? 'ai' : 'full',
        error: e?.message || String(e),
      });
    } finally {
      if (replyTimeoutRef.current) clearTimeout(replyTimeoutRef.current);
      setSending(false);
      sendingRef.current = false;
    }
  };

  const send = async () => {
    if (roleMissing) return; // 单聊角色已删除，禁止发送
    const imgs = pendingImages;
    const text = input.trim();
    if ((!text && imgs.length === 0) || sending) return;
    setInput('');
    setPendingImages([]);
    // 群聊且开启「AI 主动续聊」：标记首轮完成后自动多轮接话
    // 观察者模式下强制禁用自动接话（对局房间仅允许串流，避免干扰纯旁观）
    pendingAutoChain.current =
      chatType === 'group' && !observerModeRef.current && !!((await api.getSettings()).groupAutoChain);
    // 微信风格：所有选中图片合并为一条消息的图集（无绿色气泡），一次性发送
    await performSend(text, imgs, 'full');
    // 非流式：performSend 已 await 完整首轮，直接触发（流式由 onDone 触发）
    if (!enableStreaming && pendingAutoChain.current) {
      pendingAutoChain.current = false;
      maybeChain();
    }
  };

  // 删除当前聊天
  const handleDeleteChat = async () => {
    if (!(await api.showConfirm!(t('chats.confirmDelete')))) return;
    await api.deleteChat(chatType, chatId);
    showToast(t('chat.toastChatDeleted'));
    onChatDeleted?.(chatId);
  };

  // 刷新 UI：重建输入框并重新聚焦，用于修复「输入框无法输入文字」等偶发卡死
  const refreshUI = () => {
    setInput('');
    setPendingImages([]);
    setStreamingMsgs({});
    setFailed(null);
    setRoleMissing(false);
    setMembersMissing(0);
    setConvertPrompt(false);
    setRefreshNonce((n) => n + 1);
    load();
    showToast(t('chat.refreshUIDone'));
    // 用 requestAnimationFrame + 额外一帧延迟，确保重建后的 textarea 已挂载再聚焦
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    });
  };

  // 群聊仅剩 1 人 → 转为该成员的单聊
  const handleConvertToSingle = async () => {
    const onlyMember = members[0];
    if (!onlyMember) return;
    await api.convertGroupToSingle(chatId, onlyMember.id);
    setConvertPrompt(false);
    showToast(t('chat.toastConverted', { name: onlyMember.name }));
    onConvertedToSingle?.(onlyMember.id);
  };

  // 群聊仅剩 1 人 → 用户选择「保持群聊」：持久化忽略标记，此后再进入不再弹提示
  const handleKeepGroup = async () => {
    await api.setGroupIgnoreConvert(chatId, true);
    setConvertPrompt(false);
  };

  const resend = () => {
    if (!failed || sending) return;
    pendingAutoChain.current = false;
    performSend(failed.content, failed.imagePaths, failed.phase);
  };

  // ===== 群聊连续对话：手动接力一轮 / 自动接话循环 =====
  const continueOnce = async () => {
    if (continuing || sending) return;
    setContinuing(true);
    try {
      await api.groupContinue({ chatId });
      showToast(t('chat.toastGroupContinue'));
    } finally {
      setContinuing(false);
    }
  };

  // 单驱动器模式：只有"争抢到 driver 角色"的窗口才真正驱动循环，其余窗口仅同步显示。
  // 强行 stop 走 forceStopAutoChat，让主进程广播 stop，所有窗口的本地 autoRef/autoChat 都置 false。
  const stopAuto = () => {
    autoRef.current = false;
    setAutoChat(false);
    api.forceStopAutoChat(chatId);
  };

  const startAuto = async () => {
    if (autoRef.current || sending) return;
    // 先争抢 driver 角色
    const claim = await api.claimAutoChat(chatId);
    if (!claim.isDriver) {
      showToast(t('chat.autoAlreadyRunning'), true);
      // 仍同步显示：等广播把本地状态更新为运行中（即使 driver 是另一窗口）
      return;
    }
    autoRef.current = true;
    setAutoChat(true);
    setAutoRound(0);
    showToast(t('chat.toastAutoStart'));
    // 每次启动时读取最新设置：0 = 无限轮
    const settings = await api.getSettings();
    const limit = Math.max(0, Math.floor(settings.groupAutoRounds ?? 6));
    let n = 0;
    while (autoRef.current && (limit === 0 || n < limit)) {
      setContinuing(true);
      let ok = false;
      try {
        const res = await api.groupContinue({ chatId });
        ok = !!res.ok;
        if (!ok) break;
      } catch {
        ok = false;
        break;
      } finally {
        setContinuing(false);
      }
      if (!autoRef.current) break;
      n += 1;
      setAutoRound(n);
      api.updateAutoChatRound(chatId, n); // 同步轮数到其他窗口
      if (limit !== 0 && n >= limit) break;
      // 轮间间隔：给用户插话/停止的窗口
      await new Promise((r) => setTimeout(r, 1500));
    }
    // 退出循环：清掉本地状态并释放 driver（主进程广播 stop 给所有窗口）
    autoRef.current = false;
    setAutoChat(false);
    api.releaseAutoChat(chatId);
    showToast(t('chat.toastAutoStop'));
  };

  // 用户发消息后，若开启「AI 主动续聊」，在首轮完成后自动进入自动接话循环
  const maybeChain = () => {
    if (chatType === 'group' && groupAutoChain) startAuto();
  };



  // ---------- 文本转语音（TTS） ----------
  const speak = async (msg: ChatMessage) => {
    // 再次点击同一条：停止播放
    if (speakingId === msg.id) {
      audioRef.current?.pause();
      audioRef.current = null;
      setSpeakingId(null);
      showToast(t('chat.toastSpeakingStop'));
      return;
    }
    try {
      audioRef.current?.pause();
      setSpeakingId(msg.id);
      showToast(t('chat.toastSpeaking'));
      const src = await api.textToSpeech(msg.content);
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => setSpeakingId((id) => (id === msg.id ? null : id));
      await audio.play();
    } catch (e: any) {
      setSpeakingId(null);
      alert(t('chat.ttsFailed', { msg: e?.message || String(e) }));
    }
  };

  const onInputChange = (v: string) => {
    setInput(v);
    const tail = v.slice(v.lastIndexOf('@'));
    setShowMention(tail.startsWith('@') && !tail.includes(' '));
  };

  const insertMention = (role: Role) => {
    const idx = input.lastIndexOf('@');
    const next = input.slice(0, idx) + '@' + role.name + ' ';
    setInput(next);
    setShowMention(false);
  };

  const totalTokens = messages.reduce((s, m) => s + (m.token_used || 0), 0);
  // 是否处于「对方正在回复」状态：发送中，或仍有流式占位气泡在飞
  const replying = sending || Object.keys(streamingMsgs).length > 0;
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const allMessages = [...messages];
  // 将流式中的消息追加到最后（单聊场景）
  for (const sm of Object.values(streamingMsgs)) {
    const lastIdx = allMessages.findIndex((m) => m.id === sm.id);
    if (lastIdx >= 0) allMessages[lastIdx] = sm;
    else allMessages.push(sm);
  }
  // 兜底：同 id 消息只显示一次，防止监听器被重复触发导致气泡重复
  const uniqueMessages = new Map<number | string, ChatMessage>();
  for (const m of allMessages) uniqueMessages.set(m.id, m);
  const allMessagesUnique = Array.from(uniqueMessages.values());

  return (
    <div className="main-pane">
      <div className="chat-header">
        <div>
          <div className="title">
            <span className="title-name">{name}</span>
            {chatType === 'single' && modelMap[name] && (
              <span className="model-tag">{t('chat.modelTag', { name: modelMap[name] })}</span>
            )}
            {chatType === 'single' && roleMood && (
              <span className="mood-badge" title={t('chat.moodTitle')}>
                {t('chat.moodBadge', { mood: roleMood })}
              </span>
            )}
          </div>
          <div className="sub">
            {chatType === 'group'
              ? t('chat.groupSub', { n: members.length })
              : t('chat.singleSub')}
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            className={`idle-toggle${idleReplyOn ? ' on' : ''}`}
            title={t('chat.idleReplyTip')}
            onClick={async () => {
              // 全局关闭时聊天界面按钮不可用
              const settings = await api.getSettings();
              if (settings.idleEnabled === false) return;
              const next = !idleReplyOn;
              setIdleReplyOn(next);
              idleReplyOnRef.current = next;
              const map = { ...(settings.chatIdleEnabled || {}), [bgKey]: next };
              await api.saveSettings({ chatIdleEnabled: map });
            }}
          >
            <span className="idle-toggle-knob" />
            <span className="idle-toggle-label">{t('chat.idleReply')}</span>
          </button>
          {idleReplyOn && idleCountdown > 0 && (
            <span className="idle-countdown" title={t('chat.idleCountdownTip')}>
              {idleCountdown >= 60
                ? `${Math.floor(idleCountdown / 60)}m${idleCountdown % 60}s`
                : `${idleCountdown}s`}
            </span>
          )}
          {chatType === 'group' && !observerMode && groupAutoChain && (
            <>
              <button
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                title={t('group.continueTalkTip')}
                onClick={continueOnce}
                disabled={continuing || autoChat || sending}
              >
                {continuing && !autoChat ? '⏳' : '▶'} {t('group.continueTalk')}
              </button>
              <button
                className={autoChat ? 'btn-primary' : 'btn-ghost'}
                style={{ padding: '3px 10px', fontSize: 12 }}
                title={autoChat ? t('group.autoStopTip') : t('group.autoTalkTip')}
                onClick={autoChat ? stopAuto : startAuto}
                disabled={!autoChat && (continuing || sending)}
              >
                {autoChat
                  ? `⏹ ${t('group.autoStop')} (${autoRound})`
                  : `🔁 ${t('group.autoTalk')}`}
              </button>
            </>
          )}
          {chatType === 'group' && (
            <>
              {observerMode ? (
                <>
                  <span className="observer-badge" title={t('observer.active')}>
                    🔭 {t('observer.active')}
                  </span>
                  <button
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    title={t('observer.panelTip')}
                    onClick={async () => {
                      const all = await api.getRoles();
                      setObserverMembers(all.filter((r) => members.some((m) => m.id === r.id)));
                      setShowObserverPanel(true);
                    }}
                  >
                    📊 {t('observer.panel')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    title={t('observer.privateTip')}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setPrivateAnchor(r);
                      setShowPrivateMenu((v) => !v);
                      setShowObserverConfig(false);
                      setConfigAnchor(null);
                    }}
                  >
                    🔒 {t('observer.private')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    title={t('observer.configTip')}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setConfigAnchor(r);
                      setShowObserverConfig((v) => !v);
                      setShowPrivateMenu(false);
                      setPrivateAnchor(null);
                    }}
                  >
                    ⚙ {t('observer.config')}
                  </button>
                  <button
                    className="btn-ghost obs-exit"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    title={t('observer.exitTip')}
                    onClick={exitObserver}
                  >
                    ⏹ {t('observer.exit')}
                  </button>
                </>
              ) : (
                <button
                  className="btn-ghost"
                  style={{ padding: '3px 10px', fontSize: 12 }}
                  title={t('observer.enterTip')}
                  onClick={enterObserver}
                >
                  🔭 {t('observer.enter')}
                </button>
              )}
            </>
          )}
          {showPrivateMenu && privateAnchor && createPortal(
            <div
              className="obs-menu"
              style={{ position: 'fixed', top: privateAnchor.bottom + 4, right: window.innerWidth - privateAnchor.right, zIndex: 1000 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {members.length === 0 && (
                <div className="obs-menu-item" style={{ opacity: 0.6 }}>—</div>
              )}
              {members.map((m) => (
                <button key={m.id} className="obs-menu-item" onClick={() => openPrivateWindow(m.id, m.name)}>
                  🔒 {m.name}
                </button>
              ))}
            </div>,
            document.body
          )}
          {showObserverConfig && configAnchor && createPortal(
            <div
              className="obs-menu obs-config"
              style={{ position: 'fixed', top: configAnchor.bottom + 4, right: window.innerWidth - configAnchor.right, zIndex: 1000 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <label className="obs-toggle">
                <input type="checkbox" checked={observerConfig.freezeMemory} onChange={(e) => toggleObserverConfig('freezeMemory', e.target.checked)} />
                <span><b>{t('observer.freezeMemory')}</b><em>{t('observer.freezeMemoryDesc')}</em></span>
              </label>
              <label className="obs-toggle">
                <input type="checkbox" checked={observerConfig.publicWriteMemory} onChange={(e) => toggleObserverConfig('publicWriteMemory', e.target.checked)} />
                <span><b>{t('observer.publicWriteMemory')}</b><em>{t('observer.publicWriteMemoryDesc')}</em></span>
              </label>
              <label className="obs-toggle">
                <input type="checkbox" checked={observerConfig.observerNoEmotion} onChange={(e) => toggleObserverConfig('observerNoEmotion', e.target.checked)} />
                <span><b>{t('observer.pureObserver')}</b><em>{t('observer.pureObserverDesc')}</em></span>
              </label>
              <label className="obs-toggle">
                <input type="checkbox" checked={observerConfig.privateWriteMemory} onChange={(e) => toggleObserverConfig('privateWriteMemory', e.target.checked)} />
                <span><b>{t('observer.privateWriteMemory')}</b><em>{t('observer.privateWriteMemoryDesc')}</em></span>
              </label>
              <label className="obs-toggle">
                <input type="checkbox" checked={observerConfig.privateAffectsEmotion} onChange={(e) => toggleObserverConfig('privateAffectsEmotion', e.target.checked)} />
                <span><b>{t('observer.privateAffectsEmotion')}</b><em>{t('observer.privateAffectsEmotionDesc')}</em></span>
              </label>
            </div>,
            document.body
          )}
          {chatType === 'group' && !observerMode && (
            <button
              className="tool-btn"
              title={t('group.edit')}
              onClick={openGroupEditorLocked}
            >
              👥✎
            </button>
          )}
          <button
            className="btn-ghost"
            style={{ padding: '3px 10px', fontSize: 12 }}
            title={t('chat.openMini')}
            onClick={openMini}
          >
            🪟 {t('chat.openMini')}
          </button>
          <button
            className="btn-ghost"
            style={{ padding: '3px 10px', fontSize: 12 }}
            title={t('chat.randomEventTip')}
            onClick={() => triggerEvent()}
            disabled={eventLoading || !!eventState}
          >
            🎲 {t('chat.triggerEvent').replace('🎲 ', '')}
          </button>
          <div className="more-wrap" style={{ position: 'relative', flexShrink: 0 }}>
            <button
              className="tool-btn"
              title={t('chat.more')}
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMorePos({ right: window.innerWidth - r.right, top: r.bottom + 4 });
                setMoreOpen(true);
              }}
            >
              ⋯
            </button>
            {moreOpen && createPortal(
              <div
                className="more-dropdown"
                style={{
                  position: 'fixed', right: morePos.right, top: morePos.top,
                  zIndex: 2147483645,
                  background: 'var(--color-panel)', color: 'var(--color-text)',
                  border: '1px solid var(--color-border)', borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 6, minWidth: 200,
                }}
              >
                <button
                  className="tool-btn" style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                  onClick={() => { refreshUI(); setMoreOpen(false); }}
                >🔄 {t('chat.refreshUITip')}</button>
                <button
                  className="tool-btn" style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                  onClick={() => { handleDeleteChat(); setMoreOpen(false); }}
                >🗑️ {t('chat.deleteChat')}</button>
                <button
                  className="tool-btn" style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                  onClick={() => { setClearOpen(true); setMoreOpen(false); }}
                >🧹 {t('chat.clearMessages')}</button>
                <button
                  className="tool-btn" style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                  onClick={() => { (chatBg ? clearBg : setBg)(); setMoreOpen(false); }}
                >🖼️ {chatBg ? t('chat.clearBackground') : t('chat.setBackground')}</button>
                <button
                  className="tool-btn" style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                  onClick={() => { setChatSound(); setMoreOpen(false); }}
                  onContextMenu={(e) => { e.preventDefault(); if (chatSoundPath) { clearChatSound(); setMoreOpen(false); } }}
                >
                  🕐 {chatSoundPath ? t('chat.customSoundWithName', { name: chatSoundPath.replace(/^snd-/, '').replace(/\.[^.]+$/, '') }) : t('chat.chatSound')}
                </button>
                {chatSoundPath && (
                  <button
                    className="tool-btn" style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                    onClick={() => { previewChatSound(); setMoreOpen(false); }}
                  >▶ {t('chat.previewSound')}</button>
                )}
                <div style={{ padding: '4px 0' }}>
                  <SelectMenu
                    value={chatWorldBookId}
                    onChange={(v) => { changeChatWorldBook(v); setMoreOpen(false); }}
                    title={t('worldbook.select')}
                    style={{ width: '100%', fontSize: 13 }}
                    options={[
                      { value: '', label: `📖 ${t('worldbook.inherit')}` },
                      { value: 'none', label: t('worldbook.none') },
                      ...worldBooks.map((w) => ({ value: w.id, label: w.name })),
                    ]}
                  />
                </div>
              </div>,
              document.body,
            )}
          </div>
          <ClearChatModal
            open={clearOpen}
            onCancel={() => setClearOpen(false)}
            onConfirm={handleClearChat}
          />
          {selfRoles.length > 0 && (
            <SelectMenu
              value={selfRoleId}
              onChange={(v) => changeSelfRole(v)}
              title={t('chat.selfRoleLabel')}
              style={{ fontSize: 12, padding: '2px 6px', maxWidth: 140, width: 'auto', flexShrink: 0 }}
              options={[
                {
                  value: 'default',
                  label: defaultSelfId
                    ? t('chat.selfRoleDefaultNamed', {
                        name: selfRoles.find((r) => r.id === defaultSelfId)?.name || '',
                      })
                    : t('chat.selfRoleDefault'),
                },
                ...selfRoles.map((r) => ({ value: r.id, label: r.name })),
                { value: 'none', label: t('chat.selfRoleNone') },
              ]}
            />
          )}
          <div className="token-bar">
            {t('chat.tokenBar', { total: totalTokens, global: globalTokens })}
          </div>
        </div>
      </div>

      {replying && (
        <div className="replying-bar">
          <span className="dot" />
          {t('chat.replying')}
        </div>
      )}

      {/* 群聊仅剩 1 人：提示转为单聊 */}
      {convertPrompt && !roleMissing && (
        <div className="alert-bar alert-warn">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('chat.convertTitle')}</div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {t('chat.convertPrompt', { name: members[0]?.name || '' })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={handleConvertToSingle}>
              {t('chat.convertToSingle')}
            </button>
            <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={handleKeepGroup}>
              {t('chat.keepGroup')}
            </button>
          </div>
        </div>
      )}

      {/* 群聊部分成员被删除 */}
      {!convertPrompt && membersMissing > 0 && (
        <div className="alert-bar alert-info">⚠️ {t('chat.membersDeleted')}</div>
      )}

      <CustomScrollArea className="messages" scrollRef={scrollRef} style={chatBg ? { backgroundImage: `url(${chatBg})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
        {allMessages.length === 0 && (
          <div className="empty-state">
            <div style={{ fontSize: 32 }}>💭</div>
            <div>{t('chat.empty', { name })}</div>
          </div>
        )}
        {allMessagesUnique.map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            onImage={setPreview}
            fmtTime={fmtTime}
            modelName={m.sender_type === 'ai' ? modelMap[m.sender_name] : undefined}
            avatarPath={m.sender_type === 'ai' ? avatarMap[m.sender_name] : undefined}
            userAvatarPath={userAvatarPath}
            showTts={voiceCfg.tts && m.sender_type === 'ai' && !!m.content}
            speaking={speakingId === m.id}
            typing={m.sender_type === 'ai' && (m.id as number) < 0 && !m.content && !m.reasoning}
            streaming={(m.id as number) < 0}
            hideReasoning={hideReasoning}
            onSpeak={() => speak(m)}
            onReasoningCopied={() => showToast(t('toast.reasoningCopied'))}
            onQuickMemory={(text) => handleQuickMemory(m, text)}
            onForward={(msg) => openForwardPicker(msg)}
            onEdit={(msg) => { setEditMsg(msg); setInput(msg.content); }}
            onRollback={(msgId) => handleRollback(msgId)}
            onRecall={(msgId) => handleRecall(msgId)}
            onCopy={(text) => { navigator.clipboard.writeText(text); showToast(t('toast.copied')); }}
            roleMood={chatType === 'group' && m.sender_type === 'ai' ? groupMoods[m.sender_name] : undefined}
          />
        ))}
        {failed && (
          <div className="msg-row user" style={{ alignSelf: 'flex-end' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: '#e06c75',
                background: 'var(--color-panel)',
                border: '1px solid #e06c75',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 10px',
              }}
            >
              <span title={failed.error}>⚠ {t('chat.sendFailedShort')}</span>
              <button
                className="btn-ghost"
                style={{ padding: '2px 10px', fontSize: 12, color: 'var(--color-primary)' }}
                disabled={sending}
                onClick={resend}
              >
                ↻ {t('chat.resend')}
              </button>
            </div>
          </div>
        )}
      </CustomScrollArea>

      {roleMissing && (
        <div className="alert-bar alert-danger">⛔ {t('chat.roleDeleted')}</div>
      )}

      <div className="composer" style={{ position: 'relative' }} onClick={() => inputRef.current?.focus()}>
        {pendingImages.length > 0 && (
          <div className="img-preview-bar">
            {pendingImages.map((p, i) => (
              <PendingImageThumb
                key={i}
                path={p}
                onRemove={() => setPendingImages((arr) => arr.filter((_, idx) => idx !== i))}
              />
            ))}
          </div>
        )}
        <button
          className={`scroll-to-bottom${showScrollBtn ? ' visible' : ''}`}
          onClick={scrollToBottom}
          title={t('chat.scrollToBottom')}
        >
          ⬇ {t('chat.scrollToBottom')}
        </button>
        {showMention && members.length > 0 && (
          <div className="mention-pop">
            {members.map((r) => (
              <div key={r.id} className="item" onClick={() => insertMention(r)}>
                @{r.name}
              </div>
            ))}
          </div>
        )}
        <div className="toolbar">
          <button className="tool-btn" title={t('chat.sendImage')} onClick={pickImage}>
            📷
          </button>
          {chatType === 'group' && (
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('chat.mentionHint')}
            </span>
          )}
        </div>
        <textarea
          key={`${chatType}:${chatId}:${refreshNonce}`}
          ref={inputRef}
          value={input}
          placeholder={t('chat.placeholder')}
          readOnly={roleMissing}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="send-row">
          {editMsg && (
            <span className="edit-hint">
              ✏️ {t('msg.edit')} {editMsg.content.slice(0, 30)}...
              <button className="btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} onClick={() => { setEditMsg(null); setInput(''); }}>
                {t('msg.editCancel')}
              </button>
            </span>
          )}
          <button className="btn-primary" disabled={sending || roleMissing} onClick={send}>
            {sending ? t('chat.sending') : t('chat.send')}
          </button>
        </div>
      </div>

      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <img className="image-preview" src={preview} alt={t('chat.preview')} />
        </div>
      )}
      {affinityPop && <div className="affinity-pop">{affinityPop}</div>}
      {(eventState || eventLoading) && (
        <RandomEventModal
          event={eventState}
          loading={eventLoading && !eventState}
          onChoose={(opt) => chooseOption(opt)}
          onAutoChoose={(opt) => chooseOption(opt, true)}
          onClose={() => {
            setEventState(null);
            setEventLoading(false);
            void api.eventClosed({ chatType, chatId });
          }}
        />
      )}
      {showGroupEditor && (
        <GroupEditor
          group={{
            group_id: chatId,
            group_name: name,
            member_ids: members.map((m) => m.id).join(','),
            created_at: '',
          }}
          onClose={closeGroupEditorLocked}
          onUpdated={onGroupEditorUpdatedLocked}
        />
      )}
      {showObserverPanel && (
        <div className="modal-mask" onClick={() => setShowObserverPanel(false)}>
          <div className="modal obs-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>🔭 {t('observer.panel')}</span>
              <span className="modal-close" onClick={() => setShowObserverPanel(false)}>
                ×
              </span>
            </div>
            <div className="modal-body">
              <div className="obs-panel-hint">{t('observer.panelTip')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {observerMembers.map((r) => (
                  <div key={r.id} className="obs-member-row">
                    <span className="obs-member-name">{r.name}</span>
                    <span className="obs-member-mood">💭 {r.mood || t('observer.moodCalm')}</span>
                    <span className="obs-member-affinity">
                      {t('observer.affinity')} {r.affinity}
                    </span>
                  </div>
                ))}
                {observerMembers.length === 0 && (
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                    —
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 转发选择器 */}
      {showForwardPicker && (
        <div className="modal-mask" onClick={() => { setShowForwardPicker(false); setForwardMsg(null); }}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{t('msg.forwardPick')}</span>
              <span className="modal-close" onClick={() => { setShowForwardPicker(false); setForwardMsg(null); }}>×</span>
            </div>
            <div className="modal-body" style={{ maxHeight: 360, overflowY: 'auto' }}>
              {forwardChats.length === 0 && <div style={{ color: 'var(--color-text-secondary)' }}>—</div>}
              {forwardChats.map((c) => (
                <button key={`${c.chat_type}:${c.chat_id}`} className="forward-item"
                  onClick={() => handleForward(c.chat_type, c.chat_id, c.name)}
                >
                  {c.chat_type === 'group' ? '👥 ' : '👤 '}{c.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* 背景裁剪 */}
      {bgCrop.open && (
        <ImageCropper
          src={bgCrop.src}
          outputSize={600}
          title={t('chat.cropBgTitle')}
          hint={t('chat.cropBgHint')}
          previewShape="square"
          onClose={() => setBgCrop({ open: false, src: '' })}
          onCrop={onBgCrop}
        />
      )}
      <ToastView toast={toast} />
    </div>
  );
};

const MessageRow: React.FC<{
  msg: ChatMessage;
  onImage: (src: string) => void;
  fmtTime: (iso: string) => string;
  modelName?: string;
  avatarPath?: string;
  userAvatarPath?: string;
  showTts?: boolean;
  speaking?: boolean;
  typing?: boolean;
  streaming?: boolean;
  hideReasoning?: boolean;
  onSpeak?: () => void;
  onReasoningCopied?: () => void;
  onQuickMemory?: (text: string) => void;
  onForward?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  onRollback?: (msgId: number) => void;
  onRecall?: (msgId: number) => void;
  onCopy?: (text: string) => void;
  roleMood?: string;
}> = ({
  msg, onImage, fmtTime, modelName, avatarPath, userAvatarPath, showTts, speaking, typing, streaming, hideReasoning, onSpeak, onReasoningCopied,
  onQuickMemory, onForward, onEdit, onRollback, onRecall, onCopy, roleMood,
}) => {
  const { t } = useI18n();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selPopup, setSelPopup] = useState<{ x: number; y: number; text: string } | null>(null);
  const recalled = msg.status === 'recalled';
  const failed = msg.status === 'failed';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => { setMenuPos(null); setSelPopup(null); };

  // 在气泡内检测文字选中
  const handleMouseUp = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 0 && onQuickMemory) {
      setSelPopup({ x: e.clientX, y: e.clientY, text });
    } else {
      setSelPopup(null);
    }
  };

  // 全局点击关闭菜单
  useEffect(() => {
    if (!menuPos && !selPopup) return;
    const h = () => { setMenuPos(null); setSelPopup(null); };
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [menuPos, selPopup]);

  const handleCopy = () => {
    onCopy?.(msg.content);
    closeMenu();
  };
  const handleQuickMemory = (text: string) => {
    onQuickMemory?.(text);
    setSelPopup(null);
    closeMenu();
  };
  const handleForward = () => { onForward?.(msg); closeMenu(); };
  const handleEdit = () => { onEdit?.(msg); closeMenu(); };
  const handleRollback = () => { onRollback?.(msg.id); closeMenu(); };
  const handleRecall = () => { onRecall?.(msg.id); closeMenu(); };

  if (msg.sender_type === 'system') {
    return <div className="system-msg">{msg.content}</div>;
  }
  const isUser = msg.sender_type === 'user';
  // 多图优先：image_path 兼容旧单图数据；images 为新的多图数组
  const imgs = msg.images && msg.images.length ? msg.images : msg.image_path ? [msg.image_path] : [];
  const hasText = !!(msg.content && msg.content.trim());

  // 已撤回或失败消息特殊渲染
  if (recalled) {
    return (
      <div className="msg-row system" style={{ textAlign: 'center' }}>
        <span className="recalled-tag">↩ {t('msg.recalled')}</span>
      </div>
    );
  }

  return (
    <div className={`msg-row ${isUser ? 'user' : 'ai'}`} style={{ position: 'relative' }} onContextMenu={handleContextMenu}>
      <div className="avatar">
        {isUser
          ? (userAvatarPath ? <AvatarImg path={userAvatarPath} /> : '🙂')
          : avatarPath ? <AvatarImg path={avatarPath} /> : '🤖'}
      </div>
      <div>
        {!isUser && (
          <div className="sender">
            {msg.sender_name}
            {roleMood && <span className="mood-tag">· {roleMood}</span>}
            {modelName && (
              <span className="model-tag">{t('chat.modelTag', { name: modelName })}</span>
            )}
          </div>
        )}
        {typing ? (
          <div className="bubble" onMouseUp={handleMouseUp}>
            <div className="typing" aria-label={t('chat.replying')}>
              <span className="typing-bar" />
            </div>
          </div>
        ) : (
          <>
            {hasText && (
              <div className={`bubble ${failed ? 'bubble-failed' : ''}`} onMouseUp={handleMouseUp}>
                {!isUser && msg.reasoning && (
                  <ReasoningBlock
                    reasoning={msg.reasoning}
                    defaultOpen={hideReasoning === false || (!!streaming && !msg.content)}
                    streaming={!!streaming && !msg.content}
                    onCopied={onReasoningCopied}
                  />
                )}
                {renderMarkdown(msg.content)}
              </div>
            )}
            {imgs.length > 0 && <ImageGrid paths={imgs} onImage={onImage} failed={failed} />}
            {failed && !hasText && imgs.length === 0 && (
              <span style={{ color: '#e74c3c' }}>{t('msg.resendTip')}</span>
            )}
          </>
        )}
        <div className="msg-meta">
          <span>{fmtTime(msg.timestamp)}</span>
          {failed && (
            <a onClick={handleEdit} style={{ cursor: 'pointer', color: '#e74c3c', marginLeft: 8 }}>
              {t('msg.resend')}
            </a>
          )}
          {!isUser && msg.token_used > 0 && (
            <span>{t('chat.tokensUsed', { n: msg.token_used })}</span>
          )}
          {showTts && (
            <a onClick={onSpeak} style={{ cursor: 'pointer', userSelect: 'none' }} title={speaking ? t('chat.ttsStop') : t('chat.ttsPlay')}>
              {speaking ? '⏹' : '🔊'}
            </a>
          )}
        </div>
      </div>
      {/* 右键菜单：Portal 到 body，脱离 .app-root 的 transform/filter 包含块，避免 fixed 坐标相对祖先偏移 */}
      {menuPos && createPortal(
        <div
          className="ctx-menu"
          style={{
            position: 'fixed',
            left: Math.min(menuPos.x, window.innerWidth - 160),
            top: Math.min(menuPos.y, window.innerHeight - 200),
            zIndex: 300,
          }}
        >
          <button className="ctx-menu-item" onClick={handleCopy}>{t('msg.copy')}</button>
          {onQuickMemory && <button className="ctx-menu-item" onClick={() => handleQuickMemory(msg.content)}>{t('msg.quickMemory')}</button>}
          {onForward && <button className="ctx-menu-item" onClick={handleForward}>{t('msg.forward')}</button>}
          {isUser && onEdit && <button className="ctx-menu-item" onClick={handleEdit}>{t('msg.edit')}</button>}
          {onRollback && <button className="ctx-menu-item ctx-menu-danger" onClick={handleRollback}>{t('msg.rollback')}</button>}
          {onRecall && <button className="ctx-menu-item ctx-menu-danger" onClick={handleRecall}>{t('msg.recall')}</button>}
        </div>,
        document.body
      )}
      {/* 文字选中一键记忆弹窗 */}
      {selPopup && onQuickMemory && createPortal(
        <div
          className="sel-popup"
          style={{
            position: 'fixed',
            left: Math.min(selPopup.x, window.innerWidth - 160),
            top: selPopup.y + 16,
            zIndex: 300,
          }}
        >
          <button className="sel-popup-btn" onClick={() => handleQuickMemory(selPopup.text)}>
            🧠 {t('msg.quickMemory')}
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};
