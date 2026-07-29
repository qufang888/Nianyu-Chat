# 念语 · AI 数字人聊天客户端

基于文档规格实现的 Windows 桌面客户端：**Electron + TypeScript + React**，所有数据本地存储。

## 功能覆盖

- 多模型接入：OpenAI / DeepSeek / 自定义兼容端点（OpenAI 格式）
- 数字人（角色）管理：完整字段（性格/背景/外貌/世界观/规则/示例/开场白等）+ **AI 自动补全简介**
- 单聊与群聊：群内多数字人依次生成回复；输入 `@` 指定成员优先回复
- 好感度系统：关键词情感分析动态调整，注入 System Prompt 影响语气，聊天页浮层提示
- Token 实时统计：每条消息显示消耗，聊天页与全局累计实时更新
- 图片发送：选择本地图片 → 复制到用户数据目录 → 缩略图 + 点击全屏预览；图片随备份打包
- 设置页：API Key 管理、默认模型、主题切换
- 一键备份 / 还原：压缩整个 `data` 目录（含聊天数据、图片、设置），还原后自动重启
- 多主题系统：微信经典 / 毛玻璃 / 极简暗色 / 活力多彩，纯 CSS 变量驱动，随设置持久化
- **模型配置管理 + 角色独立绑定模型**：设置页「模型管理」可增删改模型配置（提供商 OpenAI/DeepSeek/Anthropic/自定义、Base URL、Key、模型 ID、上下文长度、温度、启停）；每个角色在「交互设定」中绑定一个已启用模型；单聊/群聊均按各自绑定配置调用，群内多角色可并行用不同模型回复；发送前校验模型失效并阻止；聊天窗显示「🧠 模型名」标签。

## 目录结构

```
nianyu-client/
├─ electron/            # 主进程
│  ├─ main.ts          # 窗口 + IPC + 聊天/好感度/备份逻辑
│  ├─ preload.ts       # 类型化上下文桥
│  ├─ db.ts            # DataManager（纯 JS JSON 存储，零原生编译）
│  ├─ ai.ts            # AI 调用（兼容 OpenAI/DeepSeek）
│  └─ backup.ts        # 备份/还原（adm-zip）
├─ src/                # 渲染进程（React）
│  ├─ App.tsx
│  ├─ ipc.ts
│  ├─ theme/           # 主题 Context + variables.css（4 套主题）
│  ├─ components/      # 侧栏/列表/聊天窗/角色编辑器/群组/设置
│  └─ utils/markdown.tsx
├─ package.json / tsconfig*.json / vite.config.ts
```

## 运行（零原生编译）

存储已改为纯 JS JSON 文件，无需 `better-sqlite3` 编译，也无需 Python / VS 编译工具。

```bash
npm install          # 安装依赖（仅下载，无编译）
npm run build        # 编译主进程 + 构建界面（一次）
npm start            # 启动念语（单条命令即可打开应用窗口）
```

> 进阶热更新（改代码自动刷新）：开两个终端，A 运行 `npm run dev`（Vite），B 运行 `set NIANYU_DEV=1 && npm start`。

打包：

```bash
npm run build        # 编译主进程 + 构建渲染进程
```

## 使用要点

1. 打开「设置 - 模型管理」新增模型配置（选提供商、填 Base URL / Key / 模型 ID / 温度，并启用）。
2. 「通讯录」点击 ＋ 新建数字人，在「交互设定」中为其绑定一个模型，可填基本信息后点 **✨ AI 补全简介**。
3. 点击角色「聊天」进入单聊；「聊天」页 ＋ 可建群聊并添加多名数字人。
4. 群聊输入 `@` 弹出成员列表，被 @ 的成员会优先回复。
5. 输入框 🖼️ 发送本地图片。
6. 「设置」内可切换 4 套主题、一键备份与还原。

数据位置：`%APPDATA%/念语/data`（聊天记录、角色、好感度、图片、设置均在此）。

## 打包为安装包

```bash
npm run build
CSC_LINK="" CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

产物：`release/念语 Setup 1.0.0.exe`（约 77MB）。当前为未签名构建，安装时 Windows 会提示未知发布者；如需消除告警需另行配置代码签名证书（见下方说明）。

## GitHub 自动构建与发布

仓库已配置 GitHub Actions（`.github/workflows/build.yml`）。在 `main` 分支推送 `v*` 标签后，自动在 Windows runner 上构建并发布到 GitHub Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

> 说明：当前工作流沿用本地无签名构建（`CSC_LINK=""`）。若已购代码签名证书，将证书与密码写入仓库 Secrets（`CSC_LINK` / `CSC_KEY_PASSWORD`）并修改工作流对应环境变量即可启用签名。

## Gitee 镜像（国内可达）

为提升国内下载稳定性，可在 GitHub 仓库 Secrets 配置 `GITEE_TOKEN`、`GITEE_REPO`、`GITEE_PRIVATE_KEY`，Action 会自动将代码与标签同步到 Gitee。Release 安装包资产建议在 Gitee 手动上传或后续补全自动化同步。

## 许可证

本项目基于 MIT License 开源，版权归「前方」所有，详见 `LICENSE`。
