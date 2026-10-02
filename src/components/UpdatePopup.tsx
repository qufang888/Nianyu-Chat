import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { UpdateStatus } from '../types';

// 更新提醒弹窗（v2.3.48，仅主窗挂载于 App.tsx）：
// - 主进程自动检查发现新版本时弹出（手动检查不弹，用户已在设置页看到结果）；
// - 每个版本只弹一次：任一按钮关闭弹窗时写入 settings.updatePopupShownVersion；
// - 用户在设置中「关闭更新提醒」（settings.disableUpdateReminder）后不再弹出，已打开的弹窗立即收起。
export const UpdatePopup: React.FC = () => {
  const { t } = useI18n();
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const stRef = useRef<UpdateStatus | null>(null);
  const openRef = useRef(false); // 弹窗当前是否打开（供事件回调读取，避免闭包过期）
  const reminderOffRef = useRef(false); // settings.disableUpdateReminder
  const shownVerRef = useRef(''); // settings.updatePopupShownVersion（已弹过的版本）
  const sessionShownRef = useRef<Set<string>>(new Set()); // 本次会话已弹（等待设置写回期间的防抖）

  // 触发条件全部满足才弹：有新版本 + 未永久关闭提醒 + 非手动检查 + 该版本未弹过
  const maybeShow = useCallback(() => {
    if (openRef.current) return;
    const s = stRef.current;
    if (!s || s.state !== 'available' || !s.latestVersion) return;
    if (reminderOffRef.current) return;
    if (s.manual === true) return;
    if (shownVerRef.current === s.latestVersion) return;
    if (sessionShownRef.current.has(s.latestVersion)) return;
    sessionShownRef.current.add(s.latestVersion);
    openRef.current = true;
    setOpen(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .updateStatus()
      .then((s) => {
        if (!alive) return;
        stRef.current = s;
        setSt(s);
      })
      .catch(() => {});
    void api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        reminderOffRef.current = s?.disableUpdateReminder === true;
        shownVerRef.current = s?.updatePopupShownVersion || '';
        maybeShow();
      })
      .catch(() => {});
    const offSt = api.onUpdateStatus((_e, data) => {
      stRef.current = data;
      setSt(data);
      maybeShow();
    });
    const offSet = api.onSettingsChanged(async (_e, patch: Record<string, any>) => {
      if (!patch) return;
      if (patch.disableUpdateReminder === undefined && patch.updatePopupShownVersion === undefined) return;
      try {
        const s = await api.getSettings();
        if (!alive) return;
        reminderOffRef.current = s?.disableUpdateReminder === true;
        shownVerRef.current = s?.updatePopupShownVersion || '';
        if (reminderOffRef.current) {
          // 永久关闭提醒后立即收起已打开的弹窗
          openRef.current = false;
          setOpen(false);
        }
      } catch {
        /* 设置读取失败忽略 */
      }
    });
    return () => {
      alive = false;
      offSt();
      offSet();
    };
  }, [maybeShow]);

  // 关闭弹窗并记录「已弹过」的版本：下载/查看发布页/稍后都记录，避免每 6 小时自动检查都弹一次
  const close = (ver: string) => {
    openRef.current = false;
    setOpen(false);
    shownVerRef.current = ver;
    void api.saveSettings({ updatePopupShownVersion: ver }).catch(() => {});
  };

  if (!open || !st?.latestVersion) return null;
  const v = st.latestVersion;
  return (
    <div className="modal-mask">
      {/* 点击遮罩不关闭：强制走按钮（避免误触把「提醒」静默消费掉） */}
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: '92vw' }}>
        <div className="modal-head">
          <span>{t('updatePopup.title', { v })}</span>
          <span className="modal-close" onClick={() => close(v)}>
            ×
          </span>
        </div>
        <div className="modal-body" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 36, margin: '2px 0 8px' }}>🎉</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
            {t('updatePopup.body', { cur: st.currentVersion || '' })}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              className="btn-primary"
              onClick={() => {
                void api.downloadUpdate();
                close(v); // 下载进度由聊天界面提示条 / 设置页展示
              }}
            >
              {t('updatePopup.download')}
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                void api.openReleasePage();
                close(v);
              }}
            >
              {t('updatePopup.release')}
            </button>
            <button className="btn-ghost" onClick={() => close(v)}>
              {t('updatePopup.later')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
