import { useState, useEffect, useCallback } from 'react';
import { api } from './ipc';
import { useI18n } from './i18n/I18nContext';
import { useTheme } from './theme/ThemeContext';
import { Sidebar } from './components/Sidebar';
import { playSoundSync } from './utils/sound';
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
import { Library } from './components/Library';
import { useToast, ToastView } from './components/Toast';
import CustomCursor from './components/CustomCursor';
import type { Role } from './types';

type View = 'chats' | 'contacts' | 'settings' | 'stats' | 'library';
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
  const [showSplash, setShowSplash] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshUI = useCallback(() => {
    setRefreshKey((k) => k + 1);
    const c = document.querySelector('.app-root');
    c?.dispatchEvent(new CustomEvent('refresh'));
  }, []);

  // 首次启动向导：未走过初始设置 或 没有配置模型时弹出，添加模型为必填。
  useEffect(() => {
    if (!showSplash && settings && (!settings.firstRunDone || !settings.models?.length)) setShowOnboarding(true);
  }, [showSplash, settings]);

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
    if (view === 'settings') return t('nav.settings');
    return t('app.name');
  })();

  return (
    <div className="app-root">
      <CustomTitleBar title={title} />
      <div className="app-shell" data-refresh={refreshKey}>
        <Sidebar view={view} onChange={setView} onAbout={() => setAboutOpen(true)} onRefresh={refreshUI} />
      {view === 'chats' && (
        <>
          <ChatList
            selectedId={selected?.id || null}
            onSelect={(it) => onSelectChat(it)}
            onNewGroup={() => setShowGroup(true)}
            onDelete={(it) => onDeleteChat(it)}
          />
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

      {view === 'contacts' && <RoleList onStartChat={onStartChat} />}
      {view === 'settings' && (
        <Settings onRerunWizard={() => { setView('chats'); setShowOnboarding(true); }} />
      )}
      {view === 'stats' && <StatsView />}
      {view === 'library' && <Library onClose={() => setView('chats')} />}

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
      </div>
    </div>
  );
}
