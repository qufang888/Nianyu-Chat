import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  Role,
  ChatMessage,
  Group,
  AffinityLogEntry,
  AppSettings,
  WorldBook,
  Rule,
  MemoryEntry,
  Plugin,
} from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';

// 纯 JS 存储：数据以 JSON 文件持久化，无需任何原生编译模块。
interface ChatSession {
  chat_type: string;
  chat_id: string;
  last_time: string;
  chat_name?: string; // 聊天卡片自定义名称（重命名），覆盖角色/群名显示，不改动角色/群本身
  role_id?: string; // 复制出的单聊：chat_id 与 roleId 解绑，用此字段指向真实角色
  storyEnabled?: boolean; // 自适应故事线：本聊是否开启剧情节点标记
}

// 剧情节点（自适应故事线）：用户手动标记或由 AI 在故事模式下自动标记
interface StoryNode {
  id: number;
  chat_type: string;
  chat_id: string;
  msg_id: number; // 关联的聊天消息 id（点击节点可跳转）
  title: string; // 节点标题（剧情节点名）
  timestamp: string;
}

// 朋友圈动态（人物养成/社交）：角色对外发布的动态，支持定时发布
interface Moment {
  id: number;
  roleId: string; // 发布者角色 id
  content: string; // 动态正文
  images: string[]; // 配图路径
  videos?: string[]; // 视频路径（AI 生成视频动态；空/未设置=无视频）
  created_at: string; // 创建时间
  scheduledAt?: string | null; // 定时发布时间（ISO）；空/null=立即发布
  published: boolean; // 是否已发布（定时未到点时为 false，到点后转 true）
  selfRoleId?: string; // 查看者/对话使用的「我的角色卡」id；不同自我身份的朋友圈相互独立，空=未指定
  liked?: boolean; // 用户点赞（本地单用户，布尔切换）
  favorited?: boolean; // 用户收藏（收藏板块展示依据）
}

interface Store {
  roles: Role[];
  groups: Group[];
  messages: ChatMessage[];
  affinity: AffinityLogEntry[];
  // ===== 新增可管理实体 =====
  worldBooks: WorldBook[];
  rules: Rule[];
  memories: MemoryEntry[];
  seq: number; // 自增 id 计数器（用于消息与好感度日志）
  chatSessions: ChatSession[]; // 已存在的聊天会话（清空消息后仍保留）
  storyNodes: StoryNode[]; // 自适应故事线的剧情节点
  moments: Moment[]; // 朋友圈动态（人物养成/社交）
  plugins: Plugin[]; // 插件（声明式/受控 HTTP，兼容外部常见格式）
}

// 数据保存路径配置：存放在固定的 userData 下（不随数据目录移动），避免「先读设置才能定位数据目录」的鸡生蛋问题。
const PATH_CONFIG_PATH = path.join(app.getPath('userData'), 'path-config.json');
interface PathConfig {
  dataPath?: string; // 用户自定义的实时数据目录（空 = 使用默认「文档/念语数据」）
  legacyMigrated?: boolean; // 是否已从旧版 userData/data 迁移过
}

function readPathConfig(): PathConfig {
  try {
    if (fs.existsSync(PATH_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PATH_CONFIG_PATH, 'utf-8')) as PathConfig;
    }
  } catch {
    /* 忽略损坏配置 */
  }
  return {};
}
function writePathConfig(cfg: PathConfig): void {
  try {
    fs.writeFileSync(PATH_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {
    /* 忽略写入失败 */
  }
}

// 解析当前实时数据目录：自定义路径优先；否则默认「文档/念语数据」。
function resolveDataDir(): string {
  const cfg = readPathConfig();
  if (cfg.dataPath && cfg.dataPath.trim()) {
    return path.resolve(cfg.dataPath.trim());
  }
  return path.join(app.getPath('documents'), '念语数据');
}

// 默认数据目录（文档/念语数据），供前端展示。
export function defaultDataDirPath(): string {
  return path.join(app.getPath('documents'), '念语数据');
}

// 旧版数据位于 userData/data；首次启动（且仍用默认路径、且旧目录有数据、目标目录为空）时一次性迁移到新目录。
function migrateLegacyData(targetDir: string): void {
  const cfg = readPathConfig();
  if (cfg.legacyMigrated) return;
  const legacy = path.join(app.getPath('userData'), 'data');
  const hasLegacy =
    fs.existsSync(path.join(legacy, 'store.json')) || fs.existsSync(path.join(legacy, 'settings.json'));
  const targetEmpty = !fs.existsSync(path.join(targetDir, 'store.json')) && !fs.existsSync(path.join(targetDir, 'settings.json'));
  if (hasLegacy && targetEmpty) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.cpSync(legacy, targetDir, { recursive: true });
    } catch (e) {
      console.error('迁移旧数据失败', e);
    }
  }
  cfg.legacyMigrated = true;
  writePathConfig(cfg);
}

class DataManager {
  private dataDir: string;
  private storePath: string;
  private settingsPath: string;
  private errorLogPath: string;
  private store: Store;
  private settings: AppSettings;
  private errorSeq = 0;

  constructor() {
    this.dataDir = resolveDataDir();
    migrateLegacyData(this.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'images'), { recursive: true });
    this.storePath = path.join(this.dataDir, 'store.json');
    this.settingsPath = path.join(this.dataDir, 'settings.json');
    this.errorLogPath = path.join(this.dataDir, 'errors.json');
    this.store = this.loadStore();
    this.settings = this.loadSettings();
    this.migrate();
  }

  // 重新从磁盘加载 store 与 settings（恢复备份后调用，使内存态与磁盘一致）
  reloadAll(): void {
    this.store = this.loadStore();
    this.settings = this.loadSettings();
  }

  // ===== 错误日志：持久化到 dataDir/errors.json，按时间倒序，上限 1000 条 =====
  logError(category: 'functional' | 'model' | 'other', message: string, detail?: string): void {
    try {
      let list: import('../src/types').ErrorLogEntry[] = [];
      if (fs.existsSync(this.errorLogPath)) {
        list = JSON.parse(fs.readFileSync(this.errorLogPath, 'utf-8')) as import('../src/types').ErrorLogEntry[];
      }
      this.errorSeq += 1;
      list.push({ id: this.errorSeq, time: new Date().toISOString(), category, message: String(message).slice(0, 2000), detail: detail ? String(detail).slice(0, 8000) : undefined });
      if (list.length > 1000) list = list.slice(-1000);
      fs.writeFileSync(this.errorLogPath, JSON.stringify(list, null, 2), 'utf-8');
    } catch {
      /* 错误日志写入失败不应影响主流程 */
    }
  }
  getErrorLog(): import('../src/types').ErrorLogEntry[] {
    try {
      if (fs.existsSync(this.errorLogPath)) {
        return JSON.parse(fs.readFileSync(this.errorLogPath, 'utf-8')) as import('../src/types').ErrorLogEntry[];
      }
    } catch {
      /* 忽略 */
    }
    return [];
  }
  clearErrorLog(): void {
    try {
      if (fs.existsSync(this.errorLogPath)) fs.rmSync(this.errorLogPath, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  // ===== 数据保存路径 =====
  getCurrentDataPath(): string {
    return this.dataDir;
  }
  getCustomDataPath(): string | null {
    return readPathConfig().dataPath?.trim() || null;
  }
  // 将当前实时数据整体迁移到新目录，并写入 path-config（下次启动生效）。已存在的目标目录会被合并覆盖。
  // 同时将路径写入明文 custom-data-path.txt 供卸载器读取删除。
  setCustomDataPath(dir: string): { ok: boolean; error?: string } {
    const target = path.resolve((dir || '').trim());
    if (!target) return { ok: false, error: '路径不能为空' };
    if (target === this.dataDir) return { ok: false, error: '新路径与当前路径相同' };
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(this.dataDir, target, { recursive: true });
      const cfg = readPathConfig();
      cfg.dataPath = target;
      writePathConfig(cfg);
      // 写明文副本供 NSIS 卸载器读取
      try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'custom-data-path.txt'), target + '\n', 'utf-8');
      } catch (_) { /* 非致命，忽略 */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  // 恢复默认数据目录（文档/念语数据）：把当前数据迁回默认目录并清除自定义路径。
  resetDataPathToDefault(): { ok: boolean; error?: string } {
    const target = defaultDataDirPath();
    if (target === this.dataDir) {
      const cfg = readPathConfig();
      cfg.dataPath = '';
      writePathConfig(cfg);
      try { fs.unlinkSync(path.join(app.getPath('userData'), 'custom-data-path.txt')); } catch (_) { /* ignore */ }
      return { ok: true };
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(this.dataDir, target, { recursive: true });
      const cfg = readPathConfig();
      cfg.dataPath = '';
      writePathConfig(cfg);
      try { fs.unlinkSync(path.join(app.getPath('userData'), 'custom-data-path.txt')); } catch (_) { /* ignore */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 旧版单一 worldBook 字符串迁移为「世界书库」中的一条，并设为全局默认
  private migrate(): void {
    if (this.settings.worldBook && this.settings.worldBook.trim() && this.store.worldBooks.length === 0) {
      const now = new Date().toISOString();
      const wb: WorldBook = {
        id: 'wb_legacy',
        name: '默认世界书',
        description: '由旧版世界书设置自动迁移',
        content: this.settings.worldBook,
        entries: [],
        created_at: now,
        updated_at: now,
      };
      this.store.worldBooks.push(wb);
      this.settings.defaultWorldBookId = wb.id;
      this.settings.worldBook = '';
      this.saveStore();
      this.saveSettings({});
    }
    // 为老用户从已有消息填充 chatSessions
    if (this.store.chatSessions.length === 0 && this.store.messages.length > 0) {
      const seen = new Set<string>();
      for (const m of this.store.messages) {
        const key = `${m.chat_type}:${m.chat_id}`;
        if (!seen.has(key)) {
          seen.add(key);
          this.store.chatSessions.push({ chat_type: m.chat_type, chat_id: m.chat_id, last_time: m.timestamp });
        }
      }
      this.saveStore();
    }
    // 兼容老数据：moments 数组缺省时补齐
    if (!Array.isArray(this.store.moments)) {
      this.store.moments = [];
      this.saveStore();
    }
  }

  get dataDirectory(): string {
    return this.dataDir;
  }

  get imagesDir(): string {
    return path.join(this.dataDir, 'images');
  }

  private loadStore(): Store {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        return {
          roles: raw.roles || [],
          groups: raw.groups || [],
          messages: raw.messages || [],
          affinity: raw.affinity || [],
          worldBooks: raw.worldBooks || [],
          rules: raw.rules || [],
          memories: raw.memories || [],
          seq: raw.seq || 0,
          chatSessions: raw.chatSessions || [],
          storyNodes: raw.storyNodes || [],
          moments: raw.moments || [],
          plugins: raw.plugins || [],
        };
      }
    } catch (e) {
      console.error('读取存储失败', e);
    }
    return { roles: [], groups: [], messages: [], affinity: [], worldBooks: [], rules: [], memories: [], seq: 0, chatSessions: [], storyNodes: [], moments: [], plugins: [] };
  }

  private genId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  private saveStore(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
  }

  private nextId(): number {
    this.store.seq += 1;
    return this.store.seq;
  }

  // ---------- 角色 ----------
  listRoles(): Role[] {
    return [...this.store.roles].sort((a, b) =>
      (b.updated_at || '').localeCompare(a.updated_at || '')
    );
  }

  getRole(id: string): Role | undefined {
    return this.store.roles.find((r) => r.id === id);
  }

  createRole(role: Role): void {
    const idx = this.store.roles.findIndex((r) => r.id === role.id);
    if (idx >= 0) this.store.roles[idx] = role;
    else this.store.roles.push(role);
    this.saveStore();
  }

  updateRole(id: string, patch: Partial<Role>): void {
    const existing = this.getRole(id);
    if (!existing) return;
    this.createRole({ ...existing, ...patch, updated_at: new Date().toISOString() });
  }

  deleteRole(id: string): void {
    this.store.roles = this.store.roles.filter((r) => r.id !== id);
    this.store.messages = this.store.messages.filter(
      (m) => !(m.chat_type === 'single' && m.chat_id === id)
    );
    this.store.affinity = this.store.affinity.filter((a) => a.role_id !== id);
    // 删除数字人：连带删除其全部记忆（自动与手动均清）
    this.store.memories = this.store.memories.filter((m) => m.roleId !== id);
    // 删除会话记录
    this.store.chatSessions = this.store.chatSessions.filter(
      (s) => !(s.chat_type === 'single' && s.chat_id === id)
    );
    this.saveStore();
  }

  getRoleByName(name: string): Role | undefined {
    const n = (name || '').trim();
    return this.store.roles.find((r) => r.name.trim() === n);
  }

  // ===================== 世界书 =====================
  listWorldBooks(): WorldBook[] {
    return [...this.store.worldBooks].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  getWorldBook(id: string): WorldBook | undefined {
    return this.store.worldBooks.find((w) => w.id === id);
  }

  saveWorldBook(wb: WorldBook): void {
    const idx = this.store.worldBooks.findIndex((w) => w.id === wb.id);
    if (idx >= 0) this.store.worldBooks[idx] = wb;
    else this.store.worldBooks.push(wb);
    this.saveStore();
  }

  deleteWorldBook(id: string): void {
    this.store.worldBooks = this.store.worldBooks.filter((w) => w.id !== id);
    // 解除角色/聊天对该世界书的引用
    this.store.roles = this.store.roles.map((r) =>
      r.worldBookId === id ? { ...r, worldBookId: '' } : r
    );
    if (this.settings.defaultWorldBookId === id) this.settings.defaultWorldBookId = '';
    for (const k of Object.keys(this.settings.chatWorldBooks)) {
      if (this.settings.chatWorldBooks[k] === id) delete this.settings.chatWorldBooks[k];
    }
    this.saveStore();
    this.saveSettings({});
  }

  copyWorldBook(id: string): WorldBook | undefined {
    const src = this.getWorldBook(id);
    if (!src) return undefined;
    const now = new Date().toISOString();
    const copy: WorldBook = {
      ...src,
      id: this.genId('wb'),
      name: `${src.name} 副本`,
      entries: src.entries.map((e) => ({ ...e, id: this.genId('wbe') })),
      created_at: now,
      updated_at: now,
    };
    this.store.worldBooks.push(copy);
    this.saveStore();
    return copy;
  }

  // ===================== 插件 =====================
  // 插件以声明式结构存储：worldBook / role / rule（复用既有资产）+ 受控 HTTP 工具 + 可选提示词片段。
  // 默认不执行任何 JS；若 settings.pluginAllowJs 为真且插件带 jsEntry，才在沙箱化的受限上下文里加载。
  listPlugins(): Plugin[] {
    return [...this.store.plugins].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  getPlugin(id: string): Plugin | undefined {
    return this.store.plugins.find((p) => p.id === id);
  }

  savePlugin(p: Plugin): void {
    const idx = this.store.plugins.findIndex((x) => x.id === p.id);
    if (idx >= 0) this.store.plugins[idx] = p;
    else this.store.plugins.push(p);
    this.saveStore();
  }

  updatePlugin(id: string, patch: Partial<Plugin>): Plugin | undefined {
    const idx = this.store.plugins.findIndex((x) => x.id === id);
    if (idx < 0) return undefined;
    const next = { ...this.store.plugins[idx], ...patch, id };
    this.store.plugins[idx] = next;
    this.saveStore();
    return next;
  }

  deletePlugin(id: string): void {
    this.store.plugins = this.store.plugins.filter((p) => p.id !== id);
    this.saveStore();
  }


  // ===================== 规则库 =====================
  listRules(): Rule[] {
    return [...this.store.rules].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  getRule(id: string): Rule | undefined {
    return this.store.rules.find((r) => r.id === id);
  }

  saveRule(rule: Rule): void {
    const idx = this.store.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.store.rules[idx] = rule;
    else this.store.rules.push(rule);
    this.saveStore();
  }

  deleteRule(id: string): void {
    this.store.rules = this.store.rules.filter((r) => r.id !== id);
    this.store.roles = this.store.roles.map((r) =>
      r.ruleIds && r.ruleIds.includes(id) ? { ...r, ruleIds: r.ruleIds.filter((x) => x !== id) } : r
    );
    this.settings.sharedRuleIds = (this.settings.sharedRuleIds || []).filter((x) => x !== id);
    this.saveStore();
    this.saveSettings({});
  }

  copyRule(id: string): Rule | undefined {
    const src = this.getRule(id);
    if (!src) return undefined;
    const now = new Date().toISOString();
    const copy: Rule = { ...src, id: this.genId('rule'), name: `${src.name} 副本`, created_at: now, updated_at: now };
    this.store.rules.push(copy);
    this.saveStore();
    return copy;
  }

  // ===================== 记忆 =====================
  // 记忆隔离：传入 chatId 时只返回「该聊天的记忆」+「角色级共享记忆(chatId 为空)」；
  // 仅传 roleId（不传 chatId）时返回该角色全部记忆（记忆面板用）。
  listMemories(roleId?: string, chatId?: string): MemoryEntry[] {
    let list = roleId
      ? this.store.memories.filter((m) => m.roleId === roleId)
      : this.store.memories;
    if (roleId && chatId) {
      list = list.filter((m) => (m.chatId || '') === chatId || !m.chatId);
    }
    return [...list].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  }

  addMemory(m: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at' | 'chatId'> & Partial<Pick<MemoryEntry, 'id' | 'created_at' | 'updated_at' | 'sourceMsgId' | 'sourceMsgIds' | 'chatId'>>): MemoryEntry {
    const now = new Date().toISOString();
    const full: MemoryEntry = {
      id: m.id || this.genId('mem'),
      roleId: m.roleId,
      chatId: (m as any).chatId,
      content: m.content,
      source: m.source,
      sourceMsgId: (m as any).sourceMsgId,
      sourceMsgIds: (m as any).sourceMsgIds,
      image_path: (m as any).image_path,
      created_at: m.created_at || now,
      updated_at: now,
    };
    this.store.memories.push(full);
    this.saveStore();
    return full;
  }

  updateMemory(id: string, content: string): void {
    const m = this.store.memories.find((x) => x.id === id);
    if (!m) return;
    m.content = content;
    m.updated_at = new Date().toISOString();
    this.saveStore();
  }

  deleteMemory(id: string): void {
    this.store.memories = this.store.memories.filter((m) => m.id !== id);
    this.saveStore();
  }

  // 按 sourceMsgId / sourceMsgIds 删除关联记忆（用于回滚/撤回）
  deleteMemoriesByMsgId(msgId: number): number {
    const before = this.store.memories.length;
    this.store.memories = this.store.memories.filter((m) => {
      if (m.sourceMsgId === msgId) return false;
      if (m.sourceMsgIds && m.sourceMsgIds.includes(msgId)) return false;
      return true;
    });
    const deleted = before - this.store.memories.length;
    if (deleted > 0) this.saveStore();
    return deleted;
  }

  // 单条删除消息（撤回）；返回是否成功，以及被联动删除的关联记忆条数
  deleteMessage(msgId: number): { ok: boolean; deletedMems: number } {
    const idx = this.store.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return { ok: false, deletedMems: 0 };
    this.store.messages.splice(idx, 1);
    const deletedMems = this.deleteMemoriesByMsgId(msgId);
    this.saveStore();
    return { ok: true, deletedMems };
  }

  // 回滚：删除 id >= msgId 的所有消息及其关联记忆
  rollbackMessages(chatType: string, chatId: string, fromMsgId: number): { deletedMsgs: number; deletedMems: number } {
    const target = this.store.messages.filter(
      (m) => m.chat_type === chatType && m.chat_id === chatId && m.id >= fromMsgId
    );
    const ids = new Set(target.map((m) => m.id));
    this.store.messages = this.store.messages.filter((m) => !ids.has(m.id));
    let deletedMems = 0;
    for (const id of ids) {
      deletedMems += this.deleteMemoriesByMsgId(id);
    }
    this.saveStore();
    return { deletedMsgs: ids.size, deletedMems };
  }

  // ---------- 聊天记录 ----------
  getMessages(chatType: string, chatId: string): ChatMessage[] {
    return this.store.messages
      .filter((m) => m.chat_type === chatType && m.chat_id === chatId)
      .sort((a, b) => a.id - b.id);
  }

  addMessage(msg: Omit<ChatMessage, 'id'>): ChatMessage {
    const full: ChatMessage = {
      ...msg,
      id: this.nextId(),
      // 观察者私密小窗聊天（id 形如 obs:<groupId>:<roleId>）默认为私密类型，便于日志分别标记
      msg_kind: msg.msg_kind ?? (msg.chat_id?.startsWith('obs:') ? 'private' : 'public'),
    };
    // 首次消息自动创建聊天会话（使清空消息后聊天仍可见）
    this.ensureChatSession(msg.chat_type, msg.chat_id, msg.timestamp);
    this.store.messages.push(full);
    this.saveStore();
    return full;
  }

  // 删除「在某聊天内产生的自动记忆」：按 sourceMsgId / sourceMsgIds 是否属于该聊天消息集合判定。
  // 手动记忆（source === 'manual'，无 sourceMsgIds 关联）不在此列，调用方需显式决定是否删除。
  private deleteAutoMemoriesByMsgIds(ids: Set<number>): number {
    if (ids.size === 0) return 0;
    const before = this.store.memories.length;
    this.store.memories = this.store.memories.filter((m) => {
      if (m.source !== 'auto') return true;
      if (m.sourceMsgId != null && ids.has(m.sourceMsgId)) return false;
      if (m.sourceMsgIds && m.sourceMsgIds.some((id) => ids.has(id))) return false;
      return true;
    });
    return before - this.store.memories.length;
  }

  // 删除聊天：一并删除该聊天内产生的自动记忆（手动记忆保留），并移除聊天会话
  deleteChat(chatType: string, chatId: string): void {
    const ids = new Set(
      this.store.messages
        .filter((m) => m.chat_type === chatType && m.chat_id === chatId)
        .map((m) => m.id)
    );
    this.store.messages = this.store.messages.filter(
      (m) => !(m.chat_type === chatType && m.chat_id === chatId)
    );
    this.deleteAutoMemoriesByMsgIds(ids);
    this.store.chatSessions = this.store.chatSessions.filter(
      (s) => !(s.chat_type === chatType && s.chat_id === chatId)
    );
    this.saveStore();
  }

  // 清空当前聊天消息；withMemories=true 时一并删除该聊天内产生的自动记忆（手动记忆保留）
  clearChatMessages(chatType: string, chatId: string, withMemories: boolean): { deletedMsgs: number; deletedMems: number } {
    const ids = new Set(
      this.store.messages
        .filter((m) => m.chat_type === chatType && m.chat_id === chatId)
        .map((m) => m.id)
    );
    this.store.messages = this.store.messages.filter(
      (m) => !(m.chat_type === chatType && m.chat_id === chatId)
    );
    let deletedMems = 0;
    if (withMemories) deletedMems = this.deleteAutoMemoriesByMsgIds(ids);
    this.saveStore();
    return { deletedMsgs: ids.size, deletedMems };
  }

  // ---------- 群组 ----------
  listGroups(): Group[] {
    return [...this.store.groups].sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || '')
    );
  }

  getGroup(id: string): Group | undefined {
    return this.store.groups.find((g) => g.group_id === id);
  }

  createGroup(g: Group): void {
    const idx = this.store.groups.findIndex((x) => x.group_id === g.group_id);
    if (idx >= 0) this.store.groups[idx] = g;
    else this.store.groups.push(g);
    this.saveStore();
  }

  deleteGroup(id: string): void {
    this.store.groups = this.store.groups.filter((g) => g.group_id !== id);
    // 复用 deleteChat 处理消息删除 + 自动记忆级联清理（手动记忆保留）
    this.deleteChat('group', id);
    // deleteChat 已调用 saveStore()
  }

  // 设置「保持群聊」的持久化忽略标记：群聊仅剩 1 人时用户选择不转换后，
  // 该标记置 true，之后进入此群聊不再弹出「转为单聊」提示。
  setGroupIgnoreConvert(groupId: string, value: boolean): void {
    const g = this.getGroup(groupId);
    if (!g) return;
    this.createGroup({ ...g, ignoreConvert: value });
  }

  // ---------- 好感度 ----------
  updateAffinity(roleId: string, change: number, reason: string): number {
    const role = this.getRole(roleId);
    if (!role) return 0;
    const factor = role.affinity_factor || 1.0;
    const delta = Math.round(change * factor);
    const next = Math.max(0, Math.min(100, role.affinity + delta));
    this.updateRole(roleId, { affinity: next });
    this.store.affinity.push({
      id: this.nextId(),
      role_id: roleId,
      change: delta,
      reason,
      timestamp: new Date().toISOString(),
    });
    this.saveStore();
    return next;
  }

  getAffinityLog(roleId?: string): AffinityLogEntry[] {
    const list = roleId
      ? this.store.affinity.filter((a) => a.role_id === roleId)
      : this.store.affinity;
    return [...list].sort((a, b) => b.id - a.id);
  }

  // ---------- 设置 ----------
  loadSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
        const merged: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...raw,
          models: Array.isArray(raw.models) ? raw.models : [],
          voice: { ...DEFAULT_SETTINGS.voice, ...(raw.voice || {}) },
          miniWindow: { ...DEFAULT_SETTINGS.miniWindow, ...(raw.miniWindow || {}) },
          imageGen: { ...DEFAULT_SETTINGS.imageGen, ...(raw.imageGen || {}) },
        };
        // 清理遗留的默认 GPT-4o mini 种子模型
        merged.models = merged.models.filter(
          (m) => !(m.id === 'default' && m.model === 'gpt-4o-mini')
        );
        // 老用户（已存在 settings.json 但无 firstRunDone 字段）视为已完成首启，不再弹出向导
        if (raw.firstRunDone === undefined) merged.firstRunDone = true;
        return merged;
      }
    } catch (e) {
      console.error('读取设置失败', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    if (patch.apiKeys) {
      this.settings.apiKeys = { ...this.settings.apiKeys, ...patch.apiKeys };
    }
    if (patch.voice) {
      this.settings.voice = { ...DEFAULT_SETTINGS.voice, ...this.settings.voice, ...patch.voice };
    }
    if (patch.miniWindow) {
      this.settings.miniWindow = {
        ...DEFAULT_SETTINGS.miniWindow,
        ...this.settings.miniWindow,
        ...patch.miniWindow,
      };
    }
    if (patch.imageGen) {
      this.settings.imageGen = {
        ...DEFAULT_SETTINGS.imageGen,
        ...this.settings.imageGen,
        ...patch.imageGen,
      };
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    return this.settings;
  }

  // ---------- 一键恢复初始设置 ----------
  // keepKeys=true 时保留已配置的 API Key 与模型（含默认模型），仅把其余偏好/行为项恢复出厂默认。
  // 无论哪种模式，以下数据均始终保留（视为用户数据，不属于「设置」项）：
  //   - firstRunDone：避免重置后下次启动误弹初始向导
  //   - selfRoles / currentSelfRoleId / chatSelfRoles：「我的角色卡」自我身份
  // 角色卡、聊天记录、世界书、规则等是独立数据存储，本方法完全不触碰它们。
  resetSettings(keepKeys: boolean): AppSettings {
    const fresh: AppSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    fresh.firstRunDone = this.settings.firstRunDone;
    fresh.selfRoles = this.settings.selfRoles;
    fresh.currentSelfRoleId = this.settings.currentSelfRoleId;
    fresh.chatSelfRoles = this.settings.chatSelfRoles;
    if (keepKeys) {
      fresh.apiKeys = this.settings.apiKeys;
      fresh.models = this.settings.models;
      fresh.defaultModel = this.settings.defaultModel;
    }
    this.settings = fresh;
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    return this.settings;
  }

  // 确保聊天会话存在（首次消息时自动创建，清空消息后聊天仍可见）
  private ensureChatSession(chatType: string, chatId: string, timestamp: string): void {
    if (chatId.startsWith('obs:')) return; // 观察者私密小窗不加入会话列表
    const exists = this.store.chatSessions.some(
      (s) => s.chat_type === chatType && s.chat_id === chatId
    );
    if (!exists) {
      this.store.chatSessions.push({ chat_type: chatType, chat_id: chatId, last_time: timestamp });
      this.saveStore();
    }
  }

  // 解析单聊真实 roleId：
  // 普通单聊 chat_id === roleId；观察者私密 obs:<gid>:<rid> 取末段；
  // 复制出的单聊 chat_id 与 roleId 解绑，需查 chatSessions.role_id。
  resolveSingleRoleId(chatType: string, chatId: string): string {
    if (chatType !== 'single') return chatId;
    if (chatId.startsWith('obs:')) return chatId.split(':').pop() || chatId;
    if (this.getRole(chatId)) return chatId;
    const s = this.store.chatSessions.find(
      (x) => x.chat_type === 'single' && x.chat_id === chatId
    );
    if (s?.role_id) return s.role_id;
    return chatId;
  }

  // 复制聊天：1:1 复制消息与卡片，新卡片名加「副本」后缀（group 复制整组，single 复制并与角色解绑为新卡片）
  // 同时复制：① 本聊的隔离记忆（按 chatId）；② 每聊独立参数（worldBook/idle/sound/bg/selfRole/sceneImage/webSearch 的 key 重映射）
  copyChat(chatType: string, chatId: string): { chat_type: string; chat_id: string; name: string } {
    const now = new Date().toISOString();
    if (chatType === 'group') {
      const g = this.getGroup(chatId);
      if (!g) throw new Error('group not found');
      const newId = this.genId('group');
      const newName = `${g.group_name} 副本`;
      const newGroup: Group = { ...g, group_id: newId, group_name: newName, created_at: now };
      this.store.groups.push(newGroup);
      const msgs = this.store.messages.filter((m) => m.chat_type === 'group' && m.chat_id === chatId);
      for (const m of msgs) {
        this.store.messages.push({ ...m, id: this.nextId(), chat_id: newId });
      }
      // 复制本聊隔离记忆（按 group chatId）
      for (const m of this.store.memories.filter((mm) => mm.chatId === chatId)) {
        this.store.memories.push({ ...m, id: this.genId('mem'), chatId: newId, created_at: now, updated_at: now });
      }
      this.remapChatSettings(`group:${chatId}`, `group:${newId}`);
      this.store.chatSessions.push({ chat_type: 'group', chat_id: newId, last_time: now });
      this.saveStore();
      return { chat_type: 'group', chat_id: newId, name: newName };
    }
    // single
    const roleId = this.resolveSingleRoleId('single', chatId);
    const role = this.getRole(roleId);
    const baseName = role?.name || roleId;
    const newId = `single_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const newName = `${baseName} 副本`;
    const msgs = this.store.messages.filter((m) => m.chat_type === 'single' && m.chat_id === chatId);
    for (const m of msgs) {
      this.store.messages.push({ ...m, id: this.nextId(), chat_id: newId });
    }
    // 复制本聊隔离记忆（按 roleId + chatId）
    for (const m of this.store.memories.filter((mm) => mm.roleId === roleId && mm.chatId === chatId)) {
      this.store.memories.push({ ...m, id: this.genId('mem'), roleId, chatId: newId, created_at: now, updated_at: now });
    }
    this.remapChatSettings(`single:${chatId}`, `single:${newId}`);
    this.store.chatSessions.push({
      chat_type: 'single',
      chat_id: newId,
      role_id: roleId,
      chat_name: newName,
      last_time: now,
    });
    this.saveStore();
    return { chat_type: 'single', chat_id: newId, name: newName };
  }

  // 按聊独立的设置 map 的 key 重映射（复制聊天后，把源聊的参数 key 重映射到新聊）
  private remapChatSettings(srcKey: string, newKey: string): void {
    const maps: Record<string, any>[] = [
      this.settings.chatWorldBooks,
      this.settings.chatIdleEnabled,
      this.settings.chatSoundPaths,
      this.settings.chatBackgrounds,
      this.settings.chatSelfRoles,
      this.settings.autoSceneImageChats,
      this.settings.webSearchChats,
    ];
    for (const map of maps) {
      if (map && Object.prototype.hasOwnProperty.call(map, srcKey)) {
        map[newKey] = map[srcKey];
        delete map[srcKey];
      }
    }
    this.saveSettings({});
  }

  // 复制角色：连同记忆（含按聊隔离记忆）与该角色的全部单聊（消息 + 每聊参数 + 记忆 chatId 重映射）一并复制
  copyRole(id: string, includeChats: boolean): { id: string; name: string } | undefined {
    const src = this.getRole(id);
    if (!src) return undefined;
    const now = new Date().toISOString();
    const newId = this.genId('role');
    const copy: Role = { ...src, id: newId, name: `${src.name} 副本`, created_at: now, updated_at: now };
    this.store.roles.push(copy);
    // 复制记忆：包含按聊隔离的记忆（chatId 保留以延续隔离关系）；不复制聊天时把隔离记忆转角色级共享
    const mems = this.store.memories.filter((m) => m.roleId === id);
    for (const m of mems) {
      this.store.memories.push({
        ...m,
        id: this.genId('mem'),
        roleId: newId,
        chatId: includeChats ? m.chatId : undefined,
        created_at: now,
        updated_at: now,
      });
    }
    if (includeChats) {
      const sessions = this.store.chatSessions.filter(
        (s) => s.chat_type === 'single' && s.role_id === id
      );
      for (const s of sessions) {
        const newChatId = `single_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        const oldChatId = s.chat_id;
        const msgs = this.store.messages.filter((m) => m.chat_type === 'single' && m.chat_id === oldChatId);
        for (const m of msgs) this.store.messages.push({ ...m, id: this.nextId(), chat_id: newChatId });
        this.store.chatSessions.push({
          chat_type: 'single',
          chat_id: newChatId,
          role_id: newId,
          chat_name: `${s.chat_name || src.name} 副本`,
          last_time: now,
        });
        // 新复制记忆中指向旧聊的 chatId 重映射到新聊
        for (const m of this.store.memories) {
          if (m.roleId === newId && m.chatId === oldChatId) m.chatId = newChatId;
        }
        this.remapChatSettings(`single:${oldChatId}`, `single:${newChatId}`);
      }
    }
    this.saveStore();
    return { id: newId, name: copy.name };
  }

  // 重命名聊天卡片：写入 chat_name 覆盖显示名，不改动角色/群本身（非破坏式）
  renameChat(chatType: string, chatId: string, name: string): void {
    const s = this.store.chatSessions.find(
      (x) => x.chat_type === chatType && x.chat_id === chatId
    );
    if (s) {
      s.chat_name = name;
    } else {
      this.store.chatSessions.push({
        chat_type: chatType,
        chat_id: chatId,
        chat_name: name,
        last_time: new Date().toISOString(),
      });
    }
    this.saveStore();
  }

  // ===== 自适应故事线 =====
  setStoryEnabled(chatType: string, chatId: string, enabled: boolean): void {
    let s = this.store.chatSessions.find(
      (x) => x.chat_type === chatType && x.chat_id === chatId
    );
    if (!s) {
      s = { chat_type: chatType, chat_id: chatId, last_time: new Date().toISOString() };
      this.store.chatSessions.push(s);
    }
    s.storyEnabled = enabled;
    this.saveStore();
  }

  getStoryEnabled(chatType: string, chatId: string): boolean {
    return (
      this.store.chatSessions.find(
        (x) => x.chat_type === chatType && x.chat_id === chatId
      )?.storyEnabled === true
    );
  }

  // 标记剧情节点：关联某条消息，返回节点 id
  addStoryNode(chatType: string, chatId: string, msgId: number, title: string): number {
    const node: StoryNode = {
      id: this.nextId(),
      chat_type: chatType,
      chat_id: chatId,
      msg_id: msgId,
      title: title || `节点 ${this.store.storyNodes.length + 1}`,
      timestamp: new Date().toISOString(),
    };
    this.store.storyNodes.push(node);
    this.saveStore();
    return node.id;
  }

  listStoryNodes(chatType: string, chatId: string): StoryNode[] {
    return this.store.storyNodes
      .filter((n) => n.chat_type === chatType && n.chat_id === chatId)
      .sort((a, b) => a.id - b.id);
  }

  removeStoryNode(id: number): void {
    const before = this.store.storyNodes.length;
    this.store.storyNodes = this.store.storyNodes.filter((n) => n.id !== id);
    if (this.store.storyNodes.length !== before) this.saveStore();
  }

  // ===== 朋友圈动态（人物养成/社交） =====
  // 新增动态：scheduledAt 为空/null 立即发布；否则到点后才发布
  addMoment(roleId: string, content: string, images: string[], scheduledAt?: string | null, selfRoleId?: string): number {
    const now = new Date().toISOString();
    const published = !scheduledAt;
    const moment: Moment = {
      id: this.nextId(),
      roleId,
      content: content || '',
      images: images || [],
      created_at: now,
      scheduledAt: scheduledAt || null,
      published,
      selfRoleId: selfRoleId || undefined,
      liked: false,
      favorited: false,
    };
    this.store.moments.push(moment);
    this.saveStore();
    return moment.id;
  }

  // 列出动态：roleId 缺省返回全部；selfRoleId 缺省返回全部（不过滤）；默认仅返回已发布，includeUnpublished 控制是否含待发布；favoritedOnly 为 true 时仅返回已收藏
  listMoments(roleId?: string, includeUnpublished = false, selfRoleId?: string, favoritedOnly = false): Moment[] {
    return this.store.moments
      .filter((m) => (roleId ? m.roleId === roleId : true))
      .filter((m) => (selfRoleId !== undefined ? (m.selfRoleId || '') === selfRoleId : true))
      .filter((m) => m.published || includeUnpublished)
      .filter((m) => (favoritedOnly ? !!m.favorited : true))
      .sort((a, b) => (b.scheduledAt || b.created_at).localeCompare(a.scheduledAt || a.created_at));
  }

  // 更新单条动态（点赞 / 收藏切换等）
  updateMoment(id: number, patch: Partial<Moment>): void {
    const m = this.store.moments.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    this.saveStore();
  }

  // 到点发布：将已到 scheduledAt 的待发布动态转为 published
  publishDueMoments(): number {
    const now = Date.now();
    let changed = 0;
    for (const m of this.store.moments) {
      if (!m.published && m.scheduledAt && new Date(m.scheduledAt).getTime() <= now) {
        m.published = true;
        changed++;
      }
    }
    if (changed > 0) this.saveStore();
    return changed;
  }

  removeMoment(id: number): void {
    const before = this.store.moments.length;
    this.store.moments = this.store.moments.filter((m) => m.id !== id);
    if (this.store.moments.length !== before) this.saveStore();
  }

  // ===== 人物养成：关系值与等级（持久化在 Role.bond / Role.level） =====
  adjustBond(roleId: string, delta: number): number {
    const r = this.getRole(roleId);
    if (!r) return 0;
    const next = Math.max(0, (r.bond || 0) + delta);
    r.bond = next;
    // 等级随关系值阶梯推导（每 100 点升一级），可被手动 level 覆盖逻辑在前端处理
    r.updated_at = new Date().toISOString();
    this.saveStore();
    return next;
  }

  // 最近聊天列表
  getChatList(): {
    chat_type: string;
    chat_id: string;
    name: string;
    avatar_path: string;
    last_message: string;
    last_time: string;
  }[] {
    // 1) 从消息分组推导已有消息的会话
    const groups: { chat_type: string; chat_id: string; ids: number[] }[] = [];
    for (const m of this.store.messages) {
      let g = groups.find((x) => x.chat_type === m.chat_type && x.chat_id === m.chat_id);
      if (!g) {
        g = { chat_type: m.chat_type, chat_id: m.chat_id, ids: [] };
        groups.push(g);
      }
      g.ids.push(m.id);
    }
    const result: any[] = [];
    const covered = new Set<string>();
    for (const g of groups) {
      // 观察者私密小窗（obs: 前缀）不属于普通会话列表，仅在私密窗口内访问
      if (g.chat_id.startsWith('obs:')) continue;
      const lastId = Math.max(...g.ids);
      const last = this.store.messages.find((m) => m.id === lastId);
      let name = g.chat_id;
      let avatar = '';
      if (g.chat_type === 'single') {
        const role = this.getRole(this.resolveSingleRoleId(g.chat_type, g.chat_id));
        if (!role) continue; // 角色已删除，跳过残留会话
        name = role.name;
        avatar = role.avatar_path || '';
      } else {
        const grp = this.getGroup(g.chat_id);
        if (!grp) continue; // 群组已删除但仍有残留消息，不再列入会话列表（杜绝 0 人幽灵群）
        name = grp.group_name;
      }
      const gOverride = this.store.chatSessions.find(
        (x) => x.chat_type === g.chat_type && x.chat_id === g.chat_id
      )?.chat_name;
      if (gOverride) name = gOverride;
      covered.add(`${g.chat_type}:${g.chat_id}`);
      result.push({
        chat_type: g.chat_type,
        chat_id: g.chat_id,
        name,
        chat_name: gOverride,
        avatar_path: avatar,
        last_message: last?.image_path || (last?.images && last.images.length) ? '[图片]' : last?.content || '',
        last_time: last?.timestamp || '',
      });
    }
    // 2) 补充仅有 chatSessions 但无消息的聊天（清空消息后保留的空会话）
    for (const s of this.store.chatSessions) {
      const key = `${s.chat_type}:${s.chat_id}`;
      if (covered.has(key)) continue;
      if (s.chat_id.startsWith('obs:')) continue;
      let name = s.chat_id;
      let avatar = '';
      if (s.chat_type === 'single') {
        const role = this.getRole(this.resolveSingleRoleId(s.chat_type, s.chat_id));
        if (!role) continue;
        name = role.name;
        avatar = role.avatar_path || '';
      } else {
        const grp = this.getGroup(s.chat_id);
        if (!grp) continue;
        name = grp.group_name;
      }
      if (s.chat_name) name = s.chat_name;
      result.push({
        chat_type: s.chat_type,
        chat_id: s.chat_id,
        name,
        chat_name: s.chat_name,
        avatar_path: avatar,
        last_message: '',
        last_time: s.last_time,
      });
    }
    return result.sort((a, b) => (a.last_time < b.last_time ? 1 : -1));
  }

  // 每个角色的聊天统计：单聊按 chat_id 归属，群聊按 AI 消息的 sender_name 归属
  getRoleStats(): { roleId: string; roleName: string; tokens: number; messages: number }[] {
    const nameToId: Record<string, string> = {};
    for (const r of this.store.roles) nameToId[r.name] = r.id;
    const stats: Record<
      string,
      { roleId: string; roleName: string; tokens: number; messages: number }
    > = {};
    for (const r of this.store.roles) {
      stats[r.id] = { roleId: r.id, roleName: r.name, tokens: 0, messages: 0 };
    }
    for (const m of this.store.messages) {
      if (m.sender_type === 'user') {
        // 用户消息：单聊中归属到对应人物；群聊中多人共享，不计入任一人物
        if (m.chat_type === 'single') {
          const st = stats[m.chat_id];
          if (st) {
            st.tokens += m.token_used || 0;
            st.messages += 1;
          }
        }
      } else if (m.sender_type === 'ai') {
        // AI 消息：单聊（chat_id=roleId）或群聊（sender_name=角色名）均归属到该人物
        let rid = stats[m.chat_id] ? m.chat_id : '';
        if (!rid) rid = nameToId[m.sender_name] || '';
        const st = rid ? stats[rid] : undefined;
        if (st) {
          st.tokens += m.token_used || 0;
          st.messages += 1;
        }
      }
    }
    return Object.values(stats).sort((a, b) => b.tokens - a.tokens);
  }

  // 将仅剩 1 名成员的群聊转为该成员名下的单聊：
  // 原群聊消息改挂到 single:<roleId>，token 即记入该人物；已删除成员的消息一并清理。
  convertGroupToSingle(groupId: string, roleId: string): void {
    const role = this.getRole(roleId);
    const roleName = role?.name || '';
    this.store.messages = this.store.messages
      .filter((m) => {
        if (m.chat_type !== 'group' || m.chat_id !== groupId) return true;
        // 仅保留本群中「用户消息」与该角色的消息，已删除成员的消息丢弃
        if (m.sender_type === 'user') return true;
        if (m.sender_type === 'ai' && m.sender_name === roleName) return true;
        return false;
      })
      .map((m) =>
        m.chat_type === 'group' && m.chat_id === groupId
          ? { ...m, chat_type: 'single' as any, chat_id: roleId }
          : m
      );
    this.store.groups = this.store.groups.filter((g) => g.group_id !== groupId);
    this.saveStore();
  }
}

let instance: DataManager | null = null;
export function getDataManager(): DataManager {
  if (!instance) instance = new DataManager();
  return instance;
}
