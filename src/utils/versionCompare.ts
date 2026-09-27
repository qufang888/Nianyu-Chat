// 版本比较（渲染层用，v2.3.48）：与 electron/updater.ts 的 compareVersions 语义一致——
// 忽略 v 前缀与后缀标记（如 -beta.1 / +build），按数字段逐段比较。
// 渲染层不 import 主进程 electron 模块，故保留一份纯函数副本（各端一份，不跨端引用）。
export function compareVersions(a: string, b: string): number {
  const seg = (v: string) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((x) => parseInt(x, 10) || 0);
  const x = seg(a);
  const y = seg(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
