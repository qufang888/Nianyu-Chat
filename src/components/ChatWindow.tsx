import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment } from 'react';

import { createPortal } from 'react-dom';

import { api } from '../ipc';

import { useI18n } from '../i18n/I18nContext';

import type { ChatListItem, ChatMessage, ChatType, Role, SelfRole, UpdateStatus, WorldBook } from '../types';



// 联网搜索结果项（后端 search:results 广播的结构，前端仅用于折叠展示）

interface SearchResultItem {

  title: string;

  url: string;

  snippet: string;

}

import { renderMarkdown } from '../utils/markdown';

import { filterSpeechText } from '../utils/speechScope';

import { AvatarImg } from './ChatList';

import { GroupEditor } from './GroupEditor';

import { ChatModelPicker } from './ChatModelPicker';

import { useToast, ToastView } from './Toast';

// v2.3.81：异步场景生图状态条（「正在生图中…」+ 成功/失败站内 Toast）
import { SceneImageStatusBar, useSceneImageStatus } from './SceneImageStatusBar';

import { ReasoningBlock } from './ReasoningBlock';

import RandomEventModal, { RandomEventData } from './RandomEventModal';

import PendingImageThumb from './PendingImageThumb';

import ImageGrid from './ImageGrid';

import { ImageCropper } from './ImageCropper';

import SelectMenu from './SelectMenu';

// v2.3.90：菜单缩入（关闭）动画通用 Hook —— 关闭时先播与弹出对称的缩入动画再卸载 DOM
import { useRetract } from '../hooks/useRetract';
import { useMenuRelocate } from '../hooks/useMenuRelocate';

import { previewSound, playSoundSync } from '../utils/sound';

import { animMs } from '../utils/animControl';

import { useVoiceInput } from '../hooks/useVoiceInput';

import { EVENT_COOLDOWN_MS, EVENT_TRIGGER_THRESHOLD } from '../eventThemes';

import { getEventStore, setEventStore } from '../utils/eventStore';

import { setIdleActivity } from '../utils/idleTimerStore';

// v2.3.94 需求 11：陪伴时长计时（模块级状态 + 1s 心跳 + 30s 批量上报）
import { startCompanionTimer } from '../utils/companionTimer';

import { resolveWantStream, resolveStreamInfo, persistStreamToggle, type StreamPref } from '../utils/chatStream';

// v2.3.101：主题色取自聊天背景主体色（无背景/关开关时回退主题默认）
import { useTheme } from '../theme/ThemeContext';
import {
  extractDominantColor,
  deriveAccent,
  deriveInkForSurfaces,
  computePrimarySurfaces,
  computeSecondarySurfaces,
} from '../utils/dominantColor';

import { usePseudoReveal, markPseudoPending, isPseudoPending, clearPseudoPending } from '../utils/pseudoStream';

import { NodeBanner } from './NodeBanner';

import { clampPseudoSpeed, PSEUDO_QUEUE } from '../types';

import CustomScrollArea from './CustomScrollArea';

import { ClearChatModal } from './ClearChatModal';

import { MessageSearch } from './MessageSearch';

import { BondPanel } from './BondPanel';
import { TranslateModal } from './TranslateModal';



// 拖拽添加接受的图片扩展名（v2.3.51）：与主进程 dialog:pickImage 的过滤器保持一致

// v2.3.102 需求 1：计算「打断后重发」按钮应挂在哪条用户消息下（主窗定义，小窗 import 复用同一份逻辑）。
// 语义：取最后一条用户消息；若它之后存在被标记 interrupted 的非用户消息 → 返回该用户消息 id，否则 null。
// 覆盖两种用户场景：
//   a) AI 已输出一部分后被用户打断（末尾存在 interrupted=true 的 AI 消息）；
//   b) AI 一个字都没输出就被打断（主进程在打断分支仍会落一条带 interrupted=true 的占位消息）。
// 两种情况都能命中同一条判定分支。interrupted 仅由主进程在打断落库时写入，正常完成不写。
export function computeInterruptedAnchorId(msgs: ChatMessage[]): number | null {
  // 1) 定位最后一条用户消息
  let ui = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].sender_type === 'user') { ui = i; break; }
  }
  if (ui < 0) return null;
  // 2) 若其后存在被标记「打断」的非用户消息 → 该用户消息即锚点；否则不显示按钮
  const tail = msgs.slice(ui + 1);
  return tail.some((m) => m.sender_type !== 'user' && m.interrupted) ? msgs[ui].id : null;
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;



export const ChatWindow: React.FC<{

  chatType: string;

  chatId: string;

  name: string;

  members: Role[]; // 群聊成员（用于 @ 提及）

  onSent: () => void;

  onChatDeleted?: (chatId: string) => void;

  onConvertedToSingle?: (roleId: string) => void;

  onGroupUpdated?: () => void;

  onForked?: (chat: { chat_type: string; chat_id: string; name: string }) => void; // 从剧情节点分叉成功后切换到新聊天（v2.3.37）

}> = ({ chatType, chatId, name, members, onSent, onChatDeleted, onConvertedToSingle, onGroupUpdated, onForked }) => {

  const { t } = useI18n();

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [input, setInput] = useState('');

  const [sending, setSending] = useState(false);

  const [pendingImages, setPendingImages] = useState<string[]>([]);

  const pendingImagesRef = useRef(pendingImages);

  pendingImagesRef.current = pendingImages;

  const [preview, setPreview] = useState<string | null>(null);

  const [affinityPop, setAffinityPop] = useState<string | null>(null);

  // v2.3.94 需求 10：翻译弹窗改为只存「原文」，其余状态（译文/朗读/段落删除）全部下沉到
  // 共享组件 TranslateModal —— 主窗与小窗用同一个组件，能力天然一致（小窗同步铁律）。
  const [translateModal, setTranslateModal] = useState<{ source: string; senderName?: string } | null>(null);

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

  // 节点横幅 / 内联改名（v2.3.37）

  const [nodeBanner, setNodeBanner] = useState<{ title: string; subtitle?: string } | null>(null);

  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);

  const [editingTitle, setEditingTitle] = useState('');

  const [forking, setForking] = useState(false);

  const storiesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {

    api.getStoryEnabled(chatType, chatId).then(setStoryOn);

    api.listStoryNodes(chatType, chatId).then(setStoryNodes);

  }, [chatType, chatId]);

  // ===== v2.3.94 需求 11：陪伴时长计时 =====

  // 「前台可见 + 窗口有焦点」时按 1s 心跳累计；卸载/隐藏/失焦自动停表。
  // 计时状态在模块级（utils/companionTimer.ts），组件只负责起停 —— 因此同一条消息里
  // 渲染多个组件也不会把时长算多份。增量上报由模块按 30s 批量 flush，主进程再合并落盘。
  useEffect(() => {

    const stop = startCompanionTimer(chatType, chatId);

    return stop;

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

  const gotoNode = async (node: { msg_id: number; title: string }) => {

    const el = document.querySelector(`[data-mid="${node.msg_id}"]`);

    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 切换/跳转到剧情节点：弹出横幅展示节点名称（1s 弹入 → 3.5s 停留 → 渐隐 + 音效）

    setNodeBanner({ title: node.title, subtitle: t('chat.nodeBannerJump') });

  };

  const renameNode = async (id: number, title: string) => {

    await api.renameStoryNode(id, title);

    setStoryNodes(await api.listStoryNodes(chatType, chatId));

    setEditingNodeId(null);

    showToast(t('chat.nodeRenamed'));

    // 编辑结束：若鼠标已不在侧栏上，恢复自动收起（编辑期间移出被挂起，收起动作被延迟到此时）

    if (storiesRef.current && !storiesRef.current.matches(':hover')) setShowStories(false);

  };

  const forkFromNode = async (node: { id: number; title: string }) => {

    if (forking) return;

    setForking(true);

    try {

      const chat = await api.forkChatFromNode(chatType, chatId, node.id);

      showToast(t('chat.forkOk', { name: chat.name }));

      setNodeBanner({ title: node.title, subtitle: t('chat.nodeBannerFork') });

      onForked?.(chat); // 切换到新聊天（原聊天保持不变）

    } catch (e: any) {

      showToast(t('chat.forkFail', { msg: e?.message || String(e) }), { error: true });

    } finally {

      setForking(false);

    }

  };

  // v2.3.94 需求 1：从任意消息开启新对话（右键菜单入口）。
  // 与 forkFromNode 的差别：不需要先建剧情节点，命名用消息摘要，
  // 且后端会自动为新聊天开启长记忆（记忆隔离 + 独立时间线）。
  const forkFromMessage = async (m: ChatMessage) => {

    if (forking) return;

    // 流式占位气泡是负数 id，尚未落库，无法作为分叉点 —— 直接忽略并提示
    if ((m.id as number) < 0) {

      showToast(t('msg.forkFailStreaming'), { error: true });

      return;

    }

    setForking(true);

    try {

      const chat = await api.forkChatFromMessage(chatType, chatId, m.id);

      showToast(t('chat.forkOk', { name: chat.name }));

      onForked?.(chat); // 切换到新聊天（原聊天保持不变）

    } catch (e: any) {

      showToast(t('chat.forkFail', { msg: e?.message || String(e) }), { error: true });

    } finally {

      setForking(false);

    }

  };

  // v2.3.94 需求 3：选取文字复制 —— 弹出只读文本框，用户手动选取后点「复制」。
  // 状态刻意放在父组件（与 translateModal 同一层级），因为它要脱离气泡、
  // portal 到 body，且需要在两个渲染进程窗口（主窗 / 小窗）各自独立存在。
  const [selectCopyText, setSelectCopyText] = useState<string | null>(null);
  const selectCopyRef = useRef<HTMLTextAreaElement | null>(null);
  const [selectCopied, setSelectCopied] = useState(false);

  const openSelectCopy = (m: ChatMessage) => {

    setSelectCopyText(m.content || '');

    setSelectCopied(false);

  };

  const closeSelectCopy = () => {

    setSelectCopyText(null);

    setSelectCopied(false);

  };

  const doCopySelected = async () => {

    const ta = selectCopyRef.current;

    if (!ta) return;

    // 优先取用户手动选中的部分；没选则视为「全选」（更符合直觉，不让用户空点）
    const picked = ta.value.substring(ta.selectionStart ?? 0, ta.selectionEnd ?? 0).trim();

    const text = picked || ta.value;

    if (!text) return;

    try {

      await navigator.clipboard.writeText(text);

      setSelectCopied(true);

      showToast(t('toast.copied'));

    } catch (e: any) {

      showToast(t('toast.copyFailed', { msg: e?.message || String(e) }), { error: true });

    }

  };

  const removeNode = async (id: number) => {

    await api.removeStoryNode(id);

    setStoryNodes(await api.listStoryNodes(chatType, chatId));

  };

  const [clearOpen, setClearOpen] = useState(false);

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

  // 流式偏好的「来源」（model=模型独立设置 / global=跟随全局），用于按钮 tooltip

  const [streamPref, setStreamPref] = useState<StreamPref>({ on: false, source: 'global' });

  const autoMemoryRef = useRef(false);

  const [hideReasoning, setHideReasoning] = useState(true);

  // 随机事件

  const chatKey = `${chatType}:${chatId}`;

  // ===== v2.3.101 消息气泡入场动画 =====
  // 目标：新追加的消息行 → 头像先渐显，气泡再从头像一侧向中间弹出（CSS 见 index.css 的 .msg-row.anim-enter）。
  // 判定「新追加」：仅在**同一聊天**内、末尾消息相对上一次变化时触发；切聊天（chatKey 变化）只重建基线、
  // 绝不播放入场，避免打开聊天时历史消息重放。
  // 用「末尾消息是否属于本聊天（chat_id 归属）」判断，专门避开「切聊天后消息异步加载被误判为新追加」的坑。
  const [enteringId, setEnteringId] = useState<number | null>(null);
  const enterRef = useRef<{ chat: string; id: number | null; valid: boolean }>({
    chat: '',
    id: null,
    valid: false,
  });
  // v2.3.101：真实流式收尾时落库的消息 id —— 其正文已在占位气泡里实时显示过，
  // 完成瞬间不应再重播「气泡从透明弹出」的入场动画（否则会闪一下）。
  const suppressEnterIdRef = useRef<number | null>(null);

  // 用 useLayoutEffect（而非 useEffect）在**绘制前**打上 anim-enter：
  // 否则新行会先整帧可见、随后才从 opacity:0 重播动画，出现「闪一下」。
  useLayoutEffect(() => {
    const last = messages.length ? messages[messages.length - 1] : null;
    const belongs = !!last && last.chat_id === chatId;
    const lastId = last ? (last.id as number) : null;
    const prev = enterRef.current;
    enterRef.current = { chat: chatKey, id: belongs ? lastId : null, valid: belongs };

    // 切聊天：只重建基线，不播放（历史消息不重放）
    if (prev.chat !== chatKey) {
      setEnteringId(null);
      return;
    }
    // 末尾消息不属于本聊天（仍显示上一个聊天的内容），或上一帧基线无效 → 不播放
    if (!belongs || lastId === null || !prev.valid) return;
    if (lastId === prev.id) return;
    // v2.3.101：真实流式收尾的消息（正文已实时显示过）→ 跳过入场动画，避免「闪一下再淡入」。
    if (suppressEnterIdRef.current !== null && lastId === suppressEnterIdRef.current) {
      suppressEnterIdRef.current = null;
      return;
    }

    setEnteringId(lastId);
    // 清空时机与 CSS 动画时长同步缩放（气泡 0.10s 延迟 + 0.42s ≈ 0.6s 基准），
    // 避免「慢速档」下动画尚未播完就摘掉 anim-enter 导致动画被截断。
    const timer = window.setTimeout(() => setEnteringId((cur) => (cur === lastId ? null : cur)), animMs(0.6));
    return () => window.clearTimeout(timer);
  }, [messages, chatKey, chatId]);

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

  const [nhppActive, setNhppActive] = useState(false); // NHPP 引擎接管时，经典主动消息开关置灰不可拨动

  // v2.3.93：主动消息「等你回复」状态。状态真源在主进程（多窗口一致），
  // 本地这份仅用于顶部提示 + 「我不回复」按钮的显示；开关关闭时主进程恒返回 false。
  const [awaitingReply, setAwaitingReply] = useState(false);
  const awaitingReplyRef = useRef(false);
  // v2.3.94 P2-5：阈值累计期（reason:'counting'）的「已发 n/m 条」提示状态
  const [awaitingCount, setAwaitingCount] = useState<{ count: number; threshold: number } | null>(null);
  const [skippingAwaiting, setSkippingAwaiting] = useState(false); // 「我不回复」请求进行中（防连点）

  const idleSwitchActionRef = useRef<'pause' | 'reset' | 'continue'>('continue'); // 切换聊天时的计时模式



// 随机事件快捷主题见 ../eventThemes（主窗/小窗共用）

  const [chatBg, setChatBg] = useState<string | null>(null);

  // v2.3.101：主题色取自聊天背景主体色。dyeSeqRef 保护异步取色竞态；dyeActive 控制滚动区玻璃类
  const { settings: themeSettings } = useTheme();
  const dyeSeqRef = useRef(0);
  const dyeActive = themeSettings?.dyeFromBackground !== false && !!chatBg;

  // 有背景且未关染色 → 提取主体色作为内联主题主色（渐变过渡由 variables.css 的 @property/transition 完成）。
  // 无背景 / 关闭开关 → 清除内联覆盖，回退主题默认色（即口径上的「无背景主体色为白」）。
  // 切主题（settings.theme 变化）也在此重算/清除，避免内联旧色盖住新主题主色。
  useEffect(() => {
    const root = document.documentElement;
    const seq = ++dyeSeqRef.current;
    const clear = () => {
      root.style.removeProperty('--color-primary');
      root.style.removeProperty('--color-primary-text');
      root.style.removeProperty('--color-primary-ink');
    };
    if (themeSettings?.dyeFromBackground === false || !chatBg) {
      clear();
      return;
    }
    extractDominantColor(chatBg).then((hex) => {
      if (seq !== dyeSeqRef.current) return; // 切聊天/切主题后旧结果作废
      if (!hex) {
        clear();
        return;
      }
      const { primary, primaryText } = deriveAccent(hex);
      root.style.setProperty('--color-primary', primary);
      root.style.setProperty('--color-primary-text', primaryText);
      // v2.3.101 无障碍：--color-primary-ink 作为**文字色**，实际压在「面板」（设置页/弹窗/
      // 编辑器）与「聊天磨砂面」上。glass/liquid 的 --color-bg 是渐变、面板是半透明，故不能只取
      // 单一表面色（否则退化为纯白 → 推出深色 ink → 压在半透明面板叠亮渐变上对比度崩塌）。
      // 这里按「面板合成到每个渐变色标」构造主要承载面集合，再以磨砂遮罩面为次要目标一并求解。
      const cs = getComputedStyle(root);
      const primarySurfaces = computePrimarySurfaces(
        cs.getPropertyValue('--color-panel').trim(),
        cs.getPropertyValue('--color-bg').trim(),
        cs.getPropertyValue('--color-hover').trim()
      );
      const secondarySurfaces = computeSecondarySurfaces(
        cs.getPropertyValue('--color-chat-scrim').trim(),
        cs.getPropertyValue('--color-bg').trim()
      );
      root.style.setProperty(
        '--color-primary-ink',
        deriveInkForSurfaces(primary, primarySurfaces, secondarySurfaces)
      );
      // ⚠️ 已知可达上限（**非本功能回归，请勿按「bug」去修**）：
      // glass 主题下 6 个承载面（3 色标 × {panel, hover}）从 #505996 跨到 #b66cb2，
      // 任何**单一** ink 的可达上界仅 3.64:1 —— 已穷举 32³ RGB 网格 + 精确黑白复核，
      // 确认无更优解（纯黑反而只有 2.58，因最亮面偏亮）。
      // 根因：--color-panel = rgba(255,255,255,0.22) 这层**白色叠加**把深蓝紫渐变
      // 抬进中紫区间，而黑白两端都够不到 4.5。若面板透明，白字可达 5.56~12.67。
      // 这是 glass 主题**自身**的既有性质，与染色无关：其 --color-text(#f4f4ff) 压在
      // 同一最亮面上也只有 3.33:1，比本 ink 更差。染色反而把该位从染色前的 ~1.3:1
      // 提升到 3.64:1。要根治需重做 glass 的面板/底色（会改变该主题全部观感），
      // 不在本批次范围内。
    });
  }, [chatBg, themeSettings?.theme, themeSettings?.dyeFromBackground]);

  // 卸载时清除内联覆盖，避免残留染色影响后续主题
  useEffect(
    () => () => {
      const root = document.documentElement;
      root.style.removeProperty('--color-primary');
      root.style.removeProperty('--color-primary-text');
      root.style.removeProperty('--color-primary-ink');
    },
    []
  );

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

  // v2.3.90：两个观察者下拉 + 工具栏「更多操作」下拉的缩入（关闭）动画。
  // 锚点/坐标随 show* 一起被置 null，故以「坐标对象」为 retract 值：缩入期间保留最后一次坐标，
  // 菜单不会闪回 (0,0) 或跳到右上角。
  const privateMenu = useRetract(showPrivateMenu ? privateAnchor : null);

  const configMenu = useRetract(showObserverConfig ? configAnchor : null);

  const moreMenu = useRetract(moreOpen ? morePos : null);

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

  // v2.3.81：订阅异步场景生图三态（sceneImage:status）。仅跟踪「当前打开的会话」，
  // 收到 success / failed 时由 hook 内部弹站内 Toast；窗口不可见时改由主进程后台卡片负责。
  const sceneImage = useSceneImageStatus(chatType, chatId, showToast);

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



  // v2.3.93：进入/切换聊天时查询「主动消息是否正在等你回复」。
  // 主进程为唯一真源；开关 idleCooldownUntilReply 关闭时恒返回 false（那就不存在等待态、不显示提示）。
  useEffect(() => {

    let cancelled = false;

    (async () => {

      let on = false;

      try {

        on = (await api.isAwaitingReply(chatType, chatId)) === true;

      } catch {

        on = false;

      }

      if (cancelled) return;

      awaitingReplyRef.current = on;

      setAwaitingReply(on);
      setAwaitingCount(null);

    })();

    return () => {

      cancelled = true;

    };

  }, [chatType, chatId]);



  // v2.3.93：「我不回复」—— 与用户真的回复完全等价的解除（主进程同一清理入口）。
  // 乐观更新：先本地清掉提示并把倒计时显示刷回满格，失败则回滚并 toast。
  const skipAwaitingReply = useCallback(async () => {

    if (skippingAwaiting || !awaitingReplyRef.current) return;

    const prev = awaitingReplyRef.current;

    setSkippingAwaiting(true);

    awaitingReplyRef.current = false;

    setAwaitingReply(false);

    try {

      const r = await api.skipAwaitingReply(chatType, chatId);

      if (!r?.ok) throw new Error('skip failed');

      // 主进程已把计时基准重置为当下并广播 idle:activity；这里同步本地基准，
      // 让倒计时立刻显示满格（「按已回复过继续计时」），不等广播回环。
      const ts = Date.now();

      lastActivityRef.current = ts;

      setIdleActivity(chatKey, ts);

      setIdleCountdown(Math.ceil(idleSecondsRef.current || 600));

    } catch (e) {

      // 失败回滚：恢复提示与倒计时显示，避免状态与主进程不一致

      awaitingReplyRef.current = prev;

      setAwaitingReply(prev);

      showToast(t('chat.idleAwaitingSkipFailed'), { error: true });

      console.warn('[nianyu] skipAwaitingReply failed:', e);

    } finally {

      setSkippingAwaiting(false);

    }

  }, [chatType, chatId, chatKey, skippingAwaiting, showToast, t]);



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

  // 伪流式输出（v2.3.34）：开启后正文在回复结束后逐字渐显；speed=每字间隔（秒）

  const [pseudoCfg, setPseudoCfg] = useState({ on: false, speed: 0.8 });

  // ref 镜像：流式监听器只在挂载时注册一次，用 ref 读取最新开关值，避免重注册监听器

  const pseudoRef = useRef({ on: false, speed: 0.2 });

  useEffect(() => { pseudoRef.current = pseudoCfg; }, [pseudoCfg]);

  // 流式生效值镜像（ref）：stream:done 事件回调闭包里需要判断「本次回复是否真实流式」——

  // 伪流式仅在非流式（生效值关闭）时打标逐字渐显；流式回复已实时输出，不打标

  const streamOnRef = useRef(true);

  useEffect(() => { streamOnRef.current = enableStreaming; }, [enableStreaming]);

  const [speakingId, setSpeakingId] = useState<number | null>(null);
  // v2.3.78：TTS 合成中的消息 id（并发守卫）。
  // 缺陷：speak() 里 setSpeakingId 是异步 state，而合成请求 await 期间连点多���会各自走到
  // 「重新合成」分支，等音频陆续返回后 new Audio() 连续覆盖 audioRef.current，
  // **前一个 Audio 实例未被 pause 仍在播** → 出现重复音频叠加。
  // 用 ref（同步生效，不受 state 异步影响）记录「正在合成的消息 id」挡住重复请求。
  const ttsSynthRef = useRef<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // TTS 播放状态机（v2.3.44）：speakingId=已加载音频的消息（播放结束后保留，供「重播」复用，不重新合成）；

  // ttsPlaying=正在播放；ttsPaused=已暂停（再点播放键从停止处续播）；ttsEnabled=全局 TTS 总开关（与设置同步）。

  const [ttsPlaying, setTtsPlaying] = useState(false);

  const [ttsPaused, setTtsPaused] = useState(false);

  const [ttsEnabled, setTtsEnabled] = useState(true);

  // 自动播报闭包中读取最新开关（避免把 ttsEnabled 塞进各事件 effect 的依赖数组）

  const ttsEnabledRef = useRef(true);

  // ===== 软件更新提醒（v2.3.45）：主进程发现新版本后在此显示提示条 =====

  const [updateSt, setUpdateSt] = useState<UpdateStatus | null>(null);

  const [dismissedVer, setDismissedVer] = useState('');

  // v2.3.48：永久关闭更新提醒（设置项 disableUpdateReminder）——开启后聊天界面不显示更新提示条

  const [updateReminderOff, setUpdateReminderOff] = useState(false);

  useEffect(() => {

    void api.updateStatus().then(setUpdateSt).catch(() => {});

    const off = api.onUpdateStatus((_e, data) => setUpdateSt(data));

    return off;

  }, []);



  // 聊天模型显示（v2.3.44）：modelInfoMap=角色名→{api API 配置名, model 实际模型名}；

  // modelTagMode=标签显示模式（点击标签切换，写入 settings.modelTagMode 全局生效）

  const [modelInfoMap, setModelInfoMap] = useState<Record<string, { api: string; model: string }>>({});

  const [modelTagMode, setModelTagMode] = useState<'api' | 'model'>('api');

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



  // 角色/聊天生效模型信息（v2.3.44）：供标题栏模型标签使用。

  // 设置变更（本窗选择器、小窗、设置页任一改动）后也要重算，保证显示始终与生效模型一致。

  const refreshModelInfo = async (settingsArg?: any) => {

    const settings = settingsArg || (await api.getSettings());

    const map: Record<string, { api: string; model: string }> = {};

    const roles = await api.getRoles();

    for (const r of roles) {

      const cfg = (settings.models || []).find((m: any) => m.id === r.model_config_id);

      if (cfg) map[r.name] = { api: cfg.name, model: cfg.model };

    }

    // 单聊：聊天级模型覆盖（跟随人物时即人物绑定模型）——会话内改模型后头部标签立即跟随

    if (chatType === 'single') {

      try {

        const eff = await api.getChatModel(chatType, chatId);

        if (eff) map[name] = { api: eff.name, model: eff.model };

      } catch {

        /* 解析失败则保持角色绑定值 */

      }

    }

    setModelInfoMap(map);

    setModelTagMode(settings.modelTagMode === 'model' ? 'model' : 'api');

    setTtsEnabled(settings.voice?.ttsEnabled !== false);

    setDismissedVer(settings.updateDismissedVersion || '');

    setUpdateReminderOff(settings.disableUpdateReminder === true);

  };



  const load = () => {

    api.getMessages(chatType, chatId).then(setMessages);

    api.getGlobalTokens().then(setGlobalTokens);

    api.listWorldBooks().then(setWorldBooks).catch(() => {});

    Promise.all([api.getRoles(), api.getSettings()]).then(async ([roles, settings]) => {

      const avatars: Record<string, string> = {};

      for (const r of roles) {

        if (r.avatar_path) avatars[r.name] = r.avatar_path;

      }

      void refreshModelInfo(settings);

      setAvatarMap(avatars);

      // 初始化群聊各成员心情

      if (chatType === 'group') {

        const moods: Record<string, string> = {};

        for (const r of roles) {

          if (r.mood) moods[r.name] = r.mood;

        }

        setGroupMoods(moods);

      }

      // 流式开关显示「生效值」：模型独立 streamEnabled 优先，否则全局 enableStreaming

      resolveStreamInfo(chatType, chatId)

        .then((info) => {

          setEnableStreaming(info.on);

          setStreamPref(info);

        })

        .catch(() => {});

      autoMemoryRef.current = !!settings.enableAutoMemory;

      setHideReasoning(settings.hideReasoning !== false);

      setPseudoCfg({ on: settings.pseudoStreamEnabled === true, speed: clampPseudoSpeed(settings.pseudoStreamSpeed) });

      setEnableRandomEvents(settings.enableRandomEvents !== false);

      // 主动消息：全局主开关 × 当前聊天单独开关 × 引擎（NHPP 接管时隐藏经典倒计时）

      const globalOn = settings.idleEnabled !== false;

      const engine = settings.proactiveEngine || 'legacy';

      setNhppActive(engine === 'nhpp');

      // v2.3.28：头部开关为当前聊天的独立开关（经典 / NHPP 引擎通用——NHPP 调度同样遵守 chatIdleEnabled）

      const perChat = (settings.chatIdleEnabled || {})[bgKey];

      const eff = globalOn && perChat !== false;

      setIdleReplyOn(eff);

      idleReplyOnRef.current = eff;

      // 随机模式初值取范围中点（后续以主进程广播的实际抽中间隔为准）

      idleSecondsRef.current =

        settings.idleTimingMode === 'random'

          ? Math.round(((settings.idleRandomMinSec ?? 60) + (settings.idleRandomMaxSec ?? 1800)) / 2)

          : settings.idleInterval || 600;

      idleSwitchActionRef.current = settings.idleSwitchAction || 'continue';

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

      // 聊天级模型覆盖由 ChatModelPicker 自身载入（v2.3.41，仅单聊）

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

      showToast(res.message, { error: !res.ok });

    } catch (e: any) {

      showToast(t('chat.summarizeFail', { msg: e?.message || String(e) }), { error: true });

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

    window.addEventListener('keydown', onKeyDown, { capture: true }); // capture 阶段拦截

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });

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

        // 伪流式打标（v2.3.36）：非流式回复也经 stream:done 广播整段到齐（main.ts runOne

        // 「即使关闭全局流式也生效」），此通道是非流式回复到达的唯一可靠路径——伪流式开启且

        // 当前流式生效值关闭时打标；打标与下方 setMessages 同帧，气泡挂载即从首字开始渐显，

        // 不会先闪全文再重播。真实流式（streamOnRef=true）不打标，正文已实时输出。

        if (pseudoRef.current.on && !streamOnRef.current && data.message.sender_type === 'ai' && data.message.content) {

          markPseudoPending(`${data.message.chat_id}:${data.message.id}`);

        }

        // v2.3.101：真实流式（正文已实时输出）收尾落库 → 记录该消息 id，令入场检测跳过动画（避免闪一下）。
        if (streamOnRef.current && data.message.id != null) {
          suppressEnterIdRef.current = data.message.id;
        }

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

        if (ttsEnabledRef.current && voiceCfg.auto && data.message.content) speak(data.message);

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

    // v2.3.93：等待回复状态同步 —— 主进程是唯一真源。
    // 触发时机：① 本窗口/其他窗口发消息解除；② 别的窗口点了「我不回复」；③ 主动消息刚发出；
    // ④ 设置里关掉了「等你回复」开关（clearAll 逐个广播）。四种情况都靠这一条广播收敛，
    // 不需要各窗口互相轮询，跨窗口天然一致。

    const offAwaiting = api.onAwaitingReply((_e, data) => {

      if (!data || data.chatKey !== chatKey) return;

      // v2.3.94 P2-5：阈值累计期广播 reason:'counting'，记录「已发 n/m 条」，此时尚未进入等待态
      if (data.reason === 'counting') {
        const d = data as typeof data & { count?: number; threshold?: number };
        setAwaitingCount({ count: d.count ?? 0, threshold: d.threshold ?? 0 });
        return;
      }

      setAwaitingCount(null);

      const on = data.awaiting === true;

      awaitingReplyRef.current = on;

      setAwaitingReply(on);

    });

    return () => {

      offUser();

      offEvent();

      offChunk();

      offDone();

      offStart();

      offRoundDone();

      offIdle();

      offAwaiting();

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

      // v2.3.44：全局 TTS 开关 / 模型标签显示模式 / 生效模型（模型切换后标题栏标签立即跟随）

      void refreshModelInfo(settings);

      // 流式开关显示「生效值」：模型独立 streamEnabled 优先，否则全局 enableStreaming

      resolveStreamInfo(chatType, chatId)

        .then((info) => {

          setEnableStreaming(info.on);

          setStreamPref(info);

        })

        .catch(() => {});

      autoMemoryRef.current = !!settings.enableAutoMemory;

      setHideReasoning(settings.hideReasoning !== false);

      setPseudoCfg({ on: settings.pseudoStreamEnabled === true, speed: clampPseudoSpeed(settings.pseudoStreamSpeed) });

      setEnableRandomEvents(settings.enableRandomEvents !== false);

      // 主动消息：全局主开关 × 当前聊天单独开关 × 引擎

      const globalOn = settings.idleEnabled !== false;

      const engine = settings.proactiveEngine || 'legacy';

      setNhppActive(engine === 'nhpp');

      // v2.3.28：显示态 = 全局开关 × 当前聊天独立开关（经典 / NHPP 通用）

      const perChat = (settings.chatIdleEnabled || {})[key];

      const eff = globalOn && perChat !== false;

      setIdleReplyOn(eff);

      idleReplyOnRef.current = eff;

      // 随机模式初值取范围中点（后续以主进程广播的实际抽中间隔为准）

      idleSecondsRef.current =

        settings.idleTimingMode === 'random'

          ? Math.round(((settings.idleRandomMinSec ?? 60) + (settings.idleRandomMaxSec ?? 1800)) / 2)

          : settings.idleInterval || 600;

      idleSwitchActionRef.current = settings.idleSwitchAction || 'continue';

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

    const off = api.onStoryChanged(async (_e, data) => {

      if (data.chatType !== chatType || data.chatId !== chatId) return;

      setStoryOn(data.enabled);
      // v2.3.80：广播后重拉节点列表（原来只更新开关，导致回滚删了节点但面板仍显示旧的）
      setStoryNodes(await api.listStoryNodes(chatType, chatId));
      setEditingNodeId(null);

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

    window.addEventListener('scroll', close, { passive: true });

    return () => {

      window.removeEventListener('mousedown', close);

      window.removeEventListener('resize', close);

      window.removeEventListener('scroll', close); // capture 默认 false 与 add 一致；remove 不支持 passive 选项

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

    // v2.3.79：回滚现在也会删剧情节点（与「修改重发」一致），toast 补上节点数量
    showToast(t('msg.editResendDone', { n: res.deletedMsgs, m: res.deletedMems, k: res.deletedMoments ?? 0, d: res.deletedNodes ?? 0 }));

    reload();

    api.syncMessages({ chatType, chatId, action: 'rolledBack' });
    // v2.3.80：回滚/修改重发会删剧情节点；reload() 只重载消息，需同时重拉节点列表并退出重命名编辑态
    setStoryNodes(await api.listStoryNodes(chatType, chatId));
    setEditingNodeId(null);

  };



  // v2.3.102 需求 1：打断后重发 —— 复用同文件「回滚 / 修改重发」的调用链（打断兜底 → rollback(keepAnchor) → 重生成）。
  // 主进程侧先中止该聊天在飞的流 → rollbackMessages(..., keepAnchor=true)（保留锚点用户消息 m，
  // 删其后全部 AI 回复 + 级联记忆/朋友圈/剧情节点）→ 广播刷新 → 以 m 的 content/images 走 handleStream 正常重生成。
  // 按钮的消失无需手动处理：新一轮 AI 正常完成、不带 interrupted 标记 → computeInterruptedAnchorId 自动返回 null。
  const handleResendInterrupted = async (m: ChatMessage) => {
    if (aiActionBusy) return; // 防连点（复用本组件已有的消息操作忙碌态）
    setAiActionBusy(true);
    try {
      // 1) 若仍有流在飞（本组件「打断生成」用的流式占位状态）→ 先打断并等 stream:done 广播清理占位
      if (Object.keys(streamingMsgs).length > 0) {
        await api.interruptStream(chatId);
        await new Promise((r) => setTimeout(r, 400));
        setStreamingMsgs({});
      }
      // 2) 主进程删除 + 重生成
      const res = await api.regenerateReply({ chatType, chatId, fromUserMsgId: m.id });
      if (!res.ok) {
        showToast(t('chat.resendInterruptedFail', { msg: res.error ?? '' }));
        return;
      }
      // 3) 刷新消息 / 剧情节点，并广播回滚（与 handleRollback 同口径）
      reload();
      setStoryNodes(await api.listStoryNodes(chatType, chatId));
      setEditingNodeId(null);
      api.syncMessages({ chatType, chatId, action: 'rolledBack' });
      showToast(t('chat.resendInterruptedDone', {
        n: res.deletedMsgs,
        m: res.deletedMems,
        k: res.deletedMoments,
        d: res.deletedNodes,
      }));
    } catch (e: any) {
      // ⚠️ 失败时数据可能**已经被删**（主进程先 rollback 再 handleStream，而 handleStream 会抛），
      //    所以这里必须同时做两件事：① 如实告知；② 重新拉取，让界面反映「已删」的真实状态。
      showToast(t('chat.resendInterruptedFail', { msg: e?.message || String(e) }), { error: true });
      reload();
      try { setStoryNodes(await api.listStoryNodes(chatType, chatId)); } catch { /* 拉取失败不掩盖原错误 */ }
    } finally {
      setAiActionBusy(false);
    }
  };

  // v2.3.63：删除消息（顶替旧「撤回」位置）——只删这一条消息，

  // **不动**记忆 / 朋友圈动态 / 剧情节点（与旧「撤回」语义相反，故 IPC 换成 messages:deleteOnly）

  const handleDeleteMsg = async (msgId: number) => {

    if (!(await api.showConfirm!(t('msg.deleteMsgConfirm')))) return;

    await api.deleteMessageOnly(msgId);

    showToast(t('msg.deleteMsgDone'));

    reload();

    api.syncMessages({ chatType, chatId, action: 'deleted' });

  };

  // ===== v2.3.63：消息下方的三个 AI 操作 =====

  // continue = AI 接着往下说一段（落库为新消息）

  // rewrite  = 换个说法重写最后一条（**保留原消息**，新版本追加在后面）

  // replyForUser = 以用户身份代写一条回复，**只填进输入框不发送**

  const [aiActionBusy, setAiActionBusy] = useState(false);

  const doAiAction = async (action: 'continue' | 'rewrite' | 'replyForUser') => {

    if (aiActionBusy) return; // 防连点重复生成

    setAiActionBusy(true);

    try {

      const res = await api.aiAction({ chatType, chatId, action });

      if (!res?.ok) {

        showToast(res?.error || t('msg.aiActionFail'), { error: true });

        return;

      }

      if (action === 'replyForUser') {

        // 覆盖输入框内容，光标置于末尾（用户可继续编辑后再手动发送）

        const text = res.content || '';

        setInput(text);

        try {

          const ta = inputRef.current;

          if (ta) {

            ta.focus();

            ta.setSelectionRange(text.length, text.length);

          }

        } catch { /* 某些环境不支持 setSelectionRange，忽略 */ }

        showToast(t('msg.aiReplyFilled'));

      } else {

        // 续写 / 重写：主进程已落库，重载即可看到新消息

        reload();

        showToast(t(action === 'continue' ? 'msg.aiContinueDone' : 'msg.aiRewriteDone'));

      }

    } catch (e: any) {

      showToast(e?.message || t('msg.aiActionFail'), { error: true });

    } finally {

      setAiActionBusy(false);

    }

  };



  // 末条消息是否为 AI 消息 —— 决定是否在其下方显示三图标

  // v2.3.94 P2-4a：最后一条 AI 消息 id（而非「最后一条消息」）。
  // 这样用户刚发完消息、AI 还没回时，仍能在最后那条 AI 消息上显示操作栏。
  // 没有任何 AI 消息时退回最后一条消息 id（兜底，保持旧行为）。
  const lastAiMsg = [...messages].reverse().find((m) => m.sender_type === 'ai');
  const lastMsgId = lastAiMsg ? lastAiMsg.id : (messages.length > 0 ? messages[messages.length - 1].id : -1);

  // v2.3.63：消息折叠——折叠后每条只显示一行摘要，点任一条展开

  const [collapsed, setCollapsed] = useState(false);

  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpand = (id: number) =>

    setExpandedIds((prev) => {

      const next = new Set(prev);

      if (next.has(id)) next.delete(id);

      else next.add(id);

      return next;

    });

  // 折叠态单行摘要：去掉换行与多余空白，取前 60 字

  const collapseSummary = (m: ChatMessage) => {

    const raw = (m.sender_type === 'user' ? '我: ' : '') + (m.content || '');

    const flat = raw.replace(/\s+/g, ' ').trim();

    return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;

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

      // 转发同样走「生效流式偏好」：模型独立设置优先，否则全局

      const wantStream = await resolveWantStream(targetChatType, targetChatId);

      if (wantStream) {

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



  // 文件拖拽添加（v2.3.51）：图片文件拖入输入区 → 加入待发图片；其他类型 toast 提示后忽略。

  // 拖悬于输入区时给 body 挂 ny-drop-chat 类 → 全窗「快速导入」遮罩让位（CSS 隐藏）。

  const [dragOver, setDragOver] = useState(false);

  const dragDepth = useRef(0);

  const setBodyDropChat = (on: boolean) => {

    try {

      document.body.classList.toggle('ny-drop-chat', on);

    } catch { /* ignore */ }

  };

  const acceptDroppedFiles = async (files: FileList | null) => {

    if (!files || !files.length) return;

    const paths: string[] = [];

    let ignored = 0;

    for (const f of Array.from(files)) {

      const p = await api.getPathForFile(f);

      if (p && IMAGE_FILE_EXT_RE.test(p)) paths.push(p);

      else ignored += 1;

    }

    if (paths.length) setPendingImages((prev) => [...prev, ...paths]);

    if (ignored > 0) showToast(t('chat.dropUnsupported', { n: ignored }), { error: true });

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

        // 伪流式输出：非流式回复本就是「整段到齐」，逐条打标以便气泡逐字渐显

        if (pseudoRef.current.on) {

          for (const m of res.aiMessages) {

            if (m.sender_type === 'ai' && m.content) markPseudoPending(`${m.chat_id}:${m.id}`);

          }

        }

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

        if (ttsEnabledRef.current && voiceCfg.auto && lastAI?.content) speak(lastAI);

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

    // ===== 修改重发（v2.3.38）：编辑模式下发送 = 打断进行中回复 → 回滚删除原消息及其后 → 以新内容正常发送 =====

    if (editMsg) {

      const em = editMsg;

      setEditMsg(null); // 编辑栏立即消失：发送后不再残留

      try {

        // 1) 模型仍在回复（有流式占位）→ 先自动打断本次回复，等 stream:done 广播清理占位

        if (Object.keys(streamingMsgs).length > 0) {

          await api.interruptStream(chatId);

          await new Promise((r) => setTimeout(r, 400));

          setStreamingMsgs({});

        }

                // v2.3.63：改用 rollbackForEdit —— 与普通「回滚」走同一个数据口径。
        // v2.3.90 更正注释：此前写的「普通回滚不动节点」自 v2.3.79 起已不成立——
        // 两条路径（rollback / rollbackForEdit）都调用 `rollbackMessages(..., true)`，**都会**删除剧情节点。
        // 记忆 / 朋友圈动态同样由回滚统一联动删除。


        const rb = await api.rollbackForEdit({ chatType, chatId, fromMsgId: em.id });


        reload();


        api.syncMessages({ chatType, chatId, action: 'rolledBack' });
    // v2.3.80：回滚/修改重发会删剧情节点；reload() 只重载消息，需同时重拉节点列表并退出重命名编辑态
    setStoryNodes(await api.listStoryNodes(chatType, chatId));
    setEditingNodeId(null);


        showToast(


          t('msg.editResendDone', {


            n: rb.deletedMsgs,


            m: rb.deletedMems,


            k: rb.deletedMoments ?? 0,


            d: rb.deletedNodes ?? 0,


          })


        );

      } catch (e: any) {

        showToast(t('chat.editResendFail', { msg: e?.message || String(e) }), { error: true });

      }

    }

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







  // ---------- 文本转语音（TTS）----------

  // v2.3.44 播放状态机：同一条消息 → 播放中点击=暂停；暂停/播完后点击=从停止处续播（播放完则从头，均复用已加载音频，不重新合成）。

  // forceRegenerate=true（右键「重新生成语音」）时忽略已加载音频，强制重新合成。

  const speak = async (msg: ChatMessage, forceRegenerate = false) => {

    // 1) 同一消息：暂停 / 续播（不重新合成）

    const cur = audioRef.current;

    if (!forceRegenerate && speakingId === msg.id && cur) {

      if (!cur.paused && !cur.ended) {

        cur.pause();

        setTtsPlaying(false);

        setTtsPaused(true);

        return;

      }

      try {

        if (cur.ended) cur.currentTime = 0;

        await cur.play();

        setTtsPlaying(true);

        setTtsPaused(false);

      } catch {

        /* 自动播放被拦截等，忽略 */

      }

      return;

    }

    // 2) 其他消息 / 强制重新生成：停掉旧音频，重新合成（命中缓存则直接复用，除非强制）

    // v2.3.78 并发守卫：同一条消息的合成请求进行中时，重复点击直接忽略。
    // 必须在 await 之前同步判断（用 ref 而非 state，state 更新是异步的挡不住连点）。
    if (ttsSynthRef.current === msg.id && !forceRegenerate) return;

    try {

      cur?.pause();

      audioRef.current = null;

      setTtsPlaying(false);

      setTtsPaused(false);

      setSpeakingId(msg.id);
      // v2.3.78：标记「正在合成」，await 期间挡住重复点击
      ttsSynthRef.current = msg.id;
      showToast(t('chat.toastSpeaking'));

      // 解析说话角色 id：单聊=当前聊天角色；群聊=按发送者名匹配成员（TTS 按角色音色合成）

      const ttsRoleId =

        chatType === 'single'

          ? members[0]?.id || chatId

          : members.find((r) => r.name === msg.sender_name)?.id;

      // 朗读范围过滤（全局设置）：只朗读勾选的类别（对话/旁白/人物心理），默认仅对话；

      // 过滤后为空则不发起合成（避免烧 token 读出空气）

      const scopes = (await api.getSettings())?.voice?.ttsScopes;

      const text = filterSpeechText(msg.content || '', scopes);

      if (!text.trim()) {

        // v2.3.78：提前返回也要清守卫
        ttsSynthRef.current = null;

        setSpeakingId(null);

        showToast(t('chat.ttsNothingInScope'));

        return;

      }

      const src = await api.textToSpeech(text, ttsRoleId, forceRegenerate);
      // v2.3.78：合成期间可能又点了别的消息（守卫只挡同一条）——返回时若已不是目标消息则丢弃本次结果，
      // 避免「点 A 合成中 → 改点 B → A 的音频后到又播出来」造成重复/错位播放。
      if (ttsSynthRef.current !== msg.id) return;
      ttsSynthRef.current = null;
      const audio = new Audio(src);
      // 双保险：显式停掉上一个实例并清空 src，杜绝任何路径下的重叠播放。
      // 用 as 断言绕过 TS 在本函数上方 `audioRef.current = null` 造成的 ref 类型收窄（收窄为 never）。
      const prev = audioRef.current as HTMLAudioElement | null;
      if (prev && prev !== audio) {
        prev.onended = null;
        prev.onplay = null;
        prev.onpause = null;
        try { prev.pause(); prev.currentTime = 0; } catch { /* 忽略 */ }
        try { prev.removeAttribute('src'); prev.load(); } catch { /* 忽略 */ }
      }
      audioRef.current = audio;

      // 播放结束：保留 speakingId（供「重播」复用同一份音频，不重新合成）

      audio.onended = () => {

        setTtsPlaying(false);

        setTtsPaused(false);

      };

      audio.onpause = () => setTtsPlaying(false);

      audio.onplay = () => {

        setTtsPlaying(true);

        setTtsPaused(false);

      };

      await audio.play();

    } catch (e: any) {
      // v2.3.78：失败路径必须清守卫，否则按钮会永久失效（守卫认为还在合成中）
      if (ttsSynthRef.current === msg.id) ttsSynthRef.current = null;
      setSpeakingId(null);
      setTtsPlaying(false);
      setTtsPaused(false);
      showToast(t('chat.ttsFailed', { msg: e?.message || String(e) }), { error: true });
    }

  };



  // 重播：复用已加载音频从头播放（不重新生成语音）；无已加载音频则按普通播放（会命中缓存）

  const replayTts = async (msg: ChatMessage) => {

    const cur = audioRef.current;

    if (speakingId === msg.id && cur) {

      try {

        cur.currentTime = 0;

        await cur.play();

        setTtsPlaying(true);

        setTtsPaused(false);

      } catch {

        /* 忽略 */

      }

      return;

    }

    await speak(msg);

  };



  // 全局 TTS 总开关（聊天界面标题栏一键开关；写入 settings.voice.ttsEnabled 全局生效）

  const toggleGlobalTts = async () => {

    const next = !ttsEnabled;

    setTtsEnabled(next);

    const s = await api.getSettings();

    await api.saveSettings({ voice: { ...(s.voice || {}), ttsEnabled: next } as any });

    showToast(next ? t('chat.ttsGlobalOn') : t('chat.ttsGlobalOff'));

  };



  // 模型标签显示模式切换（点击标签）：API 配置名 ⇄ 实际模型名（全局偏好，主窗/小窗共用）

  const toggleModelTagMode = async () => {

    const next: 'api' | 'model' = modelTagMode === 'api' ? 'model' : 'api';

    setModelTagMode(next);

    await api.saveSettings({ modelTagMode: next });

  };



  // 关闭全局 TTS 时立即停止当前播放并卸载音频

  useEffect(() => {

    ttsEnabledRef.current = ttsEnabled;

    if (ttsEnabled) return;

    audioRef.current?.pause();

    audioRef.current = null;

    setSpeakingId(null);

    setTtsPlaying(false);

    setTtsPaused(false);

  }, [ttsEnabled]);



  // 卸载时停止播放，避免音频残留

  useEffect(() => () => { audioRef.current?.pause(); ttsSynthRef.current = null; }, []);



  // 切换聊天时停止上一条消息的播报并清空播报状态（v2.3.44，避免音频跨聊天继续播放）

  useEffect(() => {

    audioRef.current?.pause();

    audioRef.current = null;

    setSpeakingId(null);

    setTtsPlaying(false);

    setTtsPaused(false);

  }, [chatType, chatId]);



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



  // 打开翻译弹窗：只带原文，翻译与朗读由 TranslateModal 自行管理（见 state 注释）。
  // senderName 记下发言人，供群聊按「发言人」解析其绑定音色（需求 10）。
  const handleTranslate = (text: string, senderName?: string) => {
    setTranslateModal({ source: text, senderName });
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

  // v2.3.102 需求 1：唯一入口判定 —— 需要挂「打断后重发」按钮的那条用户消息 id（无则 null）。
  // 向下传给 MessageRow：showResendInterrupted = isUser && msg.id === interruptedAnchorId。
  const interruptedAnchorId = useMemo(
    () => computeInterruptedAnchorId(allMessagesUnique),
    [allMessagesUnique],
  );



  return (

    <div className="main-pane">

      {/* 软件更新提示条（v2.3.45）：发现新版本 / 下载中 / 已下载；可忽略该版本（不再提醒）。

          v2.3.48：设置中「关闭更新提醒」开启后整个提示条不再显示（设置页手动检查不受影响） */}

      {updateSt &&

        !updateReminderOff &&

        (updateSt.state === 'available' || updateSt.state === 'downloading' || updateSt.state === 'verifying' || updateSt.state === 'downloaded') &&

        updateSt.latestVersion !== dismissedVer && (

          <div className="update-banner">

            <span className="update-banner-text">

              {updateSt.state === 'available' && `⬆ ${t('chat.updateBanner', { v: updateSt.latestVersion || '' })}`}

              {(updateSt.state === 'downloading' || updateSt.state === 'verifying') &&

                t('settings.updateDownloading', {

                  p: String(updateSt.percent ?? 0),

                  mb: ((updateSt.received || 0) / 1048576).toFixed(1),

                })}

              {updateSt.state === 'downloaded' && `✅ ${t('settings.updateDownloaded')}`}

            </span>

            {updateSt.state === 'available' && (

              <>

                <button className="update-banner-btn" onClick={() => { void api.downloadUpdate(); }}>

                  {t('settings.updateDownload')}

                </button>

                <button className="update-banner-btn" onClick={() => { void api.openReleasePage(); }}>

                  {t('settings.updateOpenRelease')}

                </button>

              </>

            )}

            {updateSt.state === 'downloaded' && (

              <>

                <button className="update-banner-btn" onClick={() => { void api.openUpdateFolder(); }}>

                  {t('settings.updateOpenFolder')}

                </button>

                <button className="update-banner-btn primary" onClick={() => { void api.installUpdate(); }}>

                  {t('settings.updateInstall')}

                </button>

              </>

            )}

            <button

              className="update-banner-close"

              title={t('settings.updateIgnore')}

              onClick={() => {

                const v = updateSt.latestVersion || '';

                setDismissedVer(v);

                void api.dismissUpdate(v);

              }}

            >

              ×

            </button>

          </div>

        )}

      <div className="chat-header">

        <div>

          <div className="title">

            <span className="title-name">{name}</span>

            {chatType === 'single' && modelInfoMap[name] && (

              <span

                className="model-tag model-tag-click"

                title={t('chat.modelTagToggleTip')}

                onClick={toggleModelTagMode}

                style={{ cursor: 'pointer' }}

              >

                {t('chat.modelTag', {

                  name: modelInfoMap[name][modelTagMode === 'model' ? 'model' : 'api'] || '—',

                })}

              </span>

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

          {/* v2.3.44：全局 TTS 语音一键开关（聊天界面标题栏；写入 settings.voice.ttsEnabled 全局生效，主窗/小窗同步） */}

          <button

            className={`idle-toggle${ttsEnabled ? ' on' : ''}`}

            title={ttsEnabled ? t('chat.ttsGlobalOnTip') : t('chat.ttsGlobalOffTip')}

            onClick={toggleGlobalTts}

          >

            {ttsEnabled ? '🔊' : '🔇'}

          </button>

          <button

            className={`idle-toggle${idleReplyOn ? ' on' : ''}`}

            title={t('chat.idleReplyTip')}

            onClick={async () => {

              // v2.3.28：当前聊天的独立开关（经典 / NHPP 引擎通用——NHPP 调度同样遵守 chatIdleEnabled）

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

          {/* v2.3.26：右侧小字显示当前开启的主动消息机制；经典机制下附带倒计时 */}

          {idleReplyOn && (

            <span

              className="idle-countdown"

              title={nhppActive ? t('chat.idleReplyNhpp') : t('chat.idleCountdownTip')}

            >

              {nhppActive

                ? t('chat.idleReplyNhppShort')

                : idleCountdown > 0

                  ? `${t('chat.idleReplyLegacyShort')} · ${idleCountdown >= 60 ? `${Math.floor(idleCountdown / 60)}m${idleCountdown % 60}s` : `${idleCountdown}s`}`

                  : t('chat.idleReplyLegacyShort')}

            </span>

          )}

          {/* v2.3.93：等待回复提示 + 「我不回复」按钮。
              位置紧邻倒计时小字（同一区域、同一视觉语言）；仅在主进程确认处于等待态时出现。
              点「我不回复」= 按「已经回复过了」处理：解除等待，下一条主动消息重新计满一个间隔。 */}

          {awaitingReply && (

            <span

              className="idle-awaiting"

              title={t('chat.idleAwaitingTip')}

            >

              <span className="idle-awaiting-text">{t('chat.idleAwaiting')}</span>

              <button

                className="btn-ghost idle-awaiting-skip"

                title={t('chat.idleAwaitingSkipTip')}

                disabled={skippingAwaiting}

                onClick={skipAwaitingReply}

              >

                {skippingAwaiting ? t('chat.idleAwaitingSkipping') : t('chat.idleAwaitingSkip')}

              </button>

            </span>

          )}

          {/* v2.3.94 P2-5：阈值累计期轻提示（尚未进入等待态，仅告知进度） */}
          {awaitingCount && !awaitingReply && (
            <span className="idle-awaiting" title={t('chat.idleAwaitingTip')}>
              <span className="idle-awaiting-text">已发 {awaitingCount.count}/{awaitingCount.threshold} 条，之后开始等待你回复</span>
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

          {privateMenu.shown && createPortal(

            <div

              className={`obs-menu${privateMenu.leaving ? ' leaving' : ''}`}

              style={{ position: 'fixed', top: privateMenu.shown.bottom + 4, right: window.innerWidth - privateMenu.shown.right, zIndex: 1000 }}

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

          {configMenu.shown && createPortal(

            <div

              className={`obs-menu obs-config${configMenu.leaving ? ' leaving' : ''}`}

              style={{ position: 'fixed', top: configMenu.shown.bottom + 4, right: window.innerWidth - configMenu.shown.right, zIndex: 1000 }}

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

            {moreMenu.shown && createPortal(

              <div

                className={`more-dropdown${moreMenu.leaving ? ' leaving' : ''}`}

                style={{

                  position: 'fixed', right: moreMenu.shown.right, top: moreMenu.shown.top,

                  zIndex: 2147483645,

                  color: 'var(--color-text)',

                  padding: 6, minWidth: 200,

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

                {/* 聊天级模型切换（v2.3.41，仅单聊）：勾选=跟随人物（或默认）模型，不可更改；取消勾选=本聊天自选 */}

                {chatType === 'single' && (

                  <>

                    <div style={{ borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />

                    <ChatModelPicker chatType={chatType} chatId={chatId} />

                  </>

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

          onJump={(msgId) => {

            const el = document.querySelector(`[data-mid="${msgId}"]`);

            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });

          }}

        />

      )}



      <CustomScrollArea className={dyeActive ? 'messages has-chat-bg' : 'messages'} scrollRef={scrollRef} style={chatBg ? { backgroundImage: `url(${chatBg})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>

        {/* v2.3.81：异步场景生图「正在生图中…」状态条（仅当前会话进行中时出现，完成/失败即消失）*/}
        <SceneImageStatusBar
          active={sceneImage.generating}
          startedAt={sceneImage.startedAt}
          roleName={sceneImage.roleName}
        />

        {allMessages.length === 0 && (

          <div className="empty-state">

            <div style={{ fontSize: 32 }}>💭</div>

            <div>{t('chat.empty', { name })}</div>

          </div>

        )}

        {/* v2.3.63：折叠开关条（入口也在右键菜单里）*/}

  {allMessages.length > 6 && (

    <div className="msg-collapse-bar">

      <button

        type="button"

        className="btn-ghost"

        style={{ padding: '2px 10px', fontSize: 12 }}

        onClick={() => { setCollapsed((v) => !v); setExpandedIds(new Set()); }}

      >

        {collapsed ? t('msg.expandAll') : t('msg.collapseAll')}

      </button>

      <span className="msg-collapse-count">{t('msg.collapseCount', { n: allMessages.length })}</span>

    </div>

  )}

  {/* 折叠态：每条只渲染一行摘要；点任一条单独展开 */}

  {collapsed && (

    <div className="msg-collapsed-list">

      {allMessagesUnique.filter((m) => !expandedIds.has(m.id)).map((m) => (

        <div

          key={m.id}

          className={`msg-collapsed-item ${m.sender_type}`}

          onClick={() => toggleExpand(m.id)}

          title={collapseSummary(m)}

        >

          {collapseSummary(m)}

        </div>

      ))}

      {expandedIds.size > 0 && (

        <button type="button" className="btn-ghost msg-collapse-reset" onClick={() => setExpandedIds(new Set())}>

          {t('msg.collapseAll')}

        </button>

      )}

    </div>

  )}

  {/* 正常态：被单独展开的那几条仍完整渲染 */}

  {!collapsed && expandedIds.size > 0 && (

    <div className="msg-collapsed-list">

      {allMessagesUnique

        .filter((m) => expandedIds.has(m.id))

        .map((m) => (

          <div key={m.id} className={`msg-collapsed-item ${m.sender_type}`} onClick={() => toggleExpand(m.id)} title={collapseSummary(m)}>

            {collapseSummary(m)}

          </div>

        ))}

    </div>

  )}

  {allMessagesUnique.filter((m) => (collapsed ? expandedIds.has(m.id) : !expandedIds.has(m.id))).map((m, i) => {

          const sid = (m as any).streamId || streamMsgIdRef.current[String(m.id)];

          // 搜索结果优先取随消息持久化的 search_results（每条回复自己的资料，重启后历史消息仍可点击引用），

          // 否则回退到本次会话内存中按 streamId 分桶的结果

          const msgSr = (m as any).search_results as SearchResultItem[] | undefined;

          const sr = msgSr && msgSr.length ? msgSr : sid ? searchResultsByStream[sid] : undefined;

          const expKey = sid || `msg-${m.id}`;

          return (

            <Fragment key={m.id}>

              <MessageRow

                key={m.id}

                msg={m}

                animEnter={m.id === enteringId}

                onImage={setPreview}

                prevTimestamp={i > 0 ? allMessagesUnique[i - 1].timestamp : undefined}

                avatarPath={m.sender_type === 'ai' ? avatarMap[m.sender_name] : undefined}

                userAvatarPath={userAvatarPath}

                // 全局 TTS 关闭时不显示播报按钮（v2.3.44）

                showTts={ttsEnabled && voiceCfg.tts && m.sender_type === 'ai' && !!m.content}

                ttsState={

                  speakingId !== m.id

                    ? 'idle'

                    : ttsPlaying

                      ? 'playing'

                      : ttsPaused

                        ? 'paused'

                        : 'ready'

                }

                typing={m.sender_type === 'ai' && (m.id as number) < 0 && !m.content && !m.reasoning?.trim()}

                streaming={(m.id as number) < 0}

                hideReasoning={hideReasoning}

                // 伪流式仅在流式输出（生效值：模型覆盖优先）关闭时生效；流式开启 → 正文实时显示

                pseudoOn={pseudoCfg.on && !enableStreaming}

                pseudoSpeed={pseudoCfg.speed}

                pseudoKey={`${m.chat_id}:${m.id}`}

                onSpeak={() => speak(m)}

                onReplayTts={() => replayTts(m)}

                onRegenerateTts={ttsEnabled && voiceCfg.tts ? () => speak(m, true) : undefined}

                onReasoningCopied={() => showToast(t('toast.reasoningCopied'))}

                onQuickMemory={(text) => handleQuickMemory(m, text)}

                onSaveImageMemory={handleSaveImageMemory}

                onViewPrompt={(p) => setPromptView(p)}

                onForward={(msg) => openForwardPicker(msg)}

                onEdit={(msg) => { setEditMsg(msg); setInput(msg.content); }}

                onRollback={(msgId) => handleRollback(msgId)}

                onDeleteMsg={(msgId) => handleDeleteMsg(msgId)}

                showAiActions={m.id === lastMsgId}

                aiActionBusy={aiActionBusy}

                onAiAction={doAiAction}

                allCollapsed={collapsed}

                onToggleCollapse={() => { setCollapsed((v) => !v); setExpandedIds(new Set()); }}

                onCopy={(text) => { navigator.clipboard.writeText(text); showToast(t('toast.copied')); }}

                onTranslate={handleTranslate}

                onMarkNode={storyOn ? markNode : undefined}

                roleMood={chatType === 'group' && m.sender_type === 'ai' ? groupMoods[m.sender_name] : undefined}

                searchResults={sr}

                onOpenSearch={sr && sr.length > 0 ? () => setExpandedStreams((v) => ({ ...v, [expKey]: true })) : undefined}

                onForkFromHere={forkFromMessage}

                onSelectCopy={openSelectCopy}

                // v2.3.102 需求 1：仅当本条用户消息是「打断后重发」锚点时渲染重发按钮
                interruptedAnchorId={interruptedAnchorId}

                onResendInterrupted={handleResendInterrupted}

              />

              {sr && sr.length > 0 && (

                <div className="search-result-bubble" key={`sr-${m.id}`}>

                  <button

                    type="button"

                    className="srb-head"

                    onClick={() => setExpandedStreams((v) => ({ ...v, [expKey]: !v[expKey] }))}

                    title={t('chat.webSearchResultToggle')}

                  >

                    <span className="srb-icon">🌐</span>

                    <span className="srb-title">{t('chat.webSearchResultTitle', { n: sr.length })}</span>

                    <span className="srb-chevron">{expandedStreams[expKey] ? '▾' : '▸'}</span>

                  </button>

                  {expandedStreams[expKey] && (

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

                color: 'var(--color-danger, #e06c75)',

                background: 'var(--color-panel)',

                border: '1px solid var(--color-danger, #e06c75)',

                borderRadius: 'var(--radius-sm)',

                padding: '6px 10px',

              }}

            >

              <span title={failed.error}>⚠ {t('chat.sendFailedShort')}</span>

              <button

                className="btn-ghost"

                style={{ padding: '2px 10px', fontSize: 12, color: 'var(--color-primary-ink)' }}

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



      <div

        className={`composer${dragOver ? ' composer-dragover' : ''}`}

        style={{ position: 'relative' }}

        onClick={() => inputRef.current?.focus()}

        onDragEnter={(e) => {

          if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;

          e.preventDefault();

          dragDepth.current += 1;

          setDragOver(true);

          setBodyDropChat(true);

        }}

        onDragOver={(e) => {

          if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;

          e.preventDefault();

          e.dataTransfer.dropEffect = 'copy';

          setDragOver(true);

          setBodyDropChat(true);

        }}

        onDragLeave={(e) => {

          e.preventDefault();

          dragDepth.current -= 1;

          if (dragDepth.current <= 0) {

            dragDepth.current = 0;

            setDragOver(false);

            setBodyDropChat(false);

          }

        }}

        onDrop={(e) => {

          e.preventDefault();

          dragDepth.current = 0;

          setDragOver(false);

          setBodyDropChat(false);

          void acceptDroppedFiles(e.dataTransfer?.files || null);

        }}

      >

        {dragOver && <div className="drop-hint">📎 {t('chat.dropToAdd')}</div>}

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

            title={

              streamPref.source === 'model'

                ? t('chat.streamTipModel', { state: enableStreaming ? t('common.on') : t('common.off') })

                : t('chat.streamTipGlobal', { state: enableStreaming ? t('common.on') : t('common.off') })

            }

            onClick={() => {

              const next = !enableStreaming;

              setEnableStreaming(next);

              // 写到「生效来源」：模型已独立设置→写该模型；否则写全局

              persistStreamToggle(chatType, chatId, next).catch(() => {});

              // 本地立即重算来源提示（模型首次独立化后 source 变 model）

              resolveStreamInfo(chatType, chatId)

                .then((info) => {

                  setEnableStreaming(info.on);

                  setStreamPref(info);

                })

                .catch(() => {});

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

      {/* v2.3.94 需求 3：选取文字复制弹窗。
          用 textarea（而非普通输入框）而不是 div：气泡正文含换行，
          单行 input 无法正确呈现，用户也无法按行选取。
          颜色一律走 CSS 变量，保证 14 套主题下都清晰可读（WCAG AA）。 */}
      {selectCopyText !== null && (
        <div className="modal-mask" onClick={closeSelectCopy}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '90%' }}>
            <div className="modal-title">{t('msg.selectCopyTitle')}</div>

            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
              {t('msg.selectCopyHint')}
            </div>

            <textarea
              ref={selectCopyRef}
              defaultValue={selectCopyText}
              readOnly
              autoFocus
              spellCheck={false}
              onSelect={(e) => {
                // 记录用户当前选区，供「复制选中」使用；不选则复制全文
                const ta = e.currentTarget;
                void ta;
                setSelectCopied(false);
              }}
              style={{
                width: '100%',
                minHeight: 160,
                maxHeight: 320,
                padding: 8,
                fontSize: 13,
                lineHeight: 1.5,
                fontFamily: 'inherit',
                color: 'var(--color-text)',
                background: 'var(--color-panel-alt)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn-secondary" onClick={closeSelectCopy}>{t('common.cancel')}</button>
              <button className="btn-primary" onClick={() => { void doCopySelected(); }}>
                {selectCopied ? t('msg.copied') : t('msg.copySelected')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 翻译弹窗 + 原文/译文朗读（v2.3.94 需求 10）：能力全在共享组件内，与小窗同一份实现。
          roleId 决定朗读音色：单聊取该角色；群聊按发言人名匹配成员（取不到时用第一位成员）。 */}
      {translateModal && (
        <TranslateModal
          source={translateModal.source}
          roleId={
            chatType === 'single'
              ? members[0]?.id || chatId
              : members.find((r) => r.name === translateModal.senderName)?.id || members[0]?.id
          }
          onClose={() => setTranslateModal(null)}
        />
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

      {bondOpen && chatType === 'single' && (

        <BondPanel roleId={chatId} roleName={name} onClose={() => setBondOpen(false)} />

      )}

      <ToastView toast={toast} />

      {/* 自适应故事线：悬停自动弹出、移开收回的侧边栏（不占聊天区）。

          v2.3.38：面板常驻 DOM + 过渡动画（弹入/弹出，线性动画开关关闭时自动禁用）；

          节点改名编辑中鼠标移出不收起，编辑结束后按悬停状态恢复自动收放。 */}

      {storyOn && (

        <div

          ref={storiesRef}

          className="stories"

          onMouseEnter={() => setShowStories(true)}

          onMouseLeave={() => { if (editingNodeId === null) setShowStories(false); }}

        >

          <div className="stories-tab" title={t('chat.stories')}>{t('chat.stories')}</div>

          <div className={`stories-panel${showStories ? ' open' : ''}`}>

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

                      onClick={() => { if (editingNodeId !== n.id) gotoNode(n); }}

                      title={n.title}

                    >

                      {editingNodeId === n.id ? (

                        <>

                          <input

                            className="story-rename-input"

                            autoFocus

                            value={editingTitle}

                            onChange={(e) => setEditingTitle(e.target.value)}

                            onKeyDown={(e) => {

                              if (e.key === 'Enter') {

                                renameNode(n.id, editingTitle);

                                setEditingNodeId(null);

                              } else if (e.key === 'Escape') setEditingNodeId(null);

                            }}

                            onClick={(e) => e.stopPropagation()}

                          />

                          <button

                            className="story-del"

                            onClick={(e) => {

                              e.stopPropagation();

                              renameNode(n.id, editingTitle);

                              setEditingNodeId(null);

                            }}

                            title={t('common.save')}

                          >✓</button>

                          <button

                            className="story-del"

                            onClick={(e) => { e.stopPropagation(); setEditingNodeId(null); }}

                            title={t('common.cancel')}

                          >✕</button>

                        </>

                      ) : (

                        <>

                          <span className="story-title">{n.title}</span>

                          <button

                            className="story-del"

                            onClick={(e) => {

                              e.stopPropagation();

                              setEditingNodeId(n.id);

                              setEditingTitle(n.title);

                            }}

                            title={t('chat.renameNode')}

                          >✏</button>

                          <button

                            className="story-del"

                            disabled={forking}

                            onClick={(e) => { e.stopPropagation(); forkFromNode(n); }}

                            title={t('chat.forkFromNode')}

                          >🌱</button>

                          <button

                            className="story-del"

                            onClick={(e) => { e.stopPropagation(); removeNode(n.id); }}

                            title={t('chat.deleteNode')}

                          >✕</button>

                        </>

                      )}

                    </div>

                  ))

                )}

              </div>

            </div>

        </div>

      )}

      {/* 剧情节点横幅（1s 弹入 → 3.5s 停留 → 渐隐 + 音效，v2.3.37） */}

      <NodeBanner banner={nodeBanner} onDone={() => setNodeBanner(null)} />

    </div>

  );

};



const MessageRow: React.FC<{

  msg: ChatMessage;

  onImage: (src: string) => void;

  prevTimestamp?: string;

  avatarPath?: string;

  userAvatarPath?: string;

  showTts?: boolean;

  // v2.3.44 TTS 状态（父组件推导）：idle=未加载 / playing=播放中（点击=暂停）/ paused=已暂停（点击=续播）/

  // ready=已加载但未播放（点击=从头重播，不重新合成）

  ttsState?: 'idle' | 'playing' | 'paused' | 'ready';

  typing?: boolean;

  streaming?: boolean;

  hideReasoning?: boolean;

  onSpeak?: () => void;

  onReplayTts?: () => void;

  onRegenerateTts?: () => void;

  onReasoningCopied?: () => void;

  onQuickMemory?: (text: string) => void;

  onSaveImageMemory?: (msg: ChatMessage) => void;

  onViewPrompt?: (prompt: string) => void;

  onForward?: (msg: ChatMessage) => void;

  onEdit?: (msg: ChatMessage) => void;

  onRollback?: (msgId: number) => void;

  onDeleteMsg?: (msgId: number) => void;

  // v2.3.63：消息下方的三个 AI 操作（续写 / 重写⟲ / AI 代写回复）——仅「最后一条 AI 消息」下方显示

  onAiAction?: (action: 'continue' | 'rewrite' | 'replyForUser') => Promise<void>;

  showAiActions?: boolean;

  // v2.3.63：折叠/展开全部消息（入口在右键菜单）

  onToggleCollapse?: () => void;

  allCollapsed?: boolean;

  aiActionBusy?: boolean;

  onCopy?: (text: string) => void;

  // v2.3.94 需求 10：第二个参数是发言人名（群聊按它解析该发言人的绑定音色；单聊忽略）
  onTranslate?: (text: string, senderName?: string) => void;

  onMarkNode?: (msg: ChatMessage) => void;

  // v2.3.94 需求 1：右键任意消息 → 从此处开启新对话
  // 复用后端 forkChatFromNode（经 forkChatFromMessage），复制该消息及之前的消息与记忆，
  // 新聊天为独立 chatId（配合角色级记忆隔离 = 独立时间线），并自动开启长记忆。
  onForkFromHere?: (msg: ChatMessage) => void;

  // v2.3.94 需求 3：选取文字复制（弹出可选文本框，供用户手动选取后复制）
  onSelectCopy?: (msg: ChatMessage) => void;

  roleMood?: string;

  searchResults?: SearchResultItem[];

  // 点击越界引用编号时展开本条回复下方的联网搜索结果列表

  onOpenSearch?: () => void;

  // ===== 伪流式输出（v2.3.34 起；v2.3.36 单一「动画速度」= 单字渐显时长，触发间隔自动推导）=====

  pseudoOn?: boolean; // 总开关

  pseudoSpeed?: number; // 动画速度（秒/字 = 单字渐显时长）

  pseudoKey?: string; // 本条消息的待放出标记 key（chat_id:msg.id）

  // v2.3.101：本条消息为「新追加」→ 播放「头像渐显 + 气泡弹出」入场动画
  animEnter?: boolean;

  // v2.3.102 需求 1：若本条用户消息的 id 等于唯一锚点 id，则在其 .msg-body 内渲染「重发」按钮
  interruptedAnchorId?: number | null;

  onResendInterrupted?: (m: ChatMessage) => void;

}> = ({

  msg, onImage, prevTimestamp, avatarPath, userAvatarPath, showTts, ttsState, typing, streaming, hideReasoning, onSpeak, onReplayTts, onRegenerateTts, onReasoningCopied,

  onQuickMemory, onSaveImageMemory, onViewPrompt, onForward, onEdit, onRollback, onCopy, onTranslate, onMarkNode, onForkFromHere, onSelectCopy, onDeleteMsg, onAiAction, showAiActions, aiActionBusy, onToggleCollapse, allCollapsed, roleMood, searchResults, onOpenSearch,

  pseudoOn, pseudoSpeed, pseudoKey, animEnter, interruptedAnchorId, onResendInterrupted,

}) => {

  const { t } = useI18n();

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // v2.3.90：右键菜单的缩入（关闭）动画。
  // v2.3.104 R1：原「文字选中一键记忆弹窗」及其独立 retract 已整体移除，
  // 记忆入口收敛为右键菜单「一键记忆」按钮（保留于下方 portal）。
  const ctxMenu = useRetract(menuPos);
  // v2.3.104 R3：同气泡二次右键重定位 → 旧隐新弹并行（退役快照 + key 重挂载）
  const menuRelocate = useMenuRelocate(menuPos);

  const failed = msg.status === 'failed';

  // v2.3.64：「回复已全部生成完毕」——typing（占位气泡）与 streaming（流式输出中）都为假即算完成。

  // 只有「回复已全部生成完毕」才让气泡下方的操作栏（语音 + 续写 / 重写 / AI 代写）弹出，生成过程中缩回——

  const streamed = !typing && !streaming;

  // v2.3.94 需求 2：伪流式块整体上移到此处（原在下方）。原因：「操作栏何时弹出」需要读
  // pseudoState.revealing，而 Hook 必须在使用它的 useEffect 之前调用，否则渲染时拿到 undefined。

  // ===== 伪流式输出（v2.3.34）=====

  const isUser = msg.sender_type === 'user';

  // 判定：开启伪流式 + AI 消息 + 已定稿（不在流式中）+ 有正文 + 该消息被标记为「待逐字放出」

  const pseudoText = msg.content || '';

  const pseudoActive = !!pseudoOn && !isUser && !streaming && !!pseudoText.trim() && isPseudoPending(pseudoKey || '');

  const pseudoState = usePseudoReveal(pseudoText, pseudoActive, pseudoSpeed ?? 0.2);

  // 放完即清除标记，避免切换聊天回来后二次重播

  useEffect(() => {

    if (pseudoActive && !pseudoState.revealing) clearPseudoPending(pseudoKey || '');

  }, [pseudoActive, pseudoState.revealing, pseudoKey]);

  // 流式进行中：伪流式开启时气泡内先不显示正文（留到全部生成完毕后逐字放出），思维链照常实时显示

  const pseudoHideLive = !!pseudoOn && !!streaming && !isUser && !!pseudoText.trim();

  // 单字渐显动画时长 = 「动画速度」设置（pseudoSpeed 即 D，秒）；触发间隔由 usePseudoReveal 按 D/4 自动推导

  const pseudoCharDur = `${clampPseudoSpeed(pseudoSpeed ?? 0.8)}s`;

  // 操作栏可见性（v2.3.94 修正·仅改表现方式）：streamed 变 false → 移除 is-in（CSS 里 visibility:hidden = 完全不可见）；
  // 变 true → 下一帧加 is-in（visibility:visible = 以正常大小直接出现，无缩放动画）。
  // 占位始终在（visibility 不影响布局），故不引起气泡高度跳动。

  const [actionBarVisible, setActionBarVisible] = useState(false);

  // v2.3.94 需求 2：弹出时机 = 「模型生成完毕」**且**「伪流式逐字放完」。

  // 旧实现只看 streamed，开伪流式时按钮会在正文还没放完就弹出来。

  // revealing 为 false 即已放完（判定见 src/utils/pseudoStream.ts 的 usePseudoReveal）。

  const actionBarGate = streamed && !pseudoState.revealing;

  useEffect(() => {

    if (!actionBarGate) {

      setActionBarVisible(false);

      return;

    }

    // v2.3.94 修正：表现方式改为「直接出现」后，本行的 rAF 在时序上已非必需
    //（visibility 切换无需等待基态提交，瞬时生效）。
    // 仍然保留：既维持与 v2.3.77 一致的「下一帧才切可见」的时序（避免与同帧的正文 DOM 更新抢帧），
    // 也避免因「动效开关开/关」两种环境下可能出现的首帧差异而导致按钮延后一帧出现。
    // 保守起见不动状态逻辑——本次改动只涉及 CSS 表现。

    const id = requestAnimationFrame(() => setActionBarVisible(true));

    return () => cancelAnimationFrame(id);

  }, [actionBarGate]);

  // 发送时间（气泡上方）：同一分钟仅顶部消息显示；否则显示 HH:MM（24 小时制）。
  // v2.3.102 需求 2（QA 复核修正）：**不再**显示本地化的「刚刚」文案。
  // 原因：时间标签恒在 44px 的头像列内（.msg-avatar-col，flex:0 0 44px），而 msg.justNow 的译文本宽度
  // 在 10 个 locale 里有 5 个超过 44px（西语「Hace un momento」≈82px 最甚），溢出会左右对称串出、压到旁边的气泡上。
  // HH:MM 由 getHours()/getMinutes() 生成、与 locale 无关、恒为 ~28px，故统一采用。

  const timeAbove = (() => {

    const d = new Date(msg.timestamp).getTime();

    if (isNaN(d)) return null;

    if (prevTimestamp) {

      const pd = new Date(prevTimestamp).getTime();

      if (!isNaN(pd) && Math.floor(d / 60000) === Math.floor(pd / 60000)) return null;

    }

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



  const closeMenu = () => { setMenuPos(null); };



  // 全局关闭菜单：左键点菜单外关闭；右键气泡交给 React onContextMenu 打开/重定位，不再在同事件里关闭导致二次右键失效；Esc 关闭

  useEffect(() => {

    if (!menuPos) return;

    const onDoc = (e: MouseEvent) => {

      const el = e.target as HTMLElement | null;

      if (el && el.closest('.ctx-menu')) return;

      if (e.type === 'contextmenu' && el && el.closest('.msg-row')) return;

      setMenuPos(null);

    };

    const onKey = (e: KeyboardEvent) => {

      if (e.key === 'Escape') { setMenuPos(null); }

    };

    window.addEventListener('click', onDoc);

    window.addEventListener('contextmenu', onDoc);

    window.addEventListener('keydown', onKey);

    return () => {

      window.removeEventListener('click', onDoc);

      window.removeEventListener('contextmenu', onDoc);

      window.removeEventListener('keydown', onKey);

    };

  }, [menuPos]);



  // 跨气泡菜单协调：收到其他气泡的打开通知时关闭本气泡菜单，确保整窗唯一

  useEffect(() => {

    const onCloseOthers = (ev: Event) => {

      const detail = (ev as CustomEvent<unknown>).detail;

      if (detail !== msg.id) { setMenuPos(null); }

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

    closeMenu();

  };

  const handleForward = () => { onForward?.(msg); closeMenu(); };

  const handleEdit = () => { onEdit?.(msg); closeMenu(); };

  const handleRollback = () => { onRollback?.(msg.id); closeMenu(); };

  const handleDeleteMsg = () => { onDeleteMsg?.(msg.id); closeMenu(); };



  // 流式逐字渐显（v2.3.19）：每个新字固定 0.3s 渐显；模型输出停滞（约一个动画周期无新字）时，

  // 仅最后一个字切换为「渐隐 0.5s + 渐显 0.5s」的闪烁过渡，此前已生成的字绝不参与动画

  const [tailStalled, setTailStalled] = useState(false);

  useEffect(() => {

    const has = !!(msg.content && msg.content.trim());

    if (!streaming || !has) { setTailStalled(false); return; }

    setTailStalled(false);

    const t = window.setTimeout(() => setTailStalled(true), 340);

    return () => window.clearTimeout(t);

  }, [streaming, msg.content]);

  const streamTailClass = `stream-char${tailStalled ? ' stall' : ''}`;


  if (msg.sender_type === 'system') {

    return <div className="system-msg">{msg.content}</div>;

  }

  // 多图优先：image_path 兼容旧单图数据；images 为新的多图数组

  const imgs = msg.images && msg.images.length ? msg.images : msg.image_path ? [msg.image_path] : [];

  const hasText = !!(msg.content && msg.content.trim());

  // v2.3.104 R3：右键菜单项抽为局部 JSX，供「活菜单」与「退役快照」两个 portal 共用，
  // 保证快照与活菜单渲染内容一致（尺寸一致、无跳动）。快照侧 pointer-events:none，
  // 这些 onClick 不会被触发，保留是为内容完全同源。
  const menuItems = (
    <>
      <button className="ctx-menu-item" onClick={handleCopy}>{t('msg.copy')}</button>
      {onQuickMemory && <button className="ctx-menu-item" onClick={() => handleQuickMemory(msg.content)}>{t('msg.quickMemory')}</button>}
      {onTranslate && <button className="ctx-menu-item" onClick={() => { onTranslate(msg.content, msg.sender_name); closeMenu(); }}>{t('msg.translate')}</button>}
      {/* 朗读：任何有文本的气泡都可右键朗读（用户消息用全局音色，AI 消息按角色音色） */}
      {hasText && onSpeak && (
        <button className="ctx-menu-item" onClick={() => { onSpeak(); closeMenu(); }}>
          {ttsState === 'playing' ? t('chat.ttsPause') : t('chat.ttsPlay')}
        </button>
      )}
      {/* v2.3.44：强制重新合成语音（忽略磁盘缓存）；平时的播放/重播一律复用缓存不重新生成 */}
      {hasText && onRegenerateTts && (
        <button className="ctx-menu-item" onClick={() => { onRegenerateTts(); closeMenu(); }}>
          {t('msg.regenerateTts')}
        </button>
      )}
      {onMarkNode && <button className="ctx-menu-item" onClick={() => { onMarkNode(msg); closeMenu(); }}>{t('chat.markNode')}</button>}
      {/* v2.3.94 需求 1：从此处开启新对话。放在「标记剧情节点」之后 ——
          两者语义相邻（都是「以这条消息为起点做一条新时间线」），但结果不同：
          标记节点只打标记，分叉会真的开出一个新聊天。 */}
      {onForkFromHere && (
        <button className="ctx-menu-item" onClick={() => { onForkFromHere(msg); closeMenu(); }}>
          {t('msg.forkFromHere')}
        </button>
      )}
      {/* v2.3.94 需求 3：选取文字复制。弹出文本框让用户手动选取气泡内文字，
          再复制到剪贴板（区别于上面的「复制」——后者直接复制整条）。 */}
      {onSelectCopy && hasText && (
        <button className="ctx-menu-item" onClick={() => { onSelectCopy(msg); closeMenu(); }}>
          {t('msg.selectCopy')}
        </button>
      )}
      {onSaveImageMemory && (msg.images?.length || msg.image_path) && (
        <button className="ctx-menu-item" onClick={() => { onSaveImageMemory(msg); closeMenu(); }}>{t('chat.drawMemory')}</button>
      )}
      {msg.genPrompt && (
        <button className="ctx-menu-item" onClick={() => { onViewPrompt?.(msg.genPrompt!); closeMenu(); }}>{t('msg.viewPrompt')}</button>
      )}
      {onForward && <button className="ctx-menu-item" onClick={handleForward}>{t('msg.forward')}</button>}
      {isUser && onEdit && <button className="ctx-menu-item" onClick={handleEdit}>{t('msg.edit')}</button>}
      {onRollback && <button className="ctx-menu-item ctx-menu-danger" onClick={handleRollback}>{t('msg.rollback')}</button>}
      {onDeleteMsg && <button className="ctx-menu-item ctx-menu-danger" onClick={handleDeleteMsg}>{t('msg.deleteMsg')}</button>}
      {onToggleCollapse && (
        <button className="ctx-menu-item" onClick={() => { onToggleCollapse(); closeMenu(); }}>
          {allCollapsed ? t('msg.expandAll') : t('msg.collapseAll')}
        </button>
      )}
    </>
  );

  // 联网搜索内联引用：仅 AI 消息启用 [n] 可点击。资料来源优先取随消息持久化的 search_results，

  // 缺失时回退到本次会话内存中按 streamId 分桶的搜索结果（两者顺序都与注入模型的编号一致）

  const msgSrSelf = (msg as any).search_results as SearchResultItem[] | undefined;

  const citeSrc = msgSrSelf && msgSrSelf.length ? msgSrSelf : searchResults && searchResults.length ? searchResults : undefined;

  const citeCitations = (!isUser && citeSrc && citeSrc.length)

    ? Object.fromEntries(citeSrc.map((r, idx) => [idx + 1, r.url]))

    : undefined;

  const citeOnClick = citeCitations

    ? (url: string) => { try { api?.openExternal?.(url); } catch { /* web/Capacitor 构建无此接口时忽略 */ } }

    : undefined;

  const citeOnMiss = citeCitations && onOpenSearch ? onOpenSearch : undefined;



  // v2.3.63：已移除「撤回」渲染分支——历史数据里 status==='recalled' 的旧消息

  // 现在按普通消息正常显示内容（不再渲染「已撤回」占位），避免旧消息变成空白块。



  return (

    <div className={`msg-row ${isUser ? 'user' : 'ai'}${animEnter ? ' anim-enter' : ''}`} data-mid={msg.id} style={{ position: 'relative' }} onContextMenu={handleContextMenu}>

      {/* v2.3.102 需求 2：头像 + 时间合成一个固定 44px 的竖列（.msg-avatar-col），
          时间恒在头像正下方；.msg-row.user 的 row-reverse 只翻转行方向，列内是 column，
          故 user/ai 两向时间都恒在头像下方，且不再作为 .msg-row 直接子项参与横向占宽。
          timeAbove「同一分钟仅顶部显示」的判定逻辑保持不变，仅改渲染位置。 */}
      <div className="msg-avatar-col">

        <div className="avatar">

          {isUser

            ? (userAvatarPath ? <AvatarImg path={userAvatarPath} /> : '🙂')

            : avatarPath ? <AvatarImg path={avatarPath} /> : '🤖'}

        </div>

        {timeAbove && <div className="msg-time-above">{timeAbove}</div>}

      </div>

      {/* v2.3.78：加 msg-body class —— flex 子项默认 min-width:auto，长消息会把容器撑到超过
          .msg-row 宽度而换行，把气泡挤到头像下方（名字夹在头像与气泡中间）。min-width:0 修正。 */}
      <div className="msg-body">

        {!isUser && (

          <div className="sender">

            {msg.sender_name}

            {msg.from_proactive && (

              <span className="proactive-tag" title={t('msg.proactiveTitle')}>{t('msg.proactiveTag')}</span>

            )}

            {roleMood && <span className="mood-tag">· {roleMood}</span>}

            {/* v2.3.44：删除气泡上方的模型标签（模型信息统一在标题栏模型标签显示） */}

          </div>

        )}

        {typing ? (

          <div className="bubble">

            <div className="typing" aria-label={t('chat.replying')}>

              <span className="typing-bar" />

            </div>

          </div>

        ) : (

          <>

            {(!isUser && msg.reasoning?.trim()) || hasText ? (

              <div

                className={`bubble ${failed ? 'bubble-failed' : ''}`}

                style={pseudoActive ? ({ ['--pseudo-char-dur' as any]: pseudoCharDur }) : undefined}

              >

                {!isUser && msg.reasoning?.trim() && (

                  <ReasoningBlock

                    reasoning={msg.reasoning}

                    defaultOpen={hideReasoning === false || (!!streaming && !msg.content)}

                    streaming={!!streaming && !msg.content}

                    onCopied={onReasoningCopied}

                  />

                )}

                {hasText && !pseudoHideLive && renderMarkdown(pseudoActive ? pseudoState.text : msg.content, {

                  citations: citeCitations,

                  onCite: citeOnClick,

                  onCiteMiss: citeOnMiss,

                  // 伪流式：单 tail 会被逐字触发频繁换字打断动画（字只渐显 1/4 就定格，观感为蹦字），

                  // 改用「5 字尾窗」：窗口内每个字挂载时各自渐显，落出窗口时动画已播完（v2.3.36）

                  streamTail: pseudoActive ? false : !!streaming,

                  pseudoTailCount: pseudoActive ? PSEUDO_QUEUE : 0,

                  streamTailClass: pseudoActive ? 'pseudo-char' : streamTailClass,

                })}

                {/* F6 修复：流式进行中始终在气泡内显示加载动画，避免「只有顶部横幅显示 AI 正在回复」 */}

                {streaming && (

                  <span className="typing-inline" aria-label={t('chat.replying')} />

                )}

              </div>

            ) : (

              <div className="bubble bubble-loading">

                <div className="typing" aria-label={t('chat.replying')}>

                  <span className="typing-bar" />

                </div>

              </div>

            )}

            {imgs.length > 0 && <ImageGrid paths={imgs} onImage={onImage} failed={!!failed} />}

            {failed && !hasText && imgs.length === 0 && (

              <span style={{ color: 'var(--color-danger, #e74c3c)' }}>{t('msg.resendTip')}</span>

            )}

          </>

        )}

        <div className="msg-meta">

          {failed && (

            <a onClick={handleEdit} style={{ cursor: 'pointer', color: 'var(--color-danger, #e74c3c)', marginLeft: 8 }}>

              {t('msg.resend')}

            </a>

          )}

          {!isUser && msg.token_used > 0 && (

            <span>{t('chat.tokensUsed', { n: msg.token_used })}</span>

          )}

          {/* v2.3.78：操作栏移至「消耗 N tokens」同一行的右侧（此前在气泡下方独占一行）。
              语音组 🔊 ⟳：每条 AI 消息都有；AI 操作组 ✍ ⟲ 💬：仅最后一条 AI 消息显示。

              v2.3.94 修复 BUG：原条件 `showTts && !typing && !streamed`，而 streamed = !typing && !streaming，
              代入后等价于 `!typing && streaming` —— 只在「正在流式输出」时为真，
              与可见性门（actionBarGate 要求 streamed 为真）**严格互斥**，是事实上的死代码。
              后果：语音组被错误地挂在 showAiActions（= m.id === lastMsgId）这条兜底分支上，
              于是**只有最后一条 AI 消息能看到 🔊 ⟳，其余 AI 消息的语音按钮全程不可见**。
              现改为 `showTts && !isUser`：语音组独立成门，与「是不是最后一条」解耦。
              容器始终在 DOM（占位不引起气泡高度跳动），可见性统一由 .is-in（actionBarVisible）控制。
              v2.3.94 修正：.is-in 由「scale 0.4 缩放过渡」改为「visibility 切换」，按钮直接以正常大小出现。*/}
          {((showTts && !isUser) || (showAiActions && onAiAction && !isUser)) && (

          <div className={`msg-action-bar ${actionBarVisible ? 'is-in' : ''}`}>

            {/* 语音：播放 / 暂停 / 重播（v2.3.44 语义不变，仅位置从气泡内右侧移到气泡下方）*/}

            {showTts && (

              <>

                <button

                  type="button"

                  className="msg-ai-action-btn"

                  onClick={onSpeak}

                  title={

                    ttsState === 'playing'

                      ? t('chat.ttsPause')

                      : ttsState === 'paused'

                        ? t('chat.ttsResume')

                        : ttsState === 'ready'

                          ? t('chat.ttsReplay')

                          : t('chat.ttsPlay')

                  }

                >

                  {ttsState === 'playing' ? '⏸' : ttsState === 'paused' ? '▶' : '🔊'}

                </button>

                {(ttsState === 'playing' || ttsState === 'paused' || ttsState === 'ready') && (

                  <button

                    type="button"

                    className="msg-ai-action-btn"

                    onClick={onReplayTts}

                    title={t('chat.ttsReplayTip')}

                  >

                    ⟳

                  </button>

                )}

              </>

            )}

            {/* v2.3.65：分组隔断——左侧语音组（听这条消息），右侧 AI 操作组（让 AI 再干活）。
                两者用途不同，用竖线分开避免误点：顺时针 ⟳ 是语音重播、逆时针 ⟲ 是 AI 重写，
                方向相反极易混淆，隔断同时起到视觉分组作用。*/}
            {/* v2.3.103：隔断线常驻 DOM，用 .is-shown 切换显隐并带过渡动画。
                规则：仅「朗读(🔊)」存在而无其他按钮时（is-shown=false）隔断收起（宽 0、透明），
                一旦出现 代写/重写/续写 等其它按钮（is-shown=true）才展开 —— 避免「只有朗读时右边挂一条悬空竖线」。*/}
            {showTts && (
              <span
                className={`msg-action-divider ${showAiActions && onAiAction && !isUser ? 'is-shown' : ''}`}
                aria-hidden="true"
              />
            )}

            {/* v2.3.94 需求 2 连带修复：容器门控拆开后，AI 操作组必须自己带上 showAiActions 门。
                此前这三颗按钮完全依赖外层 `(showAiActions && onAiAction && !isUser)` 兜底才不出现在
                每条 AI 消息上；容器一旦改成「语音组独立成门」，兜底就会失效，
                ✍ ⟲ 💬 会在**每条** AI 消息上冒出来（把一个 BUG 换成另一个 BUG）。
                语义依据（见上方 v2.3.78 注释）：语音组每条都有；AI 操作组仅最后一条 AI 消息显示。 */}
            {showAiActions && onAiAction && !isUser && (<>


              <button
                type="button"
                className="msg-ai-action-btn"
                disabled={aiActionBusy}
                title={t('msg.aiContinue')}

                onClick={(e) => { e.stopPropagation(); void onAiAction?.('continue'); }}

              >

                ✍

              </button>

              <button

                type="button"

                className="msg-ai-action-btn"

                disabled={aiActionBusy}

                title={t('msg.aiRewrite')}

                onClick={(e) => { e.stopPropagation(); void onAiAction?.('rewrite'); }}

              >

                ⟲

              </button>

              <button

                type="button"

                className="msg-ai-action-btn"

                disabled={aiActionBusy}

                title={t('msg.aiReplyForUser')}

                onClick={(e) => { e.stopPropagation(); void onAiAction?.('replyForUser'); }}

              >

                💬

              </button>

              {aiActionBusy && <span className="msg-ai-actions-tip">{t('msg.aiActionWorking')}</span>}
            </>)}

          </div>

          )}



        </div>

        {/* v2.3.103：重发按钮改为「横向按钮行」形态（与 AI 代写/重写/续写/朗读 同一行式样），
            复用 .msg-action-bar 的 0.5s 弹出动画。常驻 DOM、用 .is-in 切换显隐，
            这样从「无 → 有」时才会触发过渡（与 AI 操作栏同机制），而非挂载即终态。
            按钮本身仍是 block 级独占一格、左对齐（msg-resend-bar 覆盖对齐）。*/}
        {onResendInterrupted && (
          <div className={`msg-action-bar msg-resend-bar ${interruptedAnchorId === msg.id ? 'is-in' : ''}`}>
            <button
              type="button"
              className="msg-resend-btn"
              disabled={aiActionBusy}
              title={t('chat.resendInterruptedTip')}
              onClick={() => onResendInterrupted(msg)}
            >
              {t('chat.resendInterrupted')}
            </button>
          </div>
        )}

      </div>


      {/* 右键菜单：Portal 到 body，脱离 .app-root 的 transform/filter 包含块，避免 fixed 坐标相对祖先偏移。
          v2.3.104 R3：key={menuRelocate.seq} —— 同气泡二次右键重定位时 seq+1 强制重挂载，
          重放 popupLinearIn（跨气泡路径由 useRetract 既有 leaving 分支天然并行，不经此处）。 */}
      {ctxMenu.shown && createPortal(

        <div

          key={menuRelocate.seq}

          className={`ctx-menu${ctxMenu.leaving ? ' leaving' : ''}`}

          style={{

            position: 'fixed',

            left: Math.min(ctxMenu.shown.x, window.innerWidth - 160),

            top: Math.min(ctxMenu.shown.y, window.innerHeight - 200),

            zIndex: 300,

          }}

        >

          {menuItems}

        </div>,

        document.body

      )}

      {/* v2.3.104 R3：同气泡重定位的「退役快照」——旧坐标处的静态退场实例。
          className 命中 index.css 既有 `.ctx-menu.leaving`（popupLinearOut 0.15s forwards +
          pointer-events:none），零新增动画 CSS；内容与活菜单共用 menuItems 保证尺寸一致。
          卸载由 useMenuRelocate 的 scaledRetractMs(160) 定时器负责（不依赖 animationend）；
          zIndex 299 使其垫在活菜单（300）之下，旧隐新弹并行时新菜单始终在上。 */}
      {menuRelocate.retiring && createPortal(

        <div

          className="ctx-menu leaving"

          style={{

            position: 'fixed',

            left: Math.min(menuRelocate.retiring.x, window.innerWidth - 160),

            top: Math.min(menuRelocate.retiring.y, window.innerHeight - 200),

            zIndex: 299,

            pointerEvents: 'none',

          }}

        >

          {menuItems}

        </div>,

        document.body

      )}

    </div>

  );

};

