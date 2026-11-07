// 桌面角色的自主行为数据（V3）。
//
// v3.0.1-beta.9：桌宠互动语句改为「绑定对话后由 AI 模型按该对话人物人设生成」，
//   固定句子池（IDLE_TEXTS / CLICK_TEXTS / DRAG_TEXTS / IDLE_ACTIONS.text / pickText）
//   全部移除。本文件现在只保留「非语言」的自主行为数据：表情类别 / 权重 / 持续时间。
//   角色依然会呼吸、眨眼、待机动作、游走，但**不再有任何本地文案气泡**：
//   · 未绑定对话 → 完全不生成语句，也不显示任何文案气泡（只保留表情 / 动作）；
//   · 绑定对话后 → 由 CharacterApp 走 api.proactive 生成，原句同时写入绑定对话。
//   模型未配置 / 调用失败 / 离线时静默降级，绝不使用固定文案兜底冒充模型输出。
//
// 合规：动作只描述「情绪类别」这一通用行为语义，不对应任何第三方角色的具体动画序列。
import type { CharacterExpression } from './PlaceholderCharacter';

export interface IdleAction {
  id: string;
  expression: CharacterExpression;
  /** 相对权重（按权重抽取） */
  weight: number;
  /** 持续时间（毫秒） */
  holdMs: number;
}

/** 随机待机动作池：覆盖通用情绪类别，按权重抽取（仅表情 / 动作，不含任何文案）。 */
export const IDLE_ACTIONS: IdleAction[] = [
  { id: 'happy', expression: 'happy', weight: 3, holdMs: 2200 },
  { id: 'shy', expression: 'shy', weight: 2, holdMs: 2600 },
  { id: 'surprised', expression: 'surprised', weight: 1, holdMs: 1600 },
  { id: 'thinking', expression: 'thinking', weight: 2, holdMs: 2800 },
  { id: 'wave', expression: 'wave', weight: 2, holdMs: 2000 },
  { id: 'nod', expression: 'nod', weight: 2, holdMs: 1400 },
  { id: 'shake', expression: 'shake', weight: 1, holdMs: 1400 },
  { id: 'yawn', expression: 'yawn', weight: 1, holdMs: 2400 },
  { id: 'angry', expression: 'angry', weight: 1, holdMs: 1800 },
  { id: 'greet', expression: 'greet', weight: 1, holdMs: 2200 },
];

/** 按权重抽取一个待机动作。 */
export function pickIdleAction(): IdleAction {
  const total = IDLE_ACTIONS.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of IDLE_ACTIONS) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return IDLE_ACTIONS[0];
}
