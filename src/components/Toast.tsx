import { useRef, useState } from 'react';

export type ToastState = { msg: string; leaving: boolean; error?: boolean; animation?: 'linear' | 'ease' } | null;

// 通用轻提示：自动浮现 → 停留 → 自动缩回，无需手动关闭。
// 用法：const { toast, showToast } = useToast(); 然后在 JSX 末尾放 <ToastView toast={toast} />
// showToast(msg) 普通提示；showToast(msg, { error: true }) 红色错误提示；
// showToast(msg, { duration: 3000, animation: 'linear' }) 自定义停留时长与动画曲线。
export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const t1 = useRef<number | null>(null);
  const t2 = useRef<number | null>(null);
  const showToast = (
    msg: string,
    opts: { error?: boolean; duration?: number; animation?: 'linear' | 'ease' } = {}
  ) => {
    const { error = false, duration = 1500, animation = 'ease' } = opts;
    if (t1.current) window.clearTimeout(t1.current);
    if (t2.current) window.clearTimeout(t2.current);
    setToast({ msg, leaving: false, error, animation });
    t1.current = window.setTimeout(() => {
      setToast((prev) => (prev ? { ...prev, leaving: true } : prev));
      t2.current = window.setTimeout(() => setToast(null), animation === 'linear' ? 300 : 420);
    }, duration);
  };
  return { toast, showToast };
}

export function ToastView({ toast }: { toast: ToastState }) {
  if (!toast) return null;
  return (
    <div
      className={`mini-toast ${toast.leaving ? 'leaving' : ''} ${toast.error ? 'error' : ''} ${
        toast.animation === 'linear' ? 'linear' : ''
      }`}
    >
      {toast.msg}
    </div>
  );
}
