# 第三方素材与致谢

念语（Nianyu）以 **MIT 协议**开源。本文件登记项目所使用的**全部第三方素材与开源依赖**，
以便使用者知晓来源、遵守许可条款。

> 编写规范：每一条都必须可核实（能指向具体文件或上游仓库）。查不到来源的素材**不得留在项目里**。

---

## 一、非代码素材（音频 / 图标 / 图像）

### 1.1 内置音效 —— **自制（程序合成）**

| 文件 | 用途 | 来源 | 许可 | 合成脚本 |
|---|---|---|---|---|
| `public/sounds/click.wav` | 点击反馈 | **自制** | 作者原创（MIT） | `scripts/gen-builtin-sounds.mjs` |
| `public/sounds/error.wav` | 错误提示 | **自制** | 作者原创（MIT） | 同上 |
| `public/sounds/notification.wav` | 消息通知 | **自制** | 作者原创（MIT） | 同上 |
| `public/sounds/popup.wav` | 弹窗提示 | **自制** | 作者原创（MIT） | 同上 |
| `public/sounds/miniPopup.wav` | 小窗弹出 | **自制** | 作者原创（MIT） | 同上 |
| `public/sounds/messageSend.wav` | 消息发送 | **自制** | 作者原创（MIT） | 同上 |
| `public/sounds/nodeBanner.wav` | 剧情节点横幅 | **自制** | 作者原创（MIT） | 同上 |

**合成方式**：正弦波 / 三角波 / 方波叠加 + 指数衰减包络，纯数学波形生成，
**不含任何第三方采样素材**，因此不涉及任何第三方著作权。
重新生成：`node scripts/gen-builtin-sounds.mjs`

### 1.2 v2.3.97 的安全处置记录（历史）

v2.3.94 及更早版本内置了 11 个来自第三方音效站的 mp3，文件名形如
`audley_fergine-ui-button-click-5-327756.mp3`、`dragon-studio-mouse-click-sfx-free-376869.mp3`、
`universfield-new-notification-*.mp3`、`弹窗提示音.mp3`、`小窗弹出音.mp3`、`消息发送.mp3`。

**处置原因**：作者已无法回忆下载站点，因此无法确认其许可是否允许**原样再分发**。
此类音效站的通行条款（例如 Pixabay Content License）明文禁止
*"sell or redistribute the sound effects as they are"*——允许在应用内使用，
但**禁止把原始素材单独打包再分发**。项目此前将 mp3 提交进 git 并随安装包分发，
正落在该禁止条款内。经查证，未能在任何站点确认这批素材的许可条款，
故**已于 v2.3.97 全部移除并替换为上表的程序合成音**。

> 本次处置遵循「无法确认许可即视为不可用」的原则，
> 而非「查不到就当作可用」。素材的**功能**（点击反馈、消息提示等）本身不受著作权保护，
> 可由任何人独立实现，故替换后软件功能不受影响。

### 1.3 图标与图像

| 文件 | 用途 | 来源 | 许可 |
|---|---|---|---|
| `icon.ico` / `build/icon.ico` | 应用图标 | 作者自制 | MIT（作者原创） |
| `src/assets/cursor/cursor.png` | 自定义光标 | 作者自制 | MIT（作者原创） |

**项目未使用任何第三方图标库、图标字体或图片素材站资源。**
已核查：`iconfont` / `flaticon` / `undraw` / `Iconify` / `Font Awesome` / `Material Icons`
在源码中**零命中**；界面图标全部为 emoji 或 CSS/内联绘制。

### 1.4 字体

**项目未内嵌任何字体文件，未引用任何字体 CDN。** 已核查：无 `.woff` / `.ttf` / `.otf` / `.eof` 文件，
无 Google Fonts 引用。全部使用系统字体栈。

---

## 二、内置技能（AI 提示词资产）

### 2.1 「狗头军师」（`goutoujunshi`）

| 项 | 内容 |
|---|---|
| 上游仓库 | https://github.com/shengjidaguai-china/goutoujunshi |
| 许可 | **MIT License** |
| 版权人 | `Copyright (c) 2026 powerycy` |
| 引入形式 | `electron/builtinSkills.ts`（种子数据，3891 字符，**与上游 `SKILL.md` 逐字节一致**） |
| 未引入部分 | 上游的 `scripts/`（14 个脚本）与 `references/` 知识库分册**刻意未打包**（体积大，且念语不执行技能脚本） |

**念语的处理方式**：仅将上游 `SKILL.md` 作为内置技能的提示词种子使用；
**不主张该内容的原始著作权**，版权归原作者 `powerycy` 所有。
上游 LICENSE 全文可在 `使用说明.md` 第 24 章查阅。

标注位置（4 处冗余）：`electron/builtinSkills.ts` 源码注释 · `使用说明.md` ·
软件内 `GuideView.tsx` 使用指南 · `src/i18n/translations.ts` 中英双语。

---

## 三、开源软件依赖

全部依赖均为宽松许可，**无 GPL / AGPL / LGPL / MPL 等强/弱著佐权依赖**，
故本项目以 MIT 协议开源不受传染。完整清单见 [`NOTICE`](./NOTICE) 文件。

---

## 四、格式兼容（非代码引入）

项目实现了若干**第三方数据格式的解析器**，用于兼容生态内已有内容。
这是「格式兼容」，**不是代码引入**，不构成著作权风险：

| 格式 | 用途 | 解析位置 |
|---|---|---|
| SillyTavern V2/V3角色卡（PNG `tEXt` chunk 中的 `chara`） | 导入角色卡 | `electron/main.ts` `extractPngCharaChunk` / `parseCharacterPng`；`src/utils/characterCard.ts` |
| SillyTavern / NovelAI 世界书 | 导入世界书 | `electron/main.ts` `extractLoreEntries` / `parseWorldBook` |
| OpenAI `ai-plugin.json` | 导入插件 | `electron/main.ts` `importPluginLogic` |

上述解析器均为独立实现，未复制任何来源项目的代码。

---

## 五、核心算法原创性

以下模块为原创实现（文件头有设计约束说明，无外部引用）：

| 模块 | 说明 |
|---|---|
| `src/utils/fuzzySearch.ts` | 模糊搜索分档打分（8 档）|
| `src/utils/statsChart.ts` | WCAG 对比度计算、SVG 圆环扇区几何 |
| `src/utils/animControl.ts` | 动画门禁 CSS 生成 |
| `src/utils/inactiveChats.ts` | 不常用聊天判定 |
| `scripts/gen-builtin-sounds.mjs` | 内置音效程序合成 |

---

**本项目采用 MIT License 开源，版权归「前方」所有。**
第三方素材与依赖的完整清单见上；如有疑问请提交 issue。
