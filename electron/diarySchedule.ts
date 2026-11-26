/**
 * 念语 v3.0.24 日记 AI 留言调度器（纯函数排程 + 单例编排器）。
 *
 * 边界：不 import main.ts；store 与 AI / 通知 / NHPP 全部通过 deps 注入。
 * 聊天 NHPP、聊天 store、总结链路一行不改；无配置角色由调用方保留 v3.0.23 立即生成行为。
 */
import type {
  AppSettings,
  DiaryAiResult,
  DiaryCommentConfig,
  DiaryCommentTask,
  DiaryEntry,
  NormalTrigger,
} from '../src/types';
import { canRoleAccessDiary } from './diary';

export const DIARY_HEARTBEAT_PHASE_MS = 15_000;
export const DIARY_TASK_ID_PREFIX = 'dct_';

/** DiaryStore 中排程所需的最小读写面（便于自检脚本注入假 Store）。 */
export interface DiaryTaskStoreLike {
  listTasks(): DiaryCommentTask[];
  upsertTask(task: DiaryCommentTask): void;
  dropTasksForRole(diaryId: string, roleId: string, statuses?: DiaryCommentTask['status'][]): void;
  dropTasksForDiary(diaryId: string): void;
  commentLocked(diaryId: string, roleId: string): boolean;
  getDiary(id: string): DiaryEntry | undefined;
  listDiaries(): DiaryEntry[];
}

export interface DiaryScheduleDeps {
  getSettings(): AppSettings;
  getStore(): DiaryTaskStoreLike;
  /** tone='skip' 在发送时再判一次：保存时的好感/心情可能已变。 */
  isToneSkipped(diaryId: string, roleId: string): boolean;
  /** 只生成顶层留言（非 force）；实现内部含一人物一留言硬锁。 */
  generateComment(diaryId: string, roleId: string): Promise<DiaryAiResult>;
  notify?(diary: DiaryEntry, roleId: string, text: string): void;
  rescheduleNhpps(diaryId: string, roleId: string): void;
  clearNhppsForRole(diaryId: string, roleId: string): void;
  logError?(message: string): void;
}

/** 'HH:mm' → 本地分钟数；非法值返回 null（调用方退化为 delay 规则）。 */
export function parseHHmm(value: unknown): number | null {
  const s = String(value || '');
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 固定序列化指纹：与对象键顺序无关，enabled 不参与（由 cancelled 分支单独处理）。 */
export function diaryConfigFingerprint(config: DiaryCommentConfig): string {
  const normal = config?.normal || {};
  const core = {
    mode: String(config?.mode || 'normal'),
    normal: {
      trigger: String(normal.trigger || 'delay'),
      window: normal.window
        ? { start: String(normal.window.start || ''), end: String(normal.window.end || '') }
        : null,
      delayMinutes: Number.isFinite(normal.delayMinutes) ? Number(normal.delayMinutes) : null,
      fixedTime: normal.fixedTime ? String(normal.fixedTime) : null,
    },
    nhppOverride: config?.nhppOverride
      ? {
          dailyLimit: Number.isFinite(config.nhppOverride.dailyLimit) ? config.nhppOverride.dailyLimit : null,
          freshnessMin: Number.isFinite(config.nhppOverride.freshnessMin) ? config.nhppOverride.freshnessMin : null,
        }
      : null,
  };
  const stable = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return stable(core);
}

function clampDelay(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(1440, Math.round(n)));
}

function dayAt(base: Date, dayOffset: number, minutesOfDay: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + dayOffset);
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * 普通三子模式的到期时刻（本地时间计算 → 调用方存 ISO UTC）。
 * 全部使用注入的 rand / savedAt / now，便于假时钟可证伪测试。
 */
export function computeDiaryDueAt(
  trigger: NormalTrigger,
  savedAt: Date,
  config: DiaryCommentConfig,
  rand: () => number = Math.random
): Date {
  const normal = config?.normal || { trigger: 'delay' };
  if (trigger === 'delay') {
    return new Date(savedAt.getTime() + clampDelay(normal.delayMinutes) * 60_000);
  }
  if (trigger === 'fixed') {
    const at = parseHHmm(normal.fixedTime);
    if (at === null) return new Date(savedAt.getTime() + 60_000);
    let due = dayAt(savedAt, 0, at);
    if (due.getTime() <= savedAt.getTime()) due = dayAt(savedAt, 1, at);
    return due;
  }
  const start = parseHHmm(normal.window?.start);
  const end = parseHHmm(normal.window?.end);
  if (start === null || end === null) return new Date(savedAt.getTime() + 60_000);
  const total = ((end - start + 1440) % 1440) || 1440;
  const raw = rand();
  const r = Math.max(0, Math.min(0.999999999, Number.isFinite(raw) ? raw : 0));
  const offset = Math.floor(r * total);
  let due = new Date(dayAt(savedAt, 0, start).getTime() + offset * 60_000);
  if (due.getTime() <= savedAt.getTime()) due = new Date(due.getTime() + 24 * 3600_000);
  return due;
}

/** 调度器单例：所有变更都经 DiaryStore.save() 原子落盘。 */
export class DiaryCommentScheduler {
  private deps: DiaryScheduleDeps | null = null;
  private seq = 0;

  init(deps: DiaryScheduleDeps): void {
    this.deps = deps;
    this.seq = 0;
  }

  private requireDeps(): DiaryScheduleDeps {
    if (!this.deps) throw new Error('日记留言调度器尚未初始化');
    return this.deps;
  }

  private newTaskId(): string {
    this.seq += 1;
    return `${DIARY_TASK_ID_PREFIX}${Date.now().toString(36)}_${this.seq.toString(36)}`;
  }

  private makeTask(
    diary: DiaryEntry,
    roleId: string,
    config: DiaryCommentConfig,
    dueAt: Date,
    createdAt: Date = new Date()
  ): DiaryCommentTask {
    return {
      id: this.newTaskId(),
      diaryId: diary.id,
      roleId,
      selfRoleId: diary.selfRoleId,
      kind: config.mode === 'nhpp' ? 'nhpp' : config.normal?.trigger || 'delay',
      status: 'pending',
      dueAt: dueAt.toISOString(),
      configFingerprint: diaryConfigFingerprint(config),
      createdAt: createdAt.toISOString(),
    };
  }

  /** 保存日记后分流；返回「无配置」角色，由调用方执行 v3.0.23 立即生成（兼容老用户）。 */
  onDiarySaved(diary: DiaryEntry, explicitRoleIds?: string[]): string[] {
    const deps = this.requireDeps();
    const configs = deps.getSettings().diaryCommentSchedules || {};
    const roles = explicitRoleIds && explicitRoleIds.length > 0
      ? explicitRoleIds
      : (Array.isArray(diary.visibleRoleIds) ? diary.visibleRoleIds : []);
    const legacy: string[] = [];
    const savedAt = new Date(diary.updated_at || diary.created_at || Date.now());
    for (const roleId of roles) {
      // 总开关关闭 / 角色已移出可见名单：不建任务，也不走 legacy；身份切换后旧任务不会复活。
      if (!canRoleAccessDiary(diary, roleId)) {
        deps.getStore().dropTasksForRole(diary.id, roleId, ['pending', 'due']);
        deps.clearNhppsForRole(diary.id, roleId);
        continue;
      }
      const config = configs[roleId];
      if (!config) {
        legacy.push(roleId);
        continue;
      }
      const store = deps.getStore();
      if (!config.enabled) {
        store.dropTasksForRole(diary.id, roleId, ['pending', 'due']);
        deps.clearNhppsForRole(diary.id, roleId);
        continue;
      }
      if (config.mode === 'nhpp') {
        store.dropTasksForRole(diary.id, roleId, ['pending', 'due']);
        deps.rescheduleNhpps(diary.id, roleId);
        continue;
      }
      // 一人物一留言：已经 sent 就不再为该篇建新任务；pending 旧任务由新配置取代。
      const sent = store.listTasks().some((t) =>
        t.diaryId === diary.id && t.roleId === roleId && t.status === 'sent');
      store.dropTasksForRole(diary.id, roleId, ['pending', 'due']);
      deps.clearNhppsForRole(diary.id, roleId);
      if (sent) continue;
      const due = computeDiaryDueAt(config.normal?.trigger || 'delay', savedAt, config);
      store.upsertTask(this.makeTask(diary, roleId, config, due, savedAt));
    }
    return legacy;
  }

  /** 配置变更：pending → superseded / cancelled，并按新配置重排（裁定 #4）。 */
  onConfigChanged(configs: Record<string, DiaryCommentConfig> | undefined): void {
    const deps = this.requireDeps();
    const store = deps.getStore();
    const next = configs || {};
    const now = new Date();
    for (const task of store.listTasks()) {
      if (task.status !== 'pending' && task.status !== 'due') continue;
      const diary = store.getDiary(task.diaryId);
      const config = next[task.roleId];
      if (!diary || !config || !config.enabled) {
        task.status = 'cancelled';
        task.updatedAt = now.toISOString();
        task.reason = 'config_changed';
        store.upsertTask(task);
        deps.clearNhppsForRole(task.diaryId, task.roleId);
        continue;
      }
      if (diaryConfigFingerprint(config) !== task.configFingerprint) {
        task.status = 'superseded';
        task.updatedAt = now.toISOString();
        task.reason = 'config_changed';
        store.upsertTask(task);
        if (config.mode === 'nhpp') {
          deps.rescheduleNhpps(diary.id, task.roleId);
        } else {
          const due = computeDiaryDueAt(config.normal?.trigger || 'delay', now, config);
          store.upsertTask(this.makeTask(diary, task.roleId, config, due, now));
        }
      }
    }
    // NHPP 角色没有普通任务，单独遍历该篇可见名单做重排 / 清除。
    for (const diary of store.listDiaries()) {
      for (const roleId of diary.visibleRoleIds || []) {
        const config = next[roleId];
        if (!canRoleAccessDiary(diary, roleId) || !config || config.mode !== 'nhpp') continue;
        if (config.enabled) deps.rescheduleNhpps(diary.id, roleId);
        else deps.clearNhppsForRole(diary.id, roleId);
      }
    }
  }

  /** 普通排程心跳：每轮最多发送一条；失败不吞，记日志且任务标 skipped。 */
  heartbeat(now: Date = new Date()): void {
    const deps = this.requireDeps();
    const store = deps.getStore();
    const due = store.listTasks()
      .filter((t) => (t.status === 'pending' || t.status === 'due') && Date.parse(t.dueAt) <= now.getTime())
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    for (const task of due) {
      const diary = store.getDiary(task.diaryId);
      if (!diary) {
        task.status = 'cancelled';
        task.updatedAt = now.toISOString();
        task.reason = 'diary_deleted';
        store.upsertTask(task);
        continue;
      }
      if (!canRoleAccessDiary(diary, task.roleId) || diary.selfRoleId !== task.selfRoleId) {
        task.status = 'skipped';
        task.updatedAt = now.toISOString();
        task.reason = 'gate';
        store.upsertTask(task);
        continue;
      }
      if (store.commentLocked(diary.id, task.roleId)) {
        task.status = 'skipped';
        task.updatedAt = now.toISOString();
        task.reason = 'locked';
        store.upsertTask(task);
        continue;
      }
      if (deps.isToneSkipped(diary.id, task.roleId)) {
        task.status = 'skipped';
        task.updatedAt = now.toISOString();
        task.reason = 'tone_skip';
        store.upsertTask(task);
        continue;
      }
      task.status = 'due';
      task.updatedAt = now.toISOString();
      store.upsertTask(task);
      void Promise.resolve()
        .then(() => deps.generateComment(diary.id, task.roleId))
        .then((res) => {
          if (res && res.generatedRoleIds.includes(task.roleId)) {
            task.status = 'sent';
            task.reason = undefined;
          } else {
            task.status = 'skipped';
            task.reason = 'send_failed';
          }
          task.updatedAt = new Date().toISOString();
          store.upsertTask(task);
        })
        .catch((e) => {
          task.status = 'skipped';
          task.reason = 'send_failed';
          task.updatedAt = new Date().toISOString();
          store.upsertTask(task);
          try { deps.logError?.(`日记留言发送失败：${(e as Error)?.message || String(e)}`); } catch { /* ignore */ }
        });
      return; // 每轮最多一条
    }
  }

  dropTasksForDiary(diaryId: string): void {
    this.requireDeps().getStore().dropTasksForDiary(diaryId);
  }
}

let singleton: DiaryCommentScheduler | null = null;

export function getDiaryCommentScheduler(): DiaryCommentScheduler {
  if (!singleton) singleton = new DiaryCommentScheduler();
  return singleton;
}

/** 仅供自检脚本构造隔离环境使用。 */
export function resetDiaryCommentScheduler(): void {
  singleton = null;
}
