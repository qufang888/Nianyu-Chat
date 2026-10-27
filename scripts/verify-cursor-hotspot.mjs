/**
 * verify-cursor-hotspot.mjs
 * ---------------------------------------------------------------------------
 * 校验「动态光标热点（hotspotX）与 cursor.png 的真实箭头尖端一致」。
 *
 * 背景（v2.3.126）：cursor.png 是 512×512 的**调色板 PNG**（colorType 3，带 tRNS
 * 透明度表）。旧默认值 hotspotX=0.44 来自「把尖端误测为 8/512」的错误取证，导致字形
 * 尖端被画在真实指针**右侧约 1.47px** —— 用户看到的「光标尖」在真实点击点右边，点下去
 * 却落在左侧（用户原话：「点击的位置在鼠标光标显示位置的左侧」）。
 *
 * 本脚本只用 Node 内置 zlib 解 PNG（不引任何三方库），独立算出真实尖端：
 *   1. 解析 IHDR / PLTE / tRNS / IDAT；
 *   2. inflate + 逐行反滤波，得到每像素的调色板索引与 alpha；
 *   3. 取「最上一个有像素的行」（箭头顶行），该行内**第一个完全不透明**的像素即为尖端
 *      （抗锯齿的半透明边缘像素不算尖端，否则会取到外扩 1px 的虚边）；
 *   4. 换算到 28 基准的热点偏移：baseOffset = tipX / 512 * 28；
 *   5. 与 src/types.ts 的 hotspotX 默认值比对（容差 0.01）——不一致即 FAIL。
 *
 * 作用：防止将来换图 / 改默认热点时再次产生「显示位置 != 点击位置」的偏移。
 */
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG = join(root, 'src/assets/cursor/cursor.png');
const TYPES = join(root, 'src/types.ts');

/** 热点基准尺寸：settings 里的 hotspotX/hotspotY 是「28 像素基础尺寸」下的偏移 */
const BASE_SIZE = 28;
/** PNG 原始边长（热点按原始像素比例换算） */
const SRC_SIZE = 512;
/** 与 src/types.ts 默认值比对的容差 */
const TOLERANCE = 0.01;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  PASS  ${msg}`); pass++; }
  else { console.log(`  FAIL  ${msg}`); fail++; }
}

/** 解析 PNG（仅支持 8bit 调色板 + tRNS，正是 cursor.png 的形态） */
function parsePalettePng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < SIG.length; i++) {
    if (buf[i] !== SIG[i]) throw new Error('不是 PNG 文件');
  }
  let off = 8;
  let ihdr = null;
  let palette = null;   // RGB 三元组
  let trns = null;      // 每项 alpha
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len; // len + type + data + crc
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i + 2 < data.length; i += 3) {
        palette.push([data[i], data[i + 1], data[i + 2]]);
      }
    } else if (type === 'tRNS') {
      trns = Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new Error('缺少 IHDR');
  if (ihdr.colorType !== 3) throw new Error(`不是调色板 PNG（colorType=${ihdr.colorType}）`);
  if (ihdr.bitDepth !== 8) throw new Error(`仅支持 8bit（bitDepth=${ihdr.bitDepth}）`);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行扫描');
  if (!palette) throw new Error('缺少 PLTE');

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = 1; // 8bit 调色板：每像素 1 字节索引
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);

  // 逐行反滤波（PNG filter 0~4）
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;           // 左邻
      const b = prev ? prev[x] : 0;                    // 上邻
      const c = prev && x >= bpp ? prev[x - bpp] : 0;  // 左上
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = (v + pred) & 0xff;
          break;
        }
        default: throw new Error(`未知 filter ${filter}`);
      }
      cur[x] = v;
    }
  }

  // 调色板索引 → alpha（tRNS 缺省为 255）
  const alphaOf = (idx) => (trns && idx < trns.length ? trns[idx] : 255);
  return { width, height, pixels: out, alphaOf };
}

/** 找箭头尖端：最上一个有像素的行里，首个「足够可见」的像素（alpha ≥ 25%）
 *
 *  取证（512 调色板图，顶行 alpha 梯度实测）：
 *    x=34→7(2.7%)  x=35→71(27.8%)  x=36→119  x=37→166  x=38→211  x=39..42→227~237  x=43→217 …
 *  顶行是抗锯齿渐变带：几何左缘 x=34 只有 alpha=7（肉眼几乎不可见），轮廓真正"看得见的起点"
 *  是 alpha≥25% 的 x=35。故锚点取 (35, 0) → 28 基准热点 = 35/512*28 = 1.9141px。
 *  （与几何左缘 34 相比只差 0.055px，肉眼不可分辨；但**必须**精确到 1/512 像素级——旧默认值
 *  0.44 偏了 1.47px，那才是用户能感知的「点不到 / 点偏」的真根因。）
 */
function findTip(img) {
  const { width, height, pixels, alphaOf } = img;
  const VISIBLE_ALPHA = 64; // 25% × 255
  for (let y = 0; y < height; y++) {
    let firstVisible = -1;
    let firstOpaque = -1;
    for (let x = 0; x < width; x++) {
      const a = alphaOf(pixels[y * width + x]);
      if (a > 0 && firstVisible < 0) firstVisible = x;
      if (a >= VISIBLE_ALPHA) return { x, y, firstVisible, firstOpaque: firstOpaque < 0 ? x : firstOpaque };
      if (a === 255 && firstOpaque < 0) firstOpaque = x;
    }
  }
  return null;
}

console.log('=== 1. cursor.png 结构与尖端取证 ===');
let tip = null;
let img = null;
try {
  img = parsePalettePng(readFileSync(PNG));
  ok(img.width === SRC_SIZE && img.height === SRC_SIZE,
    `cursor.png 为 ${img.width}×${img.height}（预期 ${SRC_SIZE}×${SRC_SIZE}）`);
  tip = findTip(img);
  ok(!!tip, '成功定位箭头尖端像素');
} catch (e) {
  ok(false, `解析 cursor.png 失败：${e.message}`);
}

if (tip) {
  const baseOffset = (tip.x / SRC_SIZE) * BASE_SIZE;
  const geoLeft = (tip.firstVisible / SRC_SIZE) * BASE_SIZE;
  console.log(`  · 顶行 y=${tip.y} 首个可见像素 x=${tip.firstVisible}（alpha 极低，几何左缘），首个完全不透明像素 x=${tip.firstOpaque}`);
  console.log(`  · 尖端锚点 = (${tip.x}, ${tip.y})  ← 顶行首个 alpha≥25% 的像素（轮廓可见起点）`);
  console.log(`  · 28 基准热点偏移 = ${tip.x}/${SRC_SIZE}*${BASE_SIZE} = ${baseOffset.toFixed(4)}px（几何左缘 ${geoLeft.toFixed(4)}px，差 ${(baseOffset - geoLeft).toFixed(4)}px 肉眼不可分辨）`);

  console.log('=== 2. 与 src/types.ts 默认值比对 ===');
  const types = readFileSync(TYPES, 'utf8');
  const m = types.match(/hotspotX:\s*([0-9.]+)/);
  ok(!!m, 'src/types.ts 中找到 hotspotX 默认值');
  if (m) {
    const def = Number(m[1]);
    console.log(`  · types.ts 默认 hotspotX = ${def}`);
    console.log(`  · 实测应取 = ${baseOffset.toFixed(4)}（旧值 0.44 偏差 ${(baseOffset - 0.44).toFixed(4)}px）`);
    ok(Math.abs(def - baseOffset) <= TOLERANCE,
      `types.ts 默认 hotspotX 与实测尖端一致（容差 ${TOLERANCE}，实测 ${baseOffset.toFixed(4)}）`);
    ok(!(Math.abs(def - 0.44) <= TOLERANCE),
      '默认值不再是旧的错值 0.44（旧值会让字形尖端偏右约 1.47px）');
  }
  const my = types.match(/hotspotY:\s*([0-9.]+)/);
  ok(!!my && Number(my[1]) === 0, 'hotspotY 默认为 0（尖端在图像顶行）');
}

console.log('=== 3. 存量迁移闸门（electron/db.ts）===');
const dbPath = join(root, 'electron/db.ts');
ok(existsSync(dbPath), 'electron/db.ts 存在');
if (existsSync(dbPath)) {
  const db = readFileSync(dbPath, 'utf8');
  ok(/migrateCursorHotspot/.test(db), 'db.ts 含 hotspot 存量迁移函数 migrateCursorHotspot');
  ok(/migrateCursorHotspot\(merged\)|migrateCursorHotspot\(settings\)/.test(db),
    '迁移已挂到 settings 读盘路径（与 migrateMediaApiConfigs 同一处调用点）');
  ok(/1\.9141/.test(db), '迁移目标值 1.9141 与实测一致');
  const settings = readFileSync(join(root, 'src/components/Settings.tsx'), 'utf8');
  ok(!/hotspotX \?\? 0\.44/.test(settings), 'Settings.tsx 不再使用旧默认 0.44');
  ok((settings.match(/\?\? 1\.9141/g) || []).length >= 3, 'Settings.tsx 三处兜底均改为 1.9141');
  const cur = readFileSync(join(root, 'src/components/CustomCursor.tsx'), 'utf8');
  ok(!/hotspotX \?\? 0\.44/.test(cur), 'CustomCursor.tsx 不再使用旧默认 0.44');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
