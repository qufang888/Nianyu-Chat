// 角色卡解析：兼容本软件自有格式与第三方（SillyTavern V2 / V3 等）常见字段。
// 解析结果为与本软件 Role 字段对齐的 Partial 对象，便于直接合并进角色编辑器。

export type ParsedCharacter = Partial<{
  name: string;
  gender: string;
  age: number | null;
  occupation: string;
  short_intro: string;
  personality: string;
  background: string;
  appearance: string;
  world_setting: string;
  key_memories: string;
  rules: string;
  example_dialogue: string;
  first_message: string;
  // SillyTavern 角色卡内嵌头像（base64，可能带或不带 data: 前缀）
  avatar?: string;
}>;

// 角色卡导入（character:importCard IPC）的返回结构
export interface ImportCharacterResult {
  parsed: ParsedCharacter;
  avatarPath?: string;
  fileName: string;
  isPng?: boolean;
  error?: string;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 解析一个已反序列化的对象（可能是 { data: {...} } 包裹结构）
export function parseCharacterCard(raw: any): ParsedCharacter {
  // SillyTavern 导出的角色卡常包裹在 { data: {...} } 中
  const d =
    raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object'
      ? raw.data
      : raw && typeof raw === 'object'
        ? raw
        : {};

  const name = d.name || d.char_name || d.character_name || d.title || '';
  const gender = d.gender || (typeof d.sex === 'string' ? d.sex : '') || '';
  const age = toNum(d.age ?? d.char_age);
  const occupation = d.occupation || d.job || d.profession || '';
  const short_intro =
    d.short_intro || d.description || d.tagline || (typeof d.char_persona === 'string' ? d.char_persona.slice(0, 200) : '') || '';
  const personality = d.personality || d.char_persona || d.personality_traits || '';
  const background = d.background || d.backstory || d.history || d.lore || '';
  const appearance = d.appearance || d.looks || d.visual || '';
  const world_setting =
    d.world_setting || d.scenario || d.world || d.world_scenario || '';
  const key_memories = d.key_memories || d.memory || '';
  const rules = d.rules || d.system_prompt || d.behavior || '';
  const example_dialogue =
    d.example_dialogue || d.mes_example || d.example_dialog || '';
  const first_message = d.first_message || d.first_mes || d.greeting || '';
  const avatar = typeof d.avatar === 'string' && d.avatar ? d.avatar : '';

  return {
    name,
    gender,
    age,
    occupation,
    short_intro,
    personality,
    background,
    appearance,
    world_setting,
    key_memories,
    rules,
    example_dialogue,
    first_message,
    avatar: avatar || undefined,
  };
}

// 从文本解析：先尝试 JSON.parse，失败则从 ```json 代码块 或首个 { ... } 中提取
export function parseCharacterCardText(text: string): ParsedCharacter {
  if (!text || !text.trim()) return {};
  let raw: any = null;
  try {
    raw = JSON.parse(text);
  } catch {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) {
      try {
        raw = JSON.parse(fence[1]);
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      const blob = text.match(/\{[\s\S]*\}/);
      if (blob) {
        try {
          raw = JSON.parse(blob[0]);
        } catch {
          raw = null;
        }
      }
    }
  }
  if (!raw || typeof raw !== 'object') return {};
  return parseCharacterCard(raw);
}
