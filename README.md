# 念语 · AI 数字人聊天客户端

基于文档规格实现的 Windows 桌面客户端：**Electron + TypeScript + React**，所有数据本地存储。

## 功能覆盖

- **多模型接入**：OpenAI / DeepSeek / Anthropic / Anthropic 兼容 / Gemini / OpenAI 兼容 / 本地
- **多 API 配置**：文本模型、**TTS / ASR / 生图 / 生视频**都能添加多条配置并切换「当前启用项」；
  老版本只配了一组的用户升级后自动保留为第一个配置项
- **模型配置管理 + 角色独立绑定模型**：每个模型可设基础参数（上下文长度、maxTokens 等）与
  高级配置（temperature / topP / topK / frequency & presence penalty / 自定义 Header / 自定义 Body）；
  每个角色在「交互设定」中绑定一个已启用模型；**所有对模型的调用（含翻译、记忆提炼、模型对比等
  内部功能）都遵守该模型的配置参数**
- **数字人（角色）管理**：完整字段（性格/背景/外貌/世界观/规则/示例/开场白等）+ **AI 自动补全简介**
- **单聊与群聊**：群内多数字人依次生成回复；输入 `@` 指定成员优先回复；支持导演模型智能选人与轮询两种调度
- **好感度与情绪系统**：关键词情感分析动态调整，注入 System Prompt 影响语气；AI 判定关系值
- **记忆系统**：AI 自动提炼记忆 + 手动「一键记忆」；按角色 + 可选聊天**双层作用域**，可按聊天独立开关；
  记忆面板会说明「为什么记忆是空的」
- **消息分支**：右键任意消息气泡 → **从此处开启新对话**，复制该消息及之前的消息与记忆，新对话独立且自动开启记忆隔离
- **选取文字复制**：气泡右键弹出文本框，拖动选取后复制到剪贴板
- **语音**：TTS 朗读（**可按人物绑定音色**、单独调语速/音调、支持试听与音频缓存复用）、ASR 语音输入；
  **翻译结果可直接朗读**（原文与译文分别可读，支持重新生成音频，不会重叠播放）
- **Token 实时统计**：每条消息显示消耗；统计页提供 **Token 饼状图排名**、好感度与陪伴时间排行、最喜爱人物
- **统计界面**：Token 饼状图（<10% 并入「其他」、点图进完整列表、同分按字母序、顺时针拉开动画、
  悬停放大、**配色随主题变化**）／好感度与陪伴时间排行（三级 tiebreak）／
  **最喜爱人物**（含头像、陪伴时间、性别、个性签名，可从聊天卡片右键快捷设置）
- **搜索**：全局搜索规范——候选项最多 5 个、支持模糊搜索、按关联度排序、点击跳转并高亮闪动、可滚动查看其余
- **不常用聊天文件夹**：超过设定天数未聊自动归入；**置顶聊天不自动移入但可手动移入**；
  移入后置顶状态消失、移出不恢复
- **空闲主动回复**：可设置「发满几条主动消息才开始等你回复」，也可完全关闭该等待机制
- **世界书 / 规则库 / 技能（Skill）**：含内置默认技能（狗头军师）
- **多主题系统**：**15 套主题**（微信经典 / 毛玻璃 / 液态玻璃 / 极简暗色 / 活力多彩 / 天青 / 星河 / 松林 /
  余烬 / 霜白 / 玫瑰 / 赛博 / 石墨 / 靛蓝 / 沙丘），纯 CSS 变量驱动，随设置持久化
  - **液态玻璃**：对齐苹果 Liquid Glass 的材质（透底 + 折射边缘 + 镜面高光 + 分级阴影）；
    专属设置面板可单独调**色调 / 不透明度 / 模糊度**，另有液态流动与自动对比度调节
  - **毛玻璃 / 液态玻璃**另可自定义背景色或导入背景图，磨砂效果保留
- **动画三档控制**：全部开启 / 全部关闭 / 自定义（15 个可独立开关的动画分组）
- **一键备份 / 还原**：压缩整个数据目录（含聊天数据、图片、设置、记忆）
- **多语言**：简体中文 / 繁體中文 / English / 日本語 / 한국어 / Deutsch / Français / Español /
  Português / Русский
- **桌面悬浮球 / 快捷聊天小窗**：小窗与主窗机制同步
- **请求队列可视化**：主界面右缘贴边面板，实时展示各模型 QPS 队列并支持拖动调序

## 目录结构

```
Nianyu-Chat/
├─ electron/            # 主进程
│  ├─ main.ts           # 窗口 + IPC + 聊天/好感度/记忆/主动消息逻辑
│  ├─ preload.ts        # 类型化上下文桥
│  ├─ db.ts             # DataManager（纯 JS JSON 存储，零原生编译）
│  ├─ ai.ts             # AI 调用（OpenAI / Anthropic / Gemini 兼容）+ 语音/生图/生视频
│  ├─ proactive.ts      # 主动消息调度
│  ├─ awaitingReply.ts  # 「等你回复才发下一条」等待态状态机
│  └─ backup.ts         # 备份/还原（adm-zip）
├─ src/                 # 渲染进程（React）
│  ├─ App.tsx
│  ├─ ipc.ts
│  ├─ theme/            # 主题 Context + variables.css（15 套主题）
│  ├─ components/       # 侧栏/列表/聊天窗/角色编辑器/群组/设置/统计/资源库
│  ├─ utils/            # 模糊搜索、饼图几何、不常用聊天判定、伪流式、动画控制
│  └─ i18n/             # 多语言（translations.ts 的 zh/en + 8 个 locale JSON）
├─ scripts/             # 验证脚本（见下）
├─ package.json / tsconfig*.json / vite.config.ts
```

## 运行（零原生编译）

存储为纯 JS JSON 文件，无需 `better-sqlite3` 编译，也无需 Python / VS 编译工具。

```bash
npm install          # 安装依赖（仅下载，无编译）
npm run build        # 编译主进程 + 构建界面（一次）
npm start            # 启动念语
```

> 进阶热更新（改代码自动刷新）：开两个终端，A 运行 `npm run dev`（Vite），B 运行 `set NIANYU_DEV=1 && npm start`。

## 验证脚本

关键机制均配可运行断言（`scripts/`，共 200+ 条），改动后建议回归：

```bash
node scripts/verify-media-migration.mjs          # 多 API 配置迁移（老配置不丢）
node scripts/verify-fork-from-message.mjs        # 消息分支的消息/记忆截取口径
node scripts/verify-awaiting-threshold.mjs       # 主动消息等待阈值
node scripts/verify-model-config-compliance.mjs  # 审计有无绕过模型配置的调用
node scripts/verify-search-suggest.mjs           # 搜索规范（最多5条/模糊/关联度）
node scripts/verify-inactive-folder.mjs          # 不常用聊天判定与置顶处理
node scripts/verify-stats-chart.mjs              # 饼图几何与 WCAG 对比度
```

## 使用要点

1. **设置 → 模型设置**里新增模型配置（提供商、Base URL / Key、模型 ID、采样参数），并启用。
2. **通讯录**点 ＋ 新建数字人，在「交互设定」中绑定模型；「角色语音」区可绑定音色与语速音调。
3. 点角色「聊天」进单聊；聊天页 ＋ 可建群聊。
4. **记忆**：聊天工具栏「⋯ 其他操作」里打开「🧠 长记忆」，该聊天才会自动提炼记忆；
   也可随时选中文字右键「一键记忆」立即写入。
5. **统计**：左侧栏 📊 查看 Token 排名 / 好感度与陪伴时间 / 最喜爱人物。

数据位置：默认 `文档/念语数据/`（可在「设置 → 窗口 → 数据路径」自定义）。

## 打包为安装包

```bash
npm run build
CSC_LINK="" CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

产物：`release/` 下的 NSIS 安装包。当前为未签名构建，安装时 Windows 会提示未知发布者；
如需消除告警需另行配置代码签名证书。

## GitHub 自动构建与发布

仓库已配置 GitHub Actions。在 `main` 分支推送 `v*` 标签后，自动在 Windows runner 上构建并发布到 GitHub Release：

```bash
git tag v2.3.94
git push origin v2.3.94
```

> 说明：当前工作流沿用本地无签名构建（`CSC_LINK=""`）。若已购代码签名证书，将证书与密码写入仓库
> Secrets（`CSC_LINK` / `CSC_KEY_PASSWORD`）并修改工作流对应环境变量即可启用签名。

## Gitee 镜像（国内可达）

为提升国内下载稳定性，可在 GitHub 仓库 Secrets 配置 `GITEE_TOKEN`、`GITEE_REPO`、`GITEE_PRIVATE_KEY`，
Action 会自动将代码与标签同步到 Gitee。

## 文档

- `使用说明.md` —— 完整使用文档（软件内「设置 → 内置使用指南」为其同步版）
- `版本更新记录.md` —— 每个版本改了什么
- `硬编码清单.md` —— 代码里的硬编码值清单（超时 / 阈值 / 上限等）

## 第三方素材与致谢

本项目声明式致谢以下第三方内容：

- **内置技能「狗头军师」** —— 引入自开源仓库 [`shengjidaguai-china/goutoujunshi`](https://github.com/shengjidaguai-china/goutoujunshi)，
  MIT 许可，`Copyright (c) 2026 powerycy`。仅使用其 `SKILL.md` 作为提示词种子（与上游逐字节一致），
  未引入其脚本与知识库分册。本项目不主张该内容的原始著作权。
- **开源依赖** —— 共 457 个传递依赖全部为宽松许可（MIT / ISC / BSD / Apache-2.0 等），
  **无 GPL / AGPL / LGPL / MPL 类依赖**，故 MIT 开源不受传染。其中 `caniuse-lite` 采用
  CC-BY-4.0（强制署名），已在 `NOTICE` 中署名。
- **音频素材** —— 项目**全部音效均为程序合成自制**（见 `scripts/gen-builtin-sounds.mjs`），
  不含任何第三方采样素材。图标亦为自制。
- **数据格式兼容** —— 实现了 SillyTavern 角色卡 / 世界书、OpenAI `ai-plugin.json` 等
  第三方**格式**的解析器（独立实现，未复制任何来源项目代码）。

完整清单与详细说明见 [`NOTICE`](./NOTICE) 与 [`ASSETS-LICENSES.md`](./ASSETS-LICENSES.md)。

## 许可证

本项目基于 MIT License 开源，版权归「前方」所有，详见 `LICENSE`。