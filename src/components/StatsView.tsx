import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import type { AppSettings, Role, RoleStat } from '../types';
import { AvatarImg } from './ChatList';
import { normalizeRelation, RELATION_LABELS } from '../types';
import { isGroupEnabled, getAnimSpeed } from '../utils/animControl';
import {
  arcPath,
  buildPiePalette,
  contrastRatio,
  otherSliceColor,
  parseCssColor,
  readableTextOn,
  relativeLuminance,
  splitCompanion,
} from '../utils/statsChart';
import {
  buildPieSlices,
  sortByTokensDesc,
  sortRows,
  OTHER_THRESHOLD,
  type PieSlice,
  type RankMode,
  type RankRow,
} from '../utils/statsRank';
import { highlightParts, MAX_SUGGESTIONS, rankCandidates, suggest } from '../utils/fuzzySearch';

/** 饼图 SVG 视图框边长（viewBox 为 0 0 200 200，圆心 100,100） */
const PIE_SIZE = 200;
const PIE_CX = PIE_SIZE / 2;
const PIE_CY = PIE_SIZE / 2;
/** 圆环外/内半径（内半径 > 0 → 圆环；中心留白放总量文字，比实心饼更好读） */
const PIE_R_OUT = 88;
const PIE_R_IN = 44;
/** 扇区之间的角度缝隙（度）：避免相邻色块糊在一起 */
const SLICE_GAP_DEG = 1.2;
/**
 * 「从圆心顺时针拉开」的总时长（ms）。
 *
 * 取值依据：900ms 属于 800~1000ms 区间 —— 够长到用户能看清「一条线从圆心
 * 顺时针拉开、各区块依次浮现」的全过程，又不至于慢到像卡住。
 * 注意该动画是 rAF 内联补间，**必须**由 isGroupEnabled(settings,'stats') 门控
 * （见 PieChart 内 useEffect），不能靠 CSS 类名kill。
 *
 * v2.3.97：基准时长（1× 速度下）。实际时长 = `PIE_ANIM_MS * speed`，
 * speed 由外层用 getAnimSpeed(settings) 算好后作为 `animSpeed` prop 传进来
 * （与 CSS 侧 `calc(原值 * var(--anim-speed))` 是同一套倍率，故两者必然同步）。
 * ⚠️ 是**乘**不是除：`--anim-speed` 是时长倍率（1.5 = 很慢 = 时长 ×1.5）。
 */
const PIE_ANIM_MS = 900;

/**
 * 子页面。
 * v2.3.95 新增 `favEdit`：「你最喜欢的人物」的**独立编辑界面**。
 * 用户要求统计页主界面「只是一个展示窗口」，写签名 / 选性别必须进编辑界面才做得到，
 * 入口在「我最喜欢的人物」板块卡片右上角的编辑按钮。
 */
type SubPage = 'main' | 'tokenRank' | 'bondRank' | 'favEdit';

/**
 * 编辑界面里的**草稿**状态（用户正在改、还没点保存）。
 * 与 settings 里的已保存值分开，这样「取消」才能真正丢弃改动。
 */
interface FavDraft {
  /** 选中的 roleId；空串 = 未选（与 settings.favoriteRoleId 的 undefined 对应） */
  roleId: string;
  /** 用户自选性别；undefined = 不选（留空） */
  gender: 'male' | 'female' | undefined;
  /** 个性签名原文（保存时才做 trim） */
  signature: string;
  /** v2.3.101：6 个可填资料字段（保存时才做 trim），空串 = 留空 */
  occupation: string;
  personality: string;
  hobby: string;
  nationality: string;
  education: string;
  food: string;
}

/** 空草稿（未选人物时的初始值） */
const EMPTY_FAV_DRAFT: FavDraft = {
  roleId: '',
  gender: undefined,
  signature: '',
  occupation: '',
  personality: '',
  hobby: '',
  nationality: '',
  education: '',
  food: '',
};

/** 个性签名最大长度（多行文本，比旧版单行 input 的 60 放宽） */
const FAV_SIGNATURE_MAXLEN = 120;

/** v2.3.101：资料字段（职业/性格/爱好/国籍/学历/菜）单行输入的最大长度 */
const FAV_FIELD_MAXLEN = 60;

/** v2.3.101：6 个资料字段的键名（用于编辑界面的通用回调） */
type FavFieldKey = 'occupation' | 'personality' | 'hobby' | 'nationality' | 'education' | 'food';

/** 把陪伴毫秒渲染成带 i18n 单位的串（只显示最大的两个单位，保持紧凑） */
function useCompanionText(): (ms: number) => string {
  const { t } = useI18n();
  return useCallback(
    (ms: number) => {
      const p = splitCompanion(ms);
      if (p.onlySeconds) return t('stats.durSeconds', { n: p.seconds });
      if (p.days > 0) return t('stats.durDaysHours', { d: p.days, h: p.hours });
      if (p.hours > 0) return t('stats.durHoursMins', { h: p.hours, m: p.minutes });
      return t('stats.durMinsSecs', { m: p.minutes, s: p.seconds });
    },
    [t]
  );
}

export const StatsView: React.FC = () => {
  const { t } = useI18n();
  // v2.3.94 需求 11：所有统计页动画（饼图 rAF 补间 + CSS 过渡）统一归入 stats 分组，
  // 由设置内三档动效开关独立控制（内联动画必须读 isGroupEnabled，不能靠 CSS 类名）。
  const { settings } = useTheme();
  const animOn = isGroupEnabled(settings, 'stats');
  // v2.3.97：界面动效速度倍率（1 = 正常）。饼图的 rAF 补间是内联动画、CSS 管不到，
  // 必须显式按倍率缩短/延长，否则用户调快速度后唯独饼图还是老样子。
  const animSpeed = getAnimSpeed(settings);

  const [stats, setStats] = useState<RoleStat[]>([]);
  const [global, setGlobal] = useState(0);
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [modelStats, setModelStats] = useState<{ modelId: string; name: string; tokens: number; calls: number }[]>([]);
  const [companionByRole, setCompanionByRole] = useState<Record<string, number>>({});
  const [page, setPage] = useState<SubPage>('main');
  const [rankMode, setRankMode] = useState<RankMode>('affinity');
  const [pickerOpen, setPickerOpen] = useState(false);
  // v2.3.95：编辑界面（favEdit 子页）是独立的 early-return 分支，没法共用主页面那份
  // pickerOpen 的渲染节点，故单独一个状态，语义也更清楚（互不影响）。
  const [editorPickerOpen, setEditorPickerOpen] = useState(false);
  // v2.3.95：签名草稿只在**编辑界面**里存在（主页面已改为纯展示，不再有输入框）
  const [favDraft, setFavDraft] = useState<FavDraft>(EMPTY_FAV_DRAFT);

  const refresh = useCallback(() => {
    api.getRoleStats().then(setStats);
    api.getGlobalTokens().then(setGlobal);
    api.getModelStats().then(setModelStats);
    api.getCompanionByRole().then(setCompanionByRole).catch(() => setCompanionByRole({}));
    api.getRoles().then((rs: Role[]) => {
      const map: Record<string, Role> = {};
      for (const r of rs) map[r.id] = r;
      setRoles(map);
    });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  /** 有 Token 消耗的人数（决定饼图最多几个扇区 → 调色板要几色） */
  const rowsForPalette = useMemo(() => stats.filter((s) => s.tokens > 0), [stats]);

  // 调色板依赖主题：主题一变就重新取色（getComputedStyle 是同步的，放在 useMemo 里即可）。
  // 长度按「可能进入饼图的人物数」给足（阈值 10% 意味着扇区最多 10 个），
  // 否则颜色会因取模而重复，两个不同人物撞成同色。
  const paletteSize = Math.max(1, Math.min(10, rowsForPalette.length));
  const palette = useMemo(() => buildPiePalette(paletteSize), [settings?.theme, paletteSize]);

  /** 构造排行行：Token/消息来自 getRoleStats，好感度/心情/关系来自角色表，陪伴来自后端聚合 */
  const rows: RankRow[] = useMemo(() => {
    const tokenMap = new Map<string, { tokens: number; messages: number }>();
    for (const s of stats) tokenMap.set(s.roleId, { tokens: s.tokens, messages: s.messages });
    const out: RankRow[] = [];
    for (const r of Object.values(roles)) {
      const ts = tokenMap.get(r.id);
      out.push({
        roleId: r.id,
        name: r.name,
        avatar: r.avatar_path || '',
        affinity: r.affinity || 0,
        companionMs: companionByRole[r.id] || 0,
        tokens: ts?.tokens || 0,
        messages: ts?.messages || 0,
        mood: r.mood || '',
        relation: r.relation || '',
      });
    }
    return out;
  }, [stats, roles, companionByRole]);

  const slices: PieSlice[] = useMemo(() => {
    const list = buildPieSlices(rows, palette, t('stats.other'));
    return list.map((s) => (s.isOther ? { ...s, color: otherSliceColor() } : s));
  }, [rows, palette, t]);

  /** 板块二主界面只粗略展示前五 */
  const bondTop5 = useMemo(() => sortRows(rows, rankMode).slice(0, 5), [rows, rankMode]);

  // 最喜爱人物
  const favId = settings?.favoriteRoleId;
  const favRole = favId ? roles[favId] : undefined;
  const favRow = favId
    ? rows.find((r) => r.roleId === favId) || {
        roleId: favId,
        name: favRole?.name || '',
        avatar: favRole?.avatar_path || '',
        affinity: favRole?.affinity || 0,
        companionMs: 0,
        tokens: 0,
        messages: 0,
        mood: '',
        relation: '',
      }
    : null;

  const saveFavorite = useCallback(
    async (patch: Partial<AppSettings>) => {
      await api.saveSettings(patch);
      // ThemeContext 会通过 settings:changed 广播刷新，这里不重复 reload（避免双重请求）
    },
    []
  );

  /**
   * 换人物时清掉上一位人物的性别/签名。
   *
   * ⚠️ 铁律：favoriteGender / favoriteSignature 描述的是**某一个具体人物**，
   * 换人却不清空就会把 A 的签名显示到 B 头上（用户明确要求「换人物要重置」）。
   * 本函数是「**直接落盘**换人」的唯一出处（主页面未设置时的加号走它）；
   * 编辑界面里的换人走 `pickFavoriteInEditor`，它对**草稿**做同样的重置，
   * 但要等用户点「保存」才落盘 —— 两条入口的最终效果一致，只是时机不同。
   */
  const clearFavoritePersonFields = useCallback(
    (keepRoleId: string): Partial<AppSettings> => ({
      favoriteRoleId: keepRoleId,
      favoriteSetAt: Date.now(),
      favoriteGender: undefined,
      favoriteSignature: '',
      favoriteOccupation: '',
      favoritePersonality: '',
      favoriteHobby: '',
      favoriteNationality: '',
      favoriteEducation: '',
      favoriteFood: '',
    }),
    []
  );

  /**
   * 直接设置最喜爱人物（**会重置性别与签名**）。
   * 仅用于「主页面未设置时的加号」这一条不想先进编辑界面的快捷入口。
   */
  const setFavoriteRole = useCallback(
    (roleId: string) => {
      setFavDraft(EMPTY_FAV_DRAFT);
      void saveFavorite(clearFavoritePersonFields(roleId));
    },
    [saveFavorite, clearFavoritePersonFields]
  );

  /** 清除全部最喜爱人物设置（编辑界面与主页面共用） */
  const clearFavorite = useCallback(() => {
    setFavDraft(EMPTY_FAV_DRAFT);
    void saveFavorite({
      favoriteRoleId: undefined,
      favoriteGender: undefined,
      favoriteSignature: '',
      favoriteOccupation: '',
      favoritePersonality: '',
      favoriteHobby: '',
      favoriteNationality: '',
      favoriteEducation: '',
      favoriteFood: '',
      favoriteSetAt: undefined,
    });
  }, [saveFavorite]);

  /** 进入编辑界面：把当前已保存的值复制成草稿，取消时才能干净地丢弃改动 */
  const openFavoriteEditor = useCallback(() => {
    setFavDraft({
      roleId: favId || '',
      gender: settings?.favoriteGender,
      signature: settings?.favoriteSignature || '',
      occupation: settings?.favoriteOccupation || '',
      personality: settings?.favoritePersonality || '',
      hobby: settings?.favoriteHobby || '',
      nationality: settings?.favoriteNationality || '',
      education: settings?.favoriteEducation || '',
      food: settings?.favoriteFood || '',
    });
    setPage('favEdit');
  }, [
    favId,
    settings?.favoriteGender,
    settings?.favoriteSignature,
    settings?.favoriteOccupation,
    settings?.favoritePersonality,
    settings?.favoriteHobby,
    settings?.favoriteNationality,
    settings?.favoriteEducation,
    settings?.favoriteFood,
  ]);

  /**
   * 编辑界面里换人物 → **立即清空草稿里的性别与签名**，
   * 否则用户会看到（并可能保存）上一位人物的签名。
   * 这里只改草稿、不落盘：用户若点了「取消」，一切照旧。
   */
  const pickFavoriteInEditor = useCallback((roleId: string) => {
    setFavDraft((prev) =>
      prev.roleId === roleId
        ? prev
        : {
            roleId,
            gender: undefined,
            signature: '',
            occupation: '',
            personality: '',
            hobby: '',
            nationality: '',
            education: '',
            food: '',
          }
    );
  }, []);

  /** 保存草稿：roleId / gender / signature / setAt 一起写回 settings */
  const saveFavoriteDraft = useCallback(() => {
    const roleId = favDraft.roleId;
    // 未选人物时保存 = 什么都不该发生（编辑界面本身就要求先选一位）
    if (!roleId) return;
    const changed = roleId !== (settings?.favoriteRoleId || '');
    void saveFavorite({
      favoriteRoleId: roleId,
      favoriteGender: favDraft.gender,
      favoriteSignature: favDraft.signature.trim(),
      favoriteOccupation: favDraft.occupation.trim(),
      favoritePersonality: favDraft.personality.trim(),
      favoriteHobby: favDraft.hobby.trim(),
      favoriteNationality: favDraft.nationality.trim(),
      favoriteEducation: favDraft.education.trim(),
      favoriteFood: favDraft.food.trim(),
      // 换人时刷新设置时间；同一人只改性别/签名不算「重新设置」
      favoriteSetAt: changed ? Date.now() : settings?.favoriteSetAt ?? Date.now(),
    });
    setPage('main');
  }, [favDraft, saveFavorite, settings?.favoriteRoleId, settings?.favoriteSetAt]);

  /** 取消编辑：丢弃草稿（不改任何已保存值），回主页面 */
  const cancelFavoriteEdit = useCallback(() => {
    setFavDraft(EMPTY_FAV_DRAFT);
    setPage('main');
  }, []);

  /** 编辑界面里清除设置：落盘清空 + 回主页面 */
  const clearFavoriteInEditor = useCallback(() => {
    clearFavorite();
    setPage('main');
  }, [clearFavorite]);

  // ---------- 渲染 ----------

  // ===== 子页：「你最喜欢的人物」编辑界面（v2.3.95 新增）=====
  // 主页面只做展示（用户原话：「统计界面只是一个展示窗口而已」），
  // 写签名 / 选性别 / 换人物全部集中在这里，改完点保存才落盘。
  if (page === 'favEdit') {
    const draftRow = favDraft.roleId ? rows.find((r) => r.roleId === favDraft.roleId) || null : null;
    return (
      <div className="main-pane">
        <div className="list-header">
          <span>{t('stats.favEditTitle')}</span>
        </div>
        <div className="list-scroll">
          <div className="panel" style={{ padding: 16 }}>
            <div className="stats-subpage-head">
              <button className="stats-back-btn" onClick={cancelFavoriteEdit}>
                ← {t('stats.back')}
              </button>
            </div>
            <FavoriteEditor
              draft={favDraft}
              draftRow={draftRow}
              savedRoleId={favId || ''}
              roleCount={Object.keys(roles).length}
              onOpenPicker={() => setEditorPickerOpen(true)}
              onGenderChange={(g) => setFavDraft((prev) => ({ ...prev, gender: g }))}
              onSignatureChange={(v) => setFavDraft((prev) => ({ ...prev, signature: v }))}
              onFieldChange={(k, v) => setFavDraft((prev) => ({ ...prev, [k]: v }))}
              onSave={saveFavoriteDraft}
              onCancel={cancelFavoriteEdit}
              onClear={clearFavoriteInEditor}
            />
          </div>
        </div>

        {editorPickerOpen && (
          <RolePicker
            roles={Object.values(roles)}
            onPick={(r) => {
              pickFavoriteInEditor(r.id);
              setEditorPickerOpen(false);
            }}
            onClose={() => setEditorPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  if (page === 'tokenRank') {
    return (
      <div className="main-pane">
        <div className="list-header">
          <span>{t('stats.tokenRankAll')}</span>
        </div>
        <div className="list-scroll">
          <div className="panel" style={{ padding: 16 }}>
            <div className="stats-subpage-head">
              <button className="stats-back-btn" onClick={() => setPage('main')}>
                ← {t('stats.back')}
              </button>
            </div>
            <TokenRankList rows={rows} animOn={animOn} />
          </div>
        </div>
      </div>
    );
  }

  if (page === 'bondRank') {
    return (
      <div className="main-pane">
        <div className="list-header">
          <span>{t('stats.bondRankAll')}</span>
        </div>
        <div className="list-scroll">
          <div className="panel" style={{ padding: 16 }}>
            <div className="stats-subpage-head">
              <button className="stats-back-btn" onClick={() => setPage('main')}>
                ← {t('stats.back')}
              </button>
              <RankSwitch mode={rankMode} onChange={setRankMode} />
            </div>
            <BondRankList rows={rows} mode={rankMode} animOn={animOn} showAll />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="main-pane">
      <div className="list-header">
        <span>{t('stats.title')}</span>
      </div>
      <div className="list-scroll">
        <div className="panel" style={{ padding: 16 }}>
          {/* ===== 板块一（v2.3.95 调整为「最上方」）：你最喜欢的人物 =====
              用户原话：「我最喜欢的人物板块应该在统计界面的最上方」。
              因此它渲染在**累计总 Token 之上、板块二之前**，是整个统计页的第一屏第一块。
              视觉权重仍是全页最大：22px 内边距 + 84px 头像 + 主色描边 + 阴影卡片。

              ⚠️ v2.3.95：这一块已改为**纯展示**（不再有签名输入框与性别按钮），
              一切编辑操作都搬进了 `favEdit` 子页，入口是卡片右上角的编辑按钮。
              未设置时仍保留大号加号作为入口（点它直接打开人物选择弹层）。 */}
          <FavoriteSection
            favRow={favRow}
            gender={settings?.favoriteGender}
            signature={settings?.favoriteSignature || ''}
            occupation={settings?.favoriteOccupation || ''}
            personality={settings?.favoritePersonality || ''}
            hobby={settings?.favoriteHobby || ''}
            nationality={settings?.favoriteNationality || ''}
            education={settings?.favoriteEducation || ''}
            food={settings?.favoriteFood || ''}
            onOpenEditor={openFavoriteEditor}
            onOpenPicker={() => setPickerOpen(true)}
            animOn={animOn}
          />

          <div style={{ marginBottom: 16, fontSize: 14 }}>{t('stats.global', { n: global })}</div>

          {/* ===== 板块二：Token 消耗排名（饼状图） ===== */}
          <div className="stats-section">
            <div className="stats-section-title">
              <span>{t('stats.tokenRank')}</span>
              <span className="stats-title-hint">{t('stats.tokenRankHint')}</span>
            </div>
            {/* v2.3.95：原来这里是 `slices.length === 0 ? <div className="stats-empty">…</div> : <PieChart/>`，
                即「没数据 → 整块饼图连位置一起消失」，用户只看到一行字，饼图从未出现。
                现在改为：无数据时也画出「空圆环」占位 + 提示文案，
                让饼图区域始终存在、也让用户知道这里本该有内容。 */}
            {slices.length === 0 ? (
              <PieEmptyState />
            ) : (
              <PieChart
                slices={slices}
                animOn={animOn}
                animSpeed={animSpeed}
                total={global}
                onEnterDetail={() => setPage('tokenRank')}
              />
            )}
          </div>

          {/* ===== 板块三：好感度排行 + 陪伴时间排行 ===== */}
          <div className="stats-section">
            <div className="stats-section-title">
              <span>{t('stats.bondRank')}</span>
              <RankSwitch mode={rankMode} onChange={setRankMode} />
              <button
                className="stats-back-btn"
                style={{ marginLeft: 'auto' }}
                onClick={() => setPage('bondRank')}
              >
                {t('stats.viewAll')}
              </button>
            </div>
            {bondTop5.length === 0 ? (
              <div className="stats-empty">{t('stats.noRoles')}</div>
            ) : (
              <BondRankList rows={bondTop5} mode={rankMode} animOn={animOn} />
            )}
          </div>

          {/* ===== 聊天模型调用量排名（沿用原有区块，放在最后不抢三大板块的视觉重心）===== */}
          <div className="stats-section">
            <div className="stats-section-title">
              <span>{t('stats.modelRank')}</span>
            </div>
            {modelStats.length === 0 ? (
              <div className="stats-empty">{t('stats.modelEmpty')}</div>
            ) : (
              <ModelRankList modelStats={modelStats} animOn={animOn} />
            )}
          </div>
        </div>
      </div>

      {pickerOpen && (
        <RolePicker
          roles={Object.values(roles)}
          onPick={(r) => {
            setFavoriteRole(r.id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
};

// ============================================================================
// 板块一：Token 饼图
// ============================================================================

/**
 * 饼图空态（v2.3.95）。
 *
 * 为什么需要它：用户反馈「聊天统计界面的饼图呢？饼图去哪了」。
 * 真实原因是没有任何人物产生过 Token 消耗时，`buildPieSlices` 按设计返回空数组
 * （它的对外签名与语义本任务不改，见 statsRank.ts 注释），
 * 而旧代码在空数组时**直接把整个饼图区域替换成一行文字**——
 * 于是「没有数据」被渲染成了「饼图不存在」，两件事在视觉上无法区分。
 *
 * 现在无数据时画一个**只有底色圆环、没有扇区**的空饼，
 * 并配一行i18n 提示「去聊几句就会出现」，明确表达「这里该有饼图，只是还没有数据」。
 *
 * 无障碍：圆环用 --color-text-muted + --color-border 双层描边
 * （实测 --color-panel-alt 与面板底仅 1.0~1.15:1，用它画环等于隐形；
 *   text-muted 实测 3.45~5.43:1，满足 WCAG 1.4.11 非文本对比 ≥3:1），
 *   圆环纯装饰故aria-hidden；提示文字用 --color-text / --color-text-secondary
 * （14 套主题均 ≥ WCAG AA），并用 role="status" 让屏幕阅读器能播报这段状态变化。
 */
const PieEmptyState: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="stats-pie-wrap">
      <div className="stats-pie-box" aria-hidden="true">
        <svg className="stats-pie-svg" viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}>
          {/* 空圆环：内外半径与有数据时完全一致，保证空态 ↔ 有数据切换时不跳动。
              画两层（外圈 --color-border / 内圈 --color-text-muted）：
              实测 --color-panel-alt 与面板底只有 1.0~1.15:1（肉眼分不出），
              用它画环等于「空环依旧隐形」，那就等于没修这个BUG；
              text-muted 实测 3.45~5.43:1，满足非文本对比 ≥3:1。 */}
          <circle
            className="stats-pie-empty-ring is-outer"
            cx={PIE_CX}
            cy={PIE_CY}
            r={(PIE_R_OUT + PIE_R_IN) / 2}
            strokeWidth={PIE_R_OUT - PIE_R_IN}
          />
          <circle
            className="stats-pie-empty-ring is-inner"
            cx={PIE_CX}
            cy={PIE_CY}
            r={(PIE_R_OUT + PIE_R_IN) / 2}
            strokeWidth={Math.max(2, (PIE_R_OUT - PIE_R_IN) * 0.4)}
          />
        </svg>
      </div>
      <div className="stats-pie-empty-text" role="status">
        <div className="stats-pie-empty-title">{t('stats.pieEmptyTitle')}</div>
        <div className="stats-pie-empty-hint">{t('stats.pieEmptyHint')}</div>
      </div>
    </div>
  );
};

/** 饼图（手写 SVG，无图表库） */
const PieChart: React.FC<{
  slices: PieSlice[];
  animOn: boolean;
  /** v2.3.97：界面动效速度倍率（1 = 正常）。补间总时长 = PIE_ANIM_MS / animSpeed。 */
  animSpeed: number;
  total: number;
  onEnterDetail: () => void;
}> = ({ slices, animOn, animSpeed, total, onEnterDetail }) => {
  const { t } = useI18n();
  // 动画进度 0~1：从 0 顺时针拉到 1
  const [progress, setProgress] = useState(animOn ? 0 : 1);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  // v2.3.97：按速度倍率缩放补间总时长。倍率存进 ref 供 effect 读取，
  // 避免把 animSpeed 直接放进依赖数组导致每次变速都重播一遍饼图。
  const speedRef = useRef(animSpeed);
  useEffect(() => {
    speedRef.current = animSpeed;
  }, [animSpeed]);

  // 数据或动效开关变化时重播动画
  useEffect(() => {
    if (!animOn) {
      setProgress(1);
      return;
    }
    setProgress(0);
    startRef.current = 0;
    // v2.3.97：总时长按倍率缩放（倍率越大越慢，故是**乘**）。夹上下限防脏数据。
    const totalMs = Math.min(10000, Math.max(1, PIE_ANIM_MS * speedRef.current));
    const step = (ts: number) => {
      if (!startRef.current) startRef.current = ts;
      const p = Math.min(1, (ts - startRef.current) / totalMs);
      // easeOutCubic：起步快、收尾稳，避免机械的匀速感
      setProgress(1 - Math.pow(1 - p, 3));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [animOn, slices]);

  // 各扇区的起止角（12 点为 0，顺时针）
  //
  // 非法项保护（v2.3.95）：ratio 可能是 NaN / Infinity / 负数（脏数据或除零），
  // 一旦算出 NaN 角度，arcPath 会返回含 "NaN" 的 path 串，浏览器**整条 path 都画不出来**
  // （不是只丢一个扇区）—— 实测中这正是「饼图整块消失」的直接原因之一。
  // 故这里先把非有限值按 0 处理并过滤掉，再做累加。
  const geo = useMemo(() => {
    const valid = slices.filter((s) => Number.isFinite(s.ratio) && s.ratio > 0);
    let acc = 0;
    return valid.map((s) => {
      const span = s.ratio * 360;
      const start = acc;
      acc += span;
      return { slice: s, start, span };
    });
  }, [slices]);

  // 归一化后的总角度：用于把「各扇区 span 之和」拉回精确的 360°，
  // 避免浮点累加误差让最后一条扇区差一点点角度而出现缺口。
  const totalSpan = geo.length > 0 ? geo[geo.length - 1].start + geo[geo.length - 1].span : 0;

  const hovered = geo.find((g) => g.slice.key === hoverKey) || null;

  return (
    <div className="stats-pie-wrap">
      <div
        className="stats-pie-box"
        role="button"
        tabIndex={0}
        title={t('stats.tokenRankEnter')}
        onClick={onEnterDetail}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onEnterDetail();
          }
        }}
      >
        <svg className="stats-pie-svg" viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}>
          {/* 每个区块按 progress 从 0 长到满；最后再整体淡入（"浮现"）

              ⚠️ v2.3.95 修复的致命 BUG：原来写的是 `Math.min(1, g.span * progress)`。
              这里的上限必须是**扇区自己的 span（度）**，不是常量 1：
              写成 1 等于把「弧长」当成「占比」来截断，任何扇区动画结束时都只画
              **1 度**（≈1.5px 头发丝）→ 整块饼图看起来就是「没有」。
              这才是「饼图去哪了」的第一主因（比空数组更致命：它连有数据时也不显示）。
              另外 animOn=false 时直接给终态 g.span，绝不能停在 progress=0。 */}
          {geo.map((g) => {
            const p = animOn ? Math.max(0, Math.min(1, progress)) : 1;
            const shown = Math.max(0, Math.min(g.span, g.span * p));
            if (shown <= 0.05) return null;
            // 归一化：把最后一条扇区的终点对齐到 360°，消除浮点累加误差造成的缺口
            const scale = totalSpan > 0 && Math.abs(totalSpan - 360) > 1e-6 ? 360 / totalSpan : 1;
            const fullEnd = g.start + g.span * scale;
            const shownEnd = g.start + shown * scale;
            const half = SLICE_GAP_DEG / 2;
            const complete = shownEnd >= fullEnd - 1e-6;
            const start = g.start + (complete ? 0 : half);
            const end = shownEnd - (complete ? 0 : half);
            const d = arcPath(PIE_CX, PIE_CY, PIE_R_OUT, PIE_R_IN, start, Math.max(start, end));
            if (!d || /NaN|Infinity/.test(d)) return null;
            return (
              <path
                key={g.slice.key}
                className={`stats-pie-slice${hoverKey === g.slice.key ? ' is-hover' : ''}`}
                d={d}
                fill={g.slice.color}
                stroke="var(--color-panel)"
                strokeWidth={1}
                opacity={animOn ? Math.max(0, Math.min(1, progress)) : 1}
                onMouseEnter={() => setHoverKey(g.slice.key)}
                onMouseLeave={() => setHoverKey((k) => (k === g.slice.key ? null : k))}
              />
            );
          })}
          {/* 中心留白：显示总量（比实心饼更易读，也给「点击进入」留个视觉锚点） */}
          <text className="stats-pie-center-label" x={PIE_CX} y={PIE_CY - 6}>
            {t('stats.pieCenterLabel')}
          </text>
          <text className="stats-pie-center-value" x={PIE_CX} y={PIE_CY + 14}>
            {total}
          </text>
        </svg>
        {hovered && (
          <div
            className="stats-pie-tip"
            style={{
              left: '50%',
              top: 0,
              transform: 'translate(-50%, -8px)',
            }}
          >
            <div className="stats-tip-name">{hovered.slice.name}</div>
            {/* 文字色按扇区实际颜色计算，保证 AA 对比度（浅色扇区也能看清） */}
            <div
              className="stats-tip-val"
              style={tooltipValueStyle(hovered.slice.color)}
            >
              {t('stats.tipTokens', {
                n: hovered.slice.tokens,
                p: ((Number.isFinite(hovered.slice.ratio) ? hovered.slice.ratio : 0) * 100).toFixed(1),
              })}
            </div>
          </div>
        )}
      </div>

      {/* 图例走 geo（而非原始 slices），保证「图例条目」与「实际画出的扇区」严格一一对应：
          非法 ratio 的项在 geo 里已被过滤掉，不会出现「图例有、饼上没有」的幽灵条目。 */}
      <div className="stats-legend">
        {geo.map((g) => {
          const s = g.slice;
          // 非有限 ratio 一律显示 0.0%，绝不把 "NaN%" 抛给用户
          const pct = (Number.isFinite(s.ratio) ? s.ratio : 0) * 100;
          return (
            <div
              key={s.key}
              className="stats-legend-row"
              onMouseEnter={() => setHoverKey(s.key)}
              onMouseLeave={() => setHoverKey((k) => (k === s.key ? null : k))}
              onClick={onEnterDetail}
            >
              <span className="stats-legend-dot" style={{ background: s.color }} />
              <span className="stats-legend-name">{s.name}</span>
              <span className="stats-legend-val">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
        <div className="stats-legend-row" style={{ cursor: 'default' }}>
          <span className="stats-legend-name" style={{ color: 'var(--color-text-secondary)' }}>
            {t('stats.otherThreshold', { p: Math.round(OTHER_THRESHOLD * 100) })}
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * tooltip 里数值行的样式：按扇区背景色挑一个达到 WCAG AA 的前景色。
 * 主题深浅不可控（用户可自定义扇区配色），故运行时计算而不是写死一套灰/白。
 */
function tooltipValueStyle(bg: string): React.CSSProperties {
  const parsed = parseCssColor(bg);
  if (!parsed) return {};
  // 扇区本身太亮时，把文字压到近黑；太暗时提到近白 —— 两者对各自背景都 ≥ 4.5:1
  const lum = relativeLuminance(parsed);
  const fg = lum > 0.45 ? '#101010' : readableTextOn(parsed);
  const ok = contrastRatio(parsed, parseCssColor(fg) || [0, 0, 0]) >= 4.5;
  return { color: ok ? fg : '#ffffff', fontWeight: 600 };
}

// ============================================================================
// 板块一子页 / 板块二：完整榜单
// ============================================================================

/** Token 完整榜单（点击饼图进入）：Token 降序，同分按名称 A→Z */
const TokenRankList: React.FC<{ rows: RankRow[]; animOn: boolean }> = ({ rows, animOn }) => {
  const { t } = useI18n();
  const companionText = useCompanionText();
  const list = useMemo(() => sortByTokensDesc(rows), [rows]);
  const max = Math.max(1, ...list.map((r) => r.tokens));
  if (list.length === 0) return <div className="stats-empty">{t('stats.noRoles')}</div>;
  return (
    <div className="stats-rank-list">
      {list.map((r, i) => (
        <div className="stats-rank-row" key={r.roleId}>
          <span className="stats-rank-no">{i + 1}</span>
          <div className="avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 13 }}>
            {r.avatar ? <AvatarImg path={r.avatar} /> : '🤖'}
          </div>
          <span className="stats-rank-name">{r.name}</span>
          <div className="stats-rank-metrics">
            <span>
              {t('stats.messages')}：<b>{r.messages}</b>
            </span>
            <span>
              {t('stats.companion')}：<b>{companionText(r.companionMs)}</b>
            </span>
            <span>
              {t('stats.tokens')}：<b>{r.tokens}</b>
            </span>
          </div>
          {/* 同时给出「相对最大值的比例条」，让差距一眼可见（宽度过渡走 stats 分组） */}
          <div
            style={{
              width: 72,
              height: 8,
              borderRadius: 4,
              background: 'var(--color-panel-alt)',
              overflow: 'hidden',
              flex: '0 0 auto',
            }}
          >
            <div
              className="stats-pie-slice"
              style={{
                width: `${(r.tokens / max) * 100}%`,
                height: '100%',
                background: 'var(--color-primary)',
                transformOrigin: 'left center',
                transition: animOn ? 'width var(--transition)' : 'none',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

/** 排序标准切换（好感度 / 陪伴时间） */
const RankSwitch: React.FC<{ mode: RankMode; onChange: (m: RankMode) => void }> = ({ mode, onChange }) => {
  const { t } = useI18n();
  return (
    <div className="stats-rank-switch" role="tablist">
      <button
        className={mode === 'affinity' ? 'active' : ''}
        role="tab"
        aria-selected={mode === 'affinity'}
        onClick={() => onChange('affinity')}
      >
        {t('stats.sortByAffinity')}
      </button>
      <button
        className={mode === 'companion' ? 'active' : ''}
        role="tab"
        aria-selected={mode === 'companion'}
        onClick={() => onChange('companion')}
      >
        {t('stats.sortByCompanion')}
      </button>
    </div>
  );
};

/** 好感度 / 陪伴时间排行（主界面只给前五，子页给全部） */
const BondRankList: React.FC<{
  rows: RankRow[];
  mode: RankMode;
  /** 由外层 isGroupEnabled(settings,'stats') 门控后传入；保留入参以便将来加入场动画 */
  animOn: boolean;
  showAll?: boolean;
}> = ({ rows, mode, animOn: _animOn, showAll }) => {
  const { t } = useI18n();
  const companionText = useCompanionText();
  const list = useMemo(() => sortRows(rows, mode), [rows, mode]);
  if (list.length === 0) return <div className="stats-empty">{t('stats.noRoles')}</div>;
  return (
    <div className="stats-rank-list">
      {list.map((r, i) => (
        <div className="stats-rank-row" key={r.roleId}>
          <span className="stats-rank-no">{i + 1}</span>
          <div className="avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 13 }}>
            {r.avatar ? <AvatarImg path={r.avatar} /> : '🤖'}
          </div>
          <span className="stats-rank-name">{r.name}</span>
          {/* 主界面粗略展示：只给「陪伴时间 + 人名」；子页才给全量指标 */}
          <div className="stats-rank-metrics">
            {showAll && (
              <span>
                {t('stats.messages')}：<b>{r.messages}</b>
              </span>
            )}
            <span>
              {t('stats.companion')}：<b>{companionText(r.companionMs)}</b>
            </span>
            <span>
              {t('stats.affinity')}：<b>{r.affinity}</b>
            </span>
          </div>
          {/* 子页补上心情/关系（原 StatsView 的既有信息，不丢） */}
          {showAll && (
            <div className="stats-rank-metrics" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              {r.mood && (
                <span>
                  {t('stats.mood')}：{r.mood}
                </span>
              )}
              {r.relation && (
                <span>
                  {t('stats.relation')}：{relationLabelOf(r.relation)}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

/** 模型调用量排名（沿用原有数据与展示，换成与其它板块一致的容器） */
const ModelRankList: React.FC<{
  modelStats: { modelId: string; name: string; tokens: number; calls: number }[];
  animOn: boolean;
}> = ({ modelStats, animOn }) => {
  const { t } = useI18n();
  const max = Math.max(1, ...modelStats.map((m) => m.tokens));
  return (
    <div className="stats-rank-list">
      {modelStats.map((m) => (
        <div className="stats-rank-row" key={m.modelId}>
          <span className="stats-rank-name">{m.name}</span>
          <div className="stats-rank-metrics">
            <span>{t('stats.modelCalls', { n: m.calls })}</span>
            <span>
              {t('stats.tokens')}：<b>{m.tokens}</b>
            </span>
          </div>
          <div
            style={{
              width: 72,
              height: 8,
              borderRadius: 4,
              background: 'var(--color-panel-alt)',
              overflow: 'hidden',
              flex: '0 0 auto',
            }}
          >
            <div
              className="stats-pie-slice"
              style={{
                width: `${(m.tokens / max) * 100}%`,
                height: '100%',
                background: 'var(--color-primary)',
                transformOrigin: 'left center',
                transition: animOn ? 'width var(--transition)' : 'none',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// 板块一（最上方）：你最喜欢的人物 —— **主页面纯展示**
// ============================================================================

/**
 * 「你最喜欢的人物」卡片（统计页**主界面**，v2.3.95 起为纯展示）。
 *
 * 设计约束（用户原话）：「统计界面只是一个展示窗口而已，在这个编辑界面才能写个性签名、
 * 选择性别」。因此这里**不再有签名输入框与性别按钮**，只剩：
 *   - 头像、名字、陪伴时长、Token 数、消息数；
 *   - 性别（设置过才显示，未设置留空）；
 *   - 个性签名（写過才显示，未写留空）；
 *   - 右上角的**编辑入口**（进入 favEdit 子页）。
 *
 * 未设置人物时仍显示大号加号：这是「**选一个**」而不是「改内容」，
 * 属于入口行为而非编辑控件，故仍留在主页面（沿用 v2.3.94 的既有行为）。
 */
const FavoriteSection: React.FC<{
  favRow: RankRow | null;
  gender: 'male' | 'female' | undefined;
  signature: string;
  /** v2.3.101：6 个可选资料字段（空串 = 未填，不展示） */
  occupation: string;
  personality: string;
  hobby: string;
  nationality: string;
  education: string;
  food: string;
  /** 进入独立编辑界面（favEdit 子页） */
  onOpenEditor: () => void;
  /** 未设置时点大号加号 → 打开人物选择弹层 */
  onOpenPicker: () => void;
  animOn: boolean;
}> = ({
  favRow,
  gender,
  signature,
  occupation,
  personality,
  hobby,
  nationality,
  education,
  food,
  onOpenEditor,
  onOpenPicker,
  // animOn 已由外层门控进 stats 分组；此处保留入参以便将来给卡片加入场动画
}) => {
  const { t } = useI18n();
  const companionText = useCompanionText();
  // 只展示**有值**的资料项（未填不占位）
  const infoItems = [
    { label: t('stats.favOccupationLabel'), value: occupation },
    { label: t('stats.favPersonalityLabel'), value: personality },
    { label: t('stats.favHobbyLabel'), value: hobby },
    { label: t('stats.favNationalityLabel'), value: nationality },
    { label: t('stats.favEducationLabel'), value: education },
    { label: t('stats.favFoodLabel'), value: food },
  ].filter((it) => it.value.trim());
  return (
    <div className={`stats-fav-card${favRow ? ' is-set' : ''}`}>
      <div className="stats-fav-head">
        <span>{t('stats.favTitle')}</span>
        {/* 编辑入口固定在板块**右上角**（用户指定的位置）。
            未设置人物时也显示：用户可以直接进编辑界面再挑人，不必先点加号。 */}
        <button
          className="stats-fav-edit-btn"
          title={t('stats.favEdit')}
          aria-label={t('stats.favEdit')}
          onClick={onOpenEditor}
        >
          <span aria-hidden="true">✎</span>
        </button>
      </div>
      {!favRow ? (
        <div className="stats-fav-body">
          <button
            className="stats-fav-plus"
            title={t('stats.favSet')}
            aria-label={t('stats.favSet')}
            onClick={onOpenPicker}
          >
            ＋
          </button>
          <div className="stats-fav-info">
            <div className="stats-fav-name" style={{ fontSize: 15 }}>
              {t('stats.favUnset')}
            </div>
            <div className="stats-fav-metrics">{t('stats.favUnsetHint')}</div>
          </div>
        </div>
      ) : (
        <>
          <div className="stats-fav-body">
            <div className="stats-fav-avatar">
              {favRow.avatar ? <AvatarImg path={favRow.avatar} /> : '🤖'}
            </div>
            <div className="stats-fav-info">
              <div className="stats-fav-name">
                <span>{favRow.name}</span>
                {/* 用户自选性别；没选就留空（不按角色卡的 gender 猜，避免替用户做决定） */}
                {gender && <span className="stats-fav-gender">{t(`stats.gender.${gender}`)}</span>}
              </div>
              <div className="stats-fav-metrics">
                <span>
                  {t('stats.companion')}：<b>{companionText(favRow.companionMs)}</b>
                </span>
                <span>
                  {t('stats.tokens')}：<b>{favRow.tokens}</b>
                </span>
                <span>
                  {t('stats.messages')}：<b>{favRow.messages}</b>
                </span>
              </div>
            </div>
          </div>

          {/* 个性签名：只读展示。用户自己写；未写则整块留空（不占位、不显示占位符）。 */}
          {signature.trim() && (
            <div className="stats-fav-signature-view">{signature}</div>
          )}

          {/* v2.3.101：6 个资料字段（职业/性格/爱好/国籍/学历/菜）。
              只展示**有值**的项；一项都没有时整块不渲染（不占位）。 */}
          {infoItems.length > 0 && (
            <div className="stats-fav-info-list">
              {infoItems.map((it) => (
                <div className="stats-fav-info-item" key={it.label}>
                  <span className="k">{it.label}：</span>
                  <span className="v">{it.value}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ============================================================================
// favEdit 子页：「你最喜欢的人物」编辑界面
// ============================================================================

/**
 * 编辑界面（`page === 'favEdit'`）。
 *
 * 为什么要有独立界面：用户要求统计页主界面「只是一个展示窗口」，
 * 所有会**改动数据**的控件（换人物 / 选性别 / 写签名）都集中在这里，
 * 并且必须点「保存」才写回 settings —— 点「取消」则一行都不改。
 *
 * 三个字段各自独立：
 *   1. 人物：复用 RolePicker（内部走 fuzzySearch.suggest，最多 5 条候选）；
 *   2. 性别：单选按钮组（男 / 女 / 不选），不用下拉 —— 当前选择一眼可见；
 *   3. 个性签名：多行 textarea（人物签名可能较长，input 单行不够用）。
 */
const FavoriteEditor: React.FC<{
  /** 草稿（用户正在改、还没保存） */
  draft: FavDraft;
  /** 草稿里那位人物的展示数据（可能为 null：刚选完还没进统计缓存） */
  draftRow: RankRow | null;
  /** 已保存的最喜爱人物 roleId（空串 = 尚未设置过）；只用于决定「清除设置」是否显示 */
  savedRoleId: string;
  /** 人物总数：0 时提示「还没有任何人物」并禁用保存 */
  roleCount: number;
  onOpenPicker: () => void;
  onGenderChange: (g: 'male' | 'female' | undefined) => void;
  onSignatureChange: (v: string) => void;
  /** v2.3.101：6 个资料字段的统一变更回调 */
  onFieldChange: (key: FavFieldKey, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onClear: () => void;
}> = ({
  draft,
  draftRow,
  savedRoleId,
  roleCount,
  onOpenPicker,
  onGenderChange,
  onSignatureChange,
  onFieldChange,
  onSave,
  onCancel,
  onClear,
}) => {
  const { t } = useI18n();
  const hasRole = !!draft.roleId;
  // 「清除设置」只在**确实已保存过**一位人物时才显示（否则点了无事发生，是骗人的 UI）
  const canClear = !!savedRoleId;
  // v2.3.101：6 个资料字段的展示定义（标签 / 占位提示走 i18n）
  const fieldDefs: { key: FavFieldKey; label: string; ph: string }[] = [
    { key: 'occupation', label: t('stats.favOccupationLabel'), ph: t('stats.favOccupationPh') },
    { key: 'personality', label: t('stats.favPersonalityLabel'), ph: t('stats.favPersonalityPh') },
    { key: 'hobby', label: t('stats.favHobbyLabel'), ph: t('stats.favHobbyPh') },
    { key: 'nationality', label: t('stats.favNationalityLabel'), ph: t('stats.favNationalityPh') },
    { key: 'education', label: t('stats.favEducationLabel'), ph: t('stats.favEducationPh') },
    { key: 'food', label: t('stats.favFoodLabel'), ph: t('stats.favFoodPh') },
  ];

  return (
    <div className="stats-fav-editor">
      {/* ---- 1. 人物 ---- */}
      <div className="stats-fav-editor-block">
        <div className="stats-fav-editor-label">{t('stats.favRoleLabel')}</div>
        <div className="stats-fav-editor-pick">
          {draftRow ? (
            <>
              <div className="avatar" style={{ width: 40, height: 40, borderRadius: 10, fontSize: 19 }}>
                {draftRow.avatar ? <AvatarImg path={draftRow.avatar} /> : '🤖'}
              </div>
              <span className="stats-fav-editor-picked">{draftRow.name}</span>
            </>
          ) : (
            <span className="stats-fav-editor-picked is-empty">
              {hasRole ? draft.roleId : t('stats.favUnset')}
            </span>
          )}
          <button
            className="stats-back-btn"
            style={{ marginLeft: 'auto' }}
            onClick={onOpenPicker}
            disabled={roleCount === 0}
          >
            {hasRole ? t('stats.favChange') : t('stats.favSet')}
          </button>
        </div>
        {roleCount === 0 && <div className="stats-fav-editor-hint">{t('stats.noRoles')}</div>}
      </div>

      {/* ---- 2. 性别（单选按钮组，不用下拉：当前选择一眼可见） ---- */}
      <div className="stats-fav-editor-block">
        <div className="stats-fav-editor-label">{t('stats.favGenderLabel')}</div>
        <div className="stats-fav-gender-pick" role="radiogroup" aria-label={t('stats.favGenderLabel')}>
          <button
            type="button"
            role="radio"
            aria-checked={draft.gender === 'male'}
            className={draft.gender === 'male' ? 'active' : ''}
            onClick={() => onGenderChange('male')}
          >
            {t('stats.gender.male')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={draft.gender === 'female'}
            className={draft.gender === 'female' ? 'active' : ''}
            onClick={() => onGenderChange('female')}
          >
            {t('stats.gender.female')}
          </button>
          {/* 「不选」= 清空性别（settings 里存undefined → 主页面留空不显示） */}
          <button
            type="button"
            role="radio"
            aria-checked={draft.gender === undefined}
            className={draft.gender === undefined ? 'active' : ''}
            onClick={() => onGenderChange(undefined)}
          >
            {t('stats.favGenderNone')}
          </button>
        </div>
      </div>

      {/* ---- 3. 个性签名（多行） ---- */}
      <div className="stats-fav-editor-block">
        <div className="stats-fav-editor-label" id="stats-fav-signature-label">
          {t('stats.favSignatureLabel')}
        </div>
        <div className="stats-fav-signature">
          <textarea
            rows={3}
            value={draft.signature}
            aria-labelledby="stats-fav-signature-label"
            placeholder={t('stats.favSignaturePh')}
            maxLength={FAV_SIGNATURE_MAXLEN}
            onChange={(e) => onSignatureChange(e.target.value)}
          />
        </div>
        {/* 字数提示（仅在接近上限时出现，避免平时噪音） */}
        {draft.signature.trim().length >= FAV_SIGNATURE_MAXLEN - 20 && (
          <div className="stats-fav-editor-hint">
            {draft.signature.length} / {FAV_SIGNATURE_MAXLEN}
          </div>
        )}
      </div>

      {/* ---- 4. 资料字段（职业 / 性格 / 爱好 / 国籍 / 学历 / 最喜欢吃的菜；单行、可留空） ---- */}
      {fieldDefs.map((f) => (
        <div className="stats-fav-editor-block" key={f.key}>
          <div className="stats-fav-editor-label">{f.label}</div>
          <div className="stats-fav-field">
            <input
              type="text"
              value={draft[f.key]}
              placeholder={f.ph}
              maxLength={FAV_FIELD_MAXLEN}
              onChange={(e) => onFieldChange(f.key, e.target.value)}
            />
          </div>
        </div>
      ))}

      {/* ---- 5. 保存 / 取消 / 清除设置 ---- */}
      <div className="stats-fav-editor-actions">
        {/* disabled 的原生 button 在部分浏览器里不派发鼠标事件，title 提示会失效，
            故把「先选人物」的提示做成**常驻可见**的一行字（且仅在未选时出现）。 */}
        <button className="btn-primary" onClick={onSave} disabled={!hasRole}>
          {t('stats.favSave')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        {canClear && (
          <button className="stats-back-btn" style={{ marginLeft: 'auto' }} onClick={onClear}>
            {t('stats.favClear')}
          </button>
        )}
      </div>
      {!hasRole && <div className="stats-fav-editor-hint">{t('stats.favPickFirst')}</div>}
    </div>
  );
};

// ============================================================================
// 人物选择弹层（模糊搜索 · 必须走 utils/fuzzySearch 的 suggest）
// ============================================================================

const RolePicker: React.FC<{
  roles: Role[];
  onPick: (r: Role) => void;
  onClose: () => void;
}> = ({ roles, onPick, onClose }) => {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Esc 关闭
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 模糊搜索：走 fuzzySearch 的 suggest（最多 MAX_SUGGESTIONS 条），
  // 绝不自写 filter(includes) —— 那是用户的全局铁律。
  // 候选总数另用 rankCandidates 求（用于底部「显示 x / y 位」提示与是否显示滚动条）。
  const shown = useMemo(
    () => suggest(q, roles, (r) => ({ label: r.name, keywords: [r.occupation, r.short_intro] })),
    [q, roles]
  );
  const total = useMemo(
    () => rankCandidates(q, roles, (r) => ({ label: r.name, keywords: [r.occupation, r.short_intro] })).length,
    [q, roles]
  );

  return (
    <div className="stats-role-pick-mask" onClick={onClose}>
      <div className="stats-role-pick" onClick={(e) => e.stopPropagation()}>
        <div className="stats-role-pick-head">
          <span>{t('stats.favPickTitle')}</span>
          <button className="stats-role-pick-close" onClick={onClose} title={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="stats-role-pick-search">
          <input
            ref={inputRef}
            value={q}
            placeholder={t('stats.favSearchPh')}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="stats-role-pick-list">
          {shown.length === 0 && <div className="stats-empty">{t('stats.favNoResult')}</div>}
          {shown.map((r) => (
            <button key={r.id} className="stats-role-pick-item" onClick={() => onPick(r)}>
              <div className="avatar" style={{ width: 26, height: 26, borderRadius: 8, fontSize: 12 }}>
                {r.avatar_path ? <AvatarImg path={r.avatar_path} /> : '🤖'}
              </div>
              <span className="stats-role-pick-name">
                {highlightParts(r.name, q).map((p, i) =>
                  p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="stats-role-pick-meta">
          {t('stats.favPickMeta', { shown: shown.length, total, max: MAX_SUGGESTIONS })}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 关系标签（板块一子页 / 板块二子页展示「心情 / 关系」时复用）
// ============================================================================

/** 把关系值渲染成合法枚举标签（AI 可能给出自由中文/英文，需归一化后再查表） */
export function relationLabelOf(relation: string): string {
  const key = normalizeRelation(relation) as keyof typeof RELATION_LABELS;
  return RELATION_LABELS[key] || relation;
}