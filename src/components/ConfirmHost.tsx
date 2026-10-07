import React, { useCallback, useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { useI18n } from '../i18n/I18nContext';
import { api } from '../ipc';

/**
 * 确认框宿主（v2.3.97）—— 把「主进程请求 → 自绘弹窗 → 回传结果」这条链路接起来。
 *
 * 挂在 `src/main.tsx` 的顶层（与 `<App />` / `<MiniChat />` **并列**，不是它们的孩子），
 * 因此**主窗与小窗共享同一个宿主**，两边都能弹确认框、无需第二套通道。
 *
 * 为什么用「队列」而不是「同时只弹一个」：
 * 主进程可能连续发来多个请求（例如用户快速点了几次删除）。若「后来的顶掉前面的」，
 * 前一个请求就永远拿不到结果，只能等 60s 超时 —— 表现为「点了删除没反应」。
 * 队列保证每个请求都会被弹出来、都会被用户看到、都会拿到确定的答复。
 */
interface ConfirmRequest {
  id: number;
  message: string;
  title: string;
  danger: boolean;
}

const ConfirmHost: React.FC = () => {
  /**
   * 走 useI18n 取文案（而非自己读 settings.lang 二选一）。
   *
   * v2.3.97 初版这里只判 `lang === 'en'`：在德语/日语/俄语界面里，确认框的按钮
   * 会显示英文，而正文却是本地化的 —— 这在「所有弹窗都适配软件风格」的要求下是硬伤，
   * 而且与本项目其余 10 语言体系不一致。现在按钮与默认标题全部走字典，
   * 10 语言齐备（键：confirm.ok / confirm.cancel / confirm.title）。
   *
   * 注意 message 与 title 仍是主进程/调用方传来的**最终文案**（调用方自己 t() 过），
   * 这里只负责「按钮 + 主进程没给标题时的兜底标题」。
   */
  const { t } = useI18n();

  /** 待处理队列（排队语义） */
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  /** 当前正在展示的请求。**退场期间也不清空**，否则组件会提前卸载、播不出退场动画。 */
  const [active, setActive] = useState<ConfirmRequest | null>(null);
  /** 是否展开。answer 时置 false → ConfirmDialog 播退场动画后再卸载内部 DOM */
  const [visible, setVisible] = useState(false);

  // 订阅主进程推送
  useEffect(() => {
    const off = api.onConfirmAsk?.((req: { id: number; message: string; title?: string; danger?: boolean }) => {
      setQueue((prev) => [
        ...prev,
        {
          id: req.id,
          message: req.message || '',
          title: req.title || '',
          danger: !!req.danger,
        },
      ]);
    });
    return () => off?.();
  }, []);

  // 队列里没人展示时，取队首顶上
  useEffect(() => {
    if (visible && active) return;
    const next = queue[0];
    if (!next) return;
    setActive(next);
    setVisible(true);
  }, [queue, visible, active]);

  /** 回传结果并出队 */
  const answer = useCallback((id: number, ok: boolean) => {
    // 先回传：主进程侧的 Promise 立刻落地，用户不会被退场动画拖住
    api.confirmReply?.(id, ok);
    setQueue((prev) => prev.filter((q) => q.id !== id));
    // 只关不卸载：visible=false 让内部 useRetract 播退场，active 保留到下一个请求覆盖
    setVisible(false);
  }, []);

  // 首次渲染（还没有任何请求）时不挂载组件，避免多一个空的 portal 容器
  if (!active) return null;

  return (
    <ConfirmDialog
      open={visible}
      message={active.message}
      title={active.title || t('confirm.title')}
      danger={active.danger}
      confirmLabel={t('confirm.ok')}
      cancelLabel={t('confirm.cancel')}
      onConfirm={() => answer(active.id, true)}
      onCancel={() => answer(active.id, false)}
    />
  );
};

export default ConfirmHost;