import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import type { AppSettings, Role, RoleStat } from '../types';
import { AvatarImg } from './ChatList';
import { normalizeRelation, RELATION_LABELS } from '../types';
import { isGroupEnabled } from '../utils/animControl';
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
/** 「从圆心顺时针拉开」的总时长（ms） */
const PIE_ANIM_MS = 900;

/** 子页面 */
type SubPage = 'main' | 'tokenRank' | 'bondRank';

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

  const [stats, setStats] = useState<RoleStat[]>([]);
  const [global, setGlobal] = useState(0);
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [modelStats, setModelStats] = useState<{ modelId: string; name: string; tokens: number; calls: number }[]>([]);
  const [companionByRole, setCompanionByRole] = useState<Record<string, number>>({});
  const [page, setPage] = useState<SubPage>('main');
  const [rankMode, setRankMode] = useState<RankMode>('affinity');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [signatureDraft, setSignatureDraft] = useState<string | null>(null);

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

  const setFavoriteRole = useCallback(
    (roleId: string) => {
      setSignatureDraft(null);
      void saveFavorite({
        favoriteRoleId: roleId,
        favoriteSetAt: Date.now(),
        // 换人时清掉上一位人物的性别/签名（否则会把 A 的签名显示到 B 头上）
        favoriteGender: undefined,
        favoriteSignature: '',
      });
    },
    [saveFavorite]
  );

  const clearFavorite = useCallback(() => {
    setSignatureDraft(null);
    void saveFavorite({
      favoriteRoleId: undefined,
      favoriteGender: undefined,
      favoriteSignature: '',
      favoriteSetAt: undefined,
    });
  }, [saveFavorite]);

  // ---------- 渲染 ----------
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
          <div style={{ marginBottom: 16, fontSize: 14 }}>{t('stats.global', { n: global })}</div>

          {/* ===== 板块一：Token 消耗排名（饼状图） ===== */}
          <div className="stats-section">
            <div className="stats-section-title">
              <span>{t('stats.tokenRank')}</span>
              <span className="stats-title-hint">{t('stats.tokenRankHint')}</span>
            </div>
            {slices.length === 0 ? (
              <div className="stats-empty">{t('stats.empty')}</div>
            ) : (
              <PieChart
                slices={slices}
                animOn={animOn}
                total={global}
                onEnterDetail={() => setPage('tokenRank')}
              />
            )}
          </div>

          {/* ===== 板块三：你最喜欢的人物（中间偏上、最突出、占用空间最大）=====
              用户要求位置在三大板块的「中间偏上」：这里渲染在板块一之后、板块二之前，
              即三块内容的中段偏上；同时它又是三者中面积最大的一张卡
              （22px 内边距 + 84px 头像 + 主色描边），因此仍是全页最突出的元素。 */}
          <FavoriteSection
            favRow={favRow}
            gender={settings?.favoriteGender}
            signature={signatureDraft ?? settings?.favoriteSignature ?? ''}
            onOpenPicker={() => setPickerOpen(true)}
            onClear={clearFavorite}
            onSetGender={(g) => void saveFavorite({ favoriteGender: g })}
            onSignatureChange={setSignatureDraft}
            onSignatureCommit={(v) => void saveFavorite({ favoriteSignature: v })}
            animOn={animOn}
          />

          {/* ===== 板块二：好感度排行 + 陪伴时间排行 ===== */}
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

/** 饼图（手写 SVG，无图表库） */
const PieChart: React.FC<{
  slices: PieSlice[];
  animOn: boolean;
  total: number;
  onEnterDetail: () => void;
}> = ({ slices, animOn, total, onEnterDetail }) => {
  const { t } = useI18n();
  // 动画进度 0~1：从 0 顺时针拉到 1
  const [progress, setProgress] = useState(animOn ? 0 : 1);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  // 数据或动效开关变化时重播动画
  useEffect(() => {
    if (!animOn) {
      setProgress(1);
      return;
    }
    setProgress(0);
    startRef.current = 0;
    const step = (ts: number) => {
      if (!startRef.current) startRef.current = ts;
      const p = Math.min(1, (ts - startRef.current) / PIE_ANIM_MS);
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
  const geo = useMemo(() => {
    let acc = 0;
    return slices.map((s) => {
      const span = s.ratio * 360;
      const start = acc;
      acc += span;
      return { slice: s, start, span };
    });
  }, [slices]);

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
          {/* 每个区块按 progress 从 0 长到满；最后再整体淡入（"浮现"） */}
          {geo.map((g) => {
            const shown = animOn ? Math.max(0, Math.min(1, g.span * progress)) : g.span;
            if (shown <= 0.05) return null;
            const half = SLICE_GAP_DEG / 2;
            const start = g.start + (shown >= g.span ? 0 : half);
            const end = g.start + shown - (shown >= g.span ? 0 : half);
            const d = arcPath(PIE_CX, PIE_CY, PIE_R_OUT, PIE_R_IN, start, Math.max(start, end));
            if (!d) return null;
            return (
              <path
                key={g.slice.key}
                className={`stats-pie-slice${hoverKey === g.slice.key ? ' is-hover' : ''}`}
                d={d}
                fill={g.slice.color}
                stroke="var(--color-panel)"
                strokeWidth={1}
                opacity={animOn ? progress : 1}
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
                p: (hovered.slice.ratio * 100).toFixed(1),
              })}
            </div>
          </div>
        )}
      </div>

      <div className="stats-legend">
        {slices.map((s) => (
          <div
            key={s.key}
            className="stats-legend-row"
            onMouseEnter={() => setHoverKey(s.key)}
            onMouseLeave={() => setHoverKey((k) => (k === s.key ? null : k))}
            onClick={onEnterDetail}
          >
            <span className="stats-legend-dot" style={{ background: s.color }} />
            <span className="stats-legend-name">{s.name}</span>
            <span className="stats-legend-val">{(s.ratio * 100).toFixed(1)}%</span>
          </div>
        ))}
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
// 板块三：你最喜欢的人物
// ============================================================================

const FavoriteSection: React.FC<{
  favRow: RankRow | null;
  gender: 'male' | 'female' | undefined;
  signature: string;
  onOpenPicker: () => void;
  onClear: () => void;
  onSetGender: (g: 'male' | 'female' | undefined) => void;
  onSignatureChange: (v: string) => void;
  onSignatureCommit: (v: string) => void;
  animOn: boolean;
}> = ({
  favRow,
  gender,
  signature,
  onOpenPicker,
  onClear,
  onSetGender,
  onSignatureChange,
  onSignatureCommit,
  // animOn 已由外层门控进 stats 分组；此处保留入参以便将来给卡片加入场动画
}) => {
  const { t } = useI18n();
  const companionText = useCompanionText();
  return (
    <div className={`stats-fav-card${favRow ? ' is-set' : ''}`}>
      <div className="stats-fav-head">
        <span>{t('stats.favTitle')}</span>
      </div>
      {!favRow ? (
        <div className="stats-fav-body">
          <button className="stats-fav-plus" title={t('stats.favSet')} onClick={onOpenPicker}>
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

          <div className="stats-fav-actions">
            <button className="stats-back-btn" onClick={onOpenPicker}>
              {t('stats.favChange')}
            </button>
            <button className="stats-back-btn" onClick={onClear}>
              {t('stats.favClear')}
            </button>
            {/* 性别：用户自己选男/女，不选就留空 */}
            <div className="stats-fav-gender-pick">
              <span>{t('stats.favGenderLabel')}</span>
              <button
                className={gender === 'male' ? 'active' : ''}
                onClick={() => onSetGender(gender === 'male' ? undefined : 'male')}
              >
                {t('stats.gender.male')}
              </button>
              <button
                className={gender === 'female' ? 'active' : ''}
                onClick={() => onSetGender(gender === 'female' ? undefined : 'female')}
              >
                {t('stats.gender.female')}
              </button>
            </div>
          </div>

          {/* 个性签名：用户自己写，未写留空 */}
          <div className="stats-fav-signature">
            <input
              value={signature}
              placeholder={t('stats.favSignaturePh')}
              maxLength={60}
              onChange={(e) => onSignatureChange(e.target.value)}
              onBlur={(e) => onSignatureCommit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
        </>
      )}
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