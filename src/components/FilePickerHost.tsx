import React, { useCallback, useEffect, useState } from 'react';
import FilePickerModal from './FilePickerModal';
import { api } from '../ipc';

/**
 * 文件选择器宿主（v2.3.97）—— 把「主进程请求 → 自绘选择器 → 回传路径」这条链路接起来。
 *
 * 与 {@link ConfirmHost} 挂在同一层（`src/main.tsx` 顶层，与 `<App />` / `<MiniChat />` 并列），
 * 因此主窗与小窗都能用。
 *
 * 同样采用**队列**语义：主进程可能连续发多个选择请求（例如用户快速点了两次导入），
 * 顶掉前一个会让它的 Promise 悬挂到超时，表现为「点了没反应」。
 */
interface PickRequest {
  id: number;
  kind: 'open' | 'save' | 'directory';
  title: string;
  filters: { name: string; extensions: string[] }[];
  multiple: boolean;
  defaultName: string;
  startDir: string;
  unique: boolean;
}

const FilePickerHost: React.FC = () => {
  /** 待处理队列（排队语义，保证每个请求都被用户看到、都能拿到确定答复） */
  const [queue, setQueue] = useState<PickRequest[]>([]);
  /** 当前正在展示的请求。**退场期间也不清空**，否则组件会提前卸载。 */
  const [active, setActive] = useState<PickRequest | null>(null);
  /** 是否展开。answer 时置 false → FilePickerModal 播退场动画后再卸载内部 DOM */
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const off = api.onFilePickAsk?.((req: {
      id: number;
      kind: 'open' | 'save' | 'directory';
      title?: string;
      filters?: { name: string; extensions: string[] }[];
      multiple?: boolean;
      defaultName?: string;
      startDir?: string;
      unique?: boolean;
    }) => {
      const item: PickRequest = {
        id: req.id,
        kind: req.kind,
        title: req.title || '',
        filters: req.filters || [],
        multiple: !!req.multiple,
        defaultName: req.defaultName || '',
        startDir: req.startDir || '',
        unique: !!req.unique,
      };
      setQueue((prev) => [...prev, item]);
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

  /**
   * 回传结果并出队。
   * @param id 请求 id
   * @param paths 选中路径；取消为 null（与旧实现的取消语义一致）
   */
  const answer = useCallback((id: number, paths: string[] | null) => {
    // 先回传：主进程侧的 Promise 立刻落地，用户不会被退场动画拖住
    api.filePickReply?.(id, paths);
    setQueue((prev) => prev.filter((q) => q.id !== id));
    // 只关不卸载：visible=false 让内部 useRetract 播退场，active 保留到下一个请求覆盖
    setVisible(false);
  }, []);

  // 首次渲染（还没有任何请求）时不挂载组件，避免多一个空的 portal 容器
  if (!active) return null;

  return (
    <FilePickerModal
      open={visible}
      kind={active.kind}
      title={active.title}
      filters={active.filters}
      multiple={active.multiple}
      defaultName={active.defaultName}
      startDir={active.startDir}
      unique={active.unique}
      onConfirm={(paths) => answer(active.id, paths)}
      onCancel={() => answer(active.id, null)}
    />
  );
};

export default FilePickerHost;