/**
 * 日记留言语气分类（纯模块，零 IO / 零 electron import）。
 *
 * 规则（PRD §4.4，设计 §4.1）：
 *   affinity >= 60 且 mood ∈ POS_MOODS           → warm      共情温暖
 *   mood ∈ NEG_MOODS（低好感可合法 skip）        → snarky     带刺但不失人设
 *   affinity < 40 且非平静 / 非正情绪            → snarky
 *   其余                                        → neutral    角色日常口吻
 *
 * 低好感 + 负面情绪时「本次不留言」是合法结果，UI 显示「本次未留言」。
 */
import type { DiaryTone } from '../src/types';

export const DIARY_POS_MOODS: readonly string[] = ['开心', '撒娇', '心动'];
export const DIARY_NEG_MOODS: readonly string[] = ['生气', '低落', '难过'];

/** 按好感度与心情决定语气；不访问任何外部状态，便于 QA 直接执行。 */
export function classifyDiaryCommentTone(affinity: number, mood: string): DiaryTone {
  const a = Number.isFinite(affinity) ? affinity : 50;
  const m = String(mood || '平静');
  if (a >= 60 && DIARY_POS_MOODS.includes(m)) return 'warm';
  if (DIARY_NEG_MOODS.includes(m)) {
    // 很低好感 + 负面情绪：允许本次不留言（合法 skip，不算 bug）
    return a < 30 ? 'skip' : 'snarky';
  }
  if (a < 40 && m !== '平静' && !DIARY_POS_MOODS.includes(m)) return 'snarky';
  return 'neutral';
}

/**
 * 在 buildSystemPrompt(role) 之上追加的留言后缀。
 * 刻意不出现「AI / 语言模型 / 系统指令」等出戏词；只要求以角色身份输出留言正文。
 */
export function buildDiaryCommentSuffix(tone: DiaryTone): string {
  const base = '请给主人的日记写一条留言，只输出留言正文，以该角色身份严格遵守以上人设与当前心情/好感度；不要提及任何角色世界之外的事物。';
  if (tone === 'warm') return `${base} 语气温暖共情，贴合此刻的亲近与心动。`;
  if (tone === 'snarky') return `${base} 语气可带刺、略显阴阳怪气，但仍不失人设；若确无话可说可只输出空行。`;
  if (tone === 'skip') return `${base} 若此刻确无话可说，只输出空行即可。`;
  return `${base} 保持日常口吻，自然贴合角色。`;
}
