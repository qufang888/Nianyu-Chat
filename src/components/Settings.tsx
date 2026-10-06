import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useTheme } from '../theme/ThemeContext';
import { useI18n } from '../i18n/I18nContext';
import { LANGS, localeOf, type Lang } from '../i18n/translations';
import {
  type UpdateStatus,
  PROVIDER_DEFAULTS,
  DEFAULT_SETTINGS,
  type ThemeName,
  type AppSettings,
  type ImageGenSettings,
  type DeepThinkLevel,
  type VideoGenSettings,
  type ModelConfig,
  type MediaApiConfig,
  type ChatListItem,
  type SelfRole,
  type WorldBook,
  type ErrorLogEntry,
  type Plugin,
  type Skill,
  type SkillScope,
  MODEL_GROUP_COLORS,
  MODEL_GROUP_NAME_MAX,
  MODEL_GROUP_MAX,
  TTS_PROVIDERS,
  TTS_SPEED_MIN,
  TTS_SPEED_MAX,
  TTS_SPEED_DEFAULT,
  TTS_PITCH_MIN,
  TTS_PITCH_MAX,
  TTS_PITCH_DEFAULT,
  PSEUDO_SPEED_MIN,
  PSEUDO_SPEED_MAX,
  PSEUDO_SPEED_DEFAULT,
  clampPseudoSpeed,
} from '../types';
import { DEFAULT_MEMORY_SUMMARIZE_PROMPT, DEFAULT_MEMORY_INJECT_PROMPT } from '../utils/builtinPrompts';
import { Hint } from './Hint';
import { ANIM_GROUPS, ANIM_MODES, getAnimMode, isGroupEnabled, type AnimMode } from '../utils/animControl';
import { ModelEditor } from './ModelEditor';
import { MediaApiConfigEditor, resolveMediaConfigs } from './MediaApiConfigEditor';
import { FontSettings } from './FontSettings';
import { GuideView } from './GuideView';
import { SelfRoleSettings } from './SelfRoleSettings';
import { useToast, ToastView } from './Toast';
import SelectMenu from './SelectMenu';
import ComboBox from './ComboBox';
import SearchSuggest from './SearchSuggest';
import { MAX_SUGGESTIONS, suggest, suggestWithCount } from '../utils/fuzzySearch';
import {
  INACTIVE_DAYS_DEFAULT,
  INACTIVE_DAYS_MAX,
  INACTIVE_DAYS_MIN,
  clampInactiveDays,
} from '../utils/inactiveChats';
import { invalidateSoundCache, previewSound, type SoundType } from '../utils/sound';
import { compareVersions } from '../utils/versionCompare';
import cursorPngUrl from '../assets/cursor/cursor.png';

export const THEMES: { key: ThemeName; nameKey: string; swatch: string }[] = [
  { key: 'wechat', nameKey: 'theme.wechat', swatch: 'linear-gradient(135deg,#07c160,#2e2e2e)' },
  { key: 'glass', nameKey: 'theme.glass', swatch: 'linear-gradient(135deg,#6a3aa8,#a1429c)' },
  { key: 'dark', nameKey: 'theme.dark', swatch: 'linear-gradient(135deg,#0d0d0d,#4a9eff)' },
  { key: 'vibrant', nameKey: 'theme.vibrant', swatch: 'linear-gradient(135deg,#ff8fb1,#ffb86c)' },
  { key: 'azure', nameKey: 'theme.azure', swatch: 'linear-gradient(135deg,#3688d8,#42b4e8)' },
  { key: 'galaxy', nameKey: 'theme.galaxy', swatch: 'linear-gradient(135deg,#9376e0,#c3a2ff)' },
  { key: 'pine', nameKey: 'theme.pine', swatch: 'linear-gradient(135deg,#2a9d8f,#4ecdc4)' },
  { key: 'ember', nameKey: 'theme.ember', swatch: 'linear-gradient(135deg,#f27127,#ffa257)' },
  { key: 'frost', nameKey: 'theme.frost', swatch: 'linear-gradient(135deg,#2478d0,#539ee8)' },
  { key: 'rose', nameKey: 'theme.rose', swatch: 'linear-gradient(135deg,#c97386,#e898a8)' },
  { key: 'cyber', nameKey: 'theme.cyber', swatch: 'linear-gradient(135deg,#39ff99,#8effc2)' },
  { key: 'graphite', nameKey: 'theme.graphite', swatch: 'linear-gradient(135deg,#7a869a,#a0abc0)' },
  { key: 'indigo', nameKey: 'theme.indigo', swatch: 'linear-gradient(135deg,#255b9c,#3d78c2)' },
  { key: 'sand', nameKey: 'theme.sand', swatch: 'linear-gradient(135deg,#a16f49,#c89468)' },
];

// 设置分类区块（左侧导航 + 右侧分组），顺序即展示顺序
// 注：模型管理已独立为二级页（sub='models'），不再出现在左侧分类导航中
const SETTING_CATS: { id: string; labelKey: string }[] = [
  { id: 'cat-general', labelKey: 'settings.catGeneral' },
  { id: 'cat-chat', labelKey: 'settings.catChat' },
  { id: 'cat-proactive', labelKey: 'settings.catProactive' },
  { id: 'cat-social', labelKey: 'settings.catSocial' },
  { id: 'cat-appearance', labelKey: 'settings.catAppearance' },
  { id: 'cat-generation', labelKey: 'settings.catGeneration' },
  { id: 'cat-translation', labelKey: 'settings.catTranslation' },
  { id: 'cat-window', labelKey: 'settings.catWindow' },
];

// 设置搜索索引：每项含锚点 id、i18n 键、中英文关键词；可选 sub=目标二级页（'models'|'font'|'self'）。
// 带 sub 的条目：点击/回车后先切入对应二级页，再滚动到锚点并高亮（二级页内锚点此时才存在于 DOM）。
type SettingSearchItem = { id: string; key: string; kw: string[]; sub?: 'models' | 'font' | 'self' };
const SETTING_SEARCH_INDEX: SettingSearchItem[] = [
  { id: 'cat-general', key: 'settings.catGeneral', kw: ['通用', '常规', '基础', 'general', 'basic'] },
  { id: 'cat-chat', key: 'settings.catChat', kw: ['聊天', '群聊', '群组', '互聊', '情绪', '思维链', 'chat', 'group'] },
  { id: 'cat-proactive', key: 'settings.catProactive', kw: ['主动消息', '空闲', '定时', '勿扰', 'nhpp', '回访', 'proactive'] },
  { id: 'cat-social', key: 'settings.catSocial', kw: ['记忆', '世界书', '朋友圈', '社交', 'memory', 'moments'] },
  { id: 'cat-appearance', key: 'settings.catAppearance', kw: ['外观', '主题', '界面', 'appearance', 'theme'] },
  { id: 'cat-generation', key: 'settings.catGeneration', kw: ['生成', '生图', '生视频', 'generation', 'image', 'video'] },
  { id: 'cat-translation', key: 'settings.catTranslation', kw: ['翻译', 'translation'] },
  { id: 'cat-window', key: 'settings.catWindow', kw: ['窗口', '小窗', '悬浮球', 'window', '迷你'] },
  { id: 'sec-language', key: 'settings.language', kw: ['语言', 'language', '界面语言', '中文', '英文'] },
  { id: 'sec-animations', key: 'settings.animations', kw: ['动画', 'animation', '动效', '全部开启', '全部关闭', '自定义', '分组', 'all on', 'all off', 'custom', 'group'] },
  { id: 'sec-update', key: 'settings.updateTitle', kw: ['更新', '升级', '版本', '检查更新', '自动更新', '下载更新', 'github', 'update', 'upgrade', 'version', 'release'] },
  // ===== 模型管理（二级页 sub='models'）=====
  { id: 'sec-globalparams', key: 'settings.globalModelParams', sub: 'models', kw: ['全局参数', '全局模型参数', '默认参数', '温度', 'temperature', 'top p', 'topp', 'top k', 'topk', '采样', '流式', 'stream', '打字机'] },
  { id: 'sec-pseudostream', key: 'settings.pseudoStream', sub: 'models', kw: ['伪流式', '伪流式输出', '打字机', '动画速度', '渐显', 'pseudo', 'fake stream', 'typewriter', 'animation speed'] },
  { id: 'sec-modelmanage', key: 'settings.modelManage', sub: 'models', kw: ['模型', 'model', 'baseurl', 'base url', 'api key', 'apikey', '接口', 'provider', '模型列表', '添加模型', '新建模型', '默认模型', 'deepseek', 'openai', 'anthropic', '本地模型', '深度思考', '推理', 'qps', '限速', '分组', 'group', '标签', 'tags'] },
  { id: 'sec-modeldetect', key: 'settings.modelCapability', sub: 'models', kw: ['能力', '检测', '探针', 'capability', 'detect', '视觉', '工具', 'json', 'nsfw', '上下文', '流式检测'] },
  { id: 'sec-mcp', key: 'settings.mcp', sub: 'models', kw: ['mcp', '服务器', '工具', 'tool', '协议', '扩展', 'function calling', '工具调用'] },
  // ===== TTS / ASR / 生图 / 生视频（v2.3.94 需求 7：由「生成」分类移入模型管理页）=====
  { id: 'sec-voice', key: 'settings.voice', sub: 'models', kw: ['语音', 'voice', 'tts', '朗读', '播报', 'asr', '识别', '语音输入'] },
  { id: 'sec-tts', key: 'settings.mcfg.ttsTitle', sub: 'models', kw: ['tts', '文本转语音', '语音合成', '播报', '音色', 'voice', '语速', '音调', '多配置', 'api 配置'] },
  { id: 'sec-asr', key: 'settings.mcfg.asrTitle', sub: 'models', kw: ['asr', '语音识别', '语音输入', '转文字', 'whisper', 'transcribe', 'api 配置'] },
  { id: 'sec-ttsrole', key: 'settings.ttsVoicePerRole', sub: 'models', kw: ['音色', '按角色', '人物音色', '绑定', 'per role', 'voice', '角色配音', '角色卡'] },
  { id: 'sec-imgcfg', key: 'settings.mcfg.imageTitle', sub: 'models', kw: ['生图', '画图', 'image', '图像生成', '文生图', 'dalle', '尺寸', 'size', 'api 配置'] },
  { id: 'sec-vidcfg', key: 'settings.mcfg.videoTitle', sub: 'models', kw: ['生视频', '视频', 'video', '文生视频', '时长', 'duration', '尺寸', 'api 配置'] },
  // ===== 常规区 =====
  { id: 'sec-font', key: 'settings.font', sub: 'font', kw: ['字体', 'font', '字号'] },
  { id: 'sec-self', key: 'self.title', sub: 'self', kw: ['自我', '身份', 'self', '角色'] },
  { id: 'sec-worldbook', key: 'worldbook.title', kw: ['世界书', 'worldbook', '背景设定'] },
  { id: 'sec-groupchat', key: 'settings.groupChat', kw: ['群聊', 'group', '多人', '群组', '互聊', '并行'] },
  { id: 'sec-launch', key: 'settings.launchOnBoot', kw: ['开机', '自启', '启动', 'launch', 'boot', 'startup'] },
  { id: 'sec-theme', key: 'settings.theme', kw: ['主题', 'theme', '配色', '皮肤'] },
  { id: 'sec-radius', key: 'settings.radius', kw: ['圆角', 'radius', '边角'] },
  { id: 'sec-uizoom', key: 'settings.uiZoom', kw: ['缩放', 'zoom', '等比', '基准尺寸', '上下限'] },
  { id: 'sec-emoevent', key: 'settings.emoEventAdvanced', kw: ['情绪', '事件', 'emotion', 'event', '高级'] },
  { id: 'sec-inputappearance', key: 'settings.inputAppearance', kw: ['输入框', 'input', '输入栏', '外观'] },
  { id: 'sec-cursor', key: 'settings.cursor', kw: ['光标', 'cursor', '鼠标指针', '自定义光标'] },
  { id: 'sec-glassbg', key: 'settings.glassBg', kw: ['毛玻璃', 'glass', '背景', '虚化', '颜色', '字体', '边框', '气泡', '透明', 'frost', 'blur', 'color', 'border', 'bubble', 'font'] },
  { id: 'sec-debug', key: 'settings.debugMode', kw: ['调试', '测试', 'debug', '快照', '错误报告', '手动触发', '触发'] },
  { id: 'sec-sceneimage', key: 'settings.sceneImage', kw: ['场景图', 'scene', '配图'] },
  { id: 'sec-websearch', key: 'settings.webSearch', kw: ['联网', '搜索', 'web', 'search', '联网搜索'] },
  { id: 'sec-plugins', key: 'settings.plugins', kw: ['插件', 'plugin', '扩展'] },
  { id: 'sec-skills', key: 'skill.title', kw: ['技能', 'skill', '技能包', 'skill.md', '说明书', '注入'] },
  { id: 'sec-translation', key: 'settings.translation', kw: ['翻译', 'translation', '译文'] },
  { id: 'sec-sound', key: 'settings.sound', kw: ['音效', 'sound', '提示音', '通知音', '声音'] },
  { id: 'sec-mini', key: 'settings.mini', kw: ['小窗', '迷你', 'mini', '快捷'] },
  { id: 'sec-inactive-chat', key: 'settings.inactiveChatDays', kw: ['不常用', '不常用聊天', '不活跃', '闲置', '归档', '收起来', '多少天', '天数', 'inactive', 'archive', 'folder', 'days', 'stale'] },
  { id: 'sec-floatingball', key: 'settings.floatingBall', kw: ['悬浮球', '浮动球', '球', 'floating', '桌面'] },
  { id: 'sec-datapath', key: 'settings.dataPath', kw: ['数据', '路径', 'data', 'path', '存储'] },
  { id: 'sec-closebehavior', key: 'settings.closeBehavior', kw: ['关闭', '退出', 'close', '退出行为'] },
  { id: 'sec-errorlog', key: 'settings.errorLog', kw: ['错误', '日志', 'error', 'log', '报错'] },
  { id: 'sec-backup', key: 'settings.backup', kw: ['备份', 'backup', '恢复'] },
  { id: 'sec-reset', key: 'settings.resetSettings', kw: ['重置', 'reset', '恢复默认', '清空'] },
];

const SOUND_ROWS: { type: SoundType; labelKey: string }[] = [
  { type: 'error', labelKey: 'settings.soundError' },
  { type: 'click', labelKey: 'settings.soundClick' },
  { type: 'notification', labelKey: 'settings.soundNotification' },
  { type: 'popup', labelKey: 'settings.soundPopup' },
  { type: 'miniPopup', labelKey: 'settings.soundMiniPopup' },
  { type: 'messageSend', labelKey: 'settings.soundMessageSend' },
];

// 光标热点预览（拖动红点设置）
// hotspot 值是相对图像左上角的像素偏移，存储在「基础尺寸 28」坐标系下，
// 滑块在预览中以 (displaySize / 28) 的比例反映实际位置。
function CursorHotspotPreview({
  hotspotX, hotspotY, displaySize = 112, onChange,
}: {
  hotspotX: number;
  hotspotY: number;
  displaySize?: number;
  onChange: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const BASE = 28; // 与 CustomCursor.tsx 的 HOTSPOT_BASE_SIZE 对齐
  const ratio = displaySize / BASE;
  const markerLeft = hotspotX * ratio;
  const markerTop = hotspotY * ratio;

  const handlePointer = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // clamp 到预览区内
    const x = Math.max(0, Math.min(displaySize, clientX - r.left));
    const y = Math.max(0, Math.min(displaySize, clientY - r.top));
    // 转换回基础尺寸坐标系（整数）
    onChange(Math.round(x / ratio), Math.round(y / ratio));
  };

  return (
    <div
      ref={ref}
      data-cursor-preview
      style={{
        position: 'relative', width: displaySize, height: displaySize,
        borderRadius: 10, overflow: 'hidden', background: 'var(--color-input-bg)',
        border: '1px solid var(--color-border)', touchAction: 'none', userSelect: 'none',
        // 这里故意用 crosshair 风格的原生光标：CustomCursor 永远在它之上，preview 只是占位提示
        cursor: 'none',
      }}
      onMouseDown={(e) => {
        draggingRef.current = true;
        handlePointer(e.clientX, e.clientY);
        e.preventDefault();
      }}
      onMouseMove={(e) => { if (draggingRef.current) handlePointer(e.clientX, e.clientY); }}
      onMouseUp={() => { draggingRef.current = false; }}
      onMouseLeave={() => { draggingRef.current = false; }}
    >
      <img
        src={cursorPngUrl}
        alt="cursor"
        draggable={false}
        style={{ width: displaySize, height: displaySize, display: 'block', pointerEvents: 'none' }}
      />
      {/* 红色十字 + 圆点标记光标点击点 */}
      <div
        style={{
          position: 'absolute', left: markerLeft, top: markerTop,
          pointerEvents: 'none', transform: 'translate(-50%, -50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <div style={{ position: 'absolute', width: 14, height: 1, background: '#ff3b30' }} />
        <div style={{ position: 'absolute', width: 1, height: 14, background: '#ff3b30' }} />
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,59,48,0.18)', border: '1px solid rgba(255,59,48,0.6)' }} />
      </div>
      {/* 左上角 0,0 基准提示 */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 4, height: 4, background: 'var(--color-primary)' }} />
    </div>
  );
}

export const Settings: React.FC<{
  onRerunWizard?: () => void;
  onAbout?: () => void;
  // 跳到「通讯录」（人物音色绑定已迁移到角色卡编辑器，设置页只留跳转入口）
  onGoToContacts?: () => void;
  // 模型管理独立二级页面模式：只渲染「模型管理」分区 + 模型配置搜索框（不渲染其余设置分区）
  modelsOnly?: boolean;
  // 导航重置信号：再次点击左侧「设置」图标时从二级页退回设置主界面
  navResetTick?: number;
}> = ({
  onRerunWizard,
  onAbout,
  onGoToContacts,
  modelsOnly,
  navResetTick,
}) => {
  const [sub, setSub] = useState<'main' | 'font' | 'self' | 'models'>('main');
  // 点击左侧「设置」图标：无论当前在哪个二级页，都退回设置主界面
  useEffect(() => {
    setSub('main');
  }, [navResetTick]);
  const onlyModels = modelsOnly === true || sub === 'models';
  const { toast, showToast } = useToast();
  const { theme, setTheme, settings, reloadSettings } = useTheme();
  // v2.3.90：动效开关——更新进度条用的是**内联 transition**，优先级高于 `.anim-off *` 的 !important，
  // 关闭动效时仍会播放，故走 isGroupEnabled 判定（与 CustomTitleBar / QueueDock 同思路）。
  const animOn = isGroupEnabled(settings, 'progress');
  const { t, lang, setLang } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const catRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeCat, setActiveCat] = useState(SETTING_CATS[0].id);
  const scrollToCat = (id: string) => {
    // 「模型与群聊」分类：直接进入模型管理二级页（该区块已不在主页渲染，滚动无目标）
    if (id === 'cat-models') {
      setSub('models');
      return;
    }
    catRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveCat(id);
  };
  const onPanelScroll = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const top = panel.getBoundingClientRect().top;
    let current = SETTING_CATS[0].id;
    for (const c of SETTING_CATS) {
      const el = catRefs.current[c.id];
      if (el && el.getBoundingClientRect().top - top <= 90) current = c.id;
    }
    setActiveCat(current);
  };
  // 导入图片作为毛玻璃背景（读取为 data URL 存入设置）
  const importGlassBg = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => patch({ glassBgImage: String(reader.result), glassBgColor: '' });
      reader.readAsDataURL(f);
    };
    inp.click();
  };
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [detectingAll, setDetectingAll] = useState(false);
  const [status, setStatus] = useState('');

  // 识图模型（v2.3.51）：ComboBox 受控输入的临时查询文本；选中/清空后回到「按 ID 解析名称」显示
  const [visionQuery, setVisionQuery] = useState('');
  useEffect(() => {
    setVisionQuery('');
  }, [draft?.visionModelId]);

  // 一键检测所有模型能力：逐个发送探针请求，探测视觉/工具/JSON 支持与上下文窗口
  const detectAllModels = async (opts?: { images: boolean; tools: boolean; json: boolean; nsfw: boolean; thinkLevel: boolean }) => {
    if (detectingAll) return;
    setDetectingAll(true);
    try {
      const res = await api.detectAllModels(opts);
      const undetLabel = (k: string): string =>
        ({
          supportsImages: t('model.capImages'),
          supportsTools: t('model.capTools'),
          supportsJson: t('model.capJson'),
          supportsNsfw: t('model.capNsfw'),
          supportsStream: t('model.capStream'),
          supportsThinkLevel: t('model.capThinkLevel'),
        } as Record<string, string>)[k] || k;
      const lines = (res.results || [])
        .map((r: any) => {
          const caps = [
            `${t('model.capImages')}:${r.supportsImages === null ? t('model.capUnknown') : r.supportsImages ? t('model.capYes') : t('model.capNo')}`,
            `${t('model.capTools')}:${r.supportsTools === null ? t('model.capUnknown') : r.supportsTools ? t('model.capYes') : t('model.capNo')}`,
            `${t('model.capJson')}:${r.supportsJson === null ? t('model.capUnknown') : r.supportsJson ? t('model.capYes') : t('model.capNo')}`,
          ];
          if (opts?.nsfw) {
            caps.push(
              `${t('model.capNsfw')}:${r.supportsNsfw === null ? t('model.capUnknown') : r.supportsNsfw ? t('model.capYes') : t('model.capNo')}`
            );
          }
          if (opts?.thinkLevel) {
            caps.push(
              `${t('model.capThinkLevel')}:${r.supportsThinkLevel === null ? t('model.capUnknown') : r.supportsThinkLevel ? t('model.capYes') : t('model.capNo')}`
            );
          }
          // 未判定项明细（v2.3.38）：明确区分「未判定」与「判定为不支持」
          const undet = Array.isArray(r.undetected) && r.undetected.length
            ? `（${t('model.capUnknownAt', { items: r.undetected.map(undetLabel).join('、') })}）`
            : '';
          return `· ${r.name}（${caps.join(' ')}）${undet}`;
        })
        .join('\n');
      showToast(`${t('settings.detectAllDone', { count: (res.results || []).length })}\n${lines}`);
    } catch (e: any) {
      showToast(t('settings.detectAllFail', { msg: e?.message || String(e) }), { error: true });
    } finally {
      setDetectingAll(false);
    }
  };

  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<ModelConfig | undefined>(undefined);
  // 模型能力筛选：选中的能力键集合（视觉/工具/JSON/推理/NSFW），空集合=不过滤
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set());
  // 分组 / 标签筛选：各自内部 OR；与能力筛选 AND；「未分组」为虚拟分组项
  const [groupFilter, setGroupFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  // 探测项选择弹窗（一键检测全部前让用户勾选，NSFW 默认不勾）
  const [detectOptsOpen, setDetectOptsOpen] = useState(false);
  const [detectOpts, setDetectOpts] = useState<{ images: boolean; tools: boolean; json: boolean; nsfw: boolean; thinkLevel: boolean }>({
    images: true,
    tools: true,
    json: true,
    nsfw: false,
    thinkLevel: true,
  });

  // ===== 调试模式（v2.3.19）：快照/恢复 + 手动触发 + 错误报告 =====
  const [debugSession, setDebugSession] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugChat, setDebugChat] = useState('');
  const [debugReport, setDebugReport] = useState<Record<string, { time: string; message: string }[]> | null>(null);
  const runDebugTrigger = async (kind: string) => {
    if (!debugChat) {
      showToast(t('settings.debugPickChatFirst'), { error: true });
      return;
    }
    const [ct, cid] = debugChat.split(':');
    setDebugBusy(true);
    try {
      const r = await api.debugTrigger(kind, ct, cid);
      showToast(r.ok ? r.message || t('settings.debugTrigDone') : r.error || t('settings.debugTrigFail'), { error: !r.ok });
    } catch (e: any) {
      showToast(e?.message || String(e), { error: true });
    } finally {
      setDebugBusy(false);
    }
  };
  const endDebug = async () => {
    setDebugBusy(true);
    try {
      const r = await api.debugEnd();
      if (r.ok) {
        setDebugSession(false);
        setDebugReport(r.report || {});
        showToast(t('settings.debugEndedToast'));
      } else {
        showToast(r.error || t('settings.debugTrigFail'), { error: true });
      }
    } catch (e: any) {
      showToast(e?.message || String(e), { error: true });
    } finally {
      setDebugBusy(false);
    }
  };

  // 全部模型用到的标签（去重），用于标签筛选胶囊与编辑器联想
  const allTags = Array.from(
    new Set((draft?.models || []).flatMap((m) => (Array.isArray(m.tags) ? m.tags : [])))
  ).sort();
  const modelGroups = draft?.modelGroups || [];

  const toggleSet =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (key: string) =>
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });

  const filteredModels = (() => {
    const all = draft?.models || [];
    return all.filter((m) => {
      // 能力维度（AND）
      if (modelFilter.has('vision') && !m.supportsImages) return false;
      if (modelFilter.has('tools') && !m.supportsTools) return false;
      if (modelFilter.has('json') && !m.supportsJson) return false;
      if (modelFilter.has('reasoning') && !m.supportsReasoning) return false;
      if (modelFilter.has('nsfw') && !m.supportsNsfw) return false;
      // 分组维度（内部 OR）：选中「未分组」= 无 groupIds；选中具体分组=命中其一
      if (groupFilter.size > 0) {
        const gids = m.groupIds || [];
        const ungrouped = groupFilter.has('__ungrouped__');
        const hitGroup = Array.from(groupFilter).some((g) => g !== '__ungrouped__' && gids.includes(g));
        if (ungrouped && gids.length === 0) {
          // 命中未分组项，允许
        } else if (hitGroup) {
          // 命中具体分组，允许
        } else {
          return false;
        }
      }
      // 标签维度（内部 OR）
      if (tagFilter.size > 0) {
        const tags = m.tags || [];
        if (!Array.from(tagFilter).some((t) => tags.includes(t))) return false;
      }
      return true;
    });
  })();
  const [chatList, setChatList] = useState<ChatListItem[]>([]);
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  // ===== MCP 服务器管理（sec-mcp）=====
  const [mcpStatusList, setMcpStatusList] = useState<any[]>([]);
  const [mcpDraft, setMcpDraft] = useState<{ key: string; command: string; args: string }>({ key: '', command: '', args: '' });
  const refreshMcpStatus = async () => {
    try {
      setMcpStatusList(await api.mcpStatus());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (sub === 'models') void refreshMcpStatus();
  }, [sub]);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  // 应用数据保存路径（实时数据，非备份）
  const [dataPathInfo, setDataPathInfo] = useState<{ current: string; custom: string | null; def: string }>({
    current: '',
    custom: null,
    def: '',
  });
  const [dataPathBusy, setDataPathBusy] = useState(false);
  // 错误日志
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [errorLog, setErrorLog] = useState<ErrorLogEntry[]>([]);
  useEffect(() => {
    api.getDataPath().then(setDataPathInfo).catch(() => {});
  }, []);
  useEffect(() => {
    api.listWorldBooks().then(setWorldBooks).catch(() => {});
  }, []);

  // 已导入插件列表（声明式，受控 HTTP，兼容外部常见格式）
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const refreshPlugins = React.useCallback(() => {
    api.listPlugins().then(setPlugins).catch(() => {});
  }, []);
  useEffect(() => {
    refreshPlugins();
  }, [refreshPlugins]);

  // ===== v2.3.92 技能（Skill）=====
  // 独立 IPC（skill:*），数据落在主进程 userData/skills.json，不进 settings、不污染聊天主数据。
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillScopeFilter, setSkillScopeFilter] = useState<'all' | SkillScope>('all');
  // v2.3.93：已被用户删除、但仍可一键恢复的内置技能
  const [dismissedBuiltins, setDismissedBuiltins] = useState<{ id: string; name: string; description: string }[]>([]);
  const refreshSkills = React.useCallback(() => {
    api.listSkills().then(setSkills).catch(() => {});
    api.listDismissedBuiltins().then(setDismissedBuiltins).catch(() => {});
  }, []);
  useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);
  const visibleSkills =
    skillScopeFilter === 'all' ? skills : skills.filter((s) => s.scope === skillScopeFilter);
  /** 导入技能：只接受系统对话框里用户亲自选中的文件，主进程不接受任意路径 */
  const importSkillFile = async () => {
    try {
      const picked = await api.pickTextFile([{ name: 'SKILL.md', extensions: ['md', 'markdown', 'txt'] }]);
      if (!picked) return;
      const fileName = picked.path.split(/[\\/]/).pop() || 'SKILL.md';
      const res = await api.importSkill(picked.content, fileName);
      if (!res.ok) {
        showToast(`${t('skill.importFailed')}: ${t(`skill.${res.error || 'errNoFrontmatter'}`)}`, {
          error: true,
        });
        return;
      }
      refreshSkills();
      if ((res.warnings || []).includes('script')) showToast(t('skill.warnScript'), { error: true });
      else if ((res.warnings || []).includes('truncated')) showToast(t('skill.warnTruncated'));
      else showToast(t('skill.imported'));
    } catch (e: any) {
      showToast(e?.message || String(e), { error: true });
    }
  };

  /** 恢复内置技能为随念语附带的版本（v2.3.93） */
  const restoreBuiltin = async (id: string, name: string) => {
    const confirmed = await api.showConfirm!(
      t('skill.restoreConfirm', { name }),
      t('skill.title')
    );
    if (!confirmed) return;
    const res = await api.restoreBuiltinSkill(id);
    if (!res.ok) {
      showToast(t('skill.restoreFailed'), { error: true });
      return;
    }
    refreshSkills();
    showToast(t('skill.restored'));
  };

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  useEffect(() => {
    api.getChatList().then((list) => {
      // 过滤观察者私密小窗（obs: 前缀），它们不参与按聊天设置
      setChatList(list.filter((c) => !c.chat_id.startsWith('obs:')));
    });
  }, []);

  // TTS 可选音色列表（供「默认音色」下拉用；需求 8 起人物音色改在角色卡里绑定）
  const [voiceOptions, setVoiceOptions] = useState<string[]>([]);

  // ===== 设置搜索框（百度建议式候选） =====
  const [searchQ, setSearchQ] = useState('');
  const [showSuggest, setShowSuggest] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  // ===== 模型管理页（独立二级菜单）搜索：模糊搜索模型配置，点击结果跳转并高亮闪动 3 秒 =====
  const [modelSearchQ, setModelSearchQ] = useState('');
  const [modelSuggestOpen, setModelSuggestOpen] = useState(false);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);
  // ===== 软件更新（v2.3.45）：状态来自主进程 updater（订阅 update:status 广播）=====
  const [updateSt, setUpdateSt] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  useEffect(() => {
    void api.updateStatus().then(setUpdateSt).catch(() => {});
    const off = api.onUpdateStatus((_e, data) => setUpdateSt(data));
    return off;
  }, []);
  // 搜索索引：基础为静态分区/分类（含中英文关键词），再于挂载后运行时补全所有
  // 具体控件（勾选框 / 滑块 / 下拉 / 各分区标题），保证「所有设置项」均可被搜到并跳转。
  const [searchIndex, setSearchIndex] = useState<SettingSearchItem[]>(SETTING_SEARCH_INDEX);
  const draftReady = !!draft;
  // 按场景（主设置页 / 模型管理二级页）分别缓存动态索引条目。
  // 为什么缓存而不是每次覆盖：设置搜索框**只渲染在主设置页**，而 TTS / ASR / 生图 / 生视频
  // 的控件现在住在模型管理二级页 —— 若二级页的条目一离开就被丢弃，用户在主页面永远搜不到它们。
  // 缓存后，主页面搜索能命中二级页条目（带 sub='models'），点击即自动切页并高亮。
  // 条目 id 由标签文本散列而来（见 stableId），跨场景稳定，重复项按 id 去重。
  const dynIndexCache = useRef<Record<string, SettingSearchItem[]>>({});
  React.useEffect(() => {
    const root = panelRef.current;
    if (!root || !draftReady) return;
    // v2.3.94 需求 7：模型管理二级页（onlyModels）同样要建索引 —— 旧代码 `|| onlyModels`
    // 直接早退，导致移进去的这些控件一个都搜不到。该场景产出的条目打上 sub='models'。
    const sceneSub: SettingSearchItem['sub'] = onlyModels ? 'models' : undefined;
    const dyn: SettingSearchItem[] = [];
    const seen = new Set<string>();
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    // 稳定 id：按「标签文本」散列，而非遍历序号。
    // 旧实现用 `${prefix}-${seen.size}`，序号会随前面控件的增删整体错位 ——
    // 用户先前搜过一次记下了 id，之后设置项一变动，跳转就落到别的控件上（用户反馈过的 bug）。
    const stableId = (prefix: string, label: string) => {
      let h = 5381;
      for (let i = 0; i < label.length; i++) h = ((h << 5) + h + label.charCodeAt(i)) >>> 0;
      return `${prefix}-${h.toString(36)}`;
    };
    // 取「设置名」：优先直接 label → .field 内 label → 父容器内首个 fontSize:13 标题 div → 父容器文本
    const nameOf = (el: HTMLElement): string => {
      const lbl = el.closest('label');
      if (lbl) {
        const t = clean(lbl.textContent || '');
        if (t) return t;
      }
      const field = el.closest('.field');
      if (field) {
        const fl = field.querySelector('label');
        if (fl) {
          const t = clean(fl.textContent || '');
          if (t) return t;
        }
      }
      const p = el.parentElement;
      if (p) {
        const titleDiv = Array.from(p.querySelectorAll('div')).find((d) =>
          /font-size:\s*13px/i.test(d.getAttribute('style') || '')
        );
        if (titleDiv) {
          const t = clean(titleDiv.textContent || '');
          if (t) return t;
        }
        const t = clean(p.textContent || '');
        if (t) return t;
      }
      return '';
    };
    const add = (el: HTMLElement, prefix: string) => {
      const label = nameOf(el);
      const norm = label.toLowerCase();
      if (!label || seen.has(norm)) return;
      seen.add(norm);
      const id = stableId(prefix, norm);
      el.id = id;
      dyn.push({ id, key: label, kw: [], sub: sceneSub });
    };
    // 1) 所有勾选框（兼容 label 包裹与 div 包裹两种写法）
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el) => {
      add((el.closest('label') as HTMLElement) || (el.parentElement as HTMLElement) || el, 'set-chk');
    });
    // 2) 所有滑块
    root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((el) => {
      add((el.closest('div') as HTMLElement) || (el.parentElement as HTMLElement) || el, 'set-rng');
    });
    // 3) 下拉 / 文本框 / 文本域（排除搜索框）
    root
      .querySelectorAll<HTMLElement>(
        'select, input:not([type="checkbox"]):not([type="range"]):not([type="search"]), textarea'
      )
      .forEach((el) => {
        add(
          (el.closest('.field') as HTMLElement) ||
            (el.closest('label') as HTMLElement) ||
            (el.parentElement as HTMLElement) ||
            el,
          'set-ctl'
        );
      });
    // 4) 分段选项组（btn-primary / btn-ghost 按钮组）：取其上方设置名 div
    const grpSeen = new Set<HTMLElement>();
    root
      .querySelectorAll<HTMLButtonElement>('button.btn-primary, button.btn-ghost')
      .forEach((btn) => {
        let block: HTMLElement | null = btn;
        while (block && block !== root) {
          const prev = block.previousElementSibling as HTMLElement | null;
          if (prev && /font-size:\s*13px/i.test(prev.getAttribute?.('style') || '')) {
            if (!grpSeen.has(prev)) {
              grpSeen.add(prev);
              add(prev, 'set-grp');
            }
            return;
          }
          block = block.parentElement;
        }
      });
    // 合并两个场景的缓存条目（按 id 去重，二级页优先 —— 它的条目带 sub，跳转更可靠）
    const scene = onlyModels ? 'models' : 'main';
    dynIndexCache.current[scene] = dyn;
    const merged: SettingSearchItem[] = [];
    const usedIds = new Set<string>();
    for (const list of [dynIndexCache.current.models || [], dynIndexCache.current.main || []]) {
      for (const item of list) {
        if (usedIds.has(item.id)) continue;
        usedIds.add(item.id);
        merged.push(item);
      }
    }
    setSearchIndex([...SETTING_SEARCH_INDEX, ...merged]);
  }, [lang, draftReady, onlyModels]);
  // 需求 12：设置搜索改走 fuzzySearch（模糊匹配 + 相关度排序），最多 5 个候选。
  // 旧实现是自研的 startsWith/includes 打分，只能做「前缀/包含」匹配，
  // 搜「语音」找不到「朗读与语音」、搜「ms」找不到「Mini」，与全局搜索规范不一致。
  const searchHit = useMemo(
    () =>
      searchQ.trim()
        ? suggestWithCount(searchQ, searchIndex, (item) => ({ label: t(item.key), keywords: item.kw }), MAX_SUGGESTIONS)
        : { items: [] as SettingSearchItem[], total: 0 },
    [searchQ, lang, searchIndex]
  );
  const searchResults = searchHit.items;

  // 按关键字（多词）高亮标题
  const renderSearchHL = (label: string, q: string): React.ReactNode => {
    const tokens = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return label;
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'gi');
    return label.split(re).map((part, i) =>
      tokens.includes(part.toLowerCase()) ? (
        <mark key={i} className="search-hl">{part}</mark>
      ) : (
        <span key={i}>{part}</span>
      )
    );
  };
  const goToSetting = (id: string, sub?: SettingSearchItem['sub']) => {
    // 滚动 + 高亮闪动。目标可能尚未挂载（刚切二级页），故交由 retry 轮询兜底。
    const jump = () => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('setting-flash');
      void el.offsetWidth; // 触发重排以重启动画
      el.classList.add('setting-flash');
      window.setTimeout(() => el.classList.remove('setting-flash'), 5000);
      return true;
    };
    if (id === 'cat-models' || sub) {
      // 目标在二级页（模型管理/字体/角色卡）：先切入，等渲染后再滚动高亮。
      // v2.3.94：旧实现用 setTimeout(jump, 150) 硬猜渲染时机 —— 慢机器/配置多时
      // 150ms 不足以让新页挂载，表现为「点了没反应」。改为「先试一次，不中就按帧重试」，
      // 上限 ~600ms；到点仍找不到（分类入口等本就没有该锚点）则安静收手。
      setSub(sub || 'models');
      if (!jump()) {
        let tries = 0;
        const retry = () => {
          if (jump()) return;
          if (++tries >= 30) return; // 约 600ms（20ms/次）后放弃
          window.setTimeout(retry, 20);
        };
        window.setTimeout(retry, 20);
      }
    } else {
      jump();
    }
    setShowSuggest(false);
    setSearchQ('');
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 人物音色绑定已迁移到角色卡编辑器，这里只需为「默认音色」下拉拉一次全局音色列表。
      try {
        const voices = await api.listVoices();
        if (!cancelled) setVoiceOptions(voices || []);
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 模型名拉取相关 state：必须置于「加载中」提前 return 之前，否则 draft 由 null 变为有值时的
  // 二次渲染会多调用 hook，触发 Rules of Hooks 崩溃（生产环境表现为 Minified React error #301）
  const [asrModelList, setAsrModelList] = useState<string[]>([]);
  const [ttsModelList, setTtsModelList] = useState<string[]>([]);
  const [imgModelList, setImgModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState<{ asr?: boolean; tts?: boolean; img?: boolean }>({});

  if (!draft) return <div className="panel">{t('common.loading')}</div>;

  const loc = localeOf(lang);
  const providerLabel = (p: string) =>
    PROVIDER_DEFAULTS[p as keyof typeof PROVIDER_DEFAULTS]?.label || p;

  // ===== 模型管理页搜索：匹配 名称 / 模型 ID / 提供方 / 标签 / 分组名 / BaseURL =====
  // 需求 12：走 fuzzySearch 统一规范（模糊 + 相关度排序 + 最多 5 个候选）。
  // 名称作主文本（决定档位与排序），其余字段作 keywords（同档排序时降权）。
  const modelSearchResults = (() => {
    if (!modelSearchQ.trim()) return [] as typeof draft.models;
    const groups = draft?.modelGroups || [];
    return suggest(modelSearchQ, draft?.models || [], (m) => ({
      label: m.name,
      keywords: [
        m.model,
        providerLabel(m.provider),
        ...(m.tags || []),
        ...(m.groupIds || []).map((gid) => groups.find((g) => g.id === gid)?.name || '').filter(Boolean),
        m.baseUrl || '',
      ].filter(Boolean),
    }), MAX_SUGGESTIONS);
  })();
  // 点击搜索结果：滚动到对应模型卡片并高亮闪动约 3 秒（3 次 1s 脉冲动画）
  const goToModel = (id: string) => {
    setModelSearchQ('');
    const el = document.getElementById(`model-card-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('model-flash');
      void el.offsetWidth; // 触发重排以重启动画
      el.classList.add('model-flash');
      window.setTimeout(() => el.classList.remove('model-flash'), 3200);
    }
  };

  // 所有改动即时落盘并广播到其他窗口，与全页一致；不再依赖底部「保存」按钮
  const patch = (p: Partial<AppSettings>) => {
    setDraft((d) => ({ ...(d as AppSettings), ...p }));
    api.saveSettings(p).then(reloadSettings);
  };

  // ===== 高级动画控制：三档（全开 / 全关 / 自定义，v2.3.92）=====
  // 三档互斥，档位真源是 `draft.animMode`；旧的 enableAnimations / animControlMode
  // 在每次 patch 时一并同步写入，纯粹为了兼容旧版回滚与其它仍读旧字段的代码。
  // 只有「自定义」档才需要逐组开关 —— 其余两档下分组开关本就不起作用，直接整块隐藏。
  const animMode: AnimMode = getAnimMode(draft);
  const animCustom = animMode === 'custom';
  const setAnimMode = (mode: AnimMode) => {
    patch({
      animMode: mode,
      // 兼容字段同步：all-off ⇔ enableAnimations=false；custom ⇔ animControlMode='single'
      enableAnimations: mode !== 'all-off',
      animControlMode: mode === 'custom' ? 'single' : 'master',
    });
  };
  const toggleAnimGroup = (groupId: string) => {
    const cur = draft?.animGroups?.[groupId] !== false;
    patch({
      animMode: 'custom',
      animControlMode: 'single',
      animGroups: { ...(draft?.animGroups || {}), [groupId]: !cur },
    });
  };
  // 供三档选择器下方的说明文字使用（纯展示，不参与门控）
  const animModeHintKey: 'animCtl.modeAllOnHint' | 'animCtl.modeAllOffHint' | 'animCtl.modeCustomHint' =
    animMode === 'all-on'
      ? 'animCtl.modeAllOnHint'
      : animMode === 'all-off'
        ? 'animCtl.modeAllOffHint'
        : 'animCtl.modeCustomHint';

  // ===== 记忆提示词（v2.3.36）：本地草稿 + 失焦落盘 =====
  // textarea 不逐字符即时保存（避免长文本输入时频繁写盘/重载导致卡顿与光标跳动），失焦时一次性 patch。
  // 清空保护：失焦时若为纯空白，自动填回出厂默认并提示，保证运行时两提示词恒非空。
  const [summarizePromptLocal, setSummarizePromptLocal] = useState('');
  const [injectPromptLocal, setInjectPromptLocal] = useState('');
  useEffect(() => {
    setSummarizePromptLocal(draft?.memorySummarizePrompt ?? '');
  }, [draft?.memorySummarizePrompt]);
  useEffect(() => {
    setInjectPromptLocal(draft?.memoryInjectPrompt ?? '');
  }, [draft?.memoryInjectPrompt]);
  const saveMemoryPrompt = (key: 'memorySummarizePrompt' | 'memoryInjectPrompt', value: string) => {
    const empty = !value.trim();
    const filled = empty
      ? (key === 'memorySummarizePrompt' ? DEFAULT_MEMORY_SUMMARIZE_PROMPT : DEFAULT_MEMORY_INJECT_PROMPT)
      : value;
    if (key === 'memorySummarizePrompt') setSummarizePromptLocal(filled);
    else setInjectPromptLocal(filled);
    if (empty) showToast(t('settings.memoryPromptsResetToDefault'), { duration: 2500 });
    patch({ [key]: filled } as Partial<AppSettings>);
  };
  // 随机触发范围保存：钳制 1~86400 秒（1 秒 ~ 24 小时，边界为硬编码），并保证 min <= max
  const saveRandomRange = (rawMin: number, rawMax: number) => {
    const clamp = (v: number) => Math.max(1, Math.min(86400, Math.round(v)));
    let min = clamp(rawMin);
    let max = clamp(rawMax);
    if (min > max) { const t = min; min = max; max = t; }
    patch({ idleRandomMinSec: min, idleRandomMaxSec: max });
  };
  const voice = { ...DEFAULT_SETTINGS.voice, ...(draft.voice || {}) };
  const imageGen = { ...DEFAULT_SETTINGS.imageGen, ...(draft.imageGen || {}) } as ImageGenSettings;
  const mini = { ...DEFAULT_SETTINGS.miniWindow, ...(draft.miniWindow || {}) };
  const sound = { ...DEFAULT_SETTINGS.sound, ...(draft.sound || {}) };
  const cursor = { ...DEFAULT_SETTINGS.customCursor, ...(draft.customCursor || {}) };
  const floating =
    draft.floatingBall || { enabled: true, x: 0, y: 0, alwaysOnTop: true, autoHideInFullscreen: true };
  // 语音 / 生图 / 小窗 此前只改本地 draft，必须点底部「保存」才生效，与其他即时保存的开关不一致，
  // 容易让用户误以为设置没生效。改为与全页一致：改动即时落盘并触发 reloadSettings。
  const patchVoice = (p: Partial<typeof voice>) => {
    const next = { ...voice, ...p };
    patch({ voice: next });
    api.saveSettings({ voice: next }).then(reloadSettings);
  };
  const patchImageGen = (p: Partial<typeof imageGen>) => {
    const next = { ...imageGen, ...p } as ImageGenSettings;
    patch({ imageGen: next });
    api.saveSettings({ imageGen: next }).then(reloadSettings);
  };
  const videoGen = { ...DEFAULT_SETTINGS.videoGen, ...(draft.videoGen || {}) } as VideoGenSettings;
  const patchVideoGen = (p: Partial<typeof videoGen>) => {
    const next = { ...videoGen, ...p } as VideoGenSettings;
    patch({ videoGen: next });
    api.saveSettings({ videoGen: next }).then(reloadSettings);
  };
  // ===== v2.3.94 需求 7：四类服务的多API 配置写入器 =====
  // 统一口径：编辑器只吐 { configs, activeId }，这里负责落盘到各自的settings 子对象。
  // **不需要**在此处同步写扁平字段（ttsBaseUrl / baseUrl 等）—— 主进程每次 saveSettings
  // 都会调 syncActiveMediaConfigs() 把当前启用项回写扁平字段（见 electron/db.ts），
  // 后端调用点仍读扁平字段，故整条链路自动打通。
  const patchTtsConfigs = (next: { configs: MediaApiConfig[]; activeId: string }) =>
    patchVoice({ ttsConfigs: next.configs, activeTtsId: next.activeId });
  const patchAsrConfigs = (next: { configs: MediaApiConfig[]; activeId: string }) =>
    patchVoice({ asrConfigs: next.configs, activeAsrId: next.activeId });
  const patchImageConfigs = (next: { configs: MediaApiConfig[]; activeId: string }) =>
    patchImageGen({ imageConfigs: next.configs, activeImageId: next.activeId });
  const patchVideoConfigs = (next: { configs: MediaApiConfig[]; activeId: string }) =>
    patchVideoGen({ videoConfigs: next.configs, activeVideoId: next.activeId });

  // 四类服务当前要展示的多配置列表。
  // resolveMediaConfigs 负责「数组为空但扁平字段有值」的兜底（老配置迁移前 / 只填过扁平字段），
  // 避免用户看到空列表以为自己的配置丢了。
  const ttsConfigs = resolveMediaConfigs(
    voice.ttsConfigs,
    { provider: 'openai-compatible', baseUrl: voice.ttsBaseUrl, apiKey: voice.ttsApiKey, model: voice.ttsModel, voice: voice.ttsVoice },
    voice.activeTtsId
  );
  const asrConfigs = resolveMediaConfigs(
    voice.asrConfigs,
    { provider: 'custom', baseUrl: voice.asrBaseUrl, apiKey: voice.asrApiKey, model: voice.asrModel },
    voice.activeAsrId
  );
  const imageConfigs = resolveMediaConfigs(
    imageGen.imageConfigs,
    { provider: 'custom', baseUrl: imageGen.baseUrl, apiKey: imageGen.apiKey, model: imageGen.model, size: imageGen.size },
    imageGen.activeImageId
  );
  const videoConfigs = resolveMediaConfigs(
    videoGen.videoConfigs,
    {
      provider: 'custom',
      baseUrl: videoGen.baseUrl,
      apiKey: videoGen.apiKey,
      model: videoGen.model,
      size: videoGen.size,
      duration: Number(videoGen.duration) || undefined,
    },
    videoGen.activeVideoId
  );
  /** TTS 是否已具备可用端点（决定「自动播报」等开关是否可勾） */
  const activeTtsReady = !!(voice.ttsBaseUrl || '').trim();
  const patchMini = (p: Partial<typeof mini>) => {
    const next = { ...mini, ...p };
    patch({ miniWindow: next });
    api.saveSettings({ miniWindow: next }).then(reloadSettings);
  };
  const patchSound = (p: Partial<typeof sound>) => patch({ sound: { ...sound, ...p } });
  const patchCursor = (p: Partial<typeof cursor>) => patch({ customCursor: { ...cursor, ...p } });

  // 光标子设置必须落盘并触发 reloadSettings，否则 ThemeContext.settings 不会更新，
  // CustomCursor 读取不到变化（patch 只改本地 draft）。与 enabled 开关保持一致。
  const saveCursor = (p: Partial<typeof cursor>) =>
    api.saveSettings({ customCursor: { ...cursor, ...p } }).then(reloadSettings);

  // 生图 / TTS / ASR 模型名拉取：复用 OpenAI 兼容 /models，按类型关键字过滤后填入 ComboBox 建议列表
  // （v2.3.39 起由原生 datalist 改为可滚动组合框），用户既能从下拉选也能手填。
  // 过滤为空时回退全部列表，避免第三方平台命名不标准时漏掉可用模型。
  const filterModelsByKind = (list: string[], kind: 'asr' | 'tts' | 'img'): string[] => {
    const test = (id: string) => {
      const s = id.toLowerCase();
      if (kind === 'asr') return /whisper|transcrib|audio/.test(s);
      if (kind === 'tts') return /tts|speech/.test(s);
      return /dall-e|image/.test(s);
    };
    const filtered = list.filter(test);
    return filtered.length ? filtered : list;
  };

  const refreshModelList = async (kind: 'asr' | 'tts' | 'img', baseUrl: string, apiKey: string) => {
    if (!baseUrl) {
      showToast(t('settings.baseUrlRequired'));
      return;
    }
    setModelLoading((p) => ({ ...p, [kind]: true }));
    try {
      const list = await api.listModels({ baseUrl, apiKey } as any);
      const filtered = filterModelsByKind(list, kind);
      if (kind === 'asr') setAsrModelList(filtered);
      else if (kind === 'tts') setTtsModelList(filtered);
      else setImgModelList(filtered);
      if (list.length === 0) showToast(t('model.listEmpty'));
      else showToast(t('model.refreshed', { count: filtered.length }));
    } catch (e: any) {
      showToast(t('model.listFail', { msg: e?.message || String(e) }));
    } finally {
      setModelLoading((p) => ({ ...p, [kind]: false }));
    }
  };


  // 自定义音效：选择本地 MP3/WAV 文件并保存
  const pickSound = async (type: SoundType) => {
    const src = await api.pickAudioFile();
    if (!src) return;
    const fname = await api.setCustomSound({ key: type, srcPath: src });
    if (!fname) {
      showToast(t('common.failed'));
      return;
    }
    const custom = { ...(sound.custom || { error: null, click: null, notification: null }), [type]: fname };
    patchSound({ custom });
    api.saveSettings({ sound: { ...sound, custom } }).then(reloadSettings);
    invalidateSoundCache();
  };
  const resetSound = (type: SoundType) => {
    const custom = { ...(sound.custom || { error: null, click: null, notification: null }), [type]: null };
    patchSound({ custom });
    api.saveSettings({ sound: { ...sound, custom } }).then(reloadSettings);
    invalidateSoundCache();
  };
  const previewSoundType = (type: SoundType) => {
    void previewSound(type);
  };

  // 一键恢复初始设置：弹出选择框，让用户决定保留或清空 API Key 与模型
  const doReset = async (keepKeys: boolean) => {
    setResetOpen(false);
    try {
      // 完全重置（keepKeys=false）时，先清除所有聊天/角色/群组等 store 数据，再重置设置
      if (!keepKeys) {
        await api.deleteAllData();
      }
      const s = await api.resetSettings(keepKeys);
      setDraft(s);
      await reloadSettings();
      // 若重置后的语言与当前不同，热更新界面语言
      if (s.lang !== lang) setLang(s.lang);
      showToast(t('settings.resetDone'));
    } catch (e: any) {
      showToast(t('settings.resetFailed', { err: e?.message || String(e) }), { error: true });
    }
  };

  const doDeleteAll = async () => {
    setDeleteAllOpen(false);
    try {
      await api.deleteAllData();
      await reloadSettings();
      window.location.reload();
    } catch (e: any) {
      showToast(t('settings.resetFailed', { err: e?.message || String(e) }), { error: true });
    }
  };


  const persistModels = (next: ModelConfig[]) => {
    if (draft) api.saveSettings({ ...draft, models: next }).then(reloadSettings);
  };

  const onModelSave = (cfg: ModelConfig) => {
    const cur = draft?.models || [];
    const exists = cur.find((m) => m.id === cfg.id);
    const next = exists ? cur.map((m) => (m.id === cfg.id ? cfg : m)) : [...cur, cfg];
    setDraft((d) => (d ? { ...d, models: next } : d));
    persistModels(next);
    setEditorOpen(false);
  };

  const onModelDelete = async (id: string) => {
    if (!(await api.showConfirm!(t('settings.confirmDeleteModel')))) return;
    const next = (draft?.models || []).filter((m) => m.id !== id);
    // 若删除的是默认模型，同时清空默认值；是识图模型则同步清除识图设置（v2.3.51）
    const nextDefault = draft?.defaultModel === id ? '' : draft?.defaultModel || '';
    const nextVision = draft?.visionModelId === id ? '' : draft?.visionModelId || '';
    setDraft((d) => (d ? { ...d, models: next, defaultModel: nextDefault, visionModelId: nextVision } : d));
    if (draft) api.saveSettings({ ...draft, models: next, defaultModel: nextDefault, visionModelId: nextVision }).then(reloadSettings);
    // 删除后归还焦点到聊天输入框，避免原生确认框关闭导致的输入框锁死
    window.dispatchEvent(new CustomEvent('nianyu:restore-focus'));
  };

  // 复制模型配置：克隆全部字段，生成新 ID 并加「副本」后缀
  const onModelCopy = (m: ModelConfig) => {
    const copy: ModelConfig = {
      ...m,
      id: crypto.randomUUID(),
      name: `${m.name}${t('contacts.copySuffix')}`,
    };
    const next = [...(draft?.models || []), copy];
    setDraft((d) => (d ? { ...d, models: next } : d));
    persistModels(next);
  };

  // ===== 模型分组管理（全局实体，可被多模型引用）=====
  const addGroup = () => {
    const groups = draft?.modelGroups || [];
    if (groups.length >= MODEL_GROUP_MAX) {
      showToast(t('settings.groupLimitReached', { n: MODEL_GROUP_MAX }), { error: true });
      return;
    }
    // 名称去重：从「分组 1」递增，跳过已存在的同名项
    let idx = 1;
    let name = `分组 ${idx}`;
    while (groups.some((g) => g.name === name)) {
      idx += 1;
      name = `分组 ${idx}`;
    }
    const color = MODEL_GROUP_COLORS[groups.length % MODEL_GROUP_COLORS.length];
    const next = [...groups, { id: crypto.randomUUID(), name, color }];
    patch({ modelGroups: next });
  };
  const renameGroup = (id: string, rawName: string) => {
    const name = rawName.trim();
    if (!name) {
      showToast(t('settings.groupNameEmpty'), { error: true });
      return;
    }
    if (name.length > MODEL_GROUP_NAME_MAX) {
      showToast(t('settings.groupNameTooLong', { n: MODEL_GROUP_NAME_MAX }), { error: true });
      return;
    }
    const groups = draft?.modelGroups || [];
    if (groups.some((g) => g.id !== id && g.name === name)) {
      showToast(t('settings.groupNameExists'), { error: true });
      return;
    }
    patch({ modelGroups: groups.map((g) => (g.id === id ? { ...g, name } : g)) });
  };
  const recolorGroup = (id: string, color: string) => {
    const groups = draft?.modelGroups || [];
    patch({ modelGroups: groups.map((g) => (g.id === id ? { ...g, color } : g)) });
  };
  const deleteGroup = async (id: string) => {
    const groups = draft?.modelGroups || [];
    const target = groups.find((g) => g.id === id);
    if (!target) return;
    if (!(await api.showConfirm!(t('settings.groupDeleteConfirm', { name: target.name })))) return;
    const nextGroups = groups.filter((g) => g.id !== id);
    // 孤儿清理：从所有模型的 groupIds 中移除该分组 id
    const nextModels = (draft?.models || []).map((m) =>
      (m.groupIds || []).includes(id) ? { ...m, groupIds: (m.groupIds || []).filter((x) => x !== id) } : m
    );
    setDraft((d) => (d ? { ...d, modelGroups: nextGroups, models: nextModels } : d));
    if (draft) api.saveSettings({ ...draft, modelGroups: nextGroups, models: nextModels }).then(reloadSettings);
    window.dispatchEvent(new CustomEvent('nianyu:restore-focus'));
  };

  const toggleDefault = (id: string) => {
    const nextDefault = draft?.defaultModel === id ? '' : id;
    setDraft((d) => (d ? { ...d, defaultModel: nextDefault } : d));
    if (draft) api.saveSettings({ ...draft, defaultModel: nextDefault }).then(reloadSettings);
    showToast(t('settings.defaultSet'));
  };

  const backup = async () => {
    setBusy(true);
    setStatus(t('settings.backupPick'));
    const dest = await api.pickBackupTarget();
    if (!dest) {
      setBusy(false);
      setStatus('');
      return;
    }
    // v2.3.33：主进程防覆盖后可能改名，状态栏显示实际写入路径
    const actual = (await api.createBackup(dest)) || dest;
    await reloadSettings();
    setBusy(false);
    setStatus(t('settings.backupDone', { dest: actual }));
  };

  const restore = async () => {
    setBusy(true);
    setStatus(t('settings.restorePick'));
    const zip = await api.pickRestoreFile();
    if (!zip) {
      setBusy(false);
      setStatus('');
      return;
    }
    // v2.3.48：高版本备份恢复警告——先读备份包内版本清单，高于当前软件版本时先确认
    try {
      const bv = await api.peekBackupVersion(zip);
      const cur = updateSt?.currentVersion || (await api.updateStatus()).currentVersion;
      if (bv && cur && compareVersions(bv, cur) > 0) {
        const go = await api.showConfirm!(
          t('settings.backupVersionWarn', { backup: bv, current: cur }),
          t('settings.backupVersionWarnTitle')
        );
        if (!go) {
          setBusy(false);
          setStatus('');
          return;
        }
      }
    } catch {
      // 版本探测失败不阻断恢复流程（旧备份无清单属正常情况）
    }
    if (!(await api.showConfirm!(t('settings.confirmRestore')))) {
      setBusy(false);
      setStatus('');
      return;
    }
    try {
      await api.restoreBackup(zip);
      setStatus(t('settings.restoreDone'));
    } catch (e: any) {
      setBusy(false);
      setStatus(t('settings.restoreFailed', { err: e?.message || String(e) }));
    }
  };

  // 选择默认备份目录
  const chooseBackupDir = async () => {
    const dir = await api.pickBackupDir();
    if (!dir) return;
    patch({ backupDir: dir });
    await api.saveSettings({ backupDir: dir });
    await reloadSettings();
    setStatus(t('settings.backupDirSet', { dir }));
  };

  const clearBackupDir = async () => {
    patch({ backupDir: '' });
    await api.saveSettings({ backupDir: '' });
    await reloadSettings();
  };

  // ===== 我的角色卡（自我身份）=====
  const persistSelf = (p: { selfRoles: SelfRole[]; currentSelfRoleId: string }) => {
    if (draft) api.saveSettings({ ...draft, selfRoles: p.selfRoles, currentSelfRoleId: p.currentSelfRoleId }).then(reloadSettings);
  };

  // 一键导出备份到默认目录
  const exportBackup = async () => {
    setBusy(true);
    try {
      const dest = await api.exportBackup();
      await reloadSettings();
      setStatus(t('settings.backupDone', { dest }));
    } catch (e: any) {
      setStatus(t('settings.exportFailed', { err: e?.message || String(e) }));
    } finally {
      setBusy(false);
    }
  };

  // 应用数据保存路径：选择自定义目录（主进程迁移数据后延迟重启以加载新目录）
  const pickDataPath = async () => {
    const dir = await api.pickDataDir();
    if (!dir) return;
    setDataPathBusy(true);
    try {
      const res = await api.setDataPath(dir);
      if (!res.ok) showToast(t('common.failed') + (res.error ? `: ${res.error}` : ''), { error: true });
      else api.getDataPath().then(setDataPathInfo).catch(() => {});
    } catch (e: any) {
      showToast(t('common.failed') + `: ${e?.message || String(e)}`, { error: true });
    } finally {
      setDataPathBusy(false);
    }
  };
  // 恢复默认数据目录（迁移回「文档/念语数据」后重启）
  const resetDataPath = async () => {
    setDataPathBusy(true);
    try {
      const res = await api.setDataPath('');
      if (!res.ok) showToast(t('common.failed') + (res.error ? `: ${res.error}` : ''), { error: true });
      else api.getDataPath().then(setDataPathInfo).catch(() => {});
    } catch (e: any) {
      showToast(t('common.failed') + `: ${e?.message || String(e)}`, { error: true });
    } finally {
      setDataPathBusy(false);
    }
  };
  // 打开错误日志面板
  const openErrorLog = async () => {
    try {
      const list = await api.getErrorLog();
      setErrorLog(list);
      setErrorLogOpen(true);
    } catch {
      /* 忽略 */
    }
  };
  const clearErrorLogAll = async () => {
    try {
      await api.clearErrorLog();
      setErrorLog([]);
      showToast(t('common.done'));
    } catch {
      /* 忽略 */
    }
  };
  const errorCategoryLabel = (c: 'functional' | 'model' | 'other'): string =>
    c === 'functional' ? t('settings.errorFunctional') : c === 'model' ? t('settings.errorModel') : t('settings.errorOther');

  return (
    <div className="main-pane">
      <div className="list-header">
        <span>
          {sub === 'font'
            ? t('settings.font')
            : sub === 'self'
              ? t('self.title')
              : onlyModels
                ? t('nav.models')
                : t('settings.title')}
        </span>
        {/* 二级页（字体/角色卡/模型管理）返回按钮：固定在页面名称正右边，不随内容滚动 */}
        {(sub === 'font' || sub === 'self' || onlyModels) && (
          <button
            type="button"
            className="btn-ghost"
            style={{ marginLeft: 10, flex: '0 0 auto', padding: '6px 12px', fontSize: 13, whiteSpace: 'nowrap' }}
            onClick={() => setSub('main')}
          >
            ← {t('settings.back')}
          </button>
        )}
        {!onlyModels && sub === 'main' && (
          <div className="settings-header-search">
            {/* 需求 12：候选面板换成 SearchSuggest（portal + 最多 5 行 + 滚动条 + 键盘导航） */}
            <div style={{ position: 'relative', width: 220 }}>
              <input
                ref={searchInputRef}
                type="text"
                className="settings-search-input"
                placeholder={t('settings.searchPlaceholder')}
                value={searchQ}
                aria-label={t('settings.searchPlaceholder')}
                onChange={(e) => {
                  setSearchQ(e.target.value);
                  setShowSuggest(true);
                }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => window.setTimeout(() => setShowSuggest(false), 150)}
              />
              <SearchSuggest
                open={showSuggest}
                query={searchQ}
                items={searchResults}
                max={MAX_SUGGESTIONS}
                anchorRef={searchInputRef}
                emptyHint={t('settings.searchEmpty')}
                itemKey={(r) => r.id}
                renderItem={(r, ctx) => renderSearchHL(t(r.key), ctx.query)}
                onPick={(r) => goToSetting(r.id, r.sub)}
                onClose={() => setShowSuggest(false)}
              />
            </div>
            <button
              type="button"
              className="btn-ghost"
              style={{ flex: '0 0 auto', padding: '8px 12px', fontSize: 13, whiteSpace: 'nowrap' }}
              onClick={() => setGuideOpen(true)}
            >
              {t('settings.openGuide')}
            </button>
          </div>
        )}
        {/* 模型管理独立页：模型配置搜索框 + 候选面板（点击跳转并高亮闪动 3 秒） */}
        {onlyModels && (
          <div className="settings-header-search" style={{ position: 'relative', flex: 1, marginLeft: 12, minWidth: 0 }}>
            <input
              ref={modelSearchInputRef}
              type="text"
              className="settings-search-input"
              style={{ width: '100%' }}
              placeholder={t('models.searchPh')}
              value={modelSearchQ}
              aria-label={t('models.searchPh')}
              onChange={(e) => setModelSearchQ(e.target.value)}
              onFocus={() => setModelSuggestOpen(true)}
              onBlur={() => window.setTimeout(() => setModelSuggestOpen(false), 150)}
            />
            <SearchSuggest
              open={modelSuggestOpen}
              query={modelSearchQ}
              items={modelSearchResults}
              max={MAX_SUGGESTIONS}
              anchorRef={modelSearchInputRef}
              emptyHint={t('models.searchEmpty')}
              itemKey={(m) => m.id}
              renderItem={(m, ctx) =>
                renderSearchHL(`${m.name} · ${providerLabel(m.provider)} · ${m.model}`, ctx.query)
              }
              onPick={(m) => goToModel(m.id)}
              onClose={() => setModelSuggestOpen(false)}
            />
          </div>
        )}
      </div>
      <div className="settings-layout">
        {sub === 'main' && !onlyModels && (
          <nav className="settings-nav">
            {SETTING_CATS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`settings-nav-item ${activeCat === c.id ? 'active' : ''}`}
                onClick={() => scrollToCat(c.id)}
              >
                {t(c.labelKey)}
              </button>
            ))}
          </nav>
        )}
        <div className="panel" style={{ overflowY: 'auto' }} ref={panelRef} onScroll={onPanelScroll}>
        {sub === 'self' ? (
          <SelfRoleSettings
            selfRoles={draft.selfRoles || []}
            currentSelfRoleId={draft.currentSelfRoleId || ''}
            onPersist={persistSelf}
          />
        ) : sub === 'font' ? (
          <FontSettings draft={draft} patch={patch} />
        ) : (
        <>
        {status && (
          <div style={{ marginBottom: 14, color: 'var(--color-primary)', fontSize: 13 }}>
            {status}
          </div>
        )}

        {/* ===== 语言 ===== */}
        {/* 模型管理独立页：只渲染 cat-models 分区，其余分区跳过 */}
        {!onlyModels && (<>
        <div id="cat-general" ref={(el) => { catRefs.current['cat-general'] = el; }} className="settings-category">
        <div id="sec-language" className="section-title">{t('settings.language')}</div>
        <div className="field" style={{ maxWidth: 240 }}>
          <SelectMenu
            value={lang}
            onChange={(v) => setLang(v as Lang)}
            options={LANGS.map((l) => ({ value: l.key, label: l.label }))}
          />
        </div>

        {/* ===== 界面动效（三档：全部开启 / 全部关闭 / 自定义，v2.3.92）===== */}
        <div id="sec-animations" className="section-title" style={{ marginTop: 16 }}>{t('settings.animations')}</div>
        {/* 旧版是一个勾选框式总开关（v2.3.90/91），用户反馈无法表达「关一部分但不是全关」，
            故改为三档单选：三档互斥、语义直白，且「自定义」档才展开分组开关。 */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          {ANIM_MODES.map((m) => (
            <label
              key={m}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                cursor: 'pointer',
                color: animMode === m ? 'var(--color-primary)' : undefined,
                fontWeight: animMode === m ? 600 : undefined,
              }}
            >
              <input type="radio" checked={animMode === m} onChange={() => setAnimMode(m)} />
              {t(
                m === 'all-on'
                  ? 'animCtl.modeAllOn'
                  : m === 'all-off'
                    ? 'animCtl.modeAllOff'
                    : 'animCtl.modeCustom'
              )}
            </label>
          ))}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--color-text-secondary)', maxWidth: 560, marginTop: 6 }}>
          {t(animModeHintKey)}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-secondary)', maxWidth: 560, marginTop: 6 }}>
          {t('animCtl.streamNote')}
        </div>

        {/* ===== 分组开关：仅「自定义」档渲染（全开/全关档下它们本就不起作用，展示即误导）===== */}
        {animCustom && (
          <>
            <div id="sec-anim-control" className="section-title" style={{ marginTop: 16 }}>
              {t('animCtl.title')}
            </div>
            <div
              style={{
                marginTop: 12,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                gap: '8px 16px',
              }}
            >
              {ANIM_GROUPS.map((g) => (
                <label
                  key={g.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={draft.animGroups?.[g.id] !== false}
                    onChange={() => toggleAnimGroup(g.id)}
                  />
                  <span>{t(g.labelKey)}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {/* ===== 软件更新（v2.3.45）：检查 GitHub Releases → 提醒 → 下载安装包 ===== */}
        <div id="sec-update" className="section-title" style={{ marginTop: 16 }}>{t('settings.updateTitle')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn-ghost"
            disabled={updateBusy || updateSt?.state === 'checking'}
            onClick={async () => {
              setUpdateBusy(true);
              try {
                const st = await api.checkUpdate(true);
                setUpdateSt(st);
                if (st.state === 'latest') showToast(t('settings.updateIsLatest', { v: st.currentVersion }));
                else if (st.state === 'available') showToast(t('settings.updateFound', { v: st.latestVersion || '' }));
                else if (st.state === 'error') showToast(st.message || t('settings.updateCheckFailed'), { error: true });
              } catch (e: any) {
                showToast(e?.message || t('settings.updateCheckFailed'), { error: true });
              } finally {
                setUpdateBusy(false);
              }
            }}
          >
            {updateSt?.state === 'checking' || updateBusy ? t('settings.updateChecking') : t('settings.updateCheck')}
          </button>
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            {t('settings.updateCurrent', { v: updateSt?.currentVersion || '' })}
          </span>
          {updateSt?.state === 'latest' && (
            <span style={{ fontSize: 13, color: 'var(--color-success)' }}>{t('settings.updateIsLatestShort')}</span>
          )}
          {updateSt?.state === 'error' && updateSt.message && (
            <span style={{ fontSize: 13, color: 'var(--color-danger)' }}>{updateSt.message}</span>
          )}
        </div>

        {updateSt?.state === 'available' && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--color-primary)' }}>
              {t('settings.updateAvailable', { v: updateSt.latestVersion || '' })}
            </span>
            <button className="btn-primary" onClick={async () => { setUpdateBusy(true); try { setUpdateSt(await api.downloadUpdate()); } finally { setUpdateBusy(false); } }}>
              {t('settings.updateDownload')}
            </button>
            <button className="btn-ghost" onClick={() => { void api.openReleasePage(); }}>
              {t('settings.updateOpenRelease')}
            </button>
          </div>
        )}

        {updateSt?.state === 'downloading' || updateSt?.state === 'verifying' ? (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--color-hover)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${updateSt.percent ?? 0}%`,
                  height: '100%',
                  background: 'var(--color-primary)',
                  transition: animOn ? 'width 0.2s linear' : 'none',
                }}
              />
            </div>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
              {t('settings.updateDownloading', {
                p: String(updateSt.percent ?? 0),
                mb: ((updateSt.received || 0) / 1048576).toFixed(1),
              })}
            </span>
          </div>
        ) : null}

        {updateSt?.state === 'downloaded' && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--color-success)' }}>{t('settings.updateDownloaded')}</span>
            <button className="btn-ghost" onClick={() => { void api.openUpdateFolder(); }}>
              {t('settings.updateOpenFolder')}
            </button>
            <button className="btn-primary" onClick={() => { void api.installUpdate(); }}>
              {t('settings.updateInstall')}
            </button>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 10 }}>
          <input
            type="checkbox"
            checked={draft.autoCheckUpdate !== false}
            onChange={(e) => patch({ autoCheckUpdate: e.target.checked })}
          />
          <span>{t('settings.updateAutoCheck')}<Hint text={t('settings.updateAutoCheckDesc')} /></span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={draft.autoDownloadUpdate === true}
            onChange={(e) => patch({ autoDownloadUpdate: e.target.checked })}
          />
          <span>{t('settings.updateAutoDownload')}<Hint text={t('settings.updateAutoDownloadDesc')} /></span>
        </label>
        {/* v2.3.48：永久关闭更新提醒（弹窗 + 聊天界面提示条都不再出现；手动检查不受影响） */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={draft.disableUpdateReminder === true}
            onChange={(e) => patch({ disableUpdateReminder: e.target.checked })}
          />
          <span>{t('settings.updateDisableReminder')}<Hint text={t('settings.updateDisableReminderDesc')} /></span>
        </label>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
          {t('settings.updateNotesHint', { v: updateSt?.currentVersion || '' })}
        </div>


          {/* ===== 我的角色卡（自我身份） ===== */}
          <div id="sec-self" className="section-title" style={{ marginTop: 16 }}>{t('self.title')}</div>
          <div
            className="theme-card"
            style={{ cursor: 'pointer', maxWidth: 420 }}
            onClick={() => setSub('self')}
          >
            <div
              className="theme-swatch"
              style={{ background: 'linear-gradient(135deg,#ff8fb1,#42b4e8)' }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>{t('self.manage')}<Hint text={t('self.enter')} /></div>
            </div>
          </div>

          {/* ===== 模型管理（子页面入口，类似字体 / 角色卡） ===== */}
          <div id="sec-models" className="section-title" style={{ marginTop: 16 }}>{t('settings.modelManage')}</div>
          <div
            className="theme-card"
            style={{ cursor: 'pointer', maxWidth: 420 }}
            onClick={() => setSub('models')}
          >
            <div
              className="theme-swatch"
              style={{ background: 'linear-gradient(135deg,#6a3aa8,#a1429c)' }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>{t('settings.modelManage')}<Hint text={t('settings.modelManageEnter')} /></div>
            </div>
          </div>

          {/* ===== 开机自启动 ===== */}
          <div id="sec-launch" className="section-title" style={{ marginTop: 16 }}>{t('settings.launchOnBoot')}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!draft.launchOnBoot}
              onChange={(e) => patch({ launchOnBoot: e.target.checked })}
            />
            <span>{t('settings.launchOnBoot')}<Hint text={t('settings.launchOnBootDesc')} /></span>
          </label>

          {/* ===== 调试模式（v2.3.19）：数据快照保护 + 手动触发 + 错误报告 ===== */}
          <div id="sec-debug" className="section-title" style={{ marginTop: 16 }}>{t('settings.debugMode')}<Hint text={t('settings.debugModeDesc')} /></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!debugSession ? (
              <button
                className="btn-primary"
                style={{ padding: '4px 12px', fontSize: 12 }}
                disabled={debugBusy}
                onClick={async () => {
                  setDebugBusy(true);
                  try {
                    const r = await api.debugStart();
                    if (r.ok) setDebugSession(true);
                    else showToast(r.error || t('settings.debugTrigFail'), { error: true });
                  } finally {
                    setDebugBusy(false);
                  }
                }}
              >
                {t('settings.debugStart')}
              </button>
            ) : (
              <button
                className="btn-primary"
                style={{ padding: '4px 12px', fontSize: 12 }}
                disabled={debugBusy}
                onClick={() => void endDebug()}
              >
                {t('settings.debugEnd')}
              </button>
            )}
            <select
              value={debugChat}
              onChange={(e) => setDebugChat(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 8, fontSize: 12, maxWidth: 240 }}
            >
              <option value="">{t('settings.debugPickChat')}</option>
              {chatList.map((c) => (
                <option key={`${c.chat_type}:${c.chat_id}`} value={`${c.chat_type}:${c.chat_id}`}>
                  {c.chat_type === 'group' ? '👥 ' : '👤 '}
                  {c.name}
                </option>
              ))}
            </select>
          <Hint text={t('settings.debugHint')} /></div>
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              marginTop: 8,
              opacity: debugSession ? 1 : 0.5,
              pointerEvents: debugSession ? 'auto' : 'none',
            }}
          >
            {([
              ['proactive', 'settings.debugTrigProactive'],
              ['moments', 'settings.debugTrigMoments'],
              ['relationship', 'settings.debugTrigRelationship'],
              ['sceneImage', 'settings.debugTrigSceneImage'],
            ] as const).map(([k, key]) => (
              <button
                key={k}
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={debugBusy}
                onClick={() => void runDebugTrigger(k)}
              >
                {t(key)}
              </button>
            ))}
          </div>

          {/* 调试报告弹窗：结束调试后展示各功能错误分类汇总 */}
          {debugReport && (
            <div
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => setDebugReport(null)}
            >
              <div
                style={{
                  background: 'var(--color-panel)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 12,
                  width: 580,
                  maxWidth: '92vw',
                  maxHeight: '70vh',
                  overflowY: 'auto',
                  padding: 14,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{t('settings.debugReportTitle')}<Hint text={t('settings.debugReportNote')} /></div>
                  <button className="btn-ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setDebugReport(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
                {Object.keys(debugReport).length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{t('settings.debugReportEmpty')}</div>
                )}
                {Object.entries(debugReport).map(([cat, items]) => (
                  <div key={cat} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {cat === 'functional' ? t('settings.debugCatFunctional') : cat === 'model' ? t('settings.debugCatModel') : t('settings.debugCatOther')}（{items.length}）
                    </div>
                    {items.slice(0, 20).map((it, i) => (
                      <div key={i} style={{ fontSize: 12, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
                        · [{String(it.time || '').slice(11, 19)}] {it.message}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          </div>{/* end cat-general */}
        <div id="cat-chat" ref={(el) => { catRefs.current['cat-chat'] = el; }} className="settings-category">
          {/* ===== 群聊互聊（流式并行 / 调度 / 自动接话 / 主动续聊） ===== */}
          <div id="sec-groupchat" className="section-title" style={{ marginTop: 16 }}>{t('settings.groupChat')}</div>

          {/* 群聊流式并行数量 */}
          <div className="field" style={{ maxWidth: 300 }}>
            <label>{t('settings.streamParallel')}<Hint text={t('settings.streamParallelDesc')} /></label>
            <SelectMenu
              value={String(draft.streamParallel ?? 1)}
              onChange={(v) => patch({ streamParallel: Number(v) })}
              options={[
                { value: '1', label: t('settings.streamSeq') },
                { value: '3', label: t('settings.streamMod') },
                { value: '999', label: t('settings.streamAll') },
              ]}
            />
          </div>

          <div className="field" style={{ maxWidth: 300 }}>
            <label>{t('settings.groupScheduler')}<Hint text={t('settings.groupSchedulerDesc')} /></label>
            <SelectMenu
              value={draft.groupScheduler || 'director'}
              onChange={(v) => patch({ groupScheduler: v as 'director' | 'roundRobin' })}
              options={[
                { value: 'director', label: t('settings.schedulerDirector') },
                { value: 'roundRobin', label: t('settings.schedulerRoundRobin') },
              ]}
            />
          </div>
          <div className="field" style={{ maxWidth: 300, marginTop: 10 }}>
            <label>{t('settings.groupAutoRounds')}<Hint text={t('settings.groupAutoRoundsDesc')} /></label>
            <SelectMenu
              value={String(draft.groupAutoRounds ?? 6)}
              onChange={(v) => patch({ groupAutoRounds: Number(v) })}
              options={[
                ...[2, 4, 6, 10, 20, 50].map((n) => ({
                  value: String(n),
                  label: t('settings.groupRoundsN', { n }),
                })),
                { value: '0', label: t('settings.groupRoundsUnlimited') },
                ...(![2, 4, 6, 10, 20, 50, 0].includes(Number(draft.groupAutoRounds ?? 6))
                  ? [{
                      value: String(draft.groupAutoRounds),
                      label: t('settings.groupRoundsN', { n: draft.groupAutoRounds }),
                    }]
                  : []),
              ]}
            />
          </div>

          {/* AI 主动续聊开关 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 12 }}>
            <input
              type="checkbox"
              checked={!!draft.groupAutoChain}
              onChange={(e) => patch({ groupAutoChain: e.target.checked, groupSelectReply: e.target.checked ? false : draft.groupSelectReply })}
            />
            <span>{t('settings.groupAutoChain')}<Hint text={t('settings.groupAutoChainDesc')} /></span>
          </label>

          {/* 群聊选人回复：开启后每次发言与 AI 回复后由用户手动选择下一位发言者（与自动接话互斥） */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 12 }}>
            <input
              type="checkbox"
              checked={!!draft.groupSelectReply}
              onChange={(e) => patch({ groupSelectReply: e.target.checked, groupAutoChain: e.target.checked ? false : draft.groupAutoChain })}
            />
            <span>{t('settings.groupSelectReply')}<Hint text={t('settings.groupSelectReplyDesc')} /></span>
          </label>

          {/* 同角色连续发言上限（仅群聊自动接话生效） */}
          <div className="field" style={{ maxWidth: 300, marginTop: 14 }}>
            <label>{t('settings.groupMaxConsecutive')}<Hint text={t('settings.groupMaxConsecutiveDesc')} /></label>
            <SelectMenu
              value={String(draft.groupMaxConsecutive ?? 1)}
              onChange={(v) => patch({ groupMaxConsecutive: Number(v) })}
              options={Array.from({ length: 20 }, (_, i) => i + 1).map((n) => ({
                value: String(n),
                label: t('settings.groupMaxConsecutiveN', { n }),
              }))}
            />
          </div>

          {/* ===== 隐藏思维链 ===== */}
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={draft.hideReasoning !== false}
              onChange={(e) => {
                patch({ hideReasoning: e.target.checked });
                api.saveSettings({ hideReasoning: e.target.checked });
              }}
            />
            <span>{t('settings.hideReasoning')}<Hint text={t('settings.hideReasoningDesc')} /></span>
          </label>

          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={draft.enableRandomEvents !== false}
              onChange={(e) => {
                patch({ enableRandomEvents: e.target.checked });
                api.saveSettings({ enableRandomEvents: e.target.checked });
              }}
            />
            <span>{t('settings.enableRandomEvents')}<Hint text={t('settings.enableRandomEventsDesc')} /></span>
          </label>

          {/* 事件影响心情程度 */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventMoodImpact')}<Hint text={t('settings.eventMoodImpactDesc')} /></span>
              <span>{Math.round((draft.eventMoodImpact ?? 1) * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((draft.eventMoodImpact ?? 1) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                patch({ eventMoodImpact: v });
                api.saveSettings({ eventMoodImpact: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 对话影响心情程度 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.dialogueMoodImpact')}<Hint text={t('settings.dialogueMoodImpactDesc')} /></span>
              <span>{Math.round((draft.dialogueMoodImpact ?? 1) * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((draft.dialogueMoodImpact ?? 1) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                patch({ dialogueMoodImpact: v });
                api.saveSettings({ dialogueMoodImpact: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 心情过渡指数 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.moodSmoothing')}<Hint text={t('settings.moodSmoothingDesc')} /></span>
              <span>{Math.round((draft.moodSmoothing ?? 0.5) * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((draft.moodSmoothing ?? 0.5) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                patch({ moodSmoothing: v });
                api.saveSettings({ moodSmoothing: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* ===== 情绪与事件（高级可调） ===== */}
          <div id="sec-emoevent" className="section-title" style={{ marginTop: 16 }}>
            {t('settings.emoEventAdvanced')}
          </div>

          {/* 心情判定冷却 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.moodJudgeCooldown')}<Hint text={t('settings.moodJudgeCooldownDesc')} /></span>
              <span>{Math.round((draft.moodJudgeCooldownMs ?? 20000) / 1000)}s</span>
            </div>
            <input
              type="range"
              min={0}
              max={60}
              step={1}
              value={Math.round((draft.moodJudgeCooldownMs ?? 20000) / 1000)}
              onChange={(e) => {
                const v = Number(e.target.value) * 1000;
                patch({ moodJudgeCooldownMs: v });
                api.saveSettings({ moodJudgeCooldownMs: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 心情判定回顾轮数 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.moodJudgeHistory')}<Hint text={t('settings.moodJudgeHistoryDesc')} /></span>
              <span>{draft.moodJudgeHistory ?? 10}</span>
            </div>
            <input
              type="range"
              min={4}
              max={30}
              step={1}
              value={draft.moodJudgeHistory ?? 10}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ moodJudgeHistory: v });
                api.saveSettings({ moodJudgeHistory: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 低好感冲突阈值 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventNegAffinity')}<Hint text={t('settings.eventNegAffinityDesc')} /></span>
              <span>{draft.eventNegAffinity ?? 30}</span>
            </div>
            <input
              type="range"
              min={0}
              max={60}
              step={1}
              value={draft.eventNegAffinity ?? 30}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ eventNegAffinity: v });
                api.saveSettings({ eventNegAffinity: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 高好感甜蜜阈值 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventPosAffinity')}<Hint text={t('settings.eventPosAffinityDesc')} /></span>
              <span>{draft.eventPosAffinity ?? 70}</span>
            </div>
            <input
              type="range"
              min={40}
              max={100}
              step={1}
              value={draft.eventPosAffinity ?? 70}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ eventPosAffinity: v });
                api.saveSettings({ eventPosAffinity: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 事件参考上下文条数 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventHistory')}<Hint text={t('settings.eventHistoryDesc')} /></span>
              <span>{draft.eventHistory ?? 12}</span>
            </div>
            <input
              type="range"
              min={4}
              max={30}
              step={1}
              value={draft.eventHistory ?? 12}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ eventHistory: v });
                api.saveSettings({ eventHistory: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 事件生成长度上限 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventMaxTokens')}<Hint text={t('settings.eventMaxTokensDesc')} /></span>
              <span>{draft.eventMaxTokens ?? 700}</span>
            </div>
            <input
              type="range"
              min={200}
              max={1500}
              step={100}
              value={draft.eventMaxTokens ?? 700}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ eventMaxTokens: v });
                api.saveSettings({ eventMaxTokens: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* ===== 需求 14：不常用聊天文件夹（多少天没聊天算不常用） ===== */}
          <div id="sec-inactive-chat" className="section-title" style={{ marginTop: 16 }}>
            {t('settings.inactiveChat')}
          </div>
          <div className="field" style={{ maxWidth: 480 }}>
            <label>
              {t('settings.inactiveChatDays')}
              <Hint text={t('settings.inactiveChatDaysDesc')} />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min={INACTIVE_DAYS_MIN}
                max={INACTIVE_DAYS_MAX}
                step={1}
                style={{ width: 100 }}
                value={clampInactiveDays(draft.inactiveChatDays ?? INACTIVE_DAYS_DEFAULT)}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  // 输入中途（如清空成''）Number 得NaN：此时不落盘，保留用户输入框内容由其自行恢复
                  if (!Number.isFinite(raw)) return;
                  const v = clampInactiveDays(raw);
                  patch({ inactiveChatDays: v });
                  api.saveSettings({ inactiveChatDays: v });
                }}
                onBlur={(e) => {
                  // 失焦时把越界值夹回合法区间并落盘（避免 0 / -5 / 99999 这类脏值留在设置里）
                  const v = clampInactiveDays(Number(e.target.value));
                  if (v !== draft.inactiveChatDays) {
                    patch({ inactiveChatDays: v });
                    api.saveSettings({ inactiveChatDays: v });
                  }
                }}
              />
              <span style={{ fontSize: 13 }}>{t('settings.inactiveChatDaysUnit')}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
              {t('settings.inactiveChatHint')}
            </div>
          </div>

          </div>{/* end cat-chat */}
        <div id="cat-proactive" ref={(el) => { catRefs.current['cat-proactive'] = el; }} className="settings-category">
          {/* ===== ① 主动消息机制（最高层决策：先选机制，再配该机制的参数） ===== */}
          <div id="sec-proactive-engine" className="section-title" style={{ marginTop: 14 }}>{t('settings.proactiveEngine')}<Hint text={t('settings.proactiveEngineDesc')} /><Hint text={t('settings.proactiveNhppDesc')} /></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { v: 'legacy' as const, l: t('settings.proactiveLegacy') },
              { v: 'nhpp' as const, l: t('settings.proactiveNhpp') },
            ].map((opt) => {
              const active = (draft.proactiveEngine ?? 'legacy') === opt.v;
              return (
                <button
                  key={opt.v}
                  className={active ? 'btn-primary' : 'btn-ghost'}
                  style={{ padding: '5px 12px', fontSize: 12 }}
                  onClick={() => {
                    patch({ proactiveEngine: opt.v });
                    api.saveSettings({ proactiveEngine: opt.v });
                  }}
                >
                  {opt.l}
                </button>
              );
            })}
          </div>

          {/* ===== ② 总开关（两种机制共用） ===== */}
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={draft.idleEnabled !== false}
              onChange={(e) => {
                patch({ idleEnabled: e.target.checked });
                api.saveSettings({ idleEnabled: e.target.checked });
              }}
            />
            <div>
              <div style={{ fontSize: 13 }}>{t('settings.idleEnabled')}<Hint text={t('settings.idleEnabledDesc')} /></div>
            </div>
          </div>

          {/* 等回复才发下一条（两种机制通用，v2.3.92：从 legacy 专属块提到总开关旁） */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={draft.idleCooldownUntilReply !== false}
              onChange={(e) => {
                patch({ idleCooldownUntilReply: e.target.checked });
                api.saveSettings({ idleCooldownUntilReply: e.target.checked });
              }}
            />
            <div>
              <div style={{ fontSize: 13 }}>{t('settings.idleCooldown')}<Hint text={t('settings.idleCooldownDesc')} /></div>
            </div>
          </div>

          {/* v2.3.94 需求 4：触发等待的主动消息条数阈值。
              最小 1 条；填到最大档 9999（或留空）= 不启用等待功能（用户原话「最大无限条」）。
              注意：9999 这个哨兵值必须与 electron/awaitingReply.ts 的 AWAITING_NEVER 保持一致。 */}
          {(draft.idleCooldownUntilReply !== false) && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                {t('settings.idleAwaitingThreshold')}
                <Hint text={t('settings.idleAwaitingThresholdDesc')} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  step={1}
                  style={{ width: 110 }}
                  value={draft.idleAwaitingTriggerCount ?? 9999}
                  onChange={(e) => {
                    // 非法输入（空/非数）先回落到 9999（=不启用），避免写入 NaN 污染 settings
                    const n = Number(e.target.value);
                    const v = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 9999) : 9999;
                    patch({ idleAwaitingTriggerCount: v });
                    api.saveSettings({ idleAwaitingTriggerCount: v });
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {(draft.idleAwaitingTriggerCount ?? 9999) >= 9999
                    ? t('settings.idleAwaitingThresholdOff')
                    : t('settings.idleAwaitingThresholdOn', { n: draft.idleAwaitingTriggerCount ?? 1 })}
                </span>
              </div>
            </div>
          )}

          {/* ===== ③ 经典定时机制参数（仅 legacy 机制下生效/显示） ===== */}
          {(draft.proactiveEngine ?? 'legacy') === 'nhpp' ? (
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.proactiveLegacyHiddenHint')}
            </div>
          ) : (
            <>
          {/* 触发时机模式：固定间隔 / 随机时间 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.idleMode')}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(
                [
                  { v: 'fixed', l: t('settings.idleModeFixed') },
                  { v: 'random', l: t('settings.idleModeRandom') },
                ] as const
              ).map((opt) => {
                const active = (draft.idleTimingMode ?? 'fixed') === opt.v;
                return (
                  <button
                    key={opt.v}
                    className={active ? 'btn-primary' : 'btn-ghost'}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => {
                      patch({ idleTimingMode: opt.v });
                    }}
                  >
                    {opt.l}
                  </button>
                );
              })}
            </div>
          </div>

          {(draft.idleTimingMode ?? 'fixed') === 'fixed' && (
          <>
          {/* 触发时长：离散选项 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.idleInterval')}<Hint text={t('settings.idleIntervalDesc')} /></div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { v: 300, l: t('settings.idleInterval5min') },
                { v: 600, l: t('settings.idleInterval10min') },
                { v: 1800, l: t('settings.idleInterval30min') },
                { v: 3600, l: t('settings.idleInterval1h') },
                { v: 7200, l: t('settings.idleInterval2h') },
                { v: 18000, l: t('settings.idleInterval5h') },
              ].map((opt) => {
                const active = (draft.idleInterval ?? 600) === opt.v;
                return (
                  <button
                    key={opt.v}
                    className={active ? 'btn-primary' : 'btn-ghost'}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => {
                      patch({ idleInterval: opt.v });
                      api.saveSettings({ idleInterval: opt.v });
                    }}
                  >
                    {opt.l}
                  </button>
                );
              })}
            </div>
          </div>
          </>
          )}

          {(draft.idleTimingMode ?? 'fixed') === 'random' && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.idleRandomTitle')}<Hint text={t('settings.idleRandomDesc')} /></div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                {t('settings.idleRandomMin')}
                <input
                  type="number"
                  min={1}
                  max={86400}
                  step={1}
                  style={{ width: 90 }}
                  value={draft.idleRandomMinSec ?? 60}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) saveRandomRange(v, draft.idleRandomMaxSec ?? 1800);
                  }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                {t('settings.idleRandomMax')}
                <input
                  type="number"
                  min={1}
                  max={86400}
                  step={1}
                  style={{ width: 90 }}
                  value={draft.idleRandomMaxSec ?? 1800}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) saveRandomRange(draft.idleRandomMinSec ?? 60, v);
                  }}
                />
              </label>
            </div>
          </div>
          )}

          {/* 切换聊天时的计时行为 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.idleSwitchAction')}<Hint text={t('settings.idleSwitchActionDesc')} /></div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { v: 'pause' as const, l: t('settings.idleSwitchPause') },
                { v: 'reset' as const, l: t('settings.idleSwitchReset') },
                { v: 'continue' as const, l: t('settings.idleSwitchContinue') },
              ].map((opt) => {
                const active = (draft.idleSwitchAction || 'continue') === opt.v;
                return (
                  <button
                    key={opt.v}
                    className={active ? 'btn-primary' : 'btn-ghost'}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => {
                      patch({ idleSwitchAction: opt.v });
                      api.saveSettings({ idleSwitchAction: opt.v });
                    }}
                  >
                    {opt.l}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 主动消息记忆开关 */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={!!draft.idleWriteMemory}
              onChange={(e) => {
                patch({ idleWriteMemory: e.target.checked });
                api.saveSettings({ idleWriteMemory: e.target.checked });
              }}
            />
            <div>
              <div style={{ fontSize: 13 }}>{t('settings.idleWriteMemory')}<Hint text={t('settings.idleWriteMemoryDesc')} /></div>
            </div>
          </div>

          </>
          )}

          {/* ===== ④ NHPP 智能调度参数（仅 nhpp 机制下显示） ===== */}

          {(draft.proactiveEngine ?? 'legacy') === 'nhpp' && (
            <div style={{ marginTop: 10, opacity: draft.idleEnabled === false ? 0.4 : 1 }}>
              {/* 勿扰窗口 */}
              <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.proactiveDnd')}<Hint text={t('settings.proactiveDndDesc')} /></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="checkbox"
                  checked={!!draft.proactiveDnd?.enabled}
                  onChange={(e) => {
                    const dnd = { enabled: e.target.checked, start: draft.proactiveDnd?.start || '01:00', end: draft.proactiveDnd?.end || '08:00' };
                    patch({ proactiveDnd: dnd });
                    api.saveSettings({ proactiveDnd: dnd });
                  }}
                />
                <input
                  type="time"
                  value={draft.proactiveDnd?.start || '01:00'}
                  onChange={(e) => {
                    const dnd = { enabled: draft.proactiveDnd?.enabled !== false, start: e.target.value, end: draft.proactiveDnd?.end || '08:00' };
                    patch({ proactiveDnd: dnd });
                    api.saveSettings({ proactiveDnd: dnd });
                  }}
                  style={{ width: 110 }}
                />
                <span style={{ fontSize: 12 }}>—</span>
                <input
                  type="time"
                  value={draft.proactiveDnd?.end || '08:00'}
                  onChange={(e) => {
                    const dnd = { enabled: draft.proactiveDnd?.enabled !== false, start: draft.proactiveDnd?.start || '01:00', end: e.target.value };
                    patch({ proactiveDnd: dnd });
                    api.saveSettings({ proactiveDnd: dnd });
                  }}
                  style={{ width: 110 }}
                />
              </div>
              {/* 频率自适应（v2.3.92）：按用户回复间隔 EMA 动态调整发送强度 */}
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.proactiveAdaptiveEnabled !== false}
                  onChange={(e) => {
                    patch({ proactiveAdaptiveEnabled: e.target.checked });
                    api.saveSettings({ proactiveAdaptiveEnabled: e.target.checked });
                  }}
                />
                <div>
                  <div style={{ fontSize: 13 }}>{t('settings.proactiveAdaptive')}<Hint text={t('settings.proactiveAdaptiveDesc')} /></div>
                </div>
              </div>
              {/* 每日硬上限 + 新鲜度 */}
              <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {t('settings.proactiveDailyLimit')}
                  <input
                    type="number"
                    min={1}
                    max={50}
                    style={{ width: 70 }}
                    value={draft.proactiveDailyLimit ?? 5}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 1) {
                        patch({ proactiveDailyLimit: v });
                        api.saveSettings({ proactiveDailyLimit: v });
                      }
                    }}
                  />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {t('settings.proactiveFreshness')}
                  <input
                    type="number"
                    min={1}
                    max={120}
                    style={{ width: 70 }}
                    value={draft.proactiveFreshnessMin ?? 10}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 1) {
                        patch({ proactiveFreshnessMin: v });
                        api.saveSettings({ proactiveFreshnessMin: v });
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          {/* ===== ⑤ 按聊天单独开关（经典定时机制生效；NHPP 有独立调度，不适用） ===== */}
          {(draft.proactiveEngine ?? 'legacy') === 'legacy' && chatList.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="section-title" style={{ marginTop: 4 }}>
                {t('settings.idleAllChats')}<Hint text={t('settings.idleAllChatsDesc')} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: draft.idleEnabled === false ? 0.4 : 1, pointerEvents: draft.idleEnabled === false ? 'none' : 'auto' }}>
                {draft.idleEnabled === false && (
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>🔒 {t('settings.idleMasterOffHint')}</div>
                )}
                {chatList.map((c) => {
                  const key = `${c.chat_type}:${c.chat_id}`;
                  const cur = (draft.chatIdleEnabled || {})[key];
                  const effective = cur === undefined ? true : cur;
                  return (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px' }}>
                      <input
                        type="checkbox"
                        checked={effective}
                        onChange={(e) => {
                          const next = { ...(draft.chatIdleEnabled || {}), [key]: e.target.checked };
                          patch({ chatIdleEnabled: next });
                          api.saveSettings({ chatIdleEnabled: next });
                        }}
                      />
                      <span style={{ fontSize: 13 }}>
                        {c.chat_type === 'group' ? '👥' : '👤'} {c.name}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          </div>{/* end cat-proactive */}
        <div id="cat-social" ref={(el) => { catRefs.current['cat-social'] = el; }} className="settings-category">
          {/* ===== 世界书 / 记忆（全局默认 + 自动记忆） ===== */}
          <div id="sec-worldbook" className="section-title" style={{ marginTop: 16 }}>{t('worldbook.title')}</div>
          <div className="field" style={{ maxWidth: 340 }}>
            <label>{t('settings.defaultWorldbook')}<Hint text={t('settings.defaultWorldbookDesc')} /></label>
            <SelectMenu
              value={draft.defaultWorldBookId || ''}
              onChange={(v) => {
                patch({ defaultWorldBookId: v });
                api.saveSettings({ defaultWorldBookId: v });
              }}
              options={[
                { value: '', label: t('worldbook.none') },
                ...worldBooks.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </div>

          {/* 自动记忆开关 */}
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={!!draft.enableAutoMemory}
              onChange={(e) => {
                patch({ enableAutoMemory: e.target.checked });
                api.saveSettings({ enableAutoMemory: e.target.checked });
              }}
            />
            <span>{t('settings.autoMemory')}<Hint text={t('settings.autoMemoryDesc')} /></span>
          </label>

          {/* ===== 记忆提示词（v2.3.36）：总结/注入两条提示词，AI 自动提炼与手动总结共用，失焦落盘 ===== */}
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--color-border, rgba(128,128,128,0.35))' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('settings.memoryPromptsTitle')}</div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {t('settings.memorySummarizePromptLabel')}<Hint text={t('settings.memorySummarizePromptDesc')} />
            </div>
            <textarea
              value={summarizePromptLocal}
              onChange={(e) => setSummarizePromptLocal(e.target.value)}
              onBlur={() => saveMemoryPrompt('memorySummarizePrompt', summarizePromptLocal)}
              rows={12}
              spellCheck={false}
              style={{ width: '100%', maxWidth: 560, display: 'block', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
            />
            <button
              onClick={() => saveMemoryPrompt('memorySummarizePrompt', DEFAULT_MEMORY_SUMMARIZE_PROMPT)}
              style={{ marginTop: 4, fontSize: 12 }}
            >
              {t('settings.memoryPromptsReset')}
            </button>
            <div style={{ fontSize: 13, margin: '12px 0 6px' }}>
              {t('settings.memoryInjectPromptLabel')}<Hint text={t('settings.memoryInjectPromptDesc')} />
            </div>
            <textarea
              value={injectPromptLocal}
              onChange={(e) => setInjectPromptLocal(e.target.value)}
              onBlur={() => saveMemoryPrompt('memoryInjectPrompt', injectPromptLocal)}
              rows={10}
              spellCheck={false}
              style={{ width: '100%', maxWidth: 560, display: 'block', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
            />
            <button
              onClick={() => saveMemoryPrompt('memoryInjectPrompt', DEFAULT_MEMORY_INJECT_PROMPT)}
              style={{ marginTop: 4, fontSize: 12 }}
            >
              {t('settings.memoryPromptsReset')}
            </button>
          </div>

          {/* AI 自动判定关系值开关 */}
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={draft.autoRelationship !== false}
              onChange={(e) => {
                patch({ autoRelationship: e.target.checked });
                api.saveSettings({ autoRelationship: e.target.checked });
              }}
            />
            <span>{t('settings.autoRelationship')}<Hint text={t('settings.autoRelationshipDesc')} /></span>
          </label>

          {/* AI 自动发朋友圈开关 */}
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={draft.autoMoments !== false}
              onChange={(e) => {
                patch({ autoMoments: e.target.checked });
                api.saveSettings({ autoMoments: e.target.checked });
              }}
            />
            <span>{t('settings.autoMoments')}<Hint text={t('settings.autoMomentsDesc')} /></span>
          </label>

          {/* 朋友圈视频生成开关（独立开关，需配置生视频模型） */}
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={draft.momentsVideoEnabled === true}
              onChange={(e) => {
                patch({ momentsVideoEnabled: e.target.checked });
                api.saveSettings({ momentsVideoEnabled: e.target.checked });
              }}
            />
            <span>{t('settings.momentsVideo')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.momentsVideoDesc')}
            {!(draft.videoGen && draft.videoGen.enabled && draft.videoGen.baseUrl && draft.videoGen.apiKey) && (
              <span style={{ color: '#e6a23c' }}> {t('settings.momentsVideoNoModel')}</span>
            )}
          </div>

          {/* 朋友圈每日上限 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.dailyMomentLimit')}<Hint text={t('settings.dailyMomentLimitDesc')} /></span>
              <span>{draft.dailyMomentLimit === 0 ? t('moments.unlimited') : (draft.dailyMomentLimit ?? 5)}</span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={draft.dailyMomentLimit ?? 5}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ dailyMomentLimit: v });
                api.saveSettings({ dailyMomentLimit: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 朋友圈敏感程度 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.momentsSensitivity')}<Hint text={t('settings.momentsSensitivityDesc')} /></span>
              <span>{Math.round((draft.momentsSensitivity ?? 0.5) * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((draft.momentsSensitivity ?? 0.5) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                patch({ momentsSensitivity: v });
                api.saveSettings({ momentsSensitivity: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          </div>{/* end cat-social */}
        </>)}
        {/* ===== 群聊互聊（流式并行 / 调度 / 自动接话 / 主动续聊） ===== */}
        {/* 模型管理分区已独立为二级菜单页（view=models）：仅 modelsOnly 模式渲染 */}
        {onlyModels && (<>
        <div id="cat-models" ref={(el) => { catRefs.current['cat-models'] = el; }} className="settings-category">

        {/* ===== 全局模型参数（默认值；模型编辑器内可单独覆盖） ===== */}
        <div id="sec-globalparams" className="section-title">{t('settings.globalModelParams')}<Hint text={t('settings.globalModelParamsDesc')} /></div>
        <div className="field" style={{ maxWidth: 340 }}>
          <label>{t('settings.enableStreaming')}<Hint text={t('settings.globalStreamDesc')} /></label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!draft.enableStreaming}
              onChange={(e) => patch({ enableStreaming: e.target.checked })}
            />
            <span>{draft.enableStreaming ? t('model.streamOn') : t('model.streamOff')}</span>
          </label>
        </div>
        {([
          { key: 'temperature' as const, label: t('settings.globalTemperature'), min: 0, max: 2, step: 0.01, def: 1 },
          { key: 'topP' as const, label: t('settings.globalTopP'), min: 0, max: 1, step: 0.01, def: 1 },
          { key: 'topK' as const, label: t('settings.globalTopK'), min: 0, max: 50, step: 1, def: 0 },
        ]).map((row) => {
          const val = draft.globalModelParams?.[row.key] ?? row.def;
          return (
            <div className="field" style={{ maxWidth: 340 }} key={row.key}>
              <label>{row.label}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="range"
                  min={row.min}
                  max={row.max}
                  step={row.step}
                  value={val}
                  onChange={(e) =>
                    patch({ globalModelParams: { ...(draft.globalModelParams || {}), [row.key]: Number(e.target.value) } })
                  }
                  style={{ flex: 1, minWidth: 0 }}
                />
                <input
                  type="number"
                  min={row.min}
                  max={row.max}
                  step={row.step}
                  value={val}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v))
                      patch({ globalModelParams: { ...(draft.globalModelParams || {}), [row.key]: Math.max(row.min, Math.min(row.max, v)) } });
                  }}
                  style={{ width: 92 }}
                />
              </div>
            </div>
          );
        })}

        {/* ===== 伪流式输出（v2.3.39：由常规设置移入模型管理；与流式输出互斥）===== */}
        <div id="sec-pseudostream" className="section-title" style={{ marginTop: 16 }}>{t('settings.pseudoStream')}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: draft.enableStreaming !== false ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={draft.pseudoStreamEnabled === true}
            disabled={draft.enableStreaming !== false}
            onChange={(e) => patch({ pseudoStreamEnabled: e.target.checked })}
          />
          <span>{t('settings.pseudoStreamOn')}<Hint text={t('settings.pseudoStreamDesc')} /></span>
        </label>
        {draft.enableStreaming !== false && (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6 }}>
            {t('settings.pseudoStreamStreamOnHint')}
          </div>
        )}
        <div style={{ fontSize: 13, marginTop: 12, marginBottom: 6 }}>{t('settings.pseudoStreamAnimSpeed')}<Hint text={t('settings.pseudoStreamAnimSpeedDesc')} /></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 340 }}>
          <input
            type="range"
            min={PSEUDO_SPEED_MIN}
            max={PSEUDO_SPEED_MAX}
            step={0.05}
            disabled={draft.pseudoStreamEnabled !== true || draft.enableStreaming !== false}
            value={draft.pseudoStreamSpeed ?? PSEUDO_SPEED_DEFAULT}
            onChange={(e) => patch({ pseudoStreamSpeed: clampPseudoSpeed(Number(e.target.value)) })}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 92, textAlign: 'right' }}>
            {t('settings.pseudoStreamAnimSpeedValue', {
              s: (draft.pseudoStreamSpeed ?? PSEUDO_SPEED_DEFAULT).toFixed(2),
            })}
          </span>
        </div>

        {/* ===== 模型管理（含默认模型） ===== */}
        <div id="sec-modelmanage" className="section-title">{t('settings.modelManage')}<Hint text={t('settings.defaultModelHint')} /></div>

        {/* 深度思考等级：全局档位，实际仅对「模型管理」中标记为支持推理的模型生效 */}
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t('settings.deepThink')}<Hint text={t('settings.deepThinkDesc')} /></div>
        <select
          value={draft.deepThinkLevel || 'off'}
          onChange={(e) => patch({ deepThinkLevel: e.target.value as DeepThinkLevel })}
          style={{ padding: '6px 8px', borderRadius: 8, width: 260, marginTop: 6 }}
        >
          <option value="off">{t('settings.deepThinkOff')}</option>
          <option value="low">{t('settings.deepThinkLow')}</option>
          <option value="medium">{t('settings.deepThinkMedium')}</option>
          <option value="high">{t('settings.deepThinkHigh')}</option>
        </select>

        {/* 识图模型（v2.3.51）：聊天中带图消息路由到该模型识别与回复；未设置时图片走原模型 */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t('settings.visionModel')}
            <Hint text={t('settings.visionModelHint')} />
          </span>
          <ComboBox
            style={{ width: 260 }}
            placeholder={t('settings.visionModelNone')}
            title={t('settings.visionModel')}
            value={visionQuery || (draft?.models || []).find((m) => m.id === draft?.visionModelId)?.name || ''}
            options={(draft?.models || []).filter((m) => m.enabled).map((m) => m.name)}
            onChange={(v) => {
              setVisionQuery(v);
              const hit = (draft?.models || []).find((m) => m.name === v);
              if (hit) patch({ visionModelId: hit.id });
              else if (!v.trim()) patch({ visionModelId: '' });
            }}
          />
          {draft?.visionModelId && (
            <button
              className="btn-ghost"
              style={{ padding: '3px 10px', fontSize: 12 }}
              onClick={() => patch({ visionModelId: '' })}
            >
              {t('settings.visionModelClear')}
            </button>
          )}
        </div>

        {/* 模型筛选：能力维度（视觉/工具/JSON/推理/NSFW）+ 分类维度（分组/标签），组内 OR、维度间 AND */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.modelFilter')}</span>
            {[
              { key: 'vision', label: t('model.capImages') },
              { key: 'tools', label: t('model.capTools') },
              { key: 'json', label: t('model.capJson') },
              { key: 'reasoning', label: t('model.supportsReasoning') },
              { key: 'nsfw', label: t('model.capNsfw') },
            ].map((f) => {
              const active = modelFilter.has(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() =>
                    setModelFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.key)) next.delete(f.key);
                      else next.add(f.key);
                      return next;
                    })
                  }
                  style={{
                    padding: '3px 12px',
                    fontSize: 12,
                    borderRadius: 14,
                    cursor: 'pointer',
                    border: active ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                    background: active ? 'var(--color-primary)' : 'var(--color-panel-alt)',
                    color: active ? 'var(--color-primary-text)' : 'var(--color-text)',
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.filterByGroup')}</span>
            {modelGroups.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('settings.groupEmpty')}</span>
            ) : (
              modelGroups.map((g) => {
                const active = groupFilter.has(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleSet(setGroupFilter)(g.id)}
                    style={{
                      padding: '3px 12px',
                      fontSize: 12,
                      borderRadius: 14,
                      cursor: 'pointer',
                      border: `1px solid ${active ? g.color : 'var(--color-border)'}`,
                      background: active ? g.color : 'var(--color-panel-alt)',
                      color: active ? '#fff' : 'var(--color-text)',
                    }}
                  >
                    {g.name}
                  </button>
                );
              })
            )}
            <button
              type="button"
              onClick={() => toggleSet(setGroupFilter)('__ungrouped__')}
              style={{
                padding: '3px 12px',
                fontSize: 12,
                borderRadius: 14,
                cursor: 'pointer',
                border: groupFilter.has('__ungrouped__') ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                background: groupFilter.has('__ungrouped__') ? 'var(--color-primary)' : 'var(--color-panel-alt)',
                color: groupFilter.has('__ungrouped__') ? 'var(--color-primary-text)' : 'var(--color-text)',
              }}
            >
              {t('settings.ungrouped')}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.filterByTag')}</span>
            {allTags.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('settings.noTags')}</span>
            ) : (
              allTags.map((tg) => {
                const active = tagFilter.has(tg);
                return (
                  <button
                    key={tg}
                    type="button"
                    onClick={() => toggleSet(setTagFilter)(tg)}
                    style={{
                      padding: '3px 12px',
                      fontSize: 12,
                      borderRadius: 14,
                      cursor: 'pointer',
                      border: active ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                      background: active ? 'var(--color-primary)' : 'var(--color-panel-alt)',
                      color: active ? 'var(--color-primary-text)' : 'var(--color-text)',
                    }}
                  >
                    {tg}
                  </button>
                );
              })
            )}
          </div>
          {(modelFilter.size > 0 || groupFilter.size > 0 || tagFilter.size > 0) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                onClick={() => {
                  setModelFilter(new Set());
                  setGroupFilter(new Set());
                  setTagFilter(new Set());
                }}
              >
                {t('settings.filterClear')}
              </button>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {t('settings.filterMatch', {
                  n: filteredModels.length,
                  total: (draft.models || []).length,
                })}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          {filteredModels.map((m) => {
            const isDefault = draft.defaultModel === m.id;
            const isVision = draft.visionModelId === m.id;
            return (
              <div
                key={m.id}
                id={`model-card-${m.id}`}
                style={{
                  border: isDefault
                    ? '2px solid var(--color-primary)'
                    : '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 12px',
                  minWidth: 200,
                  background: 'var(--color-panel-alt)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {m.name}
                    {isDefault && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: '#fff',
                          background: 'var(--color-primary)',
                          borderRadius: 8,
                          padding: '1px 7px',
                        }}
                      >
                        {t('settings.defaultBadge')}
                      </span>
                    )}
                    {isVision && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: 'var(--color-primary)',
                          border: '1px solid var(--color-primary)',
                          borderRadius: 8,
                          padding: '1px 7px',
                        }}
                      >
                        {t('settings.visionBadge')}
                      </span>
                    )}
                  </strong>
                  <span
                    style={{
                      fontSize: 11,
                      color: m.enabled ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    }}
                  >
                    {m.enabled ? t('settings.enabled') : t('settings.disabled')}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {providerLabel(m.provider)} · {m.model}
                </div>
                {((m.groupIds && m.groupIds.length > 0) || (m.tags && m.tags.length > 0)) && (
                  <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {(m.groupIds || [])
                      .map((gid) => modelGroups.find((g) => g.id === gid))
                      .filter((g): g is NonNullable<typeof g> => !!g)
                      .map((g) => (
                        <span
                          key={g.id}
                          style={{
                            fontSize: 11,
                            padding: '1px 7px',
                            borderRadius: 8,
                            color: '#fff',
                            background: g.color,
                          }}
                        >
                          {g.name}
                        </span>
                      ))}
                    {(m.tags || []).map((tg) => (
                      <span
                        key={tg}
                        style={{
                          fontSize: 11,
                          padding: '1px 7px',
                          borderRadius: 8,
                          border: '1px solid var(--color-border)',
                          background: 'var(--color-input-bg)',
                        }}
                      >
                        {tg}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn-ghost"
                    style={{
                      padding: '3px 10px',
                      fontSize: 12,
                      color: isDefault ? 'var(--color-text-secondary)' : 'var(--color-primary)',
                    }}
                    onClick={() => toggleDefault(m.id)}
                  >
                    {isDefault ? t('settings.unsetDefault') : t('settings.setDefault')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    onClick={() => {
                      setEditorInitial(m);
                      setEditorOpen(true);
                    }}
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    onClick={() => onModelCopy(m)}
                  >
                    {t('common.copy')}
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12, color: '#e06c75' }}
                    onClick={() => onModelDelete(m.id)}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            );
          })}
          {(draft.models || []).length === 0 && (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
              {t('settings.noModels')}
            </div>
          )}
          {(modelFilter.size > 0 || groupFilter.size > 0 || tagFilter.size > 0) && filteredModels.length === 0 && (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
              {t('settings.filterNoMatch')}
            </div>
          )}
        </div>

        {/* 模型分组管理：创建 / 重命名 / 改色 / 删除（删除仅移出关联，不删模型） */}
        <div className="section-title" style={{ marginTop: 18 }}>{t('settings.modelGroups')}<Hint text={t('settings.modelGroupsDesc')} /></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          {modelGroups.map((g) => (
            <div
              key={g.id}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
                background: 'var(--color-panel-alt)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                minWidth: 200,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={g.color}
                  onChange={(e) => recolorGroup(g.id, e.target.value)}
                  style={{ width: 24, height: 24, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                />
                <input
                  defaultValue={g.name}
                  key={g.name}
                  onBlur={(e) => renameGroup(g.id, e.target.value)}
                  placeholder={t('settings.groupNamePh')}
                  style={{ flex: 1, minWidth: 0, fontSize: 13 }}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '2px 8px', fontSize: 12, color: '#e06c75' }}
                  onClick={() => deleteGroup(g.id)}
                >
                  {t('settings.groupDelete')}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {MODEL_GROUP_COLORS.map((c) => (
                  <span
                    key={c}
                    onClick={() => recolorGroup(g.id, c)}
                    title={c}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 8,
                      background: c,
                      cursor: 'pointer',
                      outline: g.color === c ? '2px solid var(--color-text)' : 'none',
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
          <button className="btn-primary" style={{ alignSelf: 'flex-start' }} onClick={addGroup}>
            {t('settings.addGroup')}
          </button>
        </div>

        <button
          className="btn-primary"
          style={{ marginBottom: 6 }}
          onClick={() => {
            setEditorInitial(undefined);
            setEditorOpen(true);
          }}
        >
          {t('settings.addModel')}
        </button>

        {/* 模型能力检测：真实探针探测视觉/工具/JSON 支持与上下文窗口（已加入设置搜索索引，id=sec-modeldetect） */}
        <div id="sec-modeldetect" style={{ marginTop: 16 }}>
          <div className="section-title">{t('settings.modelCapability')}<Hint text={t('settings.detectAllDesc')} /></div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setDetectOptsOpen(true)}
              disabled={detectingAll}
            >
              {detectingAll ? t('model.detecting') : t('settings.detectAllModels')}
            </button>
          </div>
        </div>

        {/* 一键检测全部：先选择探测项（NSFW 默认不勾），避免对全部模型无差别发送成人内容探针 */}
        {detectOptsOpen && (
          <div
            className="modal-mask"
            onClick={() => setDetectOptsOpen(false)}
          >
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
              <div className="modal-head">
                <span>{t('settings.detectAllTitle')}</span>
                <span className="modal-close" onClick={() => setDetectOptsOpen(false)}>×</span>
              </div>
              <div className="modal-body">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                  {([
                    ['images', t('model.capImages')],
                    ['tools', t('model.capTools')],
                    ['json', t('model.capJson')],
                    ['nsfw', t('model.capNsfw')],
                    ['thinkLevel', t('model.capThinkLevel')],
                  ] as const).map(([k, label]) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={detectOpts[k]}
                        onChange={(e) => setDetectOpts((p) => ({ ...p, [k]: e.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {/* NSFW 探针属于「真实发送成人内容请求」的敏感操作，保留醒目横幅提醒（不做图标化） */}
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-input-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', marginBottom: 10 }}>
                  {t('settings.detectNsfwWarn')}
                </div>
                {/* 全不勾时禁止开跑（v2.3.38）：此前会静默跳过所有探针、什么都不测却报告结果，
                    用户误以为「探针判定全部不支持」 */}
                {!detectOpts.images && !detectOpts.tools && !detectOpts.json && !detectOpts.nsfw && !detectOpts.thinkLevel && (
                  <div style={{ fontSize: 12, color: 'var(--color-danger, #e06c75)', marginBottom: 8 }}>
                    {t('settings.detectNeedOne')}
                  </div>
                )}
                <div className="row-actions">
                  <button
                    className="btn-primary"
                    disabled={detectingAll || (!detectOpts.images && !detectOpts.tools && !detectOpts.json && !detectOpts.nsfw && !detectOpts.thinkLevel)}
                    onClick={() => {
                      setDetectOptsOpen(false);
                      detectAllModels(detectOpts);
                    }}
                  >
                    {t('settings.detectStart')}
                  </button>
                  <button className="btn-ghost" onClick={() => setDetectOptsOpen(false)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ===== MCP 服务器（v2.3.17 新增）：stdio 接入，工具注入 supportsTools 模型的非流式请求 ===== */}
        <div id="sec-mcp" className="section-title" style={{ marginTop: 18 }}>{t('settings.mcp')}<Hint text={t('settings.mcpDesc')} /></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => void refreshMcpStatus()}>
            {t('settings.mcpRefresh')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.mcpToolCount', { n: mcpStatusList.reduce((a, s2) => a + (s2.enabled ? s2.tools.length : 0), 0) })}
          </span>
        </div>
        {mcpStatusList.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {mcpStatusList.map((sv) => (
              <div key={sv.key} className="theme-card" style={{ maxWidth: 560, padding: '8px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto',
                      background: !sv.enabled ? '#8a8f9c' : sv.status === 'connected' ? '#4caf72' : '#e06c75',
                    }}
                    title={sv.error || sv.status}
                  />
                  <strong style={{ fontSize: 13 }}>{sv.key}</strong>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sv.command}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {sv.enabled ? t('settings.mcpTools', { n: sv.tools.length }) : t('settings.mcpDisabled')}
                  </span>
                  <input
                    type="checkbox"
                    checked={sv.enabled}
                    onChange={async (e) => {
                      await api.mcpToggle(sv.key, e.target.checked);
                      void refreshMcpStatus();
                    }}
                    title={t('settings.mcpToggleTitle')}
                  />
                  <button
                    className="btn-ghost"
                    style={{ padding: '2px 8px', fontSize: 12, color: '#e06c75' }}
                    onClick={async () => {
                      await api.mcpRemove(sv.key);
                      void refreshMcpStatus();
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
                {sv.error && <div style={{ fontSize: 12, color: '#e06c75', marginTop: 4 }}>{sv.error}</div>}
                {sv.enabled && sv.tools.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                    {sv.tools.map((tl: { name: string }) => tl.name).join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {/* 添加 MCP 服务器 */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', maxWidth: 640 }}>
          <input placeholder={t('settings.mcpNamePh')} value={mcpDraft.key} onChange={(e) => setMcpDraft({ ...mcpDraft, key: e.target.value })} style={{ width: 130 }} />
          <input placeholder={t('settings.mcpCmdPh')} value={mcpDraft.command} onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })} style={{ width: 200 }} />
          <input placeholder={t('settings.mcpArgsPh')} value={mcpDraft.args} onChange={(e) => setMcpDraft({ ...mcpDraft, args: e.target.value })} style={{ width: 180 }} />
          <button
            className="btn-primary"
            style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={async () => {
              try {
                await api.mcpAdd({
                  key: mcpDraft.key,
                  config: {
                    command: mcpDraft.command.trim(),
                    args: mcpDraft.args.trim() ? mcpDraft.args.trim().split(/\s+/) : [],
                  },
                });
                setMcpDraft({ key: '', command: '', args: '' });
                showToast(t('settings.mcpAdded'));
                void refreshMcpStatus();
              } catch (e: any) {
                showToast(e?.message || String(e), { error: true });
              }
            }}
          >
            {t('settings.mcpAdd')}
          </button>
        <Hint text={t('settings.mcpAddDesc')} /></div>

        {/* ==========================================================================
            v2.3.94 需求 7：TTS / ASR / 生图 / 生视频 移入「模型设置」分区
            ==========================================================================
            为什么移：文本模型本来就在模型设置里，这四类服务的「Base URL / API Key / 模型」
            性质完全相同，却曾散落在「生成」分类下，导致用户配模型时找不到配TTS 的地方。
            移过来之后，「模型设置」= 所有 AI 能力的接入点，一处配齐。
            注意：以下四段内部仍使用 voice / imageGen / videoGen 的**扁平兼容字段**读写
            （如voice.ttsBaseUrl），改动仍即时落盘；多配置数组是唯一真源，
            由主进程 syncActiveMediaConfigs() 回写扁平字段，后端调用点零改动。*/}

        {/* ---------- 语音功能总入口（锚点：兼容旧搜索条目 sec-voice） ---------- */}
        <div id="sec-voice" className="section-title" style={{ marginTop: 20 }}>
          {t('settings.voice')}
          <Hint text={t('settings.mcfgMovedDesc')} />
        </div>

        {/* ---------- ASR（语音输入）多配置 ---------- */}
        <MediaApiConfigEditor
          kind="asr"
          sectionId="sec-asr"
          titleKey="settings.mcfg.asrTitle"
          hintKey="settings.asrDesc"
          configs={asrConfigs}
          activeId={voice.activeAsrId}
          onChange={patchAsrConfigs}
          modelPlaceholderKey="settings.mcfg.asrModelPh"
          modelOptions={asrModelList}
          refreshing={!!modelLoading.asr}
          onRefreshModels={(c) => void refreshModelList('asr', c.baseUrl, c.apiKey)}
        />

        {/* ---------- TTS（文本转语音）多配置 ---------- */}
        <MediaApiConfigEditor
          kind="tts"
          sectionId="sec-tts"
          titleKey="settings.mcfg.ttsTitle"
          hintKey="settings.ttsDesc"
          configs={ttsConfigs}
          activeId={voice.activeTtsId}
          onChange={patchTtsConfigs}
          showVoiceList
          roleBind
          modelOptions={ttsModelList}
          refreshing={!!modelLoading.tts}
          onRefreshModels={(c) => void refreshModelList('tts', c.baseUrl, c.apiKey)}
          voiceOptions={voiceOptions}
        />

        {/* ---------- TTS 全局朗读行为（自动播报 / 范围 / 缓存） ---------- */}
        <div id="sec-ttsplay" className="section-title" style={{ marginTop: 18 }}>
          {t('settings.mcfg.ttsPlayTitle')}
          <Hint text={t('settings.mcfg.ttsPlayDesc')} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: activeTtsReady ? 'pointer' : 'not-allowed',
            }}
          >
            <input
              type="checkbox"
              checked={!!voice.ttsAutoPlay}
              disabled={!activeTtsReady}
              onChange={(e) => patchVoice({ ttsAutoPlay: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.ttsAutoPlay')}</span>
          </label>
          {!activeTtsReady && (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.mcfg.noActiveTts')}
            </div>
          )}

          {/* 朗读范围（全局）：对话 / 旁白 / 人物心理，默认仅对话 */}
          <div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {t('settings.ttsScopes')}
              <Hint text={t('settings.ttsScopeDesc')} />
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {([
                ['dialogue', 'settings.ttsScopeDialogue'],
                ['narration', 'settings.ttsScopeNarration'],
                ['psyche', 'settings.ttsScopePsyche'],
              ] as const).map(([k, key]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={k === 'dialogue' ? voice.ttsScopes?.dialogue !== false : !!voice.ttsScopes?.[k]}
                    onChange={(e) =>
                      patchVoice({
                        ttsScopes: {
                          dialogue: voice.ttsScopes?.dialogue !== false,
                          narration: !!voice.ttsScopes?.narration,
                          psyche: !!voice.ttsScopes?.psyche,
                          [k]: e.target.checked,
                        },
                      })
                    }
                  />
                  {t(key)}
                </label>
              ))}
            </div>
          </div>

          {/* 朗读缓存：默认复用已合成音频，重复朗读不消耗 token */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!voice.ttsRegenerate}
              onChange={(e) => patchVoice({ ttsRegenerate: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>
              {t('settings.ttsRegenerate')}
              <Hint text={t('settings.ttsRegenerateDesc')} />
            </span>
          </label>

          {/* ===== 语速 / 音调（由提供商原生参数实现，仅对支持该参数的协议生效） ===== */}
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              {t('settings.ttsSpeedPitch')}
              <Hint text={t('settings.ttsSpeedPitchDesc')} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 420 }}>
              <span style={{ fontSize: 13, minWidth: 56 }}>{t('settings.ttsSpeed')}</span>
              <input
                type="range"
                min={TTS_SPEED_MIN}
                max={TTS_SPEED_MAX}
                step={0.05}
                value={voice.ttsSpeed ?? TTS_SPEED_DEFAULT}
                onChange={(e) => patchVoice({ ttsSpeed: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 52, textAlign: 'right' }}>
                {(voice.ttsSpeed ?? TTS_SPEED_DEFAULT).toFixed(2)}×
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 420, marginTop: 6 }}>
              <span style={{ fontSize: 13, minWidth: 56 }}>{t('settings.ttsPitch')}</span>
              <input
                type="range"
                min={TTS_PITCH_MIN}
                max={TTS_PITCH_MAX}
                step={1}
                value={voice.ttsPitch ?? TTS_PITCH_DEFAULT}
                onChange={(e) => patchVoice({ ttsPitch: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 52, textAlign: 'right' }}>
                {(voice.ttsPitch ?? TTS_PITCH_DEFAULT) > 0 ? '+' : ''}
                {voice.ttsPitch ?? TTS_PITCH_DEFAULT}
              </span>
            </div>
          </div>

          {/* ===== 已适配的 TTS 提供商（用户明令：界面需列出当前支持的提供商） ===== */}
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              {t('settings.ttsProviders')}
              <Hint text={t('settings.ttsProvidersDesc')} />
            </div>
            <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.ttsProvidersLegend')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
              {TTS_PROVIDERS.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    padding: '6px 8px',
                    borderRadius: 8,
                    background: 'var(--color-panel-alt)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{p.nameKey ? t(p.nameKey) : p.name}</span>
                  <Hint text={t(p.noteKey)} />
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{p.match}</span>
                  <span className="tts-prov-badge">
                    {p.site === 'both'
                      ? t('settings.ttsSiteBoth')
                      : p.site === 'cn'
                        ? t('settings.ttsSiteCn')
                        : p.site === 'intl'
                          ? t('settings.ttsSiteIntl')
                          : t('settings.ttsSiteGlobal')}
                  </span>
                  <span className={`tts-prov-badge${p.speed ? ' on' : ''}`}>
                    {t('settings.ttsSpeed')} {p.speed ? '✓' : '✕'}
                  </span>
                  <span className={`tts-prov-badge${p.pitch ? ' on' : ''}`}>
                    {t('settings.ttsPitch')} {p.pitch ? '✓' : '✕'}
                  </span>
                  <span className={`tts-prov-badge${p.voiceList ? ' on' : ''}`}>
                    {t('settings.ttsVoiceListShort')} {p.voiceList ? '✓' : '✕'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ---------- 人物音色绑定（v2.3.94 需求 8/9：已迁移到角色卡编辑器）----------
            这里不再渲染第二套可编辑表单：两处并存会让用户困惑，且可能互相覆盖
            settings.voice.ttsVoices[roleId]。设置页只保留一个跳转入口。 */}
        <div id="sec-ttsrole" className="section-title" style={{ marginTop: 18 }}>
          {t('settings.ttsVoicePerRole')}
          <Hint text={t('settings.ttsVoicePerRoleDesc')} />
        </div>
        <button
          type="button"
          className="btn-ghost"
          style={{ maxWidth: 420 }}
          onClick={() => onGoToContacts?.()}
          disabled={!onGoToContacts}
        >
          {t('settings.ttsPerRoleGoRoleCard')}
        </button>
        <div className="field-hint" style={{ maxWidth: 560 }}>
          {t('settings.ttsPerRoleGoRoleCardDesc')}
        </div>

        {/* ---------- 生图多配置 ---------- */}
        <div id="sec-imagegen" className="section-title" style={{ marginTop: 20 }}>
          {t('settings.imageGen')}
          <Hint text={t('settings.imageGenDesc')} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={!!imageGen.enabled}
            onChange={(e) => patchImageGen({ enabled: e.target.checked })}
          />
          <span style={{ fontSize: 13 }}>{t('settings.imageGenEnabled')}</span>
        </label>
        <MediaApiConfigEditor
          kind="image"
          sectionId="sec-imgcfg"
          titleKey="settings.mcfg.imageTitle"
          configs={imageConfigs}
          activeId={imageGen.activeImageId}
          onChange={patchImageConfigs}
          sizeLabelKey="settings.imageGenSize"
          sizeHintKey="settings.imageGenSizeDesc"
          modelPlaceholderKey="settings.imageGenModelPlaceholder"
          modelOptions={imgModelList}
          refreshing={!!modelLoading.img}
          onRefreshModels={(c) => void refreshModelList('img', c.baseUrl, c.apiKey)}
        />

        {/* ---------- 生视频多配置 ---------- */}
        <div id="sec-videogen" className="section-title" style={{ marginTop: 20 }}>
          {t('settings.videoGen')}
          <Hint text={t('settings.videoGenDesc')} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={!!videoGen.enabled}
            onChange={(e) => patchVideoGen({ enabled: e.target.checked })}
          />
          <span style={{ fontSize: 13 }}>{t('settings.videoGenEnabled')}</span>
        </label>
        <MediaApiConfigEditor
          kind="video"
          sectionId="sec-vidcfg"
          titleKey="settings.mcfg.videoTitle"
          configs={videoConfigs}
          activeId={videoGen.activeVideoId}
          onChange={patchVideoConfigs}
          showDuration
          sizeLabelKey="settings.videoGenSize"
          sizeHintKey="settings.videoGenSizeDesc"
          modelPlaceholderKey="settings.imageGenModelPlaceholder"
          modelOptions={imgModelList}
          refreshing={!!modelLoading.img}
          onRefreshModels={(c) => void refreshModelList('img', c.baseUrl, c.apiKey)}
        />

        </div>{/* end cat-models */}
        </>)}
        {!onlyModels && (<>
        <div id="cat-appearance" ref={(el) => { catRefs.current['cat-appearance'] = el; }} className="settings-category">
        {/* ===== 字体（子页面入口） ===== */}
        <div id="sec-font" className="section-title" style={{ marginTop: 16 }}>{t('settings.font')}</div>
        <div
          className="theme-card"
          style={{ cursor: 'pointer', maxWidth: 420 }}
          onClick={() => setSub('font')}
        >
          <div
            className="theme-swatch"
            style={{ background: 'linear-gradient(135deg,#7a869a,#a0abc0)' }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>{t('settings.font')}<Hint text={t('settings.fontEnter')} /></div>
            </div>
          </div>
        <div id="sec-theme" className="section-title">{t('settings.theme')}</div>
        <div className="theme-options">
          {THEMES.map((titem) => (
            <div
              key={titem.key}
              className={`theme-card ${theme === titem.key ? 'active' : ''}`}
              onClick={() => {
                setTheme(titem.key);
                patch({ theme: titem.key });
              }}
            >
              <div className="theme-swatch" style={{ background: titem.swatch }} />
              <div>
                <div style={{ fontWeight: 600 }}>{t(titem.nameKey)}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {theme === titem.key ? t('settings.current') : t('settings.clickSwitch')}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ===== UI 圆角 ===== */}
        <div id="sec-radius" className="section-title">{t('settings.radius')}<Hint text={t('settings.radiusDesc')} /></div>
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            {t('settings.uiRadius', { n: draft.uiRadius ?? 10 })}
          </div>
          <input
            type="range"
            min={0}
            max={28}
            step={1}
            value={draft.uiRadius ?? 10}
            style={{ width: '100%' }}
            onChange={(e) => {
              const v = Number(e.target.value);
              patch({ uiRadius: v });
              // 实时预览
              document.documentElement.style.setProperty('--radius', `${v}px`);
              document.documentElement.style.setProperty(
                '--radius-sm',
                `${Math.max(2, Math.round(v * 0.6))}px`
              );
            }}
          />
          <div style={{ fontSize: 13, margin: '10px 0 4px' }}>
            {t('settings.bubbleRadius', { n: draft.bubbleRadius ?? 10 })}
          </div>
          <input
            type="range"
            min={0}
            max={28}
            step={1}
            value={draft.bubbleRadius ?? 10}
            style={{ width: '100%' }}
            onChange={(e) => {
              const v = Number(e.target.value);
              patch({ bubbleRadius: v });
              document.documentElement.style.setProperty('--bubble-radius', `${v}px`);
            }}
          />
          <div style={{ fontSize: 13, margin: '10px 0 4px' }}>
            {t('settings.bubbleOpacity')}<Hint text={t('settings.bubbleOpacityDesc')} />
          </div>
          <input
            type="range"
            min={50}
            max={100}
            step={5}
            value={draft.bubbleOpacity ?? 100}
            style={{ width: '100%' }}
            onChange={(e) => {
              const v = Number(e.target.value);
              patch({ bubbleOpacity: v });
              document.documentElement.style.setProperty('--bubble-opacity', String(v / 100));
            }}
          />
        </div>

        {/* ===== 窗口整体等比缩放：基准尺寸 + 上下限（主窗/小窗分别配置） ===== */}
        <div id="sec-uizoom" className="section-title" style={{ marginTop: 16 }}>
          {t('settings.uiZoom')}<Hint text={t('settings.uiZoomDesc')} />
        </div>
        <div style={{ maxWidth: 480 }}>
          {(() => {
            const z = draft.uiZoom || DEFAULT_SETTINGS.uiZoom!;
            const setZoom = (p: Partial<NonNullable<AppSettings['uiZoom']>>) => {
              const next = { ...z, ...p };
              patch({ uiZoom: next });
              api.saveSettings({ uiZoom: next }).then(reloadSettings);
            };
            const field = (
              label: string,
              val: number,
              mn: number,
              mx: number,
              st: number,
              keyName: keyof NonNullable<AppSettings['uiZoom']>
            ) => (
              <label className="zoom-field" key={keyName}>
                <span>{label}</span>
                <input
                  type="number"
                  min={mn}
                  max={mx}
                  step={st}
                  value={val}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v)) setZoom({ [keyName]: v } as Partial<NonNullable<AppSettings['uiZoom']>>);
                  }}
                />
              </label>
            );
            return (
              <>
                <div className="zoom-group">{t('settings.uiZoomMain')}</div>
                <div className="zoom-grid">
                  {field(t('settings.zoomBaseW'), z.mainBaseW, 200, 4000, 10, 'mainBaseW')}
                  {field(t('settings.zoomBaseH'), z.mainBaseH, 200, 4000, 10, 'mainBaseH')}
                  {field(t('settings.zoomMin'), z.mainMin, 0.5, 3, 0.05, 'mainMin')}
                  {field(t('settings.zoomMax'), z.mainMax, 0.5, 3, 0.05, 'mainMax')}
                </div>
                <div className="zoom-group">{t('settings.uiZoomMini')}</div>
                <div className="zoom-grid">
                  {field(t('settings.zoomBaseW'), z.miniBaseW, 100, 2000, 10, 'miniBaseW')}
                  {field(t('settings.zoomBaseH'), z.miniBaseH, 100, 2000, 10, 'miniBaseH')}
                  {field(t('settings.zoomMin'), z.miniMin, 0.5, 3, 0.05, 'miniMin')}
                  {field(t('settings.zoomMax'), z.miniMax, 0.5, 3, 0.05, 'miniMax')}
                </div>
              </>
            );
          })()}
        </div>

        {/* ===== 输入框外观（文字色 / 背景色）===== */}
        <div id="sec-inputappearance" className="section-title">{t('settings.inputAppearance')}<Hint text={t('settings.inputColorDesc')} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13 }}>{t('settings.inputBgColor')}</span>
              <input
                type="color"
                value={draft.inputBgColor || '#f2f3f5'}
                onChange={(e) => patch({ inputBgColor: e.target.value })}
                style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13 }}>{t('settings.inputTextColor')}</span>
              <input
                type="color"
                value={draft.inputTextColor || '#1f2329'}
                onChange={(e) => patch({ inputTextColor: e.target.value })}
                style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }}
              />
            </label>
            <button type="button" className="btn-ghost" onClick={() => patch({ inputBgColor: '', inputTextColor: '' })}>
              {t('settings.resetColor')}
            </button>
          </div>
          {/* 预览：实时反映当前配色下的对比度，便于判断文字是否清晰 */}
          <div
            style={{
              marginTop: 4,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--color-border)',
              background: draft.inputBgColor || '#f2f3f5',
              color: draft.inputTextColor || '#1f2329',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {t('settings.inputPreview')}
          </div>
        </div>

        {/* ===== 动态 Canvas 光标 ===== */}
        <div id="sec-cursor" className="section-title">{t('settings.cursor')}<Hint text={t('settings.cursorDesc')} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!cursor.enabled}
              onChange={(e) => {
                patchCursor({ enabled: e.target.checked });
                api.saveSettings({ customCursor: { ...cursor, enabled: e.target.checked } }).then(reloadSettings);
              }}
            />
            <span style={{ fontSize: 13 }}>{t('settings.cursorEnabled')}</span>
          </label>
          {cursor.enabled && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{t('settings.cursorLerpSpeed')}</span>
                <input
                  type="range"
                  min={10}
                  max={50}
                  step={1}
                  value={Math.round((cursor.lerpSpeed ?? 0.25) * 100)}
                  onChange={(e) => saveCursor({ lerpSpeed: Number(e.target.value) / 100 })}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 36, textAlign: 'right' }}>
                  {(cursor.lerpSpeed ?? 0.25).toFixed(2)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('settings.cursorLerpSpeedDesc')}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cursor.trailEnabled !== false}
                  onChange={(e) => saveCursor({ trailEnabled: e.target.checked })}
                />
                <span style={{ fontSize: 13 }}>{t('settings.cursorTrail')}</span>
              </label>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 24 }}>
                {t('settings.cursorTrailDesc')}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cursor.particlesEnabled !== false}
                  onChange={(e) => saveCursor({ particlesEnabled: e.target.checked })}
                />
                <span style={{ fontSize: 13 }}>{t('settings.cursorParticles')}</span>
              </label>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 24 }}>
                {t('settings.cursorParticlesDesc')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{t('settings.cursorHoverScale')}</span>
                <input
                  type="range"
                  min={100}
                  max={150}
                  step={5}
                  value={Math.round((cursor.hoverScale ?? 1.25) * 100)}
                  onChange={(e) => saveCursor({ hoverScale: Number(e.target.value) / 100 })}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 36, textAlign: 'right' }}>
                  {(cursor.hoverScale ?? 1.25).toFixed(2)}x
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('settings.cursorHoverScaleDesc')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{t('settings.cursorIdleHide')}</span>
                <input
                  type="range"
                  min={1}
                  max={300}
                  step={1}
                  value={Math.max(1, Math.round((cursor.idleHideMs ?? 5000) / 1000))}
                  onChange={(e) => saveCursor({ idleHideMs: Number(e.target.value) * 1000 })}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 48, textAlign: 'right' }}>
                  {Math.max(1, Math.round((cursor.idleHideMs ?? 5000) / 1000))}s
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('settings.cursorIdleHideDesc')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{t('settings.cursorSize')}</span>
                <input
                  type="range"
                  min={16}
                  max={64}
                  step={1}
                  value={cursor.cursorSize ?? 28}
                  onChange={(e) => saveCursor({ cursorSize: Number(e.target.value) })}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 36, textAlign: 'right' }}>
                  {cursor.cursorSize ?? 28}px
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {t('settings.cursorSizeDesc')}
              </div>

              {/* 热点（点击位置）设置：左侧可拖动预览，右侧滑块微调 */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
                <div style={{ flexShrink: 0 }}>
                  <CursorHotspotPreview
                    hotspotX={cursor.hotspotX ?? 1}
                    hotspotY={cursor.hotspotY ?? 1}
                    onChange={(x, y) => saveCursor({ hotspotX: x, hotspotY: y })}
                  />
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4, textAlign: 'center' }}>
                    {t('settings.hotspotPreview')}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.hotspot')}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{t('settings.hotspotX')}</span>
                    <input
                      type="range"
                      min={0}
                      max={28}
                      step={1}
                      value={cursor.hotspotX ?? 1}
                      onChange={(e) => saveCursor({ hotspotX: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 36, textAlign: 'right' }}>
                      {cursor.hotspotX ?? 1}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, whiteSpace: 'nowrap', minWidth: 100 }}>{t('settings.hotspotY')}</span>
                    <input
                      type="range"
                      min={0}
                      max={28}
                      step={1}
                      value={cursor.hotspotY ?? 1}
                      onChange={(e) => saveCursor({ hotspotY: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 36, textAlign: 'right' }}>
                      {cursor.hotspotY ?? 1}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                    {t('settings.hotspotDesc')}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ===== 毛玻璃主题背景（仅 glass/frost 主题生效，未开启时隐藏） ===== */}
        {(theme === 'glass' || theme === 'frost') && (
          <>
            <div id="sec-glassbg" className="section-title" style={{ marginTop: 16 }}>{t('settings.glassBg')}<Hint text={t('settings.glassBgDesc')} /></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{t('settings.glassBgColor')}</span>
                  <input
                    type="color"
                    value={draft.glassBgColor || '#6a3aa8'}
                    onChange={(e) => patch({ glassBgColor: e.target.value, glassBgImage: '' })}
                    style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }}
                  />
                </label>
                <button type="button" className="btn-ghost" onClick={importGlassBg}>{t('settings.glassBgImport')}</button>
                <button type="button" className="btn-ghost" onClick={() => patch({ glassBgColor: '', glassBgImage: '' })}>{t('settings.glassBgReset')}</button>
              </div>
              {/* 预览：实时反映当前毛玻璃背景（颜色或图片） */}
              <div
                style={{
                  marginTop: 4,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border)',
                  background: draft.glassBgImage
                    ? `center/cover no-repeat url("${draft.glassBgImage}")`
                    : draft.glassBgColor || 'linear-gradient(135deg,#1e2a78,#6a3aa8,#a1429c)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  minHeight: 48,
                }}
              >
                {t('settings.glassBgPreview')}
              </div>
              {/* 聊天界面颜色覆盖（仅玻璃/frost 生效）：防止自定义背景后字体/边框与背景融合看不清 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{t('settings.glassTokenText')}</span>
                  <input type="color" value={draft.glassTokenText || '#ffffff'} onChange={(e) => patch({ glassTokenText: e.target.value })} style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{t('settings.glassTokenBorder')}</span>
                  <input type="color" value={draft.glassTokenBorder || '#ffffff'} onChange={(e) => patch({ glassTokenBorder: e.target.value })} style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{t('settings.glassBubbleUserText')}</span>
                  <input type="color" value={draft.glassBubbleUserText || '#ffffff'} onChange={(e) => patch({ glassBubbleUserText: e.target.value })} style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{t('settings.glassBubbleAiText')}</span>
                  <input type="color" value={draft.glassBubbleAiText || '#ffffff'} onChange={(e) => patch({ glassBubbleAiText: e.target.value })} style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{t('settings.glassBubbleBorder')}</span>
                  <input type="color" value={draft.glassBubbleBorder || '#ffffff'} onChange={(e) => patch({ glassBubbleBorder: e.target.value })} style={{ width: 42, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </label>
              </div>
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => patch({ glassTokenText: '', glassTokenBorder: '', glassBubbleUserText: '', glassBubbleAiText: '', glassBubbleBorder: '' })}
                >{t('settings.glassColorReset')}</button>
              </div>
            </div>
          </>
        )}
        </div>{/* end cat-appearance */}
        </>)}
        {/* ===== 语音功能（ASR + TTS） ===== */}
        {!onlyModels && (<>
        <div id="cat-generation" ref={(el) => { catRefs.current['cat-generation'] = el; }} className="settings-category">
        {/* ===== v2.3.94 需求 7：TTS / ASR / 生图 / 生视频 的配置表单已移入「模型设置」=====
            原先这四类服务的 API 端点表单散落在本分类下，只能填一套；现在它们与文本模型
            一样支持「多条配置 + 标记当前使用项」，故统一搬到模型设置二级页。
            本分类只保留一张跳转卡片（不再重复渲染表单，避免两处都能改、互相覆盖）。*/}
        <div id="sec-mediastub" className="section-title">{t('settings.catGeneration')}</div>
        <div
          className="theme-card"
          style={{ cursor: 'pointer', maxWidth: 480 }}
          onClick={() => setSub('models')}
        >
          <div
            className="theme-swatch"
            style={{ background: 'linear-gradient(135deg,#4a9eff,#39ff99)' }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>
              {t('settings.mcfgMovedTitle')}
              <Hint text={t('settings.mcfgMovedDesc')} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.mcfgMovedEnter')}
            </div>
          </div>
        </div>

        {/* ===== 异步场景生图 ===== */}
        <div id="sec-sceneimage" className="section-title">{t('settings.sceneImage')}<Hint text={t('settings.sceneImageDesc')} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.sceneImageInterval')}<Hint text={t('settings.sceneImageIntervalDesc')} /></span>
              <span>{Math.round(draft.sceneImageIntervalSec ?? 120)}s</span>
            </div>
            <input
              type="range"
              min={10}
              max={600}
              step={10}
              value={Math.round(draft.sceneImageIntervalSec ?? 120)}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch({ sceneImageIntervalSec: v });
                api.saveSettings({ sceneImageIntervalSec: v });
              }}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.sceneImageJudge')}
            </div>
            <select
              value={draft.sceneImageJudge ?? 'llm'}
              onChange={(e) => {
                const v = e.target.value as 'llm' | 'heuristic';
                patch({ sceneImageJudge: v });
                api.saveSettings({ sceneImageJudge: v });
              }}
              style={{ padding: '6px 8px', borderRadius: 8, width: 260 }}
            >
              <option value="llm">{t('settings.sceneImageJudgeLLM')}</option>
              <option value="heuristic">{t('settings.sceneImageJudgeHeuristic')}</option>
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 4 }}>
            <input
              type="checkbox"
              checked={!!draft.asyncImageUseAvatar}
              onChange={(e) => patch({ asyncImageUseAvatar: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.asyncImageUseAvatar')}<Hint text={t('settings.asyncImageUseAvatarDesc')} /></span>
          </label>

          {/* ===== 自动生图 / 生视频调用确认（仅自动流程生效，手动不受影响） ===== */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('settings.autoGenConfirm')}<Hint text={t('settings.autoGenConfirmDesc')} /></div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.confirmBeforeAutoImage !== false}
                onChange={(e) => {
                  patch({ confirmBeforeAutoImage: e.target.checked });
                  api.saveSettings({ confirmBeforeAutoImage: e.target.checked });
                }}
              />
              <span style={{ fontSize: 13 }}>{t('settings.confirmBeforeAutoImage')}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 4 }}>
              <input
                type="checkbox"
                checked={draft.confirmBeforeAutoVideo !== false}
                onChange={(e) => {
                  patch({ confirmBeforeAutoVideo: e.target.checked });
                  api.saveSettings({ confirmBeforeAutoVideo: e.target.checked });
                }}
              />
              <span style={{ fontSize: 13 }}>{t('settings.confirmBeforeAutoVideo')}</span>
            </label>
          </div>
        </div>

        {/* ===== 联网搜索 ===== */}
        <div id="sec-websearch" className="section-title">{t('settings.webSearch')}<Hint text={t('settings.webSearchDesc')} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.searchProvider')}
            </div>
            <select
              value={draft.searchProvider ?? 'auto'}
              onChange={(e) => {
                const v = e.target.value as AppSettings['searchProvider'];
                patch({ searchProvider: v });
                api.saveSettings({ searchProvider: v });
              }}
              style={{ padding: '6px 8px', borderRadius: 8, width: 320 }}
            >
              <option value="auto">{t('settings.searchProviderAuto')}</option>
              <option value="bing">{t('settings.searchProviderBing')}</option>
              <option value="baidu">{t('settings.searchProviderBaidu')}</option>
              <option value="duckduckgo">{t('settings.searchProviderDuckduckgo')}</option>
              <option value="tavily">{t('settings.searchProviderTavily')}</option>
              <option value="serpapi">{t('settings.searchProviderSerpapi')}</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.searchApiKey')}<Hint text={t('settings.searchApiKeyHint')} />
            </div>
            <input
              type="password"
              placeholder={t('settings.apiKey')}
              value={draft.searchApiKey ?? ''}
              style={{ width: 320 }}
              onChange={(e) => {
                const v = e.target.value;
                patch({ searchApiKey: v });
                api.saveSettings({ searchApiKey: v });
              }}
            />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
            <input
              type="checkbox"
              checked={!!draft.webSearchFetchPages}
              onChange={(e) => {
                const v = e.target.checked;
                patch({ webSearchFetchPages: v });
                api.saveSettings({ webSearchFetchPages: v });
              }}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.webSearchFetchPages')}<Hint text={t('settings.webSearchFetchPagesDesc')} /></div>
            </div>
          </label>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 4 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                {t('settings.webSearchFetchCount')}
              </div>
              <input
                type="number"
                min={1}
                max={6}
                value={draft.webSearchFetchCount ?? 5}
                style={{ width: 120, padding: '6px 8px', borderRadius: 8 }}
                onChange={(e) => {
                  const v = Math.min(6, Math.max(1, Number(e.target.value) || 5));
                  patch({ webSearchFetchCount: v });
                  api.saveSettings({ webSearchFetchCount: v });
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                {t('settings.webSearchFetchTimeout')}
              </div>
              <input
                type="number"
                min={2000}
                max={20000}
                step={1000}
                value={draft.webSearchFetchTimeout ?? 8000}
                style={{ width: 140, padding: '6px 8px', borderRadius: 8 }}
                onChange={(e) => {
                  const v = Math.min(20000, Math.max(2000, Number(e.target.value) || 8000));
                  patch({ webSearchFetchTimeout: v });
                  api.saveSettings({ webSearchFetchTimeout: v });
                }}
              />
            </div>
          </div>
        </div>

        {/* ===== 插件 ===== */}
        <div id="sec-plugins" className="section-title">{t('settings.plugins')}<Hint text={t('settings.pluginsDesc')} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: 'pointer',
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(255,80,80,0.08)',
              border: '1px solid rgba(255,80,80,0.3)',
            }}
          >
            <input
              type="checkbox"
              checked={!!draft.pluginAllowJs}
              onChange={(e) => {
                const v = e.target.checked;
                patch({ pluginAllowJs: v });
                api.saveSettings({ pluginAllowJs: v });
              }}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#ff8a8a' }}>
                {t('settings.pluginAllowJs')}<Hint text={t('settings.pluginAllowJsDesc')} />
              </div>
            </div>
          </label>

          <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.pluginManage')}</div>
          {plugins.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('settings.pluginEmpty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {plugins.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--color-bg-elevated, rgba(255,255,255,0.05))',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      {p.source}
                      {p.description ? ` · ${p.description}` : ''}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={!!p.enabled}
                      onChange={async (e) => {
                        await api.togglePlugin(p.id, e.target.checked);
                        refreshPlugins();
                      }}
                    />
                    {p.enabled ? t('settings.pluginEnabled') : t('settings.pluginDisabled')}
                  </label>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    onClick={async () => {
                      await api.removePlugin(p.id);
                      refreshPlugins();
                    }}
                  >
                    {t('settings.pluginRemove')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ===== 技能（Skill，v2.3.92）——纯指令注入，不执行脚本 ===== */}
        <div id="sec-skills" className="section-title" style={{ marginTop: 18 }}>
          {t('skill.title')}
          <Hint text={t('skill.desc')} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
          {/* 安全边界常驻展示：技能是「说明书」，不是可执行程序 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '9px 12px',
              borderRadius: 8,
              background: 'rgba(90,140,255,0.10)',
              border: '1px solid rgba(90,140,255,0.32)',
              fontSize: 12,
              color: 'var(--color-text-secondary)',
            }}
          >
            <span style={{ fontSize: 13, lineHeight: '18px' }}>🔒</span>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)' }}>
                {t('skill.safetyNotice')}
                <Hint text={t('skill.safetyDetail')} />
              </div>
            </div>
          </div>

          {/* v2.3.93：内置技能说明——常驻告知「随念语内置 / 仅主 SKILL.md / 不执行脚本」 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '9px 12px',
              borderRadius: 8,
              background: 'rgba(120,90,220,0.10)',
              border: '1px solid rgba(140,110,235,0.32)',
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.7,
            }}
          >
            <span style={{ fontSize: 13, lineHeight: '18px' }}>📦</span>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)' }}>
                {t('skill.builtinNotice')}
                <Hint text={t('skill.builtinDetail')} />
              </div>
            </div>
          </div>

          {/* 工具条：导入 + 作用域筛选 + 总数 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => void importSkillFile()}>
              {t('skill.import')}
            </button>
            <select
              value={skillScopeFilter}
              onChange={(e) => setSkillScopeFilter(e.target.value as 'all' | SkillScope)}
              style={{ fontSize: 12, padding: '4px 6px' }}
            >
              <option value="all">{t('skill.filterAll')}</option>
              <option value="global">{t('skill.scopeGlobal')}</option>
              <option value="role">{t('skill.scopeRole')}</option>
              <option value="chat">{t('skill.scopeChat')}</option>
            </select>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('skill.count', { n: skills.length })}
            </span>
          </div>

          {/* 技能包格式说明（供用户照着写 SKILL.md） */}
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 600, color: 'var(--color-text)' }}>{t('skill.format')}</div>
            {t('skill.formatDesc')}
          </div>

          {/* v2.3.93：被删除的内置技能 → 一键恢复入口（「安装即在列表」的可撤销实现） */}
          {dismissedBuiltins.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                padding: '8px 11px',
                borderRadius: 8,
                background: 'var(--color-bg-elevated, rgba(255,255,255,0.05))',
                fontSize: 12,
                color: 'var(--color-text-secondary)',
              }}
            >
              <span>{t('skill.builtinRemoved')}</span>
              {dismissedBuiltins.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '2px 10px', fontSize: 12 }}
                  onClick={() => void restoreBuiltin(b.id, b.name)}
                >
                  {t('skill.restoreBuiltin', { name: b.name })}
                </button>
              ))}
            </div>
          )}

          {visibleSkills.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {skills.length === 0 && dismissedBuiltins.length === 0
                ? t('skill.empty')
                : t('skill.emptyFiltered')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visibleSkills.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '9px 11px',
                    borderRadius: 8,
                    background: 'var(--color-bg-elevated, rgba(255,255,255,0.05))',
                    opacity: s.enabled ? 1 : 0.55,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{s.name}</strong>
                    {/* v2.3.93：内置技能徽标——让用户一眼看出它不是自己导入的 */}
                    {s.builtin && (
                      <span
                        style={{
                          fontSize: 10.5,
                          padding: '1px 7px',
                          borderRadius: 9,
                          whiteSpace: 'nowrap',
                          background: 'rgba(140,110,235,0.20)',
                          color: 'var(--color-text)',
                        }}
                      >
                        {t('skill.builtinBadge')}
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 10.5,
                        padding: '1px 7px',
                        borderRadius: 9,
                        whiteSpace: 'nowrap',
                        background:
                          s.scope === 'global'
                            ? 'rgba(90,140,255,0.18)'
                            : s.scope === 'role'
                              ? 'rgba(80,200,140,0.18)'
                              : 'rgba(230,160,60,0.20)',
                      }}
                    >
                      {s.scope === 'global'
                        ? t('skill.scopeGlobal')
                        : s.scope === 'role'
                          ? t('skill.scopeRole')
                          : t('skill.scopeChat')}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.description}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      {s.enabled ? t('skill.enabled') : t('skill.disabled')}
                    </span>
                    <input
                      type="checkbox"
                      checked={!!s.enabled}
                      onChange={async (e) => {
                        await api.toggleSkill(s.id, e.target.checked);
                        refreshSkills();
                      }}
                    />
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '3px 10px', fontSize: 12, color: '#e06c75' }}
                      onClick={async () => {
                        // 用应用内原生确认框（与项目其他破坏性操作一致），不用浏览器 window.confirm
                        const confirmed = await api.showConfirm!(
                          t('skill.removeConfirm', { name: s.name }),
                          t('skill.title')
                        );
                        if (!confirmed) return;
                        await api.removeSkill(s.id);
                        refreshSkills();
                      }}
                    >
                      {t('skill.remove')}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>
                      {t('skill.scope')}: {s.scope}
                      {(s.roleId || s.chatKey) ? ` · ${t('skill.target')}: ${s.roleId || s.chatKey}` : ''}
                    </span>
                    {s.version ? <span>{t('skill.version')}: {s.version}</span> : null}
                    {/* v2.3.93：内置技能标注来源为「随念语内置」而非来源文件名 */}
                    {s.builtin ? (
                      <span>
                        {t('skill.source')}: {t('skill.builtinSource')}
                      </span>
                    ) : (
                      s.sourceFile ? <span>{t('skill.source')}: {s.sourceFile}</span> : null
                    )}
                  </div>
                  {/* v2.3.93：内置有新版但用户改过正文 → 保留用户版本 + 可一键恢复内置版 */}
                  {s.builtinUpdateAvailable && (
                    <div
                      style={{ fontSize: 11, color: '#e0a83c', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                    >
                      <span>{t('skill.builtinUpdate')}</span>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: '2px 9px', fontSize: 11 }}
                        onClick={() => void restoreBuiltin(s.id, s.name)}
                      >
                        {t('skill.restoreBuiltin', { name: s.name })}
                      </button>
                    </div>
                  )}
                  {s.scriptBlocked && (
                    <div style={{ fontSize: 11, color: '#e0a83c' }}>
                      {t('skill.scriptBlocked', { fields: s.scriptFields || '' })}
                    </div>
                  )}
                  {s.truncated && <div style={{ fontSize: 11, color: '#e0a83c' }}>{t('skill.truncated')}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

          </div>{/* end cat-generation */}
          </>)}
          {/* ===== 翻译（右键消息翻译文本） ===== */}
          {!onlyModels && (<>
        <div id="cat-translation" ref={(el) => { catRefs.current['cat-translation'] = el; }} className="settings-category">
        <div id="sec-translation" className="section-title">{t('settings.translation')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!draft.translationEnabled}
              onChange={(e) => patch({ translationEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.translationEnabled')}<Hint text={t('settings.translationEnabledDesc')} /></span>
          </label>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.translationModel')}<Hint text={t('settings.translationModelDesc')} />
            </div>
            <SelectMenu
              value={draft.translationModelId || ''}
              style={{ width: '100%' }}
              onChange={(v) => patch({ translationModelId: v })}
              options={[
                { value: '', label: t('settings.voiceOff') },
                ...(draft.models || []).map((m) => ({ value: m.id, label: m.name })),
              ]}
            />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.translationLang')}
            </div>
            <SelectMenu
              value={draft.translationLang || 'auto'}
              style={{ width: 200 }}
              onChange={(v) => patch({ translationLang: v as 'auto' | Lang })}
              options={[
                { value: 'auto', label: t('settings.translationLangAuto') },
                ...LANGS.map((l) => ({ value: l.key, label: l.label })),
              ]}
            />
          </div>
        </div>

        {/* ===== 音效 ===== */}
        <div id="sec-sound" className="section-title">{t('settings.sound')}<Hint text={t('settings.soundCustomTip')} /></div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!sound.enabled}
            onChange={(e) => {
              const v = e.target.checked;
              patchSound({ enabled: v });
              api.saveSettings({ sound: { ...sound, enabled: v } }).then(reloadSettings);
              invalidateSoundCache();
            }}
          />
          <span>{t('settings.soundEnabled')}</span>
        </label>
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>{t('settings.soundVolume')}<Hint text={t('settings.soundDesc')} /></span>
            <span>{Math.round((sound.volume ?? 0.7) * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round((sound.volume ?? 0.7) * 100)}
            onChange={(e) => {
              const v = Number(e.target.value) / 100;
              patchSound({ volume: v });
              api.saveSettings({ sound: { ...sound, volume: v } }).then(reloadSettings);
              invalidateSoundCache();
            }}
            style={{ width: '100%', marginTop: 6 }}
          />
        </div>

        {/* 各音效自定义（MP3 / WAV） */}
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
          {SOUND_ROWS.map((row) => {
            const customVal = (sound.custom || ({} as any))[row.type] || null;
            return (
              <div
                key={row.type}
                style={{
                  borderTop: '1px solid var(--color-border, rgba(128,128,128,0.18))',
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t(row.labelKey)}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  {t('settings.soundCurrent')}：{customVal ? customVal : t('settings.soundDefault')}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn-ghost" onClick={() => pickSound(row.type)}>
                    {t('settings.soundPick')}
                  </button>
                  <button className="btn-ghost" onClick={() => previewSoundType(row.type)}>
                    {t('settings.soundPreview')}
                  </button>
                  <button className="btn-ghost" onClick={() => resetSound(row.type)} disabled={!customVal}>
                    {t('settings.soundReset')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        </div>{/* end cat-translation */}
        </>)}
        {/* ===== 快捷聊天小窗 ===== */}
        {!onlyModels && (<>
        <div id="cat-window" ref={(el) => { catRefs.current['cat-window'] = el; }} className="settings-category">
        <div id="sec-mini" className="section-title">{t('settings.mini')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!mini.enabled}
              onChange={(e) => patchMini({ enabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.miniEnable')}</span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{t('settings.miniHotkey')}</span>
            <input
              type="text"
              value={mini.hotkey}
              placeholder="CommandOrControl+Shift+Z"
              style={{ flex: 1 }}
              onChange={(e) => patchMini({ hotkey: e.target.value })}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!mini.autoPopupOnMinimize}
              onChange={(e) => patchMini({ autoPopupOnMinimize: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.miniAutoPopup')}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!mini.alwaysOnTop}
              onChange={(e) => patchMini({ alwaysOnTop: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.miniOnTop')}</span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{t('settings.miniDefaultChat')}<Hint text={t('settings.miniDesc')} /></span>
            <SelectMenu
              value={mini.defaultChat}
              style={{ flex: 1 }}
              onChange={(v) => patchMini({ defaultChat: v })}
              options={[
                { value: '', label: t('settings.miniDefaultRecent') },
                ...chatList.map((c) => ({
                  value: `${c.chat_type}:${c.chat_id}`,
                  label: `${c.chat_type === 'group' ? '👥 ' : '👤 '}${c.name}`,
                })),
              ]}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={() => api.miniOpen()}>
              {t('settings.miniOpenNow')}
            </button>
          </div>
        </div>

        {/* ===== 桌面悬浮球 ===== */}
        <div id="sec-floatingball" className="section-title" style={{ marginTop: 24 }}>{t('settings.floatingBall')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!floating.enabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                patch({ floatingBall: { enabled, x: floating.x, y: floating.y, coordVer: floating.coordVer } });
                if (api?.ballSetEnabled) api.ballSetEnabled(enabled);
              }}
            />
            <span style={{ fontSize: 13 }}>{t('settings.floatingBallEnable')}<Hint text={t('settings.floatingBallDesc')} /></span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 4 }}>
            <input
              type="checkbox"
              checked={floating.alwaysOnTop !== false}
              onChange={(e) => {
                const v = e.target.checked;
                patch({
                  floatingBall: {
                    enabled: floating.enabled,
                    x: floating.x,
                    y: floating.y,
                    alwaysOnTop: v,
                    autoHideInFullscreen: floating.autoHideInFullscreen !== false,
                    coordVer: floating.coordVer,
                  },
                });
                if (api?.ballSetAlwaysOnTop) api.ballSetAlwaysOnTop(v);
              }}
            />
            <span style={{ fontSize: 13 }}>{t('settings.floatingBallAlwaysOnTop')}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 4 }}>
            <input
              type="checkbox"
              checked={floating.autoHideInFullscreen !== false}
              onChange={(e) => {
                const v = e.target.checked;
                patch({
                  floatingBall: {
                    enabled: floating.enabled,
                    x: floating.x,
                    y: floating.y,
                    alwaysOnTop: floating.alwaysOnTop !== false,
                    autoHideInFullscreen: v,
                    coordVer: floating.coordVer,
                  },
                });
              }}
            />
            <span style={{ fontSize: 13 }}>{t('settings.floatingBallAutoHideFullscreen')}<Hint text={t('settings.floatingBallAutoHideDesc')} /></span>
          </label>
          <button
            type="button"
            className="btn-ghost"
            style={{ marginTop: 10, padding: '4px 12px', fontSize: 12 }}
            onClick={() => setGuideOpen(true)}
          >
            {t('settings.openGuide')}
          </button>
        </div>

        {/* ===== 应用数据保存路径（实时数据，非备份） ===== */}
        <div id="sec-datapath" className="section-title" style={{ marginTop: 24 }}>{t('settings.dataPath')}</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
          {t('settings.dataPathDesc')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, maxWidth: 760, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{t('settings.dataPathCurrent')}</span>
          <input
            type="text"
            readOnly
            value={dataPathInfo.current || t('common.loading')}
            style={{ flex: 1, minWidth: 240, fontSize: 12, color: dataPathInfo.current ? undefined : 'var(--color-text-secondary)' }}
          />
          <button className="btn-ghost" onClick={pickDataPath} disabled={dataPathBusy}>
            {t('settings.dataPathPick')}
          </button>
          {dataPathInfo.custom && (
            <button className="btn-ghost" onClick={resetDataPath} disabled={dataPathBusy}>
              {t('settings.dataPathReset')}
            </button>
          )}
        </div>
        {!dataPathInfo.custom && (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.dataPathDefault')}：{dataPathInfo.def}
          </div>
        )}

        {/* ===== 关闭主界面行为 ===== */}
        <div id="sec-closebehavior" className="section-title" style={{ marginTop: 24 }}>{t('settings.closeBehavior')}</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
          {t('settings.closeBehaviorDesc')}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={draft.closeToTray !== false}
              onChange={() => patch({ closeToTray: true })}
            />
            {t('settings.closeToTray')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={draft.closeToTray === false}
              onChange={() => patch({ closeToTray: false })}
            />
            {t('settings.closeExit')}
          </label>
        </div>

        {/* ===== 错误日志 ===== */}
        <div id="sec-errorlog" className="section-title" style={{ marginTop: 24 }}>{t('settings.errorLog')}</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
          {t('settings.errorLogDesc')}
        </div>
        <button className="btn-ghost" onClick={openErrorLog}>
          {t('settings.errorLogBtn')}
          {errorLog.length > 0 && (
            <span style={{ marginLeft: 6, color: '#e06c75' }}>({errorLog.length})</span>
          )}
        </button>

        {/* ===== 数据备份与还原 ===== */}
        <div id="sec-backup" className="section-title" style={{ marginTop: 24 }}>{t('settings.backup')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, maxWidth: 560 }}>
          <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{t('settings.backupDir')}</span>
          <input
            type="text"
            readOnly
            value={draft.backupDir || t('settings.backupDirUnset')}
            style={{ flex: 1, fontSize: 12, color: draft.backupDir ? undefined : 'var(--color-text-secondary)' }}
          />
          <button className="btn-ghost" onClick={chooseBackupDir} disabled={busy}>
            {t('settings.backupDirPick')}
          </button>
          {draft.backupDir && (
            <button className="btn-ghost" onClick={clearBackupDir} disabled={busy}>
              {t('settings.backupDirClear')}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={backup} disabled={busy}>
            {t('settings.backupBtn')}
          </button>
          {draft.backupDir && (
            <button className="btn-primary" onClick={exportBackup} disabled={busy}>
              {t('settings.exportBtn')}
            </button>
          )}
          <button className="btn-ghost" onClick={restore} disabled={busy} style={{ color: '#e06c75' }}>
            {t('settings.restoreBtn')}
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {t('settings.backupDesc')}
          {draft.lastBackupTime && (
            <>
              {' '}
              {t('settings.lastBackup', { time: new Date(draft.lastBackupTime).toLocaleString(loc) })}
            </>
          )}
        </div>

        {/* ===== 一键恢复初始设置 ===== */}
        <div id="sec-reset" className="section-title" style={{ marginTop: 24 }}>{t('settings.resetSettings')}</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
          {t('settings.resetSettingsDesc')}
        </div>
        <div className="row-actions" style={{ marginTop: 0 }}>
          <button className="btn-ghost" onClick={() => setResetOpen(true)}>
            {t('settings.resetSettingsBtn')}
          </button>
          <button
            className="btn-ghost"
            style={{ marginLeft: 8, border: '1px solid #e06c75', color: '#e06c75' }}
            onClick={() => setDeleteAllOpen(true)}
          >
            {t('settings.deleteAllData')}
          </button>
        </div>

        <div className="row-actions">
          {onRerunWizard && (
            <button
              className="btn-ghost"
              style={{ marginLeft: 12 }}
              onClick={async () => {
                await api.saveSettings({ firstRunDone: false });
                onRerunWizard();
              }}
            >
              {t('settings.rerunWizard')}
            </button>
          )}
          {/* v2.3.90：重新运行新手引导。
              注意：新手引导只在「一张人物卡都没有」时自动出现，因此对已有卡的用户点这个按钮
              只是把 tutorialDone 写回 false，界面上不会立刻弹出——它主要在刚做完初始设置、
              还没建卡时才有意义。 */}
          <button
            className="btn-ghost"
            style={{ marginLeft: 8 }}
            onClick={async () => {
              await api.saveSettings({ tutorialDone: false });
              showToast(t('tutorial.rerunDone'));
            }}
          >
            {t('tutorial.rerun')}
          </button>
        </div>
        <div className="settings-about-row">
          <button type="button" className="btn-ghost" onClick={() => onAbout?.()}>
            {t('about.open')} · 念语
          </button>
        </div>
      </div>{/* end cat-window */}
      </>)}
      </>
        )}
      </div>

      {editorOpen && (
        <ModelEditor
          initial={editorInitial}
          onClose={() => setEditorOpen(false)}
          onSave={onModelSave}
          groups={modelGroups}
          knownTags={allTags}
          globalParams={{ ...draft.globalModelParams, streamEnabled: draft.enableStreaming }}
        />
      )}

      <GuideView open={guideOpen} onClose={() => setGuideOpen(false)} />

      {resetOpen && (
        <div
          onClick={() => setResetOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-bg-elevated, #fff)',
              color: 'var(--color-text, #222)',
              borderRadius: 14,
              padding: '24px 28px',
              maxWidth: 460,
              width: '90%',
              boxShadow: '0 12px 48px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
              ⚠️ {t('settings.resetConfirmTitle')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #666)', lineHeight: 1.7, marginBottom: 6 }}>
              {t('settings.resetKeepDesc')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #666)', lineHeight: 1.7, marginBottom: 18 }}>
              {t('settings.resetWarnData')}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn-primary"
                onClick={() => doReset(true)}
              >
                {t('settings.resetKeep')}
              </button>
              <button
                onClick={() => doReset(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid #e06c75',
                  background: '#e06c75',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                {t('settings.resetFull')}
              </button>
              <button className="btn-ghost" onClick={() => setResetOpen(false)}>
                {t('settings.resetCancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteAllOpen && (
        <div
          onClick={() => setDeleteAllOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-bg-elevated, #fff)',
              color: 'var(--color-text, #222)',
              borderRadius: 14,
              padding: '24px 28px',
              maxWidth: 460,
              width: '90%',
              boxShadow: '0 12px 48px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
              ⚠️ {t('settings.deleteAllDataConfirm')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary, #666)', lineHeight: 1.7, marginBottom: 18 }}>
              {t('settings.deleteAllDataDesc')}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid #e06c75',
                  background: '#e06c75',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
                onClick={doDeleteAll}
              >
                {t('settings.deleteAllData')}
              </button>
              <button className="btn-ghost" onClick={() => setDeleteAllOpen(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {errorLogOpen && (
        <div
          onClick={() => setErrorLogOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e1e',
              color: '#f0f0f0',
              borderRadius: 14,
              padding: '22px 24px',
              maxWidth: 680,
              width: '92%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f0f0f0' }}>{t('settings.errorLog')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {/* 弹窗底色为固定深色（#1e1e1e），btn-ghost 跟随主题会导致字色≈底色看不清，
                    这里用显式高对比样式，不随主题变化（v2.3.20 修复） */}
                <button
                  onClick={clearErrorLogAll}
                  disabled={errorLog.length === 0}
                  style={{
                    background: '#3a3a3a',
                    color: '#f0f0f0',
                    border: '1px solid #555',
                    borderRadius: 8,
                    padding: '5px 14px',
                    fontSize: 13,
                    cursor: errorLog.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: errorLog.length === 0 ? 0.55 : 1,
                  }}
                >
                  {t('settings.errorLogClear')}
                </button>
                <button
                  onClick={() => setErrorLogOpen(false)}
                  style={{
                    background: '#3a3a3a',
                    color: '#f0f0f0',
                    border: '1px solid #555',
                    borderRadius: 8,
                    padding: '5px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, fontSize: 12.5 }}>
              {errorLog.length === 0 ? (
                <div style={{ color: '#bbb', padding: '16px 4px' }}>
                  {t('settings.errorLogEmpty')}
                </div>
              ) : (
                [...errorLog].reverse().map((e) => (
                  <div key={e.id} style={{ borderBottom: '1px solid #333', padding: '10px 4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span
                        style={{
                          fontSize: 11,
                          padding: '1px 8px',
                          borderRadius: 10,
                          color: '#fff',
                          background: e.category === 'model' ? '#d98a00' : e.category === 'functional' ? '#c0392b' : '#5a6b7b',
                        }}
                      >
                        {errorCategoryLabel(e.category)}
                      </span>
                      <span style={{ color: '#aaa' }}>{new Date(e.time).toLocaleString(loc)}</span>
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: e.detail ? 4 : 0, color: '#f0f0f0' }}>{e.message}</div>
                    {e.detail && (
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#999', fontSize: 11.5 }}>
                        {e.detail}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <ToastView toast={toast} />
      </div>
    </div>
  );
};
