// ===== 请求队列管理器（v2.3.46）=====
// 把「QPS 超限时各请求各自 sleep 同样时长后齐发」改为「真队列：入队 → 按顺序逐个放行」，
// 同一模型（限速键）的所有待发请求排成一列，队头倒计时结束后依次放行，间隔制 QPS 真实生效。
// 前端主界面有贴边排队面板（QueueDock），可查看各模型队列并手动调整发送顺序；
// 小窗与悬浮球不提供该面板，但其请求同样走本队列。
// 注意：本模块不 import main.ts（避免循环依赖），广播函数与模型信息提供器由 main.ts init 注入。

export const RATE_WINDOW_MS = 60000;

// 请求时间戳记录（沿用 v2.3.40 语义：间隔制 + 60 秒滑动窗口双重约束）
const modelRequestLog = new Map<string, number[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 计算某限速键还需等待多少毫秒才能再发一次；qps 由调用方给出
// （已保存模型=其配置值；未保存草稿=表单当前填写值）。
// 支持小数 qps：改用「间隔制」判定，两次请求至少间隔 60000/qps 毫秒（qps=0.5 → 120s，qps=2 → 30s）。
// 同时保留 60 秒滑动窗口计数，双重约束下既平滑了突发，也保证窗口内总量不超。
export function rateWaitMsKey(key: string, qps?: number): number {
  if (!qps || qps <= 0 || !Number.isFinite(qps)) return 0;
  const now = Date.now();
  const arr = (modelRequestLog.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  modelRequestLog.set(key, arr);
  // 1) 间隔等待：距上一次请求需满 60000/qps 毫秒
  const interval = Math.round(RATE_WINDOW_MS / qps);
  const intervalWait = arr.length > 0 ? Math.max(0, interval - (now - arr[arr.length - 1])) : 0;
  // 2) 窗口计数等待：窗口内已达上限时，等最早一条滚出窗口
  const countWait =
    arr.length >= Math.ceil(qps) ? Math.max(0, RATE_WINDOW_MS - (now - arr[0]) + 50) : 0;
  return Math.max(intervalWait, countWait);
}

// 标记一次实际发出的请求（用于计数）
export function rateMark(modelId: string): void {
  if (!modelId) return;
  const now = Date.now();
  const arr = (modelRequestLog.get(modelId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  modelRequestLog.set(modelId, arr);
}

// ===== 队列数据结构 =====
interface QItem {
  id: string; // 队列项唯一 id（前端调序用）
  label: string; // 请求来源标签（硬编码简体中文，如「聊天回复」）
  enqueuedAt: number; // 入队时间戳 ms
  resolve: (waitedMs: number) => void;
}
interface Lane {
  key: string; // 限速键（模型 id 或草稿合成键）
  qps: number; // 本 lane 生效的 qps（最近一次入队调用方给出的值；草稿探测用表单值）
  items: QItem[];
  inFlight: boolean; // 队头是否正在倒计时（锁定，不可调序）
  headDeadline: number; // 队头预计放行时间戳；0=未在倒计时
}

const lanes = new Map<string, Lane>();
let seq = 0;

// 广播函数与模型信息提供器（由 main.ts init 注入，避免循环依赖）
interface ModelInfo {
  name: string;
  qps?: number;
}
let broadcaster: (channel: string, payload: unknown) => void = () => {};
let getModelInfo: (key: string) => ModelInfo = (key) => ({ name: key, qps: 0 });

export function initQueueBroadcaster(fn: (channel: string, payload: unknown) => void): void {
  broadcaster = fn;
}
export function initQueueInfoProvider(fn: (key: string) => ModelInfo): void {
  getModelInfo = fn;
}

// ===== 队列快照（前端面板数据源）=====
export interface QueueSnapshotItem {
  id: string;
  label: string;
  enqueuedAt: number;
  etaMs: number; // 预计还需等待的毫秒（估算值）
  locked: boolean; // 队头正在倒计时，锁定不可调序
}
export interface QueueSnapshotLane {
  key: string;
  modelName: string;
  qps: number;
  intervalMs: number;
  items: QueueSnapshotItem[];
}
export interface QueueSnapshotPayload {
  lanes: QueueSnapshotLane[];
  total: number;
}

function normalizeQps(qps: number | undefined): number {
  return qps && qps > 0 && Number.isFinite(qps) ? qps : 0;
}

export function queueSnapshotPayload(): QueueSnapshotPayload {
  const now = Date.now();
  let total = 0;
  const lanesArr: QueueSnapshotLane[] = [];
  for (const lane of lanes.values()) {
    const qps = lane.qps > 0 ? lane.qps : normalizeQps(getModelInfo(lane.key).qps);
    const intervalMs = qps > 0 ? Math.round(RATE_WINDOW_MS / qps) : 1000;
    // 队头 ETA：正在倒计时用 headDeadline，否则按当前计数现算
    const headEta =
      lane.inFlight && lane.headDeadline > now ? lane.headDeadline - now : rateWaitMsKey(lane.key, qps);
    const items: QueueSnapshotItem[] = lane.items.map((it, idx) => ({
      id: it.id,
      label: it.label,
      enqueuedAt: it.enqueuedAt,
      // 第 k 项 ≈ 队头 ETA + k×间隔（估算值，仅供展示；真实放行以 rateWaitMsKey 为准）
      etaMs: Math.max(0, Math.round(headEta + idx * intervalMs)),
      locked: idx === 0 && lane.inFlight,
    }));
    total += items.length;
    lanesArr.push({ key: lane.key, modelName: getModelInfo(lane.key).name || lane.key, qps, intervalMs, items });
  }
  return { lanes: lanesArr, total };
}

function broadcastSnapshot(): void {
  try {
    broadcaster('queue:changed', queueSnapshotPayload());
  } catch (e) {
    console.warn('[nianyu] queue broadcast skip:', (e as Error)?.message);
  }
}

// 队头放行泵：lane 未在飞且有等待项时启动；放行后若队列排空则删除 lane。
// inFlight 标志保证同一 lane 不会重入（防重入）。
async function pump(key: string): Promise<void> {
  const lane = lanes.get(key);
  if (!lane || lane.inFlight || lane.items.length === 0) return;
  lane.inFlight = true;
  try {
    while (lane.items.length > 0) {
      const qps = lane.qps > 0 ? lane.qps : normalizeQps(getModelInfo(key).qps);
      const wait = rateWaitMsKey(key, qps);
      lane.headDeadline = Date.now() + wait;
      broadcastSnapshot();
      if (wait > 0) await sleep(wait);
      rateMark(key);
      const item = lane.items.shift();
      lane.headDeadline = 0;
      if (item) item.resolve(Math.max(0, Date.now() - item.enqueuedAt));
      broadcastSnapshot();
    }
  } finally {
    lane.inFlight = false;
    const cur = lanes.get(key);
    if (cur && cur.items.length === 0) lanes.delete(key);
  }
}

// 入队并等待放行；返回实际排队等待毫秒（0=未排队直接放行）。
// qps 无效（<=0/NaN）时保持旧行为：不排队、直接记一次请求额度后立即放行。
export function enqueueAndWait(key: string, qps: number | undefined, label: string): Promise<number> {
  if (!key) return Promise.resolve(0);
  if (!qps || qps <= 0 || !Number.isFinite(qps)) {
    rateMark(key);
    return Promise.resolve(0);
  }
  seq += 1;
  const id = `q${seq}_${Math.random().toString(36).slice(2, 8)}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = { key, qps: 0, items: [], inFlight: false, headDeadline: 0 };
    lanes.set(key, lane);
  }
  // 最近一次入队给出的 qps 生效（草稿探测的表单值也参与限速，与 v2.3.40 语义一致）
  lane.qps = normalizeQps(qps);
  const item: QItem = { id, label, enqueuedAt: Date.now(), resolve: () => {} };
  return new Promise<number>((resolve) => {
    item.resolve = resolve;
    lane!.items.push(item);
    broadcastSnapshot();
    void pump(key);
  });
}

// 手动调序：orderedIds 为调整后的完整顺序（前端面板传来，含队头 id）。
// 队头正在倒计时（inFlight）时队头锁定：忽略 orderedIds 中的队头 id，其余项必须与队列其余项一一对应。
// 成功返回 true 并广播新快照；队列不存在 / id 集合不匹配返回 false。
export function reorderQueue(key: string, orderedIds: string[]): boolean {
  const lane = lanes.get(key);
  if (!lane || orderedIds.length === 0) return false;
  // 防御：重复 id 拒绝（否则同一 QItem 被塞两次，被顶掉的项 promise 永不 resolve）
  if (new Set(orderedIds).size !== orderedIds.length) return false;
  const currentIds = lane.items.map((i) => i.id);
  const idSet = new Set(currentIds);
  const map = new Map(lane.items.map((i) => [i.id, i]));
  if (lane.inFlight) {
    const head = lane.items[0];
    const restIds = currentIds.slice(1);
    const filtered = orderedIds.filter((id) => id !== head.id);
    // 其余项的集合必须与队列其余项完全一致（不得增删）
    if (
      filtered.length !== restIds.length ||
      !filtered.every((id) => idSet.has(id)) ||
      !restIds.every((id) => filtered.includes(id))
    ) {
      return false;
    }
    lane.items = [head, ...filtered.map((id) => map.get(id) as QItem)];
  } else {
    if (orderedIds.length !== currentIds.length || !orderedIds.every((id) => idSet.has(id))) return false;
    lane.items = orderedIds.map((id) => map.get(id) as QItem);
  }
  broadcastSnapshot();
  return true;
}
