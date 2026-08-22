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
  ErrorLogEntry,
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
    visibleToGroup?: boolean;
    toMemory?: boolean;
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
    visibleToGroup?: boolean;
    toMemory?: boolean;
  }) => Promise<{ userMessage: ChatMessage; members: { streamId: string; roleId: string; roleName: string }[] }>;
  // 请求限速（QPS）状态查询
  rateInfo: (modelId: string) => Promise<{ enabled: boolean; limit: number; waitMs: number }>;
  // 当前聊天参与限速的代表模型 id（单聊=角色模型；群聊=默认模型）
  getChatModelId: (chatType: string, chatId: string) => Promise<string>;
  // 翻译文本（右键菜单翻译）
  translate: (text: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  // 打断生成
  interruptStream: (chatId: string) => Promise<{ ok: boolean }>;
  groupContinue: (p: {
    chatId: string;
    forceRoleId?: string;
    visibleToGroup?: boolean;
    toMemory?: boolean;
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
  onNeedSpeaker: (cb: (data: { chatId: string; members: { id: string; name: string; avatar?: string }[] }) => void) => () => void;

  onSettingsChanged: (cb: (e: any, data: any) => void) => () => void;
  offSettingsChanged: (cb: (e: any, data: any) => void) => void;

  onSearchStatus: (cb: (e: any, data: any) => void) => () => void;
  offSearchStatus: (cb: (e: any, data: any) => void) => void;
  onSearchResults: (cb: (e: any, data: any) => void) => () => void;
  offSearchResults: (cb: (e: any, data: any) => void) => void;

  // 消息操作
  recallMessage: (msgId: number) => Promise<{ ok: boolean; deletedMems: number }>;
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
  // 关系值（bond）变更广播：一端调整，主窗/小窗同步刷新展示
  onRoleBond: (cb: (e: any, data: { roleId: string }) => void) => () => void;
  offRoleBond: (cb: (e: any, data: any) => void) => void;
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
  copyRole: (id: string, includeChats: boolean) => Promise<{ id: string; name: string } | undefined>;
  // 模型对比：同一问题并发发给 ≤3 个模型，返回耗时/token + 默认模型质量评分
  compareStart: (p: { question: string; modelIds: string[]; compareId?: string }) => Promise<{
    results: { modelId: string; modelName: string; content: string; promptTokens: number; completionTokens: number; elapsedMs: number; error: string }[];
    judgments: Record<string, { score: number; comment: string }>;
    totalMs: number;
    judgeModel: string;
  }>;
  // 模型对比渐进式广播（每个模型完成即推送结果，与角色记忆无关）
  onCompareResult: (cb: (_e: any, data: { compareId: string; modelId: string; modelName: string; content: string; promptTokens: number; completionTokens: number; elapsedMs: number; error: string }) => void) => () => void;
  onCompareJudged: (cb: (_e: any, data: { compareId: string; judgments: Record<string, { score: number; comment: string }>; judgeModel: string }) => void) => () => void;
  onCompareDone: (cb: (_e: any, data: { compareId: string; totalMs: number }) => void) => () => void;
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
  generateVideo: (chatType: string, chatId: string, prompt: string) => Promise<{ ok: boolean; started: boolean }>;
  generateImageFromImage: (
    chatType: string,
    chatId: string,
    prompt: string,
    imagePath: string,
    kind: 'image' | 'video'
  ) => Promise<{ ok: boolean; started?: boolean; imagePath?: string }>;
  // 生视频进度/完成广播（主窗 + 小窗悬浮气泡订阅）
  onVideoProgress: (cb: (e: any, data: { chatType: string; chatId: string; prompt: string; percent: number; status?: string }) => void) => () => void;
  offVideoProgress: (cb: (e: any, data: any) => void) => void;
  onVideoDone: (cb: (e: any, data: { chatType: string; chatId: string; prompt: string; ok: boolean; imagePath?: string; error?: string }) => void) => () => void;
  offVideoDone: (cb: (e: any, data: any) => void) => void;
  saveImageMemory: (p: { roleId: string; imagePath: string; note?: string }) => Promise<any>;
  clearChatMessages: (chatType: string, chatId: string, withMemories: boolean) => Promise<{ deletedMsgs: number; deletedMems: number }>;
  syncAutoChat: (p: { chatId: string; action: 'start' | 'stop' }) => Promise<void>;
  syncMessages: (p: { chatType: string; chatId: string; action: 'cleared' | 'recalled' | 'rolledBack' }) => Promise<void>;
  onAutoChatSync: (cb: (data: { chatId: string; action: 'start' | 'stop' }) => void) => () => void;
  onMessagesSync: (cb: (data: { chatType: string; chatId: string; action: string }) => void) => () => void;
  onStreamRoundDone: (cb: (data: { chatId: string; chatType: string }) => void) => () => void;
  // 自动接话：单驱动器模式
  claimAutoChat: (chatId: string) => Promise<{ isDriver: boolean; ownerId?: number }>;
  releaseAutoChat: (chatId: string) => Promise<{ released: boolean }>;
  forceStopAutoChat: (chatId: string) => Promise<{ ok: boolean }>;
  updateAutoChatRound: (chatId: string, round: number) => Promise<void>;
  getAutoChatState: (chatId: string) => Promise<{ active: boolean; driverId?: number }>;
  onAutoChatDriver: (cb: (data: { chatId: string; action: 'start' | 'stop' | 'round'; driverId?: number; round?: number; reason?: string }) => void) => () => void;
  onClearFailed: (cb: (data: { chatId: string }) => void) => () => void;
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

  // ===== 应用数据保存路径（实时数据，非备份）=====
  getDataPath: () => Promise<{ current: string; custom: string | null; def: string }>;
  setDataPath: (dir: string) => Promise<{ ok: boolean; error?: string }>;
  pickDataDir: () => Promise<string | null>;

  // ===== 错误日志 =====
  logAppError: (category: 'functional' | 'model' | 'other', message: string, detail?: string) => Promise<void>;
  getErrorLog: () => Promise<ErrorLogEntry[]>;
  clearErrorLog: () => Promise<void>;

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

  // ===== 插件（导入 / 列表 / 启停 / 删除 / 受控调用） =====
  importPlugin: (content: string, name: string) => Promise<{ kind: 'worldbook' | 'rule' | 'role' | 'plugin'; id: string; name: string }>;
  listPlugins: () => Promise<import('../src/types').Plugin[]>;
  removePlugin: (id: string) => Promise<{ ok: boolean }>;
  togglePlugin: (id: string, enabled: boolean) => Promise<{ ok: boolean; plugin?: import('../src/types').Plugin }>;
  callPluginTool: (pluginId: string, toolName: string, arg: string) => Promise<{ ok: boolean; text?: string }>;

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
  // 模型回复错误（非致命）：推送一个非模态气泡，由 ErrorBubble 组件接收
  onModelError: (cb: (data: { code: string; message: string; detail?: string; cause: string; solution: string; lang: string; roleName?: string }) => void) => () => void;
  offModelError: (cb: (data: any) => void) => void;

  // ===== 打开外部网页（点击联网搜索结果编号） =====
  openExternal: (url: string) => void;
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
  rateInfo: (modelId) => ipcRenderer.invoke('chats:rateInfo', modelId),
  getChatModelId: (chatType, chatId) => ipcRenderer.invoke('chats:activeModel', chatType, chatId),
  translate: (text) => ipcRenderer.invoke('chats:translate', text),
  interruptStream: (chatId) => ipcRenderer.invoke('chats:interrupt', chatId),
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
  onNeedSpeaker: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('group:needSpeaker', listener);
    return () => ipcRenderer.removeListener('group:needSpeaker', listener);
  },

  // 设置变更广播：主窗/小窗同步刷新（世界书/身份/背景/开关等）
  onSettingsChanged: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
  offSettingsChanged: () => {},

  // 联网搜索状态广播（searching / done / failed），供聊天界面提示
  onSearchStatus: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('search:status', listener);
    return () => ipcRenderer.removeListener('search:status', listener);
  },
  offSearchStatus: () => {},

  // 联网搜索结果广播（原始检索结果），供聊天界面折叠展示
  onSearchResults: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('search:results', listener);
    return () => ipcRenderer.removeListener('search:results', listener);
  },
  offSearchResults: () => {},

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
  onVideoProgress: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('video:progress', listener);
    return () => ipcRenderer.removeListener('video:progress', listener);
  },
  offVideoProgress: () => {},
  onVideoDone: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('video:done', listener);
    return () => ipcRenderer.removeListener('video:done', listener);
  },
  offVideoDone: () => {},
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
  onRoleBond: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('role:bond', listener);
    return () => ipcRenderer.removeListener('role:bond', listener);
  },
  offRoleBond: () => {},
  onMomentsChanged: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('moments:changed', listener);
    return () => ipcRenderer.removeListener('moments:changed', listener);
  },
  offMomentsChanged: () => {},
  onMomentsAutoPosted: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('moments:autoPosted', listener);
    return () => ipcRenderer.removeListener('moments:autoPosted', listener);
  },
  offMomentsAutoPosted: () => {},
  onStoryChanged: (cb) => {
    const listener = (e: any, data: any) => cb(e, data);
    ipcRenderer.on('story:changed', listener);
    return () => ipcRenderer.removeListener('story:changed', listener);
  },
  offStoryChanged: () => {},
  eventClosed: (p) => ipcRenderer.invoke('chats:eventClosed', p),
  deleteChat: (type, id) => ipcRenderer.invoke('chats:delete', type, id),
  copyChat: (type, id) => ipcRenderer.invoke('chats:copy', type, id),
  copyRole: (id, includeChats) => ipcRenderer.invoke('roles:copy', id, includeChats),
  compareStart: (p) => ipcRenderer.invoke('compare:start', p),
  onCompareResult: (cb) => { const l = (_e: any, d: any) => cb(_e, d); ipcRenderer.on('compare:result', l); return () => ipcRenderer.removeListener('compare:result', l); },
  onCompareJudged: (cb) => { const l = (_e: any, d: any) => cb(_e, d); ipcRenderer.on('compare:judged', l); return () => ipcRenderer.removeListener('compare:judged', l); },
  onCompareDone: (cb) => { const l = (_e: any, d: any) => cb(_e, d); ipcRenderer.on('compare:done', l); return () => ipcRenderer.removeListener('compare:done', l); },
  renameChat: (type, id, name) => ipcRenderer.invoke('chats:rename', type, id, name),
  resolveRoleId: (chatType, chatId) => ipcRenderer.invoke('chats:resolveRole', chatType, chatId),
  setStoryEnabled: (chatType, chatId, enabled) => ipcRenderer.invoke('chats:setStory', chatType, chatId, enabled),
  getStoryEnabled: (chatType, chatId) => ipcRenderer.invoke('chats:getStory', chatType, chatId),
  addStoryNode: (chatType, chatId, msgId, title) => ipcRenderer.invoke('chats:addStoryNode', chatType, chatId, msgId, title),
  listStoryNodes: (chatType, chatId) => ipcRenderer.invoke('chats:listStoryNodes', chatType, chatId),
  removeStoryNode: (id) => ipcRenderer.invoke('chats:removeStoryNode', id),
  addMoment: (roleId, content, images, scheduledAt, selfRoleId) => ipcRenderer.invoke('moments:add', roleId, content, images, scheduledAt, selfRoleId),
  listMoments: (roleId, includeUnpublished, selfRoleId, favoritedOnly) => ipcRenderer.invoke('moments:list', roleId, includeUnpublished, selfRoleId, favoritedOnly),
  removeMoment: (id) => ipcRenderer.invoke('moments:remove', id),
  updateMoment: (id, patch) => ipcRenderer.invoke('moments:update', id, patch),
  publishDueMoments: () => ipcRenderer.invoke('moments:publishDue'),
  triggerRelationship: (chatType, chatId, roleId, withMoments, doRelationship) => ipcRenderer.invoke('relationship:trigger', chatType, chatId, roleId, withMoments, doRelationship),
  adjustBond: (roleId, delta) => ipcRenderer.invoke('role:adjustBond', roleId, delta),
  generateImage: (chatType, chatId, prompt) => ipcRenderer.invoke('image:generate', chatType, chatId, prompt),
  generateVideo: (chatType, chatId, prompt) => ipcRenderer.invoke('video:generate', chatType, chatId, prompt),
  generateImageFromImage: (chatType, chatId, prompt, imagePath, kind) =>
    ipcRenderer.invoke('image:generateFromImage', chatType, chatId, prompt, imagePath, kind),
  saveImageMemory: (p) => ipcRenderer.invoke('memory:saveImage', p),
  clearChatMessages: (chatType, chatId, withMemories) => ipcRenderer.invoke('chats:clearMessages', chatType, chatId, withMemories),
  // 窗口间同步
  syncAutoChat: (p) => ipcRenderer.invoke('chat:syncAutoChat', p),
  syncMessages: (p) => ipcRenderer.invoke('chat:syncMessages', p),
  onAutoChatSync: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('chat:autoChatSync', listener);
    return () => ipcRenderer.removeListener('chat:autoChatSync', listener);
  },
  onMessagesSync: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('chat:messagesSync', listener);
    return () => ipcRenderer.removeListener('chat:messagesSync', listener);
  },
  onStreamRoundDone: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('stream:roundDone', listener);
    return () => ipcRenderer.removeListener('stream:roundDone', listener);
  },
  // 自动接话：单驱动器模式
  claimAutoChat: (chatId) => ipcRenderer.invoke('chat:autoChat:claim', chatId),
  releaseAutoChat: (chatId) => ipcRenderer.invoke('chat:autoChat:release', chatId),
  forceStopAutoChat: (chatId) => ipcRenderer.invoke('chat:autoChat:forceStop', chatId),
  updateAutoChatRound: (chatId, round) => ipcRenderer.invoke('chat:autoChat:round', chatId, round),
  getAutoChatState: (chatId) => ipcRenderer.invoke('chat:autoChat:state', chatId),
  onAutoChatDriver: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('chat:autoChat:driver', listener);
    return () => ipcRenderer.removeListener('chat:autoChat:driver', listener);
  },
  onClearFailed: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('chat:clearFailed', listener);
    return () => ipcRenderer.removeListener('chat:clearFailed', listener);
  },
  // 群成员编辑：单窗口锁
  openGroupEditor: (groupId) => ipcRenderer.invoke('chat:groupEditor:open', groupId),
  closeGroupEditor: (groupId) => ipcRenderer.invoke('chat:groupEditor:close', groupId),
  notifyGroupEditorSaved: (groupId) => ipcRenderer.invoke('chat:groupEditor:saved', groupId),
  onGroupEditorState: (cb) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('chat:groupEditor:state', listener);
    return () => ipcRenderer.removeListener('chat:groupEditor:state', listener);
  },

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

  getDataPath: () => ipcRenderer.invoke('data:getPath'),
  setDataPath: (dir) => ipcRenderer.invoke('data:setPath', dir),
  pickDataDir: () => ipcRenderer.invoke('data:pickDir'),
  logAppError: (category, message, detail) => ipcRenderer.invoke('error:log', category, message, detail),
  getErrorLog: () => ipcRenderer.invoke('error:get'),
  clearErrorLog: () => ipcRenderer.invoke('error:clear'),

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

  // ===== 插件（导入 / 列表 / 启停 / 删除 / 受控调用） =====
  importPlugin: (content, name) => ipcRenderer.invoke('plugin:import', content, name),
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  removePlugin: (id) => ipcRenderer.invoke('plugin:remove', id),
  togglePlugin: (id, enabled) => ipcRenderer.invoke('plugin:toggle', id, enabled),
  callPluginTool: (pluginId, toolName, arg) =>
    ipcRenderer.invoke('plugin:callTool', pluginId, toolName, arg),

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
  onModelError: (cb: (data: { code: string; message: string; detail?: string; cause: string; solution: string; lang: string; roleName?: string }) => void) => {
    const listener = (_e: any, data: any) => cb(data);
    ipcRenderer.on('app:modelError', listener);
    return () => ipcRenderer.removeListener('app:modelError', listener);
  },
  offModelError: (cb: (data: any) => void) => {
    ipcRenderer.off('app:modelError', cb);
  },

  // ===== 打开外部网页（点击联网搜索结果编号） =====
  openExternal: (url) => ipcRenderer.send('app:openExternal', url),
};

contextBridge.exposeInMainWorld('api', api);
