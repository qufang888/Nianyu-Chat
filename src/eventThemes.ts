// 随机事件快捷主题（全部由默认 AI 生成）。集中定义，主窗与小窗共用，避免两处漂移。
export const EVENT_THEMES: { key: string; i18n: string }[] = [
  { key: 'random', i18n: 'chat.eventThemeRandom' },
  { key: 'gift', i18n: 'chat.eventThemeGift' },
  { key: 'date', i18n: 'chat.eventThemeDate' },
  { key: 'daily', i18n: 'chat.eventThemeDaily' },
  { key: 'surprise', i18n: 'chat.eventThemeSurprise' },
  { key: 'quarrel', i18n: 'chat.eventThemeQuarrel' },
];

// 自动触发参数（主窗/小窗共用，避免数值漂移）
export const EVENT_COOLDOWN_MS = 25000; // 自动触发冷却，避免刷屏
export const EVENT_TRIGGER_THRESHOLD = 0.55; // Math.random() > 该值则本轮不触发（即约 45% 概率跳过）

