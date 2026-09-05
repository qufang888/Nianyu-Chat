import React, { useEffect, useRef, useState, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { ChatListItem, ChatMessage, ChatType, Role, SelfRole, WorldBook } from '../types';

// 联网搜索结果项（后端 search:results 广播的结构，前端仅用于折叠展示）
interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}
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
import { useVoiceInput } from '../hooks/useVoiceInput';
import { EVENT_COOLDOWN_MS, EVENT_TRIGGER_THRESHOLD } from '../eventThemes';
import { getEventStore, setEventStore } from '../utils/eventStore';
import { setIdleActivity } from '../utils/idleTimerStore';
import CustomScrollArea from './CustomScrollArea';
import { ClearChatModal } from './ClearChatModal';
import { MessageSearch } from './MessageSearch';
import { BondPanel } from './BondPanel';

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
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  const [preview, setPreview] = useState<string | null>(null);
  const [affinityPop, setAffinityPop] = useState<string | null>(null);
  const [translateModal, setTranslateModal] = useState<{ source: string; text?: string; loading?: boolean; error?: string } | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genTyping, setGenTyping] = useState(false); // 生图期间在聊天框显示「AI 正在回复」动画（用户不会看到自己的生图指令）
  const [genVideoOpen, setGenVideoOpen] = useState(false); // 生视频弹窗
  const [genVideoText, setGenVideoText] = useState('');
  const [aiCompleteLoading, setAiCompleteLoading] = useState(false); // AI 补全提示词中
  const [promptView, setPromptView] = useState<string | null>(null); // 查看提示词弹窗
  const [showMention, setShowMention] = useState(false);
  // 消息查找（🔍）与关系值（💞）面板开关
  const [searchOpen, setSearchOpen] = useState(false);
  const [bondOpen, setBondOpen] = useState(false);
  const [globalTokens, setGlobalTokens] = useState(0);
  // 请求限速（QPS）预排队：超限时输入框保留文本、显示倒计时、可取消，倒计时结束自动发送
  const [queue, setQueue] = useState<{ waitMs: number; startedAt: number } | null>(null);
  const [queueLeft, setQueueLeft] = useState(0);
  // 语音转文字：识别文本送入输入框（不自动发送），由用户手动发送
  const voice = useVoiceInput(
    (text) => {
      setInput((prev) => (prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? prev + ' ' : prev) + text);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    (msg) => showToast(t('chat.voiceFailed', { msg }))
  );
  // 自适应故事线：开关 / 节点列表 / 侧栏
  const [storyOn, setStoryOn] = useState(false);
  const [storyNodes, setStoryNodes] = useState<{ id: number; msg_id: number; title: string; timestamp: string }[]>([]);
  const [showStories, setShowStories] = useState(false);
  useEffect(() => {
    api.getStoryEnabled(chatType, chatId).then(setStoryOn);
    api.listStoryNodes(chatType, chatId).then(setStoryNodes);
  }, [chatType, chatId]);
  const toggleStory = async () => {
    const next = !storyOn;
    setStoryOn(next);
    await api.setStoryEnabled(chatType, chatId, next);
  };
  const markNode = async (msg: ChatMessage) => {
    const title = (msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 30) || t('chat.stories');
    await api.addStoryNode(chatType, chatId, msg.id, title);
    setStoryNodes(await api.listStoryNodes(chatType, chatId));
    showToast(t('chat.markNode'));
  };
  const gotoNode = (msgId: number) => {
    const el = document.querySelector(`[data-mid="${msgId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const removeNode = async (id: number) => {
    await api.removeStoryNode(id);
    setStoryNodes(await api.listStoryNodes(chatType, chatId));
  };
  const [clearOpen, setClearOpen] = useState(false);
  const [modelMap, setModelMap] = useState<Record<string, string>>({});
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  // 长记忆（per-chat 独立开关）：开启后该聊天「其他操作」中出现「AI 总结记忆」按钮
  const [longMemoryOn, setLongMemoryOn] = useState(false);
  const [longMemoryMap, setLongMemoryMap] = useState<Record<string, boolean>>({});
  // 已读未读：聊天气泡的「● 未读」徽章 / 未读分隔线 / 侧栏未读角标已按用户要求移除。
  // 水位线（readWatermark）仅在主进程后台记录（悬浮球未读与统计不依赖它），界面不再消费。
  const [summarizing, setSummarizing] = useState(false);
  // 长记忆 10 轮自动提炼计数器：当前聊天累计用户消息轮数（满 10 触发）
  const [autoMemRound, setAutoMemRound] = useState(0);
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
  const [groupSelectReply, setGroupSelectReply] = useState(false);
  // 群聊选人回复：主进程广播「请选择下一位发言者」时弹出浮层
  const [needSpeaker, setNeedSpeaker] = useState<{ chatId: string; members: { id: string; name: string; avatar?: string }[] } | null>(null);
  // 群聊消息可见性 / 记忆开关（用户发出的消息与选人回复生成的 AI 消息共用）
  const [replyVisible, setReplyVisible] = useState(true);
  const [replyToMemory, setReplyToMemory] = useState(true);
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
  // 本对话独立开关：异步场景生图 / 联网搜索（主界面与小窗共用同一份数据，经 settings:changed 同步，不会出现一端开一端关）
  const [sceneImageOn, setSceneImageOn] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(false);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  // 联网搜索结果：按 streamId 分桶，每条 AI 回复独立拥有自己的折叠气泡（不在全聊共享一个气泡）
  const [searchResultsByStream, setSearchResultsByStream] = useState<Record<string, SearchResultItem[]>>({});
  const [expandedStreams, setExpandedStreams] = useState<Record<string, boolean>>({});
  // 检索在流式开始前完成，先把结果暂存为 pending；首个 stream:start 将其挂到对应消息的 streamId
  const pendingSearchRef = useRef<SearchResultItem[] | null>(null);
  // 已完成的 AI 消息 id -> streamId 映射，用于历史消息继续显示其搜索气泡
  const streamMsgIdRef = useRef<Record<string, string>>({});
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
      showToast(t('group.editLockedTip'), { error: true });
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
      const rid = chatType === 'single' ? await api.resolveRoleId(chatType, chatId) : ev.roleId;
      const r = await api.getRole(rid);
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

  // 主动消息计时基准：进入聊天时初始化/继承，计时与触发统一交给主进程。
  // 主界面关闭到托盘时窗口仅 hide，渲染进程的 setInterval 会被浏览器节流乃至冻结，
  // 过去由渲染端触发会出现「不打开窗口就不来消息、一打开才姗姗来迟」。现在渲染端只负责显示。
  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatType, chatId]);

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
      // 随机模式初值取范围中点（后续以主进程广播的实际抽中间隔为准）
      idleSecondsRef.current =
        settings.idleTimingMode === 'random'
          ? Math.round(((settings.idleRandomMinSec ?? 60) + (settings.idleRandomMaxSec ?? 1800)) / 2)
          : settings.idleInterval || 600;
      idleSwitchActionRef.current = settings.idleSwitchAction || 'pause';
      setGroupAutoChain(settings.groupAutoChain !== false);
      setGroupSelectReply(!!settings.groupSelectReply);
      setVoiceCfg({
        asr: !!(settings.voice?.asrBaseUrl && settings.voice?.asrApiKey),
        tts: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey),
        auto: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey) && !!settings.voice?.ttsAutoPlay,
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
      // 本对话独立开关：场景生图 / 联网搜索
      setSceneImageOn(!!settings.autoSceneImageChats?.[bgKey]);
      setWebSearchOn(!!settings.webSearchChats?.[bgKey]);
      // 长记忆（per-chat 独立开关）
      setLongMemoryMap(settings.longMemory || {});
      setLongMemoryOn(!!settings.longMemory?.[bgKey]);
      setAutoMemRound((settings.autoMemRoundCount || {})[bgKey] ?? 0);
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

  // 长记忆：per-chat 独立开关切换
  const toggleLongMemory = async (next: boolean) => {
    const map = { ...longMemoryMap, [bgKey]: next };
    setLongMemoryMap(map);
    setLongMemoryOn(next);
    await api.saveSettings({ longMemory: map });
  };

  // 长记忆：手动让 AI 总结记忆（受 longMemory 开关门控，调用默认模型、受 QPS 约束）
  const handleSummarize = async () => {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const res = await api.summarizeMemories(chatType, chatId);
      showToast(res.message, !res.ok);
    } catch (e: any) {
      showToast(t('chat.summarizeFail', { msg: e?.message || String(e) }), true);
    } finally {
      setSummarizing(false);
    }
  };

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
    window.addEventListener('keydown', onKeyDown, { error: true }); // capture 阶段拦截
    return () => window.removeEventListener('keydown', onKeyDown, { error: true });
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
        const rid = await api.resolveRoleId(chatType, chatId);
        const r = await api.getRole(rid);
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
  }, [chatType, chatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (!existing) {
          // 未收到 stream:start，或切换聊天后本地占位已被清空：忽略中途 chunk，
          // 避免生成孤立/不完整的占位气泡；最终消息仍由 stream:done 落库后显示。
          return prev;
        }
        const next: ChatMessage = {
          ...existing,
          content: existing.content + (data.content || ''),
          reasoning: (existing.reasoning || '') + (data.reasoning || '') || undefined,
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
        // 记录 消息id -> streamId，让已完成的回复在历史中仍显示自己的搜索气泡
        if (data.message.id != null) streamMsgIdRef.current[String(data.message.id)] = data.streamId;
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
      // 检索在流式开始前已完成：把暂存的搜索结果挂到本消息的 streamId（每条回复独立气泡，仅首个成员消费）
      if (pendingSearchRef.current) {
        const payload = pendingSearchRef.current;
        pendingSearchRef.current = null;
        setSearchResultsByStream((prev) => ({ ...prev, [data.streamId]: payload }));
      }
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
          streamId: data.streamId,
        } as any;
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
        // 随机模式：主进程随广播下发本聊天下一次触发间隔，倒计时据此显示
        if (typeof data.intervalMs === 'number' && data.intervalMs > 0) {
          idleSecondsRef.current = Math.round(data.intervalMs / 1000);
        }
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

  // 群聊选人回复：主进程广播「请选择下一位发言者」，弹出选人浮层
  useEffect(() => {
    const off = api.onNeedSpeaker((data) => {
      if (!data || data.chatId !== chatId) return;
      setNeedSpeaker(data);
    });
    return off;
  }, [chatId]);

  // 设置变更广播同步：主窗与小窗的世界书/身份/背景/开关保持一致
  // 统一重派生：任意设置变更都从最新 settings 重算所有本地开关，杜绝字段遗漏（如 groupAutoChain）
  useEffect(() => {
    const off = api.onSettingsChanged(async (_e, patch: Record<string, any>) => {
      if (!patch) return;
      const settings = await api.getSettings();
      const key = bgKey;
      setEnableStreaming(!!settings.enableStreaming);
      autoMemoryRef.current = !!settings.enableAutoMemory;
      setHideReasoning(settings.hideReasoning !== false);
      setEnableRandomEvents(settings.enableRandomEvents !== false);
      // 主动消息：全局主开关 × 当前聊天单独开关
      const globalOn = settings.idleEnabled !== false;
      const perChat = (settings.chatIdleEnabled || {})[key];
      const eff = globalOn && (perChat === undefined ? true : perChat);
      setIdleReplyOn(eff);
      idleReplyOnRef.current = eff;
      // 随机模式初值取范围中点（后续以主进程广播的实际抽中间隔为准）
      idleSecondsRef.current =
        settings.idleTimingMode === 'random'
          ? Math.round(((settings.idleRandomMinSec ?? 60) + (settings.idleRandomMaxSec ?? 1800)) / 2)
          : settings.idleInterval || 600;
      idleSwitchActionRef.current = settings.idleSwitchAction || 'pause';
      setGroupAutoChain(settings.groupAutoChain !== false);
      setGroupSelectReply(!!settings.groupSelectReply);
      setVoiceCfg({
        asr: !!(settings.voice?.asrBaseUrl && settings.voice?.asrApiKey),
        tts: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey),
        auto: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey) && !!settings.voice?.ttsAutoPlay,
      });
      // 按聊天覆盖的设置（以 bgKey 为维度）
      setChatWorldBookId((settings.chatWorldBooks || {})[key] ?? '');
      setSceneImageOn(!!(settings.autoSceneImageChats || {})[key]);
      setWebSearchOn(!!(settings.webSearchChats || {})[key]);
      setAutoMemRound((settings.autoMemRoundCount || {})[key] ?? 0);
      setSelfRoleId((settings.chatSelfRoles || {})[key] ?? 'default');
      const bgPath = (settings.chatBackgrounds || {})[key];
      if (bgPath) {
        api.getImage(bgPath).then((src) => setChatBg(src));
      } else {
        setChatBg(null);
      }
    });
    return off;
  }, [bgKey]);

  // 联网搜索状态：仅关心当前聊天，用于在小窗/主界面提示「搜索中…」
  useEffect(() => {
    const off = api.onSearchStatus((_e, data: any) => {
      if (!data || data.chatType !== chatType || data.chatId !== chatId) return;
      if (data.status === 'searching') {
        setSearchStatus('searching');
      } else if (data.status === 'done') {
        setSearchStatus('done');
        setTimeout(() => setSearchStatus('idle'), 2500);
      } else if (data.status === 'failed') {
        setSearchStatus('failed');
        setTimeout(() => setSearchStatus('idle'), 2500);
      }
    });
    return off;
  }, [chatType, chatId]);

  // 联网搜索结果：仅关心当前聊天；按每条回复独立展示，切换对话时清空重置
  useEffect(() => {
    setSearchResultsByStream({});
    setExpandedStreams({});
    pendingSearchRef.current = null;
    streamMsgIdRef.current = {};
    const off = api.onSearchResults((_e, data: any) => {
      if (!data || data.chatType !== chatType || data.chatId !== chatId) return;
      const incoming: SearchResultItem[] = Array.isArray(data.results) ? data.results : [];
      if (!incoming.length) return;
      // 暂存：检索在流式开始前完成，等首个 stream:start 再挂到对应消息，实现「每条回复独立气泡」
      pendingSearchRef.current = incoming;
    });
    return off;
  }, [chatType, chatId]);

  // 窗口间同步：故事线开关变更（一端开/关，另一端实时刷新）
  useEffect(() => {
    const off = api.onStoryChanged((_e, data) => {
      if (data.chatType !== chatType || data.chatId !== chatId) return;
      setStoryOn(data.enabled);
    });
    return off;
  }, [chatType, chatId]);

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

  // 挂载即同步当前自动接话状态：若主进程已有 driver（如主窗先于小窗开启自动接话），
  // 本窗口立即进入「运行中」显示态，避免卡在「非自动接话」状态导致按钮/轮数不同步或误触驱动。
  useEffect(() => {
    let alive = true;
    api.getAutoChatState(chatId).then((s) => {
      if (alive && s?.active) {
        setAutoChat(true);
        setAutoRound(0);
      }
    }).catch(() => {});
    return () => { alive = false; };
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
    window.addEventListener('scroll', close, { error: true });
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, { error: true });
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

  // 解析一条消息应写入哪个角色的记忆（单聊取真实角色；群聊按 AI 发言名匹配成员）
  const getMemoryRoleId = async (m: ChatMessage): Promise<string> => {
    if (chatType === 'single') return await api.resolveRoleId(chatType, chatId);
    if (m.sender_type === 'ai') {
      const r = members.find((x) => x.name === m.sender_name);
      return r?.id || '';
    }
    return '';
  };

  const doGenerate = async () => {
    const prompt = genText.trim();
    if (!prompt) return;
    setGenLoading(true);
    setGenTyping(true); // 生成期间显示 AI 正在回复动画
    try {
      await api.generateImage(chatType, chatId, prompt);
      setGenOpen(false);
      setGenText('');
    } catch (e: any) {
      showToast(e?.message || t('chat.drawFailed'));
    } finally {
      setGenLoading(false);
      setGenTyping(false);
    }
  };

  // AI 自动补全提示词：把用户在生图/生视频弹窗里写的粗略想法，交给默认模型扩展成完整提示词
  const doAutocomplete = async (type: 'image' | 'video') => {
    const base = type === 'image' ? genText : genVideoText;
    if (!base.trim()) {
      showToast(t('chat.genNeedPrompt'));
      return;
    }
    setAiCompleteLoading(true);
    try {
      const r = await api.autocompletePrompt(type, base);
      if (r.rateLimited) {
        showToast(t('chat.aiCompleteRateLimited'));
        return;
      }
      if (!r.ok || !r.prompt) {
        showToast(r.error || t('chat.aiCompleteFailed'));
        return;
      }
      if (type === 'image') setGenText(r.prompt);
      else setGenVideoText(r.prompt);
    } catch (e: any) {
      showToast(e?.message || t('chat.aiCompleteFailed'));
    } finally {
      setAiCompleteLoading(false);
    }
  };

  // 生视频：非阻塞——立即返回，进度由全局悬浮气泡（video:progress/video:done）展示，完成后自动插入 AI 视频消息
  const doGenerateVideo = async () => {
    const prompt = genVideoText.trim();
    if (!prompt) return;
    setGenVideoOpen(false);
    setGenVideoText('');
    try {
      await api.generateVideo(chatType, chatId, prompt);
    } catch (e: any) {
      showToast(e?.message || t('chat.genVideoFailed'));
    }
  };

  // F4：发送图片 + 文字提示词 → 据此生图 / 生视频（只发图片无提示词则无效）
  const doGenerateFromImage = async (kind: 'image' | 'video') => {
    const text = input.trim();
    if (!text) {
      showToast(t('chat.genNeedPrompt'));
      return;
    }
    if (pendingImages.length === 0) return;
    const img = pendingImages[0];
    setPendingImages([]);
    setInput('');
    if (kind === 'video') {
      // 非阻塞：生成在后台进行，进度由悬浮气泡展示，无需等待
      try {
        await api.generateImageFromImage(chatType, chatId, text, img, kind);
      } catch (e: any) {
        showToast(e?.message || t('chat.genVideoFailed'));
      }
      return;
    }
    setGenLoading(true);
    setGenTyping(true);
    try {
      const res = await api.generateImageFromImage(chatType, chatId, text, img, kind);
      if (!res.ok) showToast(t('chat.drawFailed'));
    } catch (e: any) {
      showToast(e?.message || t('chat.drawFailed'));
    } finally {
      setGenLoading(false);
      setGenTyping(false);
    }
  };

  // F1：群聊选人回复 —— 用户点击某成员，驱动该成员接话（可带可见性 / 记忆选项）
  const pickSpeaker = async (roleId: string) => {
    const data = needSpeaker;
    setNeedSpeaker(null);
    if (!data) return;
    try {
      await api.groupContinue({
        chatId,
        forceRoleId: roleId,
        visibleToGroup: replyVisible,
        toMemory: replyVisible ? replyToMemory : false,
      });
    } catch (e: any) {
      showToast(e?.message || t('chat.genNeedPrompt'));
    }
  };

  // 手动把图片存进角色记忆（AI 不会自动保存图片记忆）
  const handleSaveImageMemory = async (m: ChatMessage) => {
    const imgs = m.images && m.images.length ? m.images : m.image_path ? [m.image_path] : [];
    if (!imgs.length) return;
    const roleId = await getMemoryRoleId(m);
    if (!roleId) {
      showToast(t('chat.drawMemoryNoRole'));
      return;
    }
    await api.saveImageMemory({ roleId, imagePath: imgs[0] });
    showToast(t('chat.drawMemorySaved'));
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
      showToast(t('chat.sendFailedShort'), { error: true });
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
    if (!fname) { showToast(t('common.failed'), { error: true }); return; }
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

  // 本对话独立开关：异步场景生图
  const toggleSceneImage = async (v: boolean) => {
    setSceneImageOn(v);
    const settings = await api.getSettings();
    const next = { ...(settings.autoSceneImageChats || {}) };
    if (v) next[bgKey] = true;
    else delete next[bgKey];
    await api.saveSettings({ autoSceneImageChats: next });
    showToast(t(v ? 'chat.sceneImageOn' : 'chat.sceneImageOff'), { duration: 2000, animation: 'linear' });
  };

  // 本对话独立开关：联网搜索
  const toggleWebSearch = async (v: boolean) => {
    setWebSearchOn(v);
    const settings = await api.getSettings();
    const next = { ...(settings.webSearchChats || {}) };
    if (v) next[bgKey] = true;
    else delete next[bgKey];
    await api.saveSettings({ webSearchChats: next });
    showToast(t(v ? 'chat.webSearchOn' : 'chat.webSearchOff'), { duration: 2000, animation: 'linear' });
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
    pendingSearchRef.current = null;
    let userSent = phase === 'ai';
    try {
      if (enableStreaming && phase === 'full') {
        const { userMessage, members: streamMembers } = await api.startStream({
          chatType,
          chatId,
          content,
          imagePaths,
          visibleToGroup: replyVisible,
          toMemory: replyVisible ? replyToMemory : false,
        });
        setMessages((prev) => [...prev, userMessage]);
        // 用后端 streamId 立即落占位，保证气泡在首字到达前就出现
        const init: Record<string, ChatMessage> = {};
        for (const mb of streamMembers) init[mb.streamId] = makePlaceholder(mb.roleName);
        setStreamingMsgs((prev) => ({ ...prev, ...init }));
        // 选人回复：后端 handleSend 已提前返回并广播 needSpeaker，此处同步弹出选人浮层
        if (chatType === 'group' && groupSelectReply) {
          setNeedSpeaker({ chatId, members: members.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_path })) });
        }
      } else {
        if (phase === 'full') {
          const userMessage = await api.sendUserMessage({
            chatType,
            chatId,
            content,
            imagePaths,
            visibleToGroup: replyVisible,
            toMemory: replyVisible ? replyToMemory : false,
          });
          setMessages((prev) => [...prev, userMessage]);
          userSent = true;
          // 选人回复：不自动生成 AI 回复，交由前端弹窗选择下一位发言者
          if (chatType === 'group' && groupSelectReply) {
            setNeedSpeaker({ chatId, members: members.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_path })) });
            onSent();
            return;
          }
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

  const doSend = async (overrideText?: string, overrideImgs?: string[]) => {
    const text = (overrideText ?? input).trim();
    const imgs = overrideImgs ?? pendingImages;
    if (!text && imgs.length === 0) return;
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

  const send = async () => {
    if (roleMissing) return; // 单聊角色已删除，禁止发送
    const text = input.trim();
    const imgs = pendingImages;
    if ((!text && imgs.length === 0) || sending) return;
    // 请求限速（QPS）：超限进入预排队，输入框保留文本、可编辑、倒计时后自动发送
    try {
      const modelId = await api.getChatModelId(chatType, chatId);
      if (modelId) {
        const info = await api.rateInfo(modelId);
        if (info.enabled && info.waitMs > 0) {
          setQueue({ waitMs: info.waitMs, startedAt: Date.now() });
          return;
        }
      }
    } catch {
      // 限速查询失败则按正常发送
    }
    await doSend();
  };

  // QPS 预排队倒计时：归零后清空队列并自动发送（使用当前输入框文本与待发图片）
  useEffect(() => {
    if (!queue) return;
    const tick = () => {
      const left = queue.waitMs - (Date.now() - queue.startedAt);
      if (left <= 0) {
        setQueue(null);
        void doSend(inputRef.current?.value, pendingImagesRef.current);
      } else {
        setQueueLeft(Math.ceil(left / 1000));
      }
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [queue]);

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
    await api.setGroupIgnoreConvert(chatId, { error: true });
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
      showToast(t('chat.autoAlreadyRunning'), { error: true });
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
      const src = await api.textToSpeech(msg.content, msg.role_id);
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => setSpeakingId((id) => (id === msg.id ? null : id));
      await audio.play();
    } catch (e: any) {
      setSpeakingId(null);
      showToast(t('chat.ttsFailed', { msg: e?.message || String(e) }), { error: true });
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

  const handleTranslate = async (text: string) => {
    setTranslateModal({ source: text, loading: true });
    try {
      const res = await api.translate(text);
      if (res.ok) setTranslateModal({ source: text, text: res.text || '' });
      else setTranslateModal({ source: text, error: res.error || t('msg.translateFailed') });
    } catch (e: any) {
      setTranslateModal({ source: text, error: e?.message || t('msg.translateFailed') });
    }
  };

  const totalTokens = messages.reduce((s, m) => s + (m.token_used || 0), 0);
  // 是否处于「对方正在回复」状态：发送中，或仍有流式占位气泡在飞
  const replying = sending || Object.keys(streamingMsgs).length > 0;
  // 模型正在输出（有流式占位气泡在飞）→ 发送按钮变打断按钮
  const isStreaming = Object.keys(streamingMsgs).length > 0;

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
          {chatType === 'single' && (
            <button
              className="btn-ghost"
              style={{ padding: '3px 10px', fontSize: 12 }}
              title={t('bond.title')}
              onClick={() => setBondOpen(true)}
            >
              💞 {t('bond.title')}
            </button>
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
                  color: 'var(--color-text)',
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
                  onClick={() => { toggleStory(); setMoreOpen(false); }}
                >📖 {storyOn ? t('chat.storyOff') : t('chat.storyOn')}</button>
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
                {/* 长记忆：per-chat 独立开关 + 手动让 AI 总结记忆 */}
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={longMemoryOn}
                    onChange={(e) => { toggleLongMemory(e.target.checked); }}
                  />
                  🧠 {t('chat.longMemory')}
                </label>
                {longMemoryOn && (
                  <div style={{ padding: '0 10px 4px', fontSize: 12, opacity: 0.7 }}>
                    {t('chat.longMemoryAutoHint', { n: autoMemRound, total: 10 })}
                  </div>
                )}
                {longMemoryOn && (
                  <button
                    className="tool-btn"
                    style={{ width: '100%', justifyContent: 'flex-start', padding: '6px 10px', fontSize: 13 }}
                    onClick={() => { handleSummarize(); setMoreOpen(false); }}
                    disabled={summarizing}
                  >
                    {summarizing ? `⏳ ${t('chat.summarizing')}` : `✨ ${t('chat.summarizeMemory')}`}
                  </button>
                )}
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

      {searchOpen && (
        <MessageSearch
          messages={allMessagesUnique}
          compact={false}
          onClose={() => setSearchOpen(false)}
          onJump={(msgId) => gotoNode(Number(msgId))}
        />
      )}

      <CustomScrollArea className="messages" scrollRef={scrollRef} style={chatBg ? { backgroundImage: `url(${chatBg})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
        {allMessages.length === 0 && (
          <div className="empty-state">
            <div style={{ fontSize: 32 }}>💭</div>
            <div>{t('chat.empty', { name })}</div>
          </div>
        )}
        {allMessagesUnique.map((m, i) => {
          const sid = (m as any).streamId || streamMsgIdRef.current[String(m.id)];
          const sr = sid ? searchResultsByStream[sid] : undefined;
          return (
            <Fragment key={m.id}>
              <MessageRow
                key={m.id}
                msg={m}
                onImage={setPreview}
                prevTimestamp={i > 0 ? allMessagesUnique[i - 1].timestamp : undefined}
                modelName={m.sender_type === 'ai' ? modelMap[m.sender_name] : undefined}
                avatarPath={m.sender_type === 'ai' ? avatarMap[m.sender_name] : undefined}
                userAvatarPath={userAvatarPath}
                showTts={voiceCfg.tts && m.sender_type === 'ai' && !!m.content}
                speaking={speakingId === m.id}
                typing={m.sender_type === 'ai' && (m.id as number) < 0 && !m.content && !m.reasoning?.trim()}
                streaming={(m.id as number) < 0}
                hideReasoning={hideReasoning}
                onSpeak={() => speak(m)}
                onReasoningCopied={() => showToast(t('toast.reasoningCopied'))}
                onQuickMemory={(text) => handleQuickMemory(m, text)}
                onSaveImageMemory={handleSaveImageMemory}
                onViewPrompt={(p) => setPromptView(p)}
                onForward={(msg) => openForwardPicker(msg)}
                onEdit={(msg) => { setEditMsg(msg); setInput(msg.content); }}
                onRollback={(msgId) => handleRollback(msgId)}
                onRecall={(msgId) => handleRecall(msgId)}
                onCopy={(text) => { navigator.clipboard.writeText(text); showToast(t('toast.copied')); }}
                onTranslate={handleTranslate}
                onMarkNode={storyOn ? markNode : undefined}
                roleMood={chatType === 'group' && m.sender_type === 'ai' ? groupMoods[m.sender_name] : undefined}
                searchResults={sr}
              />
              {sr && sr.length > 0 && (
                <div className="search-result-bubble" key={`sr-${m.id}`}>
                  <button
                    type="button"
                    className="srb-head"
                    onClick={() => setExpandedStreams((v) => ({ ...v, [sid]: !v[sid] }))}
                    title={t('chat.webSearchResultToggle')}
                  >
                    <span className="srb-icon">🌐</span>
                    <span className="srb-title">{t('chat.webSearchResultTitle', { n: sr.length })}</span>
                    <span className="srb-chevron">{expandedStreams[sid] ? '▾' : '▸'}</span>
                  </button>
                  {expandedStreams[sid] && (
                    <div className="srb-list">
                      {sr.map((r, i2) => (
                        <div
                          className="srb-item"
                          key={i2}
                          role="link"
                          tabIndex={0}
                          title={t('chat.webSearchResultToggle')}
                          onClick={() => (api as any).openExternal?.(r.url)}
                          onKeyDown={(e) => { if (e.key === 'Enter') (api as any).openExternal?.(r.url); }}
                        >
                          <div className="srb-item-head">
                            <span className="srb-item-idx">{i2 + 1}</span>
                            <div className="srb-item-title">{r.title}</div>
                          </div>
                          {r.snippet && <div className="srb-item-snippet">{r.snippet}</div>}
                          <div className="srb-item-url">{r.url}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
        {genTyping && (
          <div className="msg-row ai" style={{ opacity: 0.85 }}>
            <div className="avatar">🤖</div>
            <div>
              <div className="bubble">
                <div className="typing" aria-label={t('chat.replying')}>
                  <span className="typing-bar" />
                </div>
              </div>
            </div>
          </div>
        )}
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
        {queue && (
          <div className="qps-queue">
            <span className="qps-tip">⏳ {t('chat.rateLimited')}</span>
            <span className="qps-count">{t('chat.queueAutoSend', { sec: queueLeft })}</span>
            <button className="qps-cancel" onClick={() => setQueue(null)}>
              {t('chat.queueCancel')}
            </button>
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
          <button
            className={`tool-btn${voice.recording ? ' recording' : ''}`}
            title={voice.recording ? t('chat.voiceRecording') : t('chat.voiceInput')}
            onClick={voice.toggle}
          >
            {voice.recording ? '⏹' : '🎤'}
          </button>
          <button className="tool-btn" title={t('chat.sendImage')} onClick={pickImage}>
            📷
          </button>
          <button className="tool-btn" title={t('chat.drawImage')} onClick={() => setGenOpen(true)}>
            🎨
          </button>
          <button className="tool-btn" title={t('chat.drawVideo')} onClick={() => setGenVideoOpen(true)}>
            🎬
          </button>
          <button
            className={`tool-btn${sceneImageOn ? ' active' : ''}`}
            title={t('chat.sceneImageToggle')}
            onClick={() => toggleSceneImage(!sceneImageOn)}
          >
            🖼️
          </button>
          <button
            className={`tool-btn${webSearchOn ? ' active' : ''}`}
            title={
              searchStatus === 'searching'
                ? t('chat.searching')
                : searchStatus === 'failed'
                ? t('chat.searchFailed')
                : t('chat.webSearchToggle')
            }
            onClick={() => toggleWebSearch(!webSearchOn)}
          >
            {searchStatus === 'searching' ? '⏳' : '🌐'}
          </button>
          <button
            className={`tool-btn${searchOpen ? ' active' : ''}`}
            title={t('search.title')}
            onClick={() => setSearchOpen((o) => !o)}
          >
            🔍
          </button>
          <button
            className={`tool-btn${enableStreaming ? ' active' : ''}`}
            title={t('settings.enableStreaming')}
            onClick={() => {
              const next = !enableStreaming;
              setEnableStreaming(next);
              api.saveSettings({ enableStreaming: next });
              showToast(t(next ? 'settings.streamingEnabled' : 'settings.streamingDisabled'), {
                duration: 3000,
                animation: 'linear',
              });
            }}
          >
            🌊
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
          className="chat-input"
          value={input}
          placeholder={t('chat.placeholder')}
          readOnly={roleMissing}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              // 模型输出中禁止发送新消息（仅可打断），编辑输入框不受影响
              if (isStreaming) return;
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
          {/* F1：群聊消息可见性 / 记忆开关（仅群聊、非编辑态显示） */}
          {chatType === 'group' && !editMsg && (
            <span className="reply-flags">
              <label title={t('chat.visibleToGroupHint')}>
                <input
                  type="checkbox"
                  checked={replyVisible}
                  onChange={(e) => { setReplyVisible(e.target.checked); if (!e.target.checked) setReplyToMemory(false); }}
                />
                {t('chat.visibleToGroup')}
              </label>
              <label title={t('chat.toMemoryHint')} style={{ opacity: replyVisible ? 1 : 0.4 }}>
                <input
                  type="checkbox"
                  checked={replyToMemory}
                  disabled={!replyVisible}
                  onChange={(e) => setReplyToMemory(e.target.checked)}
                />
                {t('chat.toMemory')}
              </label>
            </span>
          )}
          {/* F4：发图生图 / 生视频（有附图且已输入提示词时显示） */}
          {pendingImages.length > 0 && input.trim() && (
            <span className="reply-flags">
              <button className="btn-ghost" disabled={sending} onClick={() => doGenerateFromImage('image')}>
                {t('chat.genImageFromImage')}
              </button>
              <button className="btn-ghost" disabled={sending} onClick={() => doGenerateFromImage('video')}>
                {t('chat.genVideoFromImage')}
              </button>
            </span>
          )}
          {isStreaming ? (
            <button
              className="btn-primary"
              onClick={() => api.interruptStream(chatId)}
              title={t('chat.interruptTip')}
              aria-label={t('chat.interrupt')}
            >
              <span className="interrupt-icon" />
            </button>
          ) : (
            <button className="btn-primary" disabled={sending || roleMissing} onClick={send}>
              {sending ? t('chat.sending') : t('chat.send')}
            </button>
          )}
        </div>
      </div>

      {genOpen && (
        <div className="modal-mask" onClick={() => !genLoading && setGenOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: '90%' }}>
            <div className="draw-input-panel">
              <div className="draw-title">{t('chat.drawImage')}</div>
              <div className="draw-desc">{t('chat.drawImageDesc')}</div>
              <textarea
                value={genText}
                onChange={(e) => setGenText(e.target.value)}
                placeholder={t('chat.drawPromptPlaceholder')}
                rows={4}
                disabled={genLoading}
                autoFocus
              />
            </div>
            {genLoading && <div style={{ padding: '8px 0', color: 'var(--color-text-secondary)' }}>{t('chat.generating')}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginTop: genLoading ? 0 : 8 }}>
              <button
                className="btn-ghost"
                disabled={genLoading || aiCompleteLoading || !genText.trim()}
                onClick={() => doAutocomplete('image')}
              >
                {aiCompleteLoading ? t('chat.aiCompleting') : t('chat.aiCompletePrompt')}
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-ghost" disabled={genLoading} onClick={() => setGenOpen(false)}>
                  {t('msg.editCancel')}
                </button>
                <button
                  className="btn-primary"
                  disabled={genLoading || !genText.trim()}
                  onClick={doGenerate}
                >
                  {t('chat.drawImage')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {genVideoOpen && (
        <div className="modal-mask" onClick={() => setGenVideoOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: '90%' }}>
            <div className="draw-input-panel">
              <div className="draw-title">{t('chat.drawVideo')}</div>
              <div className="draw-desc">{t('chat.drawVideoDesc')}</div>
              <textarea
                value={genVideoText}
                onChange={(e) => setGenVideoText(e.target.value)}
                placeholder={t('chat.drawVideoPlaceholder')}
                rows={4}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <button
                className="btn-ghost"
                disabled={aiCompleteLoading || !genVideoText.trim()}
                onClick={() => doAutocomplete('video')}
              >
                {aiCompleteLoading ? t('chat.aiCompleting') : t('chat.aiCompletePrompt')}
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-ghost" onClick={() => setGenVideoOpen(false)}>
                  {t('msg.editCancel')}
                </button>
                <button
                  className="btn-primary"
                  disabled={!genVideoText.trim()}
                  onClick={doGenerateVideo}
                >
                  {t('chat.drawVideo')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {needSpeaker && (
        <div className="modal-mask" onClick={() => setNeedSpeaker(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="draw-title">{t('chat.needSpeaker')}</div>
            <div className="draw-desc">{t('chat.selectReplyDesc')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
              {needSpeaker.members.map((m) => (
                <button key={m.id} className="speaker-item" onClick={() => pickSpeaker(m.id)}>
                  {m.avatar ? <AvatarImg path={m.avatar} /> : '🤖'}
                  <span>{m.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <img className="image-preview" src={preview} alt={t('chat.preview')} />
        </div>
      )}
      {promptView && (
        <div className="modal-mask" onClick={() => setPromptView(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '90%' }}>
            <div className="modal-head">
              <span>{t('msg.viewPrompt')}</span>
              <span className="modal-close" onClick={() => setPromptView(null)}>×</span>
            </div>
            <div className="modal-body">
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'var(--color-input-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '12px 14px',
                  fontSize: 14,
                  lineHeight: 1.6,
                }}
              >
                {promptView}
              </div>
            </div>
          </div>
        </div>
      )}
      {translateModal && (
        <div className="modal-mask" onClick={() => setTranslateModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '90%' }}>
            <div className="modal-title">{t('msg.translate')}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('msg.translateSource')}</div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto', padding: 8, background: 'var(--color-panel-alt)', borderRadius: 8, marginBottom: 10 }}>
              {translateModal.source}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('msg.translateResult')}</div>
            {translateModal.loading ? (
              <div style={{ padding: 8 }}>{t('chat.transcribing')}</div>
            ) : translateModal.error ? (
              <div style={{ color: '#e74c3c', padding: 8 }}>{translateModal.error}</div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto', padding: 8, background: 'var(--color-panel)', borderRadius: 8 }}>
                {translateModal.text}
              </div>
            )}
            <div style={{ textAlign: 'right', marginTop: 12 }}>
              <button className="btn-primary" onClick={() => setTranslateModal(null)}>{t('common.ok')}</button>
            </div>
          </div>
        </div>
      )}
      {affinityPop && <div className="affinity-pop">{affinityPop}</div>}
      {(eventState || eventLoading) && (
        <RandomEventModal
          event={eventState}
          loading={eventLoading && !eventState}
          onChoose={(opt) => chooseOption(opt)}
          onAutoChoose={(opt) => chooseOption(opt, { error: true })}
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
      {bondOpen && chatType === 'single' && (
        <BondPanel roleId={chatId} roleName={name} onClose={() => setBondOpen(false)} />
      )}
      <ToastView toast={toast} />
      {/* 自适应故事线：悬停自动弹出、移开收回的侧边栏（不占聊天区） */}
      {storyOn && (
        <div
          className="stories"
          onMouseEnter={() => setShowStories(true)}
          onMouseLeave={() => setShowStories(false)}
        >
          <div className="stories-tab" title={t('chat.stories')}>{t('chat.stories')}</div>
          {showStories && (
            <div className="stories-panel">
              <div className="stories-head">
                <span>{t('chat.stories')}</span>
                <span className="stories-count">{storyNodes.length}</span>
              </div>
              <div className="stories-list">
                {storyNodes.length === 0 ? (
                  <div className="stories-empty">{t('chat.noNodes')}</div>
                ) : (
                  storyNodes.map((n) => (
                    <div
                      key={n.id}
                      className="story-node"
                      onClick={() => gotoNode(n.msg_id)}
                      title={n.title}
                    >
                      <span className="story-title">{n.title}</span>
                      <button
                        className="story-del"
                        onClick={(e) => { e.stopPropagation(); removeNode(n.id); }}
                        title={t('msg.recall')}
                      >✕</button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const MessageRow: React.FC<{
  msg: ChatMessage;
  onImage: (src: string) => void;
  prevTimestamp?: string;
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
  onSaveImageMemory?: (msg: ChatMessage) => void;
  onViewPrompt?: (prompt: string) => void;
  onForward?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  onRollback?: (msgId: number) => void;
  onRecall?: (msgId: number) => void;
  onCopy?: (text: string) => void;
  onTranslate?: (text: string) => void;
  onMarkNode?: (msg: ChatMessage) => void;
  roleMood?: string;
  searchResults?: SearchResultItem[];
}> = ({
  msg, onImage, prevTimestamp, modelName, avatarPath, userAvatarPath, showTts, speaking, typing, streaming, hideReasoning, onSpeak, onReasoningCopied,
  onQuickMemory, onSaveImageMemory, onViewPrompt, onForward, onEdit, onRollback, onRecall, onCopy, onTranslate, onMarkNode, roleMood, searchResults,
}) => {
  const { t } = useI18n();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selPopup, setSelPopup] = useState<{ x: number; y: number; text: string } | null>(null);
  const recalled = msg.status === 'recalled';
  const failed = msg.status === 'failed';
  const isUser = msg.sender_type === 'user';

  // 发送时间（气泡上方）：同一分钟仅顶部消息显示；1 分钟内显示「刚刚」，否则精确到分钟
  const timeAbove = (() => {
    const d = new Date(msg.timestamp).getTime();
    if (isNaN(d)) return null;
    if (prevTimestamp) {
      const pd = new Date(prevTimestamp).getTime();
      if (!isNaN(pd) && Math.floor(d / 60000) === Math.floor(pd / 60000)) return null;
    }
    if (Date.now() - d < 60000) return t('msg.justNow');
    const dt = new Date(d);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  })();

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 跨气泡协调：通知其他气泡关闭各自的右键菜单，保证一个聊天界面同时只有一个菜单
    window.dispatchEvent(new CustomEvent('nianyu:closeCtxMenu', { detail: msg.id }));
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

  // 全局关闭菜单：左键点菜单外关闭；右键气泡交给 React onContextMenu 打开/重定位，不再在同事件里关闭导致二次右键失效；Esc 关闭
  useEffect(() => {
    if (!menuPos && !selPopup) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('.ctx-menu') || el.closest('.sel-popup'))) return;
      if (e.type === 'contextmenu' && el && el.closest('.msg-row')) return;
      setMenuPos(null);
      setSelPopup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuPos(null); setSelPopup(null); }
    };
    window.addEventListener('click', onDoc);
    window.addEventListener('contextmenu', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDoc);
      window.removeEventListener('contextmenu', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuPos, selPopup]);

  // 跨气泡菜单协调：收到其他气泡的打开通知时关闭本气泡菜单，确保整窗唯一
  useEffect(() => {
    const onCloseOthers = (ev: Event) => {
      const detail = (ev as CustomEvent<unknown>).detail;
      if (detail !== msg.id) { setMenuPos(null); setSelPopup(null); }
    };
    window.addEventListener('nianyu:closeCtxMenu', onCloseOthers);
    return () => window.removeEventListener('nianyu:closeCtxMenu', onCloseOthers);
  }, [msg.id]);

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
  // 多图优先：image_path 兼容旧单图数据；images 为新的多图数组
  const imgs = msg.images && msg.images.length ? msg.images : msg.image_path ? [msg.image_path] : [];
  const hasText = !!(msg.content && msg.content.trim());

  // 联网搜索内联引用：仅 AI 消息、且本消息对应 stream 有搜索结果时启用 [n] 可点击
  const citeCitations = (!isUser && searchResults && searchResults.length)
    ? Object.fromEntries(searchResults.map((r, idx) => [idx + 1, r.url]))
    : undefined;
  const citeOnClick = citeCitations
    ? (url: string) => { try { api?.openExternal?.(url); } catch { /* web/Capacitor 构建无此接口时忽略 */ } }
    : undefined;

  // 已撤回或失败消息特殊渲染
  if (recalled) {
    return (
      <div className="msg-row system" style={{ textAlign: 'center' }}>
        <span className="recalled-tag">↩ {t('msg.recalled')}</span>
      </div>
    );
  }

  return (
    <div className={`msg-row ${isUser ? 'user' : 'ai'}`} data-mid={msg.id} style={{ position: 'relative' }} onContextMenu={handleContextMenu}>
      {timeAbove && <div className="msg-time-above">{timeAbove}</div>}
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
            {(!isUser && msg.reasoning?.trim()) || hasText ? (
              <div className={`bubble ${failed ? 'bubble-failed' : ''}`} onMouseUp={handleMouseUp}>
                {!isUser && msg.reasoning?.trim() && (
                  <ReasoningBlock
                    reasoning={msg.reasoning}
                    defaultOpen={hideReasoning === false || (!!streaming && !msg.content)}
                    streaming={!!streaming && !msg.content}
                    onCopied={onReasoningCopied}
                  />
                )}
                {hasText && renderMarkdown(msg.content, { citations: citeCitations, onCite: citeOnClick })}
                {/* F6 修复：流式进行中始终在气泡内显示加载动画，避免「只有顶部横幅显示 AI 正在回复」 */}
                {streaming && (
                  <span className="typing-inline" aria-label={t('chat.replying')} />
                )}
              </div>
            ) : (
              <div className="bubble bubble-loading" onMouseUp={handleMouseUp}>
                <div className="typing" aria-label={t('chat.replying')}>
                  <span className="typing-bar" />
                </div>
              </div>
            )}
            {imgs.length > 0 && <ImageGrid paths={imgs} onImage={onImage} failed={!!failed} />}
            {failed && !hasText && imgs.length === 0 && (
              <span style={{ color: '#e74c3c' }}>{t('msg.resendTip')}</span>
            )}
          </>
        )}
        <div className="msg-meta">
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
          {onTranslate && <button className="ctx-menu-item" onClick={() => { onTranslate(msg.content); closeMenu(); }}>{t('msg.translate')}</button>}
          {onMarkNode && <button className="ctx-menu-item" onClick={() => { onMarkNode(msg); closeMenu(); }}>{t('chat.markNode')}</button>}
          {onSaveImageMemory && (msg.images?.length || msg.image_path) && (
            <button className="ctx-menu-item" onClick={() => { onSaveImageMemory(msg); closeMenu(); }}>{t('chat.drawMemory')}</button>
          )}
          {msg.genPrompt && (
            <button className="ctx-menu-item" onClick={() => { onViewPrompt?.(msg.genPrompt!); closeMenu(); }}>{t('msg.viewPrompt')}</button>
          )}
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
