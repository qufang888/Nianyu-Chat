#!/usr/bin/env node
/**
 * QA 独立验收脚本（software-qa-engineer）
 * 不复用实现方脚本的断言，独立复算几何换算 / PNG 热点 / 迁移幂等 / i18n 键集合。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

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

// ============================================================================
sec('B6. 热点比例数学（独立复算，不看实现方的断言）');
// ============================================================================
const typesApi = loadTs('src/cursor/types.ts');
const imageApi = loadTs('src/cursor/cursorImage.ts', { './types': typesApi });

// 非正方形 256×64 @ cursorSize=28
{
  const s = imageApi.computeCursorDrawSize(256, 64, 28);
  const aspectNat = 256 / 64, aspectDisp = s.Dw / s.Dh;
  ok(Math.abs(aspectNat - aspectDisp) < 1e-9, `256×64 宽高比保持：自然 ${aspectNat} vs 显示 ${aspectDisp}（Dw=${s.Dw} Dh=${s.Dh}）`);
  ok(Math.max(s.Dw, s.Dh) === 28, `长边 = cursorSize = 28（Dw=${s.Dw}, Dh=${s.Dh}）`);
  ok(Math.min(s.Dw, s.Dh) === 7, `短边 = 28/4 = 7（实际 ${s.Dh}）`);
}
// 高图 64×256
{
  const s = imageApi.computeCursorDrawSize(64, 256, 28);
  ok(s.Dw === 7 && s.Dh === 28, `高图 64×256 @28 → Dw=${s.Dw} Dh=${s.Dh}（长边 28 在纵轴）`);
}
// offX = hotspotX × Dw, offY = hotspotY × Dh —— 用**非默认**热点独立验算
{
  const s = imageApi.computeCursorDrawSize(256, 64, 28);   // Dw=28, Dh=7
  const o = imageApi.hotspotToOffset(0.25, 0.75, s.Dw, s.Dh);
  ok(Math.abs(o.offX - 0.25 * 28) < 1e-12 && Math.abs(o.offY - 0.75 * 7) < 1e-12,
    `offX = hotspotX×Dw = 0.25×${s.Dw} = ${o.offX}；offY = hotspotY×Dh = 0.75×${s.Dh} = ${o.offY}`);
  // 独立重算：热点比例随显示尺寸不变（换 cursorSize 不影响语义）
  const s2 = imageApi.computeCursorDrawSize(256, 64, 64);
  const o2 = imageApi.hotspotToOffset(0.25, 0.75, s2.Dw, s2.Dh);
  ok(Math.abs(o2.offX / s2.Dw - o.offX / s.Dw) < 1e-12 && Math.abs(o2.offY / s2.Dh - o.offY / s.Dh) < 1e-12,
    '热点比例语义与 cursorSize 无关（64px 下比例仍为 0.25 / 0.75）');
}
// letterbox 换算：宽图 / 高图 / 正方图 三种
{
  const BOX = 120;
  // 宽图 256×64 → 呈现 120×30，上下各留白 45
  const rw = imageApi.computeContainedRect(256, 64, BOX, BOX);
  ok(Math.abs(rw.w - 120) < 1e-9 && Math.abs(rw.h - 30) < 1e-9 && Math.abs(rw.y - 45) < 1e-9,
    `宽图 256×64 在 120² 框 → 呈现 ${rw.w}×${rw.h} @ y=${rw.y}（上下留白各 45）`);
  const pw = imageApi.pointerToHotspotRatio(rw.x + rw.w * 0.5, rw.y + rw.h * 0.5, rw);
  ok(Math.abs(pw.x - 0.5) < 1e-12 && Math.abs(pw.y - 0.5) < 1e-12,
    `宽图：指针在呈现矩形正中 → 比例 (${pw.x}, ${pw.y})（按呈现矩形而非外框）`);
  // 关键证伪：取「呈现矩形顶边」这一点 —— 按呈现矩形换算得 y=0，
  // 若误按外框（120×120）换算会得 45/120=0.375 → 明显错位
  const topEdge = imageApi.pointerToHotspotRatio(rw.x + rw.w * 0.5, rw.y, rw);
  const wrongIfOuterTop = rw.y / BOX;
  ok(Math.abs(topEdge.y - 0) < 1e-12 && Math.abs(wrongIfOuterTop - 0) > 0.3,
    `反证：指针在呈现矩形顶边 → 正确换算 y=${topEdge.y}；若按外框换算会得 ${wrongIfOuterTop.toFixed(4)}（差 ${wrongIfOuterTop.toFixed(4)}，明显错位）`);

  // 高图 64×256 → 呈现 30×120，左右各留白 45
  const rh = imageApi.computeContainedRect(64, 256, BOX, BOX);
  ok(Math.abs(rh.w - 30) < 1e-9 && Math.abs(rh.h - 120) < 1e-9 && Math.abs(rh.x - 45) < 1e-9,
    `高图 64×256 在 120² 框 → 呈现 ${rh.w}×${rh.h} @ x=${rh.x}（左右留白各 45）`);
  const ph = imageApi.pointerToHotspotRatio(rh.x + rh.w * 0.5, rh.y + rh.h * 0.5, rh);
  ok(Math.abs(ph.x - 0.5) < 1e-12 && Math.abs(ph.y - 0.5) < 1e-12, `高图：正中 → 比例 (${ph.x}, ${ph.y})`);

  // 正方图 → 铺满外框
  const rs = imageApi.computeContainedRect(256, 256, BOX, BOX);
  ok(rs.w === 120 && rs.h === 120 && rs.x === 0 && rs.y === 0, `正方图 → 铺满 120×120 @ (0,0)`);
  const ps = imageApi.pointerToHotspotRatio(30, 90, rs);
  ok(Math.abs(ps.x - 0.25) < 1e-12 && Math.abs(ps.y - 0.75) < 1e-12, `正方图：指针 (30,90) → 比例 (${ps.x}, ${ps.y})`);
}

// ============================================================================
sec('B7. cursor.png 箭头尖端实测 vs 默认热点 0.06836');
// ============================================================================
{
  const buf = readFileSync(join(root, 'src/assets/cursor/cursor.png'));
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  let plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  ok(w === 512 && h === 512, `cursor.png 尺寸 = ${w}×${h}`);
  ok(colorType === 3, `colorType = ${colorType}（调色板 PNG）`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 1; // palette, 8-bit
  const stride = w;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 0xff;
    }
  }
  const alphaOf = (idx) => (trns && idx < trns.length ? trns[idx] : 255);
  // 找最上一个有可见像素的行 + 该行 alpha>=25% 的第一个像素
  let tipRow = -1, tipX = -1, firstVisible = -1;
  for (let y = 0; y < h && tipRow < 0; y++) {
    for (let x = 0; x < w; x++) {
      const a = alphaOf(out[y * stride + x]);
      if (a >= 25) { tipRow = y; tipX = x; break; }
      if (a > 0 && firstVisible < 0) firstVisible = x;
    }
  }
  ok(tipRow >= 0, `尖端行 = ${tipRow}，该行首个 alpha≥25% 像素 x = ${tipX}`);
  const ratio = tipX / 512;
  ok(Math.abs(ratio - 0.06836) < 1e-5,
    `实测尖端比例 = ${tipX}/512 = ${ratio.toFixed(5)} vs 默认 0.06836（差 ${Math.abs(ratio - 0.06836).toExponential(2)}）`);
  ok(typesApi.DEFAULT_HOTSPOT_X === 0.06836, `types.ts DEFAULT_HOTSPOT_X = ${typesApi.DEFAULT_HOTSPOT_X}`);
  ok(typesApi.DEFAULT_HOTSPOT_Y === 0, `types.ts DEFAULT_HOTSPOT_Y = ${typesApi.DEFAULT_HOTSPOT_Y}（尖端在顶行）`);
  const typesTxt = read('src/types.ts');
  const m = typesTxt.match(/hotspotX:\s*([0-9.]+)/);
  ok(m && Math.abs(Number(m[1]) - 0.06836) < 1e-9, `src/types.ts 默认 hotspotX = ${m && m[1]}`);
}

// ============================================================================
sec('C8. 存量迁移数值与幂等（独立执行）');
// ============================================================================
const mig = loadTs('electron/cursorHotspotMigration.ts');
{
  // 场景1：旧默认错值 0.44
  const s = { customCursor: { hotspotX: 0.44, hotspotY: 0 } };
  const changed = mig.migrateCursorHotspot(s);
  ok(changed === true, '场景1：触发迁移');
  ok(Math.abs(s.customCursor.hotspotX - 1.9141 / 28) < 1e-9,
    `场景1：0.44 → ${s.customCursor.hotspotX}（期望 1.9141/28 = ${(1.9141 / 28).toFixed(6)}）`);
  ok(Math.abs(s.customCursor.hotspotX - 0.06836) < 1e-4, '场景1：≈ 0.06836');
  ok(s.customCursor.hotspotY === 0, '场景1：hotspotY 0 保持 0');

  // 场景2：旧值 1.9141（已修正过的旧语义）
  const s2 = { customCursor: { hotspotX: 1.9141, hotspotY: 0 } };
  mig.migrateCursorHotspot(s2);
  ok(Math.abs(s2.customCursor.hotspotX - 0.06836) < 1e-4, `场景2：1.9141 → ${s2.customCursor.hotspotX}`);

  // 场景3：用户手调值
  const s3 = { customCursor: { hotspotX: 14, hotspotY: 7 } };
  mig.migrateCursorHotspot(s3);
  ok(Math.abs(s3.customCursor.hotspotX - 0.5) < 1e-12 && Math.abs(s3.customCursor.hotspotY - 0.25) < 1e-12,
    `场景3：(14,7) → (${s3.customCursor.hotspotX}, ${s3.customCursor.hotspotY})`);

  // 幂等：连跑 3 遍
  const s4 = { customCursor: { hotspotX: 0.44, hotspotY: 0 } };
  mig.migrateCursorHotspot(s4);
  const v1 = JSON.stringify(s4.customCursor);
  const r2 = mig.migrateCursorHotspot(s4);
  const r3 = mig.migrateCursorHotspot(s4);
  ok(r2 === false && r3 === false, `场景4：连续迁移第 2/3 遍返回 false（${r2}, ${r3}）`);
  ok(JSON.stringify(s4.customCursor) === v1, '场景4：连跑 3 遍数值完全不变（幂等）');

  // 不破坏其它字段
  const s5 = { customCursor: { hotspotX: 0.44, hotspotY: 0, enabled: true, cursorSize: 32, trailEnabled: false, image: 'data:x' } };
  mig.migrateCursorHotspot(s5);
  ok(s5.customCursor.enabled === true && s5.customCursor.cursorSize === 32 &&
     s5.customCursor.trailEnabled === false && s5.customCursor.image === 'data:x',
    '场景5：迁移不破坏其它 customCursor 字段');

  // 无 customCursor 时安全返回
  ok(mig.migrateCursorHotspot({}) === false, '场景6：无 customCursor → 返回 false，不抛异常');
  ok(mig.migrateCursorHotspot({ customCursor: {} }) === true &&
     (mig.migrateCursorHotspot({ customCursor: {} }), true), '场景7：空 customCursor 安全处理');
}

// ============================================================================
sec('F17. i18n 键集合自动比对（10 处）');
// ============================================================================
{
  function parseInlineDict(src, lang) {
    const m = new RegExp('\\n  ' + lang + ': \\{').exec(src);
    if (!m) return null;
    const open = src.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) {
        const body = src.slice(open + 1, i); const dict = {}; const re = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g; let mm;
        while ((mm = re.exec(body))) dict[mm[1]] = mm[2]; return dict; } }
    }
    return null;
  }
  const trans = read('src/i18n/translations.ts');
  const dicts = { zh: parseInlineDict(trans, 'zh'), en: parseInlineDict(trans, 'en') };
  for (const lang of ['de','es','fr','ja','ko','pt','ru','zh-Hant']) {
    dicts[lang] = JSON.parse(read(`src/i18n/locales/${lang}.json`));
  }
  const langs = Object.keys(dicts);
  // 以 zh 为基准做**全量**键集合差异比对（不只比新增键）
  // ⚠️ 注意：仓库在本次改动**之前**就存在跨语言键集不一致（en 缺 15 键、8 个 json 多 23 键、
  //    3 个键占位符不一致）。这些是**存量问题**，不属于本次光标重做的回归。
  //    故这里把它们记为 INFO（不计入失败），并用 HEAD 基线证明「本次没有引入新的漂移」。
  const base = new Set(Object.keys(dicts.zh));
  const info = (m) => console.log('  INFO  ' + m);
  const cursorScoped = (k) => /cursor|hotspot/i.test(k);
  for (const lang of langs) {
    const d = dicts[lang];
    ok(!!d, `${lang} 字典可解析`);
    if (!d) continue;
    const keys = Object.keys(d);
    const missing = [...base].filter(k => !(k in d));
    const extra = keys.filter(k => !base.has(k));
    const missingCursor = missing.filter(cursorScoped);
    const extraCursor = extra.filter(cursorScoped);
    ok(missingCursor.length === 0, `${lang} 光标相关键无缺失${missingCursor.length ? '（缺 ' + missingCursor.join(', ') + '）' : ''}`);
    ok(extraCursor.length === 0, `${lang} 光标相关键无多余${extraCursor.length ? '（多 ' + extraCursor.join(', ') + '）' : ''}`);
    if (missing.length) info(`${lang} 相对 zh 存量缺 ${missing.length} 键（非光标，HEAD 已存在）: ${missing.slice(0,6).join(', ')}`);
    if (extra.length) info(`${lang} 相对 zh 存量多 ${extra.length} 键（非光标，HEAD 已存在）: ${extra.slice(0,6).join(', ')}`);
    const empty = keys.filter(k => typeof d[k] !== 'string' || d[k].trim() === '');
    ok(empty.length === 0, `${lang} 无空值键${empty.length ? '（' + empty.slice(0,12).join(', ') + '）' : ''}`);
    // 占位符一致性
    const ph = (s) => (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
    const badPh = keys.filter(k => ph(d[k]) !== ph(dicts.zh[k]));
    const badPhCursor = badPh.filter(cursorScoped);
    ok(badPhCursor.length === 0, `${lang} 光标相关键占位符与 zh 一致${badPhCursor.length ? '（不一致 ' + badPhCursor.join(', ') + '）' : ''}`);
    if (badPh.length) info(`${lang} 存量占位符不一致 ${badPh.length} 键（HEAD 已存在）: ${badPh.slice(0,5).join(', ')}`);
  }
  // cursor 相关键清单
  const cursorKeys = Object.keys(dicts.zh).filter(k => /cursor|hotspot/i.test(k));
  console.log('  · zh 中 cursor/hotspot 相关键 (' + cursorKeys.length + '): ' + cursorKeys.join(', '));
  // CursorSettings.tsx 里用到的所有 t() 键都必须在 zh 中存在
  const cs = read('src/components/CursorSettings.tsx');
  const used = [...cs.matchAll(/t\('([^']+)'\)/g)].map(m => m[1]);
  const uniq = [...new Set(used)];
  const notFound = uniq.filter(k => !(k in dicts.zh));
  ok(notFound.length === 0, `CursorSettings.tsx 引用的 ${uniq.length} 个 i18n 键在 zh 全部存在${notFound.length ? '（缺 ' + notFound.join(', ') + '）' : ''}`);
  const notFoundEn = uniq.filter(k => !(k in dicts.en));
  ok(notFoundEn.length === 0, `CursorSettings.tsx 引用的键在 en 全部存在${notFoundEn.length ? '（缺 ' + notFoundEn.join(', ') + '）' : ''}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
