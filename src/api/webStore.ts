// Web 版数据存储（浏览器/WebView 环境）
// 复刻 electron/db.ts 的 DataManager：数据语义完全一致（角色/群组/消息/好感/世界书/规则/记忆/会话/剧情/朋友圈）。
// 持久化改用 IndexedDB；图片以 Blob 存储，并以 dataURL 缓存供多模态模型输入（替代桌面版的文件路径）。
// 为保持与桌面版一致的「同步」调用方式，所有读写命中内存缓存，变更后异步落盘 IndexedDB。
import type {
  Role,
  ChatMessage,
  Group,
  AffinityLogEntry,
  AppSettings,
  WorldBook,
  Rule,
  MemoryEntry,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';

interface ChatSession {
  chat_type: string;
  chat_id: string;
  last_time: string;
  chat_name?: string;
  role_id?: string;
  storyEnabled?: boolean;
}

interface StoryNode {
  id: number;
  chat_type: string;
  chat_id: string;
  msg_id: number;
  title: string;
  timestamp: string;
}

interface Moment {
  id: number;
  roleId: string;
  content: string;
  images: string[];
  created_at: string;
  scheduledAt?: string | null;
  published: boolean;
  selfRoleId?: string;
  liked?: boolean;
  favorited?: boolean;
}

interface Store {
  roles: Role[];
  groups: Group[];
  messages: ChatMessage[];
  affinity: AffinityLogEntry[];
  worldBooks: WorldBook[];
  rules: Rule[];
  memories: MemoryEntry[];
  seq: number;
  chatSessions: ChatSession[];
  storyNodes: StoryNode[];
  moments: Moment[];
}

const DB_NAME = 'nianyu-web';
const DB_VERSION = 1;
const STORE_KEY = 'main';

export class WebDataManager {
  private store: Store;
  private settings: AppSettings;
  private imageCache: Map<string, string> = new Map(); // id -> dataURL
  private blobMap: Map<string, Blob> = new Map();
  private readyPromise: Promise<void>;
  private persistTimer: number | null = null;

  constructor() {
    this.store = {
      roles: [], groups: [], messages: [], affinity: [],
      worldBooks: [], rules: [], memories: [], seq: 0,
      chatSessions: [], storyNodes: [], moments: [],
    };
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.readyPromise = this.load();
  }

  whenReady(): Promise<void> { return this.readyPromise; }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async load(): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['store', 'images'], 'readonly');
      const storeReq = tx.objectStore('store').get(STORE_KEY);
      const imagesReq = tx.objectStore('images').getAll();
      await new Promise<void>((res) => { tx.oncomplete = () => res(); });
      const raw = storeReq.result as Store | undefined;
      if (raw) {
        this.store = {
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
        };
      }
      const imgRecords = (imagesReq.result as { id: string; blob: Blob }[]) || [];
      for (const rec of imgRecords) {
        this.blobMap.set(rec.id, rec.blob);
        try {
          const url = await blobToDataUrl(rec.blob);
          this.imageCache.set(rec.id, url);
        } catch { /* ignore */ }
      }
      this.settings = this.loadSettings();
      this.migrate();
    } catch (e) {
      console.error('WebDataManager 加载失败', e);
      this.settings = this.loadSettings();
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 200) as unknown as number;
  }

  private async persist(): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction('store', 'readwrite');
      tx.objectStore('store').put(this.store, STORE_KEY);
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) {
      console.error('持久化 store 失败', e);
    }
  }

  private async persistImage(id: string, blob: Blob): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put({ id, blob }, id);
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    } catch (e) {
      console.error('持久化图片失败', e);
    }
  }

  // ===================== 图片 =====================
  async saveImage(dataUrl: string): Promise<string | null> {
    try {
      const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!m) return null;
      const mime = m[1];
      const bin = atob(m[2]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: mime });
      const id = `img_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      this.blobMap.set(id, blob);
      this.imageCache.set(id, dataUrl);
      await this.persistImage(id, blob);
      return id;
    } catch (e) {
      console.error('保存图片失败', e);
      return null;
    }
  }

  // 同步取 dataURL（聊天多模态构建用，依赖初始化时已填充的缓存）
  getDataUrlSync(id: string): string | null {
    return this.imageCache.get(id) || null;
  }

  async getImage(id: string): Promise<string | null> {
    if (this.imageCache.has(id)) return this.imageCache.get(id)!;
    const blob = this.blobMap.get(id);
    if (!blob) return null;
    const url = await blobToDataUrl(blob);
    this.imageCache.set(id, url);
    return url;
  }

  // 多图存为 blob，返回 id 数组
  async saveImages(dataUrls: string[]): Promise<string[] | null> {
    if (!dataUrls || dataUrls.length === 0) return null;
    const out: string[] = [];
    for (const d of dataUrls) {
      const id = await this.saveImage(d);
      if (id) out.push(id);
    }
    return out.length ? out : null;
  }

  // ===================== 迁移 =====================
  private migrate(): void {
    if (this.settings.worldBook && this.settings.worldBook.trim() && this.store.worldBooks.length === 0) {
      const now = new Date().toISOString();
      const wb: WorldBook = {
        id: 'wb_legacy', name: '默认世界书', description: '由旧版世界书设置自动迁移',
        content: this.settings.worldBook, entries: [], created_at: now, updated_at: now,
      };
      this.store.worldBooks.push(wb);
      this.settings.defaultWorldBookId = wb.id;
      this.settings.worldBook = '';
      this.schedulePersist();
      this.saveSettings({});
    }
    if (this.store.chatSessions.length === 0 && this.store.messages.length > 0) {
      const seen = new Set<string>();
      for (const m of this.store.messages) {
        const key = `${m.chat_type}:${m.chat_id}`;
        if (!seen.has(key)) {
          seen.add(key);
          this.store.chatSessions.push({ chat_type: m.chat_type, chat_id: m.chat_id, last_time: m.timestamp });
        }
      }
      this.schedulePersist();
    }
    if (!Array.isArray(this.store.moments)) {
      this.store.moments = [];
      this.schedulePersist();
    }
  }

  private genId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  // ===================== 角色 =====================
  listRoles(): Role[] {
    return [...this.store.roles].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }
  getRole(id: string): Role | undefined {
    return this.store.roles.find((r) => r.id === id);
  }
  createRole(role: Role): void {
    const idx = this.store.roles.findIndex((r) => r.id === role.id);
    if (idx >= 0) this.store.roles[idx] = role;
    else this.store.roles.push(role);
    this.schedulePersist();
  }
  updateRole(id: string, patch: Partial<Role>): void {
    const existing = this.getRole(id);
    if (!existing) return;
    this.createRole({ ...existing, ...patch, updated_at: new Date().toISOString() });
  }
  deleteRole(id: string): void {
    this.store.roles = this.store.roles.filter((r) => r.id !== id);
    this.store.messages = this.store.messages.filter((m) => !(m.chat_type === 'single' && m.chat_id === id));
    this.store.affinity = this.store.affinity.filter((a) => a.role_id !== id);
    this.store.memories = this.store.memories.filter((m) => m.roleId !== id);
    this.store.chatSessions = this.store.chatSessions.filter((s) => !(s.chat_type === 'single' && s.chat_id === id));
    this.schedulePersist();
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
    this.schedulePersist();
  }
  deleteWorldBook(id: string): void {
    this.store.worldBooks = this.store.worldBooks.filter((w) => w.id !== id);
    this.store.roles = this.store.roles.map((r) => (r.worldBookId === id ? { ...r, worldBookId: '' } : r));
    if (this.settings.defaultWorldBookId === id) this.settings.defaultWorldBookId = '';
    for (const k of Object.keys(this.settings.chatWorldBooks)) {
      if (this.settings.chatWorldBooks[k] === id) delete this.settings.chatWorldBooks[k];
    }
    this.schedulePersist();
    this.saveSettings({});
  }
  copyWorldBook(id: string): WorldBook | undefined {
    const src = this.getWorldBook(id);
    if (!src) return undefined;
    const now = new Date().toISOString();
    const copy: WorldBook = {
      ...src, id: this.genId('wb'), name: `${src.name} 副本`,
      entries: src.entries.map((e) => ({ ...e, id: this.genId('wbe') })),
      created_at: now, updated_at: now,
    };
    this.store.worldBooks.push(copy);
    this.schedulePersist();
    return copy;
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
    this.schedulePersist();
  }
  deleteRule(id: string): void {
    this.store.rules = this.store.rules.filter((r) => r.id !== id);
    this.store.roles = this.store.roles.map((r) =>
      r.ruleIds && r.ruleIds.includes(id) ? { ...r, ruleIds: r.ruleIds.filter((x) => x !== id) } : r
    );
    this.settings.sharedRuleIds = (this.settings.sharedRuleIds || []).filter((x) => x !== id);
    this.schedulePersist();
    this.saveSettings({});
  }
  copyRule(id: string): Rule | undefined {
    const src = this.getRule(id);
    if (!src) return undefined;
    const now = new Date().toISOString();
    const copy: Rule = { ...src, id: this.genId('rule'), name: `${src.name} 副本`, created_at: now, updated_at: now };
    this.store.rules.push(copy);
    this.schedulePersist();
    return copy;
  }

  // ===================== 记忆 =====================
  listMemories(roleId?: string): MemoryEntry[] {
    const list = roleId ? this.store.memories.filter((m) => m.roleId === roleId) : this.store.memories;
    return [...list].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  }
  addMemory(m: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at'> & Partial<Pick<MemoryEntry, 'id' | 'created_at' | 'updated_at' | 'sourceMsgId' | 'sourceMsgIds'>>): MemoryEntry {
    const now = new Date().toISOString();
    const full: MemoryEntry = {
      id: m.id || this.genId('mem'),
      roleId: m.roleId,
      content: m.content,
      source: m.source,
      sourceMsgId: (m as any).sourceMsgId,
      sourceMsgIds: (m as any).sourceMsgIds,
      image_path: (m as any).image_path,
      created_at: m.created_at || now,
      updated_at: now,
    };
    this.store.memories.push(full);
    this.schedulePersist();
    return full;
  }
  updateMemory(id: string, content: string): void {
    const m = this.store.memories.find((x) => x.id === id);
    if (!m) return;
    m.content = content;
    m.updated_at = new Date().toISOString();
    this.schedulePersist();
  }
  deleteMemory(id: string): void {
    this.store.memories = this.store.memories.filter((m) => m.id !== id);
    this.schedulePersist();
  }
  deleteMemoriesByMsgId(msgId: number): number {
    const before = this.store.memories.length;
    this.store.memories = this.store.memories.filter((m) => {
      if (m.sourceMsgId === msgId) return false;
      if (m.sourceMsgIds && m.sourceMsgIds.includes(msgId)) return false;
      return true;
    });
    const deleted = before - this.store.memories.length;
    if (deleted > 0) this.schedulePersist();
    return deleted;
  }
  deleteMessage(msgId: number): { ok: boolean; deletedMems: number } {
    const idx = this.store.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return { ok: false, deletedMems: 0 };
    this.store.messages.splice(idx, 1);
    const deletedMems = this.deleteMemoriesByMsgId(msgId);
    this.schedulePersist();
    return { ok: true, deletedMems };
  }
  rollbackMessages(chatType: string, chatId: string, fromMsgId: number): { deletedMsgs: number; deletedMems: number } {
    const target = this.store.messages.filter((m) => m.chat_type === chatType && m.chat_id === chatId && m.id >= fromMsgId);
    const ids = new Set(target.map((m) => m.id));
    this.store.messages = this.store.messages.filter((m) => !ids.has(m.id));
    let deletedMems = 0;
    for (const id of ids) deletedMems += this.deleteMemoriesByMsgId(id);
    this.schedulePersist();
    return { deletedMsgs: ids.size, deletedMems };
  }

  // ===================== 聊天记录 =====================
  getMessages(chatType: string, chatId: string): ChatMessage[] {
    return this.store.messages
      .filter((m) => m.chat_type === chatType && m.chat_id === chatId)
      .sort((a, b) => a.id - b.id);
  }
  addMessage(msg: Omit<ChatMessage, 'id'>): ChatMessage {
    const full: ChatMessage = {
      ...msg,
      id: this.nextId(),
      msg_kind: msg.msg_kind ?? (msg.chat_id?.startsWith('obs:') ? 'private' : 'public'),
    };
    this.ensureChatSession(msg.chat_type, msg.chat_id, msg.timestamp);
    this.store.messages.push(full);
    this.schedulePersist();
    return full;
  }
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
  deleteChat(chatType: string, chatId: string): void {
    const ids = new Set(
      this.store.messages.filter((m) => m.chat_type === chatType && m.chat_id === chatId).map((m) => m.id)
    );
    this.store.messages = this.store.messages.filter((m) => !(m.chat_type === chatType && m.chat_id === chatId));
    this.deleteAutoMemoriesByMsgIds(ids);
    this.store.chatSessions = this.store.chatSessions.filter((s) => !(s.chat_type === chatType && s.chat_id === chatId));
    this.schedulePersist();
  }
  clearChatMessages(chatType: string, chatId: string, withMemories: boolean): { deletedMsgs: number; deletedMems: number } {
    const ids = new Set(
      this.store.messages.filter((m) => m.chat_type === chatType && m.chat_id === chatId).map((m) => m.id)
    );
    this.store.messages = this.store.messages.filter((m) => !(m.chat_type === chatType && m.chat_id === chatId));
    let deletedMems = 0;
    if (withMemories) deletedMems = this.deleteAutoMemoriesByMsgIds(ids);
    this.schedulePersist();
    return { deletedMsgs: ids.size, deletedMems };
  }

  // ===================== 群组 =====================
  listGroups(): Group[] {
    return [...this.store.groups].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
  getGroup(id: string): Group | undefined {
    return this.store.groups.find((g) => g.group_id === id);
  }
  createGroup(g: Group): void {
    const idx = this.store.groups.findIndex((x) => x.group_id === g.group_id);
    if (idx >= 0) this.store.groups[idx] = g;
    else this.store.groups.push(g);
    this.schedulePersist();
  }
  deleteGroup(id: string): void {
    this.store.groups = this.store.groups.filter((g) => g.group_id !== id);
    this.deleteChat('group', id);
  }
  setGroupIgnoreConvert(groupId: string, value: boolean): void {
    const g = this.getGroup(groupId);
    if (!g) return;
    this.createGroup({ ...g, ignoreConvert: value });
  }

  // ===================== 好感度 =====================
  updateAffinity(roleId: string, change: number, reason: string): number {
    const role = this.getRole(roleId);
    if (!role) return 0;
    const factor = role.affinity_factor || 1.0;
    const delta = Math.round(change * factor);
    const next = Math.max(0, Math.min(100, role.affinity + delta));
    this.updateRole(roleId, { affinity: next });
    this.store.affinity.push({ id: this.nextId(), role_id: roleId, change: delta, reason, timestamp: new Date().toISOString() });
    this.schedulePersist();
    return next;
  }
  getAffinityLog(roleId?: string): AffinityLogEntry[] {
    const list = roleId ? this.store.affinity.filter((a) => a.role_id === roleId) : this.store.affinity;
    return [...list].sort((a, b) => b.id - a.id);
  }

  // ===================== 设置 =====================
  loadSettings(): AppSettings {
    // 注意：IndexedDB 暂未存 settings.json，settings 全在内存（随 store 一起持久化到 'store' 之外，这里并入内存）
    return this.settings;
  }
  getSettings(): AppSettings {
    return this.settings;
  }
  saveSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    if (patch.apiKeys) this.settings.apiKeys = { ...this.settings.apiKeys, ...patch.apiKeys };
    if (patch.voice) this.settings.voice = { ...DEFAULT_SETTINGS.voice, ...this.settings.voice, ...patch.voice };
    if (patch.miniWindow) this.settings.miniWindow = { ...DEFAULT_SETTINGS.miniWindow, ...this.settings.miniWindow, ...patch.miniWindow };
    if (patch.imageGen) this.settings.imageGen = { ...DEFAULT_SETTINGS.imageGen, ...this.settings.imageGen, ...patch.imageGen };
    this.schedulePersist();
    return this.settings;
  }
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
    this.schedulePersist();
    return this.settings;
  }

  private ensureChatSession(chatType: string, chatId: string, timestamp: string): void {
    if (chatId.startsWith('obs:')) return;
    const exists = this.store.chatSessions.some((s) => s.chat_type === chatType && s.chat_id === chatId);
    if (!exists) {
      this.store.chatSessions.push({ chat_type: chatType, chat_id: chatId, last_time: timestamp });
      this.schedulePersist();
    }
  }
  resolveSingleRoleId(chatType: string, chatId: string): string {
    if (chatType !== 'single') return chatId;
    if (chatId.startsWith('obs:')) return chatId.split(':').pop() || chatId;
    if (this.getRole(chatId)) return chatId;
    const s = this.store.chatSessions.find((x) => x.chat_type === 'single' && x.chat_id === chatId);
    if (s?.role_id) return s.role_id;
    return chatId;
  }
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
      for (const m of msgs) this.store.messages.push({ ...m, id: this.nextId(), chat_id: newId });
      this.store.chatSessions.push({ chat_type: 'group', chat_id: newId, last_time: now });
      this.schedulePersist();
      return { chat_type: 'group', chat_id: newId, name: newName };
    }
    const roleId = this.resolveSingleRoleId('single', chatId);
    const role = this.getRole(roleId);
    const baseName = role?.name || roleId;
    const newId = `single_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const newName = `${baseName} 副本`;
    const msgs = this.store.messages.filter((m) => m.chat_type === 'single' && m.chat_id === chatId);
    for (const m of msgs) this.store.messages.push({ ...m, id: this.nextId(), chat_id: newId });
    this.store.chatSessions.push({ chat_type: 'single', chat_id: newId, role_id: roleId, chat_name: newName, last_time: now });
    this.schedulePersist();
    return { chat_type: 'single', chat_id: newId, name: newName };
  }
  renameChat(chatType: string, chatId: string, name: string): void {
    const s = this.store.chatSessions.find((x) => x.chat_type === chatType && x.chat_id === chatId);
    if (s) s.chat_name = name;
    else this.store.chatSessions.push({ chat_type: chatType, chat_id: chatId, chat_name: name, last_time: new Date().toISOString() });
    this.schedulePersist();
  }

  // ===================== 自适应故事线 =====================
  setStoryEnabled(chatType: string, chatId: string, enabled: boolean): void {
    let s = this.store.chatSessions.find((x) => x.chat_type === chatType && x.chat_id === chatId);
    if (!s) { s = { chat_type: chatType, chat_id: chatId, last_time: new Date().toISOString() }; this.store.chatSessions.push(s); }
    s.storyEnabled = enabled;
    this.schedulePersist();
  }
  getStoryEnabled(chatType: string, chatId: string): boolean {
    return this.store.chatSessions.find((x) => x.chat_type === chatType && x.chat_id === chatId)?.storyEnabled === true;
  }
  addStoryNode(chatType: string, chatId: string, msgId: number, title: string): number {
    const node: StoryNode = {
      id: this.nextId(), chat_type: chatType, chat_id: chatId, msg_id: msgId,
      title: title || `节点 ${this.store.storyNodes.length + 1}`, timestamp: new Date().toISOString(),
    };
    this.store.storyNodes.push(node);
    this.schedulePersist();
    return node.id;
  }
  listStoryNodes(chatType: string, chatId: string): StoryNode[] {
    return this.store.storyNodes.filter((n) => n.chat_type === chatType && n.chat_id === chatId).sort((a, b) => a.id - b.id);
  }
  removeStoryNode(id: number): void {
    const before = this.store.storyNodes.length;
    this.store.storyNodes = this.store.storyNodes.filter((n) => n.id !== id);
    if (this.store.storyNodes.length !== before) this.schedulePersist();
  }

  // ===================== 朋友圈 =====================
  addMoment(roleId: string, content: string, images: string[], scheduledAt?: string | null, selfRoleId?: string): number {
    const now = new Date().toISOString();
    const published = !scheduledAt;
    const moment: Moment = {
      id: this.nextId(), roleId, content: content || '', images: images || [],
      created_at: now, scheduledAt: scheduledAt || null, published,
      selfRoleId: selfRoleId || undefined, liked: false, favorited: false,
    };
    this.store.moments.push(moment);
    this.schedulePersist();
    return moment.id;
  }
  listMoments(roleId?: string, includeUnpublished = false, selfRoleId?: string, favoritedOnly = false): Moment[] {
    return this.store.moments
      .filter((m) => (roleId ? m.roleId === roleId : true))
      .filter((m) => (selfRoleId !== undefined ? (m.selfRoleId || '') === selfRoleId : true))
      .filter((m) => m.published || includeUnpublished)
      .filter((m) => (favoritedOnly ? !!m.favorited : true))
      .sort((a, b) => (b.scheduledAt || b.created_at).localeCompare(a.scheduledAt || a.created_at));
  }
  updateMoment(id: number, patch: Partial<Moment>): void {
    const m = this.store.moments.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    this.schedulePersist();
  }
  publishDueMoments(): number {
    const now = Date.now();
    let changed = 0;
    for (const m of this.store.moments) {
      if (!m.published && m.scheduledAt && new Date(m.scheduledAt).getTime() <= now) { m.published = true; changed++; }
    }
    if (changed > 0) this.schedulePersist();
    return changed;
  }
  removeMoment(id: number): void {
    const before = this.store.moments.length;
    this.store.moments = this.store.moments.filter((m) => m.id !== id);
    if (this.store.moments.length !== before) this.schedulePersist();
  }

  // ===================== 关系值 =====================
  adjustBond(roleId: string, delta: number): number {
    const r = this.getRole(roleId);
    if (!r) return 0;
    const next = Math.max(0, (r.bond || 0) + delta);
    r.bond = next;
    r.updated_at = new Date().toISOString();
    this.schedulePersist();
    return next;
  }

  // ===================== 聊天列表 =====================
  getChatList(): {
    chat_type: string; chat_id: string; name: string; avatar_path: string;
    last_message: string; last_time: string;
  }[] {
    const groups: { chat_type: string; chat_id: string; ids: number[] }[] = [];
    for (const m of this.store.messages) {
      let g = groups.find((x) => x.chat_type === m.chat_type && x.chat_id === m.chat_id);
      if (!g) { g = { chat_type: m.chat_type, chat_id: m.chat_id, ids: [] }; groups.push(g); }
      g.ids.push(m.id);
    }
    const result: any[] = [];
    const covered = new Set<string>();
    for (const g of groups) {
      if (g.chat_id.startsWith('obs:')) continue;
      const lastId = Math.max(...g.ids);
      const last = this.store.messages.find((m) => m.id === lastId);
      let name = g.chat_id;
      let avatar = '';
      if (g.chat_type === 'single') {
        const role = this.getRole(this.resolveSingleRoleId(g.chat_type, g.chat_id));
        if (!role) continue;
        name = role.name;
        avatar = role.avatar_path || '';
      } else {
        const grp = this.getGroup(g.chat_id);
        if (!grp) continue;
        name = grp.group_name;
      }
      const gOverride = this.store.chatSessions.find((x) => x.chat_type === g.chat_type && x.chat_id === g.chat_id)?.chat_name;
      if (gOverride) name = gOverride;
      covered.add(`${g.chat_type}:${g.chat_id}`);
      result.push({
        chat_type: g.chat_type, chat_id: g.chat_id, name, chat_name: gOverride, avatar_path: avatar,
        last_message: last?.image_path || (last?.images && last.images.length) ? '[图片]' : last?.content || '',
        last_time: last?.timestamp || '',
      });
    }
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
        chat_type: s.chat_type, chat_id: s.chat_id, name, chat_name: s.chat_name,
        avatar_path: avatar, last_message: '', last_time: s.last_time,
      });
    }
    return result.sort((a, b) => (a.last_time < b.last_time ? 1 : -1));
  }

  getRoleStats(): { roleId: string; roleName: string; tokens: number; messages: number }[] {
    const nameToId: Record<string, string> = {};
    for (const r of this.store.roles) nameToId[r.name] = r.id;
    const stats: Record<string, { roleId: string; roleName: string; tokens: number; messages: number }> = {};
    for (const r of this.store.roles) stats[r.id] = { roleId: r.id, roleName: r.name, tokens: 0, messages: 0 };
    for (const m of this.store.messages) {
      if (m.sender_type === 'user') {
        if (m.chat_type === 'single') {
          const st = stats[m.chat_id];
          if (st) { st.tokens += m.token_used || 0; st.messages += 1; }
        }
      } else if (m.sender_type === 'ai') {
        let rid = stats[m.chat_id] ? m.chat_id : '';
        if (!rid) rid = nameToId[m.sender_name] || '';
        const st = rid ? stats[rid] : undefined;
        if (st) { st.tokens += m.token_used || 0; st.messages += 1; }
      }
    }
    return Object.values(stats).sort((a, b) => b.tokens - a.tokens);
  }

  convertGroupToSingle(groupId: string, roleId: string): void {
    const role = this.getRole(roleId);
    const roleName = role?.name || '';
    this.store.messages = this.store.messages
      .filter((m) => {
        if (m.chat_type !== 'group' || m.chat_id !== groupId) return true;
        if (m.sender_type === 'user') return true;
        if (m.sender_type === 'ai' && m.sender_name === roleName) return true;
        return false;
      })
      .map((m) => (m.chat_type === 'group' && m.chat_id === groupId ? { ...m, chat_type: 'single' as any, chat_id: roleId } : m));
    this.store.groups = this.store.groups.filter((g) => g.group_id !== groupId);
    this.schedulePersist();
  }

  async deleteAllData(): Promise<boolean> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['store', 'images'], 'readwrite');
      tx.objectStore('store').delete(STORE_KEY);
      tx.objectStore('images').clear();
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      this.store = { roles: [], groups: [], messages: [], affinity: [], worldBooks: [], rules: [], memories: [], seq: 0, chatSessions: [], storyNodes: [], moments: [] };
      this.imageCache.clear();
      this.blobMap.clear();
      this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      return true;
    } catch (e) {
      console.error('清空数据失败', e);
      return false;
    }
  }

  private nextId(): number {
    this.store.seq += 1;
    return this.store.seq;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

let _instance: WebDataManager | null = null;
export function getDataManager(): WebDataManager {
  if (!_instance) _instance = new WebDataManager();
  return _instance;
}
