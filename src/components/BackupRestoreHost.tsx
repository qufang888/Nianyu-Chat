import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nContext';
import { api } from '../ipc';
import { compareVersions } from '../utils/versionCompare';
import { backupBus } from '../utils/backupBus';
import type { PortableCreateResult, RestoreRequest } from '../types';
import PassphraseDialog from './PassphraseDialog';
import { useToast, ToastView } from './Toast';

/**
 * 可携带备份宿主（v3.0.19）—— 挂在 main.tsx 顶层，与 ConfirmHost / FilePickerHost 并列。
 *
 * 因 main.tsx 是主窗 <App /> 与小窗 <MiniChat /> 的共用入口，本宿主同时服务两窗。
 * 订阅 backupBus 三事件，驱动：
 *   1. 创建成功后的一次性口令展示（关闭即丢，不写任何持久层）；
 *   2. 三态还原分流：v2 先 peek（免口令，含高版本告警）再弹自绘口令框；
 *      v1 / zip / unknown 沿用既有 showConfirm + restoreBackup；
 *   3. 拖入 .ny 的全窗 overlay（复用 .quick-import-overlay）。
 * 采用队列语义，避免连续拖入 / 连点丢请求。
 */
const BackupRestoreHost: React.FC = () => {
  const { t } = useI18n();
  const { toast, showToast } = useToast();

  const [createdQueue, setCreatedQueue] = useState<PortableCreateResult[]>([]);
  const [created, setCreated] = useState<PortableCreateResult | null>(null);
  const [createdVisible, setCreatedVisible] = useState(false);

  const [restoreQueue, setRestoreQueue] = useState<RestoreRequest[]>([]);
  const [current, setCurrent] = useState<RestoreRequest | null>(null);
  const [processing, setProcessing] = useState(false);

  const [dragActive, setDragActive] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [passErr, setPassErr] = useState('');
  const [busy, setBusy] = useState(false);

  // 订阅总线（主窗 / 小窗各自一份）
  useEffect(() => {
    const offCreated = backupBus.onShowCreated(({ result }) => {
      setCreatedQueue((q) => [...q, result]);
    });
    const offRestore = backupBus.onRequestRestore((req) => {
      setRestoreQueue((q) => [...q, req]);
    });
    const offDrag = backupBus.onDragActive((active) => setDragActive(active));
    return () => {
      offCreated();
      offRestore();
      offDrag();
    };
  }, []);

  // 展示队列：退场期间不卸载，等 useRetract 播完
  useEffect(() => {
    if (createdVisible && created) return;
    const next = createdQueue[0];
    if (!next) return;
    setCreated(next);
    setCreatedVisible(true);
  }, [createdQueue, createdVisible, created]);

  /** 关闭一次性口令展示：只动内存态，口令不进日志 / 设置 / DOM 持久属性。 */
  const closeCreated = useCallback(() => {
    setCreatedQueue((q) => q.slice(1));
    setCreatedVisible(false);
  }, []);

  /** 结束当前还原请求，允许队列下一项顶上。 */
  const finish = useCallback(() => {
    setCurrent(null);
    setProcessing(false);
    setPassOpen(false);
    setPassErr('');
    setBusy(false);
  }, []);

  // 用 ref 承载异步处理器，避免把它放进 effect 依赖造成重复取队首
  const handleRequestRef = useRef<(req: RestoreRequest) => Promise<void>>(async () => undefined);
  handleRequestRef.current = async (req: RestoreRequest): Promise<void> => {
    try {
      const info = await api.peekBackupInfo(req.path);
      if (info.kind === 'v2') {
        // peek 免口令：高版本告警在输入口令之前完成
        if (info.appVersion) {
          try {
            const st = await api.updateStatus();
            const cur = String(st?.currentVersion || '');
            if (cur && compareVersions(info.appVersion, cur) > 0) {
              const go = await api.showConfirm!(
                t('settings.backupVersionWarn', { backup: info.appVersion, current: cur }),
                t('settings.backupVersionWarnTitle')
              );
              if (!go) {
                finish();
                return;
              }
            }
          } catch {
            // 版本探测失败不阻断还原（与 3.0.18 peek 语义一致）
          }
        }
        setPassErr('');
        setPassOpen(true);
        return; // 等用户输入；processing 保持 true，队列不前进
      }
      // v1 / zip / unknown：沿用既有二次确认 + 旧还原通道（跨机无密钥由主进程抛 E_KEY_MISSING）
      const go = await api.showConfirm!(t('settings.confirmRestore'));
      if (!go) {
        finish();
        return;
      }
      try {
        await api.restoreBackup(req.path);
        finish();
      } catch (e: any) {
        showToast(t('settings.restoreFailed', { err: e?.message || String(e) }), { error: true });
        finish();
      }
    } catch (e: any) {
      showToast(t('settings.restoreFailed', { err: e?.message || String(e) }), { error: true });
      finish();
    }
  };

  // 还原队列：一次只处理一个请求
  useEffect(() => {
    if (processing || current) return;
    const next = restoreQueue[0];
    if (!next) return;
    setRestoreQueue((q) => q.slice(1));
    setCurrent(next);
    setProcessing(true);
    void handleRequestRef.current(next);
  }, [restoreQueue, processing, current]);

  /** v2 口令提交：失败原地报错、数据不动、不重启；成功由主进程 relaunch。 */
  const submitPass = useCallback(
    async (pass: string): Promise<void> => {
      if (!current || busy) return;
      setBusy(true);
      setPassErr('');
      try {
        await api.restorePortableBackup(current.path, pass);
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        setPassErr(
          msg.includes('E_BAD_PASSPHRASE')
            ? t('settings.restorePassWrong')
            : t('settings.restoreFailed', { err: msg })
        );
        setBusy(false);
      }
    },
    [current, busy, t]
  );

  const cancelPass = useCallback(() => {
    finish();
  }, [finish]);

  const overlay =
    dragActive && !passOpen
      ? createPortal(
          <div className="quick-import-overlay backup-drop-overlay">
            <div className="quick-import-card">{t('settings.restoreDropHint')}</div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      {overlay}
      {created && (
        <PassphraseDialog
          mode="display"
          open={createdVisible}
          passphrase={created.passphrase}
          title={t('settings.backupPassTitle')}
          description={t('settings.backupPassDesc')}
          warning={t('settings.backupPassOnce')}
          copyLabel={t('settings.backupPassCopy')}
          copiedLabel={t('settings.backupPassCopied')}
          doneLabel={t('settings.backupPassDone')}
          onClose={closeCreated}
        />
      )}
      {current && (
        <PassphraseDialog
          mode="input"
          open={passOpen}
          error={passErr}
          busy={busy}
          title={t('settings.restorePassTitle')}
          description={t('settings.restorePassDesc')}
          submitLabel={t('settings.restorePassSubmit')}
          cancelLabel={t('confirm.cancel')}
          showLabel={t('settings.passShow')}
          hideLabel={t('settings.passHide')}
          onSubmit={(pass) => void submitPass(pass)}
          onClose={cancelPass}
        />
      )}
      <ToastView toast={toast} />
    </>
  );
};

export default BackupRestoreHost;
