// 模块级存储：按 chatKey 保存随机事件状态，组件卸载时保存、重新挂载时恢复
import type { RandomEventData } from '../components/RandomEventModal';

export interface ChatEventData {
  event: RandomEventData | null;
  loading: boolean;
}

const store = new Map<string, ChatEventData>();

// 聊天切换时清理过期条目（保留最近使用的 N 个）
const MAX_ENTRIES = 50;
const accessOrder: string[] = [];

function touch(key: string) {
  const idx = accessOrder.indexOf(key);
  if (idx !== -1) accessOrder.splice(idx, 1);
  accessOrder.push(key);
  if (accessOrder.length > MAX_ENTRIES) {
    const oldest = accessOrder.shift();
    if (oldest) store.delete(oldest);
  }
}

export function getEventStore(chatKey: string): ChatEventData {
  return store.get(chatKey) || { event: null, loading: false };
}

export function setEventStore(chatKey: string, data: ChatEventData): void {
  store.set(chatKey, data);
  touch(chatKey);
}

export function deleteEventStore(chatKey: string): void {
  store.delete(chatKey);
  const idx = accessOrder.indexOf(chatKey);
  if (idx !== -1) accessOrder.splice(idx, 1);
}
