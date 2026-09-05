import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './Toast';
import type { ModelConfig } from '../types';

const COLORS = ['#7c6cf0', '#4fc3f7', '#ff9f43'];

interface CmpResult {
  modelId: string;
  modelName: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
  error: string;
}

// 模型对比：把同一问题同时发给 ≤3 个模型，一个窗口三列对照展示；
// 与角色记忆完全无关（纯测试对话窗）；可 JSON 导出；默认模型自动评判输出质量。
// 每个模型完成后立即推送结果，各窗口独立计时、独立展示（首个完成的窗口立刻出字与耗时）。
export const ModelCompare: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [question, setQuestion] = useState('');
  const [sel, setSel] = useState<string[]>(['', '', '']);
  const [running, setRunning] = useState(false);
  const [compareId, setCompareId] = useState('');
  // 以 modelId 为键，结果/评分渐进写入（某模型完成即写入，不等待其他模型）
  const [results, setResults] = useState<Record<string, CmpResult>>({});
  const [judgments, setJudgments] = useState<Record<string, { score: number; comment: string }>>({});
  const [judgeError, setJudgeError] = useState('');
  const [judgeModelId, setJudgeModelId] = useState(''); // '' = 使用默认模型；可选任意已启用模型（含被测模型=互评）
  const [runStart, setRunStart] = useState(0);
  const [now, setNow] = useState(0);
  const [judgeModel, setJudgeModel] = useState('');
  const [totalMs, setTotalMs] = useState(0);
  const [lastQ, setLastQ] = useState('');
  // 当前正在独立评分的模型（逐模型顺序评判）：用于显示「正在评分」横幅，明确评分进行中
  const [judging, setJudging] = useState<{ modelId: string; modelName: string } | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      const enabled = s.models.filter((m) => m.enabled);
      setModels(enabled);
      setSel((prev) => prev.map((v, i) => v || enabled[i]?.id || ''));
    });
  }, []);

  // 运行期间每 100ms 刷新一次计时基准，用于各窗口「实时计时」展示
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(iv);
  }, [running]);

  // 订阅渐进式广播：按 compareId 过滤，每个模型完成即独立更新该列
  useEffect(() => {
    if (!compareId) return;
    const offResult = api.onCompareResult((_e, data) => {
      if (data.compareId !== compareId) return;
      setResults((prev) => ({
        ...prev,
        [data.modelId]: {
          modelId: data.modelId,
          modelName: data.modelName,
          content: data.content,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          elapsedMs: data.elapsedMs,
          error: data.error,
        },
      }));
    });
    const offJudged = api.onCompareJudged((_e, data) => {
      if (data.compareId !== compareId) return;
      setJudgments(data.judgments);
      setJudgeModel(data.judgeModel);
      setJudgeError(data.judgeError || '');
      setJudging(null); // 全部评分结束，收起「正在评分」横幅
    });
    const offJudging = api.onCompareJudging((_e, data) => {
      if (data.compareId !== compareId) return;
      setJudging({ modelId: data.modelId, modelName: data.modelName });
    });
    const offDone = api.onCompareDone((_e, data) => {
      if (data.compareId !== compareId) return;
      setTotalMs(data.totalMs);
      setJudging(null);
    });
    return () => {
      offResult();
      offJudged();
      offJudging();
      offDone();
    };
  }, [compareId]);

  const activeIds = sel.filter(Boolean).slice(0, 3);

  const run = async () => {
    const q = question.trim();
    if (!q) {
      showToast(t('compare.needQuestion'));
      return;
    }
    if (!activeIds.length) {
      showToast(t('compare.needModel'));
      return;
    }
    const cid = `cmp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    setCompareId(cid);
    setResults({});
    setJudgments({});
    setRunStart(Date.now());
    setNow(Date.now());
    setRunning(true);
    setLastQ(q);
    setJudgeModel('');
    setJudgeError('');
    setJudging(null);
    setTotalMs(0);
    try {
      await api.compareStart({ question: q, modelIds: activeIds, compareId: cid, judgeModelId: judgeModelId || undefined });
    } catch (e: any) {
      showToast(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const exportJson = async () => {
    const payload = {
      question: lastQ || question.trim(),
      timestamp: new Date().toISOString(),
      judgeModel,
      totalMs,
      results: activeIds.map((id) => {
        const r = results[id];
        return {
          modelId: id,
          modelName: r?.modelName || id,
          elapsedMs: r?.elapsedMs ?? 0,
          promptTokens: r?.promptTokens ?? 0,
          completionTokens: r?.completionTokens ?? 0,
          error: r?.error || '',
          content: r?.content || '',
          quality: judgments[id] || null,
        };
      }),
    };
    await api.saveTextFile(JSON.stringify(payload, null, 2), 'model-compare.json');
  };

  const cellStyle: React.CSSProperties = {
    border: '1px solid var(--color-border, #3a3a44)',
    borderRadius: 12,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 320,
    background: 'var(--color-bg-card, #26262e)',
  };

  // 输出框：浅灰底 + 深字，保证任意主题下都清晰可读（不受深色卡片背景影响）
  const outputStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    marginTop: 10,
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    minHeight: 120,
    background: '#f2f3f5',
    color: '#1f2329',
    borderRadius: 8,
    padding: '10px 12px',
  };

  return (
    <div className="main-pane" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border, #333)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t('compare.questionPlaceholder')}
          rows={2}
          style={{ flex: 1, minWidth: 220, resize: 'vertical' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--color-text-secondary)' }}>{t('compare.judgeModel')}</span>
          <select
            value={judgeModelId}
            onChange={(e) => setJudgeModelId(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 8, minWidth: 130 }}
            title={t('compare.judgeModelTip')}
          >
            <option value="">{t('compare.judgeDefault')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <button className="btn-primary" disabled={running} onClick={run}>
          {running ? t('compare.running') : t('compare.start')}
        </button>
        <button className="btn-ghost" onClick={exportJson} title={t('compare.exportJson')}>
          {t('compare.exportJson')}
        </button>
      </div>

      {judging && (
        <div
          style={{
            margin: '0 14px',
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(33,150,243,0.12)',
            border: '1px solid rgba(33,150,243,0.4)',
            color: '#1565c0',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span className="typing" aria-label={t('compare.judging')}>
            <span className="typing-bar" />
          </span>
          <span>{t('compare.judging', { name: judging.modelName })}</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: 14, alignItems: 'start', minHeight: 0 }}>
        {[0, 1, 2].map((idx) => {
          const id = sel[idx];
          const res = id ? results[id] : undefined;
          const judge = id ? judgments[id] : undefined;
          const done = !!res;
          const elapsedMs = done ? res!.elapsedMs : running ? now - runStart : 0;
          const showTimer = running || done;
          return (
            <div key={idx} style={cellStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: `2px solid ${COLORS[idx]}`, paddingBottom: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: COLORS[idx], flexShrink: 0 }} />
                <select
                  value={id}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSel((prev) => prev.map((x, j) => (j === idx ? v : x)));
                    setResults((prev) => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    });
                    setJudgments((prev) => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    });
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <option value="">{t('compare.pickModel')}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                {showTimer && (
                  <span
                    style={{ fontSize: 11, whiteSpace: 'nowrap', color: done ? '#2e7d32' : '#9aa0a6' }}
                    title={t('compare.elapsedTip')}
                  >
                    ⏱ {(elapsedMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>

              <div style={outputStyle}>
                {running && !res ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#5a5f66' }}>
                    <span className="typing" aria-label={t('chat.replying')}>
                      <span className="typing-bar" />
                    </span>
                    <span style={{ fontSize: 12 }}>{t('compare.generating')}</span>
                  </div>
                ) : res ? (
                  res.error ? (
                    <span style={{ color: '#d32f2f' }}>{t('compare.failed', { msg: res.error })}</span>
                  ) : (
                    res.content || '( )'
                  )
                ) : (
                  <span style={{ color: '#9aa0a6' }}>{t('compare.waiting')}</span>
                )}
              </div>

              {done && res && !res.error && (
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #d0d3d8', fontSize: 11, color: '#5a5f66' }}>
                  <div>
                    {t('compare.tokens', { n: res.completionTokens + res.promptTokens })}
                    <span style={{ marginLeft: 8 }}>{t('compare.chars', { n: res.content.length })}</span>
                  </div>
                  {judge ? (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 4 }}>{t('compare.qualityTitle')}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14 }}>{judge.score >= 85 ? '🟢' : judge.score >= 60 ? '🟡' : '🔴'}</span>
                        <span style={{ fontWeight: 600, color: judge.score >= 85 ? '#2e7d32' : judge.score >= 60 ? '#b26a00' : '#d32f2f' }}>
                          {judge.score}
                        </span>
                        <span>{judge.comment}</span>
                      </div>
                    </div>
                  ) : judgeModel ? (
                    // 评判已执行（judgeModel 已设置）但该模型无有效评分：明确提示，而非留白让用户以为「没跑评判」
                    <div style={{ marginTop: 8, fontSize: 11, color: '#b26a00' }}>{t('compare.noScore')}</div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {judgeError && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid rgba(217,83,79,.4)', fontSize: 12, color: '#d9534f' }}>
          ⚠️ {t('compare.judgeFailed', { msg: judgeError })}
        </div>
      )}
      {judgeModel && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--color-border, #333)', fontSize: 12, color: 'var(--color-text-secondary, #999)' }}>
          {t('compare.judgeBy', { model: judgeModel, total: (totalMs / 1000).toFixed(1) })}
        </div>
      )}
    </div>
  );
};
