/**
 * 可携带备份渲染层进程内事件总线（v3.0.19）。
 *
 * 定位：只负责「Settings / main.tsx 拖放 → BackupRestoreHost」的跨组件通知，
 * 不是 IPC（不跨进程）。Host 挂在 main.tsx 顶层，主窗与 #mini 小窗共享同一入口，
 * 因此每个窗口各自一份总线，天然只影响本窗。
 *
 * 口令绝不经过本总线：创建成功后 PortableCreateResult 里的 passphrase 只用于
 * Host 的一次性展示态，关闭即丢弃，不写任何持久层。
 */
import type { PortableCreateResult, RestoreRequest } from '../types';

export interface CreatedEvent {
  result: PortableCreateResult;
}

export type RestoreEvent = RestoreRequest;
export type Unsub = () => void;

const createdSubs = new Set<(e: CreatedEvent) => void>();
const restoreSubs = new Set<(e: RestoreEvent) => void>();
const dragSubs = new Set<(active: boolean) => void>();

/**
 * 拖放门控（渲染侧镜像）：仅 .ny（大小写不敏感）由备份流程接管；
 * .zip / .vrm / 角色卡等一律放行，保证既有快速导入零回归。
 * 主进程侧唯一真源为 electron/portableBackup.ts 的同名函数。
 */
export function isPortableBackupFile(name: string): boolean {
  return /\.ny$/i.test(String(name || ''));
}

export const backupBus = {
  /** 创建备份成功 → 请求一次性展示口令。 */
  showCreated(result: PortableCreateResult): void {
    createdSubs.forEach((cb) => cb({ result }));
  },
  onShowCreated(cb: (e: CreatedEvent) => void): Unsub {
    createdSubs.add(cb);
    return () => createdSubs.delete(cb);
  },
  /** 请求还原（拖放 / 设置页文件选择器）。 */
  requestRestore(req: RestoreEvent): void {
    restoreSubs.forEach((cb) => cb(req));
  },
  onRequestRestore(cb: (e: RestoreEvent) => void): Unsub {
    restoreSubs.add(cb);
    return () => restoreSubs.delete(cb);
  },
  /** 拖入 / 离开状态，驱动 Host 的 overlay。 */
  setDragActive(active: boolean): void {
    dragSubs.forEach((cb) => cb(active));
  },
  onDragActive(cb: (active: boolean) => void): Unsub {
    dragSubs.add(cb);
    return () => dragSubs.delete(cb);
  },
};

export default backupBus;
