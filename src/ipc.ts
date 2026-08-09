import type {
  Role,
  ChatMessage,
  Group,
  AffinityLogEntry,
  AppSettings,
  ChatListItem,
  SendMessageResult,
  ModelConfig,
  RoleStat,
  WorldBook,
  Rule,
  MemoryEntry,
} from './types';
import type { ImportCharacterResult } from './utils/characterCard';
export type { ImportCharacterResult };

export interface NianyuAPI {
  getRoles: () => Promise<Role[]>;
  getRole: (id: string) => Promise<Role | undefined>;
  saveRole: (role: Role) => Promise<void>;
  deleteRole: (id: string) => Promise<void>;
  aiCompleteRole: (basic: Record<string, string>, modelId?: string) => Promise<string>;

  getChatList: () => Promise<ChatListItem[]>;
  getMessages: (type: string, id: string) => Promise<ChatMessage[]>;
  sendMessage: (p: {
    chatType: string;
    chatId: string;
    content: string;
    imagePath?: string | null;
  }) => Promise<SendMessageResult>;
  sendUserMessage: (p: {
    chatType: string;
    chatId: string;
    content: string;
    imagePath?: string | null;
    imagePaths?: string[];
  }) => Promise<ChatMessage>;
  sendAIMessages: (p: {
    chatType: string;
    chatId: string;
    content: string;
    imagePath?: string | null;
    imagePaths?: string[];
  }) => Promise<Omit<SendMessageResult, 'userMessage'>>;
  startStream: (p: {
    chatType: string;
    chatId: string;
    content: string;
    imagePath?: string | null;
    imagePaths?: string[];
  }) => Promise<{ userMessage: ChatMessage; members: { streamId: string; roleId: string; roleName: string }[] }>;
  // 请求限速（QPS）状态查询
  rateInfo: (modelId: string) => Promise<{ enabled: boolean; limit: number; waitMs: number }>;
  // 当前聊天参与限速的代表模型 id（单聊=角色模型；群聊=默认模型）
  getChatModelId: (chatType: string, chatId: string) => Promise<string>;
  // 翻译文本（右键菜单翻译）
  translate: (text: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  // 打断生成：中止某聊天当前流式输出（已生成内容保留）
  interruptStream: (chatId: string) => Promise<{ ok: boolean }>;
  groupContinue: (p: {
    chatId: string;
  }) => Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }>;
  // ===== 空闲主动回复 =====
  proactive: (p: {
    chatType: string;
    chatId: string;
  }) => Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }>;
  // ===== 随机事件 =====
  randomEvent: (p: { chatType: string; chatId: string; theme?: string; window?: string }) => Promise<
    | { busy: true; window?: string }
    | {
        roleId: string;
        roleName: string;
        event: string;
        options: { text: string; affinity: number; mood: string }[];
      }
  >;
  chooseEvent: (p: {
    chatType: string;
    chatId: string;
    roleId: string;
    change: number;
    choiceText: string;
    eventText: string;
    mood?: string;
  }) => Promise<{ roleId: string; roleName: string; total: number; change: number; mood: string }>;

  // ===== 观察者模式（对局） =====
  observerSetMode: (p: {
    groupId: string;
    on: boolean;
    applyPreset?: boolean;
  }) => Promise<{ ok: boolean; archivePath?: string }>;
  observerSetConfig: (p: {
    groupId: string;
    patch: {
      freezeMemory?: boolean;
      observerNoEmotion?: boolean;
      privateWriteMemory?: boolean;
      privateAffectsEmotion?: boolean;
    };
  }) => Promise<{ ok: boolean }>;
  onGroupObserver: (cb: (e: any, data: { groupId: string; observerMode: boolean; config?: any }) => void) => () => void;
  offGroupObserver: (cb: (e: any, data: any) => void) => void;

  // 消息操作
  recallMessage: (msgId: number) => Promise<{ ok: boolean; deletedMems: number }>;
  rollbackMessages: (p: { chatType: string; chatId: string; fromMsgId: number }) => Promise<{ deletedMsgs: number; deletedMems: number }>;
  // 快捷记忆（选中文本一键存入）
  addQuickMemory: (p: { roleId: string; content: string }) => Promise<any>;

  onSettingsChanged: (cb: (e: any, data: any) => void) => () => void;
  offSettingsChanged: (cb: (e: any, data: any) => void) => void;

  onStreamChunk: (cb: (e: any, data: any) => void) => () => void;
  offStreamChunk: (cb: (e: any, data: any) => void) => void;
  onStreamStart: (cb: (e: any, data: any) => void) => () => void;
  offStreamStart: (cb: (e: any, data: any) => void) => void;
  onStreamDone: (cb: (e: any, data: any) => void) => () => void;
  offStreamDone: (cb: (e: any, data: any) => void) => void;
  onStreamUser: (cb: (e: any, data: any) => void) => () => void;
  offStreamUser: (cb: (e: any, data: any) => void) => void;
  onEventChosen: (cb: (e: any, data: any) => void) => () => void;
  offEventChosen: (cb: (e: any, data: any) => void) => void;
  sendIdleActivity: (chatKey: string) => void;
  idleGet: (chatKey: string) => Promise<number | null>;
  idleSet: (chatKey: string, ts: number) => void;
  onIdleActivity: (cb: (e: any, data: any) => void) => () => void;
  offIdleActivity: (cb: (e: any, data: any) => void) => void;
  onIdleTick: (cb: (e: any, data: Record<string, number>) => void) => () => void;
  onRoleMood: (cb: (e: any, data: any) => void) => () => void;
  offRoleMood: (cb: (e: any, data: any) => void) => void;
  // 关系值（bond）变更广播：一端调整，主窗/小窗同步刷新展示
  onRoleBond: (cb: (e: any, data: { roleId: string }) => void) => () => void;
  offRoleBond: (cb: (e: any, data: any) => void) => void;
  // 朋友圈变更广播：AI 自动发动态或手动增删后，通知所有窗口刷新朋友圈列表
  onMomentsChanged: (cb: (e: any, data: { roleId: string; selfRoleId: string }) => void) => () => void;
  offMomentsChanged: (cb: (e: any, data: any) => void) => void;
  onMomentsAutoPosted: (cb: (e: any, data: { roleId: string; selfRoleId: string; roleName: string; count: number }) => void) => () => void;
  offMomentsAutoPosted: (cb: (e: any, data: any) => void) => void;
  // 故事线开关变更广播：一端开/关，主窗/小窗同步刷新展示
  onStoryChanged: (cb: (e: any, data: { chatType: string; chatId: string; enabled: boolean }) => void) => () => void;
  offStoryChanged: (cb: (e: any, data: any) => void) => void;
  eventClosed: (p: { chatType: string; chatId: string }) => Promise<void>;
  deleteChat: (type: string, id: string) => Promise<void>;
  copyChat: (type: string, id: string) => Promise<ChatListItem>;
  renameChat: (type: string, id: string, name: string) => Promise<void>;
  resolveRoleId: (chatType: string, chatId: string) => Promise<string>;
  setStoryEnabled: (chatType: string, chatId: string, enabled: boolean) => Promise<void>;
  getStoryEnabled: (chatType: string, chatId: string) => Promise<boolean>;
  addStoryNode: (chatType: string, chatId: string, msgId: number, title: string) => Promise<number>;
  listStoryNodes: (chatType: string, chatId: string) => Promise<any[]>;
  removeStoryNode: (id: number) => Promise<void>;
  addMoment: (roleId: string, content: string, images: string[], scheduledAt?: string | null, selfRoleId?: string) => Promise<number>;
  listMoments: (roleId?: string, includeUnpublished?: boolean, selfRoleId?: string, favoritedOnly?: boolean) => Promise<any[]>;
  removeMoment: (id: number) => Promise<void>;
  updateMoment: (id: number, patch: Record<string, unknown>) => Promise<void>;
  publishDueMoments: () => Promise<number>;
  triggerRelationship: (chatType: string, chatId: string, roleId: string, withMoments?: boolean, doRelationship?: boolean) => Promise<{ ok: boolean; moments: number; relation?: string; error?: string }>;
  adjustBond: (roleId: string, delta: number) => Promise<number>;
  generateImage: (chatType: string, chatId: string, prompt: string) => Promise<{ ok: boolean; imagePath: string }>;
  saveImageMemory: (p: { roleId: string; imagePath: string; note?: string }) => Promise<any>;
  clearChatMessages: (chatType: string, chatId: string, withMemories: boolean) => Promise<{ deletedMsgs: number; deletedMems: number }>;
  syncAutoChat: (p: { chatId: string; action: 'start' | 'stop' }) => Promise<void>;
  syncMessages: (p: { chatType: string; chatId: string; action: 'cleared' | 'recalled' | 'rolledBack' }) => Promise<void>;
  onAutoChatSync: (cb: (data: { chatId: string; action: 'start' | 'stop' }) => void) => () => void;
  onMessagesSync: (cb: (data: { chatType: string; chatId: string; action: string }) => void) => () => void;
  onStreamRoundDone: (cb: (data: { chatId: string; chatType: string }) => void) => () => void;
  onClearFailed: (cb: (data: { chatId: string }) => void) => () => void;
  // 自动接话：单驱动器模式
  claimAutoChat: (chatId: string) => Promise<{ isDriver: boolean; ownerId?: number }>;
  releaseAutoChat: (chatId: string) => Promise<{ released: boolean }>;
  forceStopAutoChat: (chatId: string) => Promise<{ ok: boolean }>;
  updateAutoChatRound: (chatId: string, round: number) => Promise<void>;
  getAutoChatState: (chatId: string) => Promise<{ active: boolean; driverId?: number }>;
  onAutoChatDriver: (cb: (data: { chatId: string; action: 'start' | 'stop' | 'round'; driverId?: number; round?: number; reason?: string }) => void) => () => void;
  // 群成员编辑：单窗口锁
  openGroupEditor: (groupId: string) => Promise<{ ok: boolean; ownerId?: number }>;
  closeGroupEditor: (groupId: string) => Promise<{ ok: boolean }>;
  notifyGroupEditorSaved: (groupId: string) => Promise<void>;
  onGroupEditorState: (cb: (data: { groupId: string; action: 'opened' | 'closed' | 'saved'; ownerId: number }) => void) => () => void;

  getGroups: () => Promise<Group[]>;
  getGroup: (id: string) => Promise<Group | undefined>;
  saveGroup: (g: Group) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  convertGroupToSingle: (groupId: string, roleId: string) => Promise<void>;
  setGroupIgnoreConvert: (groupId: string, value: boolean) => Promise<void>;

  getAffinityLog: (roleId?: string) => Promise<AffinityLogEntry[]>;
  getGlobalTokens: () => Promise<number>;
  getRoleStats: () => Promise<RoleStat[]>;

  getSettings: () => Promise<AppSettings>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  resetSettings: (keepKeys?: boolean) => Promise<AppSettings>;
  deleteAllData: () => Promise<boolean>;
  setMenuLang: (lang: string) => Promise<void>;

  pickImage: () => Promise<string[] | null>;
  getImage: (path: string) => Promise<string | null>;
  saveImage: (dataUrl: string) => Promise<string | null>;

  pickTextFile: (filters?: { name: string; extensions: string[] }[]) => Promise<{ path: string; content: string } | null>;
  // ===== 自定义音效 =====
  pickAudioFile: () => Promise<string | null>;
  setCustomSound: (p: { key: string; srcPath: string }) => Promise<string | null>;
  saveTextFile: (content: string, defaultName?: string) => Promise<string | null>;
  importCharacterCard: () => Promise<ImportCharacterResult | null>;

  pickBackupTarget: () => Promise<string | null>;
  createBackup: (destPath: string) => Promise<void>;
  pickRestoreFile: () => Promise<string | null>;
  restoreBackup: (zipPath: string) => Promise<void>;
  pickBackupDir: () => Promise<string | null>;
  exportBackup: () => Promise<string>;

  listModels: (cfg: ModelConfig) => Promise<string[]>;
  testModel: (cfg: ModelConfig) => Promise<{ ok: boolean; message: string }>;

  transcribeAudio: (data: Uint8Array) => Promise<string>;
  textToSpeech: (text: string) => Promise<string>;

  miniOpen: (p?: {
    initialChat?: { chatType: string; chatId: string; isObserverPrivate?: boolean };
  }) => Promise<void>;
  miniGetInitial: () => Promise<{ chatType: string; chatId: string; isObserverPrivate?: boolean } | null>;
  miniHide: () => Promise<void>;
  miniSetOnTop: (v: boolean) => Promise<void>;
  miniSetOpacity: (v: number) => Promise<void>;
  onMiniSwitch: (cb: (e: any, data: { chatType: string; chatId: string; isObserverPrivate?: boolean } | null) => void) => () => void;
  offMiniSwitch: (cb: (e: any, data: any) => void) => void;
  showMainWindow: () => Promise<void>;

  windowControl: (action: 'minimize' | 'maximize' | 'unmaximize' | 'close') => void;
  windowDragTo: (x: number, y: number) => void;
  onWindowStateChange: (cb: (isMaximized: boolean) => void) => void;
  offWindowStateChange: (cb: (isMaximized: boolean) => void) => void;
  onShowAbout: (cb: () => void) => void;
  offShowAbout: (cb: () => void) => void;

  // ===== 世界书 =====
  listWorldBooks: () => Promise<WorldBook[]>;
  getWorldBook: (id: string) => Promise<WorldBook | undefined>;
  saveWorldBook: (wb: WorldBook) => Promise<void>;
  deleteWorldBook: (id: string) => Promise<void>;
  copyWorldBook: (id: string) => Promise<WorldBook | null>;
  importWorldBook: (content: string, name: string) => Promise<WorldBook>;
  getEffectiveWorldBookId: (chatType: string, chatId: string) => Promise<string>;

  // ===== 规则库 =====
  listRules: () => Promise<Rule[]>;
  saveRule: (rule: Rule) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  copyRule: (id: string) => Promise<Rule | null>;
  importRule: (content: string, name: string) => Promise<Rule>;

  // ===== 记忆 =====
  listMemories: (roleId?: string) => Promise<MemoryEntry[]>;
  addMemory: (m: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at'>) => Promise<MemoryEntry>;
  updateMemory: (id: string, content: string) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  extractMemories: (chatType: string, chatId: string) => Promise<number>;

  // ===== 插件导入 =====
  importPlugin: (content: string, name: string) => Promise<{ kind: 'worldbook' | 'rule' | 'role'; id: string; name: string }>;

  // ===== 确认对话框 =====
  showConfirm?: (message: string, title?: string) => Promise<boolean>;

  // ===== 后台消息提醒 =====
  notifyCard: (p: { chatType: string; chatId: string; name: string; roleName: string; content: string }) => Promise<void>;
  onNotifyData: (cb: (e: any, data: any) => void) => () => void;
  notifyOpen: (chat: { chatType: string; chatId: string; name: string }) => Promise<void>;
  notifyClose: () => Promise<void>;
  notifyIgnoreMouse: (ignore: boolean) => Promise<void>;
  onAppOpenChat: (cb: (e: any, data: any) => void) => () => void;

  // ===== 主进程错误推送 =====
  onAppError?: (cb: (data: { message: string; cause: string; solution: string; lang: string }) => void) => () => void;
  offAppError?: (cb: (data: any) => void) => void;
}

const raw = (window as any).api as NianyuAPI;

// 外部注入的 showConfirm 前置钩子（sound.ts 初始化时注册，避免循环依赖）
export let _beforeConfirm: (() => void) | null = null;
export function setBeforeConfirm(fn: () => void): void { _beforeConfirm = fn; }

export const api: NianyuAPI = {
  ...raw,
  getGlobalTokens: () => raw.getGlobalTokens(),
  getRoleStats: () => raw.getRoleStats(),
  rateInfo: (modelId) => raw.rateInfo(modelId),
  getChatModelId: (chatType, chatId) => raw.getChatModelId(chatType, chatId),
  translate: (text) => raw.translate(text),
  interruptStream: (chatId) => raw.interruptStream(chatId),
  copyChat: (type, id) => raw.copyChat(type, id),
  renameChat: (type, id, name) => raw.renameChat(type, id, name),
  resolveRoleId: (chatType, chatId) => raw.resolveRoleId(chatType, chatId),
  setStoryEnabled: (chatType, chatId, enabled) => raw.setStoryEnabled(chatType, chatId, enabled),
  getStoryEnabled: (chatType, chatId) => raw.getStoryEnabled(chatType, chatId),
  addStoryNode: (chatType, chatId, msgId, title) => raw.addStoryNode(chatType, chatId, msgId, title),
  listStoryNodes: (chatType, chatId) => raw.listStoryNodes(chatType, chatId),
  removeStoryNode: (id) => raw.removeStoryNode(id),
  addMoment: (roleId, content, images, scheduledAt, selfRoleId) => raw.addMoment(roleId, content, images, scheduledAt, selfRoleId),
  listMoments: (roleId, includeUnpublished, selfRoleId, favoritedOnly) => raw.listMoments(roleId, includeUnpublished, selfRoleId, favoritedOnly),
  removeMoment: (id) => raw.removeMoment(id),
  updateMoment: (id, patch) => raw.updateMoment(id, patch),
  publishDueMoments: () => raw.publishDueMoments(),
  triggerRelationship: (chatType, chatId, roleId, withMoments, doRelationship) => raw.triggerRelationship(chatType, chatId, roleId, withMoments, doRelationship),
  adjustBond: (roleId, delta) => raw.adjustBond(roleId, delta),
  generateImage: (chatType, chatId, prompt) => raw.generateImage(chatType, chatId, prompt),
  saveImageMemory: (p) => raw.saveImageMemory(p),
  recallMessage: (msgId) => raw.recallMessage(msgId),
  rollbackMessages: (p) => raw.rollbackMessages(p),
  addQuickMemory: (p) => raw.addQuickMemory(p),
  pickTextFile: (filters) => raw.pickTextFile(filters),
  pickAudioFile: () => raw.pickAudioFile(),
  setCustomSound: (p) => raw.setCustomSound(p),
  saveTextFile: (content, defaultName) => raw.saveTextFile(content, defaultName),
  importCharacterCard: () => raw.importCharacterCard(),
  resetSettings: (keepKeys) => raw.resetSettings(keepKeys),
  deleteAllData: () => raw.deleteAllData(),
  showConfirm: async (message, title) => {
    _beforeConfirm?.();
    return raw.showConfirm!(message, title);
  },
};
