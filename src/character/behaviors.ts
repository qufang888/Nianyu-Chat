// 桌面角色的自主行为数据（V3）。
//
// v3.0.1-beta.4：本文件只存 **i18n 键**（不含中文原文）——
//   角色气泡是用户可见文案，须随界面语言切换，故由 CharacterApp 用 translate() 解析。
//   （IDLE_ACTIONS.text / IDLE_TEXTS / CLICK_TEXTS / DRAG_TEXTS 全部为键名）
//
// 合规：以下气泡文案均为念语原创，不含任何第三方桌面陪伴产品的提示语/品牌名；
// 动作只描述「情绪类别」这一通用行为语义，不对应任何第三方角色的具体动画序列。
import type { CharacterExpression } from './PlaceholderCharacter';

export interface IdleAction {
  id: string;
  expression: CharacterExpression;
  /** 相对权重（按权重抽取） */
  weight: number;
  /** 触发时可能附带的原创气泡（可空） */
  text?: string;
  /** 持续时间（毫秒） */
  holdMs: number;
}

/** 随机待机动作池：覆盖通用情绪类别，按权重抽取。 */
export const IDLE_ACTIONS: IdleAction[] = [
  { id: 'happy', expression: 'happy', weight: 3, text: 'character.bubble.happy', holdMs: 2200 },
  { id: 'shy', expression: 'shy', weight: 2, text: 'character.bubble.shy', holdMs: 2600 },
  { id: 'surprised', expression: 'surprised', weight: 1, text: 'character.bubble.surprised', holdMs: 1600 },
  { id: 'thinking', expression: 'thinking', weight: 2, text: 'character.bubble.thinking', holdMs: 2800 },
  { id: 'wave', expression: 'wave', weight: 2, holdMs: 2000 },
  { id: 'nod', expression: 'nod', weight: 2, holdMs: 1400 },
  { id: 'shake', expression: 'shake', weight: 1, holdMs: 1400 },
  { id: 'yawn', expression: 'yawn', weight: 1, text: 'character.bubble.yawn', holdMs: 2400 },
  { id: 'angry', expression: 'angry', weight: 1, text: 'character.bubble.angry', holdMs: 1800 },
  { id: 'greet', expression: 'greet', weight: 1, text: 'character.bubble.greet', holdMs: 2200 },
];

/** 本地主动开口的原创短句（不依赖联网社区/在线内容）。 */
export const IDLE_TEXTS: string[] = [
  'character.idle.1',
  'character.idle.2',
  'character.idle.3',
  'character.idle.4',
  'character.idle.5',
  'character.idle.6',
  'character.idle.7',
  'character.idle.8',
  'character.idle.9',
  'character.idle.10',
  'character.idle.11',
  'character.idle.12',
];

/** 点击反馈文案（原创）。 */
export const CLICK_TEXTS: string[] = [
  'character.click.1',
  'character.click.2',
  'character.click.3',
  'character.click.4',
  'character.click.5',
];

/** 被拖拽时的原创文案（不引用任何第三方语音/音效素材）。 */
export const DRAG_TEXTS: string[] = [
  'character.drag.1',
  'character.drag.2',
  'character.drag.3',
  'character.drag.4',
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

/** 从数组里随机取一条。 */
export function pickText(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}
