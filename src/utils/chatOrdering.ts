// 聊天列表排序 / 置顶 / 拖拽排序共享逻辑
// 主界面 ChatList 与悬浮球聊天选择面板共用，保证两端排序一致。
// 排序规则：置顶（pinnedChats）永远在最上；同一组内按 chatOrder 手动顺序；
// 不在 chatOrder 里的聊天（新建等）按后端返回顺序（最近活跃）追加在组内末尾。

export type SortableChat = { chat_type: string; chat_id: string };

export const chatKeyOf = (it: SortableChat): string => `${it.chat_type}:${it.chat_id}`;

export function sortChats<T extends SortableChat>(items: T[], pinned?: string[], order?: string[]): T[] {
  const pin = new Set(pinned || []);
  const idx = new Map<string, number>();
  (order || []).forEach((k, i) => idx.set(k, i));
  return items
    .map((it, i) => ({ it, i, key: chatKeyOf(it) }))
    .sort((a, b) => {
      const pa = pin.has(a.key) ? 0 : 1;
      const pb = pin.has(b.key) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const oa = idx.has(a.key) ? (idx.get(a.key) as number) : Number.MAX_SAFE_INTEGER;
      const ob = idx.has(b.key) ? (idx.get(b.key) as number) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

// 置顶 / 取消置顶：返回新的 pinnedChats 数组
export function togglePinnedChat(pinned: string[] | undefined, key: string): string[] {
  const cur = [...(pinned || [])];
  const i = cur.indexOf(key);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(key);
  return cur;
}

// 拖拽排序：把 dragKey 移动到 targetKey 当前所在位置，返回新的完整顺序数组。
// 采用「拖动插入到目标位置」语义：置顶区与普通区各自连续，跨区拖动会把元素带入目标区。
export function applyDragOrder(visibleKeys: string[], dragKey: string, targetKey: string): string[] {
  if (!dragKey || !targetKey || dragKey === targetKey) return visibleKeys;
  const arr = visibleKeys.filter((k) => k !== dragKey);
  const ti = arr.indexOf(targetKey);
  if (ti < 0) return visibleKeys;
  arr.splice(ti, 0, dragKey);
  return arr;
}
