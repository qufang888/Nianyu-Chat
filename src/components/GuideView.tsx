// 念语 · 内置软件使用指南（弹窗）
// ⚠️ 同步约定：本文件内容必须与根目录《使用说明.md》保持一致（文档为权威源）。
// 更新《使用说明.md》时，请同步更新这里的 GUIDE 数组；反之亦然。
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
    kw: ['开始', '启动', '安装', '开屏', '单实例', '首次', 'start', 'install'],
    body: (
      <>
        <p>念语是一款本地 AI 数字人聊天客户端，所有数据保存在本机。</p>
        <ul>
          <li>首次启动会播放开屏动画（仅首次，之后不再重复）；程序默认单实例运行，再次点击图标会聚焦已有窗口。</li>
          <li>首次使用会有引导向导：至少添加一个模型后即可开始聊天。</li>
          <li>主界面左侧为功能导航与会话列表，右侧为聊天区。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-model',
    title: '模型管理（二级页）',
    kw: ['模型', 'api', 'baseurl', 'key', '配置', 'model', '默认模型', '全局参数', '温度', 'topp', 'topk', '探针', '检测', '能力', '跟随全局'],
    body: (
      <>
        <p>「设置 → 模型管理」为独立二级页，集中管理全部模型配置：</p>
        <ul>
          <li>添加/编辑模型：Base URL、API Key、模型名、上下文长度、分组标签、QPS 限速等。</li>
          <li>全局模型参数（默认值）：流式输出、温度（1.00）、Top-P（0.95）、Top-K（50）；模型编辑器内可单独覆盖，「跟随全局设置」复选框默认勾选，调参自动取消。</li>
          <li>能力检测：真实探针测试视觉/工具/JSON/NSFW/流式输出支持与上下文窗口，结果以徽章展示。</li>
          <li>「↺ 恢复到全局设置」一键清空模型独立参数。支持 DeepSeek/OpenAI/Anthropic/本地/自定义/OpenAI 兼容六种提供方。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-roles',
    title: '角色管理',
    kw: ['角色', '人物', '数字人', 'avatar', '通讯录'],
    body: (
      <>
        <p>「通讯录」中创建与管理你的数字人角色。</p>
        <ul>
          <li>每个角色可绑定独立模型、头像、人设与语音音色。</li>
          <li>从通讯录发起单聊；角色也可加入群聊。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-chat',
    title: '聊天与群聊',
    kw: ['聊天', '群聊', '提及', '发言', 'chat', 'group', '图片', '联网', '搜索', '引用', '回到底部'],
    body: (
      <>
        <p>单聊即与一名数字人对话；群聊可加入多名角色，由导演模型、轮询或 @ 提及决定发言者。</p>
        <ul>
          <li>支持多图合并发送（图集气泡）、图片发图生图/生视频、联网搜索（结果气泡与 [n] 引用编号重启后保留可点击）。</li>
          <li>长对话自动出现「⬇ 回到底部」按钮；支持消息撤回/回滚/转发/快捷记忆。</li>
          <li>流式输出三级体系：设置页全局开关、模型编辑器独立开关、聊天界面 🌊 按钮显示本对话生效值。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-worldbook',
    title: '世界书',
    kw: ['世界书', 'worldbook', '设定', '背景', 'lorebook'],
    body: (
      <>
        <p>「资源库 → 世界书」管理世界观设定，按关键词或常驻注入对话。</p>
        <ul>
          <li>支持应用到指定聊天（按聊覆盖，优先级：聊天 &gt; 角色 &gt; 全局默认）。</li>
          <li>支持拖动排序（仅展示顺序）、SillyTavern/NAI lorebook 导入。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-memory',
    title: '记忆系统',
    kw: ['记忆', 'memory', '提炼', '隔离', '遗忘'],
    body: (
      <>
        <p>AI 可从对话中自动提炼长期记忆，也可手动添加。</p>
        <ul>
          <li>记忆隔离（默认开）：同一角色在不同聊天的记忆互相独立。</li>
          <li>随机事件的选择会与事件一起写入记忆；撤回/删除关联消息会联动清理记忆。</li>
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
        <p>在语音设置填写 TTS 专用 API 后即可朗读：右键任意有文字的气泡点「朗读」，或开启「全局自动播报」让 AI 回复自动播放。</p>
        <ul>
          <li>多协议自动识别（按 Base URL 路由）：OpenAI 兼容、MiniMax、Google Gemini、ElevenLabs、Fish Audio、字节火山、Azure、AWS Polly、腾讯云、百度、阿里通义 qwen-tts、Cartesia。</li>
          <li>音色列表自动从厂商接口拉取；没有列表接口的厂商直接手填——软件不内置任何音色/模型清单，留空合成时会明确提示补填。</li>
          <li>字节 / AWS Polly / 腾讯云 / 百度需在 API Key 栏填 `ID:Secret` 双凭据（如字节为 AppID:AccessToken）。</li>
          <li>朗读范围可选 对话 / 旁白 / 人物心理（「…」为心理标记），默认仅对话；已合成音频自动缓存复用，重复朗读不消耗 token（可在设置关闭）。</li>
          <li>「按角色配置音色」：可为每位角色单独配 Base URL / Key / 模型 / 音色，留空回退全局。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-minichat',
    title: '快捷聊天小窗',
    kw: ['小窗', '迷你', 'mini', '快捷', 'miniwindow'],
    body: (
      <>
        <p>小窗是独立的紧凑聊天窗，通过托盘或快捷键唤起，关闭仅隐藏不退出。</p>
        <ul>
          <li>功能与主窗一致：多图、语音、TTS、联网搜索、流式开关等。</li>
          <li>小窗与主界面共用同一份设置与数据，实时同步。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-image',
    title: '生图与场景图',
    kw: ['生图', '画图', '图像', 'image', '文生图', '场景图'],
    body: (
      <>
        <p>在「生图」设置填写独立的图像生成 API，即可在对话中调用文生图。</p>
        <ul>
          <li>生图与模型配置完全解耦，拥有独立的 Base URL / API Key。</li>
          <li>角色头像可作为参考图；支持异步场景配图。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-video',
    title: '生视频',
    kw: ['视频', '生视频', 'video', '进度', '气泡'],
    body: (
      <>
        <p>调用视频生成后，界面右下角会出现可拖动的进度悬浮气泡。</p>
        <ul>
          <li>后端自动识别「任务式」接口（每 3 秒轮询）与「即时返回」接口；完成后气泡自动收起。</li>
          <li>视频消息以内嵌播放器展示，可直接播放；需在「生视频」设置中配置独立 API。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-moments',
    title: '朋友圈',
    kw: ['朋友圈', '动态', '点赞', '收藏', 'moments', '视频'],
    body: (
      <>
        <p>朋友圈为社交功能，数字人可自动生成帖子（含图片/视频），你可互动。</p>
        <ul>
          <li>支持 AI 驱动帖子生成、点赞、收藏、人物关系价值判断。</li>
          <li>每个角色可设每日自动发帖上限。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-random',
    title: '随机事件',
    kw: ['随机事件', '事件', '选项', '好感', 'random', 'event'],
    body: (
      <>
        <p>聊天中会随机触发事件弹窗，由你选择走向。</p>
        <ul>
          <li>选项影响好感度与角色心情；心情变化有平滑过渡。</li>
          <li>你的选择会与事件一起写入角色记忆（未选的选项不会写入），遵循记忆隔离。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-observer',
    title: '观察者模式（对局）',
    kw: ['观察者', '对局', '公屏', '私密', 'observer'],
    body: (
      <>
        <p>群聊可开启观察者模式：公屏频道与观察者私密小窗两套隔离信息流。</p>
        <ul>
          <li>可配置记忆冻结、公屏/私密记忆写入、情绪演算开关。</li>
          <li>统计界面展示对局情绪轨迹。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-proactive',
    title: '主动消息（经典定时 / NHPP 智能调度）',
    kw: ['主动', '消息', '空闲', 'idle', 'nhpp', '贝叶斯', '勿扰', '回访', '定时'],
    body: (
      <>
        <p>设置中可二选一：经典定时（原机制）或 NHPP 智能调度，相互独立。</p>
        <ul>
          <li>经典定时：固定/随机间隔计时，支持每聊天独立开关与冷却。</li>
          <li>NHPP：按时段强度建模 + 从你的回应学习理想频率（积极回应升、长期忽略降）+ 疲劳保护 + 勿扰窗口 + 定向回访（提到「开会/吃饭」到点跟进一条）+ 每日上限。</li>
          <li>NHPP 数据存独立的 proactive-nhpp.json，不影响聊天数据。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-mcp',
    title: 'MCP 工具扩展',
    kw: ['mcp', '工具', '服务器', 'tool', '协议', '扩展'],
    body: (
      <>
        <p>「设置 → 模型管理 → MCP 服务器」可接入 MCP（Model Context Protocol）服务器。</p>
        <ul>
          <li>填写名称、启动命令与参数（如 npx -y @modelcontextprotocol/server-filesystem 路径），实时查看连接状态与工具列表。</li>
          <li>工具仅注入能力检测确认支持工具调用的模型，非流式请求自动多轮执行。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-appearance',
    title: '主题与外观',
    kw: ['主题', '外观', '毛玻璃', '圆角', '透明', '光标', '字体', 'theme'],
    body: (
      <>
        <p>多套主题（含毛玻璃自定义背景）、全局字体/字号、圆角与气泡透明度、输入框配色。</p>
        <ul>
          <li>自定义 Canvas 动态光标：主界面、小窗、悬浮球三处一致生效（拖尾/粒子/空闲隐藏）。</li>
          <li>全局动效开关：低配电脑可关闭动画。</li>
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
          <li>左键：呼出主界面并清空未读；右键：退出/本次关闭/置顶开关。</li>
          <li>悬停展开快捷聊天面板（置顶/拖动排序与主界面同步）。</li>
          <li>未读角标 ≤99 显示数字，&gt;99 显示「99+」；动态光标与小窗/主界面一致。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-sidebar',
    title: '聊天侧边栏缩进',
    kw: ['侧边栏', '缩进', '收起', '恢复', '全屏聊天'],
    body: (
      <>
        <p>聊天列表头部「«」按钮可收起会话列表，让聊天区占满整页。</p>
        <ul>
          <li>收起后在左侧导航图标列底部（设置图标下方）出现「›」恢复按钮。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-launch',
    title: '开机自动启动',
    kw: ['开机', '自启', '启动', 'launch', 'boot'],
    body: (
      <>
        <p>「设置 → 常规」中的「开机自动启动」开关（默认开启）。</p>
        <ul>
          <li>系统登录后自动运行念语；关闭后需手动启动。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-stats',
    title: '统计界面',
    kw: ['统计', 'token', '消耗', 'stats', '关系值'],
    body: (
      <>
        <p>左侧「📊 统计」汇总 Token 消耗与角色统计。</p>
        <ul>
          <li>人物板块：关系值 + 关系类别标签。</li>
          <li>聊天模型调用量排名：按模型累计 Token 排序，仅统计当前启用模型。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-search',
    title: '设置搜索与二级页导航',
    kw: ['搜索', '查找', '设置', 'search', '二级页', '返回'],
    body: (
      <>
        <p>设置页顶部搜索框覆盖所有设置项（含模型管理二级页内条目）。</p>
        <ul>
          <li>候选按关联度排序、命中高亮；点击/回车自动切入对应二级页并滚动高亮定位。</li>
          <li>字体/角色卡/模型管理二级页的返回按钮固定在页面名称右侧；再次点击左侧「设置」图标直接回设置主界面。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-backup',
    title: '数据备份与恢复',
    kw: ['备份', '恢复', '数据', 'backup', '重置', '路径', '日志'],
    body: (
      <>
        <p>念语数据保存在本机，可手动备份与恢复。</p>
        <ul>
          <li>在「备份」设置中创建/恢复备份或导出压缩包；支持自定义数据目录与默认备份目录。</li>
          <li>「重置设置」仅清空配置；「删除全部数据」会清空所有本地数据，请谨慎。</li>
          <li>错误日志可在设置中查看与导出；模型报错浮层按语言给出原因与解决办法。</li>
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
          background: 'var(--color-panel, #fff)',
          color: 'var(--color-text, #1a1d24)',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,.4)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
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
