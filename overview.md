# 念语 v2.3.14 功能交付总结

> 6 项需求已全部实现并通过 `npm run build`（tsc 主进程 + vite 渲染产物，exit 0）。

## 交付清单

| # | 需求 | 状态 | 关键改动 |
|---|------|------|----------|
| 1 | 联网搜索结果重启保留 | ✅ 已构建 | 代码早已支持，本次重新构建 `dist-electron/main.js` 与 `dist` 渲染产物后生效；新建对话重启即保留 |
| 2 | 开机自动启动（默认开） | ✅ | `electron/main.ts` `applyLaunchOnBoot` + 启动即应用；`src/types.ts` `launchOnBoot`；设置页开关 |
| 3 | 聊天侧边栏缩进 | ✅ | `ChatList` « 收起 / `App.tsx` › 恢复；新增 i18n 与 CSS |
| 4 | 动态光标覆盖悬浮球 | ✅ | `floating-ball.ts` 挂载独立 React 根（`ThemeProvider`+`CustomCursor`）；小窗此前已覆盖 |
| 5 | 模型管理改设置二级页 | ✅ | `Settings.tsx` `sub='models'` 子页；移除左侧导航图标 |
| 6 | 群聊互聊移出模型管理 | ✅ | 迁回「设置 → 常规」`sec-groupchat` |

## 验证

- `npm run build` 通过：`build:main`（tsc -p tsconfig.node.json）与 `build:renderer`（vite，含 floating-ball 入口）均 0 错误。
- Feature 1 渲染链路确认：`ChatWindow.tsx` 重启后读取 `msg.search_results`（气泡 line 2232 / 引用 line 2947），`markdown.tsx` 渲染可点 `[n]` 徽标。

## 已知限制

- Feature 1 仅对**本次编译后新建的对话**生效；旧版本产生的历史消息当时未落库 `search_results`，无法回填。

## 文档同步

- `版本更新记录.md`：新增 v2.3.14 章节，头部 latest 更新为 v2.3.14。
- `使用说明.md`：新增第 23 章「近期新增功能」并补入目录，footer 日期更新为 2026-09-07。
