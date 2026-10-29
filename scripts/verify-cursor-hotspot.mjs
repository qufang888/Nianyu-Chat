#!/usr/bin/env node
/**
 * verify-cursor-hotspot.mjs
 * ---------------------------------------------------------------------------
 * 校验「动态光标热点（hotspotX）与 cursor.png 的真实箭头尖端一致」。
 *
 * 背景：cursor.png 是 512×512 的**调色板 PNG**（colorType 3，带 tRNS 透明度表）。
 * 箭头尖端在顶行（y=0）的 x=35 处（该行 alpha 梯度为 x=34→7、x=35→71、x=36→119…，
 * 轮廓可见起点取 alpha≥25% 的第一个像素）。旧默认值 hotspotX=0.44 来自「把尖端误测为
 * 8/512」的错误取证，导致字形尖端被画在真实指针**右侧约 1.47px** —— 用户看到的
 * 「光标尖」在真实点击点右边，点下去却落在左侧。
 *
 * **v2.3.126 重做**：热点单位从「28 基准像素」改为「**比例**（0~1，相对图像自身宽高）」。
 * 因此正确值 = 35 / 512 = **0.06836**（不再是 35/512*28 = 1.9141px）。
 *
 * 本脚本只用 Node 内置 zlib 解 PNG（不引任何三方库），独立算出真实尖端：
 *   1. 解析 IHDR / PLTE / tRNS / IDAT；
 *   2. inflate + 逐行反滤波，得到每像素的调色板索引与 alpha；
 *   3. 取「最上一个有像素的行」（箭头顶行），该行内**第一个足够可见**的像素即为尖端；
 *   4. 换算成比例：ratio = tipX / 512；
 *   5. 与 src/types.ts 的 hotspotX 默认值比对（容差 0.001）——不一致即 FAIL。
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

/** PNG 原始边长（热点比例按图像自身宽高计算） */
const SRC_SIZE = 512;
/** 与 src/types.ts 默认值比对的容差 */
const TOLERANCE = 0.001;

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
 *  是 alpha≥25% 的 x=35。故锚点取 (35, 0) → 比例热点 = 35/512 = 0.06836。
 *  （与几何左缘 34 相比只差 0.002 个比例单位，肉眼不可分辨；但**必须**精确到 1/512 级 ——
 *  旧默认值 0.44 偏了整整 0.37，那才是用户能感知的「点不到 / 点偏」的真根因。）
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
  // v2.3.126：热点单位是「比例」（相对图像自身宽高）
  const ratio = tip.x / SRC_SIZE;
  const geoLeftRatio = tip.firstVisible / SRC_SIZE;
  console.log(`  · 顶行 y=${tip.y} 首个可见像素 x=${tip.firstVisible}（alpha 极低，几何左缘），首个足够可见像素 x=${tip.firstOpaque}`);
  console.log(`  · 尖端锚点 = (${tip.x}, ${tip.y})  ← 顶行首个 alpha≥25% 的像素（轮廓可见起点）`);
  console.log(`  · 比例热点 = ${tip.x}/${SRC_SIZE} = ${ratio.toFixed(5)}（几何左缘 ${geoLeftRatio.toFixed(5)}，差 ${(ratio - geoLeftRatio).toFixed(5)} 肉眼不可分辨）`);
  console.log(`  · 换算成 28px 显示尺寸下的像素偏移 = ${(ratio * 28).toFixed(4)}px（旧语义 1.9141px，等价）`);

  console.log('=== 2. 与 src/types.ts 默认值比对（比例语义）===');
  const types = readFileSync(TYPES, 'utf8');
  const m = types.match(/hotspotX:\s*([0-9.]+)/);
  ok(!!m, 'src/types.ts 中找到 hotspotX 默认值');
  if (m) {
    const def = Number(m[1]);
    console.log(`  · types.ts 默认 hotspotX = ${def}`);
    console.log(`  · 实测应取 = ${ratio.toFixed(5)}（旧错值 0.44 偏差 ${(ratio - 0.44).toFixed(5)}）`);
    ok(Math.abs(def - ratio) <= TOLERANCE,
      `types.ts 默认 hotspotX 与实测尖端一致（容差 ${TOLERANCE}，实测 ${ratio.toFixed(5)}）`);
    ok(!(Math.abs(def - 0.44) <= TOLERANCE),
      '默认值不再是旧的错值 0.44（旧值会让字形尖端偏右约 1.47px）');
    ok(def >= 0 && def <= 1, '默认值落在比例语义区间 0~1 内');
  }
  const my = types.match(/hotspotY:\s*([0-9.]+)/);
  ok(!!my && Number(my[1]) === 0, 'hotspotY 默认为 0（尖端在图像顶行）');
  ok(/hotspotSpace\?:\s*'ratio'/.test(types), 'AppSettings.customCursor 含 hotspotSpace 语义标记字段');
}

console.log('=== 3. 存量迁移闸门（electron/cursorHotspotMigration.ts + db.ts 调用点）===');
const migPath = join(root, 'electron/cursorHotspotMigration.ts');
ok(existsSync(migPath), 'electron/cursorHotspotMigration.ts 存在（迁移纯逻辑独立成模块，可行为级校验）');
if (existsSync(migPath)) {
  const mig = readFileSync(migPath, 'utf8');
  ok(/export function migrateCursorHotspot/.test(mig), '导出 migrateCursorHotspot');
  ok(/LEGACY_HOTSPOT_BASE_SIZE = 28/.test(mig), '旧语义基准尺寸 = 28（像素 → 比例的换算基数）');
  ok(/LEGACY_HOTSPOT_WRONG_VALUE = 0\.44/.test(mig), '旧错值 0.44 被登记');
  ok(/LEGACY_HOTSPOT_FIXED_VALUE = 1\.9141/.test(mig), '修正值 1.9141 被登记');
  ok(/hotspotSpace === 'ratio'/.test(mig), '已换算过则跳过（幂等标记）');
  ok(/\/ LEGACY_HOTSPOT_BASE_SIZE/.test(mig), 'hotspotX / 28 换算为比例');
}
const dbPath = join(root, 'electron/db.ts');
ok(existsSync(dbPath), 'electron/db.ts 存在');
if (existsSync(dbPath)) {
  const db = readFileSync(dbPath, 'utf8');
  ok(/migrateCursorHotspot/.test(db), 'db.ts 引用 hotspot 迁移函数 migrateCursorHotspot');
  ok(/migrateCursorHotspot\(merged\)/.test(db), '迁移已挂到 settings 读盘路径');
  ok(/from '\.\/cursorHotspotMigration'/.test(db), 'db.ts 从独立迁移模块导入');
  ok(/writeFileSync\(this\.settingsPath/.test(db), '迁移结果落盘（否则下次启动会重复换算）');
}
const settings = readFileSync(join(root, 'src/components/Settings.tsx'), 'utf8');
ok(!/hotspotX \?\? 0\.44/.test(settings), 'Settings.tsx 不再使用旧默认 0.44');
ok(!/hotspotX \?\? 1\.9141/.test(settings), 'Settings.tsx 不再使用旧「28 基准像素」默认 1.9141');
const cursorUi = readFileSync(join(root, 'src/components/CursorSettings.tsx'), 'utf8');
ok(/DEFAULT_HOTSPOT_X/.test(cursorUi), '新的设置 UI 使用比例语义的默认热点常量');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
