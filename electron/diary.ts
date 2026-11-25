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
  DiaryEntry,
  DiaryStoreShape,
  DiarySummary,
  DiaryTone,
} from '../src/types';

export const DIARY_FILE = 'diary.json';
export const NO_SELF_ROLE = 'none';

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
export function collectArtifactsForRole(input: GateInput): DiaryArtifact[] {
  const out: DiaryArtifact[] = [];
  if (!input || !input.roleId) return out;
  const diaries = Array.isArray(input.diaries) ? input.diaries : [];
  const summaries = Array.isArray(input.summaries) ? input.summaries : [];
  for (const d of diaries) {
    if (!canRoleAccessDiary(d, input.roleId)) continue;
    if (d.selfRoleId !== input.selfRoleId) continue;
    for (const c of d.aiComments || []) {
      if (c.roleId === input.roleId && !c.revoked && typeof c.text === 'string' && c.text.trim()) {
        out.push({ kind: 'comment', text: c.text, diaryId: d.id });
      }
    }
    for (const s of summaries) {
      if (
        s.diaryId === d.id &&
        s.roleId === input.roleId &&
        !s.revoked &&
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
      if (all || ids.has(c.roleId)) c.revoked = true;
    }
  }
  for (const s of summaries || []) {
    if (all || ids.has(s.roleId)) s.revoked = true;
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
  return { version: 1, seq: 0, diaries: [], diary_summaries: [] };
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

export class DiaryStore {
  dataDir = '';
  diaries: DiaryEntry[] = [];
  summaries: DiarySummary[] = [];
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
  }

  save(): void {
    if (!this.filePath) return;
    this.shape.diaries = this.diaries;
    this.shape.diary_summaries = this.summaries;
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
      applyRevoke(this.diaries, this.summaries, removed, contentChanged || switchedOff);
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

  addSummary(s: DiarySummary): void {
    this.summaries.push(s);
    this.save();
  }

  revokeForRoles(diaryId: string, roleIds: string[]): void {
    const d = this.getDiary(diaryId);
    applyRevoke(d ? [d] : [], this.summaries.filter((s) => s.diaryId === diaryId), roleIds, false);
    this.save();
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
