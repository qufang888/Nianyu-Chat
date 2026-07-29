// 模块级存储：按 chatKey 保存主动消息的最后活跃时间（用于跨会话切换保持）
const store = new Map<string, number>();

export function getIdleActivity(chatKey: string): number | undefined {
  return store.get(chatKey);
}

export function setIdleActivity(chatKey: string, t: number): void {
  store.set(chatKey, t);
}

export function deleteIdleActivity(chatKey: string): void {
  store.delete(chatKey);
}

/** 清除所有存储（组件卸载时使用） */
export function clearAllIdle(): void {
  store.clear();
}
