import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useRetract, RETRACT_MS } from '../hooks/useRetract';
import type { DirEntryFile, DirListing, DirPlace } from '../ipc';

/**
 * 自绘文件选择器（v2.3.97）—— 替换 Electron 的 `dialog.showOpenDialog` / `showSaveDialog`。
 *
 * 三种形态：
 *  - `open`      选文件，可多选（`pickImage` 需要），按扩展名过滤
 *  - `save`      选保存路径，底部带文件名输入框
 *  - `directory` 只选目录（隐藏文件列表与文件名输入框）
 *
 * 样式：复用现成的 `.modal-mask` + `.modal` + `.modal-head/body/foot`，
 * 不另造容器样式，因此入场动画与动效开关自动继承。
 *
 * 无障碍：`role="dialog"` + `aria-modal`；文件列表用 `role="listbox"` / `role="option"`
 * + `aria-selected`；↑/↓ 移动高亮、Enter 确认、Esc 取消；焦点锁在弹窗内。
 */
export interface FilePickerModalProps {
  open: boolean;
  kind: 'open' | 'save' | 'directory';
  title?: string;
  /** 扩展名过滤（小写、不含点）。空 = 不过滤 */
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
  defaultName?: string;
  startDir?: string;
  /** 同名文件自动改名（备份另存为，与旧实现一致，绝不静默覆盖） */
  unique?: boolean;
  onConfirm: (paths: string[]) => void;
  onCancel: () => void;
}

/** 当前请求的过滤扩展名集合（小写、不含点） */
function filterExtSet(filters?: { name: string; extensions: string[] }[]): Set<string> {
  const set = new Set<string>();
  for (const f of filters || []) {
    for (const ext of f.extensions || []) set.add(String(ext).replace(/^\./, '').toLowerCase());
  }
  return set;
}

/** 取文件名的扩展名（小写、不含点）；无扩展名返回空串 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/**
 * 把 `fs:makeDir` 的错误码映射成 i18n 键。
 * 未知码一律回落到通用「创建失败」——宁可文案笼统，也不要把原始码/英文异常
 * 直接甩到界面上（那正是本次改造要消灭的粗糙感）。
 */
function makeDirErrorKey(code?: string): string {
  switch (code) {
    case 'INVALID_NAME':
    case 'NAME_TOO_LONG':
      return 'filepicker.mkdirInvalidName';
    case 'EXISTS':
      return 'filepicker.mkdirExists';
    case 'PERMISSION':
      return 'filepicker.mkdirPermission';
    case 'NOT_A_DIR':
      return 'filepicker.mkdirNotDir';
    default:
      return 'filepicker.mkdirFailed';
  }
}

/** 人类可读的体积（B / KB / MB / GB） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

const FilePickerModal: React.FC<FilePickerModalProps> = ({
  open,
  kind,
  title,
  filters,
  multiple = false,
  defaultName = '',
  startDir = '',
  unique = false,
  onConfirm,
  onCancel,
}) => {
  const { t, lang } = useI18n();
  // 分组传 'theme'：与 ConfirmDialog 同理（.modal-mask 已由 modal-anim 登记在 theme 组）
  const { shown, leaving } = useRetract(open ? true : null, RETRACT_MS, 'theme');

  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  /** open 模式：已勾选的文件绝对路径（多选累加，跨目录） */
  const [picked, setPicked] = useState<string[]>([]);
  /** save 模式：文件名输入框 */
  const [fileName, setFileName] = useState(defaultName);
  /** 当前高亮项（键盘导航用） */
  const [activeIdx, setActiveIdx] = useState(0);
  /** v2.3.97：新建文件夹的内联输入（null = 未展开）。只读文件夹不需要。 */
  const [mkdirName, setMkdirName] = useState<string | null>(null);
  /** 新建文件夹的失败提示（i18n 键，已按 makeDirErrorKey 映射） */
  const [mkdirErr, setMkdirErr] = useState<string>('');
  /** 新建进行中（防连点重复提交） */
  const [mkdirBusy, setMkdirBusy] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  /** 打开时的起始目录请求（只发一次；目录内的后续切换由用户操作触发） */
  const requestedStart = useRef(false);
  /** 新建文件夹的内联输入框 ref（展开后聚焦） */
  const mkdirInputRef = useRef<HTMLInputElement | null>(null);

  const extSet = useMemo(() => filterExtSet(filters), [filters]);

  /** 按扩展名过滤后的文件列表（目录不过滤） */
  const visibleFiles: DirEntryFile[] = useMemo(() => {
    if (!listing) return [];
    if (extSet.size === 0) return listing.files;
    return listing.files.filter((f) => extSet.has(extOf(f.name)));
  }, [listing, extSet]);

  /** 合并后的可选项：目录在前（. 分组），文件在后 */
  const options = useMemo(() => {
    const dirs = listing?.dirs || [];
    return {
      dirs,
      files: visibleFiles,
      total: dirs.length + visibleFiles.length,
    };
  }, [listing, visibleFiles]);

  // ---- 目录加载 ----
  const loadDir = useCallback(
    async (dir: string) => {
      setLoading(true);
      try {
        // v2.3.97 修 tsc2722/TS18048：`api.listDir` 在 IPC 契约里是可选方法
        // （preload 的 API 面是 Partial，Web/无 preload 环境下可能不存在），严格模式下
        // 直接调用会报"可能是 undefined"。这里显式判空并降级为空列表 —— 与下面的
        // catch 分支同构：列不出目录时弹窗仍可用（可手动输路径），不该整窗崩掉。
        const listDir = api.listDir;
        if (!listDir) {
          setListing(null);
          return;
        }
        const r = await listDir({ dir });
        setListing(r);
        setActiveIdx(0);
      } catch (e) {
        // 列目录失败（主进程异常）→ 保留空列表，不崩弹窗
        console.error('[FilePicker] 列目录失败', e);
        setListing(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // 打开时：重置状态 + 加载起始目录 + 焦点落到确定按钮（save 模式落输入框）
  useEffect(() => {
    if (!open) return;
    requestedStart.current = false;
    setPicked([]);
    setFileName(defaultName);
    setActiveIdx(0);
    // 重置新建文件夹的内联状态（同一宿主会复用同一个组件实例）
    setMkdirName(null);
    setMkdirErr('');
    setMkdirBusy(false);
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    loadDir(startDir);
    const id = window.requestAnimationFrame(() => {
      if (kind === 'save') inputRef.current?.focus();
      else okRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, startDir, defaultName, kind, loadDir]);

  // 关闭（含退场结束）：焦点归还原触发元素
  useEffect(() => {
    if (open || shown) return;
    const el = restoreRef.current;
    restoreRef.current = null;
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
  }, [open, shown]);

  /** 切换某个文件的勾选状态（多选） */
  const togglePick = useCallback(
    (absPath: string) => {
      setPicked((prev) => {
        if (prev.includes(absPath)) return prev.filter((p) => p !== absPath);
        // 单选模式下勾选新项即替换旧项
        if (!multiple) return [absPath];
        return [...prev, absPath];
      });
    },
    [multiple]
  );

  /** save 模式：避免与目录内已有文件同名（unique 模式追加 _1/_2，与旧 backup 行为一致） */
  const resolveSavePath = useCallback(
    (name: string): string => {
      const base = listing?.cwd || '';
      const sep = base.includes('\\') ? '\\' : '/';
      const join = (n: string): string => (base ? `${base}${sep}${n}` : n);
      if (!unique || !base) return join(name);
      const exists = listing?.files.some((f) => f.name === name);
      if (!exists) return join(name);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 1;
      let cand = join(`${stem}_${i}${ext}`);
      while (listing?.files.some((f) => f.name === `${stem}_${i}${ext}`)) {
        i++;
        cand = join(`${stem}_${i}${ext}`);
      }
      return cand;
    },
    [listing, unique]
  );

  /** 确定：按模式产出结果路径 */
  const handleConfirm = useCallback(() => {
    if (kind === 'save') {
      const name = fileName.trim();
      if (!name) return; // 文件名为空 → 不允许确定（禁用按钮已处理，这里兜底）
      onConfirm([resolveSavePath(name)]);
      return;
    }
    if (kind === 'directory') {
      // 目录模式：确定 = 进入当前高亮的子目录，或确认当前目录本身
      const d = options.dirs[activeIdx];
      if (d !== undefined && activeIdx < options.dirs.length) {
        const sep = listing?.cwd.includes('\\') ? '\\' : '/';
        loadDir(`${listing?.cwd || ''}${sep}${d}`);
        return;
      }
      if (listing?.cwd) onConfirm([listing.cwd]);
      return;
    }
    // open 模式
    if (multiple) {
      if (picked.length) onConfirm(picked);
      return;
    }
    // 单选：优先用已勾选，否则用当前高亮的文件
    if (picked.length === 1) {
      onConfirm(picked);
      return;
    }
    const f = options.files[activeIdx - options.dirs.length];
    if (f && listing) {
      const sep = listing.cwd.includes('\\') ? '\\' : '/';
      onConfirm([`${listing.cwd}${sep}${f.name}`]);
    }
  }, [kind, fileName, resolveSavePath, options, activeIdx, listing, multiple, picked, onConfirm, loadDir]);

  const confirmDisabled = useMemo(() => {
    if (kind === 'save') return !fileName.trim();
    if (kind === 'directory') return !listing?.cwd;
    // open 单选：必须勾选或高亮一个文件
    if (multiple) return picked.length === 0;
    if (picked.length === 1) return false;
    return options.files.length === 0;
  }, [kind, fileName, listing, multiple, picked, options.files.length]);

  /** 返回上级 */
  const goUp = useCallback(() => {
    if (listing?.parent) loadDir(listing.parent);
  }, [listing, loadDir]);

  /** 展开/收起「新建文件夹」内联输入 */
  const toggleMkdir = useCallback(() => {
    setMkdirErr('');
    setMkdirName((prev) => (prev === null ? '' : null));
  }, []);

  // 展开时自动聚焦输入框
  useEffect(() => {
    if (mkdirName === null) return;
    const id = window.requestAnimationFrame(() => mkdirInputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [mkdirName !== null]);

  /**
   * 提交新建文件夹。
   *
   * 主进程 `fs:makeDir` 负责全部校验（父目录合法性 / 名称单段白名单 / 只建一层 / 绝不覆盖），
   * 这里只负责：调接口 → 成功则进入新目录并收起输入 → 失败则把错误码映射成 i18n 提示。
   */
  const submitMkdir = useCallback(async () => {
    const name = (mkdirName || '').trim();
    if (!name || mkdirBusy) return;
    if (!listing?.cwd) {
      setMkdirErr(t('filepicker.mkdirNotDir'));
      return;
    }
    setMkdirBusy(true);
    try {
      const res = await api.makeDir!({ parentDir: listing.cwd, name });
      if (res?.ok && res.path) {
        setMkdirName(null);
        setMkdirErr('');
        // 建完直接进入新目录：这是用户下一步最可能想做的事（在里面选/再套一层）
        await loadDir(res.path);
      } else {
        setMkdirErr(makeDirErrorKey(res?.error));
      }
    } catch (e) {
      console.error('[FilePicker] 新建文件夹失败', e);
      setMkdirErr(t('filepicker.mkdirFailed'));
    } finally {
      setMkdirBusy(false);
    }
  }, [mkdirName, mkdirBusy, listing, t, loadDir]);

  /** 键盘操作：Esc 取消 / Enter 确定 / ↑↓ 移动高亮 / Tab 焦点锁 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter') {
        // save 模式下输入框里的 Enter 也走确定
        e.preventDefault();
        e.stopPropagation();
        if (!confirmDisabled) handleConfirm();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (options.total === 0) return;
        e.preventDefault();
        setActiveIdx((prev) => {
          const next = e.key === 'ArrowDown' ? prev + 1 : prev - 1;
          if (next < 0) return options.total - 1;
          if (next >= options.total) return 0;
          return next;
        });
        return;
      }
      if (e.key !== 'Tab') return;
      // 焦点锁：只在「取消」「确定」两个按钮之间循环。
      // 刻意**不把列表/输入框纳入 Tab 环**——列表与输入框用方向键与直接点击操作，
      // 这样既满足 WCAG 的「焦点不被困住又不出弹窗」，也让键盘路径最短。
      e.preventDefault();
      const a = cancelRef.current;
      const b = okRef.current;
      if (a && b) (document.activeElement === a ? b : a).focus();
    },
    [onCancel, handleConfirm, confirmDisabled, options.total]
  );

  // 高亮项变化时把它滚进可视区
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, listing]);

  if (!shown) return null;

  const titleText = title || t('filepicker.title');
  const errText =
    listing?.error === 'TRAVERSAL_DENIED'
      ? t('filepicker.errTraversal')
      : listing?.error
        ? t('filepicker.errRead')
        : '';

  return createPortal(
    <div
      className={`modal-mask filepicker-mask${leaving ? ' leaving' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !leaving) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="modal file-picker"
        role="dialog"
        aria-modal="true"
        aria-label={titleText}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-head">
          <span>{titleText}</span>
          <button
            type="button"
            className="modal-close"
            aria-label={t('common.close')}
            onClick={onCancel}
            disabled={leaving}
          >
            ×
          </button>
        </div>

        <div className="modal-body filepicker-body">
          {/* 左：位置栏 */}
          <nav className="filepicker-places" aria-label={t('filepicker.places')}>
            {(listing?.places || []).map((pl: DirPlace) => (
              <button
                key={pl.key}
                type="button"
                className={`filepicker-place${listing?.cwd === pl.path ? ' is-active' : ''}`}
                onClick={() => loadDir(pl.path)}
                disabled={leaving}
                title={pl.path}
              >
                {t(`filepicker.place.${pl.key}`)}
              </button>
            ))}
          </nav>

          {/* 右：路径条 + 列表 */}
          <div className="filepicker-main">
            <div className="filepicker-pathbar">
              <button
                type="button"
                className="btn-ghost filepicker-up"
                onClick={goUp}
                disabled={!listing?.parent || leaving}
              >
                ↑ {t('filepicker.parent')}
              </button>
              {/* v2.3.97：新建文件夹（补回旧 showOpenDialog 的 createDirectory 能力）。
                  只在「选目录」模式出现 —— 选文件/另存为时建文件夹没有意义。 */}
              {kind === 'directory' && (
                <button
                  type="button"
                  className="btn-ghost filepicker-newdir"
                  onClick={toggleMkdir}
                  disabled={leaving}
                  aria-expanded={mkdirName !== null}
                >
                  ＋ {t('filepicker.newFolder')}
                </button>
              )}
              <span className="filepicker-cwd" title={listing?.cwd || ''}>
                {listing?.cwd || t('filepicker.loading')}
              </span>
            </div>

            {/* 新建文件夹的内联输入 + 错误提示 */}
            {kind === 'directory' && mkdirName !== null && (
              <div className="filepicker-mkdir">
                <input
                  ref={mkdirInputRef}
                  type="text"
                  value={mkdirName}
                  placeholder={t('filepicker.newFolderName')}
                  aria-label={t('filepicker.newFolderName')}
                  disabled={mkdirBusy || leaving}
                  onChange={(e) => {
                    setMkdirName(e.target.value);
                    if (mkdirErr) setMkdirErr('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      void submitMkdir();
                    } else if (e.key === 'Escape') {
                      // Esc 先收起内联输入，而不是直接关掉整个选择器
                      e.preventDefault();
                      e.stopPropagation();
                      setMkdirName(null);
                      setMkdirErr('');
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void submitMkdir()}
                  disabled={mkdirBusy || leaving || !mkdirName.trim()}
                >
                  {t('filepicker.create')}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setMkdirName(null);
                    setMkdirErr('');
                  }}
                  disabled={mkdirBusy || leaving}
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}
            {/* 错误提示紧跟在内联输入下方（aria-live 让读屏用户也能听到）*/}
            {kind === 'directory' && mkdirErr && (
              <div className="filepicker-err" role="alert" aria-live="polite">
                {t(mkdirErr)}
              </div>
            )}

            {errText && <div className="filepicker-err">{errText}</div>}

            <div
              ref={listRef}
              className="filepicker-list"
              role="listbox"
              aria-multiselectable={multiple}
              aria-label={t('filepicker.list')}
            >
              {loading && <div className="filepicker-hint">{t('filepicker.loading')}</div>}
              {!loading && options.total === 0 && (
                <div className="filepicker-hint">{t('filepicker.empty')}</div>
              )}
              {/* `.` 分组：目录 */}
              {!loading && options.dirs.length > 0 && (
                <div className="filepicker-group" role="group" aria-label={t('filepicker.groupDirs')}>
                  {options.dirs.map((d, i) => (
                    <button
                      key={`d_${d}`}
                      type="button"
                      role="option"
                      aria-selected={activeIdx === i}
                      data-active={activeIdx === i}
                      className={`filepicker-row is-dir${activeIdx === i ? ' is-active' : ''}`}
                      onClick={() => {
                        setActiveIdx(i);
                        const sep = listing?.cwd.includes('\\') ? '\\' : '/';
                        loadDir(`${listing?.cwd || ''}${sep}${d}`);
                      }}
                      onDoubleClick={() => {
                        const sep = listing?.cwd.includes('\\') ? '\\' : '/';
                        loadDir(`${listing?.cwd || ''}${sep}${d}`);
                      }}
                      disabled={leaving}
                    >
                      <span className="filepicker-name">
                        <span aria-hidden="true">📁</span> {d}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {/* `.` 分组：文件（目录模式不显示） */}
              {!loading && kind !== 'directory' && options.files.length > 0 && (
                <div className="filepicker-group" role="group" aria-label={t('filepicker.groupFiles')}>
                  {options.files.map((f, i) => {
                    const idx = options.dirs.length + i;
                    const abs = `${listing?.cwd || ''}${listing?.cwd.includes('\\') ? '\\' : '/'}${f.name}`;
                    const isPicked = picked.includes(abs);
                    return (
                      <button
                        key={`f_${f.name}`}
                        type="button"
                        role="option"
                        aria-selected={isPicked || activeIdx === idx}
                        data-active={activeIdx === idx}
                        className={`filepicker-row${activeIdx === idx ? ' is-active' : ''}${isPicked ? ' is-picked' : ''}`}
                        onClick={() => {
                          setActiveIdx(idx);
                          togglePick(abs);
                        }}
                        onDoubleClick={() => {
                          if (kind === 'open') {
                            const sep = listing?.cwd.includes('\\') ? '\\' : '/';
                            onConfirm([`${listing?.cwd || ''}${sep}${f.name}`]);
                          }
                        }}
                        disabled={leaving}
                      >
                        {multiple && (
                          <span className="filepicker-check" aria-hidden="true">
                            {isPicked ? '☑' : '☐'}
                          </span>
                        )}
                        <span className="filepicker-name">{f.name}</span>
                        <span className="filepicker-size">{formatSize(f.size)}</span>
                        <span className="filepicker-time">
                          {f.mtime ? new Date(f.mtime).toLocaleDateString(lang) : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 底部：文件名输入（save）+ 取消/确定 */}
        <div className="modal-foot filepicker-foot">
          {kind === 'save' && (
            <label className="filepicker-namefield">
              <span className="filepicker-namelabel">{t('filepicker.fileName')}</span>
              <input
                ref={inputRef}
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !confirmDisabled) handleConfirm();
                }}
                disabled={leaving}
                aria-label={t('filepicker.fileName')}
              />
            </label>
          )}
          {multiple && (
            <span className="filepicker-count">
              {t('filepicker.selected', { n: picked.length })}
            </span>
          )}
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={leaving}
          >
            {t('common.cancel')}
          </button>
          <button
            ref={okRef}
            type="button"
            className="btn-primary"
            onClick={handleConfirm}
            disabled={confirmDisabled || leaving}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default FilePickerModal;