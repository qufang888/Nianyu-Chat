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
  MediaApiConfig,
} from '../src/types';
import { DEFAULT_SETTINGS, TTS_PROVIDERS } from '../src/types';
import {
  listSkills,
  getSkill,
  importSkill,
  deleteSkill,
  setSkillEnabled,
  restoreBuiltinSkill,
  listDismissedBuiltinSkills,
  getSkillsForChat,
  buildSkillsPrompt,
} from './skills';
import type { Skill, SkillImportResult } from '../src/types';

/**
 * 陪伴时长落盘合并窗口（毫秒）。
 * 「前台停留 1s 心跳」若每秒同步写盘会造成明显卡顿（settings 是整份 JSON），
 * 故累加只改内存，落盘按此窗口合并；退出前另有 flushCompanionSync 兜底。
 */
const COMPANION_FLUSH_MS = 30_000;

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
  modelUsage: Record<string, { name: string; tokens: number; calls: number }>; // 聊天模型调用量统计（按 modelId 累计 token 与次数）
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

// ===== 需求 7：TTS / ASR / 生图 / 生视频 多 API 配置的迁移与同步 =====
// 设计要点（务必保持，它是老用户不丢配置的关键）：
//   1. 老版本这四类服务各自只有**一组扁平字段**（ttsBaseUrl/ttsApiKey/...），新版本支持多组；
//   2. 迁移方向：若某服务的数组为空，而扁平字段有内容 → 把扁平字段变成数组的第一项；
//      若数组已有内容（用户真的配了多条）→ **不动**，扁平字段视为兼容产物；
//   3. 同步方向：每次 saveSettings 后，把「当前启用项」回写扁平字段，
//      于是所有仍读扁平字段的老调用点零改动即可拿到当前配置；
//   4. 双向不覆盖：只要用户改过扁平字段（老界面残留），下一次 load 时会补回数组首项。
//     这两条一起保证「新旧界面混用」时期配置永远只有一个真源。

/** 生成一个稳定但不易碰撞的配置 id（读盘不会重新生成，故不参与判重之外的逻辑） */
function newMediaConfigId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 按「数组优先、扁平兜底」原则取某服务的当前启用配置 */
export function resolveMediaConfig(
  list: MediaApiConfig[] | undefined,
  activeId: string | undefined,
  flat: Partial<MediaApiConfig>
): MediaApiConfig | undefined {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > 0) {
    const byId = activeId ? arr.find((c) => c.id === activeId) : undefined;
    return byId || arr[0];
  }
  // 数组为空但扁平字段有内容（老配置尚未迁移，或用户只填了扁平字段）
  const hasFlat = !!(flat.baseUrl || flat.apiKey || flat.model);
  if (!hasFlat) return undefined;
  return {
    id: activeId || `${flat.model ? 'legacy' : 'legacy'}`,
    name: '默认配置',
    provider: flat.provider || 'custom',
    baseUrl: flat.baseUrl || '',
    apiKey: flat.apiKey || '',
    model: flat.model || '',
    enabled: true,
    voice: flat.voice,
    size: flat.size,
    duration: flat.duration,
  };
}

/**
 * 读盘时把扁平字段迁移进多配置数组（原地修改 settings）。
 * 幂等：已迁移过的配置不会重复生成。
 */
export function migrateMediaApiConfigs(settings: AppSettings): void {
  const v = settings.voice;
  if (v) {
    if (!Array.isArray(v.ttsConfigs)) v.ttsConfigs = [];
    if (v.ttsConfigs.length === 0 && (v.ttsBaseUrl || v.ttsApiKey || v.ttsModel || v.ttsVoice)) {
      v.ttsConfigs.push({
        id: v.activeTtsId || newMediaConfigId('tts'),
        name: '默认配置',
        provider: guessProviderByUrl(v.ttsBaseUrl),
        baseUrl: v.ttsBaseUrl || '',
        apiKey: v.ttsApiKey || '',
        model: v.ttsModel || '',
        voice: v.ttsVoice || '',
        enabled: true,
      });
    }
    if (!Array.isArray(v.asrConfigs)) v.asrConfigs = [];
    if (v.asrConfigs.length === 0 && (v.asrBaseUrl || v.asrApiKey || v.asrModel)) {
      v.asrConfigs.push({
        id: v.activeAsrId || newMediaConfigId('asr'),
        name: '默认配置',
        provider: guessProviderByUrl(v.asrBaseUrl),
        baseUrl: v.asrBaseUrl || '',
        apiKey: v.asrApiKey || '',
        model: v.asrModel || '',
        enabled: true,
      });
    }
    // 人物音色绑定：老格式是纯音色名字符串，迁移为带 configId 的对象形式（v 后端本就兼容两种，这里只补齐类型）
  }
  const ig = settings.imageGen;
  if (ig) {
    if (!Array.isArray(ig.imageConfigs)) ig.imageConfigs = [];
    if (ig.imageConfigs.length === 0 && (ig.baseUrl || ig.apiKey || ig.model)) {
      ig.imageConfigs.push({
        id: ig.activeImageId || newMediaConfigId('img'),
        name: '默认配置',
        provider: 'custom',
        baseUrl: ig.baseUrl || '',
        apiKey: ig.apiKey || '',
        model: ig.model || '',
        size: ig.size || '1024x1024',
        enabled: true,
      });
    }
  }
  const vg = settings.videoGen;
  if (vg) {
    if (!Array.isArray(vg.videoConfigs)) vg.videoConfigs = [];
    if (vg.videoConfigs.length === 0 && (vg.baseUrl || vg.apiKey || vg.model)) {
      vg.videoConfigs.push({
        id: vg.activeVideoId || newMediaConfigId('vid'),
        name: '默认配置',
        provider: 'custom',
        baseUrl: vg.baseUrl || '',
        apiKey: vg.apiKey || '',
        model: vg.model || '',
        size: vg.size || '1280x720',
        duration: Number(vg.duration) || 5,
        enabled: true,
      });
    }
  }
}

/** 凭 Base URL 猜一个提供商 id（迁移时给个像样的默认值，用户可在界面改） */
function guessProviderByUrl(baseUrl: string | undefined): string {
  const u = (baseUrl || '').toLowerCase();
  const hit = TTS_PROVIDERS.find((p) => p.match && u.includes(p.match.toLowerCase()));
  return hit ? hit.id : 'openai-compatible';
}

/**
 * 把「当前启用配置」回写到扁平字段（保存后调用）。
 * 这是老调用点（audio:tts / audio:transcribe / image:generate / video:generate）的兼容闸门。
 */
export function syncActiveMediaConfigs(settings: AppSettings): void {
  const v = settings.voice;
  if (!v) return;
  const tts = resolveMediaConfig(v.ttsConfigs, v.activeTtsId, {
    provider: 'openai-compatible',
    baseUrl: v.ttsBaseUrl,
    apiKey: v.ttsApiKey,
    model: v.ttsModel,
    voice: v.ttsVoice,
  });
  if (tts) {
    v.ttsBaseUrl = tts.baseUrl;
    v.ttsApiKey = tts.apiKey;
    v.ttsModel = tts.model;
    if (tts.voice) v.ttsVoice = tts.voice;
    if (!v.activeTtsId && Array.isArray(v.ttsConfigs) && v.ttsConfigs.length) {
      v.activeTtsId = v.ttsConfigs[0].id;
    }
  }
  const asr = resolveMediaConfig(v.asrConfigs, v.activeAsrId, {
    provider: 'custom',
    baseUrl: v.asrBaseUrl,
    apiKey: v.asrApiKey,
    model: v.asrModel,
  });
  if (asr) {
    v.asrBaseUrl = asr.baseUrl;
    v.asrApiKey = asr.apiKey;
    v.asrModel = asr.model;
    if (!v.activeAsrId && Array.isArray(v.asrConfigs) && v.asrConfigs.length) {
      v.activeAsrId = v.asrConfigs[0].id;
    }
  }
  const ig = settings.imageGen;
  if (ig) {
    const img = resolveMediaConfig(ig.imageConfigs, ig.activeImageId, {
      provider: 'custom',
      baseUrl: ig.baseUrl,
      apiKey: ig.apiKey,
      model: ig.model,
      size: ig.size,
    });
    if (img) {
      ig.baseUrl = img.baseUrl;
      ig.apiKey = img.apiKey;
      ig.model = img.model;
      if (img.size) ig.size = img.size;
      if (!ig.activeImageId && Array.isArray(ig.imageConfigs) && ig.imageConfigs.length) {
        ig.activeImageId = ig.imageConfigs[0].id;
      }
    }
  }
  const vg = settings.videoGen;
  if (vg) {
    const vid = resolveMediaConfig(vg.videoConfigs, vg.activeVideoId, {
      provider: 'custom',
      baseUrl: vg.baseUrl,
      apiKey: vg.apiKey,
      model: vg.model,
      size: vg.size,
      duration: Number(vg.duration),
    });
    if (vid) {
      vg.baseUrl = vid.baseUrl;
      vg.apiKey = vid.apiKey;
      vg.model = vid.model;
      if (vid.size) vg.size = vid.size;
      if (vid.duration) vg.duration = String(vid.duration);
      if (!vg.activeVideoId && Array.isArray(vg.videoConfigs) && vg.videoConfigs.length) {
        vg.activeVideoId = vg.videoConfigs[0].id;
      }
    }
  }
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
    // v2.3.90：回收孤儿剧情节点（msg_id 指向已不存在的消息）。
    // 幂等：只在真有孤儿时写盘；重复启动不会再删任何东西。
    this.cleanupOrphanStoryNodes();
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
          modelUsage: raw.modelUsage || {},
        };
      }
    } catch (e) {
      console.error('读取存储失败', e);
    }
    return { roles: [], groups: [], messages: [], affinity: [], worldBooks: [], rules: [], memories: [], seq: 0, chatSessions: [], storyNodes: [], moments: [], plugins: [], modelUsage: {} };
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

  // ===================== 技能（Skill）=====================
  // 刻意**不进 store.json**：技能数据落在独立文件 skills.json（见 electron/skills.ts）。
  // 理由：store.json 是聊天主数据（消息/角色/记忆），技能属于可随时整体删除的外挂资产，
  // 物理隔离可避免技能解析异常污染聊天存档，也便于单独备份/回滚。
  // DataManager 只做薄门面，真实逻辑与解析规则集中在 skills.ts（便于独立实测）。

  /** 列出全部技能（导入时间倒序） */
  listSkills(): Skill[] {
    return listSkills();
  }

  /** 取单个技能 */
  getSkill(id: string): Skill | undefined {
    return getSkill(id);
  }

  /** 解析并导入一段 SKILL.md 文本（content 来自用户对话框选中的文件，不接受任意路径） */
  importSkill(content: string, fileName: string): SkillImportResult {
    return importSkill(content, fileName);
  }

  /** 删除技能，返回是否命中 */
  deleteSkill(id: string): boolean {
    return deleteSkill(id);
  }

  /** 启停技能，返回是否命中 */
  setSkillEnabled(id: string, enabled: boolean): boolean {
    return setSkillEnabled(id, enabled);
  }

  /**
   * 恢复内置技能为随念语附带的版本（v2.3.93）。
   * 记录仍在 → 覆盖正文但保留用户的启停状态；记录已被删除 → 重新种入。
   */
  restoreBuiltinSkill(id: string): Skill | undefined {
    return restoreBuiltinSkill(id);
  }

  /** 已被用户删除、但仍可一键恢复的内置技能（设置页恢复入口用） */
  listDismissedBuiltinSkills(): { id: string; name: string; description: string }[] {
    return listDismissedBuiltinSkills();
  }

  /**
   * 某场对话实际生效的技能：global ∪ (role 且 roleId 匹配) ∪ (chat 且 chatKey 匹配)。
   * 单聊传 resolveSingleRoleId 后的角色 id；群聊传正在发言的角色 id（可为空）。
   */
  getSkillsForChat(chatType: string, chatId: string, roleId = ''): Skill[] {
    return getSkillsForChat(chatType, chatId, roleId);
  }

  /** 构造注入给 AI 的「可用技能」段；无技能时返回空串（调用方整段跳过） */
  buildSkillsPrompt(chatType: string, chatId: string, roleId = ''): string {
    return buildSkillsPrompt(this.getSkillsForChat(chatType, chatId, roleId));
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

  // 该聊天参与角色的 id 集合（单聊=角色本身（chatId 即 roleId）；群聊=群成员角色）
  private chatRoleIds(chatType: string, chatId: string): string[] {
    if (chatType === 'single') return [chatId];
    const g = this.store.groups.find((x) => x.group_id === chatId);
    if (!g) return [];
    return g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // 删除「该时间点之后」的未关联消息的记忆（纯手写快捷记忆/面板记忆等）：
  // 范围 = 该聊天角色的对话记忆（chatId 匹配）+ 角色级共享记忆（无 chatId）；
  // 不区分 source（手动/自动都删）、不管是否被人工修改过——以创建时间为准。
  deleteMemoriesSince(chatType: string, chatId: string, sinceTs: number): number {
    const roles = new Set(this.chatRoleIds(chatType, chatId));
    if (roles.size === 0) return 0;
    const before = this.store.memories.length;
    this.store.memories = this.store.memories.filter((m) => {
      if (!roles.has(m.roleId)) return true;
      const t = Date.parse(m.created_at || '');
      if (!(Number.isFinite(t) && t >= sinceTs)) return true;
      // 有 chatId 的对话记忆必须属于本聊天；无 chatId 的角色级共享记忆无法区分产生聊天，一并删除
      if (m.chatId && m.chatId !== chatId) return true;
      return false;
    });
    return before - this.store.memories.length;
  }

  // 删除「该时间点之后」该聊天角色的朋友圈动态（不论点赞/收藏/定时未发布）
  deleteMomentsSince(chatType: string, chatId: string, sinceTs: number): number {
    const roles = new Set(this.chatRoleIds(chatType, chatId));
    if (roles.size === 0) return 0;
    const before = this.store.moments.length;
    this.store.moments = this.store.moments.filter((m) => {
      if (!roles.has(m.roleId)) return true;
      const t = Date.parse(m.created_at || '');
      return !(Number.isFinite(t) && t >= sinceTs);
    });
    return before - this.store.moments.length;
  }

  // 回滚：删除 id >= msgId 的所有消息、其关联记忆（无论手动/自动/人工修改过），
  // 以及「该时间点之后」该聊天角色的全部记忆（含纯手写未关联的）与朋友圈动态（不论点赞收藏）
  rollbackMessages(
    chatType: string,
    chatId: string,
    fromMsgId: number,
    withStoryNodes = false
  ): { deletedMsgs: number; deletedMems: number; deletedMoments: number; deletedNodes: number } {
    const target = this.store.messages.filter(
      (m) => m.chat_type === chatType && m.chat_id === chatId && m.id >= fromMsgId
    );
    const ids = new Set(target.map((m) => m.id));
    // 时间锚点：被回滚消息中最早的时间戳（即回滚起点消息的时刻）
    const tsList = target.map((m) => Date.parse(m.timestamp)).filter((t) => Number.isFinite(t));
    const fromTs = tsList.length ? Math.min(...tsList) : 0;
    this.store.messages = this.store.messages.filter((m) => !ids.has(m.id));
    let deletedMems = 0;
    for (const id of ids) {
      deletedMems += this.deleteMemoriesByMsgId(id);
    }
    if (fromTs > 0) {
      deletedMems += this.deleteMemoriesSince(chatType, chatId, fromTs);
    }
    const deletedMoments = fromTs > 0 ? this.deleteMomentsSince(chatType, chatId, fromTs) : 0;
    // 剧情节点：v2.3.63 起「修改重发」场景需要；v2.3.79 起普通回滚也需要（withStoryNodes=true）。
    // v2.3.80 修正：msg_id 精确删除**不依赖时间戳**（节点 timestamp 是「创建时刻」，
    // 且历史数据可能存在无法解析的时间戳），故不能被 `fromTs > 0` 一起短路掉——
    // 否则消息时间戳全不可解析时，msg_id 明明能命中的节点也删不掉。
    // 时间戳路径仅在 fromTs 有效时作为补充，且**只清理未关联节点**（见 deleteStoryNodesSince）。
    const deletedNodes = withStoryNodes
      ? this.deleteStoryNodesByMsgIds(chatType, chatId, ids) + (fromTs > 0 ? this.deleteStoryNodesSince(chatType, chatId, fromTs) : 0)
      : 0;
    this.saveStore();
    return { deletedMsgs: ids.size, deletedMems, deletedMoments, deletedNodes };
  }

  // 仅删除该条消息，**不动**记忆 / 朋友圈动态 / 剧情节点（v2.3.63「删除消息」语义）
  // 与 deleteMessage 的区别：后者会连带 deleteMemoriesByMsgId 删掉该消息关联的记忆
  deleteMessageOnly(msgId: number): { ok: boolean } {
    const idx = this.store.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return { ok: false };
    this.store.messages.splice(idx, 1);
    this.saveStore();
    return { ok: true };
  }

  // 按消息 id 精确删除剧情节点（v2.3.80，**回滚节点残留的主修复路径**）
  // 为什么必须走 msg_id：节点 timestamp 取的是「节点创建时刻」（addStoryNode 里的 new Date()），
  // 与消息 timestamp 并不相等 —— 纯时间戳过滤无法可靠命中被回滚消息自带的那个节点。
  // msg_id 是节点与消息的唯一确定关联，无歧义。
  // ⚠️ 必须同时按 chat_type/chat_id 过滤：消息 id 是**全局自增**的（nextId），
  // 不同聊天的 id 空间不隔离。若不过滤，回滚 A 聊天的消息会误删 B 聊天里同 id 的节点。
  deleteStoryNodesByMsgIds(chatType: string, chatId: string, msgIds: Set<number> | number[]): number {
    const set = msgIds instanceof Set ? msgIds : new Set(msgIds);
    if (set.size === 0) return 0;
    const before = this.store.storyNodes.length;
    this.store.storyNodes = this.store.storyNodes.filter((n) => {
      if (n.chat_type !== chatType || n.chat_id !== chatId) return true; // 其他聊天/群聊的节点保留
      // msg_id 缺失（历史脏数据）→ 保守保留，宁可漏删不误删
      if (n.msg_id == null) return true;
      return !set.has(n.msg_id);
    });
    const removed = before - this.store.storyNodes.length;
    if (removed > 0) this.saveStore();
    return removed;
  }

  // 按聊天删除**全部**剧情节点（v2.3.90：清空消息时的连带清理）
  // 为什么需要：clearChatMessages / deleteChat 删掉消息后，节点会残留成「孤儿」——
  // msg_id 指向一条已不存在的消息。这种孤儿早于任何回滚锚点，回滚永远回收不掉，
  // 节点面板里也点不开（源消息没了）。
  deleteStoryNodesByChat(chatType: string, chatId: string): number {
    const before = this.store.storyNodes.length;
    this.store.storyNodes = this.store.storyNodes.filter(
      (n) => !(n.chat_type === chatType && n.chat_id === chatId)
    );
    const removed = before - this.store.storyNodes.length;
    if (removed > 0) this.saveStore();
    return removed;
  }

  // 删除「该时间点之后」的剧情节点（v2.3.63，供「修改重发 / 回滚」联动清理）
  //
  // ⚠️ v2.3.90 语义收窄（BUG 修复）：**只删除「未关联消息」（msg_id == null）的近期节点**。
  // 原因：节点 timestamp 取的是「标记时刻」（addStoryNode 里的 new Date()），与消息 timestamp
  // 无关。用户可以很久以后才回头标记一条**旧消息**（back-fill），此时节点 timestamp 远晚于
  // 消息时间。若按时间戳无差别删除，回滚到该消息时间点之前就会把「消息仍然存活、但节点被删掉」
  // 的节点误删——真实数据已出现过这种风险（节点标记时间比消息晚 12 天）。
  // 已关联（msg_id != null）的节点一律交给精确路径 deleteStoryNodesByMsgIds 处理：
  // 审计已证明该路径覆盖全部「消息确实被回滚」的情形，且不会误删存活消息的节点。
  // 保守策略依然保留：时间戳无法解析（NaN）的节点一律保留，宁可漏删也不误删。
  // v2.3.80 的边界修正（保留 `t < sinceTs`）依然成立，只是现在只作用于未关联节点。
  deleteStoryNodesSince(chatType: string, chatId: string, sinceTs: number): number {
    if (!(sinceTs > 0)) return 0;
    const before = this.store.storyNodes.length;
    this.store.storyNodes = this.store.storyNodes.filter((n) => {
      if (n.chat_type !== chatType || n.chat_id !== chatId) return true; // 其他聊天/群聊的节点保留
      // 已关联消息的节点 → 时间戳路径不碰（由 deleteStoryNodesByMsgIds 精确处理）
      if (n.msg_id != null) return true;
      const t = Date.parse(n.timestamp);
      if (!Number.isFinite(t)) return true; // 时间戳不可解析 → 保守保留
      // 保留「严格早于起点」的未关联节点 → 等价于删除 t >= sinceTs
      return t < sinceTs;
    });
    const removed = before - this.store.storyNodes.length;
    if (removed > 0) this.saveStore();
    return removed;
  }

  /**
   * 一次性数据迁移（v2.3.90）：回收「孤儿剧情节点」。
   *
   * 孤儿定义：节点 msg_id != null，但同一 chat_type + chat_id 下**不存在**该 id 的消息。
   * 成因：历史版本的 clearChatMessages / deleteChat 只删消息不删节点。
   * 这些节点回滚永远回收不掉（它们早于任何回滚锚点），会一直挂在节点面板上。
   *
   * 安全性：
   *  - **保留** msg_id == null 的节点：无法判定其关联，永不删除（宁可漏删不误删）。
   *  - **保留** 消息确实存在的节点。
   *  - 幂等：第二次运行没有任何节点可删（removed === 0 → 不写盘）。
   *  - 逐条按 id + chat 联合判定，不受「消息 id 全局自增、跨聊天不隔离」影响。
   */
  private cleanupOrphanStoryNodes(): void {
    const nodes = this.store.storyNodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    const before = nodes.length;
    const isAlive = (n: { chat_type: string; chat_id: string; msg_id: number | null }): boolean =>
      this.store.messages.some(
        (m) => m.id === n.msg_id && m.chat_type === n.chat_type && m.chat_id === n.chat_id
      );
    this.store.storyNodes = nodes.filter((n) => (n.msg_id == null ? true : isAlive(n)));
    const removed = before - this.store.storyNodes.length;
    if (removed > 0) {
      console.log(`[迁移] 回收孤儿剧情节点 ${removed} 个`);
      this.saveStore();
    }
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
  // v2.3.90：同时删除该聊天的全部剧情节点（同 clearChatMessages，避免孤儿节点）
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
    this.deleteStoryNodesByChat(chatType, chatId);
    this.store.chatSessions = this.store.chatSessions.filter(
      (s) => !(s.chat_type === chatType && s.chat_id === chatId)
    );
    this.saveStore();
  }

  // 清空当前聊天消息；withMemories=true 时一并删除该聊天内产生的自动记忆（手动记忆保留）
  // v2.3.90：**同时删除该聊天的全部剧情节点**。此前只删消息不删节点，会留下 msg_id
  // 指向已删除消息的孤儿节点（回滚也回收不掉，因为它们早于任何回滚锚点）。
  clearChatMessages(chatType: string, chatId: string, withMemories: boolean): { deletedMsgs: number; deletedMems: number; deletedNodes: number } {
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
    // v2.3.90：连带清理该聊天的剧情节点，避免产生孤儿节点
    const deletedNodes = this.deleteStoryNodesByChat(chatType, chatId);
    this.saveStore();
    return { deletedMsgs: ids.size, deletedMems, deletedNodes };
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
          // 模型分组：老配置无此字段时回落空数组；脏数据（非数组）同样兜底
          modelGroups: Array.isArray(raw.modelGroups)
            ? raw.modelGroups.filter((g: any) => g && typeof g.id === 'string' && typeof g.name === 'string')
            : [],
          voice: { ...DEFAULT_SETTINGS.voice, ...(raw.voice || {}) },
          miniWindow: { ...DEFAULT_SETTINGS.miniWindow, ...(raw.miniWindow || {}) },
          imageGen: { ...DEFAULT_SETTINGS.imageGen, ...(raw.imageGen || {}) },
        };
        // 清理遗留的默认 GPT-4o mini 种子模型
        merged.models = merged.models.filter(
          (m) => !(m.id === 'default' && m.model === 'gpt-4o-mini')
        );
        // 清理指向已删除分组的孤儿引用，并把非数组的 tags/groupIds 兜底为空数组
        const groupIds = new Set(merged.modelGroups.map((g) => g.id));
        merged.models = merged.models.map((m) => ({
          ...m,
          // v2.3.44：已移除「自定义」提供商；老配置统一迁移为「OpenAI 兼容」（同一套协议，仅标签/默认值不同）
          provider: ((m.provider as string) === 'custom' ? 'openai-compatible' : m.provider) || 'openai-compatible',
          groupIds: (Array.isArray(m.groupIds) ? m.groupIds : []).filter((id: string) => groupIds.has(id)),
          tags: Array.isArray(m.tags) ? m.tags.filter((x: any) => typeof x === 'string') : [],
        }));
        // 老用户（已存在 settings.json 但无 firstRunDone 字段）视为已完成首启，不再弹出向导
        if (raw.firstRunDone === undefined) merged.firstRunDone = true;
        // v2.3.92：动画控制由「总控/单控」二元改为「全开/全关/自定义」三档。
        // 老配置没有 animMode 字段，按旧语义单向映射（不覆盖已存在的合法 animMode）：
        //   animControlMode==='single'（当年拨过分项开关）→ 'custom'：保留用户逐项调过的结果；
        //   否则 enableAnimations===false              → 'all-off'；
        //   其余（含老配置 enableAnimations=true）    → 'all-on'。
        // 只在读盘时补齐，不主动回写 settings.json（避免老用户文件被无谓改动）。
        if (raw.animMode !== 'all-on' && raw.animMode !== 'all-off' && raw.animMode !== 'custom') {
          merged.animMode =
            raw.animControlMode === 'single'
              ? 'custom'
              : raw.enableAnimations === false
                ? 'all-off'
                : 'all-on';
        }
        // 需求 7：多 API 配置迁移（TTS/ASR/生图/生视频）
        migrateMediaApiConfigs(merged);
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
    // 需求 7：保存后立刻把「当前启用配置」回写到扁平兼容字段，
    // 这样所有仍读扁平字段的老调用点（audio:tts / image:generate / video:generate 等）
    // 无需改动就能拿到当前配置，改造范围与回归风险都显著降低。
    syncActiveMediaConfigs(this.settings);
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    return this.settings;
  }

  // ---------- 陪伴时长累计（v2.3.94 需求 11）----------
  //
  // 为什么要放在**主进程**做累加（而不是渲染进程各自读改写 settings.companionMs）：
  //   主窗与小窗是两个独立 BrowserWindow，同一个 key（"chatType:chatId"）可能同时在两边计时。
  //   若渲染进程各自「读出整份 companionMs → 加一秒 → 写回」，两边互相覆盖会**丢秒**；
  //   而 settings 是整份 JSON 文件，两个窗口并发写还会互相撕裂。
  //   故 IPC 传的是**增量**（deltaMs），主进程这里是唯一的累加点：只做 `+=`，天然幂等且不丢秒。
  //
  // 写盘节流：累加只改内存（this.settings），落盘由 scheduleCompanionFlush() 合并为
  // 每 COMPANION_FLUSH_MS（默认 30s）至多一次，外加 flushCompanionSync() 在退出前兜底。
  // 这样「每秒心跳」不会变成「每秒同步写盘」（会造成明显卡顿，见需求硬性约束②）。
  private companionFlushTimer: NodeJS.Timeout | null = null;

  /** 累计某个会话的陪伴时长（毫秒）。deltaMs ≤ 0 直接忽略。返回累计后的总时长。 */
  addCompanionMs(key: string, deltaMs: number): number {
    if (!key || !Number.isFinite(deltaMs) || deltaMs <= 0) return this.getCompanionMs(key);
    const table = { ...(this.settings.companionMs || {}) };
    const next = Math.max(0, Math.round(table[key] || 0) + Math.round(deltaMs));
    table[key] = next;
    this.settings.companionMs = table;
    this.scheduleCompanionFlush();
    return next;
  }

  /** 取某个会话已累计的陪伴时长（毫秒）。 */
  getCompanionMs(key: string): number {
    const v = (this.settings.companionMs || {})[key];
    return Number.isFinite(v) && (v as number) > 0 ? Math.round(v as number) : 0;
  }

  /** 合并写盘：30s 内多次累加只落盘一次（退出前由 flushCompanionSync 强制落盘）。 */
  private scheduleCompanionFlush(): void {
    if (this.companionFlushTimer) return;
    this.companionFlushTimer = setTimeout(() => {
      this.companionFlushTimer = null;
      this.flushCompanionSync();
    }, COMPANION_FLUSH_MS);
    // 定时器不应阻止进程退出（退出前另有 flushCompanionSync 兜底落盘）
    if (typeof this.companionFlushTimer.unref === 'function') this.companionFlushTimer.unref();
  }

  /**
   * 立即把陪伴时长落盘（退出前调用）。不抛异常：写盘失败不应阻断退出流程。
   * 刻意**不**走 saveSettings（它会把整份 patch 语义化合并并触发广播），此处只写文件。
   */
  flushCompanionSync(): void {
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch (e) {
      console.error('陪伴时长落盘失败', e);
    }
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
      // 分组与模型的 tags/groupIds 归属属于模型配置的一部分，随模型一并保留
      fresh.modelGroups = this.settings.modelGroups || [];
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

  // 重命名剧情节点（v2.3.37）：非破坏式，仅改 title
  renameStoryNode(id: number, title: string): void {
    const t = (title || '').trim();
    if (!t) return;
    const n = this.store.storyNodes.find((x) => x.id === id);
    if (n) {
      n.title = t;
      this.saveStore();
    }
  }

  /**
   * 从剧情节点处分叉新聊天（v2.3.37）：原聊天不动，新聊天包含「节点消息及之前」的消息，
   * 记忆按口径截取——自动记忆（sourceMsgIds 全部指向节点前消息）保留；
   * 手动/无关联记忆按 created_at ≤ 节点消息 timestamp 保留。
   * 群聊复制整组成员；单聊绑定原角色（不复制角色卡）。per-chat 设置复制式带到新聊（不影响原聊）。
   *
   * v2.3.94 需求 1：新增可选参数 customTitle —— 「从消息分叉」时用它替代节点标题作为新聊天名后缀。
   * 这样两条路径共用同一份复制/记忆截取逻辑，只在命名上分叉，避免重复实现同一套语义。
   */
  forkChatFromNode(chatType: string, chatId: string, msgId: number, customTitle?: string): { chat_type: string; chat_id: string; name: string } {
    const now = new Date().toISOString();
    const all = this.store.messages.filter((m) => m.chat_type === chatType && m.chat_id === chatId);
    const idx = all.findIndex((m) => m.id === msgId);
    if (idx < 0) throw new Error('node message not found');
    const before = all.slice(0, idx + 1); // 含节点消息本身
    const beforeIds = new Set(before.map((m) => m.id));
    const nodeMsg = before[before.length - 1];
    const nodeTitle = customTitle?.trim()
      || this.store.storyNodes.find((n) => n.msg_id === msgId && n.chat_type === chatType && n.chat_id === chatId)?.title
      || '节点';

    // 记忆截取口径：sourceMsgIds 非空 → 关联消息全部在节点前才保留；否则按 created_at ≤ 节点消息时间
    const memKeep = (m: (typeof this.store.memories)[number]): boolean => {
      if (m.sourceMsgIds && m.sourceMsgIds.length) return m.sourceMsgIds.every((id) => beforeIds.has(id));
      if (m.sourceMsgId != null) return beforeIds.has(m.sourceMsgId);
      return (m.created_at || '') <= nodeMsg.timestamp;
    };

    const srcSession = this.store.chatSessions.find(
      (x) => x.chat_type === chatType && x.chat_id === chatId
    );

    if (chatType === 'group') {
      const g = this.getGroup(chatId);
      if (!g) throw new Error('group not found');
      const newId = this.genId('group');
      const newName = `${g.group_name} · ${nodeTitle.slice(0, 12)}`;
      this.store.groups.push({ ...g, group_id: newId, group_name: newName, created_at: now });
      for (const m of before) {
        this.store.messages.push({ ...m, id: this.nextId(), chat_id: newId });
      }
      for (const m of this.store.memories.filter((mm) => mm.chatId === chatId && memKeep(mm))) {
        this.store.memories.push({ ...m, id: this.genId('mem'), chatId: newId, created_at: now, updated_at: now });
      }
      // per-chat 设置：复制式带到新聊（不影响原聊）
      this.copyChatSettings(`group:${chatId}`, `group:${newId}`);
      this.store.chatSessions.push({ chat_type: 'group', chat_id: newId, last_time: now, storyEnabled: true });
      this.saveStore();
      return { chat_type: 'group', chat_id: newId, name: newName };
    }

    // single：绑定原角色（不复制角色卡，语义为「回到该节点重新开始」）
    const roleId = this.resolveSingleRoleId('single', chatId);
    const newId = `single_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const baseName = srcSession?.chat_name || this.getRole(roleId)?.name || roleId;
    const newName = `${baseName} · ${nodeTitle.slice(0, 12)}`;
    for (const m of before) {
      this.store.messages.push({ ...m, id: this.nextId(), chat_id: newId });
    }
    for (const m of this.store.memories.filter((mm) => mm.roleId === roleId && mm.chatId === chatId && memKeep(mm))) {
      this.store.memories.push({ ...m, id: this.genId('mem'), roleId, chatId: newId, created_at: now, updated_at: now });
    }
    this.copyChatSettings(`single:${chatId}`, `single:${newId}`);
    this.store.chatSessions.push({
      chat_type: 'single',
      chat_id: newId,
      role_id: roleId,
      chat_name: newName,
      last_time: now,
      storyEnabled: true,
    });
    this.saveStore();
    return { chat_type: 'single', chat_id: newId, name: newName };
  }

  /**
   * 从任意消息分叉出新对话（v2.3.94 需求 1）：右键消息气泡 →「从此处开启新对话」。
   *
   * 与 forkChatFromNode 的差别**只有命名**：节点版用节点标题，这里改用消息正文摘要。
   * 复制「该消息及之前的消息」+ 按同一口径截取记忆 + 单聊绑定原角色 + per-chat 设置带走，
   * 全部复用 forkChatFromNode（只多传一个 customTitle），不重复实现同一套语义。
   *
   * 记忆隔离：新聊天是独立 chatId，配合角色级 memoryIsolation（默认开启）即为独立时间线；
   * 主进程侧还会顺手把新聊天的长记忆开关打开，避免用户分叉后还得手动去开。
   */
  forkChatFromMessage(chatType: string, chatId: string, msgId: number): { chat_type: string; chat_id: string; name: string } {
    const m = this.store.messages.find((x) => x.id === msgId && x.chat_type === chatType && x.chat_id === chatId);
    if (!m) throw new Error('message not found');
    // 摘要：取正文首个非空行 → 压掉换行与多余空白 → 截断 12 字（与节点版后缀长度一致）
    const firstLine = (m.content || '').split('\n').map((s) => s.trim()).find((s) => s.length > 0) || '新对话';
    const snippet = firstLine.replace(/\s+/g, ' ').slice(0, 12);
    return this.forkChatFromNode(chatType, chatId, msgId, `分支·${snippet}`);
  }

  // per-chat 设置：复制式重映射（与 remapChatSettings 的「移动」语义不同，源聊 key 保留）
  private copyChatSettings(srcKey: string, newKey: string): void {
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
      }
    }
    this.saveSettings({});
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

  /**
   * 按角色聚合陪伴时长（毫秒）—— 统计页板块二/板块三用。
   *
   * 口径说明（写在代码里以免日后被改错）：
   *   - `single:<chatId>`：用 {@link resolveSingleRoleId} 解出真实 roleId 后全额记到该人物名下
   *     （单聊天然只属于一个人，含「复制出的单聊」—— 那种 chat_id 与 roleId 解绑，靠 session.role_id 找回）；
   *   - `obs:<roleId>`：观察者私密小窗，全额记到该人物；
   *   - `group:<groupId>`：群聊是多人共享的陪伴，**按成员数均摊**到当前成员名下
   *     （均摊而非全额重复计入，是为了「所有人陪伴时长之和 ≈ 用户实际投入的总陪伴时间」，
   *     否则群聊会被重复计入每个人而虚高）；
   *   - 认不出归属的 key 直接跳过（不猜）。
   */
  getCompanionMsByRole(): Record<string, number> {
    const table = this.settings.companionMs || {};
    const out: Record<string, number> = {};
    for (const [key, rawMs] of Object.entries(table)) {
      const ms = Number(rawMs);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const chatType = key.slice(0, sep);
      const chatId = key.slice(sep + 1);
      if (!chatId) continue;

      if (chatType === 'single' || chatType === 'obs') {
        const roleId = this.resolveSingleRoleId('single', chatId);
        if (!roleId) continue;
        out[roleId] = (out[roleId] || 0) + ms;
        continue;
      }
      if (chatType === 'group') {
        const g = this.getGroup(chatId);
        const members = (g?.member_ids || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (members.length === 0) continue;
        const each = ms / members.length;
        for (const rid of members) out[rid] = (out[rid] || 0) + each;
      }
    }
    for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
    return out;
  }

  // 记录一次聊天模型调用（token 与次数累计）。modelId 为空则忽略。
  recordModelUsage(modelId: string, name: string, promptTokens: number, completionTokens: number): void {
    if (!modelId) return;
    if (!this.store.modelUsage) this.store.modelUsage = {};
    const e = this.store.modelUsage[modelId] || { name, tokens: 0, calls: 0 };
    if (name) e.name = name;
    e.tokens += (promptTokens || 0) + (completionTokens || 0);
    e.calls += 1;
    this.store.modelUsage[modelId] = e;
    this.saveStore();
  }

  // 聊天模型调用量排名：按 token 从高到低；仅包含当前「已启用」的模型（模型被更换/删除则退出排名）。
  getModelStats(): { modelId: string; name: string; tokens: number; calls: number }[] {
    const usage = this.store.modelUsage || {};
    const enabled = new Set((this.settings.models || []).filter((m) => m.enabled).map((m) => m.id));
    return Object.entries(usage)
      .filter(([id]) => enabled.has(id))
      .map(([id, e]) => ({ modelId: id, name: e.name, tokens: e.tokens, calls: e.calls }))
      .sort((a, b) => b.tokens - a.tokens);
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
