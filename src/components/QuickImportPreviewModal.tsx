// 拖拽导入的「预检确认弹窗」（v2.3.97）
//
// 用户拖文件进窗口时，先由主进程 `import:previewFiles` **只读**解析一遍（不落库），
// 把每个文件的 类型 / 大小 / 关键字段摘要 / 失败原因 交给本组件展示，
// 用户点确认后才真正导入。三种出口：
//   取消        —— 什么都不做（原 v2.3.51 的行为里没有这一步，这是本次新增的核心）
//   仅导入      —— 走既有 import:dropFiles，行为与 v2.3.51 完全一致
//   导入并编辑  —— 可编辑类型（角色卡/世界书/规则）先交给编辑器，点保存才落库；
//                  取消编辑等于完全没导入。插件无编辑器，降级为「仅导入」
//
// 无障碍（WCAG 2.1 AA）：
//   - role="dialog" + aria-modal + aria-labelledby/aria-describedby
//   - Esc 取消；打开时把焦点移到「仅导入」（最安全的默认动作），关闭后焦点归还触发元素
//   - 失败项**不只用颜色区分**（WCAG 1.4.1）：额外带 ⚠ 图标 + 「无法导入」文字标签
//   - 焦点在弹窗内循环（Tab / Shift+Tab 不逃出），避免键盘用户 Tab 到被遮住的背景
//   - 颜色一律走主题 CSS 变量，14 套主题下对比度均达标
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { api } from '../ipc';
import type { QuickImportPreviewItem } from '../types';

export interface QuickImportPreviewState {
  /** 正在读文件（IPC 未返回） */
  loading: boolean;
  /** 预检结果；null 表示还没开始或已关闭 */
  result: { items: QuickImportPreviewItem[]; truncated: number; limit: number } | null;
  error: string;
}

/** 字节数 → 人类可读（与 FilePickerModal 的 formatSize 同一套单位，便于全站一致） */
function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** 每种导入类型的图标（与 quick-import 徽标同族，纯装饰，语义由旁边的文字承担） */
const KIND_ICON: Record<string, string> = {
  role: '👤',
  worldbook: '📖',
  rule: '📝',
  plugin: '🧩',
};

/**
 * 头像缩略图。
 *
 * ⚠️ 必须定义在**模块作用域**，不能定义在 QuickImportPreviewModal 的函数体内：
 * 定义在函数体内会让每次渲染都产生一个新的组件类型，React 据此判定「类型变了」
 * 而卸载重挂载 —— 于是 useState 的 src 被清空、useEffect 重新跑 api.getImage，
 * 形成「渲染 → 卸载重挂 → 取图 → setState → 再渲染」的无限循环（IPC 被刷爆）。
 */
const AvatarThumb: React.FC<{ item: QuickImportPreviewItem }> = ({ item }) => {
  const rp = item.rolePreview;
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    if (!rp?.avatarPath) return;
    api
      .getImage(rp.avatarPath)
      .then((s) => {
        if (alive && s) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [rp?.avatarPath]);
  const finalSrc = rp?.avatarDataUrl || src;
  if (!finalSrc) return <div className="qip-thumb qip-thumb-empty" aria-hidden="true">👤</div>;
  return <img className="qip-thumb" src={finalSrc} alt="" />;
};

export const QuickImportPreviewModal: React.FC<{
  state: QuickImportPreviewState;
  /** 用户点「仅导入」：交给调用方去跑既有 importDroppedFiles */
  onImportOnly: (items: QuickImportPreviewItem[]) => void;
  /** 用户点「导入并编辑」：交给调用方打开编辑器（内部按draft 类型分流）。
   *  声明为可返回 Promise：调用方要把 PNG 头像归位到图片目录，是异步的。 */
  onImportAndEdit: (items: QuickImportPreviewItem[]) => void | Promise<void>;
  onClose: () => void;
}> = ({ state, onImportOnly, onImportAndEdit, onClose }) => {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const importOnlyRef = useRef<HTMLButtonElement>(null);
  /** 打开弹窗前的焦点，关弹窗时归还（无障碍要求） */
  const openerRef = useRef<HTMLElement | null>(null);

  const items = state.result?.items || [];
  const okItems = useMemo(() => items.filter((i) => !i.error), [items]);
  const badItems = useMemo(() => items.filter((i) => !!i.error), [items]);
  const editableItems = useMemo(() => okItems.filter((i) => !!i.draft), [okItems]);
  /** 是否有任何可编辑项 → 决定「导入并编辑」按钮是否可用 */
  const canEdit = editableItems.length > 0;

  // 列表行的入场：首帧不加 .is-in（保持 CSS 基态 opacity:0），
  // 下一帧再加上，浏览器才会把「基态 → is-in」当成一次 transition 来插值。
  // 用 rAF 而非 setTimeout(0)：与浏览器的一帧绘制对齐，避免偶发跳帧。
  const [rowsIn, setRowsIn] = useState(false);
  useEffect(() => {
    if (!state.result) return;
    let raf = 0;
    raf = requestAnimationFrame(() => setRowsIn(true));
    return () => cancelAnimationFrame(raf);
  }, [state.result]);

  // 打开时记住焦点来源；关闭时归还
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    // 焦点落到最安全的默认动作「仅导入」上（而不是「导入并编辑」，后者会改变数据形态）
    importOnlyRef.current?.focus();
    return () => {
      const el = openerRef.current;
      if (el && document.body.contains(el)) el.focus();
    };
  }, []);

  // Esc 取消；Tab 在弹窗内循环（键盘用户不该Tab 到被遮罩住的背景内容上）
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal qip-modal"
        style={{ width: 620, maxWidth: '94vw' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qip-title"
        aria-describedby="qip-desc"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <span id="qip-title">📥 {t('quickimport.preview.title')}</span>
          <span className="modal-close" onClick={onClose} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); } }}
            aria-label={t('common.close')}
          >
            ×
          </span>
        </div>

        <div className="modal-body">
          <p id="qip-desc" className="qip-desc">
            {state.loading
              ? t('quickimport.preview.loading')
              : t('quickimport.preview.desc')}
          </p>

          {state.error && (
            <div className="qip-error" role="alert">
              <span aria-hidden="true">⚠</span> {state.error}
            </div>
          )}

          {!state.loading && !state.error && items.length === 0 && (
            <div className="qip-empty">{t('quickimport.preview.empty')}</div>
          )}

          {!state.loading && items.length > 0 && (
            <ul className="qip-list">
              {items.map((it, idx) => (
                <li
                  key={it.path}
                  className={`qip-item${rowsIn ? ' is-in' : ''}${it.error ? ' qip-item-bad' : ''}`}
                  // 列表行的入场是 stagger 的（每行 +18ms，最多前 8 行），
                  // 让长列表逐行浮现而不是整块「啪」地出现。
                  style={{ transitionDelay: `${Math.min(idx, 8) * 18}ms` }}
                >
                  <div className="qip-item-head">
                    {it.kind === 'role' && !it.error && <AvatarThumb item={it} />}
                    <span className="qip-name" title={it.fileName}>
                      {it.fileName}
                    </span>
                    <span className="qip-size">{formatSize(it.size)}</span>
                    {it.error ? (
                      // 失败徽标：颜色 + 图标 + 文字三重编码（WCAG 1.4.1 不靠颜色单独传达信息）
                      <span className="qip-badge qip-badge-bad">
                        <span aria-hidden="true">⚠</span> {t('quickimport.preview.badLabel')}
                      </span>
                    ) : (
                      <span className={`qip-badge qip-badge-${it.kind}`}>
                        <span aria-hidden="true">{KIND_ICON[it.kind] || '📄'}</span>{' '}
                        {t(`quickimport.${it.kind}`)}
                      </span>
                    )}
                  </div>

                  {it.error ? (
                    <div className="qip-reason">
                      {t(`quickimport.err_${it.error.code}`)}
                      {it.error.message ? `（${it.error.message}）` : ''}
                    </div>
                  ) : (
                    <div className="qip-detail">
                      {it.rolePreview && (
                        <>
                          <div className="qip-detail-name">{it.rolePreview.name}</div>
                          {it.rolePreview.fields.length > 0 && (
                            <div className="qip-fields">
                              {it.rolePreview.fields.map((f, i) => (
                                <span className="qip-field" key={`${f.labelKey}-${i}`}>
                                  <span className="qip-field-label">{t(f.labelKey)}</span>
                                  <span className="qip-field-value">{f.value}</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {it.rolePreview.summary && (
                            <div className="qip-summary">{it.rolePreview.summary}</div>
                          )}
                        </>
                      )}
                      {it.bookPreview && (
                        <>
                          <div className="qip-detail-name">{it.bookPreview.name}</div>
                          <div className="qip-fields">
                            <span className="qip-field">
                              <span className="qip-field-label">{t('quickimport.preview.entries')}</span>
                              <span className="qip-field-value">{it.bookPreview.entryCount}</span>
                            </span>
                            {it.bookPreview.keysSample.length > 0 && (
                              <span className="qip-field">
                                <span className="qip-field-label">{t('quickimport.preview.keys')}</span>
                                <span className="qip-field-value">{it.bookPreview.keysSample.join(' / ')}</span>
                              </span>
                            )}
                          </div>
                        </>
                      )}
                      {it.rulePreview && (
                        <>
                          <div className="qip-detail-name">{it.rulePreview.name}</div>
                          <div className="qip-fields">
                            <span className="qip-field">
                              <span className="qip-field-label">{t('quickimport.preview.chars')}</span>
                              <span className="qip-field-value">{it.rulePreview.charCount}</span>
                            </span>
                          </div>
                          {it.rulePreview.excerpt && <div className="qip-summary">{it.rulePreview.excerpt}</div>}
                        </>
                      )}
                      {it.pluginPreview && (
                        <>
                          <div className="qip-detail-name">{it.pluginPreview.name}</div>
                          <div className="qip-fields">
                            <span className="qip-field">
                              <span className="qip-field-label">{t('quickimport.preview.tools')}</span>
                              <span className="qip-field-value">{it.pluginPreview.toolCount}</span>
                            </span>
                            <span className="qip-field">
                              <span className="qip-field-label">{t('quickimport.preview.segments')}</span>
                              <span className="qip-field-value">{it.pluginPreview.segmentCount}</span>
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {state.result && state.result.truncated > 0 && (
            <p className="qip-truncated">
              {t('quickimport.preview.truncated', {
                n: state.result.truncated,
                limit: state.result.limit,
              })}
            </p>
          )}

          {badItems.length > 0 && okItems.length > 0 && (
            <p className="qip-hint">{t('quickimport.preview.badHint')}</p>
          )}
        </div>

        <div className="modal-actions qip-actions">
          <button className="btn-ghost" onClick={onClose}>
            {t('quickimport.preview.cancel')}
          </button>
          <button
            className="btn-primary"
            ref={importOnlyRef}
            disabled={state.loading || okItems.length === 0}
            onClick={() => onImportOnly(okItems)}
          >
            {t('quickimport.preview.importOnly')}
          </button>
          {canEdit ? (
            <button className="btn-primary" disabled={state.loading} onClick={() => onImportAndEdit(editableItems)}>
              {t('quickimport.preview.importAndEdit')}
            </button>
          ) : (
            // 没有可编辑类型（全是插件/失败项）时保留一个 disabled 按钮而不是让布局跳动，
            // 并用 title 说明原因 —— 键盘/读屏用户也能知道为什么不能逐个编辑
            <button
              className="btn-primary"
              disabled
              title={t('quickimport.preview.noEditable')}
              aria-label={`${t('quickimport.preview.importAndEdit')} — ${t('quickimport.preview.noEditable')}`}
            >
              {t('quickimport.preview.importAndEdit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickImportPreviewModal;