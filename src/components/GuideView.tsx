// 念语 · 内置软件使用指南（弹窗）
// 指南内搜索逻辑与「设置页搜索框」一致：百度建议式候选、最多 5 条按关联度排序、
// 命中高亮、点击跳转后闪动 5 秒。
import React, { useMemo, useState } from 'react';

type GuideSection = {
  id: string;
  title: string;
  kw: string[];
  body: React.ReactNode;
};

const GUIDE: GuideSection[] = [
  {
    id: 'guide-start',
    title: '快速开始',
    kw: ['开始', '启动', '安装', '开屏', '单实例', 'start', 'install'],
    body: (
      <>
        <p>念语是一款本地 AI 数字人聊天客户端，所有数据保存在本机。</p>
        <ul>
          <li>首次启动会播放开屏动画，之后仅在首次展示，再次打开不再重复。</li>
          <li>程序默认只允许一个实例运行：若已打开，再次点击图标会聚焦已有窗口而非新开。</li>
          <li>主界面左侧为会话列表，右侧为聊天区，顶部可切换角色/群组。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-ai',
    title: 'AI 模型配置',
    kw: ['模型', 'api', 'baseurl', 'key', '配置', 'model'],
    body: (
      <>
        <p>在「模型配置中心」添加至少一个可用的模型：</p>
        <ul>
          <li>填写 Base URL（到版本号，如 https://api.openai.com/v1）、API Key 与模型名。</li>
          <li>可设置默认模型，作为未单独指定时的兜底。</li>
          <li>支持受控 HTTP 调用远程 AI；配置正确后聊天即可正常回复。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-chat',
    title: '聊天与群聊',
    kw: ['聊天', '群聊', '提及', '发言', 'chat', 'group'],
    body: (
      <>
        <p>单聊即与一名数字人对话；群聊可加入多名角色，由导演模型或轮流机制决定下一位发言者。</p>
        <ul>
          <li>输入 @ 可提及并指定某位角色发言。</li>
          <li>开启「选择发言」后，每条消息后由你手动挑选下一位说话者。</li>
          <li>支持流式输出、记忆提炼、世界书与规则库注入。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-asr',
    title: '语音输入（ASR）',
    kw: ['语音', '录音', '识别', 'asr', '输入', 'wav'],
    body: (
      <>
        <p>点击输入框的语音按钮开始录音，松开即上传识别为文字。</p>
        <ul>
          <li>上传格式默认 wav（16kHz 单声道），兼容性最好，可规避多数第三方 ASR 返回 400 的问题。</li>
          <li>可在语音设置中调整格式（wav/mp3/m4a/flac/webm）与强制识别语言。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-tts',
    title: '语音播报（TTS）',
    kw: ['语音', '播报', '朗读', 'tts', '音色', '角色'],
    body: (
      <>
        <p>在语音设置填写独立的 TTS 专用 API（Base URL / API Key / 模型）后，AI 回复可自动朗读。</p>
        <ul>
          <li>「按角色配置音色」：为每位数字人单独指定音色，未指定则回退全局默认。</li>
          <li>音色列表优先从服务端拉取，服务端不支持时回退内置清单（alloy/echo/fable/onyx/nova/shimmer），也可手动输入自定义音色名。</li>
          <li>开启「全局自动播报」后，每条 AI 回复自动播放。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-image',
    title: '生图',
    kw: ['生图', '画图', '图像', 'image', '文生图'],
    body: (
      <>
        <p>在「生图」设置填写独立的图像生成 API，即可在对话中调用文生图。</p>
        <ul>
          <li>生图与模型配置中心完全解耦，拥有独立的 Base URL / API Key。</li>
          <li>角色头像可作为参考图传入，增强生成相关性。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-video',
    title: '生视频',
    kw: ['视频', '生视频', 'video', '进度'],
    body: (
      <>
        <p>调用视频生成后，界面右下角会出现悬浮气泡，每 10 秒轮询一次进度。</p>
        <ul>
          <li>气泡实时展示生成进度，可拖拽，完成后自动消失。</li>
          <li>视频生成同样使用独立的视频生成 API 配置。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-moments',
    title: '朋友圈',
    kw: ['朋友圈', '动态', '点赞', '收藏', 'moments'],
    body: (
      <>
        <p>朋友圈为社交功能，数字人可自动生成帖子，你可进行互动。</p>
        <ul>
          <li>支持 AI 驱动帖子生成、点赞与收藏。</li>
          <li>支持对人物关系的价值判断（好感/关系值）。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-floatingball',
    title: '桌面悬浮球',
    kw: ['悬浮球', '浮动球', '球', 'floating', '未读', '拖拽'],
    body: (
      <>
        <p>悬浮球是独立的透明置顶窗口，方便随时回到念语。</p>
        <ul>
          <li>左键点击：呼出主界面并清空未读。</li>
          <li>右键点击：退出念语。</li>
          <li>按住拖拽：自由移动，位置自动保存，不回弹；拖拽基于坐标计算，无跳动。</li>
          <li>未读角标：≤99 显示数字，&gt;99 显示「99+」，无未读则隐藏。</li>
          <li>在「窗口」设置中可开关悬浮球。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-search',
    title: '设置搜索',
    kw: ['搜索', '查找', '设置', 'search'],
    body: (
      <>
        <p>设置页顶部提供搜索框，逻辑与本指南一致。</p>
        <ul>
          <li>输入即给出「百度建议」式候选，最多 5 条，按关联度排序。</li>
          <li>候选下拉为毛玻璃样式，可滚轮/滚动条浏览，适配多套主题。</li>
          <li>命中的文字会高亮；点击候选跳转并闪动 5 秒定位到对应设置。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-backup',
    title: '数据备份与恢复',
    kw: ['备份', '恢复', '数据', 'backup', '重置'],
    body: (
      <>
        <p>念语数据保存在本机，可手动备份与恢复。</p>
        <ul>
          <li>在「备份」设置中创建/恢复备份，或导出备份压缩包。</li>
          <li>「重置设置」仅清空配置，不影响聊天数据；「删除全部数据」会清空所有本地数据，请谨慎。</li>
          <li>数据存储路径可在「应用数据保存路径」中查看或更改。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-window',
    title: '窗口与小窗',
    kw: ['窗口', '小窗', '迷你', 'mini', '关闭行为', 'window'],
    body: (
      <>
        <p>支持紧凑的小窗聊天与自定义关闭行为。</p>
        <ul>
          <li>小窗：通过系统托盘右键或快捷键唤起紧凑聊天窗；关闭仅隐藏不退出。</li>
          <li>关闭行为：可设置点击关闭按钮时最小化到托盘而非退出。</li>
        </ul>
      </>
    ),
  },
];

export function GuideView({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [showSuggest, setShowSuggest] = useState(false);

  const results = useMemo<GuideSection[]>(() => {
    const raw = q.toLowerCase().trim();
    if (!raw) return [];
    const tokens = raw.split(/\s+/).filter(Boolean);
    const scored = GUIDE.map((s) => {
      const label = s.title.toLowerCase();
      const hay = label + ' ' + s.kw.join(' ').toLowerCase();
      let score = -1;
      if (label.startsWith(raw)) score = 100;
      else if (label.includes(raw)) score = 80;
      else if (hay.includes(raw)) score = 50;
      if (score < 0 && tokens.length > 0) {
        const allHit = tokens.every((tk) => hay.includes(tk));
        if (allHit) score = tokens.every((tk) => label.includes(tk)) ? 70 : 40;
      }
      return { s, score };
    })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.s.title.length - b.s.title.length);
    return scored.slice(0, 5).map((x) => x.s);
  }, [q]);

  const renderHL = (label: string): React.ReactNode => {
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

  const goTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('setting-flash');
      void el.offsetWidth;
      el.classList.add('setting-flash');
      window.setTimeout(() => el.classList.remove('setting-flash'), 5000);
    }
    setShowSuggest(false);
    setQ('');
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 92vw)',
          height: 'min(82vh, 760px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-surface, #fff)',
          color: 'var(--color-text, #1a1d24)',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,.4)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--color-border, rgba(128,128,128,.2))',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700 }}>念语使用指南</div>
          <button type="button" className="btn-ghost" style={{ padding: '4px 12px' }} onClick={onClose}>
            关闭
          </button>
        </div>

        {/* 指南内搜索（与设置页一致） */}
        <div style={{ padding: '12px 18px 0', position: 'relative' }}>
          <input
            type="text"
            className="settings-search-input"
            placeholder="搜索指南内容…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setShowSuggest(true);
            }}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => window.setTimeout(() => setShowSuggest(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) goTo(results[0].id);
              else if (e.key === 'Escape') setShowSuggest(false);
            }}
          />
          {showSuggest && results.length > 0 && (
            <div className="settings-suggest" style={{ position: 'absolute', top: 'calc(100% - 6px)' }}>
              {results.map((r) => (
                <div
                  key={r.id}
                  className="settings-suggest-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    goTo(r.id);
                  }}
                >
                  {renderHL(r.title)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 22px 28px' }}>
          {GUIDE.map((s) => (
            <section key={s.id} id={s.id} className="guide-section" style={{ marginBottom: 22, scrollMarginTop: 12 }}>
              <h3 style={{ fontSize: 15, margin: '0 0 8px', color: 'var(--color-primary, #3a8fd0)' }}>{s.title}</h3>
              <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--color-text, #1a1d24)' }}>{s.body}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
