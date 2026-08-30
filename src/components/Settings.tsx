import React, { useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useTheme } from '../theme/ThemeContext';
import { useI18n } from '../i18n/I18nContext';
import {
  PROVIDER_DEFAULTS,
  DEFAULT_SETTINGS,
  type ThemeName,
  type AppSettings,
  type ImageGenSettings,
  type DeepThinkLevel,
  type VideoGenSettings,
  type ModelConfig,
  type ChatListItem,
  type SelfRole,
  type WorldBook,
  type ErrorLogEntry,
  type Plugin,
} from '../types';
import { ModelEditor } from './ModelEditor';
import { FontSettings } from './FontSettings';
import { GuideView } from './GuideView';
import { SelfRoleSettings } from './SelfRoleSettings';
import { useToast, ToastView } from './Toast';
import SelectMenu from './SelectMenu';
import { invalidateSoundCache, previewSound, type SoundType } from '../utils/sound';
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
const SETTING_CATS: { id: string; labelKey: string }[] = [
  { id: 'cat-general', labelKey: 'settings.catGeneral' },
  { id: 'cat-models', labelKey: 'settings.catModels' },
  { id: 'cat-appearance', labelKey: 'settings.catAppearance' },
  { id: 'cat-generation', labelKey: 'settings.catGeneration' },
  { id: 'cat-translation', labelKey: 'settings.catTranslation' },
  { id: 'cat-window', labelKey: 'settings.catWindow' },
];

// 设置搜索索引：每项含锚点 id、i18n 键、中英文关键词；搜索框据此给出「百度建议」式候选
type SettingSearchItem = { id: string; key: string; kw: string[] };
const SETTING_SEARCH_INDEX: SettingSearchItem[] = [
  { id: 'cat-general', key: 'settings.catGeneral', kw: ['通用', '常规', '基础', 'general', 'basic'] },
  { id: 'cat-models', key: 'settings.catModels', kw: ['模型', 'model', '模型配置'] },
  { id: 'cat-appearance', key: 'settings.catAppearance', kw: ['外观', '主题', '界面', 'appearance', 'theme'] },
  { id: 'cat-generation', key: 'settings.catGeneration', kw: ['生成', '生图', '生视频', 'generation', 'image', 'video'] },
  { id: 'cat-translation', key: 'settings.catTranslation', kw: ['翻译', 'translation'] },
  { id: 'cat-window', key: 'settings.catWindow', kw: ['窗口', '小窗', '悬浮球', 'window', '迷你'] },
  { id: 'sec-language', key: 'settings.language', kw: ['语言', 'language', '界面语言', '中文', '英文'] },
  { id: 'sec-streaming', key: 'settings.enableStreaming', kw: ['流式', 'stream', '打字机'] },
  { id: 'sec-animations', key: 'settings.animations', kw: ['动画', 'animation', '动效'] },
  { id: 'sec-font', key: 'settings.font', kw: ['字体', 'font', '字号'] },
  { id: 'sec-self', key: 'self.title', kw: ['自我', '身份', 'self', '角色'] },
  { id: 'sec-worldbook', key: 'worldbook.title', kw: ['世界书', 'worldbook', '背景设定'] },
  { id: 'sec-groupchat', key: 'settings.groupChat', kw: ['群聊', 'group', '多人', '群组'] },
  { id: 'sec-modelmanage', key: 'settings.modelManage', kw: ['模型管理', 'model manage', '添加模型'] },
  { id: 'sec-theme', key: 'settings.theme', kw: ['主题', 'theme', '配色', '皮肤'] },
  { id: 'sec-radius', key: 'settings.radius', kw: ['圆角', 'radius', '边角'] },
  { id: 'sec-uizoom', key: 'settings.uiZoom', kw: ['缩放', 'zoom', '等比', '基准尺寸', '上下限'] },
  { id: 'sec-emoevent', key: 'settings.emoEventAdvanced', kw: ['情绪', '事件', 'emotion', 'event', '高级'] },
  { id: 'sec-inputappearance', key: 'settings.inputAppearance', kw: ['输入框', 'input', '输入栏', '外观'] },
  { id: 'sec-cursor', key: 'settings.cursor', kw: ['光标', 'cursor', '鼠标指针', '自定义光标'] },
  { id: 'sec-glassbg', key: 'settings.glassBg', kw: ['毛玻璃', 'glass', '背景', '虚化'] },
  { id: 'sec-voice', key: 'settings.voice', kw: ['语音', 'voice', 'tts', '朗读', '播报', 'asr', '识别', '语音输入'] },
  { id: 'sec-imagegen', key: 'settings.imageGen', kw: ['生图', '画图', 'image', '图像生成', '文生图'] },
  { id: 'sec-videogen', key: 'settings.videoGen', kw: ['视频', 'video', '生视频', '文生视频'] },
  { id: 'sec-sceneimage', key: 'settings.sceneImage', kw: ['场景图', 'scene', '配图'] },
  { id: 'sec-websearch', key: 'settings.webSearch', kw: ['联网', '搜索', 'web', 'search', '联网搜索'] },
  { id: 'sec-plugins', key: 'settings.plugins', kw: ['插件', 'plugin', '扩展'] },
  { id: 'sec-translation', key: 'settings.translation', kw: ['翻译', 'translation', '译文'] },
  { id: 'sec-sound', key: 'settings.sound', kw: ['音效', 'sound', '提示音', '通知音', '声音'] },
  { id: 'sec-mini', key: 'settings.mini', kw: ['小窗', '迷你', 'mini', '快捷'] },
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

export const Settings: React.FC<{ onRerunWizard?: () => void; onAbout?: () => void }> = ({
  onRerunWizard,
  onAbout,
}) => {
  const { toast, showToast } = useToast();
  const { theme, setTheme, settings, reloadSettings } = useTheme();
  const { t, lang, setLang } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const catRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeCat, setActiveCat] = useState(SETTING_CATS[0].id);
  const scrollToCat = (id: string) => {
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
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<ModelConfig | undefined>(undefined);
  const [chatList, setChatList] = useState<ChatListItem[]>([]);
  const [sub, setSub] = useState<'main' | 'font' | 'self'>('main');
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
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

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  useEffect(() => {
    api.getChatList().then((list) => {
      // 过滤观察者私密小窗（obs: 前缀），它们不参与按聊天设置
      setChatList(list.filter((c) => !c.chat_id.startsWith('obs:')));
    });
  }, []);

  // TTS 按角色音色：加载角色（含群成员）清单与可选音色列表
  const [roleVoiceList, setRoleVoiceList] = useState<{ roleId: string; name: string }[]>([]);
  const [voiceOptions, setVoiceOptions] = useState<string[]>([]);

  // ===== 设置搜索框（百度建议式候选） =====
  const [searchQ, setSearchQ] = useState('');
  const [showSuggest, setShowSuggest] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // 搜索索引：基础为静态分区/分类（含中英文关键词），再于挂载后运行时补全所有
  // 具体控件（勾选框 / 滑块 / 下拉 / 各分区标题），保证「所有设置项」均可被搜到并跳转。
  const [searchIndex, setSearchIndex] = useState<SettingSearchItem[]>(SETTING_SEARCH_INDEX);
  const draftReady = !!draft;
  React.useEffect(() => {
    const root = panelRef.current;
    if (!root || !draftReady) return;
    const dyn: SettingSearchItem[] = [];
    const seen = new Set<string>();
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
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
      const id = `${prefix}-${seen.size}`;
      el.id = id;
      dyn.push({ id, key: label, kw: [] });
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
    setSearchIndex([...SETTING_SEARCH_INDEX, ...dyn]);
  }, [lang, draftReady]);
  const searchResults = React.useMemo<SettingSearchItem[]>(() => {
    const raw = searchQ.toLowerCase().trim();
    if (!raw) return [];
    // 拆词：支持「语音 输入」式多关键字，每个词都需在标题或关键词中出现才算命中
    const tokens = raw.split(/\s+/).filter(Boolean);
    const scored = searchIndex.map((item) => {
      const label = t(item.key).toLowerCase();
      const hay = label + ' ' + item.kw.join(' ').toLowerCase();
      let score = -1;
      if (label.startsWith(raw)) score = 100;
      else if (label.includes(raw)) score = 80;
      else if (hay.includes(raw)) score = 50;
      // 多词匹配：全部 token 命中（标题内命中优先）
      if (score < 0 && tokens.length > 0) {
        const allHit = tokens.every((tk) => hay.includes(tk));
        if (allHit) score = tokens.every((tk) => label.includes(tk)) ? 70 : 40;
      }
      return { item, score };
    })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.item.key.length - b.item.key.length);
    return scored.slice(0, 5).map((x) => x.item);
  }, [searchQ, lang, searchIndex]);

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
  const goToSetting = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('setting-flash');
      void el.offsetWidth; // 触发重排以重启动画
      el.classList.add('setting-flash');
      window.setTimeout(() => el.classList.remove('setting-flash'), 5000);
    }
    setShowSuggest(false);
    setSearchQ('');
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const roles: any[] = (await api.getRoles()) || [];
        const groups: any[] = (await api.getGroups()) || [];
        const list: { roleId: string; name: string }[] = [];
        roles.forEach((r) => list.push({ roleId: r.id, name: r.name }));
        groups.forEach((g) => {
          const ids = (g.member_ids || '').split(',').filter(Boolean);
          ids.forEach((id: string) => {
            if (list.some((l) => l.roleId === id)) return;
            const r = roles.find((x: any) => x.id === id);
            list.push({ roleId: id, name: r ? `${r.name}（${g.group_name}）` : `${id}（${g.group_name}）` });
          });
        });
        if (!cancelled) setRoleVoiceList(list);
      } catch {
        /* 忽略：未导入角色时为空 */
      }
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

  if (!draft) return <div className="panel">{t('common.loading')}</div>;

  const loc = lang === 'en' ? 'en-US' : 'zh-CN';
  const providerLabel = (p: string) =>
    p === 'custom' ? t('model.providerCustom') : PROVIDER_DEFAULTS[p as keyof typeof PROVIDER_DEFAULTS]?.label || p;

  // 所有改动即时落盘并广播到其他窗口，与全页一致；不再依赖底部「保存」按钮
  const patch = (p: Partial<AppSettings>) => {
    setDraft((d) => ({ ...(d as AppSettings), ...p }));
    api.saveSettings(p).then(reloadSettings);
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
  const patchMini = (p: Partial<typeof mini>) => {
    const next = { ...mini, ...p };
    patch({ miniWindow: next });
    api.saveSettings({ miniWindow: next }).then(reloadSettings);
  };
  const patchSound = (p: Partial<typeof sound>) => patch({ sound: { ...sound, ...p } });
  const patchCursor = (p: Partial<typeof cursor>) => patch({ customCursor: { ...cursor, ...p } });

  // TTS 按角色音色：key=角色 id，value=音色名；空字符串表示回退全局默认（存于 voice 子对象）
  const ttsVoices = voice.ttsVoices || {};
  const patchTtsVoice = (roleId: string, voiceName: string) => {
    const next = { ...ttsVoices };
    if (voiceName) next[roleId] = voiceName;
    else delete next[roleId];
    patchVoice({ ttsVoices: next });
  };
  // 光标子设置必须落盘并触发 reloadSettings，否则 ThemeContext.settings 不会更新，
  // CustomCursor 读取不到变化（patch 只改本地 draft）。与 enabled 开关保持一致。
  const saveCursor = (p: Partial<typeof cursor>) =>
    api.saveSettings({ customCursor: { ...cursor, ...p } }).then(reloadSettings);

  // 生图 / TTS / ASR 模型名拉取：复用 OpenAI 兼容 /models，按类型关键字过滤后填入 datalist，
  // 用户既能从下拉选也能手填。过滤为空时回退全部列表，避免第三方平台命名不标准时漏掉可用模型。
  const [asrModelList, setAsrModelList] = useState<string[]>([]);
  const [ttsModelList, setTtsModelList] = useState<string[]>([]);
  const [imgModelList, setImgModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState<{ asr?: boolean; tts?: boolean; img?: boolean }>({});

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
    // 若删除的是默认模型，同时清空默认值
    const nextDefault = draft?.defaultModel === id ? '' : draft?.defaultModel || '';
    setDraft((d) => (d ? { ...d, models: next, defaultModel: nextDefault } : d));
    if (draft) api.saveSettings({ ...draft, models: next, defaultModel: nextDefault }).then(reloadSettings);
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
    await api.createBackup(dest);
    await reloadSettings();
    setBusy(false);
    setStatus(t('settings.backupDone', { dest }));
  };

  const restore = async () => {
    if (!(await api.showConfirm!(t('settings.confirmRestore')))) return;
    setBusy(true);
    setStatus(t('settings.restorePick'));
    const zip = await api.pickRestoreFile();
    if (!zip) {
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
              : t('settings.title')}
        </span>
        {sub === 'main' && (
          <div className="settings-header-search">
            <div style={{ position: 'relative', width: 220 }}>
              <input
                type="text"
                className="settings-search-input"
                placeholder={t('settings.searchPlaceholder')}
                value={searchQ}
                onChange={(e) => {
                  setSearchQ(e.target.value);
                  setShowSuggest(true);
                }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => window.setTimeout(() => setShowSuggest(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (searchResults[0]) goToSetting(searchResults[0].id);
                  } else if (e.key === 'Escape') {
                    setShowSuggest(false);
                  }
                }}
              />
              {showSuggest && searchResults.length > 0 && (
                <div className="settings-suggest">
                  {searchResults.map((r) => (
                    <div
                      key={r.id}
                      className="settings-suggest-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        goToSetting(r.id);
                      }}
                    >
                      {renderSearchHL(t(r.key), searchQ)}
                    </div>
                  ))}
                </div>
              )}
              {showSuggest && searchQ.trim() && searchResults.length === 0 && (
                <div className="settings-suggest">
                  <div className="settings-suggest-empty">{t('settings.searchEmpty')}</div>
                </div>
              )}
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
      </div>
      <div className="settings-layout">
        {sub === 'main' && (
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
            onBack={() => setSub('main')}
          />
        ) : sub === 'font' ? (
          <FontSettings draft={draft} patch={patch} onBack={() => setSub('main')} />
        ) : (
        <>
        {status && (
          <div style={{ marginBottom: 14, color: 'var(--color-primary)', fontSize: 13 }}>
            {status}
          </div>
        )}

        {/* ===== 语言 ===== */}
        <div id="cat-general" ref={(el) => { catRefs.current['cat-general'] = el; }} className="settings-category">
        <div id="sec-language" className="section-title">{t('settings.language')}</div>
        <div className="field" style={{ maxWidth: 240 }}>
          <SelectMenu
            value={lang}
            onChange={(v) => setLang(v as 'zh' | 'en')}
            options={[
              { value: 'zh', label: t('settings.langZh') },
              { value: 'en', label: t('settings.langEn') },
            ]}
          />
        </div>

        {/* ===== 流式输出 ===== */}
        <div className="section-title">{t('settings.enableStreaming')}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!draft.enableStreaming}
            onChange={(e) => patch({ enableStreaming: e.target.checked })}
          />
          <span>{t('settings.enableStreaming')}</span>
        </label>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.streamingDesc')}
        </div>

        {/* ===== 界面动效 ===== */}
        <div id="sec-animations" className="section-title" style={{ marginTop: 16 }}>{t('settings.animations')}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!draft.enableAnimations}
            onChange={(e) => patch({ enableAnimations: e.target.checked })}
          />
          <span>{t('settings.animationsOn')}</span>
        </label>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.animationsDesc')}
        </div>

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
            <div style={{ fontWeight: 600 }}>{t('settings.font')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {t('settings.fontEnter')}
              </div>
            </div>
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
              <div style={{ fontWeight: 600 }}>{t('self.manage')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {t('self.enter')}
              </div>
            </div>
          </div>

          {/* ===== 世界书 / 记忆（全局默认 + 自动记忆） ===== */}
          <div id="sec-worldbook" className="section-title" style={{ marginTop: 16 }}>{t('worldbook.title')}</div>
          <div className="field" style={{ maxWidth: 340 }}>
            <label>{t('settings.defaultWorldbook')}</label>
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
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.defaultWorldbookDesc')}
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
            <span>{t('settings.autoMemory')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.autoMemoryDesc')}
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
            <span>{t('settings.autoRelationship')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.autoRelationshipDesc')}
          </div>

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
            <span>{t('settings.autoMoments')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.autoMomentsDesc')}
          </div>

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
              <span>{t('settings.dailyMomentLimit')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.dailyMomentLimitDesc')}
            </div>
          </div>

          {/* 朋友圈敏感程度 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.momentsSensitivity')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.momentsSensitivityDesc')}
            </div>
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
            <span>{t('settings.hideReasoning')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.hideReasoningDesc')}
          </div>

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
            <span>{t('settings.enableRandomEvents')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.enableRandomEventsDesc')}
          </div>

          {/* 事件影响心情程度 */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventMoodImpact')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.eventMoodImpactDesc')}
            </div>
          </div>

          {/* 对话影响心情程度 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.dialogueMoodImpact')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.dialogueMoodImpactDesc')}
            </div>
          </div>

          {/* 心情过渡指数 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.moodSmoothing')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.moodSmoothingDesc')}
            </div>
          </div>

          {/* 空闲主动回复（全局主开关 + 触发时长 + 记忆控制 + 按聊天覆盖） */}
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
              <div style={{ fontSize: 13 }}>{t('settings.idleEnabled')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('settings.idleEnabledDesc')}
              </div>
            </div>
          </div>

          {/* 触发时长：离散选项 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.idleInterval')}</div>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.idleIntervalDesc')}
            </div>
          </div>

          {/* 切换聊天时的计时行为 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.idleSwitchAction')}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { v: 'pause' as const, l: t('settings.idleSwitchPause') },
                { v: 'reset' as const, l: t('settings.idleSwitchReset') },
                { v: 'continue' as const, l: t('settings.idleSwitchContinue') },
              ].map((opt) => {
                const active = (draft.idleSwitchAction || 'pause') === opt.v;
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.idleSwitchActionDesc')}
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
              <div style={{ fontSize: 13 }}>{t('settings.idleWriteMemory')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('settings.idleWriteMemoryDesc')}
              </div>
            </div>
          </div>

          {/* 按聊天单独设置 */}
          {chatList.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="section-title" style={{ marginTop: 4 }}>
                {t('settings.idleAllChats')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                {t('settings.idleAllChatsDesc')}
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

          {/* ===== 情绪与事件（高级可调） ===== */}
          <div id="sec-emoevent" className="section-title" style={{ marginTop: 16 }}>
            {t('settings.emoEventAdvanced')}
          </div>

          {/* 心情判定冷却 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.moodJudgeCooldown')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.moodJudgeCooldownDesc')}
            </div>
          </div>

          {/* 心情判定回顾轮数 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.moodJudgeHistory')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.moodJudgeHistoryDesc')}
            </div>
          </div>

          {/* 低好感冲突阈值 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventNegAffinity')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.eventNegAffinityDesc')}
            </div>
          </div>

          {/* 高好感甜蜜阈值 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventPosAffinity')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.eventPosAffinityDesc')}
            </div>
          </div>

          {/* 事件参考上下文条数 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventHistory')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.eventHistoryDesc')}
            </div>
          </div>

          {/* 事件生成长度上限 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.eventMaxTokens')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.eventMaxTokensDesc')}
            </div>
          </div>

          </div>{/* end cat-general */}
        {/* ===== 群聊互聊（流式并行 / 调度 / 自动接话 / 主动续聊） ===== */}
        <div id="cat-models" ref={(el) => { catRefs.current['cat-models'] = el; }} className="settings-category">
        <div id="sec-groupchat" className="section-title" style={{ marginTop: 16 }}>{t('settings.groupChat')}</div>

        {/* 群聊流式并行数量 */}
        <div className="field" style={{ maxWidth: 300 }}>
          <label>{t('settings.streamParallel')}</label>
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
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.streamParallelDesc')}
        </div>

        <div className="field" style={{ maxWidth: 300 }}>
          <label>{t('settings.groupScheduler')}</label>
          <SelectMenu
            value={draft.groupScheduler || 'director'}
            onChange={(v) => patch({ groupScheduler: v as 'director' | 'roundRobin' })}
            options={[
              { value: 'director', label: t('settings.schedulerDirector') },
              { value: 'roundRobin', label: t('settings.schedulerRoundRobin') },
            ]}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.groupSchedulerDesc')}
        </div>
        <div className="field" style={{ maxWidth: 300, marginTop: 10 }}>
          <label>{t('settings.groupAutoRounds')}</label>
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
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.groupAutoRoundsDesc')}
        </div>

        {/* AI 主动续聊开关 */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={!!draft.groupAutoChain}
            onChange={(e) => patch({ groupAutoChain: e.target.checked, groupSelectReply: e.target.checked ? false : draft.groupSelectReply })}
          />
          <span>{t('settings.groupAutoChain')}</span>
        </label>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.groupAutoChainDesc')}
        </div>

        {/* 群聊选人回复：开启后每次发言与 AI 回复后由用户手动选择下一位发言者（与自动接话互斥） */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={!!draft.groupSelectReply}
            onChange={(e) => patch({ groupSelectReply: e.target.checked, groupAutoChain: e.target.checked ? false : draft.groupAutoChain })}
          />
          <span>{t('settings.groupSelectReply')}</span>
        </label>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.groupSelectReplyDesc')}
        </div>

        {/* 同角色连续发言上限（仅群聊自动接话生效） */}
        <div className="field" style={{ maxWidth: 300, marginTop: 14 }}>
          <label>{t('settings.groupMaxConsecutive')}</label>
          <SelectMenu
            value={String(draft.groupMaxConsecutive ?? 1)}
            onChange={(v) => patch({ groupMaxConsecutive: Number(v) })}
            options={Array.from({ length: 20 }, (_, i) => i + 1).map((n) => ({
              value: String(n),
              label: t('settings.groupMaxConsecutiveN', { n }),
            }))}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.groupMaxConsecutiveDesc')}
        </div>

        {/* ===== 模型管理（含默认模型） ===== */}
        <div id="sec-modelmanage" className="section-title">{t('settings.modelManage')}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          {t('settings.defaultModelHint')}
        </div>

        {/* 深度思考等级：全局档位，实际仅对「模型管理」中标记为支持推理的模型生效 */}
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t('settings.deepThink')}</div>
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
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.deepThinkDesc')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          {(draft.models || []).map((m) => {
            const isDefault = draft.defaultModel === m.id;
            return (
              <div
                key={m.id}
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

        </div>{/* end cat-models */}
        <div id="cat-appearance" ref={(el) => { catRefs.current['cat-appearance'] = el; }} className="settings-category">
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
        <div id="sec-radius" className="section-title">{t('settings.radius')}</div>
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
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.radiusDesc')}
          </div>
          <div style={{ fontSize: 13, margin: '10px 0 4px' }}>
            {t('settings.bubbleOpacity')}
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
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.bubbleOpacityDesc')}
          </div>
        </div>

        {/* ===== 窗口整体等比缩放：基准尺寸 + 上下限（主窗/小窗分别配置） ===== */}
        <div id="sec-uizoom" className="section-title" style={{ marginTop: 16 }}>
          {t('settings.uiZoom')}
        </div>
        <div style={{ maxWidth: 480 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {t('settings.uiZoomDesc')}
          </div>
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
        <div id="sec-inputappearance" className="section-title">{t('settings.inputAppearance')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 2 }}>
            {t('settings.inputColorDesc')}
          </div>
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
        <div id="sec-cursor" className="section-title">{t('settings.cursor')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 4 }}>
            {t('settings.cursorDesc')}
          </div>
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
            <div id="sec-glassbg" className="section-title" style={{ marginTop: 16 }}>{t('settings.glassBg')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 2 }}>
                {t('settings.glassBgDesc')}
              </div>
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
            </div>
          </>
        )}
        </div>{/* end cat-appearance */}
        {/* ===== 语音功能（ASR + TTS） ===== */}
        <div id="cat-generation" ref={(el) => { catRefs.current['cat-generation'] = el; }} className="settings-category">
        <div id="sec-voice" className="section-title">{t('settings.voice')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.asrApi')}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={voice.asrBaseUrl}
                style={{ flex: 1, minWidth: 200 }}
                onChange={(e) => {
                  const val = e.target.value;
                  // 首次填写 ASR 专用 API 时即视为接入，语音转文本默认开启
                  patchVoice({ asrBaseUrl: val });
                }}
              />
              <input
                type="password"
                placeholder={t('settings.apiKey')}
                value={voice.asrApiKey}
                style={{ width: 180 }}
                onChange={(e) => patchVoice({ asrApiKey: e.target.value })}
              />
              <input
                type="text"
                placeholder="whisper-1"
                value={voice.asrModel}
                style={{ width: 140 }}
                list="asr-model-options"
                onChange={(e) => patchVoice({ asrModel: e.target.value })}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={modelLoading.asr}
                onClick={() => refreshModelList('asr', voice.asrBaseUrl, voice.asrApiKey)}
              >
                {modelLoading.asr ? t('model.refreshing') : t('model.refreshModels')}
              </button>
              <datalist id="asr-model-options">
                {asrModelList.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.asrDesc')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.ttsTitle')}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={voice.ttsBaseUrl}
                style={{ flex: 1, minWidth: 200 }}
                onChange={(e) => {
                  const val = e.target.value;
                  // 首次填写 TTS 专用 API 时，默认打开全局自动播报
                  patchVoice({ ttsBaseUrl: val, ...(val && !voice.ttsBaseUrl ? { ttsAutoPlay: true } : {}) });
                }}
              />
              <input
                type="password"
                placeholder={t('settings.apiKey')}
                value={voice.ttsApiKey}
                style={{ width: 180 }}
                onChange={(e) => patchVoice({ ttsApiKey: e.target.value })}
              />
              <input
                type="text"
                placeholder="tts-1"
                value={voice.ttsModel}
                style={{ width: 110 }}
                list="tts-model-options"
                onChange={(e) => patchVoice({ ttsModel: e.target.value })}
              />
              <input
                type="text"
                placeholder="alloy"
                value={voice.ttsVoice}
                style={{ width: 90 }}
                onChange={(e) => patchVoice({ ttsVoice: e.target.value })}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!voice.ttsAutoPlay}
                disabled={!voice.ttsBaseUrl}
                onChange={(e) => patchVoice({ ttsAutoPlay: e.target.checked })}
              />
              <span style={{ fontSize: 13 }}>{t('settings.ttsAutoPlay')}</span>
            </label>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={modelLoading.tts}
                onClick={() => refreshModelList('tts', voice.ttsBaseUrl, voice.ttsApiKey)}
              >
                {modelLoading.tts ? t('model.refreshing') : t('model.refreshModels')}
              </button>
              <datalist id="tts-model-options">
                {ttsModelList.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.ttsDesc')}
            </div>

            {/* 按数字人角色分别配置 TTS 音色 */}
            <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border, rgba(128,128,128,.18))', paddingTop: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('settings.ttsVoicePerRole')}</div>
              {roleVoiceList.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('settings.ttsNoRoles')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto', paddingRight: 4 }}>
                  {roleVoiceList.map((r) => (
                    <div key={r.roleId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{ fontSize: 12, flex: '0 0 150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={r.name}
                      >
                        {r.name}
                      </span>
                      <input
                        type="text"
                        list="tts-voice-options"
                        placeholder={voice.ttsVoice || 'alloy'}
                        value={ttsVoices[r.roleId] || ''}
                        style={{ flex: 1, minWidth: 120 }}
                        onChange={(e) => patchTtsVoice(r.roleId, e.target.value)}
                      />
                      {ttsVoices[r.roleId] ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '2px 8px', fontSize: 12 }}
                          onClick={() => patchTtsVoice(r.roleId, '')}
                        >
                          {t('settings.ttsVoiceClear')}
                        </button>
                      ) : null}
                    </div>
                  ))}
                  <datalist id="tts-voice-options">
                    {voiceOptions.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6 }}>
                {t('settings.ttsVoicePerRoleDesc')}
              </div>
            </div>
          </div>
        </div>

        {/* ===== 生图（专用图像生成 API） ===== */}
        <div id="sec-imagegen" className="section-title">{t('settings.imageGen')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!imageGen.enabled}
              onChange={(e) => patchImageGen({ enabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.imageGenEnabled')}</span>
          </label>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.imageGenApi')}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={imageGen.baseUrl}
                style={{ flex: 1, minWidth: 200 }}
                onChange={(e) => patchImageGen({ baseUrl: e.target.value })}
              />
              <input
                type="password"
                placeholder={t('settings.apiKey')}
                value={imageGen.apiKey}
                style={{ width: 180 }}
                onChange={(e) => patchImageGen({ apiKey: e.target.value })}
              />
              <input
                type="text"
                placeholder={t('settings.imageGenModelPlaceholder')}
                value={imageGen.model}
                style={{ width: 150 }}
                list="img-model-options"
                onChange={(e) => patchImageGen({ model: e.target.value })}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={modelLoading.img}
                onClick={() => refreshModelList('img', imageGen.baseUrl, imageGen.apiKey)}
              >
                {modelLoading.img ? t('model.refreshing') : t('model.refreshModels')}
              </button>
              <datalist id="img-model-options">
                {imgModelList.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.imageGenDesc')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.imageGenSize')}
            </div>
            <input
              type="text"
              placeholder="1024x1024"
              value={imageGen.size}
              style={{ width: 150 }}
              onChange={(e) => patchImageGen({ size: e.target.value })}
            />
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.imageGenSizeDesc')}
            </div>
          </div>
        </div>

        {/* ===== 生视频（专用视频生成 API，使用方式与生图一致） ===== */}
        <div id="sec-videogen" className="section-title">{t('settings.videoGen')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!videoGen.enabled}
              onChange={(e) => patchVideoGen({ enabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.videoGenEnabled')}</span>
          </label>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.videoGenApi')}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={videoGen.baseUrl}
                style={{ flex: 1, minWidth: 200 }}
                onChange={(e) => patchVideoGen({ baseUrl: e.target.value })}
              />
              <input
                type="password"
                placeholder={t('settings.apiKey')}
                value={videoGen.apiKey}
                style={{ width: 180 }}
                onChange={(e) => patchVideoGen({ apiKey: e.target.value })}
              />
              <input
                type="text"
                placeholder={t('settings.imageGenModelPlaceholder')}
                value={videoGen.model}
                style={{ width: 150 }}
                list="video-model-options"
                onChange={(e) => patchVideoGen({ model: e.target.value })}
              />
            </div>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={modelLoading.img}
                onClick={() => refreshModelList('img', videoGen.baseUrl, videoGen.apiKey)}
              >
                {modelLoading.img ? t('model.refreshing') : t('model.refreshModels')}
              </button>
              <datalist id="video-model-options">
                {imgModelList.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.videoGenDesc')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.videoGenSize')}
            </div>
            <input
              type="text"
              placeholder="1280x720"
              value={videoGen.size}
              style={{ width: 150 }}
              onChange={(e) => patchVideoGen({ size: e.target.value })}
            />
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.imageGenSizeDesc')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.videoGenDuration')}
            </div>
            <input
              type="text"
              placeholder="5"
              value={videoGen.duration}
              style={{ width: 150 }}
              onChange={(e) => patchVideoGen({ duration: e.target.value })}
            />
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.videoGenDesc')}
            </div>
          </div>
        </div>

        {/* ===== 异步场景生图 ===== */}
        <div id="sec-sceneimage" className="section-title">{t('settings.sceneImage')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.sceneImageDesc')}
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{t('settings.sceneImageInterval')}</span>
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.sceneImageIntervalDesc')}
            </div>
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
            <span style={{ fontSize: 13 }}>{t('settings.asyncImageUseAvatar')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.asyncImageUseAvatarDesc')}
          </div>
        </div>

        {/* ===== 联网搜索 ===== */}
        <div id="sec-websearch" className="section-title">{t('settings.webSearch')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.webSearchDesc')}
          </div>
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
              {t('settings.searchApiKey')}
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.searchApiKeyHint')}
            </div>
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
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.webSearchFetchPages')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('settings.webSearchFetchPagesDesc')}
              </div>
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
        <div id="sec-plugins" className="section-title">{t('settings.plugins')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.pluginsDesc')}
          </div>
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
                {t('settings.pluginAllowJs')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {t('settings.pluginAllowJsDesc')}
              </div>
            </div>
          </label>

          <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.pluginManage')}</div>
          {plugins.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.pluginEmpty')}
            </div>
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

        </div>{/* end cat-generation */}
        {/* ===== 翻译（右键消息翻译文本） ===== */}
        <div id="cat-translation" ref={(el) => { catRefs.current['cat-translation'] = el; }} className="settings-category">
        <div id="sec-translation" className="section-title">{t('settings.translation')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!draft.translationEnabled}
              onChange={(e) => patch({ translationEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 13 }}>{t('settings.translationEnabled')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.translationEnabledDesc')}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.translationModel')}
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
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              {t('settings.translationModelDesc')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              {t('settings.translationLang')}
            </div>
            <SelectMenu
              value={draft.translationLang || 'auto'}
              style={{ width: 200 }}
              onChange={(v) => patch({ translationLang: v as 'auto' | 'zh' | 'en' })}
              options={[
                { value: 'auto', label: t('settings.translationLangAuto') },
                { value: 'zh', label: t('settings.translationLangZh') },
                { value: 'en', label: t('settings.translationLangEn') },
              ]}
            />
          </div>
        </div>

        {/* ===== 音效 ===== */}
        <div id="sec-sound" className="section-title">{t('settings.sound')}</div>
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
            <span>{t('settings.soundVolume')}</span>
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
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {t('settings.soundDesc')}
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
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 10 }}>
          {t('settings.soundCustomTip')}
        </div>

        </div>{/* end cat-translation */}
        {/* ===== 快捷聊天小窗 ===== */}
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
            <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{t('settings.miniDefaultChat')}</span>
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
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.miniDesc')}
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
                patch({ floatingBall: { enabled, x: floating.x, y: floating.y } });
                if (api?.ballSetEnabled) api.ballSetEnabled(enabled);
              }}
            />
            <span style={{ fontSize: 13 }}>{t('settings.floatingBallEnable')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {t('settings.floatingBallDesc')}
          </div>
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
                  },
                });
              }}
            />
            <span style={{ fontSize: 13 }}>{t('settings.floatingBallAutoHideFullscreen')}</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {t('settings.floatingBallAutoHideDesc')}
          </div>
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
        </div>
        <div className="settings-about-row">
          <button type="button" className="btn-ghost" onClick={() => onAbout?.()}>
            {t('about.open')} · 念语
          </button>
        </div>
      </div>{/* end cat-window */}
      </>
        )}
      </div>

      {editorOpen && (
        <ModelEditor
          initial={editorInitial}
          onClose={() => setEditorOpen(false)}
          onSave={onModelSave}
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
                <button className="btn-ghost" onClick={clearErrorLogAll} disabled={errorLog.length === 0}>
                  {t('settings.errorLogClear')}
                </button>
                <button className="btn-ghost" onClick={() => setErrorLogOpen(false)}>
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
