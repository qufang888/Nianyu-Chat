import { useRef, useState } from 'react';

export type ToastState = { msg: string; leaving: boolean; error?: boolean } | null;

// 通用轻提示：自动浮现 → 停留 → 自动缩回，无需手动关闭。
// 用法：const { toast, showToast } = useToast(); 然后在 JSX 末尾放 <ToastView toast={toast} />
// showToast(msg) 普通提示；showToast(msg, true) 红色错误提示。
export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const t1 = useRef<number | null>(null);
  const t2 = useRef<number | null>(null);
  const showToast = (msg: string, error = false) => {
    if (t1.current) window.clearTimeout(t1.current);
    if (t2.current) window.clearTimeout(t2.current);
    setToast({ msg, leaving: false, error });
    t1.current = window.setTimeout(() => {
      setToast((prev) => (prev ? { ...prev, leaving: true } : prev));
      t2.current = window.setTimeout(() => setToast(null), 420);
    }, 1500);
  };
  return { toast, showToast };
}

export function ToastView({ toast }: { toast: ToastState }) {
  if (!toast) return null;
  return (
    <div className={`mini-toast ${toast.leaving ? 'leaving' : ''} ${toast.error ? 'error' : ''}`}>
      {toast.msg}
    </div>
  );
}
