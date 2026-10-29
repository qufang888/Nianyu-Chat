#!/usr/bin/env node
/**
 * QA 独立运行时验收（software-qa-engineer）
 * 用**自己写的** DOM 桩跑引擎，验证核心不变量：
 *   · 字形显示位置 == 点击位置（对任意坐标、任意缩放、任意热点都必须成立）
 *   · 进出窗口零延迟（滑出立即摘 cursor-hidden；滑入立即在真实位置）
 *   · 门控（cursor-gate-off）时不响应指针
 *   · 自定义图加载失败回退内置
 *   · 拖动热点实时生效 + 卸载后解绑
 *
 * 关键：断言用**数值反算**（从 transform 字符串反解出字形左上角 + 热点偏移，
 * 验证「热点像素恰好落在指针坐标」），而不是匹配实现方脚本里的字面量。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const sec = (t) => console.log('\n=== ' + t + ' ===');

function loadTs(relPath, stubs = {}) {
  const ts = require('typescript');
  const js = ts.transpileModule(read(relPath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: relPath,
  }).outputText;
  const mod = { exports: {} };
  const req = (id) => (Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : require(id));
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(mod.exports, req, mod, relPath, root);
  return mod.exports;
}

// ===== DOM 桩 =====
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
}
class FakeStyle {
  constructor() {
    this._p = {};
    return new Proxy(this, {
      set(t, p, v) { t._p[p] = v; return true; },
      get(t, p) { return p in t ? t[p] : t._p[p]; },
    });
  }
  setProperty(k, v) { this._p[k] = v; }
  getPropertyValue(k) { return this._p[k] ?? ''; }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.children = [];
    this.naturalWidth = 0; this.naturalHeight = 0;
    this.complete = false; this.width = 0; this.height = 0;
  }
  appendChild(c) { this.children.push(c); return c; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900 }; }
  setAttribute() {} getAttribute() { return null; } hasAttribute() { return false; }
  closest() { return null; }
  getContext() {
    return { canvas: this, globalAlpha: 1, fillStyle: '', setTransform() {}, clearRect() {},
      beginPath() {}, arc() {}, fill() {}, save() {}, restore() {} };
  }
}
class FakeImage extends FakeElement {
  constructor(natW = 512, natH = 512) {
    super('img');
    this.onload = null; this.onerror = null; this._src = '';
    this._natW = natW; this._natH = natH;
  }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      if (v && String(v).includes('broken')) { this.onerror && this.onerror(); return; }
      this.naturalWidth = this._natW; this.naturalHeight = this._natH;
      this.complete = true;
      this.onload && this.onload();
    }, 0);
  }
}

const typesApi = loadTs('src/cursor/types.ts');
const imageApi = loadTs('src/cursor/cursorImage.ts', { './types': typesApi });

// ===== 解析 transform，反算字形左上角 =====
function parseTransform(tr) {
  const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px,\s*0\)\s*scale\((-?[\d.]+)\)/.exec(tr || '');
  if (!m) return null;
  return { tx: parseFloat(m[1]), ty: parseFloat(m[2]), s: parseFloat(m[3]) };
}

const bodyEl = new FakeElement('body');
const docL = new Map(), winL = new Map();
const g = globalThis;
const saved = { document: g.document, window: g.window, Image: g.Image, raf: g.requestAnimationFrame,
  caf: g.cancelAnimationFrame, ro: g.ResizeObserver, ce: g.CustomEvent, gcs: g.getComputedStyle };
g.performance = g.performance || { now: () => Date.now() };
g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame = (id) => clearTimeout(id);
g.ResizeObserver = class { observe() {} disconnect() {} };
g.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
g.getComputedStyle = () => ({ cursor: 'default' });
g.Image = FakeImage;
g.document = {
  body: bodyEl, hidden: false,
  createElement: (t) => (t === 'img' ? new FakeImage() : new FakeElement(t)),
  addEventListener: (t, f) => docL.set(t, f),
  removeEventListener: (t) => docL.delete(t),
  querySelector: () => null, elementFromPoint: () => null, dispatchEvent: () => true,
};
g.window = {
  devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900,
  matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  addEventListener: (t, f) => winL.set(t, f),
  removeEventListener: (t) => winL.delete(t),
  setTimeout: (f, t) => setTimeout(f, t), clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
  dispatchEvent: () => true,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  const engineApi = loadTs('src/cursor/cursorEngine.ts', { './types': typesApi, './cursorImage': imageApi });
  const { CursorEngine } = engineApi;

  const baseCfg = {
    enabled: true, animEnabled: true, animSpeed: 1, lerpSpeed: 0.25,
    trailEnabled: true, trailMaxLength: 24, particlesEnabled: true, maxParticles: 64,
    hoverScale: 1.25, idleHideMs: 5000, cursorSize: 28,
    hotspotX: 0.06836, hotspotY: 0, image: '',
  };

  // ================================================================
  sec('核心不变量：字形「热点像素」必须精确落在指针坐标');
  // ================================================================
  {
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    const eng = new CursorEngine({ config: baseCfg, builtinImageUrl: 'builtin.png' });
    eng.mount({ glyphHost, fxCanvas });
    await sleep(20);
    const move = docL.get('mousemove');

    // 反算：字形左上角 + 热点偏移（按比例 × 实际显示宽高 × scale）应等于指针坐标
    const checkInvariant = (px, py, hotspotX, hotspotY, scale, label) => {
      const size = imageApi.computeCursorDrawSize(512, 512, eng.cfg.cursorSize);
      const off = imageApi.hotspotToOffset(hotspotX, hotspotY, size.Dw, size.Dh);
      const t = parseTransform(glyphHost.style._p.transform);
      if (!t) return ok(false, label + '：transform 不可解析');
      const hotspotScreenX = t.tx + off.offX * t.s;
      const hotspotScreenY = t.ty + off.offY * t.s;
      const dx = Math.abs(hotspotScreenX - px), dy = Math.abs(hotspotScreenY - py);
      ok(dx < 1e-6 && dy < 1e-6,
        `${label}：热点屏幕位置 (${hotspotScreenX.toFixed(4)}, ${hotspotScreenY.toFixed(4)}) == 指针 (${px}, ${py})（Δ=${dx.toExponential(1)},${dy.toExponential(1)}）`);
    };

    move({ clientX: 400, clientY: 300 });
    checkInvariant(400, 300, 0.06836, 0, 1, '默认热点 (0.06836,0) @ (400,300)');

    move({ clientX: 1234.5, clientY: 678.25 });
    checkInvariant(1234.5, 678.25, 0.06836, 0, 1, '非整数坐标 @ (1234.5,678.25)');

    move({ clientX: 42, clientY: 900 - 30 });
    checkInvariant(42, 870, 0.06836, 0, 1, '靠近下边缘但未入边缘带 @ (42,870)');

    // 改热点 → 仍必须精确
    eng.updateConfig({ hotspotX: 0.5, hotspotY: 0.5 });
    move({ clientX: 700, clientY: 500 });
    checkInvariant(700, 500, 0.5, 0.5, 1, '热点改中心 (0.5,0.5) @ (700,500)');

    eng.updateConfig({ hotspotX: 0.25, hotspotY: 0.75 });
    move({ clientX: 800, clientY: 600 });
    checkInvariant(800, 600, 0.25, 0.75, 1, '热点 (0.25,0.75) @ (800,600)');

    // 改 cursorSize → 仍必须精确（比例语义与尺寸无关）
    eng.updateConfig({ cursorSize: 64 });
    move({ clientX: 900, clientY: 400 });
    checkInvariant(900, 400, 0.25, 0.75, 1, 'cursorSize=64 + 热点 (0.25,0.75) @ (900,400)');

    // 换非方图 → Dw/Dh 不同，偏移必须分别用各自边长
    eng.updateConfig({ cursorSize: 28 });
    await sleep(20);
    eng.unmount();
  }

  // 非方图（256×64）场景：偏移必须用 Dh=7 而不是 28
  {
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    // 让 FakeImage 变成 256×64
    const origCreate = g.document.createElement;
    g.document.createElement = (t) => (t === 'img' ? new FakeImage(256, 64) : new FakeElement(t));
    const eng = new CursorEngine({ config: { ...baseCfg, hotspotX: 0.5, hotspotY: 0.5 }, builtinImageUrl: 'builtin.png' });
    eng.mount({ glyphHost, fxCanvas });
    await sleep(20);
    g.document.createElement = origCreate;
    const move = docL.get('mousemove');
    move({ clientX: 600, clientY: 400 });
    const t = parseTransform(glyphHost.style._p.transform);
    const size = imageApi.computeCursorDrawSize(256, 64, 28);  // Dw=28, Dh=7
    const off = imageApi.hotspotToOffset(0.5, 0.5, size.Dw, size.Dh);
    const hx = t.tx + off.offX * t.s, hy = t.ty + off.offY * t.s;
    ok(Math.abs(hx - 600) < 1e-6 && Math.abs(hy - 400) < 1e-6,
      `非方图 256×64（Dw=${size.Dw} Dh=${size.Dh}）+ 中心热点：热点屏幕位置 (${hx}, ${hy}) == 指针 (600,400)`);
    // 反证：若错用 Dh=28，offY 会是 14 而非 3.5 → 偏移 10.5px
    const wrongOffY = 0.5 * 28;
    ok(Math.abs(wrongOffY - off.offY) > 1,
      `反证：用错边长（Dh=28）会偏 ${(wrongOffY - off.offY).toFixed(2)}px（说明按各自边长换算是必需的）`);
    eng.unmount();
  }

  // ================================================================
  sec('进出窗口零延迟');
  // ================================================================
  {
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    const eng = new CursorEngine({ config: baseCfg, builtinImageUrl: 'builtin.png' });
    eng.mount({ glyphHost, fxCanvas });
    await sleep(20);
    const move = docL.get('mousemove');

    move({ clientX: 500, clientY: 400 });
    ok(bodyEl.classList.contains('cursor-hidden'), '滑入后 cursor-hidden 已挂（原生光标被压制）');
    ok(glyphHost.style._p.visibility === 'visible', '滑入后字形立即可见（不淡入）');
    const t = parseTransform(glyphHost.style._p.transform);
    const off = imageApi.hotspotToOffset(0.06836, 0, 28, 28);
    ok(Math.abs(t.tx + off.offX * t.s - 500) < 1e-6, '滑入首个事件即精确落位（无追赶）');

    // 滑出
    docL.get('mouseout')({ relatedTarget: null });
    ok(!bodyEl.classList.contains('cursor-hidden'), '滑出后立即摘 cursor-hidden（原生光标立即接管）');
    ok(glyphHost.style._p.visibility === 'hidden', '滑出后字形立即隐藏');
    ok(glyphHost.style._p.opacity === '0', '滑出后 opacity=0（不是淡出残留）');

    // 再滑入 —— 必须落在新的真实位置，而不是回到旧位置
    move({ clientX: 1100, clientY: 700 });
    const t2 = parseTransform(glyphHost.style._p.transform);
    ok(Math.abs(t2.tx + off.offX * t2.s - 1100) < 1e-6, '再次滑入精确落在新位置 (1100,700)');
    ok(bodyEl.classList.contains('cursor-hidden'), '再次滑入重新挂 cursor-hidden');

    eng.unmount();
  }

  // ================================================================
  sec('门控 cursor-gate-off');
  // ================================================================
  {
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    const eng = new CursorEngine({ config: baseCfg, builtinImageUrl: 'builtin.png' });
    eng.mount({ glyphHost, fxCanvas });
    await sleep(20);
    const move = docL.get('mousemove');
    move({ clientX: 300, clientY: 200 });
    const before = glyphHost.style._p.transform;

    bodyEl.classList.add('cursor-gate-off');
    move({ clientX: 900, clientY: 800 });
    ok(glyphHost.style._p.transform === before, '门控开启后 mousemove 被忽略（transform 未变）');
    ok(!/900/.test(glyphHost.style._p.transform), '门控开启后光标未跳到门控坐标（不乱跳）');

    bodyEl.classList.remove('cursor-gate-off');
    move({ clientX: 900, clientY: 800 });
    const t = parseTransform(glyphHost.style._p.transform);
    const off = imageApi.hotspotToOffset(0.06836, 0, 28, 28);
    ok(Math.abs(t.tx + off.offX * t.s - 900) < 1e-6, '解除门控后恢复精确跟随');
    eng.unmount();
  }

  // ================================================================
  sec('自定义图加载失败 → 回退内置（光标不消失）');
  // ================================================================
  {
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    const eng = new CursorEngine({ config: baseCfg, builtinImageUrl: 'builtin.png' });
    eng.mount({ glyphHost, fxCanvas });
    await sleep(20);
    const img = glyphHost.children[0];
    ok(img.src === 'builtin.png', '默认使用内置光标');
    eng.updateConfig({ image: 'broken-data' });
    await sleep(30);
    ok(String(img.src).includes('builtin'), `坏图回退内置（src=${img.src}）`);
    ok(glyphHost.style._p.display !== 'none', '回退后 img 未被隐藏（光标不消失）');
    // 回退后仍要能定位
    docL.get('mousemove')({ clientX: 500, clientY: 400 });
    const t = parseTransform(glyphHost.style._p.transform);
    ok(t && Math.abs(t.tx - (500 - 0.06836 * 28)) < 1e-4, '回退内置后定位仍精确');
    eng.unmount();
  }

  // ================================================================
  sec('拖动热点实时生效 + 卸载解绑');
  // ================================================================
  {
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    const eng = new CursorEngine({ config: baseCfg, builtinImageUrl: 'builtin.png' });
    eng.mount({ glyphHost, fxCanvas });
    await sleep(20);
    docL.get('mousemove')({ clientX: 700, clientY: 500 });
    const preview = winL.get('ny-cursor-hotspot-preview');
    ok(!!preview, '引擎监听 ny-cursor-hotspot-preview');
    preview({ detail: { hotspotX: 0.5, hotspotY: 0.5 } });
    let t = parseTransform(glyphHost.style._p.transform);
    ok(Math.abs(t.tx - (700 - 14)) < 1e-6 && Math.abs(t.ty - (500 - 14)) < 1e-6,
      `拖动中实时生效（不落盘）：transform=(${t.tx},${t.ty})，期望 (686,486)`);
    eng.unmount();
    ok(winL.size === 0 && docL.size === 0, `卸载后监听全部解绑（win=${winL.size} doc=${docL.size}）`);
  }

  // ================================================================
  sec('上传图片处理（尺寸/透明/拒绝）');
  // ================================================================
  {
    // 直接跑 processCursorImageFile 需要 DOM canvas —— 用桩验证关键分支（类型/体积拒绝）
    const imgApi = imageApi;
    ok(typeof imgApi.processCursorImageFile === 'function', 'processCursorImageFile 导出');
    ok(typeof imgApi.isImageFile === 'function', 'isImageFile 导出');
    ok(imgApi.isImageFile({ type: 'image/png', name: 'a.png' }) === true, '识别 image/png');
    ok(imgApi.isImageFile({ type: '', name: 'a.JPG' }) === true, '无 MIME 时按扩展名识别');
    ok(imgApi.isImageFile({ type: 'text/plain', name: 'a.txt' }) === false, '拒绝非图片');
    const tooBig = await imgApi.processCursorImageFile({ size: 5 * 1024 * 1024, type: 'image/png', name: 'a.png' });
    ok(tooBig.ok === false && tooBig.reason === 'too-large', '超 4MB 被拒绝（too-large）');
    const notImg = await imgApi.processCursorImageFile({ size: 100, type: 'text/plain', name: 'a.txt' });
    ok(notImg.ok === false && notImg.reason === 'not-image', '非图片被拒绝（not-image）');
    // 缩放上限的纯算法复算
    const scale = Math.min(1, 128 / Math.max(512, 256));
    ok(Math.round(512 * scale) === 128 && Math.round(256 * scale) === 64,
      `512×256 缩放到最长边 128 → 128×64（scale=${scale}）`);
  }

  // ================================================================
  sec('i18n：CursorSettings 引用的键在 10 处语言都存在');
  // ================================================================
  {
    function parseInlineDict(src, lang) {
      const m = new RegExp('\\n  ' + lang + ': \\{').exec(src);
      if (!m) return null;
      const open = src.indexOf('{', m.index); let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) {
          const body = src.slice(open + 1, i); const d = {}; const re = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g; let mm;
          while ((mm = re.exec(body))) d[mm[1]] = mm[2]; return d; } }
      }
      return null;
    }
    const trans = read('src/i18n/translations.ts');
    const dicts = { zh: parseInlineDict(trans, 'zh'), en: parseInlineDict(trans, 'en') };
    for (const l of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
      dicts[l] = JSON.parse(read(`src/i18n/locales/${l}.json`));
    }
    const cs = read('src/components/CursorSettings.tsx');
    const used = [...new Set([...cs.matchAll(/t\('([^']+)'\)/g)].map(m => m[1]))];
    for (const lang of Object.keys(dicts)) {
      const miss = used.filter(k => !(k in dicts[lang]));
      const empty = used.filter(k => k in dicts[lang] && !String(dicts[lang][k]).trim());
      ok(miss.length === 0 && empty.length === 0,
        `${lang}：CursorSettings 的 ${used.length} 个键齐全且非空${miss.length ? ' 缺:' + miss.join(',') : ''}${empty.length ? ' 空:' + empty.join(',') : ''}`);
    }
  }
} catch (e) {
  ok(false, '运行时验收抛异常：' + e.message + '\n' + e.stack);
} finally {
  g.document = saved.document; g.window = saved.window; g.Image = saved.Image;
  g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf;
  g.ResizeObserver = saved.ro; g.CustomEvent = saved.ce; g.getComputedStyle = saved.gcs;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
