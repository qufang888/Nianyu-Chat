import { contextBridge, ipcRenderer } from 'electron';
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
} from '../src/types';
import type { ImportCharacterResult } from '../src/utils/characterCard';

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
  groupContinue: (p: {
    chatId: string;
  }) => Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }>;
  // ===== 空闲主动回复 =====
  proactive: (p: {
    chatType: string;
    chatId: string;
  }) => Promise<{ ok: boolean; roleId?: string; roleName?: string; error?: string }>;
  // ===== 随机事件 =====
  randomEvent: (p: { chatType: string; chatId: string; theme?: string }) => Promise<{
    roleId: string;
    roleName: string;
    event: string;
    options: { text: string; affinity: number; mood: string }[];
  }>;
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

  onSettingsChanged: (cb: (e: any, data: any) => void) => () => void;
  offSettingsChanged: (cb: (e: any, data: any) => void) => void;

  // 消息操作
  recallMessage: (msgId: number) => Promise<boolean>;
  rollbackMessages: (p: { chatType: string; chatId: string; fromMsgId: number }) => Promise<{ deletedMsgs: number; deletedMems: number }>;
  addQuickMemory: (p: { roleId: string; content: string }) => Promise<any>;

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
  eventClosed: (p: { chatType: string; chatId: string }) => Promise<void>;
  deleteChat: (type: string, id: string) => Promise<void>;

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
  showConfirm: (message: string, title?: string) => Promise<boolean>;

  // ===== 后台消息提醒卡片 =====
  notifyCard: (p: { chatType: string; chatId: string; name: string; roleName: string; content: string }) => Promise<void>;
  onNotifyData: (cb: (e: any, data: any) => void) => () => void;
  notifyOpen: (chat: { chatType: string; chatId: string; name: string }) => Promise<void>;
  notifyClose: () => Promise<void>;
  notifyIgnoreMouse: (ignore: boolean) => Promise<void>;

  // ===== 主窗打开指定会话（消息提醒卡片点击） =====
  onAppOpenChat: (cb: (e: any, data: any) => void) => () => void;

  // ===== 主进程错误推送 =====
  onAppError: (cb: (data: { message: string; cause: string; solution: string; lang: string }) => void) => () => void;
  offAppError: (cb: (data: any) => void) => void;
}

const windowStateListeners = new Map<
  (isMaximized: boolean) => void,
  (_e: unknown, isMaximized: boolean) => void
>();

const api: NianyuAPI = {
  getRoles: () => ipcRenderer.invoke('roles:list'),
  getRole: (id) => ipcRenderer.invoke('roles:get', id),
  saveRole: (role) => ipcRenderer.invoke('roles:save', role),
  deleteRole: (id) => ipcRenderer.invoke('roles:delete', id),
  aiCompleteRole: (basic, modelId) => ipcRenderer.invoke('roles:aiComplete', basic, modelId),

  getChatList: () => ipcRenderer.invoke('chats:list'),
  getMessages: (type, id) => ipcRenderer.invoke('chats:messages', type, id),
  sendMessage: (p) => ipcRenderer.invoke('chats:send', p),
  sendUserMessage: (p) => ipcRenderer.invoke('chats:sendUser', p),
  sendAIMessages: (p) => ipcRenderer.invoke('chats:sendAI', p),
  startStream: (p) => ipcRenderer.invoke('chats:stream', p),
  groupContinue: (p) => ipcRenderer.invoke('chats:groupContinue', p),
  proactive: (p) => ipcRenderer.invoke('chats:proactive', p),
  randomEvent: (p) => ipcRenderer.invoke('chats:randomEvent', p),
  chooseEvent: (p) => ipcRenderer.invoke('chats:chooseEvent', p),

  // ===== 观察者模式（对局） =====
  observerSetMode: (p) => ipcRenderer.invoke('observer:setMode', p),
  observerSetConfig: (p) => ipcRenderer.invoke('observer:setConfig', p),
  // 消息操作
  recallMessage: (msgId) => ipcRenderer.invoke('messages:recall', msgId),
  rollbackMessages: (p) => ipcRenderer.invoke('messages:rollback', p.chatType, p.chatId, p.fromMsgId),
  addQuickMemory: (p) => ipcRenderer.invoke('memories:addQuick', p),
  onGroupObserver: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('group:observer', listener);
    return () => ipcRenderer.removeListener('group:observer', listener);
  },
  offGroupObserver: () => {},

  // 设置变更广播：主窗/小窗同步刷新（世界书/身份/背景/开关等）
  onSettingsChanged: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
  offSettingsChanged: () => {},

  // 在 preload 内部创建 listener 包装并返回 unsubscribe，避免 contextBridge
  // 跨边界导致 on/off 传入的回调被包装成不同代理、无法正确移除监听（监听器累积）。
  onStreamChunk: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('stream:chunk', listener);
    return () => ipcRenderer.removeListener('stream:chunk', listener);
  },
  offStreamChunk: () => {},
  onStreamStart: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('stream:start', listener);
    return () => ipcRenderer.removeListener('stream:start', listener);
  },
  offStreamStart: () => {},
  onStreamDone: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('stream:done', listener);
    return () => ipcRenderer.removeListener('stream:done', listener);
  },
  offStreamDone: () => {},
  onStreamUser: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('stream:user', listener);
    return () => ipcRenderer.removeListener('stream:user', listener);
  },
  offStreamUser: () => {},
  onEventChosen: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('event:chosen', listener);
    return () => ipcRenderer.removeListener('event:chosen', listener);
  },
  offEventChosen: () => {},
  sendIdleActivity: (chatKey) => ipcRenderer.send('idle:set', { chatKey, ts: Date.now() }),
  idleGet: (chatKey) => ipcRenderer.invoke('idle:get', chatKey),
  idleSet: (chatKey, ts) => ipcRenderer.send('idle:set', { chatKey, ts }),
  onIdleActivity: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('idle:activity', listener);
    return () => ipcRenderer.removeListener('idle:activity', listener);
  },
  offIdleActivity: () => {},
  onIdleTick: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('idle:tick', listener);
    return () => ipcRenderer.removeListener('idle:tick', listener);
  },
  onRoleMood: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('role:mood', listener);
    return () => ipcRenderer.removeListener('role:mood', listener);
  },
  offRoleMood: () => {},
  eventClosed: (p) => ipcRenderer.invoke('chats:eventClosed', p),
  deleteChat: (type, id) => ipcRenderer.invoke('chats:delete', type, id),

  getGroups: () => ipcRenderer.invoke('groups:list'),
  getGroup: (id) => ipcRenderer.invoke('groups:get', id),
  saveGroup: (g) => ipcRenderer.invoke('groups:save', g),
  deleteGroup: (id) => ipcRenderer.invoke('groups:delete', id),
  convertGroupToSingle: (groupId, roleId) =>
    ipcRenderer.invoke('groups:convertToSingle', groupId, roleId),
  setGroupIgnoreConvert: (groupId, value) =>
    ipcRenderer.invoke('groups:setIgnoreConvert', groupId, value),

  getAffinityLog: (roleId) => ipcRenderer.invoke('affinity:log', roleId),

  getGlobalTokens: () => ipcRenderer.invoke('stats:tokens'),
  getRoleStats: () => ipcRenderer.invoke('stats:roles'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  resetSettings: (keepKeys) => ipcRenderer.invoke('settings:reset', keepKeys),
  deleteAllData: () => ipcRenderer.invoke('app:deleteAllData'),
  setMenuLang: (lang) => ipcRenderer.invoke('app:setMenuLang', lang),

  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  getImage: (path) => ipcRenderer.invoke('image:get', path),
  saveImage: (dataUrl) => ipcRenderer.invoke('image:save', dataUrl),

  pickTextFile: (filters) => ipcRenderer.invoke('file:pickText', filters),
  pickAudioFile: () => ipcRenderer.invoke('sound:pick'),
  setCustomSound: (p) => ipcRenderer.invoke('sound:setCustom', p),
  saveTextFile: (content, defaultName) => ipcRenderer.invoke('file:saveText', content, defaultName),
  importCharacterCard: () => ipcRenderer.invoke('character:importCard'),

  pickBackupTarget: () => ipcRenderer.invoke('backup:pickTarget'),
  createBackup: (destPath) => ipcRenderer.invoke('backup:create', destPath),
  pickRestoreFile: () => ipcRenderer.invoke('backup:pickFile'),
  restoreBackup: (zipPath) => ipcRenderer.invoke('backup:restore', zipPath),
  pickBackupDir: () => ipcRenderer.invoke('backup:pickDir'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),

  listModels: (cfg) => ipcRenderer.invoke('models:list', cfg),
  testModel: (cfg) => ipcRenderer.invoke('models:test', cfg),

  transcribeAudio: (data) => ipcRenderer.invoke('audio:transcribe', data),
  textToSpeech: (text) => ipcRenderer.invoke('audio:tts', text),

  miniOpen: (p) => ipcRenderer.invoke('mini:open', p),
  miniGetInitial: () => ipcRenderer.invoke('mini:getInitial'),
  miniHide: () => ipcRenderer.invoke('mini:hide'),
  miniSetOnTop: (v) => ipcRenderer.invoke('mini:setOnTop', v),
  miniSetOpacity: (v) => ipcRenderer.invoke('mini:setOpacity', v),
  onMiniSwitch: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('mini:switch', listener);
    return () => ipcRenderer.removeListener('mini:switch', listener);
  },
  offMiniSwitch: () => {},
  showMainWindow: () => ipcRenderer.invoke('main:show'),

  windowControl: (action) => ipcRenderer.send('window-control', action),
  windowDragTo: (x, y) => ipcRenderer.send('window-drag-to', x, y),
  onWindowStateChange: (cb) => {
    const wrapper = (_e: unknown, isMax: boolean) => cb(isMax);
    windowStateListeners.set(cb, wrapper);
    ipcRenderer.on('window-state-change', wrapper);
  },
  offWindowStateChange: (cb) => {
    const wrapper = windowStateListeners.get(cb);
    if (wrapper) {
      ipcRenderer.off('window-state-change', wrapper);
      windowStateListeners.delete(cb);
    }
  },
  onShowAbout: (cb) => ipcRenderer.on('app:showAbout', cb),
  offShowAbout: (cb) => ipcRenderer.off('app:showAbout', cb),

  // ===== 世界书 =====
  listWorldBooks: () => ipcRenderer.invoke('worldbooks:list'),
  getWorldBook: (id) => ipcRenderer.invoke('worldbooks:get', id),
  saveWorldBook: (wb) => ipcRenderer.invoke('worldbooks:save', wb),
  deleteWorldBook: (id) => ipcRenderer.invoke('worldbooks:delete', id),
  copyWorldBook: (id) => ipcRenderer.invoke('worldbooks:copy', id),
  importWorldBook: (content, name) => ipcRenderer.invoke('worldbooks:import', content, name),
  getEffectiveWorldBookId: (chatType, chatId) =>
    ipcRenderer.invoke('worldbook:effectiveId', chatType, chatId),

  // ===== 规则库 =====
  listRules: () => ipcRenderer.invoke('rules:list'),
  saveRule: (rule) => ipcRenderer.invoke('rules:save', rule),
  deleteRule: (id) => ipcRenderer.invoke('rules:delete', id),
  copyRule: (id) => ipcRenderer.invoke('rules:copy', id),
  importRule: (content, name) => ipcRenderer.invoke('rules:import', content, name),

  // ===== 记忆 =====
  listMemories: (roleId) => ipcRenderer.invoke('memories:list', roleId),
  addMemory: (m) => ipcRenderer.invoke('memories:add', m),
  updateMemory: (id, content) => ipcRenderer.invoke('memories:update', id, content),
  deleteMemory: (id) => ipcRenderer.invoke('memories:delete', id),
  extractMemories: (chatType, chatId) => ipcRenderer.invoke('memories:extract', chatType, chatId),

  // ===== 插件导入 =====
  importPlugin: (content, name) => ipcRenderer.invoke('plugin:import', content, name),

  // ===== 确认对话框 =====
  showConfirm: (message, title) => ipcRenderer.invoke('app:confirm', message, title),

  // ===== 后台消息提醒卡片 =====
  notifyCard: (p) => ipcRenderer.invoke('notify:card', p),
  onNotifyData: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('notify:data', listener);
    return () => ipcRenderer.removeListener('notify:data', listener);
  },
  notifyOpen: (chat) => ipcRenderer.invoke('notify:open', chat),
  notifyClose: () => ipcRenderer.invoke('notify:close'),
  notifyIgnoreMouse: (ignore) => ipcRenderer.invoke('notify:ignoreMouse', ignore),

  // ===== 主窗打开指定会话 =====
  onAppOpenChat: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('app:openChat', listener);
    return () => ipcRenderer.removeListener('app:openChat', listener);
  },

  // ===== 主进程错误推送 =====
  onAppError: (cb: (data: { message: string; cause: string; solution: string; lang: string }) => void) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('app:error', listener);
    return () => ipcRenderer.removeListener('app:error', listener);
  },
  offAppError: (cb: (data: any) => void) => {
    ipcRenderer.off('app:error', cb);
  },
};

contextBridge.exposeInMainWorld('api', api);
