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
    kw: ['模型', 'api', 'baseurl', 'key', '配置', 'model', '默认模型', '全局参数', '温度', 'topp', 'topk', '探针', '检测', '能力', '跟随全局', '搜索', '限速', 'qps', '聊天模型切换'],
    body: (
      <>
        <p>「设置 → 模型管理」为独立二级页，集中管理全部模型配置：</p>
        <ul>
          <li>添加/编辑模型：Base URL、API Key、模型名、上下文长度、分组标签、QPS 限速等。<b>模型名与 Base URL 均不预填</b>，输入框下方有灰色小字说明格式（如 Base URL 填到版本号为止，软件自动拼接接口路径；模型名可手填或点「刷新模型列表」选取）。</li>
          <li>提供商：OpenAI / DeepSeek / Anthropic / <b>Anthropic 兼容</b> / <b>Gemini（原生接口）</b> / 本地模型 / OpenAI 兼容。Anthropic 兼容可自填第三方网关地址（走 /v1/messages 协议）；Gemini 走原生 generateContent 接口（流式为原生实现）。原「自定义」提供商已移除，老配置自动迁移为「OpenAI 兼容」。</li>
          <li>全局模型参数（默认值）：流式输出、温度（1.00）、Top-P（0.95）、Top-K（50）；模型编辑器内可单独覆盖，「跟随全局设置」复选框默认勾选，调参自动取消。</li>
          <li>能力检测：真实探针测试视觉/工具/JSON/NSFW/流式输出支持与上下文窗口，结果以徽章展示。<b>测试范围</b>（检测按钮下方）决定实际探测哪些项，与上方「能力标记」互不影响；检测进行中范围冻结。</li>
          <li>QPS 限速覆盖「检测能力 / 测试连接 / 一键检测全部」：按界面上当前填写的 QPS 执行，<b>未保存的草稿也立即生效</b>（超过 1 秒的等待会在结果里注明）。</li>
          <li>模型搜索框支持按 <b>API 配置名称或模型名称</b>模糊搜索（多词、大小写不敏感），点击结果会滚动到对应模型卡片并高亮闪动。</li>
          <li><b>识图模型</b>：在「模型管理」中从已添加模型里选择（可模糊搜索、列表可滚动）。设置后，聊天中发送的图片均交给该模型识别与回复（调用同样受 QPS 限速、回复走正常消息管线）；未设置时图片由各角色模型按自身「支持图片输入」能力处理。被设为识图模型的卡片会带「识图」徽标。</li>
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
    kw: ['聊天', '群聊', '提及', '发言', 'chat', 'group', '图片', '联网', '搜索', '引用', '回到底部', '模型切换', '跟随人物', '聊天模型', '回滚'],
    body: (
      <>
        <p>单聊即与一名数字人对话；群聊可加入多名角色，由导演模型、轮询或 @ 提及决定发言者。</p>
        <ul>
          <li>支持多图合并发送（图集气泡）、图片发图生图/生视频、联网搜索（结果气泡与 [n] 引用编号重启后保留可点击）。</li>
          <li><b>拖拽添加图片</b>：把图片文件从资源管理器直接拖到输入框区域，松开即加入待发列表（与 📷 按钮等效，主窗与小窗输入区均支持）；不支持的文件类型会提示并忽略。拖到窗口其他空白位置则触发「快速导入」。</li>
          <li><b>模型标签</b>：标题栏人物名右侧显示当前生效模型，<b>点击可在「API 配置名 / 实际模型名」之间切换</b>（全局偏好）；切换聊天模型后该标签立即跟随更新。气泡上方的模型标签已移除，模型信息统一在标题栏显示。</li>
          <li><b>聊天模型切换（仅单聊）</b>：「其他操作」菜单可勾选「跟随人物（或默认）模型」——勾选时本聊天使用人物编辑中绑定的模型（未绑定则默认模型）且不可更改；取消勾选后可为<b>仅本聊天</b>选择其他模型（该人物的其他聊天不变）。选择器列表可滚动、支持按 API 配置名/模型名模糊搜索，点搜索结果会跳转并高亮闪动。</li>
          <li>长对话自动出现「⬇ 回到底部」按钮；支持消息撤回/回滚/转发/快捷记忆。</li>
          <li><b>回滚</b>会删除该消息之后的所有消息、<b>该时间点之后的全部记忆</b>（手动/自动、人工修改过或纯手写的都算）与<b>该时间点之后该角色的朋友圈动态</b>（不论点赞收藏）。「编辑重发」走同一逻辑。</li>
          <li>流式输出三级体系：设置页全局开关、模型编辑器独立开关、聊天界面 🌊 按钮显示本对话生效值。</li>
          <li>伪流式输出（可选）：设置页「伪流式输出」开启后，正文不再实时逐字显示（思维链照常实时输出），等整条回复生成完毕再以固定间隔逐字渐显放出；间隔可调，范围 0.05~1 秒/字，默认 0.2 秒。该功能纯前端呈现，不改变真实请求方式，主窗与小窗同时生效。</li>
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
    id: 'guide-quickimport',
    title: '快速导入',
    kw: ['拖拽', '拖入', '快速导入', '导入', '角色卡导入', '插件导入', '规则导入', '世界书导入'],
    body: (
      <>
        <p>把文件从资源管理器直接拖进软件窗口的空白区域，松开即自动识别类型并导入，无需经文件选择器逐级找目录。</p>
        <ul>
          <li>支持：SillyTavern PNG 角色卡（自动以该图作头像直接建卡）、角色卡 JSON、世界书 / 规则 / 插件清单（自动识别，兼容 SillyTavern / NovelAI / OpenAI ai-plugin 格式）。</li>
          <li>区域区分：拖到<b>聊天输入框</b>区域 = 添加待发图片（不触发导入）；拖到窗口<b>其他任意位置</b> = 快速导入。每次最多处理 20 个文件，逐个独立导入、互不影响。</li>
          <li>导入结果以气泡提示：成功显示类型与数量；失败逐个给出原因（如「不是角色卡 PNG」「不支持的文件类型」「文件读取失败」）。</li>
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
          <li>记忆归属：每条记忆都挂在<b>人物</b>名下，并带「产生于哪个聊天」的标记——自动提炼/手动总结/随机事件写入的是「本聊天」的记忆（遵循记忆隔离），长按消息快捷记忆、图片记忆与记忆面板手动添加的是<b>角色级共享记忆</b>（该人物所有开了长记忆的聊天都能读到）。</li>
          <li><b>回滚会连带清理</b>：回滚到某条消息时，该时间点之后该聊天角色的全部记忆（手动/自动、人工改过、纯手写都算）与朋友圈动态（不论点赞收藏）都会删除；删除条数会在提示里显示。</li>
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
    kw: ['语音', '播报', '朗读', 'tts', '音色', '角色', '暂停', '续播', '重播', '全局开关'],
    body: (
      <>
        <p>在语音设置填写 TTS 专用 API 后即可朗读：右键任意有文字的气泡点「朗读」，或开启「全局自动播报」让 AI 回复自动播放。</p>
        <ul>
          <li><b>全局开关</b>：聊天标题栏的 🔊/🔇 一键开关全局 TTS 语音（小窗在抽屉菜单内），关闭后气泡不再显示播报按钮、自动播报停止。</li>
          <li><b>播放 / 暂停 / 续播</b>：播报时播放键变为 ⏸，点一下暂停；再点变 ▶ 从停止处继续播放（不重新合成）。旁点 ⟳ 可重播——复用已合成音频，不重新生成。</li>
          <li><b>重新生成语音</b>：右键该消息 → 「重新生成语音」才会忽略缓存重新合成（普通播放/重播一律命中缓存，不消耗额度）。</li>
          <li>多协议自动识别（按 Base URL 路由）：OpenAI 原生 / OpenAI 兼容网关、MiniMax、豆包语音 1.0、豆包语音 2.0 与 BytePlus、Google Gemini、ElevenLabs、Fish Audio、Azure 语音、AWS Polly、腾讯云、百度、阿里通义 qwen-tts、Cartesia。</li>
          <li>设置页「已适配的 TTS 提供商」清单列出全部已支持协议，并标明该协议是否原生支持语速 / 音调、是否提供音色列表端点，以及是否区分国内站与国际站；以后新增提供商此清单会同步增加。</li>
          <li>国内站 / 国际站：MiniMax（api.minimaxi.* ↔ api.minimax.io）、字节豆包与 BytePlus、Azure（全球 ↔ 中国区世纪互联）、腾讯云（国内 ↔ tts.intl）、阿里百炼（国内 ↔ 新加坡 ↔ 美国）、AWS Polly（全球 ↔ 中国区）均已同时适配，按 Base URL 域名自动走对应站点，两站一般需各自填写 API Key。</li>
          <li>音色列表自动从厂商接口拉取；没有列表接口的厂商直接手填——软件不内置任何音色/模型清单，留空合成时会明确提示补填。</li>
          <li>语速 / 音调：按厂商协议的原生参数下发（不做前端变速、不改变音色）。语速 0.5~2.0 倍，音调 -12~+12（近似半音）。是否生效取决于协议是否原生支持——MiniMax、豆包、Azure、百度支持音调；OpenAI、腾讯云、阿里、ElevenLabs、Fish Audio、Cartesia 等仅支持语速；Gemini 与 AWS Polly 两者都不支持。角色级可单独覆盖，留空回退全局。</li>
          <li>语速 / 音调已纳入朗读缓存键：调整后会重新合成，不会误用旧缓存。</li>
          <li>字节 / AWS Polly / 腾讯云 / 百度需在 API Key 栏填 `ID:Secret` 双凭据（如字节为 AppID:AccessToken）。</li>
          <li>朗读范围可选 对话 / 旁白 / 人物心理（「…」为心理标记），默认仅对话；已合成音频自动缓存复用，重复朗读不消耗 token（可在设置关闭）。</li>
          <li>「按角色配置音色」：可为每位角色单独配 Base URL / Key / 模型 / 音色 / 语速 / 音调，留空回退全局。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-minichat',
    title: '快捷聊天小窗',
    kw: ['小窗', '迷你', 'mini', '快捷', 'miniwindow', '抽屉', '模型切换', '聊天模型'],
    body: (
      <>
        <p>小窗是独立的紧凑聊天窗，通过托盘或快捷键唤起，关闭仅隐藏不退出。</p>
        <ul>
          <li>功能与主窗一致：多图、语音、TTS、联网搜索、流式开关等。</li>
          <li>小窗与主界面共用同一份设置与数据，实时同步。</li>
          <li><b>模型切换</b>：小窗「抽屉菜单」内与主窗同款（仅单聊）——勾选「跟随人物（或默认）模型」或取消勾选后仅为本聊天切换模型，两端共用同一实现、状态实时同步（任一窗口切换，另一端立即跟随）。</li>
          <li><b>全局 TTS 开关</b>：抽屉菜单内同样提供 🔈/🔇 一键开关全局语音播报，与主窗同步。</li>
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
          <li><b>面板弹出方向自适应</b>：球在屏幕左侧面板向右弹、右侧向左弹（垂直同理）；展开前与拖动中均做边界检测，面板始终完整显示不被屏幕边缘裁切；收回/重弹均为线性动画。</li>
          <li><b>收起即缩窗</b>：面板收起后窗口收缩为只包住球体，原面板区域与其它窗口重叠缩放互不干扰。</li>
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
    id: 'guide-update',
    title: '软件更新（自动检查 / 下载安装包）',
    kw: ['更新', '升级', '版本', '检查更新', '自动更新', '下载更新', 'github', 'update', 'upgrade', 'version', 'release'],
    body: (
      <>
        <p>念语会自动检查新版本，并可直接从 GitHub 下载安装包。</p>
        <ul>
          <li>自动检查：启动约 8 秒后检查一次（可在设置关闭），之后每 6 小时一次；只读取 GitHub 上的版本号，不上传本机数据。</li>
          <li>提醒：发现新版本时聊天界面顶部出现提示条（版本号 + 下载 / 打开发布页 / ×忽略此版本）；点 × 只忽略该版本，换新版本仍会提醒。v2.3.48 起还会在主界面弹出更新弹窗（每个版本只弹一次；手动检查不弹），并可在设置中永久关闭提醒（弹窗与提示条都不再出现，手动检查不受影响）。</li>
          <li>下载：安装包流式下载到系统「下载」文件夹（先写 .part 临时文件再改名），过程中显示百分比与已接收大小；开启「发现新版本后自动下载」可自动开始下载。</li>
          <li>安装：下载完成后可「打开所在文件夹」或「立即安装并退出」（调用系统安装器后自动退出念语，避免文件占用）。</li>
          <li>设置页路径：设置 → 通用 → 「软件更新」；含当前版本、检查更新、下载/安装入口，以及「启动时自动检查更新」（默认开）、「发现新版本后自动下载」（默认关）与「关闭更新提醒」（默认关）三个开关。</li>
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
          <li>备份文件名含创建时的软件版本号（如 NianyuBackup_v2.3.48_…zip，v2.3.48 起），包内另含版本清单。</li>
          <li>恢复由更高版本软件创建的备份时会先弹窗提示「可能不兼容」并建议先升级软件；确认后才会继续（旧备份无版本清单，不提示）。</li>
          <li>「重置设置」仅清空配置；「删除全部数据」会清空所有本地数据，请谨慎。</li>
          <li>错误日志可在设置中查看与导出；模型报错浮层按语言给出原因与解决办法。</li>
        </ul>
      </>
    ),
  },
  {
    id: 'guide-queue',
    title: '请求队列（QPS 排队可视化）',
    kw: ['队列', '排队', 'qps', '限速', 'queue', '贴边', '调序', '倒计时'],
    body: (
      <>
        <p>主界面右缘新增贴边排队图标，实时展示各模型的 QPS 请求队列（v2.3.46）。</p>
        <ul>
          <li>贴边图标：默认贴主界面右缘，<b>仅能沿右缘上下拖动</b>调整位置（自动记忆）；显示 🕒 与排队总数徽标，没有排队时半透明。</li>
          <li>点击图标弹出完整队列面板（<b>线性动画</b>），再次点击图标或点 × 收起；点击面板外部不自动关闭。</li>
          <li>不同模型的队列<b>分页展示</b>、互不影响、分开计时。</li>
          <li>手动调序：<b>拖动条目</b>或用 ↑↓ 调整发送顺序，主进程按新顺序依次放行；队头正在倒计时时显示「倒计时中」并锁定不可移动。</li>
          <li>快捷小窗与悬浮球不提供此面板，但其请求同样参与排队。</li>
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
