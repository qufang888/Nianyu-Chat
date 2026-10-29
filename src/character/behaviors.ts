// 桌面角色的自主行为数据（V3）。
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
  { id: 'happy', expression: 'happy', weight: 3, text: '嘿嘿。', holdMs: 2200 },
  { id: 'shy', expression: 'shy', weight: 2, text: '别一直盯着我啦。', holdMs: 2600 },
  { id: 'surprised', expression: 'surprised', weight: 1, text: '诶？', holdMs: 1600 },
  { id: 'thinking', expression: 'thinking', weight: 2, text: '我在想一件事。', holdMs: 2800 },
  { id: 'wave', expression: 'wave', weight: 2, holdMs: 2000 },
  { id: 'nod', expression: 'nod', weight: 2, holdMs: 1400 },
  { id: 'shake', expression: 'shake', weight: 1, holdMs: 1400 },
  { id: 'yawn', expression: 'yawn', weight: 1, text: '哈啊——有点困。', holdMs: 2400 },
  { id: 'angry', expression: 'angry', weight: 1, text: '哼。', holdMs: 1800 },
  { id: 'greet', expression: 'greet', weight: 1, text: '你来啦。', holdMs: 2200 },
];

/** 本地主动开口的原创短句（不依赖联网社区/在线内容）。 */
export const IDLE_TEXTS: string[] = [
  '我在这儿。',
  '今天也一起待着吧。',
  '你忙你的，我不吵你。',
  '刚刚走神了一下。',
  '要不要休息一会儿？',
  '窗外好像有风。',
  '我一直都在。',
  '有点想说话了。',
  '伸个懒腰。',
  '你回来啦。',
  '喝口水吧。',
  '时间过得真快。',
];

/** 点击反馈文案（原创）。 */
export const CLICK_TEXTS: string[] = ['嗯？', '我在。', '怎么啦？', '摸摸头。', '有事找我？'];

/** 被拖拽时的原创文案（不引用任何第三方语音/音效素材）。 */
export const DRAG_TEXTS: string[] = ['哇——', '轻一点啦。', '要带我去哪儿？', '晕乎乎的。'];

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
