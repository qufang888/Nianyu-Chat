import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';

interface VideoTask {
  id: string; // chatType|chatId|prompt
  chatType: string;
  chatId: string;
  prompt: string;
  percent: number;
  status?: string;
  done: boolean;
  ok?: boolean;
  imagePath?: string;
  error?: string;
}

// 生视频悬浮气泡：全局唯一实例，主窗/小窗都挂载。
// 订阅 video:progress / video:done；可拖动；任务完成后 8 秒自动消失，也可点 ✕ 关闭。
const VideoBubble: React.FC = () => {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<VideoTask[]>([]);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(12, window.innerWidth - 320),
    y: 84,
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const timersRef = useRef<Map<string, number>>(new Map());

  // 完成/失败的任务 8 秒后自动移除
  const scheduleRemove = useCallback((id: string, delay = 8000) => {
    const old = timersRef.current.get(id);
    if (old) window.clearTimeout(old);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(id);
      setTasks((prev) => prev.filter((x) => x.id !== id));
    }, delay);
    timersRef.current.set(id, timer);
  }, []);

  const removeNow = useCallback((id: string) => {
    const old = timersRef.current.get(id);
    if (old) window.clearTimeout(old);
    timersRef.current.delete(id);
    setTasks((prev) => prev.filter((x) => x.id !== id));
  }, []);

  useEffect(() => {
    const offProgress = api.onVideoProgress((_e, data) => {
      const id = `${data.chatType}|${data.chatId}|${data.prompt}`;
      setTasks((prev) => {
        const idx = prev.findIndex((x) => x.id === id);
        if (idx === -1) {
          return [...prev, { id, chatType: data.chatType, chatId: data.chatId, prompt: data.prompt, percent: data.percent, status: data.status, done: false }];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], percent: data.percent, status: data.status };
        return next;
      });
    });
    const offDone = api.onVideoDone((_e, data) => {
      const id = `${data.chatType}|${data.chatId}|${data.prompt}`;
      setTasks((prev) => {
        const idx = prev.findIndex((x) => x.id === id);
        if (idx === -1) {
          const task: VideoTask = { id, chatType: data.chatType, chatId: data.chatId, prompt: data.prompt, percent: data.ok ? 100 : 0, done: true, ok: data.ok, imagePath: data.imagePath, error: data.error };
          scheduleRemove(id);
          return [...prev, task];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], done: true, ok: data.ok, imagePath: data.imagePath, error: data.error, percent: data.ok ? 100 : next[idx].percent };
        scheduleRemove(id);
        return next;
      });
    });
    return () => {
      offProgress();
      offDone();
      timersRef.current.forEach((tm) => window.clearTimeout(tm));
      timersRef.current.clear();
    };
  }, [scheduleRemove]);

  // 拖动（鼠标 + 触屏）
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, taskId: string) => {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    // 拖动时暂停该任务的自动移除计时
    const tm = timersRef.current.get(taskId);
    if (tm) window.clearTimeout(tm);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const nx = Math.min(Math.max(4, e.clientX - dragRef.current.dx), window.innerWidth - 316);
    const ny = Math.min(Math.max(4, e.clientY - dragRef.current.dy), window.innerHeight - 120);
    setPos({ x: nx, y: ny });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>, taskId: string) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    const tm = timersRef.current.get(taskId);
    if (tm) window.clearTimeout(tm);
  };

  if (tasks.length === 0) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 300,
        width: 300,
        userSelect: 'none',
        touchAction: 'none',
        pointerEvents: 'auto',
      }}
    >
      {tasks.map((task) => (
        <div
          key={task.id}
          onPointerDown={(e) => onPointerDown(e, task.id)}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerUp(e, task.id)}
          style={{
            background: 'var(--color-bg-card, #2b2b33)',
            color: 'var(--color-text, #eee)',
            border: '1px solid var(--color-border, #444)',
            borderRadius: 12,
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            padding: '10px 12px',
            cursor: 'grab',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>{task.done ? (task.ok ? '✅' : '❌') : '🎬'}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={task.prompt}>
              {task.prompt}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); removeNow(task.id); }}
              style={{ cursor: 'pointer', color: 'var(--color-text-secondary, #999)', padding: '0 2px' }}
              title={t('video.close')}
            >
              ✕
            </span>
          </div>
          {!task.done && (
            <>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--color-border, #444)', marginTop: 8, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(2, Math.min(100, task.percent))}%`,
                    background: 'linear-gradient(90deg,#7c6cf0,#4fc3f7)',
                    transition: 'width .3s ease',
                    borderRadius: 3,
                  }}
                />
              </div>
              <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', color: 'var(--color-text-secondary, #999)' }}>
                <span>{t('video.generating')}</span>
                <span>{Math.max(0, Math.min(100, Math.round(task.percent)))}%</span>
              </div>
            </>
          )}
          {task.done && (
            <div style={{ marginTop: 6, color: task.ok ? '#4caf50' : '#e57373' }}>
              {task.ok ? t('video.done') : task.error || t('video.failed')}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body
  );
};

export default VideoBubble;
