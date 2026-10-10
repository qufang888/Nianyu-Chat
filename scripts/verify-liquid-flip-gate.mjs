/**
 * v2.3.105 回归守卫：液态玻璃「白块」缺陷（用户实测反馈「液态玻璃主题非常恶心」）
 * ============================================================================
 *
 * 【缺陷现象】
 * 深色液态玻璃主题下，设置页出现 15 块近乎纯白的大色块（主题预览卡网格被整体翻白）。
 *
 * 【已定位根因】（经截图像素复核，非推测）
 *   1. 白色块颜色实测 rgb(226, 233, 243)；
 *   2. 而 liquid 的 `--auto-contrast-flip-bg: rgba(240, 246, 255, 0.94)`
 *      压在 `--auto-contrast-base: rgba(14, 30, 62, 1)` 上合成后
 *      = rgb(226, 233, 243) —— **与实测逐通道完全一致**，锁定为 data-auto-contrast='flip'；
 *   3. 色块排布（2 列 × 5 行、宽 404px、行高 56px、间距 12px）与
 *      `.theme-options { grid-template-columns: repeat(2,1fr); gap:12px }` + `.theme-card` 完全吻合；
 *   4. 块内文字实测 rgb(8, 16, 37) ≈ `--auto-contrast-flip-text: #0b1220`，与 flip 规则的
 *      `color: var(--auto-contrast-flip-text)` 吻合。
 *   ⇒ autoContrast 看门狗把**文档流内的静态内容面**（.theme-card / .sidebar 等）也判成 flip，
 *     而 flip 的设计初衷只针对「浮在动态渐变之上的玻璃浮层」。
 *
 * 【修复】src/utils/autoContrast.ts 新增 allowsFlip()：
 *   自元素沿祖先链向上查是否处于 position:absolute/fixed 的浮层上下文中；
 *   不是则判级封顶为 'boost'（叠加深色 scrim，视觉仍是深色），绝不 flip 成浅底。
 *
 * 【本脚本断言的护栏】
 *   A. allowsFlip 存在，且沿**祖先链**查找（不是只看自身）；
 *   B. judge() 接收 allowFlip 参数且 flip 分支受它约束（封顶 boost）；
 *   C. applyVerdicts 调用 allowsFlip 并把结果并入判级签名（换主题/重排不残留旧判级）；
 *   D. CSS 侧 flip 规则未被删掉（浮层在深色背景上仍需翻转保底可读性）；
 *   E. liquid 的 .theme-card 有独立的深色卡片底（不再依赖继承的透明底）；
 *   F. flip 相关令牌仍为浅底 + 深字（保证浮层翻转后文字可读）。
 *
 * 运行：node scripts/verify-liquid-flip-gate.mjs
 */

import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const ac = read('src/utils/autoContrast.ts');
const css = read('src/styles/index.css');
const vars = read('src/theme/variables.css');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` —— ${extra}` : ''}`);
  }
};

console.log('=== A. allowsFlip 存在且沿祖先链查找 ===');
ok(/function allowsFlip\s*\(/.test(ac), 'A1 autoContrast.ts 定义了 allowsFlip()');
ok(
  /allowsFlip[\s\S]{0,600}parentElement/.test(ac),
  'A2 allowsFlip 沿 parentElement 向上遍历祖先链（非仅看自身）'
);
ok(
  /position:\s*absolute|===\s*'absolute'/.test(ac) && /===\s*'fixed'/.test(ac),
  "A3 allowsFlip 同时认position:absolute 与 fixed"
);

console.log('\n=== B. judge() 的 flip 受 allowFlip 约束 ===');
ok(
  /function judge\s*\([^)]*allowFlip[^)]*\)/.test(ac),
  'B1 judge() 签名带 allowFlip 参数'
);
ok(
  /return allowFlip \? 'flip' : 'boost';/.test(ac),
  "B2 flip 分支为 condition 门控（allowFlip 为假时降级 boost）",
  "期望字面量 return allowFlip ? 'flip' : 'boost';"
);
ok(
  !/\n\s*return 'flip';/.test(ac),
  'B3 不存在无条件的裸 return \'flip\'（否则闸门可被绕过）'
);

console.log('\n=== C. applyVerdicts 传入并签名 ===');
ok(
  /applyVerdicts[\s\S]*allowsFlip\(el\)/.test(ac),
  'C1 applyVerdicts 调用 allowsFlip(el)'
);
ok(
  /const allowFlip = allowsFlip\(el\)/.test(ac),
  'C2 判级前先算出 allowFlip'
);
ok(
  /judge\(el,\s*bg,\s*allowFlip\)/.test(ac),
  'C3 judge(el, bg, allowFlip) 三参调用'
);
ok(
  /allowFlip \? 'f' : 's'/.test(ac),
  'C4 判级签名含 allowFlip（布局变化后不会残留旧 flip 属性）'
);

console.log('\n=== D. CSS 侧 flip 规则保留（浮层仍需翻转保底）===');
ok(
  /\[data-theme='liquid'\] \[data-auto-contrast='flip'\]/.test(css),
  "D1 liquid flip 规则仍存在"
);
ok(
  /\[data-theme='glass'\] \[data-auto-contrast='flip'\]/.test(css),
  'D2 glass flip 规则仍存在'
);
ok(
  /\[data-auto-contrast='flip'\][\s\S]{0,200}color:\s*var\(--color-primary-flip-text\)|\[data-auto-contrast='flip'\][\s\S]{0,200}color:\s*var\(--auto-contrast-flip-text\)/.test(css),
  'D3 flip 规则把文字改写为 flip-text（浅底深字，保证浮层可读）'
);

console.log('\n=== E. liquid 主题卡有独立深色卡片底 ===');
const cardBlock = css.match(/\[data-theme='liquid'\] \.theme-card\s*\{([\s\S]*?)\}/);
ok(!!cardBlock, 'E1 存在 [data-theme=\'liquid\'] .theme-card 规则');
ok(
  !!cardBlock && /background:\s*var\(--liquid-content-bg\)/.test(cardBlock[1]),
  'E2 liquid .theme-card 显式给了 background（不再透明悬空）'
);

console.log('\n=== F. flip 令牌仍为浅底 + 深字 ===');
ok(
  /--auto-contrast-flip-bg:\s*rgba\(/.test(vars),
  'F1 --auto-contrast-flip-bg 为半透明浅色（供浮层翻转）'
);
ok(
  /--auto-contrast-flip-text:\s*#/.test(vars),
  'F2 --auto-contrast-flip-text 为深色'
);
// 自洽性：flip 底合成后必须够亮（否则翻转反而更看不清）
const bgM = vars.match(/--auto-contrast-flip-bg:\s*rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
if (bgM) {
  const [, r, g, b, a] = bgM.map(Number);
  const over = (fg, bgA, bg) => fg.map((v, i) => (v * fg[3] + bg[i] * bgA * (1 - fg[3])) / (fg[3] + bgA * (1 - fg[3])));
  void over;
  const baseM = vars.match(/--auto-contrast-base:\s*rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
  if (baseM) {
    const base = [Number(baseM[1]), Number(baseM[2]), Number(baseM[3])];
    const alpha = a;
    const comp = [r, g, b].map((v, i) => v * alpha + base[i] * (1 - alpha));
    const lum = (c) => {
      const f = (u) => {
        const x = u / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const lin = (u) => {
      const x = u / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    const txtM = vars.match(/--auto-contrast-flip-text:\s*#([0-9a-f]{6})/i);
    const txt = txtM
      ? [parseInt(txtM[1].slice(0, 2), 16), parseInt(txtM[1].slice(2, 4), 16), parseInt(txtM[1].slice(4, 6), 16)]
      : [11, 18, 32];
    const lf = 0.2126 * lin(txt[0]) + 0.7152 * lin(txt[1]) + 0.0722 * lin(txt[2]);
    const lb = lum(comp);
    const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
    ok(ratio >= 4.5, `F3 flip 后文字对比度 ≥ 4.5（实测 ${ratio.toFixed(2)}:1）`);
    ok(
      comp.every((v) => Math.round(v) >= 200),
      `F4 flip 合成底确为浅色 rgb(${comp.map((v) => Math.round(v)).join(',')})（与缺陷截图实测 rgb(226,233,243) 吻合，反证定位正确）`
    );
  }
}

console.log('\n====================================================');
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('❌ 液态玻璃 flip 闸门回归');
  process.exit(1);
}
console.log('✅ 液态玻璃 flip 闸门通过（静态内容面不再被翻白）');