import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './ipc';
import { useI18n } from './i18n/I18nContext';
import { useTheme } from './theme/ThemeContext';
import { Sidebar } from './components/Sidebar';
import { ChatList } from './components/ChatList';
import { RoleList } from './components/RoleList';
import { ChatWindow } from './components/ChatWindow';
import { Settings } from './components/Settings';
import { GroupEditor } from './components/GroupEditor';
import { StatsView } from './components/StatsView';
import { CustomTitleBar } from './components/CustomTitleBar';
import { SplashScreen } from './components/SplashScreen';
import { AboutModal } from './components/AboutModal';
import { OnboardingWizard } from './components/OnboardingWizard';
import { Library, type LibraryTab } from './components/Library';
import { WorldBookEditor } from './components/WorldBookEditor';
import { RuleEditor } from './components/RuleEditor';
import { RoleEditor } from './components/RoleEditor';
import {
  QuickImportPreviewModal,
  type QuickImportPreviewState as QuickImportPreviewModalState,
} from './components/QuickImportPreviewModal';
import { ModelCompare } from './components/ModelCompare';
import { MomentsView } from './components/MomentsView';
import { useToast, ToastView } from './components/Toast';
import CustomCursor from './components/CustomCursor';
import VideoBubble from './components/VideoBubble';
import ErrorBubble from './components/ErrorBubble';
import QueueDock from './components/QueueDock';
import { UpdatePopup } from './components/UpdatePopup';
import { TutorialOverlay } from './components/TutorialOverlay';
import type { Role, QuickImportResult, QuickImportPreviewItem } from './types';

type View = 'chats' | 'contacts' | 'compare' | 'settings' | 'stats' | 'library' | 'moments';
interface Selected {
  type: string;
  id: string;
  name: string;
  members: Role[];
}

export default function App() {
  const { t } = useI18n();
  const { settings, reloadSettings } = useTheme();
  const { toast, showToast } = useToast();
  const [view, setView] = useState<View>('chats');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [showGroup, setShowGroup] = useState(false);
  // 开屏动画：仅「进程冷启动」（双击 exe / 开始菜单 / 命令行）播放一次；
  // 从托盘或悬浮球唤出已隐藏窗口时，主进程会带 ?nosplash=1 重建渲染进程，不再重播。
  // hasShownSplash 仅作历史记录，不参与展示判定。
  const [showSplash, setShowSplash] = useState<boolean>(
    () => !new URLSearchParams(window.location.search).has('nosplash')
  );
  const [aboutOpen, setAboutOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // 聊天侧边栏缩进：true=收起会话列表，聊天区占满整页
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 设置页导航重置信号：再次点击左侧「设置」图标时从二级页退回设置主界面
  const [settingsNavTick, setSettingsNavTick] = useState(0);

  // ===== 快速导入（v2.3.51）：文件拖入窗口任意位置 → 识别角色卡/世界书/规则/插件并直接导入 =====
  // v2.3.97：改为「先预检 → 弹确认 → 再导入」。松手不再直接落库，误拖可以反悔。
  const [dropActive, setDropActive] = useState(false);
  const [importTick, setImportTick] = useState(0); // 导入成功后重挂载联系人/资料库列表以刷新
  const dropDepth = useRef(0);
  // 预检弹窗状态（loading 时 result 为 null）
  const [preview, setPreview] = useState<QuickImportPreviewModalState | null>(null);
  // 「导入并编辑」的工作队列：按顺序逐个打开编辑器，点保存才落库；取消即跳过（完全不导入）
  const [editQueue, setEditQueue] = useState<QuickImportPreviewItem[]>([]);
  // 本轮队列里**实际保存成功**的项（收尾时用它决定跳到哪个页面）。
  // 用 ref 而不是 state：onSaved 回调里紧接着就要读它，state 更新是异步的读不到。
  const savedRef = useRef<QuickImportPreviewItem[]>([]);
  // 资料库深链页签（导入完插件/规则后跳到对应页签「稍后编辑」）
  const [libraryTab, setLibraryTab] = useState<LibraryTab | undefined>(undefined);

  const hasDragFiles = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer?.types || []).includes('Files');

  // 把既有「导入完成」的 Toast 汇报抽成独立函数：仅导入 / 导入并编辑两条路径共用
  const reportImportResults = (results: QuickImportResult[]) => {
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    const counts: Record<string, number> = {};
    ok.forEach((r) => {
      const k = r.kind || 'plugin';
      counts[k] = (counts[k] || 0) + 1;
    });
    const summary = Object.entries(counts)
      .map(([k, n]) => `${t(`quickimport.${k}`)}×${n}`)
      .join('、');
    const failText = bad
      .map((r) => t('toast.quickImportFail', { name: r.name, reason: t(`quickimport.err_${r.error || 'read_failed'}`) }))
      .join('；');
    if (ok.length && !bad.length) showToast(t('toast.quickImportDone', { summary }));
    else if (!ok.length) showToast(failText, { error: true });
    else showToast(`${t('toast.quickImportDone', { summary })}；${failText}`, { duration: 5000 });
    if (ok.length) setImportTick((v) => v + 1);
  };

  /** 「取消」：关弹窗，什么都不做（预检本身无副作用，所以这里不需要任何回滚） */
  const closePreview = useCallback(() => setPreview(null), []);

  /**
   * 拖放入口：先拿路径 → 调预检（只读）→ 弹确认弹窗。
   * 注意顺序：previewFiles 的调用点行号必须早于弹窗渲染与 importDroppedFiles 的调用点，
   * `scripts/verify-quick-import-preview.mjs` 第 3 条断言按行号校验这个先后关系。
   */
  const handleQuickImport = async (files: FileList) => {
    const paths: string[] = [];
    for (const f of Array.from(files)) {
      const p = await api.getPathForFile(f);
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    // ① 预检：主进程只读解析，不落库
    setPreview({ loading: true, result: null, error: '' });
    try {
      const result = await api.previewFiles(paths);
      setPreview({ loading: false, result, error: '' });
    } catch (e: any) {
      setPreview({ loading: false, result: null, error: t('quickimport.preview.failed') });
    }
  };

  /** 「仅导入」：走既有 api.importDroppedFiles，语义与 v2.3.51 完全一致 */
  const onPreviewImportOnly = useCallback(
    async (items: QuickImportPreviewItem[]) => {
      setPreview(null);
      if (!items.length) return;
      try {
        // ② 确认之后才真正落库
        const results = await api.importDroppedFiles(items.map((i) => i.path));
        reportImportResults(results);
      } catch (e: any) {
        showToast(t('chat.sendFailedShort'), { error: true });
      }
    },
    [showToast, t]
  );

  /**
   * 把 PNG 角色卡的头像「归位」到图片目录。
   *
   * 背景：预检阶段不允许写盘（不复制头像文件），所以 draft.role.avatar_path 暂借用户
   * **原文件**的路径当头像。但编辑器保存时会把 avatar_path 原样写进角色记录 ——
   * 而用户随时可能把那个 PNG 挪走/删掉，于是头像就断了。
   * 「仅导入」路径没这个问题：既有 import:dropFiles 会 fs.copyFileSync 一份进 imagesDir。
   *
   * 这里用**既有 IPC** 补上这一步，不新增接口：
   *   api.getImage(原路径) → data URL → api.saveImage(data URL) → imagesDir 里的新路径。
   * 只在用户点了「导入并编辑」之后才执行（此时用户已明确同意导入），预检阶段不碰。
   * 失败则退回原路径 —— 头像仍能显示，只是不再随图片目录一起被管理。
   */
  const rehomeAvatar = async (items: QuickImportPreviewItem[]): Promise<QuickImportPreviewItem[]> =>
    Promise.all(
      items.map(async (it) => {
        const role = it.draft?.role;
        // avatar_path 等于 item.path ⇒ 它是预检时暂借的原始 PNG，不是已归位的图片
        if (!role || !role.avatar_path || role.avatar_path !== it.path) return it;
        try {
          const dataUrl = await api.getImage(it.path);
          if (!dataUrl) return it;
          const stored = await api.saveImage(dataUrl);
          if (!stored) return it;
          return { ...it, draft: { ...it.draft, role: { ...role, avatar_path: stored } } };
        } catch {
          return it;
        }
      })
    );

  /** 「导入并编辑」：编辑器保存才落库；取消 = 完全不导入 */
  const onPreviewImportAndEdit = useCallback(async (items: QuickImportPreviewItem[]) => {
    setPreview(null);
    if (!items.length) return;
    savedRef.current = [];
    setEditQueue(await rehomeAvatar(items));
  }, []);

  /**
   * 编辑队列的收尾：刷新列表 + 把用户带到「刚导入的东西所在的页面」。
   * 无论队列是被onEditSaved（保存）还是 onEditClosed（取消）走完的都要调 ——
   * 否则「保存了第 1 项、取消了第 2 项」这种混合结局下，第 1 项已落库但列表不刷新，
   * 用户会以为没导进去。
   * @param saved 本轮队列里实际保存成功的项数（0 = 全取消了，什么都没落库）
   */
  const finishEditQueue = useCallback(
    (saved: QuickImportPreviewItem[]) => {
      setImportTick((v) => v + 1);
      if (!saved.length) return; // 全取消：没有任何东西落库，别乱跳页面
      showToast(t('quickimport.preview.edited'));
      const kinds = saved.map((i) => i.kind);
      // 角色卡 → 通讯录；世界书/规则 → 资料库对应页签；插件 → 资料库插件页
      if (kinds.includes('role')) setView('contacts');
      else if (kinds.includes('worldbook')) {
        setLibraryTab('worldbook');
        setView('library');
      } else if (kinds.includes('rule')) {
        setLibraryTab('rule');
        setView('library');
      } else if (kinds.includes('plugin')) {
        setLibraryTab('plugin');
        setView('library');
      }
    },
    [showToast, t]
  );

  /** 编辑器保存成功：关掉当前编辑器，弹下一个；队列走完则收尾 */
  const onEditSaved = useCallback(() => {
    // 记下本轮保存过的项：编辑器的 onSaved 回调不携带是哪一项，用队列头推断即可
    const savedAcc = savedRef.current;
    savedAcc.push(editQueue[0]);
    setEditQueue((q) => {
      const next = q.slice(1);
      if (next.length) return next;
      finishEditQueue(savedAcc.splice(0, savedAcc.length));
      return next;
    });
  }, [editQueue, finishEditQueue]);

  /** 编辑器被关闭（放弃）：跳过这一项，继续下一个；全跳完则收尾（saved 列表为空 → 不跳页） */
  const onEditClosed = useCallback(() => {
    setEditQueue((q) => {
      const next = q.slice(1);
      if (next.length) return next;
      finishEditQueue(savedRef.current.splice(0, savedRef.current.length));
      return next;
    });
  }, [finishEditQueue]);

  const currentEdit = editQueue[0] || null;

  // 首次启动向导：未走过初始设置 或 没有配置模型时弹出，添加模型为必填。
  useEffect(() => {
    if (!showSplash && settings && (!settings.firstRunDone || !settings.models?.length)) setShowOnboarding(true);
  }, [showSplash, settings]);

  // ===== 新手引导（v2.3.90，可跳过）=====
  // 与上面的初始设置向导严格互斥：仅当 firstRunDone === true（初始设置已走完）且
  // 初始设置向导当前没有展示时，才可能挂载 TutorialOverlay。
  // 触发条件全部满足才弹：已完成初始设置 + 未完成也未跳过引导 + 还没有任何人物卡。
  // 人物卡数量为 0 的限制意味着「设置 → 重新运行新手引导」对已有卡的老用户不会自动弹出
  // （按钮仍会把 tutorialDone 写回 false），这点在设置按钮旁有注释说明。
  const [tutorialDismissed, setTutorialDismissed] = useState(false);
  const [roleCount, setRoleCount] = useState<number | null>(null);
  useEffect(() => {
    if (tutorialDismissed) return;
    let alive = true;
    void api
      .getRoles()
      .then((rs) => {
        if (alive) setRoleCount(rs.length);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tutorialDismissed, showOnboarding]);

  const tutorialEligible =
    !showSplash &&
    !showOnboarding &&
    !!settings &&
    settings.firstRunDone === true &&
    settings.tutorialDone !== true &&
    roleCount === 0;

  // 开屏动画每次启动都展示；此处仅把 hasShownSplash 写入设置做历史记录，不作为展示门槛。
  useEffect(() => {
    if (!showSplash) return;
    api.saveSettings({ hasShownSplash: true }).catch(() => {});
  }, [showSplash]);

  // 原生菜单「帮助 → 关于念语」打开关于弹窗
  useEffect(() => {
    api.onShowAbout(() => setAboutOpen(true));
    return () => api.offShowAbout(() => {});
  }, []);

  // 后台消息提醒卡片点击：在主窗打开对应会话
  useEffect(() => {
    if (typeof api.onAppOpenChat !== 'function') return;
    const off = api.onAppOpenChat((_e, data) => {
      onSelectChat({ chat_type: data.chatType, chat_id: data.chatId, name: data.name });
    });
    return off;
  }, []);

  // AI 自动发朋友圈后弹 toast 提示
  useEffect(() => {
    if (typeof api.onMomentsAutoPosted !== 'function') return;
    const off = api.onMomentsAutoPosted((_e, data) => {
      const name = data?.roleName || t('moments.unknownAuthor');
      showToast(`「${name}」发布了 ${data?.count || 0} 条朋友圈`);
    });
    return off;
  }, []);

  // v2.3.88：上报主窗当前一级视图。朋友圈自动配图 / 配视频的状态提醒需要据此判断
  // 「用户此刻是否正停在朋友圈页」——在该页弹站内 Toast（有上下文），不在该页弹后台提醒卡片。
  // 视图切换即上报（含首帧），主进程侧还额外要求窗口真实可见才算「正在看」。
  useEffect(() => {
    if (typeof api.setActiveView !== 'function') return;
    api.setActiveView(view);
  }, [view]);

  const loadMembers = async (type: string, id: string): Promise<Role[]> => {
    if (type !== 'group') return [];
    const g = await api.getGroup(id);
    if (!g) return [];
    const ids = g.member_ids.split(',').map((s) => s.trim()).filter(Boolean);
    const all = await api.getRoles();
    return all.filter((r) => ids.includes(r.id));
  };

  const openChat = async (type: string, id: string, name: string) => {
    const members = await loadMembers(type, id);
    setSelected({ type, id, name, members });
    // 通知主进程当前聊天，供悬浮球判断「主动消息」是否计入未读
    api.setActiveChat(type, id);
  };

  const onSelectChat = (item: { chat_type: string; chat_id: string; name: string }) => {
    setView('chats');
    openChat(item.chat_type, item.chat_id, item.name);
  };

  // 从聊天列表中删除会话
  const onDeleteChat = async (item: { chat_type: string; chat_id: string }) => {
    await api.deleteChat(item.chat_type, item.chat_id);
    showToast(t('chat.toastChatDeleted'));
    if (selected && selected.id === item.chat_id) setSelected(null);
  };

  // 聊天窗口内删除会话
  const onChatDeleted = (chatId: string) => {
    if (selected && selected.id === chatId) setSelected(null);
  };

  // 群聊转为单聊后，重新以单聊打开
  const onConvertedToSingle = async (roleId: string) => {
    const r = await api.getRole(roleId);
    openChat('single', roleId, r?.name || t('chat.singleSub'));
  };

  // 群聊成员编辑后，刷新成员并重新打开
  const onGroupUpdated = async () => {
    if (selected && selected.type === 'group') {
      const members = await loadMembers('group', selected.id);
      setSelected((s) => (s ? { ...s, members } : s));
    }
  };

  const onStartChat = (role: Role) => {
    setView('chats');
    setSelected({ type: 'single', id: role.id, name: role.name, members: [] });
  };

  // 群聊创建后跳入
  const onGroupSaved = () => {
    setShowGroup(false);
    api.getGroups().then((gs) => {
      const g = gs[0];
      if (g) openChat('group', g.group_id, g.group_name);
    });
  };

  const onSent = useCallback(() => {}, []);

  const title = (() => {
    if (view === 'chats' && selected) return selected.name;
  if (view === 'contacts') return t('nav.contacts');
  if (view === 'compare') return t('nav.compare');
  if (view === 'settings') return t('nav.settings');
  if (view === 'moments') return t('nav.moments');
  return t('app.name');
  })();

  return (
    <div
      className="app-root"
      onDragEnter={(e) => {
        if (!hasDragFiles(e)) return;
        e.preventDefault();
        dropDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        if (!hasDragFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dropDepth.current -= 1;
        if (dropDepth.current <= 0) {
          dropDepth.current = 0;
          setDropActive(false);
        }
      }}
      onDrop={(e) => {
        dropDepth.current = 0;
        setDropActive(false);
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        // 输入区（.composer）内部的下落由 ChatWindow 处理（添加待发图片），不做快速导入
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('.composer, .mini-composer')) return;
        void handleQuickImport(e.dataTransfer.files);
      }}
    >
      {dropActive && (
        <div className="quick-import-overlay">
          <div className="quick-import-card">📥 {t('quickimport.overlay')}</div>
        </div>
      )}
      <CustomTitleBar title={title} />
      <div className="app-shell">
        <Sidebar
          view={view}
          onChange={(v) => {
            if (v === 'settings') setSettingsNavTick((t) => t + 1);
            setView(v);
          }}
          extra={
            view === 'chats' && sidebarCollapsed ? (
              <button
                className="sidebar-restore"
                title={t('chats.expandSidebar')}
                onClick={() => setSidebarCollapsed(false)}
              >
                ›
              </button>
            ) : undefined
          }
        />
      {view === 'chats' && (
        <>
          {!sidebarCollapsed && (
            <ChatList
              selectedId={selected?.id || null}
              onSelect={(it) => onSelectChat(it)}
              onNewGroup={() => setShowGroup(true)}
              onDelete={(it) => onDeleteChat(it)}
              onToggleCollapse={() => setSidebarCollapsed(true)}
            />
          )}
          {selected ? (
            <ChatWindow
              key={`${selected.type}:${selected.id}`}
              chatType={selected.type}
              chatId={selected.id}
              name={selected.name}
              members={selected.members}
              onSent={onSent}
              onChatDeleted={onChatDeleted}
              onConvertedToSingle={onConvertedToSingle}
              onGroupUpdated={onGroupUpdated}
              onForked={(chat) => openChat(chat.chat_type, chat.chat_id, chat.name)}
            />
          ) : (
            <div className="main-pane">
              <div className="empty-state">
                <div style={{ fontSize: 40 }}>💬</div>
                <div>{t('app.emptyChat')}</div>
              </div>
            </div>
          )}
        </>
      )}

      {view === 'contacts' && <RoleList key={`roles-${importTick}`} onStartChat={onStartChat} />}
      {view === 'compare' && <ModelCompare />}
      {view === 'settings' && (
        <Settings
          onRerunWizard={() => { setView('chats'); setShowOnboarding(true); }}
          onAbout={() => setAboutOpen(true)}
          onGoToContacts={() => setView('contacts')}
          navResetTick={settingsNavTick}
        />
      )}
      {view === 'stats' && <StatsView />}
      {view === 'moments' && <MomentsView />}
      {view === 'library' && (
        <Library
          key={`lib-${importTick}`}
          onClose={() => setView('chats')}
          initialTab={libraryTab}
        />
      )}

      {/* v2.3.97：拖拽导入预检确认弹窗。
          用项目现成的 .modal-mask / .modal 类，因此自动继承统一的线性入场动画
          （index.css 的 maskFadeIn / popupLinearIn，且已在 animControl 的 theme 组登记）。 */}
      {preview && (
        <QuickImportPreviewModal
          state={preview}
          onImportOnly={onPreviewImportOnly}
          onImportAndEdit={onPreviewImportAndEdit}
          onClose={closePreview}
        />
      )}

      {/* v2.3.97：「导入并编辑」——预检已返回未落库的草稿，这里逐个交给对应编辑器。
          编辑器点保存才真正落库；点取消/叉号则这一项**完全不导入**。
          三种类型分流：角色卡→RoleEditor(initial) / 世界书→WorldBookEditor(wb) / 规则→RuleEditor(rule)；
          插件无编辑器，预检阶段就不给 draft，故不会走到这里。 */}
      {currentEdit?.draft?.role && (
        <RoleEditor
          initial={currentEdit.draft.role}
          onClose={onEditClosed}
          onSaved={onEditSaved}
        />
      )}
      {currentEdit?.draft?.worldBook && (
        <div className="modal-mask" onClick={onEditClosed}>
          <div className="modal" style={{ width: 640, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                📖 {t('library.edit')} · {currentEdit.draft.worldBook.name || currentEdit.fileName}
              </span>
              <span className="modal-close" onClick={onEditClosed}>
                ×
              </span>
            </div>
            <div className="modal-body">
              <p className="qip-desc">{t('quickimport.preview.editHint')}</p>
              <WorldBookEditor
                wb={currentEdit.draft.worldBook}
                onClose={onEditClosed}
                onSaved={onEditSaved}
              />
            </div>
          </div>
        </div>
      )}
      {currentEdit?.draft?.rule && (
        <div className="modal-mask" onClick={onEditClosed}>
          <div className="modal" style={{ width: 560, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                📝 {t('library.edit')} · {currentEdit.draft.rule.name || currentEdit.fileName}
              </span>
              <span className="modal-close" onClick={onEditClosed}>
                ×
              </span>
            </div>
            <div className="modal-body">
              <p className="qip-desc">{t('quickimport.preview.editHint')}</p>
              <RuleEditor
                rule={currentEdit.draft.rule}
                onClose={onEditClosed}
                onSaved={onEditSaved}
              />
            </div>
          </div>
        </div>
      )}

      {showGroup && (
        <GroupEditor onClose={() => setShowGroup(false)} onSaved={onGroupSaved} />
      )}
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {showOnboarding && (
        <OnboardingWizard
          onDone={async () => {
            setShowOnboarding(false);
            await reloadSettings();
          }}
        />
      )}
      <ToastView toast={toast} />
      <CustomCursor />
      <VideoBubble />
      <ErrorBubble />
      <QueueDock />
{/* v2.3.48：更新提醒弹窗（仅主窗；每版本只弹一次，设置中可永久关闭提醒） */}
      <UpdatePopup />
      {/* v2.3.90：新手引导（可跳过；与初始设置向导互斥，仅在「无人物卡」时出现） */}
      {tutorialEligible && (
        <TutorialOverlay
          show
          onClose={() => setTutorialDismissed(true)}
          onGoToContacts={() => setView('contacts')}
        />
      )}
    </div>
    </div>
  );
}
