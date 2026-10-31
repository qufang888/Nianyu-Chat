// 导出工具：把念语数据转换为其它酒馆类软件（SillyTavern 等）兼容的格式。
//
// 设计原则：
// - 角色卡 → SillyTavern V3 角色卡 JSON（{ data: {...} } 包裹；酒馆导入端已支持）。
//   （因项目无 PNG 编码库，头像按需由调用方以 dataURL 传入，否则写 'none'。）
// - 世界书 → SillyTavern Lorebook（world.json）结构（含 entries 数组）。
// - 规则库 → SillyTavern Regex Scripts（regexes.json）数组：每条规则一个脚本条目，
//   findRegex（script）留空、名称/内容写入 replaceString，**不会自动生效**，仅作内容迁移/存档。
// - 记忆 → JSON 数组（念语自有结构，便于在其它工具里归档/检索）。
// - 聊天记录 → SillyTavern 现代对话数组（name/role/content/image_url/timestamp/extra）。
//
// 所有函数均为纯函数（仅做字段映射 + JSON 序列化），不触碰 IPC / DOM，便于单测与校验脚本断言。

import type { Role, WorldBook, Rule, MemoryEntry, ChatMessage } from '../types';

/** 序列化为带 2 空格缩进的 JSON 文本（可读、可 diff）。 */
function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

// ===================== 角色卡（SillyTavern V3）=====================

export function buildCharacterCard(role: Role, opts?: { avatarDataUrl?: string | null }): string {
  const avatar = opts?.avatarDataUrl && opts.avatarDataUrl.startsWith('data:') ? opts.avatarDataUrl : 'none';
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: role.name || '',
      description: role.background || '',
      personality: role.personality || '',
      scenario: role.world_setting || '',
      first_mes: role.first_message || '',
      mes_example: role.example_dialogue || '',
      creatorcomment: role.short_intro || '',
      tags: [] as string[],
      creator: '念语 Nianyu',
      character_version: '',
      avatar,
      extensions: {
        nianyu: {
          gender: role.gender || '',
          age: role.age ?? null,
          occupation: role.occupation || '',
          appearance: role.appearance || '',
          key_memories: role.key_memories || '',
          rules: role.rules || '',
          affinity: role.affinity ?? 0,
          worldBookId: role.worldBookId || '',
          ruleIds: role.ruleIds || [],
          memoryIsolation: role.memoryIsolation ?? true,
          mood: role.mood || '',
        },
      },
      group_only_greetings: [] as string[],
      alternate_greetings: [] as string[],
      yaml_data: null,
      post_history_instructions: '',
      system_prompt: '',
      narrator: false,
      persona_override: null,
    },
  };
  return pretty(card);
}

// ===================== 世界书（SillyTavern Lorebook）=====================

export function buildWorldBook(wb: WorldBook): string {
  // 念语世界书有「整段文本 content」+「条目化 entries」两层。
  // 酒馆 Lorebook 以 entries 为主，因此：
  //  - 结构化条目原样映射为 lorebook entries（带常量/关键词）；
  //  - 整段文本 content 额外生成一个常驻条目，保证在酒馆里也能看到；
  //  - 同时把 content 原值存进 extensions.nianyu，便于回灌念语。
  const entries: any[] = (wb.entries || []).map((e, i) => ({
    id: i + 1,
    key: e.key || '',
    keysecondary: '',
    comment: e.key || '',
    content: e.content || '',
    constant: !!e.constant,
    vectorized: false,
    selective: false,
    selectiveLogic: 0,
    addMemo: true,
    order: i + 1,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: 5,
    caseSensitive: false,
    matchWordBoundary: false,
    useGroupScoring: false,
    automationId: '',
    role: 0,
    uid: i + 1,
  }));

  if (wb.content && wb.content.trim()) {
    entries.unshift({
      id: 0,
      key: '',
      keysecondary: '',
      comment: '念语·整段世界观文本',
      content: wb.content,
      constant: true,
      vectorized: false,
      selective: false,
      selectiveLogic: 0,
      addMemo: true,
      order: 0,
      position: 0,
      disable: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      probability: 100,
      useProbability: true,
      depth: 4,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: 5,
      caseSensitive: false,
      matchWordBoundary: false,
      useGroupScoring: false,
      automationId: '',
      role: 0,
      uid: 0,
    });
  }

  const lorebook = {
    name: wb.name || '',
    description: wb.description || '',
    scanDepth: 5,
    tokenBudget: 2048,
    recursiveScan: true,
    extensions: {
      nianyu: {
        content: wb.content || '',
      },
    },
    entries,
  };
  return pretty(lorebook);
}

// ===================== 规则库（SillyTavern Regex Scripts）=====================
//
// 用户确认映射：每条规则 → 一个脚本条目，名称/内容写入，findRegex（script）留空。
// 该映射在酒馆里**不会自动生效**（空 find 永不匹配），仅作内容迁移 / 存档。

export function buildRegexScripts(rules: Rule[]): string {
  const scripts = (rules || []).map((r, i) => ({
    id: i + 1,
    name: r.name || '',
    script: '',
    replaceString: r.content || '',
    trimStrings: [] as string[],
    placement: [0, 1, 2, 3, 4],
    disabled: false,
    minDepth: 0,
    maxDepth: null,
    extensions: {
      nianyu: {
        scope: r.scope || 'shared',
        source: r.source || 'manual',
        created_at: r.created_at || '',
        updated_at: r.updated_at || '',
      },
    },
  }));
  return pretty(scripts);
}

// ===================== 记忆（JSON 数组）=====================

export function buildMemories(memories: MemoryEntry[]): string {
  const arr = (memories || []).map((m) => ({
    roleId: m.roleId,
    chatId: m.chatId || null,
    content: m.content || '',
    source: m.source || 'manual',
    sourceMsgId: m.sourceMsgId ?? null,
    image_path: m.image_path || null,
    created_at: m.created_at || '',
    updated_at: m.updated_at || '',
  }));
  return pretty(arr);
}

// ===================== 聊天记录（SillyTavern 现代对话数组）=====================

export function buildChatExport(messages: ChatMessage[], opts?: { selfName?: string }): string {
  const selfName = opts?.selfName || '用户';
  const arr = (messages || []).map((m) => {
    let role: 'user' | 'assistant' | 'system';
    let name: string;
    if (m.sender_type === 'user') {
      role = 'user';
      name = m.sender_name || selfName;
    } else if (m.sender_type === 'system') {
      role = 'system';
      name = m.sender_name || 'system';
    } else {
      role = 'assistant';
      name = m.sender_name || 'assistant';
    }
    const image_url =
      m.images && m.images.length
        ? m.images
        : m.image_path
          ? [m.image_path]
          : [];
    const ts = m.timestamp ? Date.parse(m.timestamp) : Date.now();
    return {
      name,
      role,
      content: m.content || '',
      image_url,
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
      reasoning: m.reasoning || '',
      extra: {
        nianyu: {
          id: m.id,
          chat_type: m.chat_type,
          chat_id: m.chat_id,
          msg_kind: m.msg_kind || 'public',
          status: m.status || 'normal',
          from_proactive: !!m.from_proactive,
          from_auto: !!m.from_auto,
          interrupted: !!m.interrupted,
          search_results: m.search_results || [],
        },
      },
    };
  });
  return pretty(arr);
}
