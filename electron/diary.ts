/**
 * 念语 v3.0.18 分册日记数据层 + 门控唯一真源（纯模块，不 import electron）。
 *
 * 关键不变量：
 *   1. 「AI 知道」只由已产生且当前仍可见的产物（留言 / 摘要）承载，日记正文永不注入对话。
 *   2. 每个产物带 roleId + selfRoleId + revoked + sourceUpdatedAt，身份册与可见名单双门控。
 *   3. 总开关 allowAi=false 时，对所有角色一律隔离，与 visibleRoleIds 无关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText } from './secureStore';
import { buildDiaryCommentSuffix, classifyDiaryCommentTone } from './diaryTone';
import type {
  DiaryAiResult,
  DiaryComment,
  DiaryCommentReply,
  DiaryCommentTask,
  DiaryEntry,
  DiaryStoreShape,
  DiarySummary,
  DiaryTone,
} from '../src/types';

export const DIARY_FILE = 'diary.json';
export const NO_SELF_ROLE = 'none';

// v3.0.24 回复上下文硬编码常量（同步登记 硬编码清单.md）。
export const DIARY_REPLY_CHAT_N_CAP = 16;
export const DIARY_REPLY_KEYWORD_MAX = 4;
export const DIARY_REPLY_CHAR_BUDGET = 6000;
export const DIARY_REPLY_USER_MAX = 2000;
export const DIARY_REPLY_THREAD_ITEM_MAX = 1200;
export const DIARY_REPLY_TOP_MAX = 1200;
export const DIARY_REPLY_ARTIFACT_MAX = 2000;
export const DIARY_REPLY_SINGLE_CHAR_CAP = 800;

export interface DiaryArtifact {
  kind: 'comment' | 'summary';
  text: string;
  diaryId: string;
}

export interface GateInput {
  diaries: DiaryEntry[];
  summaries: DiarySummary[];
  roleId: string;
  selfRoleId: string;
}

export interface DiaryCreateParams {
  selfRoleId: string;
  date: string;
  title?: string;
  content: string;
}

/** v3.0.22 内部兼容迁移结果：只统计归属改写，不产生任何新产物或时间戳。 */
export interface DiaryMigrationResult {
  migratedDiaries: number;
  migratedSummaries: number;
  targetSelfRoleId: string | null;
}

export interface DiaryPatch {
  date?: string;
  title?: string;
  content?: string;
  allowAi?: boolean;
  visibleRoleIds?: string[];
  /** 删除单条 AI 留言：传入过滤后的数组（物理移除产物，不影响正文）。 */
  aiComments?: DiaryComment[];
}

export interface DiaryAiWorkItem {
  roleId: string;
  tone: DiaryTone;
  affinity: number;
  mood: string;
  suffix: string;
}

/** 串联与：总开关优先；名单为空 = 无人可见。此函数是唯一判定真源。 */
export function canRoleAccessDiary(d: DiaryEntry, roleId: string): boolean {
  return d.allowAi === true && Array.isArray(d.visibleRoleIds) && d.visibleRoleIds.includes(roleId);
}

/**
 * 只有「已产生且当前仍可见」的产物才进对话；绝不读取 / 输出 diary.content。
 * diaries 只用于校验 updated_at / selfRoleId / 当前可见名单。
 */
export function collectArtifactsForRole(input: GateInput, includeReplies = false): DiaryArtifact[] {
  const out: DiaryArtifact[] = [];
  if (!input || !input.roleId) return out;
  const diaries = Array.isArray(input.diaries) ? input.diaries : [];
  const summaries = Array.isArray(input.summaries) ? input.summaries : [];
  for (const d of diaries) {
    if (!canRoleAccessDiary(d, input.roleId)) continue;
    if (d.selfRoleId !== input.selfRoleId) continue;
    for (const c of d.aiComments || []) {
      // v3.0.25：冻结快照只在聊天回忆（buildDiaryRecallBlock）中可见，正常门控永不复活。
      if (c.roleId === input.roleId && !c.revoked && !c.frozen && typeof c.text === 'string' && c.text.trim()) {
        out.push({ kind: 'comment', text: c.text, diaryId: d.id });
        // v3.0.24：默认口径不变；回复服务显式开启时才把同一留言串的 AI 回复计为产物。
        if (includeReplies) {
          for (const r of c.replies || []) {
            if (!r.revoked && r.author === 'ai' && typeof r.text === 'string' && r.text.trim()) {
              out.push({ kind: 'comment', text: r.text, diaryId: d.id });
            }
          }
        }
      }
    }
    for (const s of summaries) {
      if (
        s.diaryId === d.id &&
        s.roleId === input.roleId &&
        !s.revoked &&
        !s.frozen &&
        s.selfRoleId === input.selfRoleId &&
        s.sourceUpdatedAt === d.updated_at &&
        Array.isArray(s.visibleRoleIdsSnapshot) &&
        s.visibleRoleIdsSnapshot.every((r) => d.visibleRoleIds.includes(r))
      ) {
        if (typeof s.text === 'string' && s.text.trim()) {
          out.push({ kind: 'summary', text: s.text, diaryId: d.id });
        }
      }
    }
  }
  return out;
}

/** 自动留言触发条件：allowAi=true 且名单非空；名单外角色一律不生成。 */
export function shouldGenerateComments(d: DiaryEntry): boolean {
  return d.allowAi === true && Array.isArray(d.visibleRoleIds) && d.visibleRoleIds.length > 0;
}

/** 自动总结：仅 allowAi=true 的日记；自动档还需设置开关为真。 */
export function shouldSummarize(d: DiaryEntry, auto: boolean, autoSetting = false): boolean {
  if (!d || d.allowAi !== true) return false;
  // 名单为空时无任何角色可触发（调用方按角色遍历）；这里承担总开关与自动档判定。
  if (!Array.isArray(d.visibleRoleIds) || d.visibleRoleIds.length === 0) return false;
  return !auto || autoSetting === true;
}

/**
 * 软撤销：关闭总开关 / 移除角色 / 改正文时，把对应产物标为 revoked。
 * all=true 时撤销该篇全部角色的产物；重新勾选不自动恢复，须手动重新生成。
 *
 * v3.0.25 正交约定：两类产物集合互不牵连。
 *   - 只需撤摘要（重新总结）时传 diaries=[]，只撤留言串（force 重新留言）走 revokeThreadForRole；
 *   - 只有正文变更 / 关闭总开关 / 移除可见角色等「整篇失效」场景才同时撤两类（diaries + summaries）。
 */
export function applyRevoke(
  diaries: DiaryEntry[],
  summaries: DiarySummary[],
  roleIds: string[],
  all: boolean
): void {
  const ids = new Set(roleIds || []);
  for (const d of diaries || []) {
    for (const c of d.aiComments || []) {
      // v3.0.25：冻结快照是不可变历史状态，任何撤销路径都不得改写。
      if (!c.frozen && (all || ids.has(c.roleId))) {
        c.revoked = true;
        // v3.0.24：整串撤销——回复随顶层留言一并失效，渲染 / 注入均过滤。
        for (const r of c.replies || []) if (!r.frozen) r.revoked = true;
      }
    }
  }
  for (const s of summaries || []) {
    if (!s.frozen && (all || ids.has(s.roleId))) s.revoked = true;
  }
}

/** 生成计划（纯函数）：只有名单内角色进入；QA 可据此断言 allowAi=false 时 queryAI 调用数 0。 */
export function planDiaryAiWork(
  d: DiaryEntry,
  roles: Array<{ id: string; affinity: number; mood?: string }>,
  roleIds?: string[]
): DiaryAiWorkItem[] {
  if (!d || !shouldGenerateComments(d)) return [];
  const wanted = roleIds && roleIds.length > 0 ? new Set(roleIds) : null;
  const out: DiaryAiWorkItem[] = [];
  for (const role of roles || []) {
    if (!canRoleAccessDiary(d, role.id)) continue;
    if (wanted && !wanted.has(role.id)) continue;
    const affinity = Number.isFinite(role.affinity) ? role.affinity : 50;
    const mood = String(role.mood || '平静');
    const tone = classifyDiaryCommentTone(affinity, mood);
    if (tone === 'skip') continue;
    out.push({ roleId: role.id, tone, affinity, mood, suffix: buildDiaryCommentSuffix(tone) });
  }
  return out;
}

function emptyShape(): DiaryStoreShape {
  return { version: 1, seq: 0, diaries: [], diary_summaries: [], commentTasks: [] };
}

function normalizeShape(raw: unknown): DiaryStoreShape {
  if (!raw || typeof raw !== 'object') return emptyShape();
  const r = raw as Partial<DiaryStoreShape>;
  return {
    version: 1,
    seq: typeof r.seq === 'number' ? r.seq : 0,
    diaries: Array.isArray(r.diaries) ? (r.diaries as DiaryEntry[]) : [],
    // 独立集合：绝不复用 MemoryEntry。
    diary_summaries: Array.isArray(r.diary_summaries) ? (r.diary_summaries as DiarySummary[]) : [],
    // v3.0.24：旧档无该字段 → 空表，零迁移可读。
    commentTasks: Array.isArray(r.commentTasks) ? (r.commentTasks as DiaryCommentTask[]) : [],
  };
}

function id(prefix: string, seq: number): string {
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** 单调时间戳：同一毫秒内连续编辑也保证 updated_at 变化（摘要游标可靠失效）。 */
function nextTimestamp(prev?: string): string {
  const last = prev ? Date.parse(prev) : 0;
  const ms = Number.isFinite(last) ? Math.max(Date.now(), last + 1) : Date.now();
  return new Date(ms).toISOString();
}

/**
 * v3.0.22 内部兼容迁移：把 selfRoleId 不在有效身份列表里的日记（历史哨兵值与身份已删除的孤儿）
 * 归到 target。只改日记与摘要的 selfRoleId 两个字段：正文、时间戳、可见名单、留言、摘要文本
 * 与游标全部保持不变；不调用 applyRevoke / nextTimestamp。
 * 摘要同步改写 selfRoleId，sourceUpdatedAt 因 diary.updated_at 未动而继续匹配，
 * collectArtifactsForRole 的产物集合因此保持原样。
 */
export function migrateLegacyDiaries(
  diaries: DiaryEntry[],
  summaries: DiarySummary[],
  validSelfRoleIds: string[],
  preferredSelfRoleId?: string | null
): DiaryMigrationResult {
  const valid = (Array.isArray(validSelfRoleIds) ? validSelfRoleIds : [])
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x !== NO_SELF_ROLE);
  const preferred = String(preferredSelfRoleId || '');
  const target = valid.includes(preferred) ? preferred : (valid[0] || null);
  const result: DiaryMigrationResult = {
    migratedDiaries: 0,
    migratedSummaries: 0,
    targetSelfRoleId: target,
  };
  if (!target) return result; // 没有任何身份：数据原样保留，等首个身份创建后再迁移

  const moved = new Set<string>();
  for (const d of diaries || []) {
    if (!d || valid.includes(d.selfRoleId)) continue; // 幂等：迁移后不再命中
    d.selfRoleId = target; // 唯一写入点
    moved.add(d.id);
    result.migratedDiaries += 1;
  }
  if (moved.size === 0) return result;

  for (const s of summaries || []) {
    if (!s || !moved.has(s.diaryId) || s.selfRoleId === target) continue;
    s.selfRoleId = target; // 唯一写入点；revoked / text / sourceUpdatedAt / 快照原样
    result.migratedSummaries += 1;
  }
  return result;
}

export class DiaryStore {
  dataDir = '';
  diaries: DiaryEntry[] = [];
  summaries: DiarySummary[] = [];
  commentTasks: DiaryCommentTask[] = [];
  private shape: DiaryStoreShape = emptyShape();
  private filePath = '';

  init(dataDir: string): void {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, DIARY_FILE);
    try {
      if (fs.existsSync(this.filePath)) {
        this.shape = normalizeShape(JSON.parse(readText(this.filePath)) as unknown);
      } else {
        this.shape = emptyShape();
      }
    } catch (e) {
      console.error('[diary] 读取日记失败，按空表启动', e);
      this.shape = emptyShape();
    }
    this.diaries = this.shape.diaries;
    this.summaries = this.shape.diary_summaries;
    this.commentTasks = Array.isArray(this.shape.commentTasks) ? this.shape.commentTasks : [];
    this.shape.commentTasks = this.commentTasks;
  }

  save(): void {
    if (!this.filePath) return;
    this.shape.diaries = this.diaries;
    this.shape.diary_summaries = this.summaries;
    this.shape.commentTasks = this.commentTasks;
    writeText(this.filePath, JSON.stringify(this.shape, null, 2));
  }

  private bumpSeq(): number {
    this.shape.seq += 1;
    return this.shape.seq;
  }

  snapshot(): { diaries: DiaryEntry[]; summaries: DiarySummary[] } {
    return { diaries: this.diaries, summaries: this.summaries };
  }

  listDiaries(selfRoleId?: string): DiaryEntry[] {
    const list = selfRoleId === undefined
      ? this.diaries
      : this.diaries.filter((d) => d.selfRoleId === selfRoleId);
    return [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '') ||
      (b.created_at || '').localeCompare(a.created_at || ''));
  }

  getDiary(id: string): DiaryEntry | undefined {
    return this.diaries.find((d) => d.id === id);
  }

  createDiary(p: DiaryCreateParams): DiaryEntry {
    const now = nextTimestamp();
    const entry: DiaryEntry = {
      id: id('diary', this.bumpSeq()),
      selfRoleId: p.selfRoleId || NO_SELF_ROLE,
      date: p.date || now.slice(0, 10),
      title: p.title || '',
      content: p.content || '',
      // 最保守默认：总开关关 + 名单空（裁定 #8）。
      allowAi: false,
      visibleRoleIds: [],
      aiComments: [],
      created_at: now,
      updated_at: now,
    };
    this.diaries.push(entry);
    this.save();
    return entry;
  }

  updateDiary(id: string, patch: DiaryPatch): DiaryEntry | undefined {
    const d = this.getDiary(id);
    if (!d) return undefined;
    const oldContent = d.content;
    const oldAllow = d.allowAi;
    const oldVisible = [...(d.visibleRoleIds || [])];

    if (patch.date !== undefined) d.date = patch.date;
    if (patch.title !== undefined) d.title = patch.title;
    if (patch.content !== undefined) d.content = patch.content;
    if (patch.allowAi !== undefined) d.allowAi = patch.allowAi === true;
    if (Array.isArray(patch.visibleRoleIds)) {
      d.visibleRoleIds = [...new Set(patch.visibleRoleIds.filter((x) => typeof x === 'string'))];
    }
    if (Array.isArray(patch.aiComments)) d.aiComments = patch.aiComments;

    const contentChanged = patch.content !== undefined && patch.content !== oldContent;
    const switchedOff = oldAllow === true && d.allowAi === false;
    const removed = oldVisible.filter((r) => !d.visibleRoleIds.includes(r));

    if (contentChanged || switchedOff || removed.length > 0) {
      if (contentChanged || switchedOff) {
        // 正文变更 / 关总开关：整篇失效，既有双撤语义逐字保留。
        applyRevoke(this.diaries, this.summaries, removed, contentChanged || switchedOff);
      } else {
        // v3.0.25：仅取消人物资格 → 冻结最后状态快照，不撤销、不删除任何产物。
        this.freezeArtifactsForRoles(d, removed);
      }
    } else if (oldAllow === false && d.allowAi === true && patch.visibleRoleIds === undefined) {
      // 首次开启（未同时显式勾选时）：名单保持空，不自动填当前角色（裁定 #8）。
      d.visibleRoleIds = [];
    }
    // 仅删除留言产物不改变正文，摘要游标必须保持不变（否则既有摘要会无故失效）。
    const artifactsOnly =
      patch.aiComments !== undefined &&
      patch.date === undefined &&
      patch.title === undefined &&
      patch.content === undefined &&
      patch.allowAi === undefined &&
      patch.visibleRoleIds === undefined;
    if (!artifactsOnly) d.updated_at = nextTimestamp(d.updated_at);
    this.save();
    return d;
  }

  deleteDiary(id: string): boolean {
    const before = this.diaries.length;
    this.diaries = this.diaries.filter((d) => d.id !== id);
    this.summaries = this.summaries.filter((s) => s.diaryId !== id);
    if (this.diaries.length === before) return false;
    this.save();
    return true;
  }

  addComment(diaryId: string, c: DiaryComment): void {
    const d = this.getDiary(diaryId);
    if (!d) return;
    if (!Array.isArray(d.aiComments)) d.aiComments = [];
    d.aiComments.push(c);
    this.save();
  }

  // ===== v3.0.24 留言排程任务 / 回复串（旧档零迁移，全部只做增量）=====
  listTasks(): DiaryCommentTask[] {
    return [...this.commentTasks];
  }

  upsertTask(task: DiaryCommentTask): void {
    const idx = this.commentTasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) this.commentTasks[idx] = task;
    else this.commentTasks.push(task);
    this.save();
  }

  dropTasksForRole(
    diaryId: string,
    roleId: string,
    statuses?: DiaryCommentTask['status'][]
  ): void {
    const wanted = statuses && statuses.length > 0 ? new Set(statuses) : null;
    this.commentTasks = this.commentTasks.filter(
      (t) => !(t.diaryId === diaryId && t.roleId === roleId && (!wanted || wanted.has(t.status)))
    );
    this.save();
  }

  dropTasksForDiary(diaryId: string): void {
    this.commentTasks = this.commentTasks.filter((t) => t.diaryId !== diaryId);
    this.save();
  }

  /** 顶层留言硬锁：每 (diaryId, roleId) 只允许一条未撤销留言；回复永不新增顶层留言。 */
  commentLocked(diaryId: string, roleId: string): boolean {
    const d = this.getDiary(diaryId);
    if (!d) return false;
    return (d.aiComments || []).some((c) => c.roleId === roleId && !c.revoked);
  }

  getComment(diaryId: string, commentId: string): DiaryComment | undefined {
    const d = this.getDiary(diaryId);
    if (!d) return undefined;
    return (d.aiComments || []).find((c) => c.id === commentId);
  }

  addReply(commentId: string, reply: DiaryCommentReply): boolean {
    for (const d of this.diaries) {
      const c = (d.aiComments || []).find((x) => x.id === commentId);
      if (!c) continue;
      if (!Array.isArray(c.replies)) c.replies = [];
      c.replies.push(reply);
      this.save();
      return true;
    }
    return false;
  }

  setAwaiting(commentId: string, value: boolean): boolean {
    for (const d of this.diaries) {
      const c = (d.aiComments || []).find((x) => x.id === commentId);
      if (!c) continue;
      c.awaitingUserReply = value;
      this.save();
      return true;
    }
    return false;
  }

  /** force 重生成：旧顶层留言与整串 replies 一并软撤，随后才可新建新留言。 */
  revokeThreadForRole(diaryId: string, roleId: string): number {
    const d = this.getDiary(diaryId);
    if (!d) return 0;
    let n = 0;
    for (const c of d.aiComments || []) {
      if (c.roleId !== roleId || c.revoked || c.frozen) continue;
      c.revoked = true;
      for (const r of c.replies || []) if (!r.frozen) r.revoked = true;
      n += 1;
    }
    if (n > 0) this.save();
    return n;
  }

  addSummary(s: DiarySummary): void {
    this.summaries.push(s);
    this.save();
  }

  /**
   * v3.0.22/v3.0.24 既有口径：同时软撤该篇指定角色的留言串与摘要。
   * 仅供「整篇失效」类场景（正文变更 / 关闭开关 / 移除角色 / 换册）使用；
   * 重新总结与重新留言禁止调用本方法，改用下面的单类专用方法，保证两类产物正交。
   */
  revokeForRoles(diaryId: string, roleIds: string[]): void {
    const d = this.getDiary(diaryId);
    applyRevoke(d ? [d] : [], this.summaries.filter((s) => s.diaryId === diaryId), roleIds, false);
    this.save();
  }

  /**
   * v3.0.25：重新总结专用——只软撤该篇指定角色的旧摘要，绝不触碰任何留言 / 回复。
   * 传 diaries=[] 让 applyRevoke 的留言循环空转；摘要仍按 roleId 精确匹配。
   */
  revokeSummariesForRoles(diaryId: string, roleIds: string[]): void {
    applyRevoke([], this.summaries.filter((s) => s.diaryId === diaryId), roleIds, false);
    this.save();
  }

  /**
   * v3.0.25：取消人物回复资格时把该人物已有产物冻结为「最后状态快照」。
   * 只写 frozen 标记；revoked / text / replies / sourceUpdatedAt / 时间戳一律不动。
   * 冻结产物不再参与新留言 / 新回复生成，但仍可在聊天回忆中被该角色引用。
   */
  freezeArtifactsForRoles(d: DiaryEntry, roleIds: string[]): void {
    const ids = new Set(roleIds || []);
    if (ids.size === 0) return;
    for (const c of d.aiComments || []) {
      if (!ids.has(c.roleId)) continue;
      c.frozen = true;
      for (const r of c.replies || []) r.frozen = true;
    }
    for (const s of this.summaries) {
      if (s.diaryId === d.id && ids.has(s.roleId)) s.frozen = true;
    }
    this.save();
  }

  /**
   * v3.0.25：重试用户回复时软撤上一条因生成失败而遗留的 user reply，避免重复叠加。
   * 只处理「末条未撤销且为 user、其后没有 ai」的失败残留；审计痕迹保留。
   */
  revokePendingUserReply(commentId: string): boolean {
    for (const d of this.diaries) {
      const comment = (d.aiComments || []).find((x) => x.id === commentId);
      if (!comment) continue;
      const replies = comment.replies || [];
      const last = [...replies].reverse().find((r) => !r.revoked);
      if (!last || last.author !== 'user') return false;
      last.revoked = true;
      if (last.frozen === undefined) last.frozen = false;
      this.save();
      return true;
    }
    return false;
  }

  /** selfRoleId 既不在有效身份列表也不是 'none' → 孤儿（删除自我身份后保留的日记）。 */
  listOrphans(validSelfRoleIds: string[] = []): DiaryEntry[] {
    const valid = new Set([NO_SELF_ROLE, ...(validSelfRoleIds || [])]);
    return this.diaries.filter((d) => !valid.has(d.selfRoleId));
  }

  reassignOrphans(fromSelfRoleId: string, toSelfRoleId: string): number {
    const target = toSelfRoleId || NO_SELF_ROLE;
    let n = 0;
    for (const d of this.diaries) {
      if (d.selfRoleId === fromSelfRoleId && fromSelfRoleId !== target) {
        d.selfRoleId = target;
        // 换册后旧产物的身份册不再匹配，软删（不自动复活）。
        applyRevoke([d], this.summaries.filter((s) => s.diaryId === d.id), [], true);
        d.updated_at = nextTimestamp(d.updated_at);
        n += 1;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  /** v3.0.22：专用兼容迁移——仅在真有归属改写时落盘，沿用 save() 的原子写口径。 */
  migrateLegacySelfRoles(
    validSelfRoleIds: string[],
    preferredSelfRoleId?: string | null
  ): DiaryMigrationResult {
    const r = migrateLegacyDiaries(
      this.diaries,
      this.summaries,
      validSelfRoleIds,
      preferredSelfRoleId
    );
    if (r.migratedDiaries > 0 || r.migratedSummaries > 0) this.save();
    return r;
  }
}

let singleton: DiaryStore | null = null;

export function getDiaryStore(): DiaryStore {
  if (!singleton) singleton = new DiaryStore();
  return singleton;
}

/** 重置单例（仅供自检脚本构造隔离环境使用）。 */
export function resetDiaryStore(): void {
  singleton = null;
}

/**
 * v3.0.24 回复上下文（纯函数，不读 diary.content，不碰身份/群聊/revoked 数据）。
 * P0 用户本次原文、P1 该留言串全部历史、P2 顶层留言、P3 门控产物块四项不可丢条目；
 * P4 单聊最近 N 条与 P5 关键词补条在 6000 字符硬预算内从低优先级开始裁剪。
 */
export interface DiaryReplyContextInput {
  roleId: string;
  roleName: string;
  userText: string;
  thread: DiaryCommentReply[];
  topText: string;
  artifactBlock: string;
  chatMessages: Array<{ content?: string; sender_type?: string; timestamp?: string }>;
  historyCap: number;
}

function clip(text: string, max: number): string {
  const s = String(text || '').trim();
  return s.length <= max ? s : s.slice(0, max);
}

function replyKeywords(text: string): string[] {
  const out = new Set<string>();
  const s = String(text || '');
  const ascii = s.match(/[A-Za-z0-9_]{2,}/g) || [];
  for (const w of ascii) out.add(w.toLowerCase());
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
    if (seg.length === 1) out.add(seg);
  }
  return [...out];
}

export function buildDiaryReplyContext(input: DiaryReplyContextInput): string {
  const roleName = String(input?.roleName || input?.roleId || '');
  const userText = clip(input?.userText, DIARY_REPLY_USER_MAX);
  const threadRaw = Array.isArray(input?.thread) ? input.thread.filter((r) => r && !r.revoked) : [];
  const p0 = userText ? `【用户刚刚回复（请针对其内容作答）】\n${userText}` : '';
  const p1Items = threadRaw.map((r) => {
    const who = r.author === 'user' ? '我' : roleName;
    return `- ${r.created_at || ''} ${who}：${clip(r.text, DIARY_REPLY_THREAD_ITEM_MAX)}`;
  });
  const p1 = p1Items.length > 0 ? `【这条留言的完整对话历史】\n${p1Items.join('\n')}` : '';
  const p2 = clip(input?.topText, DIARY_REPLY_TOP_MAX)
    ? `【这条留言的原文】\n${clip(input.topText, DIARY_REPLY_TOP_MAX)}`
    : '';
  const p3 = clip(input?.artifactBlock, DIARY_REPLY_ARTIFACT_MAX);

  const all = Array.isArray(input?.chatMessages) ? input.chatMessages : [];
  const usable = all.filter((m) => m && String(m.content || '').trim());
  const cap = Math.max(0, Math.min(Number.isFinite(input.historyCap) ? input.historyCap : 16, DIARY_REPLY_CHAT_N_CAP));
  const recent = usable.slice(-cap);
  const recentSet = new Set(recent);
  const p4Items = recent.map((m) => `- ${m.timestamp || ''} 我/角色：${clip(String(m.content), DIARY_REPLY_SINGLE_CHAR_CAP)}`);
  const p4 = p4Items.length > 0 ? `【该角色单聊最近 ${recent.length} 条（仅作背景）】\n${p4Items.join('\n')}` : '';

  const keys = replyKeywords(userText);
  const p5Items: string[] = [];
  for (let i = usable.length - recent.length - 1; i >= 0 && p5Items.length < DIARY_REPLY_KEYWORD_MAX; i--) {
    const m = usable[i];
    if (recentSet.has(m)) continue;
    const content = String(m.content || '');
    const lower = content.toLowerCase();
    if (!keys.some((k) => lower.includes(k))) continue;
    p5Items.push(`- ${m.timestamp || ''} 我/角色：${clip(content, DIARY_REPLY_SINGLE_CHAR_CAP)}`);
  }
  const p5 = p5Items.length > 0 ? `【关键词命中的更早单聊（最多 ${DIARY_REPLY_KEYWORD_MAX} 条）】\n${p5Items.join('\n')}` : '';

  const join = (blocks: string[]): string => blocks.filter(Boolean).join('\n\n');
  let out = join([p0, p1, p2, p3, p4, p5]);
  if (out.length <= DIARY_REPLY_CHAR_BUDGET) return out;
  // 先丢低优先级背景；P0/P1 条目本身永不删除，只逐条截短。
  out = join([p0, p1, p2, p3, p4]);
  if (out.length > DIARY_REPLY_CHAR_BUDGET) out = join([p0, p1, p2, p3]);
  if (out.length > DIARY_REPLY_CHAR_BUDGET) {
    const topShort = clip(input?.topText, 400);
    const artShort = clip(input?.artifactBlock, 600);
    out = join([
      p0,
      p1,
      topShort ? `【这条留言的原文】\n${topShort}` : '',
      artShort,
    ]);
  }
  if (out.length > DIARY_REPLY_CHAR_BUDGET) {
    const prefix = p0 ? p0.length + 2 : 0;
    const n = Math.max(1, p1Items.length);
    const per = Math.max(1, Math.floor((DIARY_REPLY_CHAR_BUDGET - prefix - 2 * (n - 1)) / n));
    // 每条对话历史都保留一个条目（只截文本，不丢条目），满足 P1「永不丢弃条目」。
    out = join([p0, ...p1Items.map((line) => (line.length <= per ? line : line.slice(0, per)))]);
  }
  return out.length <= DIARY_REPLY_CHAR_BUDGET ? out : out.slice(0, DIARY_REPLY_CHAR_BUDGET);
}

/**
 * 供 buildSystemPrompt 调用的产物块：只输出已产生且当前仍可见的留言 / 摘要文本。
 * selfRoleId 由调用方传 selfRole?.id || 'none'；无产物时返回空串（完全不注入）。
 */
export function buildDiaryContextBlock(roleId: string, selfRoleId: string): string {
  const store = getDiaryStore();
  const artifacts = collectArtifactsForRole({
    diaries: store.diaries,
    summaries: store.summaries,
    roleId,
    selfRoleId: selfRoleId || NO_SELF_ROLE,
  });
  if (artifacts.length === 0) return '';
  const lines = artifacts.map((a) =>
    a.kind === 'comment' ? `- [留言] ${a.text}` : `- [摘要] ${a.text}`
  );
  return `【你记得的主人日记片段（仅你可看见，按当前可见范围实时门控）】\n${lines.join('\n')}`;
}

/**
 * v3.0.25 聊天回忆的一行产物（摘要优先；回复区分 user / ai）。
 * 绝不携带 diary.content，只引用已门控的产物文本。
 */
export interface DiaryRecallLine {
  kind: 'summary' | 'comment' | 'reply';
  text: string;
  diaryId: string;
}

/**
 * v3.0.25 最小可靠触发：标题子串命中（≥2 字，取最长）或明确的日记指代 + 该身份册最近一篇。
 * 没有提及返回 null；绝不每轮无差别注入所有日记。
 */
export function resolveMentionedDiary(
  text: string,
  diaries: DiaryEntry[],
  selfRoleId: string
): DiaryEntry | null {
  const s = String(text || '').trim();
  if (!s) return null;
  const selfId = selfRoleId || NO_SELF_ROLE;
  const mine = (Array.isArray(diaries) ? diaries : []).filter((d) => d && d.selfRoleId === selfId);
  if (mine.length === 0) return null;
  let best: DiaryEntry | null = null;
  let bestLen = 0;
  for (const d of mine) {
    const title = String(d.title || '').trim();
    if (title.length >= 2 && s.includes(title) && title.length > bestLen) {
      best = d;
      bestLen = title.length;
    }
  }
  if (best) return best;
  const explicit = /(这|那|刚才|之前|上次|昨天|前天|提到|说过|写的那)\s*(篇|本)?\s*日记|日记(里|中|内容|说的|写的|提到)/;
  if (!explicit.test(s)) return null;
  return [...mine].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (b.created_at || '').localeCompare(a.created_at || '')
  )[0] || null;
}

/** 冻结快照（取消资格前最后状态）：仅在聊天回忆中使用，正常门控仍不产出。 */
export function collectFrozenArtifactsForRole(
  diary: DiaryEntry | undefined,
  summaries: DiarySummary[],
  roleId: string,
  selfRoleId: string
): DiaryRecallLine[] {
  const out: DiaryRecallLine[] = [];
  if (!diary || !roleId || diary.selfRoleId !== (selfRoleId || NO_SELF_ROLE)) return out;
  for (const s of summaries || []) {
    if (
      s.diaryId === diary.id && s.roleId === roleId && s.frozen === true && !s.revoked &&
      typeof s.text === 'string' && s.text.trim()
    ) {
      out.push({ kind: 'summary', text: s.text, diaryId: diary.id });
    }
  }
  for (const c of diary.aiComments || []) {
    if (c.roleId !== roleId || c.frozen !== true || c.revoked) continue;
    if (typeof c.text === 'string' && c.text.trim()) {
      out.push({ kind: 'comment', text: c.text, diaryId: diary.id });
    }
    for (const r of c.replies || []) {
      if (r.frozen !== true || r.revoked || typeof r.text !== 'string' || !r.text.trim()) continue;
      out.push({
        kind: 'reply',
        text: `${r.author === 'user' ? '我：' : ''}${r.text}`,
        diaryId: diary.id,
      });
    }
  }
  return out;
}

/**
 * 聊天中用户明确提到日记时的上下文块：摘要优先 → 当前可见留言/回复 → 冻结快照兜底。
 * 正文永远不进入返回值；无命中 / 无产物返回空串。
 */
export function buildDiaryRecallBlock(text: string, roleId: string, selfRoleId: string): string {
  const store = getDiaryStore();
  const d = resolveMentionedDiary(text, store.diaries, selfRoleId);
  if (!d) return '';
  const selfId = selfRoleId || NO_SELF_ROLE;
  const lines: DiaryRecallLine[] = [];
  const push = (line: DiaryRecallLine): void => {
    if (!lines.some((x) => x.kind === line.kind && x.text === line.text)) lines.push(line);
  };

  // 摘要优先：游标匹配 + 可见快照门控，与 collectArtifactsForRole 同口径。
  for (const s of store.summaries) {
    if (
      s.diaryId === d.id && s.roleId === roleId && !s.revoked && s.selfRoleId === selfId &&
      s.sourceUpdatedAt === d.updated_at &&
      Array.isArray(s.visibleRoleIdsSnapshot) &&
      s.visibleRoleIdsSnapshot.every((r) => d.visibleRoleIds.includes(r)) &&
      typeof s.text === 'string' && s.text.trim()
    ) {
      push({ kind: 'summary', text: s.text, diaryId: d.id });
    }
  }
  // 当前仍可见的留言串（含用户与 AI 回复）。
  if (canRoleAccessDiary(d, roleId)) {
    for (const c of d.aiComments || []) {
      if (c.roleId !== roleId || c.revoked || typeof c.text !== 'string' || !c.text.trim()) continue;
      push({ kind: 'comment', text: c.text, diaryId: d.id });
      for (const r of c.replies || []) {
        if (r.revoked || typeof r.text !== 'string' || !r.text.trim()) continue;
        push({ kind: 'reply', text: `${r.author === 'user' ? '我：' : ''}${r.text}`, diaryId: d.id });
      }
    }
  }
  // 取消资格后的冻结快照兜底（含该人物回复与用户回复）。
  for (const f of collectFrozenArtifactsForRole(d, store.summaries, roleId, selfId)) push(f);

  if (lines.length === 0) return '';
  const ordered = [...lines.filter((l) => l.kind === 'summary'), ...lines.filter((l) => l.kind !== 'summary')];
  const body = ordered.map((l) =>
    l.kind === 'summary' ? `- [摘要] ${l.text}` : l.kind === 'reply' ? `- [回复] ${l.text}` : `- [留言] ${l.text}`
  );
  const title = String(d.title || d.date || '日记');
  return `【你记得的主人日记「${title}」（摘要优先，正文不可见）】\n${body.join('\n')}`;
}

/** 手动留言/总结的统一返回结构构造（供 IPC 层使用）。 */
export function makeDiaryAiResult(
  generatedRoleIds: string[],
  skippedRoleIds: string[],
  reason?: DiaryAiResult['reason']
): DiaryAiResult {
  return {
    ok: generatedRoleIds.length > 0 || !reason,
    generatedRoleIds,
    skippedRoleIds,
    reason,
  };
}
