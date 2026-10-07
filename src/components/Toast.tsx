import { useRef, useState } from 'react';
import { animMs } from '../utils/animControl';

export type ToastState = { msg: string; leaving: boolean; error?: boolean; animation?: 'linear' | 'ease' } | null;

// 通用轻提示：自动浮现 → 停留 → 自动缩回，无需手动关闭。
// 用法：const { toast, showToast } = useToast(); 然后在 JSX 末尾放 <ToastView toast={toast} />
// showToast(msg) 普通提示；showToast(msg, { error: true }) 红色错误提示；
// showToast(msg, { duration: 3000 }) 自定义停留时长。
//
// v2.3.97：默认动画档由 'ease' 改为 'linear'（用户要求全项目线性动画）。
// CSS 侧 .mini-toast 的默认规则本身也已改为 linear 变体，两处互为兜底 ——
// 即使有调用方显式传 animation:'ease'，也只是拿到同一个 linear 表现（不会退回 scale）。
//
// v2.3.97 界面动效速度：退场等待时长必须与 CSS 的 toastOutLinear 同步缩放。
// 该 CSS 已改成 calc(0.3s * var(--anim-speed, 1))，故这里用 animMs(0.3) 在**调用时**现算。
// 若不缩放：快档下动画 0.15s 播完还在等 300ms（拖沓）；慢档下动画要 0.6s 但 300ms 就卸载
// （提示条凭空消失）。这与 NodeBanner 是同一类故障，故一并修掉。
export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const t1 = useRef<number | null>(null);
  const t2 = useRef<number | null>(null);
  const showToast = (
    msg: string,
    opts: { error?: boolean; duration?: number; animation?: 'linear' | 'ease' } = {}
  ) => {
    const { error = false, duration = 1500, animation = 'linear' } = opts;
    if (t1.current) window.clearTimeout(t1.current);
    if (t2.current) window.clearTimeout(t2.current);
    setToast({ msg, leaving: false, error, animation });
    t1.current = window.setTimeout(() => {
      setToast((prev) => (prev ? { ...prev, leaving: true } : prev));
      // = index.css 的 toastOutLinear（基准 0.3s；原 ease 档为 0.42s，同样已缩放）
      t2.current = window.setTimeout(() => setToast(null), animation === 'linear' ? animMs(0.3) : animMs(0.42));
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
