import React, { useEffect, useRef, useState, useCallback, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import type { ChatListItem, ChatMessage, ChatType, Role, SelfRole, WorldBook } from '../types';

// 联网搜索结果项（后端 search:results 广播的结构，前端仅用于折叠展示）
interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}
import { renderMarkdown } from '../utils/markdown';
import { CustomTitleBar } from './CustomTitleBar';
import CustomCursor from './CustomCursor';
import ErrorBubble from './ErrorBubble';
import { AvatarImg } from './ChatList';
import { playSoundSync } from '../utils/sound';
import CustomScrollArea from './CustomScrollArea';
import { GroupEditor } from './GroupEditor';
import { useToast, ToastView } from './Toast';
import SelectMenu from './SelectMenu';
import { ReasoningBlock } from './ReasoningBlock';
import RandomEventModal, { RandomEventData } from './RandomEventModal';
import PendingImageThumb from './PendingImageThumb';
import ImageGrid from './ImageGrid';
import { MomentsView } from './MomentsView';
import { EVENT_COOLDOWN_MS, EVENT_TRIGGER_THRESHOLD } from '../eventThemes';
import { getEventStore, setEventStore } from '../utils/eventStore';
import { setIdleActivity } from '../utils/idleTimerStore';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { ClearChatModal } from './ClearChatModal';
import { MessageSearch } from './MessageSearch';
import { BondPanel } from './BondPanel';

// 快捷聊天小窗（独立无边框窗口，#mini 路由渲染）
// 交互逻辑与 ChatWindow 主界面保持一致：图片发送/预览、语音输入、TTS、回到底部、重发、@提及、群聊转单聊提示等。
export const MiniChat: React.FC = () => {
  const { t, lang } = useI18n();
  const { settings, reloadSettings } = useTheme();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [current, setCurrent] = useState<ChatListItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMsgs, setStreamingMsgs] = useState<Record<string, ChatMessage>>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // 请求限速（QPS）预排队状态
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
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [translateModal, setTranslateModal] = useState<{ source: string; text?: string; loading?: boolean; error?: string } | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genTyping, setGenTyping] = useState(false); // 生图期间在聊天框显示「AI 正在回复」动画（与主界面一致，用户不会看到自己的生图指令）
  const [promptView, setPromptView] = useState<string | null>(null); // 查看提示词弹窗
  const [pinned, setPinned] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [momentsOpen, setMomentsOpen] = useState(false);
  // 消息查找（🔍）与关系值（💞）开关
  const [searchOpen, setSearchOpen] = useState(false);
  const [bondOpen, setBondOpen] = useState(false);
  const [bondRoleId, setBondRoleId] = useState('');
  // 已结束的 streamId 集合，防止同一 AI 消息被重复追加（与 ChatWindow 一致）
  const doneStreamIds = useRef<Set<string>>(new Set());
  const seenSeqRef = useRef<Record<string, number>>({});
  // F1：群聊选人回复 —— 可见性 / 记忆开关 + 选人浮层状态
  const [needSpeaker, setNeedSpeaker] = useState<{ chatId: string; members: { id: string; name: string; avatar?: string }[] } | null>(null);
  const [replyVisible, setReplyVisible] = useState(true);
  const [replyToMemory, setReplyToMemory] = useState(true);
  // 角色/成员删除后的提示
  const [roleMissing, setRoleMissing] = useState(false);
  const [membersMissing, setMembersMissing] = useState(0);
  // 刷新 UI 计数器：自增可强制重建输入框并重新聚焦，用于修复「输入框无法输入」等偶发卡死
  const [refreshNonce] = useState(0);
  const [convertPrompt, setConvertPrompt] = useState(false);
  const [showGroupEditor, setShowGroupEditor] = useState(false);
  // 自我身份（用户自己的角色卡）：按会话覆盖
  const [selfRoles, setSelfRoles] = useState<SelfRole[]>([]);
  const { toast, showToast } = useToast();
  const [defaultSelfId, setDefaultSelfId] = useState('');
  const [selfRoleId, setSelfRoleId] = useState('default');
  // 本对话世界书（''=继承；'none'=不使用；其它=具体ID）
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [chatWorldBookId, setChatWorldBookId] = useState('');
  // 本对话独立开关：异步场景生图 / 联网搜索（与主界面共用同一份数据，经 settings:changed 同步）
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
  const autoMemoryRef = useRef(false);
  const [hideReasoning, setHideReasoning] = useState(true);
  const [enableStreaming, setEnableStreaming] = useState(false);
  // 好感度变化提示（与主界面一致）
  const [affinityPop, setAffinityPop] = useState<string | null>(null);
  // 自适应故事线：开关 / 节点列表 / 侧栏（与主界面同步）
  const [storyOn, setStoryOn] = useState(false);
  const [storyNodes, setStoryNodes] = useState<{ id: number; msg_id: number; title: string; timestamp: string }[]>([]);
  const [showStories, setShowStories] = useState(false);
  useEffect(() => {
    if (!current) return;
    api.getStoryEnabled(current.chat_type, current.chat_id).then(setStoryOn);
    api.listStoryNodes(current.chat_type, current.chat_id).then(setStoryNodes);
  }, [current?.chat_type, current?.chat_id]);
  const toggleStory = async () => {
    if (!current) return;
    const next = !storyOn;
    setStoryOn(next);
    await api.setStoryEnabled(current.chat_type, current.chat_id, next);
  };
  const markNode = async (msg: ChatMessage) => {
    if (!current) return;
    const title = (msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 30) || t('chat.stories');
    await api.addStoryNode(current.chat_type, current.chat_id, msg.id, title);
    setStoryNodes(await api.listStoryNodes(current.chat_type, current.chat_id));
    showToast(t('chat.markNode'));
  };
  const gotoNode = (msgId: number) => {
    const el = document.querySelector(`[data-mid="${msgId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const removeNode = async (id: number) => {
    if (!current) return;
    await api.removeStoryNode(id);
    setStoryNodes(await api.listStoryNodes(current.chat_type, current.chat_id));
  };
  // 随机事件（与主界面一致，按 chatKey 隔离）
  const chatKey = current ? `${current.chat_type}:${current.chat_id}` : '';
  const [eventState, setEventState] = useState<RandomEventData | null>(() => (chatKey ? getEventStore(chatKey).event : null));
  const [eventLoading, setEventLoading] = useState(() => (chatKey ? getEventStore(chatKey).loading : false));
  const eventStateRef = useRef(eventState);
  const eventLoadingRef = useRef(eventLoading);
  eventStateRef.current = eventState;
  eventLoadingRef.current = eventLoading;
  const prevChatKeyRef = useRef(chatKey);
  // current 切换时保存旧 chat 状态，加载新 chat 状态
  useEffect(() => {
    if (prevChatKeyRef.current !== chatKey) {
      if (prevChatKeyRef.current) {
        setEventStore(prevChatKeyRef.current, { event: eventStateRef.current, loading: eventLoadingRef.current });
      }
      if (chatKey) {
        const saved = getEventStore(chatKey);
        // 清理失效的 loading 状态：只有 loading 没有 event → 视为无事件
        if (saved.loading && !saved.event) {
          setEventStore(chatKey, { event: null, loading: false });
          setEventState(null);
          setEventLoading(false);
        } else {
          setEventState(saved.event);
          setEventLoading(saved.loading);
        }
      } else {
        setEventState(null);
        setEventLoading(false);
      }
      prevChatKeyRef.current = chatKey;
    }
  }, [chatKey]);
  // 状态变化时同步到 store
  useEffect(() => {
    if (chatKey) setEventStore(chatKey, { event: eventState, loading: eventLoading });
  }, [chatKey, eventState, eventLoading]);
  const [enableRandomEvents, setEnableRandomEvents] = useState(true);
  // 用 ref 持有最新开关值，避免流式回调 onDone 闭包捕获旧值导致「关闭后仍然弹出」
  const enableRandomEventsRef = useRef(true);
  enableRandomEventsRef.current = enableRandomEvents;
  const [roleMood, setRoleMood] = useState(''); // 当前角色心情徽标（单聊）
  const lastEventRef = useRef(0);
  // 空闲主动回复：默认开启；idleSeconds 为静默多久后角色主动开口
  const [idleReplyOn, setIdleReplyOn] = useState(true);
  const [groupAutoChain, setGroupAutoChain] = useState(false);
  const [idleCountdown, setIdleCountdown] = useState(0);
  const idleSwitchActionRef = useRef<'pause' | 'reset' | 'continue'>('pause');
  const lastActivityRef = useRef(Date.now()); // 最近一次用户操作时间
  const proactiveBusyRef = useRef(false); // 正在生成主动消息，防止重复触发
  const idleReplyOnRef = useRef(true);
  const idleSecondsRef = useRef(60);
  const sendingRef = useRef(false); // 与 setSending 同步，供轮询读取
  const streamingCountRef = useRef(0); // 当前进行中的流式数量
  const activeStreamsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessage[]>([]);
  const roleMissingRef = useRef(false);
  const membersMissingRef = useRef(0);

// 随机事件快捷主题见 ../eventThemes（主窗/小窗共用）
  // 语音、模型、头像、token
  const [voiceCfg, setVoiceCfg] = useState({ asr: false, tts: false, auto: false });
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [globalTokens, setGlobalTokens] = useState(0);
  const [modelMap, setModelMap] = useState<Record<string, string>>({});
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  const [showMention, setShowMention] = useState(false);
  const [failed, setFailed] = useState<{
    content: string;
    imagePaths: string[];
    phase: 'full' | 'ai';
    error: string;
  } | null>(null);
  const [members, setMembers] = useState<Role[]>([]);
  // 观察者私密小窗标记：以 obs:<groupId>:<roleId> 打开时为 true，强制显示思维链
  const [observerPrivate, setObserverPrivate] = useState(false);
  const [chatBg, setChatBg] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recentlySentRef = useRef(false);
  const lastSentRef = useRef<{ content: string; imagePaths: string[] }>({
    content: '',
    imagePaths: [],
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const miniPrevChatIdRef = useRef<string | undefined>(undefined);
  // 群聊连续对话（与主界面 ChatWindow 一致）
  const [continuing, setContinuing] = useState(false);
  const [autoChat, setAutoChat] = useState(false);
  const [autoRound, setAutoRound] = useState(0);
  const autoRef = useRef(false);
  const pendingAutoChain = useRef(false); // 发消息后是否自动进入多轮接话（AI 主动续聊）

  // 载入会话列表并定位默认会话
  const loadChats = async () => {
    const list = await api.getChatList();
    setChats(list);
    if (!current && list.length > 0) {
      const def = settings?.miniWindow?.defaultChat || '';
      const hit = def
        ? list.find((c) => `${c.chat_type}:${c.chat_id}` === def)
        : undefined;
      setCurrent(hit || list[0]);
    }
  };

  // 拉取模型/头像/voice/全局token/自我身份等辅助数据（与 ChatWindow.load 对齐）
  const loadAux = async () => {
    const [roles, settings] = await Promise.all([api.getRoles(), api.getSettings()]);
    const map: Record<string, string> = {};
    const avatars: Record<string, string> = {};
    for (const r of roles) {
      const cfg = (settings.models || []).find((m) => m.id === r.model_config_id);
      if (cfg) map[r.name] = cfg.name;
      if (r.avatar_path) avatars[r.name] = r.avatar_path;
    }
    setModelMap(map);
    setAvatarMap(avatars);
    setVoiceCfg({
      asr: !!(settings.voice?.asrBaseUrl && settings.voice?.asrApiKey),
      tts: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey),
      auto: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey) && !!settings.voice?.ttsAutoPlay,
    });
    setSelfRoles(settings.selfRoles || []);
    // 同步 body/html 背景与 shell 一致，填补原生窗口圆角与 CSS 圆角间的透明缝隙
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
    if (bg) document.documentElement.style.background = bg;
    setDefaultSelfId(settings.currentSelfRoleId || '');
    autoMemoryRef.current = !!settings.enableAutoMemory;
    setHideReasoning(settings.hideReasoning !== false);
    setEnableStreaming(!!settings.enableStreaming);
    setEnableRandomEvents(settings.enableRandomEvents !== false);
    const globalOn = settings.idleEnabled !== false;
    const perChat = current ? (settings.chatIdleEnabled || {})[`${current.chat_type}:${current.chat_id}`] : undefined;
    const eff = globalOn && (perChat === undefined ? true : perChat);
    setIdleReplyOn(eff);
    idleReplyOnRef.current = eff;
    idleSecondsRef.current = settings.idleInterval || 600;
    idleSwitchActionRef.current = settings.idleSwitchAction || 'pause';
    setGroupAutoChain(settings.groupAutoChain !== false);
    // 加载聊天背景
    if (current) {
      const key = `${current.chat_type}:${current.chat_id}`;
      const bgPath = (settings.chatBackgrounds || {})[key];
      if (bgPath) {
        api.getImage(bgPath).then((src) => setChatBg(src));
      } else {
        setChatBg(null);
      }
    }
    api.listWorldBooks().then(setWorldBooks).catch(() => {});
  };

  // 应用主进程下发的初始/切换会话（含观察者私密小窗 obs:<groupId>:<roleId>）
  const applyInitialChat = async (
    data: { chatType: string; chatId: string; isObserverPrivate?: boolean } | null
  ) => {
    if (!data) return;
    let name = data.chatId;
    let avatar: string | undefined;
    const parts = data.chatId.split(':');
    if (data.isObserverPrivate && parts[0] === 'obs' && parts.length >= 3) {
      const role = await api.getRole(parts[parts.length - 1]);
      name = role?.name || parts[parts.length - 1];
      avatar = role?.avatar_path;
    } else if (data.chatType === 'single') {
      const role = await api.getRole(data.chatId);
      name = role?.name || data.chatId;
      avatar = role?.avatar_path;
    } else {
      const g = await api.getGroup(data.chatId);
      name = g?.group_name || data.chatId;
    }
    setCurrent({ chat_type: data.chatType as ChatType, chat_id: data.chatId, name, avatar_path: avatar || '', last_message: '', last_time: '' });
    setObserverPrivate(!!data.isObserverPrivate);
  };

  useEffect(() => {
    loadChats();
    loadAux();
    setPinned(settings?.miniWindow?.alwaysOnTop !== false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // 小窗音效：首次挂载 + mini:switch + visibilitychange 配合判断
  // - 首次挂载（新窗口创建）→ miniPopup
  // - mini:switch 窗口已可见 → miniPopup（小窗已打开，点击打开按钮）
  // - mini:switch 窗口隐藏 → 设标志；visibilitychange→visible 时 miniPopup
  const pendingMiniPopup = useRef(false);
  const hasPlayedInit = useRef(false);
  useEffect(() => {
    if (!hasPlayedInit.current) {
      hasPlayedInit.current = true;
      playSoundSync('miniPopup');
    }
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && pendingMiniPopup.current) {
        pendingMiniPopup.current = false;
        playSoundSync('miniPopup');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 启动时消费主进程下发的初始会话（观察者私密小窗），并监听后续切换
  useEffect(() => {
    api.miniGetInitial().then((d) => { if (d) applyInitialChat(d); }).catch(() => {});
    const off = api.onMiniSwitch((_e, data) => {
      if (data) {
        if (document.visibilityState === 'visible') {
          // 不再播放刷新完毕提示音
        } else {
          pendingMiniPopup.current = true;
        }
        applyInitialChat(data);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窗口获得焦点时刷新（主窗产生的新消息同步进来）
  useEffect(() => {
    const onFocus = () => {
      loadChats();
      if (current) loadMessages(current);
      reloadSettings();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // 闲置 5 分钟半透明；有交互恢复
  useEffect(() => {
    const reset = () => {
      api.miniSetOpacity(1);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => api.miniSetOpacity(0.8), 5 * 60 * 1000);
    };
    reset();
    window.addEventListener('mousemove', reset);
    window.addEventListener('keydown', reset);
    return () => {
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('keydown', reset);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  const loadMessages = async (c: ChatListItem) => {
    const all = await api.getMessages(c.chat_type, c.chat_id);
    setMessages(all.slice(-10)); // 只保留最近 10 条
  };

  // 群聊成员（用于 @ 提及与转单聊）
  const loadMembers = async (c: ChatListItem) => {
    if (c.chat_type !== 'group') {
      setMembers([]);
      return;
    }
    const g = await api.getGroup(c.chat_id);
    if (!g) {
      setMembers([]);
      return;
    }
    const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
    const all = await api.getRoles();
    setMembers(all.filter((r) => ids.includes(r.id)));
  };

  useEffect(() => {
    if (current) {
      loadMessages(current);
      loadMembers(current);
      setStreamingMsgs({});
      setRoleMissing(false);
      setMembersMissing(0);
      setConvertPrompt(false);
      setFailed(null);
      doneStreamIds.current.clear();
      seenSeqRef.current = {};
      // 切换会话时终止自动接话
      autoRef.current = false;
      pendingAutoChain.current = false;
      setAutoChat(false);
      setAutoRound(0);
      setContinuing(false);
      api.getGlobalTokens().then(setGlobalTokens);
      // 检测角色/成员删除、群聊转单聊
      (async () => {
        if (current.chat_type === 'single') {
          const rid = await api.resolveRoleId(current.chat_type, current.chat_id);
          const r = await api.getRole(rid);
          setRoleMissing(!r);
          setRoleMood(r?.mood || '');
        } else if (current.chat_type === 'group') {
          const g = await api.getGroup(current.chat_id);
          const all = await api.getRoles();
          const existingIds = new Set(all.map((r) => r.id));
          if (g) {
            const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
            const missing = ids.filter((id) => !existingIds.has(id)).length;
            setMembersMissing(missing);
            const ignored = !!(g && g.ignoreConvert);
            const existingCount = ids.filter((id) => existingIds.has(id)).length;
            setConvertPrompt(existingCount === 1 && ids.length >= 1 && !ignored);
          }
        }
      })();
      // 载入自我身份列表与当前对话的身份覆盖
      (async () => {
        const s = await api.getSettings();
        const sRoles = s.selfRoles || [];
        setSelfRoles(sRoles);
        setDefaultSelfId(s.currentSelfRoleId || '');
        const key = `${current.chat_type}:${current.chat_id}`;
        setSelfRoleId(s.chatSelfRoles?.[key] ?? 'default');
        setChatWorldBookId(s.chatWorldBooks?.[key] ?? '');
        setSceneImageOn(!!s.autoSceneImageChats?.[key]);
        setWebSearchOn(!!s.webSearchChats?.[key]);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.chat_type, current?.chat_id]);

  // 滚动监听：显示/隐藏回到底部按钮
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

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  // 流式事件（主进程广播到所有窗口）
  useEffect(() => {
    if (!current) return;
    const belongs = (streamId: string) => {
      // streamId = `${chatId}:${roleId}`，按最后一个 ':' 精确解析出 chatId 再比较，
      // 避免 chatId 互为字符串前缀时（如 "1" 与 "12"）回复串到无关聊天
      const sep = streamId.lastIndexOf(':');
      const sid = sep >= 0 ? streamId.slice(0, sep) : streamId;
      return sid === current.chat_id;
    };
    const onChunk = (_e: any, data: any) => {
      if (!belongs(data.streamId)) return;
      // 按 seq 去重：同一 chunk 被多个监听器/窗口重复处理时只追加一次
      if (typeof data.seq === 'number') {
        const last = seenSeqRef.current[data.streamId] || 0;
        if (data.seq <= last) return;
        seenSeqRef.current[data.streamId] = data.seq;
      }
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
        if (!existing) return prev;
        return {
          ...prev,
          [data.streamId]: {
            ...existing,
            content: existing.content + (data.content || ''),
            reasoning: (existing.reasoning || '') + (data.reasoning || '') || undefined,
          },
        };
      });
    };
    const onStart = (_e: any, data: any) => {
      if (!belongs(data.streamId)) return;
      // 同一 streamId 可能被复用（继续对话/重发）：重置 seq 与完成标记，避免新一轮 chunk 被误丢弃
      delete seenSeqRef.current[data.streamId];
      doneStreamIds.current.delete(data.streamId);
      activeStreamsRef.current.add(data.streamId);
      streamingCountRef.current = activeStreamsRef.current.size;
      // 检索在流式开始前已完成：把暂存的搜索结果挂到本消息的 streamId（每条回复独立气泡）
      if (pendingSearchRef.current) {
        const payload = pendingSearchRef.current;
        pendingSearchRef.current = null;
        setSearchResultsByStream((prev) => ({ ...prev, [data.streamId]: payload }));
      }
      setStreamingMsgs((prev) => {
        if (prev[data.streamId]) return prev;
        return {
          ...prev,
          [data.streamId]: {
            id: -Date.now() - Math.floor(Math.random() * 100000),
            chat_type: current.chat_type,
            chat_id: current.chat_id,
            sender_type: 'ai',
            sender_name: data.roleName,
            content: '',
            image_path: null,
            token_used: 0,
            timestamp: new Date().toISOString(),
            streamId: data.streamId,
          } as any,
        };
      });
    };
    const onDone = (_e: any, data: any) => {
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
        if (voiceCfg.auto && data.message.content) speak(data.message);
      }
      // 后台消息提醒：主窗/小窗均隐藏且软件在后台时，弹出 Steam 风格卡片
      if (data.message?.sender_type === 'ai' && data.message.content) {
        if (typeof api.notifyCard === 'function') {
          api.notifyCard({
            chatType: current.chat_type,
            chatId: current.chat_id,
            name: current.name,
            roleName: data.message.sender_name,
            content: data.message.content,
          }).catch(() => {});
        }
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
    const offChunk = api.onStreamChunk(onChunk);
    const offStart = api.onStreamStart(onStart);
    const offDone = api.onStreamDone(onDone);
    // 整轮结束后由主进程广播 stream:roundDone 触发 AI 主动续聊,避免群聊串行时首个 done 即误触发
    const offRoundDone = api.onStreamRoundDone((data) => {
      if (!data || !current || data.chatId !== current.chat_id) return;
      if (pendingAutoChain.current) {
        pendingAutoChain.current = false;
        setTimeout(() => maybeChain(), 250);
      }
    });
    const offUser = api.onStreamUser((_e, data) => {
      if (!data || !current || data.chat_id !== current.chat_id) return;
      setMessages((prev) => {
        if (prev.find((m) => m.id === data.id)) return prev;
        return [...prev, data];
      });
    });
    const offEvent = api.onEventChosen((_e, data) => {
      if (!data || !current || data.chatId !== current.chat_id) return;
      setEventState(null);
      setEventLoading(false);
      if (data.message) {
        setMessages((prev) => {
          if (prev.find((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
      }
    });
    const offIdle = api.onIdleActivity((_e, data) => {
      if (data && current) {
        const curKey = `${current.chat_type}:${current.chat_id}`;
        if (data.chatKey === curKey) {
          const ts = data.timestamp || Date.now();
          setIdleActivity(curKey, ts);
          lastActivityRef.current = ts;
          // 立即刷新倒计时显示，避免等下次 setInterval 造成短暂不一致
          const total = (idleSecondsRef.current || 600) * 1000;
          setIdleCountdown(Math.ceil(total / 1000));
        }
      }
    });
    // F1：群聊选人回复 —— 主进程广播「请选择下一位发言者」，弹出选人浮层
    const offNeedSpeaker = api.onNeedSpeaker((data) => {
      if (!data || !current || data.chatId !== current.chat_id) return;
      setNeedSpeaker(data);
    });
    return () => {
      offChunk();
      offStart();
      offDone();
      offRoundDone();
      offUser();
      offEvent();
      offIdle();
      offNeedSpeaker();
    };
  }, [current]);

  // 心情实时同步：AI 判定或事件选择后，主进程广播 role:mood，两窗口同步刷新
  useEffect(() => {
    const off = api.onRoleMood((_e, d) => {
      if (d && current && d.chatId === current.chat_id && current.chat_type === 'single') {
        setRoleMood(d.mood || '');
      }
    });
    return off;
  }, [current]);

  // 设置变更广播同步：主窗与小窗的世界书/身份/开关保持一致
  useEffect(() => {
    const off = api.onSettingsChanged(async (_e, patch: Record<string, any>) => {
      if (!patch || !current) return;
      // 统一从最新 settings 重派生所有本地开关与样式（含 groupAutoChain / enableStreaming），杜绝字段遗漏
      const settings = await api.getSettings();
      const key = `${current.chat_type}:${current.chat_id}`;
      // 主题与 CSS 变量（圆角/气泡透明度/字体/主题/动效）与主界面一致
      document.documentElement.setAttribute('data-theme', settings.theme || 'wechat');
      const root = document.documentElement;
      const ui = Number(settings.uiRadius);
      if (Number.isFinite(ui) && ui >= 0) {
        root.style.setProperty('--radius', `${ui}px`);
        root.style.setProperty('--radius-sm', `${Math.max(2, Math.round(ui * 0.6))}px`);
      }
      const bubble = Number(settings.bubbleRadius);
      if (Number.isFinite(bubble) && bubble >= 0) root.style.setProperty('--bubble-radius', `${bubble}px`);
      const bo = Number(settings.bubbleOpacity);
      root.style.setProperty('--bubble-opacity', bo >= 50 && bo <= 100 ? String(bo / 100) : '1');
      const fs = Number(settings.fontSize);
      if (Number.isFinite(fs) && fs > 0) {
        root.style.setProperty('--font-size', `${fs}px`);
        root.style.setProperty('--font-scale', String(fs / 14));
      }
      const FONT_FAMILIES: Record<string, string> = {
        system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", serif',
        round: '"M PLUS Rounded 1c", "PingFang SC", "Microsoft YaHei UI", sans-serif',
        mono: '"JetBrains Mono", "Source Code Pro", "Fira Code", Consolas, monospace',
        cjk: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif',
      };
      const ff = FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.system;
      if (ff) root.style.setProperty('--font-family', ff);
      root.classList.toggle('anim-off', !settings.enableAnimations);
      // 全局开关统一重派生
      setHideReasoning(settings.hideReasoning !== false);
      setEnableStreaming(!!settings.enableStreaming);
      autoMemoryRef.current = !!settings.enableAutoMemory;
      setEnableRandomEvents(settings.enableRandomEvents !== false);
      const globalOn = settings.idleEnabled !== false;
      const perChat = (settings.chatIdleEnabled || {})[key];
      const eff = globalOn && (perChat === undefined ? true : perChat);
      setIdleReplyOn(eff);
      idleReplyOnRef.current = eff;
      idleSecondsRef.current = settings.idleInterval || 600;
      idleSwitchActionRef.current = settings.idleSwitchAction || 'pause';
      setGroupAutoChain(settings.groupAutoChain !== false);
      setVoiceCfg({
        asr: !!(settings.voice?.asrBaseUrl && settings.voice?.asrApiKey),
        tts: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey),
        auto: !!(settings.voice?.ttsBaseUrl && settings.voice?.ttsApiKey) && !!settings.voice?.ttsAutoPlay,
      });
      // 按聊天覆盖的设置
      setChatWorldBookId((settings.chatWorldBooks || {})[key] ?? '');
      setSceneImageOn(!!(settings.autoSceneImageChats || {})[key]);
      setWebSearchOn(!!(settings.webSearchChats || {})[key]);
      setSelfRoleId((settings.chatSelfRoles || {})[key] ?? 'default');
      const bgPath = (settings.chatBackgrounds || {})[key];
      if (bgPath) {
        api.getImage(bgPath).then((src) => setChatBg(src));
      } else {
        setChatBg(null);
      }
    });
    return off;
  }, [current]);

  // 窗口间同步：自动接话 driver 事件
  useEffect(() => {
    const off = api.onAutoChatDriver((data) => {
      if (!current || data.chatId !== current.chat_id) return;
      if (data.action === 'start') {
        setAutoChat(true);
      } else if (data.action === 'round') {
        if (typeof data.round === 'number') setAutoRound(data.round);
      } else if (data.action === 'stop') {
        setAutoChat(false);
        setAutoRound(0);
        setContinuing(false);
        if (data.reason === 'forced') autoRef.current = false;
      }
    });
    return off;
  }, [current]);

  // 挂载即同步当前自动接话状态（小窗常晚于主窗开启，避免卡在非自动接话状态）
  useEffect(() => {
    if (!current) return;
    let alive = true;
    api.getAutoChatState(current.chat_id).then((s) => {
      if (alive && s?.active) {
        setAutoChat(true);
        setAutoRound(0);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [current]);

  // 窗口间同步：消息变更（清空/撤回/回滚后重载）
  useEffect(() => {
    const off = api.onMessagesSync((data) => {
      if (!current || data.chatType !== current.chat_type || data.chatId !== current.chat_id) return;
      reloadMessages();
    });
    return off;
  }, [current]);

  // 窗口间同步：背景变更
  useEffect(() => {
    const off = api.onSettingsChanged(async (_e: any, patch: Record<string, any>) => {
      if (!patch || !current) return;
      if (patch.chatBackgrounds) {
        const settings = await api.getSettings();
        const key = `${current.chat_type}:${current.chat_id}`;
        const bgPath = (settings.chatBackgrounds || {})[key];
        if (bgPath) {
          api.getImage(bgPath).then((src) => setChatBg(src));
        } else {
          setChatBg(null);
        }
      }
    });
    return off;
  }, [current]);

  // 联网搜索状态：仅关心当前聊天，用于提示「搜索中…」
  useEffect(() => {
    if (!current) return;
    const off = api.onSearchStatus((_e, data: any) => {
      if (!data || data.chatType !== current.chat_type || data.chatId !== current.chat_id) return;
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
  }, [current]);

  // 联网搜索结果：仅关心当前聊天；按每条回复独立展示，切换对话时清空重置
  useEffect(() => {
    setSearchResultsByStream({});
    setExpandedStreams({});
    pendingSearchRef.current = null;
    streamMsgIdRef.current = {};
    if (!current) return;
    const off = api.onSearchResults((_e, data: any) => {
      if (!data || data.chatType !== current.chat_type || data.chatId !== current.chat_id) return;
      const incoming: SearchResultItem[] = Array.isArray(data.results) ? data.results : [];
      if (!incoming.length) return;
      // 暂存：检索在流式开始前完成，等首个 stream:start 再挂到对应消息，实现「每条回复独立气泡」
      pendingSearchRef.current = incoming;
    });
    return off;
  }, [current]);

  // 窗口间同步：故事线开关变更（一端开/关，另一端实时刷新）
  useEffect(() => {
    if (!current) return;
    const off = api.onStoryChanged((_e, data) => {
      if (data.chatType !== current.chat_type || data.chatId !== current.chat_id) return;
      setStoryOn(data.enabled);
    });
    return off;
  }, [current]);

  // 清空发送失败状态（由 forceStopAutoChat / 新 driver claim 触发）
  useEffect(() => {
    if (!current) return;
    const off = api.onClearFailed((data) => {
      if (data.chatId === current.chat_id) setFailed(null);
    });
    return off;
  }, [current]);

  const maybeAutoMemory = () => {
    if (!autoMemoryRef.current || !current) return;
    api.extractMemories(current.chat_type, current.chat_id).catch(() => {});
  };

  // ===== 随机事件（与主界面一致） =====
  const triggerEvent = async (theme?: string) => {
    if (!current || eventLoading || eventState) return;
    setEventLoading(true);
    try {
      const ev = await api.randomEvent({ chatType: current.chat_type, chatId: current.chat_id, theme, window: 'mini' });
      if ('busy' in ev) {
        const win = (ev as any).window;
        if (win && win !== 'mini') showToast(t('chat.eventBusyAt', { window: t('chat.window' + win) }));
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
    if (!eventState || !current) return;
    const ev = eventState;
    setEventState(null);
    try {
      const res = await api.chooseEvent({
        chatType: current.chat_type,
        chatId: current.chat_id,
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
      const rid = current.chat_type === 'single'
        ? await api.resolveRoleId(current.chat_type, current.chat_id)
        : ev.roleId;
      const r = await api.getRole(rid);
      if (r) setRoleMood(r.mood || '');
      void api.eventClosed({ chatType: current.chat_type, chatId: current.chat_id });
      // 立即拉取最新消息，显示后端已写入的「好感/心情」系统消息
      api.getMessages(current.chat_type, current.chat_id).then(setMessages);
    } catch (e: any) {
      showToast(t('toast.eventFail', { msg: e?.message || String(e) }));
    }
  };
  const maybeRandomEvent = () => {
    if (!enableRandomEventsRef.current || !current) return;
    if (eventState || eventLoading) return;
    const now = Date.now();
    if (now - lastEventRef.current < EVENT_COOLDOWN_MS) return;
    lastEventRef.current = now;
    if (Math.random() > EVENT_TRIGGER_THRESHOLD) return;
    triggerEvent();
  };

  const makePlaceholder = (roleName: string): ChatMessage => ({
    id: -Date.now() - Math.floor(Math.random() * 100000),
    chat_type: current?.chat_type as any,
    chat_id: current?.chat_id || '',
    sender_type: 'ai',
    sender_name: roleName,
    content: '',
    image_path: null,
    token_used: 0,
    timestamp: new Date().toISOString(),
  });

  const performSend = async (content: string, imagePaths: string[], phase: 'full' | 'ai') => {
    if (!current) return;
    // 用户插话：停止自动接话循环
    autoRef.current = false;
    setAutoChat(false);
    setSending(true);
    sendingRef.current = true;
    recentlySentRef.current = true;
    playSoundSync('messageSend');
    setFailed(null);
    lastSentRef.current = { content, imagePaths };
    // 发送消息即视为用户主动活动，重置空闲计时
    lastActivityRef.current = Date.now();
    if (current) {
      setIdleActivity(`${current.chat_type}:${current.chat_id}`, Date.now());
      api.sendIdleActivity(`${current.chat_type}:${current.chat_id}`);
    }
    doneStreamIds.current.clear();
    seenSeqRef.current = {};
    pendingSearchRef.current = null;
    let userSent = phase === 'ai';
    try {
      const s = await api.getSettings();
      // F1：群聊选人回复 —— 仅在群聊且开启开关时生效
      const selectReply = !!(s.groupSelectReply && current.chat_type === 'group');
      if (s.enableStreaming && phase === 'full') {
        const { userMessage, members: streamMembers } = await api.startStream({
          chatType: current.chat_type,
          chatId: current.chat_id,
          content,
          imagePaths,
          visibleToGroup: replyVisible,
          toMemory: replyVisible ? replyToMemory : false,
        });
        setMessages((prev) => [...prev.slice(-9), userMessage]);
        const init: Record<string, ChatMessage> = {};
        for (const mb of streamMembers) init[mb.streamId] = makePlaceholder(mb.roleName);
        setStreamingMsgs((prev) => ({ ...prev, ...init }));
        // 选人回复：后端 handleSend 已提前返回并广播 needSpeaker，此处同步弹出选人浮层
        if (selectReply) {
          setNeedSpeaker({ chatId: current.chat_id, members: members.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_path })) });
        }
      } else {
        if (phase === 'full') {
          const userMessage = await api.sendUserMessage({
            chatType: current.chat_type,
            chatId: current.chat_id,
            content,
            imagePaths,
            visibleToGroup: replyVisible,
            toMemory: replyVisible ? replyToMemory : false,
          });
          setMessages((prev) => [...prev.slice(-9), userMessage]);
          userSent = true;
          // 选人回复：不自动生成 AI 回复，交由前端弹窗选择下一位发言者
          if (selectReply) {
            setNeedSpeaker({ chatId: current.chat_id, members: members.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_path })) });
            return;
          }
        }
        const res = await api.sendAIMessages({
          chatType: current.chat_type,
          chatId: current.chat_id,
          content,
          imagePaths,
        });
        setStreamingMsgs({});
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const newMsgs = res.aiMessages.filter((m) => !seen.has(m.id));
          return [...prev, ...newMsgs];
        });
        // 好感度变化提示（与主界面一致）
        const changed = res.affinityChanges?.find((a) => a.change !== 0);
        if (changed) {
          const sign = changed.change > 0 ? '+' : '';
          setAffinityPop(t('chat.affinityPop', { change: `${sign}${changed.change}` }));
          setTimeout(() => setAffinityPop(null), 1500);
        }
        maybeAutoMemory();
        maybeRandomEvent();
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
      setSending(false);
      sendingRef.current = false;
    }
  };

  // 同步供空闲轮询读取的最新值
  useEffect(() => {
    messagesRef.current = messages;
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

  // 全局键盘安全网（与主窗一致）：敲键盘时焦点丢失则自动归还输入框
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.length > 1 && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'Enter') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!inputRef.current || inputRef.current.readOnly) return;
      if (document.querySelector('.modal-backdrop, .dialog-overlay, [role="dialog"]')) return;
      e.preventDefault();
      inputRef.current.focus();
      const fakeEvent = new KeyboardEvent('keydown', {
        key: e.key, code: e.code, keyCode: e.keyCode,
        bubbles: true, cancelable: true,
      });
      inputRef.current.dispatchEvent(fakeEvent);
    };
    window.addEventListener('keydown', onKeyDown, { error: true });
    return () => window.removeEventListener('keydown', onKeyDown, { error: true });
  }, []);

  // 随机事件弹窗关闭后，若当前无其他模态/遮罩打开，立即把焦点归还小窗输入框
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
    roleMissingRef.current = roleMissing;
  }, [roleMissing]);
  useEffect(() => {
    membersMissingRef.current = membersMissing;
  }, [membersMissing]);

  // 空闲主动回复：用户在线但一段时间无操作时，角色主动发一条贴合语境与心情的消息
  const triggerProactive = useCallback(async () => {
    if (!current || proactiveBusyRef.current) return;
    if (roleMissingRef.current || membersMissingRef.current > 0) return;
    proactiveBusyRef.current = true;
    try {
      const res = await api.proactive({ chatType: current.chat_type, chatId: current.chat_id });
      if (!res.ok && res.error) showToast(t('chat.proactiveError', { error: res.error }));
    } catch (e: any) {
      showToast(t('chat.proactiveError', { error: e?.message || String(e) }));
    } finally {
      proactiveBusyRef.current = false;
      const now = Date.now();
      lastActivityRef.current = now;
      api.idleSet(`${current.chat_type}:${current.chat_id}`, now);
    }
  }, [current, t, showToast]);

  useEffect(() => {
    if (!current) return;
    const curKey = `${current.chat_type}:${current.chat_id}`;
    let cancelled = false;
    // 进入聊天时，从主进程读取全局权威计时基准（跨窗口唯一数据源）
    (async () => {
      let initTime: number;
      if (idleSwitchActionRef.current === 'reset') {
        initTime = Date.now();
        api.idleSet(curKey, initTime);
      } else {
        const saved = await api.idleGet(curKey);
        if (cancelled) return;
        if (saved != null) {
          // pause / continue：继承主进程权威值
          initTime = saved;
        } else {
          initTime = Date.now();
          api.idleSet(curKey, initTime);
        }
      }
      if (!cancelled) lastActivityRef.current = initTime;
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
  }, [current, triggerProactive]);

  // 主动消息倒计时：订阅主进程每秒广播的 elapsed，保证多窗口完全一致
  useEffect(() => {
    if (!current) return;
    const curKey = `${current.chat_type}:${current.chat_id}`;
    const offTick = api.onIdleTick((_e, payload) => {
      if (!idleReplyOnRef.current || document.visibilityState !== 'visible') {
        setIdleCountdown(0);
        return;
      }
      const elapsed = payload[curKey];
      const totalMs = (idleSecondsRef.current || 600) * 1000;
      if (elapsed === undefined) {
        setIdleCountdown(Math.ceil(totalMs / 1000));
        return;
      }
      const remaining = totalMs - elapsed;
      setIdleCountdown(remaining > 0 ? Math.ceil(remaining / 1000) : 0);
    });
    return offTick;
  }, [current]);

  const doSendMini = async () => {
    if (!current || roleMissing || (!input.trim() && pendingImages.length === 0) || sending) return;
    const content = input.trim();
    const imgs = pendingImages;
    setInput('');
    setPendingImages([]);
    // 群聊且开启「AI 主动续聊」：标记首轮完成后自动多轮接话
    pendingAutoChain.current =
      current.chat_type === 'group' && !!settings?.groupAutoChain;
    // 微信风格：所有选中图片合并为一条消息的图集（无绿色气泡），一次性发送
    await performSend(content, imgs, 'full');
    // 非流式：performSend 已 await 完整首轮，直接触发（流式由 onDone 触发）
    if (!enableStreaming && pendingAutoChain.current) {
      pendingAutoChain.current = false;
      maybeChain();
    }
  };

  const send = async () => {
    if (!current || roleMissing || (!input.trim() && pendingImages.length === 0) || sending) return;
    // 请求限速（QPS）：超限进入预排队，输入框保留文本、可编辑、倒计时后自动发送
    try {
      const modelId = await api.getChatModelId(current.chat_type, current.chat_id);
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
    await doSendMini();
  };

  // QPS 预排队倒计时：归零后清空队列并自动发送（使用当前输入框文本）
  useEffect(() => {
    if (!queue) return;
    const tick = () => {
      const left = queue.waitMs - (Date.now() - queue.startedAt);
      if (left <= 0) {
        setQueue(null);
        void doSendMini();
      } else {
        setQueueLeft(Math.ceil(left / 1000));
      }
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [queue]);

  const resend = () => {
    if (!failed || sending) return;
    pendingAutoChain.current = false;
    performSend(failed.content, failed.imagePaths, failed.phase);
  };

  // ===== 消息操作：快捷记忆 / 回滚 / 撤回 =====
  const handleQuickMemory = async (m: ChatMessage, text: string) => {
    if (!current) return;
    let roleId = '';
    if (current.chat_type === 'single') {
      roleId = current.chat_id.startsWith('obs:')
        ? current.chat_id.split(':').pop()!
        : current.chat_id;
    } else if (m.sender_type === 'ai') {
      const roles = await api.getRoles();
      const r = roles.find((x: Role) => x.name === m.sender_name);
      roleId = r?.id || '';
    }
    if (!roleId) return;
    await api.addQuickMemory({ roleId, content: text.trim().slice(0, 500) });
    showToast(t('msg.quickMemoryDone', { name: m.sender_name }));
  };

  // 生图：由主进程生成并落库（经 stream:user 广播同步到本窗）
  const doGenerate = async () => {
    if (!current) return;
    const prompt = genText.trim();
    if (!prompt) return;
    setGenLoading(true);
    setGenTyping(true);
    try {
      await api.generateImage(current.chat_type, current.chat_id, prompt);
      setGenOpen(false);
      setGenText('');
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
    if (!data || !current) return;
    try {
      await api.groupContinue({
        chatId: current.chat_id,
        forceRoleId: roleId,
        visibleToGroup: replyVisible,
        toMemory: replyVisible ? replyToMemory : false,
      });
    } catch (e: any) {
      showToast(e?.message || t('chat.genNeedPrompt'));
    }
  };

  // F4：发图生图 / 生视频（取附图 + 输入框提示词，交给后端异步生成）
  const doGenerateFromImage = async (kind: 'image' | 'video') => {
    if (!current) return;
    const text = input.trim();
    if (!text) {
      showToast(t('chat.genNeedPrompt'));
      return;
    }
    if (pendingImages.length === 0) return;
    const img = pendingImages[0];
    setPendingImages([]);
    setInput('');
    setSending(true);
    try {
      const res = await api.generateImageFromImage(current.chat_type, current.chat_id, text, img, kind);
      if (!res || !res.ok) showToast(kind === 'video' ? t('chat.genVideoFailed') : t('chat.drawFailed'));
    } catch (e: any) {
      showToast(e?.message || (kind === 'video' ? t('chat.genVideoFailed') : t('chat.drawFailed')));
    } finally {
      setSending(false);
    }
  };

  // 手动把图片存进角色记忆（AI 不会自动保存图片记忆）
  const handleSaveImageMemory = async (m: ChatMessage) => {
    if (!current) return;
    const imgs = m.images && m.images.length ? m.images : m.image_path ? [m.image_path] : [];
    if (!imgs.length) return;
    let roleId = '';
    if (current.chat_type === 'single') {
      roleId = await api.resolveRoleId(current.chat_type, current.chat_id);
    } else if (m.sender_type === 'ai') {
      const r = members.find((x) => x.name === m.sender_name);
      roleId = r?.id || '';
    }
    if (!roleId) {
      showToast(t('chat.drawMemoryNoRole'));
      return;
    }
    await api.saveImageMemory({ roleId, imagePath: imgs[0] });
    showToast(t('chat.drawMemorySaved'));
  };
  const handleRecall = async (msgId: number) => {
    if (!(await api.showConfirm!(t('msg.recallConfirm')))) return;
    const res = await api.recallMessage(msgId);
    showToast(res.deletedMems > 0 ? t('msg.recallDone', { n: res.deletedMems }) : t('msg.recallDoneNone'));
    setRoleMissing(false);
    reloadMessages();
    if (current) api.syncMessages({ chatType: current.chat_type, chatId: current.chat_id, action: 'recalled' });
  };

  // 清空当前聊天消息（可选是否连同自动记忆一起删除）
  const handleClearChat = async (withMemories: boolean) => {
    if (!current) return;
    setClearOpen(false);
    const res = await api.clearChatMessages(current.chat_type, current.chat_id, withMemories);
    showToast(
      withMemories
        ? t('chat.clearMessagesDoneWithMem', { n: res.deletedMsgs, m: res.deletedMems })
        : t('chat.clearMessagesDone', { n: res.deletedMsgs })
    );
    reloadMessages();
    api.syncMessages({ chatType: current.chat_type, chatId: current.chat_id, action: 'cleared' });
  };
  const handleRollback = async (chatType: string, chatId: string, msgId: number) => {
    if (!(await api.showConfirm!(t('msg.rollbackConfirm')))) return;
    const res = await api.rollbackMessages({ chatType, chatId, fromMsgId: msgId });
    showToast(t('msg.rollbackDone', { n: res.deletedMsgs, m: res.deletedMems }));
    setRoleMissing(false);
    reloadMessages();
    api.syncMessages({ chatType, chatId, action: 'rolledBack' });
  };

  const reloadMessages = () => {
    if (current) api.getMessages(current.chat_type, current.chat_id).then((msgs) => setMessages(msgs.slice(-10)));
  };

  // 消息列表更新后聚焦输入框（回滚/撤回等操作导致 messages 变化后自动恢复焦点）
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [messages]);

  // 会话切换 / 刷新 UI 后，使用 requestAnimationFrame 在下一帧可靠地把焦点交回输入框。
  // 直接依赖 autoFocus 在「删除会话后就地切换」等场景下不可靠（节点挂载时机/窗口焦点问题），
  // 会导致输入框看似存在却无法输入，故改为程序化聚焦。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [current?.chat_type, current?.chat_id, refreshNonce]);

  // ===== 群聊连续对话：手动接力一轮 / 自动接话循环（与主界面一致） =====
  const continueOnce = async () => {
    if (!current || continuing || sending) return;
    setContinuing(true);
    try {
      await api.groupContinue({ chatId: current.chat_id });
      showToast(t('chat.toastGroupContinue'));
    } finally {
      setContinuing(false);
    }
  };

  const stopAuto = () => {
    autoRef.current = false;
    setAutoChat(false);
    if (current) api.forceStopAutoChat(current.chat_id);
  };

  const startAuto = async () => {
    if (!current || autoRef.current || sending) return;
    const chatId = current.chat_id;
    // 先争抢 driver 角色
    const claim = await api.claimAutoChat(chatId);
    if (!claim.isDriver) {
      showToast(t('chat.autoAlreadyRunning'), { error: true });
      return;
    }
    autoRef.current = true;
    setAutoChat(true);
    setAutoRound(0);
    showToast(t('chat.toastAutoStart'));
    // 每次启动时读取最新设置：0 = 无限轮
    const s = await api.getSettings();
    const limit = Math.max(0, Math.floor(s.groupAutoRounds ?? 6));
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
      api.updateAutoChatRound(chatId, n);
      if (limit !== 0 && n >= limit) break;
      // 轮间间隔：给用户插话/停止的窗口
      await new Promise((r) => setTimeout(r, 1500));
    }
    autoRef.current = false;
    setAutoChat(false);
    api.releaseAutoChat(chatId);
    showToast(t('chat.toastAutoStop'));
  };

  // 用户发消息后，若开启「AI 主动续聊」，在首轮完成后自动进入自动接话循环
  const maybeChain = () => {
    if (current?.chat_type === 'group' && groupAutoChain) startAuto();
  };

  // 卸载时终止自动接话循环
  useEffect(() => {
    return () => {
      autoRef.current = false;
      pendingAutoChain.current = false;
    };
  }, []);

  // 切换会话时,如旧的会话正持有群成员编辑锁,主动释放
  useEffect(() => {
    const prev = miniPrevChatIdRef.current;
    if (prev && prev !== current?.chat_id && showGroupEditor) {
      api.closeGroupEditor(prev).catch(() => {});
      setShowGroupEditor(false);
    }
    miniPrevChatIdRef.current = current?.chat_id;
  }, [current?.chat_id, showGroupEditor]);

  // 群聊仅剩 1 人 → 转为该成员的单聊
  const handleConvertToSingle = async () => {
    if (!current || current.chat_type !== 'group') return;
    const only = members[0];
    if (!only) return;
    await api.convertGroupToSingle(current.chat_id, only.id);
    setConvertPrompt(false);
    showToast(t('chat.toastConverted', { name: only.name }));
    const list = await api.getChatList();
    setChats(list);
    const next = list.find((c) => c.chat_type === 'single' && c.chat_id === only.id);
    if (next) setCurrent(next);
  };

  // ===== 群成员编辑：单窗口锁 =====
  const openGroupEditorLocked = async () => {
    if (!current) return;
    const res = await api.openGroupEditor(current.chat_id);
    if (!res.ok) {
      showToast(t('group.editLockedTip'), { error: true });
      return;
    }
    setShowGroupEditor(true);
  };
  const closeGroupEditorLocked = () => {
    setShowGroupEditor(false);
    if (current) api.closeGroupEditor(current.chat_id);
  };
  const onGroupEditorUpdatedLocked = () => {
    setShowGroupEditor(false);
    if (current) api.closeGroupEditor(current.chat_id);
    if (current) loadMembers(current);
    if (current) api.notifyGroupEditorSaved(current.chat_id);
  };

  // 监听其他窗口编辑群成员事件：saved 时刷新成员列表
  useEffect(() => {
    if (!current || current.chat_type !== 'group') return;
    const off = api.onGroupEditorState((data) => {
      if (data.groupId !== current.chat_id) return;
      if (data.action === 'saved') {
        loadMembers(current);
        showToast(t('group.editSavedSync'));
      }
    });
    return off;
  }, [current]);

  const handleKeepGroup = async () => {
    if (!current || current.chat_type !== 'group') return;
    await api.setGroupIgnoreConvert(current.chat_id, { error: true });
    setConvertPrompt(false);
  };

  const pickImage = async () => {
    const paths = await api.pickImage();
    if (paths && paths.length) setPendingImages((prev) => [...prev, ...paths]);
  };

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    api.miniSetOnTop(next);
  };

  const switchChat = (key: string) => {
    setObserverPrivate(false);
    const hit = chats.find((c) => `${c.chat_type}:${c.chat_id}` === key);
    if (hit) setCurrent(hit);
  };

  // 切换当前对话使用的「自我身份」：写入按会话覆盖 chatSelfRoles[key]
  const changeSelfRole = async (val: string) => {
    setSelfRoleId(val);
    if (!current) return;
    const settings = await api.getSettings();
    const key = `${current.chat_type}:${current.chat_id}`;
    const next = { ...(settings.chatSelfRoles || {}) };
    if (val === 'default') delete next[key];
    else next[key] = val;
    await api.saveSettings({ chatSelfRoles: next });
    const name = val === 'default'
      ? t('chat.selfRoleDefault')
      : (selfRoles.find((r) => r.id === val)?.name || val);
    showToast(t('chat.selfRoleSwitched', { name }));
  };

  // 切换本对话世界书：写入 chatWorldBooks[key]
  const changeChatWorldBook = async (val: string) => {
    setChatWorldBookId(val);
    if (!current) return;
    const settings = await api.getSettings();
    const key = `${current.chat_type}:${current.chat_id}`;
    const next = { ...(settings.chatWorldBooks || {}) };
    if (val === '') delete next[key];
    else next[key] = val;
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
    if (!current) return;
    const settings = await api.getSettings();
    const key = `${current.chat_type}:${current.chat_id}`;
    const next = { ...(settings.autoSceneImageChats || {}) };
    if (v) next[key] = true;
    else delete next[key];
    await api.saveSettings({ autoSceneImageChats: next });
    showToast(t(v ? 'chat.sceneImageOn' : 'chat.sceneImageOff'), { duration: 2000, animation: 'linear' });
  };

  // 本对话独立开关：联网搜索
  const toggleWebSearch = async (v: boolean) => {
    setWebSearchOn(v);
    if (!current) return;
    const settings = await api.getSettings();
    const key = `${current.chat_type}:${current.chat_id}`;
    const next = { ...(settings.webSearchChats || {}) };
    if (v) next[key] = true;
    else delete next[key];
    await api.saveSettings({ webSearchChats: next });
    showToast(t(v ? 'chat.webSearchOn' : 'chat.webSearchOff'), { duration: 2000, animation: 'linear' });
  };

  // ---------- 语音输入（ASR） ----------
  // ---------- 文本转语音（TTS） ----------
  const speak = async (msg: ChatMessage) => {
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

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const allMessages = [...messages];
  for (const sm of Object.values(streamingMsgs)) {
    const lastIdx = allMessages.findIndex((m) => m.id === sm.id);
    if (lastIdx >= 0) allMessages[lastIdx] = sm;
    else allMessages.push(sm);
  }
  const uniqueMessages = new Map<number | string, ChatMessage>();
  for (const m of allMessages) uniqueMessages.set(m.id, m);
  const allMessagesUnique = Array.from(uniqueMessages.values());

  const replying = sending || Object.keys(streamingMsgs).length > 0;
  const isStreaming = Object.keys(streamingMsgs).length > 0;
  const totalTokens = messages.reduce((s, m) => s + (m.token_used || 0), 0);

  const activeSelfRole = selfRoleId !== 'none' && selfRoleId !== 'default'
    ? selfRoles.find((r) => r.id === selfRoleId)
    : (defaultSelfId ? selfRoles.find((r) => r.id === defaultSelfId) : undefined);
  const userAvatarPath = activeSelfRole?.avatar_path;

  return (
    <div className="mini-shell">
      {/* 自定义无边框标题栏（小窗紧凑版） */}
      <CustomTitleBar
        variant="mini"
        title={
          observerPrivate && current
            ? t('observer.privateTitle', { name: current.name })
            : (current?.name || t('mini.noChat')) + (roleMood ? ` · ${roleMood}` : '')
        }
        avatar={current?.avatar_path}
        pinned={pinned}
        onTogglePin={togglePin}
        onOpenMain={() => api.showMainWindow()}
      />

      {/* 会话切换 + 操作 */}
      <div className="mini-switch">
        <SelectMenu
          value={current ? `${current.chat_type}:${current.chat_id}` : ''}
          onChange={(v) => switchChat(v)}
          style={{ width: '100%' }}
          options={[
            ...(chats.length === 0 ? [{ value: '', label: t('mini.noChat') }] : []),
            ...chats.map((c) => ({
              value: `${c.chat_type}:${c.chat_id}`,
              label: `${c.chat_type === 'group' ? '👥 ' : '👤 '}${c.name}`,
            })),
            ...(current && !chats.some((c) => c.chat_id === current.chat_id)
              ? [{
                  value: `${current.chat_type}:${current.chat_id}`,
                  label: `🔒 ${observerPrivate ? t('observer.private') : current.name}`,
                }]
              : []),
          ]}
        />
        {selfRoles.length > 0 && current && (
          <SelectMenu
            value={selfRoleId}
            onChange={(v) => changeSelfRole(v)}
            title={t('chat.selfRoleLabel')}
            style={{ fontSize: 12, marginTop: 6, width: '100%' }}
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
        {current && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'flex-start' }}>
            <SelectMenu
              value={chatWorldBookId}
              onChange={(v) => changeChatWorldBook(v)}
              title={t('worldbook.select')}
              style={{ fontSize: 12, flex: 1, minWidth: 0 }}
              options={[
                { value: '', label: `📖 ${t('worldbook.inherit')}` },
                { value: 'none', label: t('worldbook.none') },
                ...worldBooks.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
            <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: 34 }}>
              <button
                className={`idle-toggle${idleReplyOn ? ' on' : ''}`}
                title={t('chat.idleReplyTip')}
                style={!idleReplyOn ? { flex: 1, justifyContent: 'center' } : undefined}
                onClick={async () => {
                  const settings = await api.getSettings();
                  if (settings.idleEnabled === false) return;
                  const next = !idleReplyOn;
                  setIdleReplyOn(next);
                  idleReplyOnRef.current = next;
                  const key = `${current.chat_type}:${current.chat_id}`;
                  const map = { ...(settings.chatIdleEnabled || {}), [key]: next };
                  await api.saveSettings({ chatIdleEnabled: map });
                }}
              >
                <span className="idle-toggle-knob" />
                <span className="idle-toggle-label">{t('chat.idleReply')}</span>
              </button>
              {idleReplyOn && idleCountdown > 0 && (
                <span className="idle-countdown" title={t('chat.idleCountdownTip')} style={{ fontSize: 11, textAlign: 'center', marginTop: 1 }}>
                  {idleCountdown >= 60
                    ? `${Math.floor(idleCountdown / 60)}m${idleCountdown % 60}s`
                    : `${idleCountdown}s`}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {replying && (
        <div className="replying-bar">
          <span className="dot" />
          {t('chat.replying')}
        </div>
      )}

      {/* 群聊仅剩 1 人：提示转为单聊 */}
      {convertPrompt && !roleMissing && current?.chat_type === 'group' && (
        <div className="alert-bar alert-warn" style={{ flexShrink: 0 }}>
          <div style={{ flex: 1, fontSize: 12 }}>
            <div style={{ fontWeight: 600 }}>{t('chat.convertTitle')}</div>
            <div style={{ fontSize: 11, marginTop: 2 }}>
              {t('chat.convertPrompt', { name: members[0]?.name || '' })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-primary" style={{ padding: '3px 8px', fontSize: 11 }} onClick={handleConvertToSingle}>
              {t('chat.convertToSingle')}
            </button>
            <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={handleKeepGroup}>
              {t('chat.keepGroup')}
            </button>
          </div>
        </div>
      )}

      {/* 群聊部分成员被删除 */}
      {!convertPrompt && membersMissing > 0 && (
        <div className="alert-bar alert-info" style={{ flexShrink: 0 }}>
          ⚠️ {t('chat.membersDeleted')}
        </div>
      )}

      {/* 观察者私密小窗提示：本窗对话隔离于公屏，且强制展示 AI 内心推演 */}
      {observerPrivate && (
        <div className="alert-bar obs-private-hint" style={{ flexShrink: 0 }}>
          🔒 {t('observer.privateHint')}
        </div>
      )}

      {searchOpen && (
        <MessageSearch
          messages={allMessagesUnique}
          compact
          onClose={() => setSearchOpen(false)}
          onJump={(msgId) => {
            const el = document.querySelector(`[data-mid="${msgId}"]`);
            if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        />
      )}

      {/* 消息列表（最近 10 条） */}
      <CustomScrollArea className="mini-messages" scrollRef={scrollRef} style={chatBg ? {
        flex: 1,
        backgroundImage: `url(${chatBg})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      } : { flex: 1 }}>
        {allMessages.length === 0 && (
          <div className="empty-state" style={{ fontSize: 12 }}>
            {current ? t('chat.empty', { name: current.name }) : t('mini.empty')}
          </div>
        )}
        {allMessagesUnique.map((m) => {
          const sid = (m as any).streamId || streamMsgIdRef.current[String(m.id)];
          const sr = sid ? searchResultsByStream[sid] : undefined;
          return (
            <Fragment key={m.id}>
              <MiniMessageRow
                key={m.id}
                msg={m}
                onImage={setPreview}
                fmtTime={fmtTime}
                modelName={m.sender_type === 'ai' ? modelMap[m.sender_name] : undefined}
                avatarPath={m.sender_type === 'ai' ? avatarMap[m.sender_name] : undefined}
                userAvatarPath={userAvatarPath}
                showTts={voiceCfg.tts && m.sender_type === 'ai' && !!m.content}
                speaking={speakingId === m.id}
                hideReasoning={observerPrivate ? false : hideReasoning}
                onSpeak={() => speak(m)}
                onReasoningCopied={() => showToast(t('toast.reasoningCopied'))}
                onQuickMemory={(text) => handleQuickMemory(m, text)}
                onSaveImageMemory={handleSaveImageMemory}
                onRollback={(msgId) => handleRollback(m.chat_type, m.chat_id, msgId)}
                onRecall={(msgId) => handleRecall(msgId)}
                onCopy={(text) => { navigator.clipboard.writeText(text); showToast(t('toast.copied')); }}
                onTranslate={handleTranslate}
                onMarkNode={storyOn ? markNode : undefined}
                failed={failed}
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
        <div className="alert-bar alert-danger" style={{ flexShrink: 0 }}>
          ⛔ {t('chat.roleDeleted')}
        </div>
      )}

      {/* 输入区 */}
      <div className="mini-composer" style={{ position: 'relative', flexDirection: 'column' }}>
        <button
          className={`scroll-to-bottom mini-scroll-to-bottom${showScrollBtn ? ' visible' : ''}`}
          onClick={scrollToBottom}
          title={t('chat.scrollToBottom')}
        >
          ⬇ {t('chat.scrollToBottom')}
        </button>
        {showMention && members.length > 0 && (
          <div className="mention-pop" style={{ bottom: '100%', left: 10, marginBottom: 4 }}>
            {members.map((r) => (
              <div key={r.id} className="item" onClick={() => insertMention(r)}>
                @{r.name}
              </div>
            ))}
          </div>
        )}
      <div className="mini-toolbar">
        <button className="mini-btn" title={t('mini.menu')} onClick={() => setDrawerOpen((o) => !o)}>
          ☰
        </button>
        <button
          className={`mini-btn${voice.recording ? ' recording' : ''}`}
          title={voice.recording ? t('chat.voiceRecording') : t('chat.voiceInput')}
          onClick={voice.toggle}
        >
          {voice.recording ? '⏹' : '🎤'}
        </button>
        <button className="mini-btn" title={t('chat.sendImage')} onClick={pickImage}>
          🖼️
        </button>
        <button className="mini-btn" title={t('chat.drawImage')} onClick={() => setGenOpen(true)}>
          🎨
        </button>
        <button
          className={`mini-btn${sceneImageOn ? ' active' : ''}`}
          title={t('chat.sceneImageToggle')}
          onClick={() => toggleSceneImage(!sceneImageOn)}
        >
          🖼️
        </button>
        <button
          className={`mini-btn${webSearchOn ? ' active' : ''}`}
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
          className={`mini-btn${searchOpen ? ' active' : ''}`}
          title={t('search.title')}
          onClick={() => setSearchOpen((o) => !o)}
        >
          🔍
        </button>
        <button
          className={`mini-btn${enableStreaming ? ' active' : ''}`}
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
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {t('chat.tokenBar', { total: totalTokens, global: globalTokens })}
        </span>
      </div>
        {pendingImages.length > 0 && (
          <div className="img-preview-bar mini">
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
          <div className="qps-queue mini">
            <span className="qps-tip">⏳ {t('chat.rateLimited')}</span>
            <span className="qps-count">{t('chat.queueAutoSend', { sec: queueLeft })}</span>
            <button className="qps-cancel" onClick={() => setQueue(null)}>
              {t('chat.queueCancel')}
            </button>
          </div>
        )}
        {/* F1：群聊消息可见性 / 记忆开关（仅群聊显示） */}
        {current?.chat_type === 'group' && (
          <div className="send-row">
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
          </div>
        )}
        {/* F4：发图生图 / 生视频（有附图且已输入提示词时显示） */}
        {pendingImages.length > 0 && input.trim() && (
          <div className="send-row">
            <span className="reply-flags">
              <button className="btn-ghost" disabled={sending} onClick={() => doGenerateFromImage('image')}>
                {t('chat.genImageFromImage')}
              </button>
              <button className="btn-ghost" disabled={sending} onClick={() => doGenerateFromImage('video')}>
                {t('chat.genVideoFromImage')}
              </button>
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, width: '100%' }} onClick={() => inputRef.current?.focus()}>
          <textarea
            key={current ? `${current.chat_type}:${current.chat_id}:${refreshNonce}` : `none:${refreshNonce}`}
            ref={inputRef}
            className="chat-input"
            value={input}
            placeholder={current?.chat_type === 'group' ? t('chat.placeholder') + ' · ' + t('chat.mentionHint') : t('chat.placeholder')}
            readOnly={!current || roleMissing}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (isStreaming) return;
                send();
              }
            }}
          />
          {isStreaming ? (
            <button
              className="btn-primary mini-send"
              onClick={() => current && api.interruptStream(current.chat_id)}
              title={t('chat.interruptTip')}
              aria-label={t('chat.interrupt')}
            >
              <span className="interrupt-icon" />
            </button>
          ) : (
            <button className="btn-primary mini-send" disabled={sending || !current || roleMissing} onClick={send}>
              {sending ? '…' : t('chat.send')}
            </button>
          )}
        </div>
      </div>

      {drawerOpen && (
        <div className="mini-drawer-mask" onClick={() => setDrawerOpen(false)}>
          <div className="mini-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="mini-drawer-head">
              <span>{t('mini.menu')}</span>
              <span className="mini-drawer-close" onClick={() => setDrawerOpen(false)}>×</span>
            </div>
            <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); setMomentsOpen(true); }}>
              🌟 {t('nav.moments')}
            </div>
            <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); triggerEvent(); }}>
              🎲 {t('chat.randomEvent')}
            </div>
            <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); toggleStory(); }}>
              📖 {storyOn ? t('chat.storyOff') : t('chat.storyOn')}
            </div>
            {current?.chat_type === 'single' && (
              <div
                className="mini-drawer-item"
                onClick={async () => {
                  setDrawerOpen(false);
                  const rid = await api.resolveRoleId(current.chat_type, current.chat_id);
                  setBondRoleId(rid);
                  setBondOpen(true);
                }}
              >
                💞 {t('bond.title')}
              </div>
            )}
            {current?.chat_type === 'group' && (
              <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); openGroupEditorLocked(); }}>
                👥✎ {t('group.edit')}
              </div>
            )}
            {current?.chat_type === 'group' && groupAutoChain && (
              <>
                <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); continueOnce(); }}>
                  ▶ {t('group.continueTalk')}
                </div>
                <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); autoChat ? stopAuto() : startAuto(); }}>
                  {autoChat ? `⏹ ${autoRound}` : '🔁'} {autoChat ? t('group.autoStop') : t('group.autoTalk')}
                </div>
              </>
            )}
            <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); scrollToBottom(); }}>
              🔝 {t('chat.scrollToBottom')}
            </div>
            <div className="mini-drawer-item" onClick={() => { setDrawerOpen(false); setClearOpen(true); }}>
              🧹 {t('chat.clearMessages')}
            </div>
          </div>
        </div>
      )}

      {momentsOpen && (
        <div className="modal-mask" onClick={() => setMomentsOpen(false)}>
          <div className="modal moments-modal" onClick={(e) => e.stopPropagation()}>
            <MomentsView />
          </div>
        </div>
      )}

      {bondOpen && bondRoleId && (
        <BondPanel roleId={bondRoleId} roleName={current?.name} onClose={() => setBondOpen(false)} />
      )}

      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <img className="image-preview" src={preview} alt={t('chat.preview')} />
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
      {translateModal && (
        <div className="modal-mask" onClick={() => setTranslateModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: '90%' }}>
            <div className="modal-title">{t('msg.translate')}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('msg.translateSource')}</div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflowY: 'auto', padding: 8, background: 'var(--color-panel-alt)', borderRadius: 8, marginBottom: 10 }}>
              {translateModal.source}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('msg.translateResult')}</div>
            {translateModal.loading ? (
              <div style={{ padding: 8 }}>{t('chat.transcribing')}</div>
            ) : translateModal.error ? (
              <div style={{ color: '#e74c3c', padding: 8 }}>{translateModal.error}</div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto', padding: 8, background: 'var(--color-panel)', borderRadius: 8 }}>
                {translateModal.text}
              </div>
            )}
            <div style={{ textAlign: 'right', marginTop: 12 }}>
              <button className="btn-primary" onClick={() => setTranslateModal(null)}>{t('common.ok')}</button>
            </div>
          </div>
        </div>
      )}

      {genOpen && (
        <div className="modal-mask" onClick={() => !genLoading && setGenOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, width: '90%' }}>
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
            <div style={{ textAlign: 'right', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" disabled={genLoading} onClick={() => setGenOpen(false)}>
                {t('msg.editCancel')}
              </button>
              <button className="btn-primary" disabled={genLoading || !genText.trim()} onClick={doGenerate}>
                {t('chat.drawImage')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 好感度变化提示（与主界面一致） */}
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
            if (current) void api.eventClosed({ chatType: current.chat_type, chatId: current.chat_id });
          }}
        />
      )}

      {showGroupEditor && current?.chat_type === 'group' && (
        <GroupEditor
          group={{
            group_id: current.chat_id,
            group_name: current.name,
            member_ids: members.map((m) => m.id).join(','),
            created_at: '',
          }}
          onClose={closeGroupEditorLocked}
          onUpdated={onGroupEditorUpdatedLocked}
        />
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
      <ToastView toast={toast} />
      <CustomCursor />
      <ErrorBubble />
      <ClearChatModal
        open={clearOpen}
        onCancel={() => setClearOpen(false)}
        onConfirm={handleClearChat}
      />
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

const MiniMessageRow: React.FC<{
  msg: ChatMessage;
  onImage: (src: string) => void;
  fmtTime: (iso: string) => string;
  modelName?: string;
  avatarPath?: string;
  userAvatarPath?: string;
  showTts?: boolean;
  speaking?: boolean;
  hideReasoning?: boolean;
  onSpeak?: () => void;
  onReasoningCopied?: () => void;
  onQuickMemory?: (text: string) => void;
  onSaveImageMemory?: (msg: ChatMessage) => void;
  onRollback?: (msgId: number) => void;
  onRecall?: (msgId: number) => void;
  onCopy?: (text: string) => void;
  onTranslate?: (text: string) => void;
  onMarkNode?: (msg: ChatMessage) => void;
  failed?: { content: string; imagePaths: string[]; phase: 'full' | 'ai'; error: string } | null;
  searchResults?: SearchResultItem[];
}> = ({
  msg, onImage, fmtTime, modelName, avatarPath, userAvatarPath, showTts, speaking, hideReasoning, onSpeak, onReasoningCopied,
  onQuickMemory, onSaveImageMemory, onRollback, onRecall, onCopy, onTranslate, onMarkNode, failed, searchResults,
}) => {
  const { t } = useI18n();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selPopup, setSelPopup] = useState<{ x: number; y: number; text: string } | null>(null);
  const recalled = msg.status === 'recalled';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 跨气泡协调：通知其他气泡关闭各自的右键菜单，保证一个聊天界面同时只有一个菜单
    window.dispatchEvent(new CustomEvent('nianyu:closeCtxMenu', { detail: msg.id }));
    setMenuPos({ x: e.clientX, y: e.clientY });
  };
  const closeMenu = () => { setMenuPos(null); setSelPopup(null); };

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

  if (msg.sender_type === 'system') {
    return <div className="system-msg" style={{ padding: '2px 8px' }}>{msg.content}</div>;
  }
  if (recalled) {
    return (
      <div className="msg-row system" style={{ textAlign: 'center' }}>
        <span className="recalled-tag">↩ {t('msg.recalled')}</span>
      </div>
    );
  }
  const isUser = msg.sender_type === 'user';
  const streaming = msg.sender_type === 'ai' && (msg.id as number) < 0;
  const typing = streaming && !msg.content && !msg.reasoning;
  // 多图优先
  const imgs = msg.images && msg.images.length ? msg.images : msg.image_path ? [msg.image_path] : [];
  const hasText = !!(msg.content && msg.content.trim());

  // 联网搜索内联引用：仅 AI 消息、且本消息对应 stream 有搜索结果时启用 [n] 可点击
  const citeCitations = (!isUser && searchResults && searchResults.length)
    ? Object.fromEntries(searchResults.map((r, idx) => [idx + 1, r.url]))
    : undefined;
  const citeOnClick = citeCitations
    ? (url: string) => { try { api?.openExternal?.(url); } catch { /* web/Capacitor 构建无此接口时忽略 */ } }
    : undefined;
  return (
    <div className={`msg-row ${isUser ? 'user' : 'ai'}`} data-mid={msg.id} onContextMenu={handleContextMenu}>
      {!isUser ? (
        <div className="avatar" style={{ marginRight: 6, fontSize: 16 }}>
          {avatarPath ? <AvatarImg path={avatarPath} /> : '🤖'}
        </div>
      ) : userAvatarPath ? (
        <div className="avatar" style={{ marginRight: 6, fontSize: 16 }}>
          <AvatarImg path={userAvatarPath} />
        </div>
      ) : null}
      <div style={{ maxWidth: '100%' }}>
        {!isUser && (
          <div className="sender">
            {msg.sender_name}
            {modelName && <span className="model-tag">{t('chat.modelTag', { name: modelName })}</span>}
          </div>
        )}
        {typing ? (
          <div className="bubble" onMouseUp={handleMouseUp}>
            <div className="typing">
              <div className="typing-bar" />
            </div>
          </div>
        ) : (
          <>
            {(!isUser && msg.reasoning) || hasText ? (
              <div className={`bubble ${failed ? 'bubble-failed' : ''}`} onMouseUp={handleMouseUp}>
                {!isUser && msg.reasoning && (
                  <ReasoningBlock
                    reasoning={msg.reasoning}
                    defaultOpen={hideReasoning === false || (streaming && !msg.content)}
                    streaming={streaming && !msg.content}
                    onCopied={onReasoningCopied}
                  />
                )}
                {hasText && renderMarkdown(msg.content, { citations: citeCitations, onCite: citeOnClick })}
                {/* F6 修复：流式进行中始终在气泡内显示加载动画 */}
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
          </>
        )}
        <div className="msg-meta">
          <span>{fmtTime(msg.timestamp)}</span>
          {!isUser && msg.token_used > 0 && <span>{t('chat.tokensUsed', { n: msg.token_used })}</span>}
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
          <button className="ctx-menu-item" onClick={() => { onCopy?.(msg.content); closeMenu(); }}>{t('msg.copy')}</button>
          {msg.genPrompt && (
            <button className="ctx-menu-item" onClick={() => { setPromptView(msg.genPrompt!); closeMenu(); }}>{t('msg.viewPrompt')}</button>
          )}
          {onQuickMemory && <button className="ctx-menu-item" onClick={() => { onQuickMemory(msg.content); closeMenu(); }}>{t('msg.quickMemory')}</button>}
          {onTranslate && <button className="ctx-menu-item" onClick={() => { onTranslate(msg.content); closeMenu(); }}>{t('msg.translate')}</button>}
          {onMarkNode && <button className="ctx-menu-item" onClick={() => { onMarkNode(msg); closeMenu(); }}>{t('chat.markNode')}</button>}
          {onSaveImageMemory && (msg.images?.length || msg.image_path) && (
            <button className="ctx-menu-item" onClick={() => { onSaveImageMemory(msg); closeMenu(); }}>{t('chat.drawMemory')}</button>
          )}
          {onRollback && <button className="ctx-menu-item ctx-menu-danger" onClick={() => { onRollback(msg.id); closeMenu(); }}>{t('msg.rollback')}</button>}
          {onRecall && <button className="ctx-menu-item ctx-menu-danger" onClick={() => { onRecall(msg.id); closeMenu(); }}>{t('msg.recall')}</button>}
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
          <button className="sel-popup-btn" onClick={() => { onQuickMemory(selPopup.text); setSelPopup(null); }}>
            🧠 {t('msg.quickMemory')}
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};

