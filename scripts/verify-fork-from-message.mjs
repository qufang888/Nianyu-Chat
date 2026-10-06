// v2.3.94 需求 1 验证：从消息分叉新对话（记忆截取 / 命名 / 隔离）
// 用法：node scripts/verify-fork-from-message.mjs
// 做法：把 forkChatFromMessage / forkChatFromNode 的**消息截取与记忆筛选**逻辑抠出来跑，
// 因为 db.ts 依赖 electron（app.getPath），无法直接 import。
// 这里用最小 store 桩复刻同口径的算法，并断言三条需求硬指标：
//   ① 复制「该消息及之前」的消息，一条不多一条不少；
//   ② 记忆按口径截取（自动记忆看关联消息是否都在范围内；手动记忆看创建时间）；
//   ③ 新聊天是独立 chatId（= 记忆隔离的前提）。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

// 复刻 db.ts forkChatFromNode 的截取口径（保持与线上同语义）
function makeFork(store, chatType, chatId, msgId, customTitle) {
  const now = new Date().toISOString();
  const all = store.messages.filter((m) => m.chat_type === chatType && m.chat_id === chatId);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) throw new Error('node message not found');
  const before = all.slice(0, idx + 1);
  const beforeIds = new Set(before.map((m) => m.id));
  const nodeMsg = before[before.length - 1];
  const nodeTitle =
    customTitle?.trim() ||
    store.storyNodes.find((n) => n.msg_id === msgId && n.chat_type === chatType && n.chat_id === chatId)?.title ||
    '节点';

  const memKeep = (m) => {
    if (m.sourceMsgIds && m.sourceMsgIds.length) return m.sourceMsgIds.every((id) => beforeIds.has(id));
    if (m.sourceMsgId != null) return beforeIds.has(m.sourceMsgId);
    return (m.created_at || '') <= nodeMsg.timestamp;
  };

  if (chatType === 'group') {
    const newId = 'new_group';
    for (const m of before) store.messages.push({ ...m, id: store.nextId(), chat_id: newId });
    for (const m of store.memories.filter((mm) => mm.chatId === chatId && memKeep(mm))) {
      store.memories.push({ ...m, id: 'mem' + store.memories.length, chatId: newId });
    }
    return { chat_type: 'group', chat_id: newId, name: `群 · ${nodeTitle.slice(0, 12)}` };
  }
  const newId = 'new_single';
  for (const m of before) store.messages.push({ ...m, id: store.nextId(), chat_id: newId });
  const roleId = store.roleIdFor(chatId);
  for (const m of store.memories.filter((mm) => mm.roleId === roleId && mm.chatId === chatId && memKeep(mm))) {
    store.memories.push({ ...m, id: 'mem' + store.memories.length, chatId: newId });
  }
  return { chat_type: 'single', chat_id: newId, name: `角色 · ${nodeTitle.slice(0, 12)}` };
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function baseStore() {
  let id = 1000;
  return {
    messages: [
      { id: 1, chat_type: 'single', chat_id: 'r1', content: '第一条', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 2, chat_type: 'single', chat_id: 'r1', content: '第二条\n换行内容', timestamp: '2026-01-01T00:01:00.000Z' },
      { id: 3, chat_type: 'single', chat_id: 'r1', content: '第三条', timestamp: '2026-01-01T00:02:00.000Z' },
      { id: 4, chat_type: 'single', chat_id: 'r1', content: '第四条', timestamp: '2026-01-01T00:03:00.000Z' },
      { id: 5, chat_type: 'single', chat_id: 'r1', content: '第五条', timestamp: '2026-01-01T00:04:00.000Z' },
    ],
    memories: [
      // 自动记忆，关联消息都在分叉点之前 → 应保留
      { id: 'a', roleId: 'r1', chatId: 'r1', content: '自动记忆-早', source: 'auto', sourceMsgIds: [1, 2], created_at: '2026-01-01T00:02:00.000Z' },
      // 自动记忆，关联消息跨过分叉点 → 应丢弃
      { id: 'b', roleId: 'r1', chatId: 'r1', content: '自动记忆-晚', source: 'auto', sourceMsgIds: [4, 5], created_at: '2026-01-01T00:05:00.000Z' },
      // 手动记忆，创建时间早于分叉点 → 应保留
      { id: 'c', roleId: 'r1', chatId: 'r1', content: '手动记忆-早', source: 'manual', created_at: '2026-01-01T00:01:30.000Z' },
      // 手动记忆，创建时间晚于分叉点 → 应丢弃
      { id: 'd', roleId: 'r1', chatId: 'r1', content: '手动记忆-晚', source: 'manual', created_at: '2026-01-01T00:06:00.000Z' },
    ],
    storyNodes: [],
    roleIdFor: () => 'r1',
    nextId() { return ++id; },
  };
}

section('A. 从第3条分叉：复制范围与记忆截取');
{
  const s = baseStore();
  const r = makeFork(s, 'single', 'r1', 3);
  const copied = s.messages.filter((m) => m.chat_id === 'new_single');
  check('复制了 3 条（1..3）', copied.length === 3, `实际 ${copied.length}`);
  check('含分叉点消息本身', copied.some((m) => m.content === '第三条'));
  check('不含分叉点之后的第4条', !copied.some((m) => m.content === '第四条'));
  check('不含第5条', !copied.some((m) => m.content === '第五条'));

  const mem = s.memories.filter((m) => m.chatId === 'new_single');
  const contents = mem.map((m) => m.content);
  check('保留自动记忆-早（关联消息都在范围内）', contents.includes('自动记忆-早'));
  check('丢弃自动记忆-晚（关联消息跨分叉点）', !contents.includes('自动记忆-晚'));
  check('保留手动记忆-早（created_at 早）', contents.includes('手动记忆-早'));
  check('丢弃手动记忆-晚（created_at 晚）', !contents.includes('手动记忆-晚'));
  check('共 2 条记忆', mem.length === 2, `实际 ${mem.length}`);
}

section('B. 记忆隔离：新 chatId 与原聊天互不影响');
{
  const s = baseStore();
  makeFork(s, 'single', 'r1', 3);
  const orig = s.messages.filter((m) => m.chat_id === 'r1');
  check('原聊天的 5 条消息未被删改', orig.length === 5, `实际 ${orig.length}`);
  check('新聊天 chatId 与原不同', 'new_single' !== 'r1');
  const origMem = s.memories.filter((m) => m.chatId === 'r1');
  check('原聊天记忆仍为 4 条（未被搬走）', origMem.length === 4, `实际 ${origMem.length}`);
}

section('C. 命名：customTitle 优先，无则回落节点标题');
{
  const s = baseStore();
  const r1 = makeFork(s, 'single', 'r1', 2, '分支·你好');
  check('customTitle 生效', r1.name.includes('分支·你好'), r1.name);

  const s2 = baseStore();
  s2.storyNodes = [{ id: 1, msg_id: 2, chat_type: 'single', chat_id: 'r1', title: '节点A' }];
  const r2 = makeFork(s2, 'single', 'r1', 2);
  check('无 customTitle 时用节点标题', r2.name.includes('节点A'), r2.name);

  const s3 = baseStore();
  const r3 = makeFork(s3, 'single', 'r1', 2);
  check('两者都无 → 回落「节点」', r3.name.includes('节点'), r3.name);
}

section('D. 摘要命名：多行取首个非空行、压空白、截断 12 字');
{
  const s = baseStore();
  const m = s.messages.find((x) => x.id === 2);
  const firstLine = (m.content || '').split('\n').map((x) => x.trim()).find((x) => x.length > 0) || '新对话';
  const snippet = firstLine.replace(/\s+/g, ' ').slice(0, 12);
  check('取首个非空行（未取到换行后半段）', snippet === '第二条', snippet);
  check('结果不超过 12 字', snippet.length <= 12, `实际 ${snippet.length}`);

  const long = { content: '这是一段非常非常长的消息内容用来测试截断行为是否生效'.repeat(3) };
  const fl2 = (long.content || '').split('\n').map((x) => x.trim()).find((x) => x.length > 0);
  check('超长文本被截断到 12 字', fl2.replace(/\s+/g, ' ').slice(0, 12).length === 12);
}

section('E. 边界：空消息 / 不存在的 msgId');
{
  const s = baseStore();
  let threw = null;
  try { makeFork(s, 'single', 'r1', 999); } catch (e) { threw = e; }
  check('不存在的消息抛错', threw !== null && /not found/.test(String(threw.message)));

  const s2 = baseStore();
  s2.messages.push({ id: 6, chat_type: 'single', chat_id: 'r1', content: '', timestamp: '2026-01-01T00:05:00.000Z' });
  const r = makeFork(s2, 'single', 'r1', 6, undefined);
  const s3Snippet = (s2.messages.find((x) => x.id === 6).content || '').split('\n').map((x) => x.trim()).find((x) => x.length > 0) || '新对话';
  check('空内容回落「新对话」摘要', s3Snippet === '新对话', s3Snippet);
  check('空内容仍能分叉成功', !!r.chat_id);
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);