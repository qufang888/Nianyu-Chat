// 技能（Skill）层 —— 导入 SKILL.md 形态的技能包，按作用域注入系统提示词（v2.3.92 新增）
// ============================================================================
// 设计要点：
//   1. **纯指令注入，不执行任何脚本**：技能正文只进系统提示词。frontmatter 里若声明
//      scripts/exec/command 等可执行字段，解析时**忽略并显式记录**（scriptBlocked），
//      由 UI 标注「本版本不支持脚本执行」，绝不静默忽略。
//   2. **独立文件 skills.json**（userData 目录，参考 proactive-nhpp.json 范式）：
//      刻意不塞进 store.json —— 那是聊天主数据（消息/角色/记忆），技能属于「可随时
//      整体删除」的外挂资产，混入主数据一旦解析异常会污染聊天，故物理隔离 + 独立
//      load/save + 500ms 防抖。
//   3. **注入顺序护人设**：技能段必须排在角色/世界书设定**之后**、群聊规则**之前**
//      （见 electron/main.ts 的 buildMessagesForRole / buildGroupMessages），
//      避免技能文本以「更靠后的指令」姿态覆盖角色人设。
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { Skill, SkillScope, SkillImportResult } from '../src/types';

// ===== 硬编码常量（同步登记 硬编码清单.md）=====
export const SKILL_BODY_MAX = 20_000; // 技能正文最大字符数，超出截断并在 UI 标注
const STORE_FILE = 'skills.json';
const SAVE_DEBOUNCE_MS = 500; // 落盘防抖：连续导入/启停只写一次
const NAME_MAX = 80; // 技能名最大长度（进提示词 attribute，防超长污染）
const DESC_MAX = 400; // description 最大长度（AI 判断触发场景的依据）
/** 解析时遇到即「忽略 + 显式标注」的 frontmatter 字段（本版本不执行任何脚本） */
export const SKILL_SCRIPT_FIELDS = [
  'scripts',
  'script',
  'exec',
  'execute',
  'command',
  'commands',
  'cmd',
  'run',
  'entry',
  'entrypoint',
  'hook',
  'hooks',
  'bin',
] as const;
const SCOPES: SkillScope[] = ['global', 'role', 'chat'];

// ===== 存储（独立文件，与 store.json 物理隔离）=====
interface SkillStore {
  version: number;
  skills: Skill[];
}
const STORE_VERSION = 1;
let store: SkillStore = { version: STORE_VERSION, skills: [] };
let storePath = '';
let loaded = false;

function storeFile(): string {
  if (!storePath) storePath = path.join(app.getPath('userData'), STORE_FILE);
  return storePath;
}

/** 从磁盘载入 skills.json（幂等；损坏文件退化为空表，绝不抛出到调用方） */
export function loadSkills(): void {
  try {
    const p = storeFile();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<SkillStore>;
      store = {
        version: typeof raw.version === 'number' ? raw.version : STORE_VERSION,
        skills: Array.isArray(raw.skills) ? raw.skills.filter(isValidSkill) : [],
      };
    } else {
      store = { version: STORE_VERSION, skills: [] };
    }
  } catch {
    store = { version: STORE_VERSION, skills: [] };
  }
  loaded = true;
}

function ensureLoaded(): void {
  if (!loaded) loadSkills();
}

let saveTimer: NodeJS.Timeout | null = null;
/** 防抖落盘（对齐 proactive-nhpp.json 的 500ms 范式） */
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSkills();
  }, SAVE_DEBOUNCE_MS);
  // Node 侧不因该定时器阻止退出（与 proactive.ts 一致的兜底）
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** 立即同步落盘（防抖窗口内需要读盘一致性时由调用方显式调用） */
export function flushSkills(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    /* 落盘失败不打断聊天链路 */
  }
}

/** 读取落盘文件原文（供自测/诊断；不提供任意路径入参） */
function readStoreFileText(): string {
  try {
    const p = storeFile();
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

// ===== 运行时结构校验（读档与写入共用）=====
function isValidSkill(s: unknown): s is Skill {
  if (!s || typeof s !== 'object') return false;
  const o = s as Partial<Skill>;
  return (
    typeof o.id === 'string' &&
    !!o.id &&
    typeof o.name === 'string' &&
    !!o.name.trim() &&
    typeof o.description === 'string' &&
    typeof o.body === 'string' &&
    !!o.body.trim() &&
    SCOPES.includes(o.scope as SkillScope)
  );
}

// ===== frontmatter 解析（YAML 子集，够用且无依赖）=====
interface ParsedFrontmatter {
  fields: Record<string, string>;
  scriptFields: string[];
}

/**
 * 解析 SKILL.md 的 frontmatter。
 * 仅支持 `key: value` 与 `key:` + `- item` 列表两种形态（技能包实际用到的子集）；
 * 其余 YAML 特性（锚点、多文档、嵌套对象）不支持，也不做静默猜测。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const fields: Record<string, string> = {};
  const scriptFields: string[] = [];
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { fields, scriptFields };
  let currentKey = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const prev = fields[currentKey];
      fields[currentKey] = prev ? `${prev}\n${listItem[1].trim()}` : listItem[1].trim();
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    currentKey = kv[1].toLowerCase();
    fields[currentKey] = kv[2].trim();
  }
  // 可执行字段：记录并忽略（不执行、不静默）
  for (const key of Object.keys(fields)) {
    if ((SKILL_SCRIPT_FIELDS as readonly string[]).includes(key)) scriptFields.push(key);
  }
  return { fields, scriptFields };
}

/** 去掉可能成对包裹的引号 */
function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function clampText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 剥掉 frontmatter，返回正文 */
function extractBody(raw: string): { body: string; hasFrontmatter: boolean } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { body: text.trim(), hasFrontmatter: false };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { body: lines.slice(i + 1).join('\n').trim(), hasFrontmatter: true };
    }
  }
  return { body: text.trim(), hasFrontmatter: false };
}

// ===== 对外：解析 + 校验（不落库）=====
/**
 * 解析一段 SKILL.md 文本为技能记录（尚未分配 id/时间戳）。
 * 失败时返回 error（i18n 键后缀：skill.err*），成功时返回 warnings（脚本字段/截断提示）。
 */
export function parseSkillMarkdown(
  raw: string,
  meta: { fileName?: string; enabled?: boolean } = {}
): Omit<Skill, 'id' | 'importedAt'> & { warnings: string[] } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'errEmptyBody' };
  if (raw.length > SKILL_BODY_MAX * 3) return { error: 'errTooLarge' };

  const { fields, scriptFields } = parseFrontmatter(raw);
  const { body, hasFrontmatter } = extractBody(raw);
  const warnings: string[] = [];

  if (!hasFrontmatter) return { error: 'errNoFrontmatter' };
  if (scriptFields.length) warnings.push('script');

  const name = clampText(unquote(fields.name || ''), NAME_MAX);
  if (!name) return { error: 'errNoName' };
  const description = clampText(unquote(fields.description || ''), DESC_MAX);
  if (!description) return { error: 'errNoDescription' };

  const rawScope = (fields.scope || 'global').toLowerCase();
  if (!SCOPES.includes(rawScope as SkillScope)) return { error: 'errBadScope' };
  const scope = rawScope as SkillScope;

  const roleId = unquote(fields.roleid || fields['role-id'] || '').trim();
  const chatKey = unquote(fields.chatkey || fields['chat-key'] || '').trim();
  if (scope === 'role' && !roleId) return { error: 'errNoRoleId' };
  if (scope === 'chat' && !chatKey) return { error: 'errNoChatKey' };

  const content = body.trim();
  if (!content) return { error: 'errEmptyBody' };
  let finalBody = content;
  let truncated = false;
  if (finalBody.length > SKILL_BODY_MAX) {
    finalBody = finalBody.slice(0, SKILL_BODY_MAX);
    truncated = true;
    warnings.push('truncated');
  }

  const version = unquote(fields.version || '').trim();
  return {
    name,
    description,
    scope,
    roleId: scope === 'role' ? roleId : undefined,
    chatKey: scope === 'chat' ? chatKey : undefined,
    version: version || undefined,
    body: finalBody,
    sourceFile: meta.fileName || undefined,
    enabled: meta.enabled !== false,
    truncated,
    scriptBlocked: scriptFields.length > 0,
    scriptFields: scriptFields.length ? scriptFields.join(', ') : undefined,
    warnings,
  };
}

/** 生成技能 id（与既有实体 id 风格一致，避免与角色/世界书 id 撞车） */
function newSkillId(): string {
  return `skill_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 同名 + 同作用域 + 同绑定目标 视为同一技能（重复导入覆盖，不产生重复项） */
function identityOf(s: Pick<Skill, 'name' | 'scope' | 'roleId' | 'chatKey'>): string {
  return `${s.scope}::${s.name.trim().toLowerCase()}::${s.roleId || ''}::${s.chatKey || ''}`;
}

// ===== 对外：CRUD =====
/** 列出全部技能（按导入时间倒序，新导入在前） */
export function listSkills(): Skill[] {
  ensureLoaded();
  return [...store.skills].sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
}

export function getSkill(id: string): Skill | undefined {
  ensureLoaded();
  return store.skills.find((s) => s.id === id);
}

/** 写入（新增或按 identity 覆盖），返回落库后的技能 */
export function saveSkill(skill: Omit<Skill, 'id' | 'importedAt'>): Skill {
  ensureLoaded();
  const now = new Date().toISOString();
  const ident = identityOf(skill);
  const idx = store.skills.findIndex((s) => identityOf(s) === ident);
  if (idx >= 0) {
    const merged: Skill = {
      ...store.skills[idx],
      ...skill,
      id: store.skills[idx].id,
      importedAt: store.skills[idx].importedAt || now,
    };
    store.skills[idx] = merged;
    scheduleSave();
    return merged;
  }
  const created: Skill = { ...skill, id: newSkillId(), importedAt: now };
  store.skills.push(created);
  scheduleSave();
  return created;
}

/** 解析文本并落库（渲染进程拿到的是对话框选中的文件内容，不接受任意路径） */
export function importSkill(raw: string, fileName: string): SkillImportResult {
  ensureLoaded();
  const parsed = parseSkillMarkdown(raw, { fileName });
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { warnings, ...rest } = parsed;
  const skill = saveSkill(rest);
  return { ok: true, skill, warnings };
}

export function deleteSkill(id: string): boolean {
  ensureLoaded();
  const before = store.skills.length;
  store.skills = store.skills.filter((s) => s.id !== id);
  if (store.skills.length === before) return false;
  scheduleSave();
  return true;
}

export function setSkillEnabled(id: string, enabled: boolean): boolean {
  ensureLoaded();
  const s = store.skills.find((x) => x.id === id);
  if (!s) return false;
  s.enabled = !!enabled;
  scheduleSave();
  return true;
}

// ===== 作用域解析（纯函数，可独立断言）=====
/** 作用域优先级：越具体越靠前、越优先（同名冲突时覆盖 global） */
const SCOPE_PRIORITY: Record<SkillScope, number> = { chat: 3, role: 2, global: 1 };

/**
 * 解析某场对话实际生效的技能：
 *   scope=global → 恒生效
 *   scope=role   → roleId 匹配（单聊传 resolveSingleRoleId 后的角色 id；群聊传正在发言的角色 id）
 *   scope=chat   → chatKey 精确匹配 `${chatType}:${chatId}`
 * 同名冲突：跨 scope 取更具体者（chat > role > global）；同 scope 内后导入者覆盖前者。
 * 返回按「作用域优先级降序 + 名称」稳定排序，保证注入顺序可预期。
 */
export function resolveSkillsForChat(
  all: Skill[],
  chatType: string,
  chatId: string,
  roleId = ''
): Skill[] {
  const wantKey = `${chatType}:${chatId}`;
  const matched = all.filter((s) => {
    if (!s.enabled) return false;
    if (s.scope === 'global') return true;
    if (s.scope === 'role') return !!roleId && s.roleId === roleId;
    return s.chatKey === wantKey;
  });
  // 覆盖：同 identity 已被 saveSkill 合并，这里再按「优先级 → 导入时间」去重，双保险
  const winner = new Map<string, Skill>();
  for (const s of matched) {
    const key = s.name.trim().toLowerCase();
    const cur = winner.get(key);
    if (!cur) {
      winner.set(key, s);
      continue;
    }
    const pNew = SCOPE_PRIORITY[s.scope] ?? 0;
    const pCur = SCOPE_PRIORITY[cur.scope] ?? 0;
    if (pNew > pCur || (pNew === pCur && (s.importedAt || '') > (cur.importedAt || ''))) {
      winner.set(key, s);
    }
  }
  return [...winner.values()].sort((a, b) => {
    const d = (SCOPE_PRIORITY[b.scope] ?? 0) - (SCOPE_PRIORITY[a.scope] ?? 0);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}

/** DataManager 门面：某场对话生效的技能 */
export function getSkillsForChat(chatType: string, chatId: string, roleId = ''): Skill[] {
  ensureLoaded();
  return resolveSkillsForChat(store.skills, chatType, chatId, roleId);
}

// ===== 提示词注入 =====
/** 转义会破坏 <skill .../> 标签结构的正文片段。
 *  开标签与闭标签都要转义：只转义 `</skill>` 时，正文里伪造的 `<skill name="假技能">`
 *  能让模型误以为存在第二个技能（v2.3.92 独立复核发现）。 */
function escapeBody(body: string): string {
  return body.replace(/<skill/gi, '<\\skill').replace(/<\/skill>/gi, '<\\/skill>');
}

function escapeAttr(v: string): string {
  return v.replace(/["<>\n\r]/g, ' ').trim();
}

/**
 * 构造注入给 AI 的「可用技能」段。
 * 空列表返回空串 —— 调用方据此**整段跳过**，省 token 且避免 AI 误以为存在技能。
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const lines: string[] = [
    '【可用技能】',
    '以下是用户为本对话启用的技能。当对话情境符合某个技能的 description 时，按该技能的正文执行；不相关时不要提及。',
  ];
  for (const s of skills) {
    lines.push(
      `<skill name="${escapeAttr(s.name)}" description="${escapeAttr(s.description)}">\n${escapeBody(s.body)}\n</skill>`
    );
  }
  return lines.join('\n');
}

// ===== 供自测脚本使用的只读快照（生产代码无副作用）=====
export function skillsStoreFileText(): string {
  ensureLoaded();
  return readStoreFileText();
}