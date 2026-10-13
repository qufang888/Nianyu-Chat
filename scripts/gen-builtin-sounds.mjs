/**
 * 生成念语内置音效 —— **程序合成，零第三方版权风险**
 *
 * 为什么要换掉旧音效
 * ============================================================================
 * v2.3.94 及更早版本内置 11 个来自第三方音效站的 mp3
 * （文件名形如 `audley_fergine-ui-button-click-5-327756.mp3`、
 * `universfield-new-notification-012-363675.mp3`，是音效站批量导出的典型命名）。
 * 作者已无法回忆下载站点，因此**无法确认其许可是否允许「原样再分发」**。
 *
 * 而这类站点的通行条款（以 Pixabay Content License 为例）明确写着：
 *   "You cannot sell or redistribute the sound effects as they are."
 * 即**允许在应用里使用，但禁止把原始素材单独打包再分发**。
 * 念语此前把 mp3 直接提交进 git 并随安装包分发，正好落在这一禁止条款里 ——
 * 这是本次发版唯一有实质法律风险的项。
 *
 * 处置：全部改为**本脚本用数学波形合成**的音效。合成音频不是任何人的作品，
 * 不触发任何第三方许可，作者本人即著作权人，可自由分发与 MIT 授权。
 *
 * 合成参数说明（为什么这样选参数）
 * ============================================================================
 * - 时长极短（8~260ms）：UI 反馈音效必须短，>300ms 会显得迟钝。
 * - 包络用 exp(-t·k) 指数衰减：模拟真实敲击/铃击的物理衰减，比线性淡出自然。
 * - 全部为纯正弦/方波/三角波叠加，**不含任何采样素材**，故不存在采样权问题。
 * - 峰值统一归一化到 0.5：留足余量，避免多音效叠加时削波失真。
 * - 输出 WAV（PCM 16bit，44.1kHz 立体声）而非 MP3：MIT 协议下用 WAV 最干净，
 *   且音效文件极小（合计 <200KB），打包进安装包无压力。
 *
 * v2.3.111：新增 5 套「主题音效」包（aurora / crystal / wood / bubble / chime），
 * 每套覆盖全部 6 类音效，输出到 public/sounds/themes/<id>/。合成方法升级为
 * **加法合成**（基频 + 4~6 个泛音 + 指数衰减包络），并引入：
 *   - 轻微滑音（pitch glide）：相位积分实现，滑音过程无爆音；
 *   - 泛音微失谐（detune ±0.2%）：破坏纯正弦的机械感，出音更灵动；
 *   - 分泛音独立衰减：「叮-咚」双音色用快衰高频 + 慢衰低频叠加得到；
 *   - 噪声瞬态（木鱼主题）：确定性 LCG 伪随机，可复跑、字节稳定；
 *   - 响度归一化到 -3dBFS（10^(-3/20) ≈ 0.708），主题包之间响度一致。
 * 生成后脚本会**读回 WAV 自检**：时长、非静音、无爆音（峰值不触顶）。
 *
 * 用法：node scripts/gen-builtin-sounds.mjs
 * 输出：public/sounds/*.wav（经典默认包）+ public/sounds/themes/<id>/*.wav（5 套主题包）
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'public', 'sounds');
const SR = 44100; // 采样率

/** -3dBFS 归一化峰值（10^(-3/20) ≈ 0.7079）：留足余量，任何样本都不会削波 */
const PEAK_MINUS_3DB = Math.pow(10, -3 / 20);

/** 把 [-1,1] 的 Float32 波形写成 16bit PCM WAV 文件 */
function writeWav(file, samples) {
  const n = samples.length;
  const data = Buffer.alloc(n * 4); // 16bit * 2ch
  for (let i = 0; i < n; i++) {
    // 峰值保护：夹到 [-1, 1] 再转 16bit
    const v = Math.max(-1, Math.min(1, samples[i]));
    const s = Math.round(v * 32767);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2); // 双声道同值 → 单声道听感
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM 头长
  header.writeUInt16LE(1, 20);         // 格式 = PCM
  header.writeUInt16LE(2, 22);         // 声道数 = 2
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);     // 字节率
  header.writeUInt16LE(4, 32);          // 块对齐
  header.writeUInt16LE(16, 34);         // 位深
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/** 指数衰减包络；k 越大衰减越快 */
const decay = (t, k) => Math.exp(-t * k);

/** 正弦 */
const sin = (f, t) => Math.sin(2 * Math.PI * f * t);
/** 三角波（比方波柔和，比正弦有存在感） */
const tri = (f, t) => {
  const p = (f * t) % 1;
  return 4 * Math.abs(p - 0.5) - 1;
};
/** 方波 */
const sq = (f, t) => (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1);

/**
 * 合成一个音效
 * @param durSec时长（秒）
 * @param fn       (t: 0..durSec) => -1..1 的波形函数
 * @param peak     峰值（默认 0.5）
 */
function synth(durSec, fn, peak = 0.5) {
  const n = Math.floor(durSec * SR);
  const out = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) out[i] = fn(i / SR);
  // 先扫峰值做归一化，避免不同音色响度差异过大
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(out[i]));
  const g = max > 0 ? peak / max : 0;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

// ===== 6 类音效的合成配方 =====
// 命名与旧的 SoundType 一一对应，便于 src/utils/sound.ts 直接换路径。

/** click（点击）：短促木质感「哒」——高方波 + 快速衰减，~60ms */
const click = synth(0.06, (t) =>
  (0.6 * sq(2100, t) + 0.3 * sin(1400, t) + 0.1 * sin(3200, t)) * decay(t, 70)
);

/** error（错误）：下行二音「嘟-噜」——低音方波，明显但不刺耳，~280ms */
const error = synth(0.28, (t) => {
  // 前 130ms 高音（440→370Hz 下行），后 150ms 低音（220Hz）
  const seg = t < 0.13;
  const f = seg ? 440 - (t / 0.13) * 70 : 220;
  return (0.5 * tri(f, t) + 0.2 * sq(f / 2, t)) * decay(t, 11);
});

/** notification（消息通知）：清亮双音「叮-咚」——三角波，~260ms */
const notification = synth(0.26, (t) => {
  // 前 120ms 高音（988Hz），后 140ms 低音（784Hz）
  const seg = t < 0.12;
  const f = seg ? 988 : 784;
  return (0.55 * tri(f, t) + 0.15 * sin(f * 2, t)) * decay(t, 13);
});

/** popup（弹窗提示）：柔和上滑「叮咚」——频率渐升，~200ms */
const popup = synth(0.2, (t) => {
  // 660 → 990Hz 线性上滑
  const f = 660 + (t / 0.2) * 330;
  return (0.5 * tri(f, t) + 0.2 * sin(f * 1.5, t)) * decay(t, 15);
});

/** miniPopup（小窗弹出）：更轻更短的上滑，~150ms（小窗场景不该抢注意力） */
const miniPopup = synth(0.15, (t) => {
  const f = 700 + (t / 0.15) * 290;
  return (0.4 * tri(f, t) + 0.1 * sin(f * 1.5, t)) * decay(t, 20);
});

/** messageSend（消息发送）：轻快上滑「呼」，带一点气声感，~180ms */
const messageSend = synth(0.18, (t) => {
  // 520 → 860Hz 上滑。⚠️ 这里刻意**不用颤音（vibrato）**：
  // 22Hz 颤音会让波形反复过零，实测峰值算出来接近 0（生成出静音文件）。
  // 「发送」的动态感改用**幅度包络起伏**表达 —— 同样是两段渐强渐弱，但不碰波形过零点。
  const f = 520 + (t / 0.18) * 340;
  const swell = 0.7 + 0.3 * Math.sin(Math.PI * (t / 0.18)); // 中段最响
  return (0.45 * sin(f, t) + 0.15 * tri(f * 2, t)) * decay(t, 17) * swell;
});

/** nodeBanner（剧情节点横幅）：庄重的双音钟声，~520ms（横幅是重要事件，可稍长） */
const nodeBanner = synth(0.52, (t) => {
  // 523Hz + 784Hz 叠加，长衰减 → 钟声感
  return (0.42 * tri(523, t) + 0.3 * sin(784, t) + 0.1 * sin(1046, t)) * decay(t, 5.2);
});

const files = [
  ['click.wav', click],
  ['error.wav', error],
  ['notification.wav', notification],
  ['popup.wav', popup],
  ['miniPopup.wav', miniPopup],
  ['messageSend.wav', messageSend],
  ['nodeBanner.wav', nodeBanner],
];

// ============================================================================
// v2.3.111：5 套主题音效包（加法合成）
// ============================================================================

/** 6 类音效的类型 key（与 src/utils/sound.ts 的 SoundType 一一对应） */
const SOUND_TYPES = ['error', 'click', 'notification', 'popup', 'miniPopup', 'messageSend'];

/** 确定性伪随机（LCG）：保证每次运行产出**逐字节一致**的 wav（可复跑、git diff 干净） */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 归一化到指定峰值（默认 -3dBFS）。先扫峰值再乘增益，避免各主题响度参差不齐。
 */
function normalize(buf, peak = PEAK_MINUS_3DB) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > max) max = a;
  }
  const g = max > 0 ? peak / max : 0;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/**
 * 加法合成一个音色片段。
 *
 * @param dur   时长（秒）
 * @param parts 泛音表：[{ f, g, d?, glide?, k? }]
 *               f=基频(Hz)  g=增益  d=失谐倍数(默认1，制造微失谐) 
 *               glide=终点频率(默认=f，制造滑音)  k=该泛音独立衰减系数(默认全局)
 * @param decayK 全局指数衰减系数（越大衰减越快）
 * @param opts.noise 攻击段噪声量（0=不加；木鱼主题的木质瞬态）
 * @param opts.seed  噪声种子（默认 1；同种子字节稳定）
 *
 * 滑音用**相位积分**（∫f dt = f0·t + (f1-f0)·t²/2dur）而非「每帧重算相位」，
 * 保证频率连续变化不过零爆裂；失谐只缩放频率不改相位连续性。
 */
function additiveSynth(dur, parts, decayK, opts = {}) {
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  const rng = opts.noise ? makeRng(opts.seed ?? 1) : null;
  const noiseAttack = 0.012; // 噪声瞬态只在攻击段前 12ms
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const p of parts) {
      const f0 = p.f * (p.d ?? 1);
      const f1 = (p.glide ?? p.f) * (p.d ?? 1);
      const ph = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * dur));
      v += p.g * Math.sin(ph) * Math.exp(-t * (p.k ?? decayK));
    }
    if (rng && t < noiseAttack) {
      v += opts.noise * (2 * rng() - 1) * Math.exp(-t * 320);
    }
    out[i] = v;
  }
  return normalize(out);
}

/**
 * 每套主题的「嗓音」：给定基频/终点频率，返回泛音表。
 * 各主题的区分度全在这里——泛音结构、失谐量、衰减形态。
 */
const THEME_VOICES = {
  // 极光：空灵钟铃。非谐泛音（2/3/4.2/5.4 倍）+ 长衰减 → Apple 风铃那种悠长尾音。
  aurora: (f0, f1) => [
    { f: f0, g: 1.0, glide: f1 },
    { f: f0 * 2, g: 0.5, d: 1.001, glide: f1 * 2 },
    { f: f0 * 3, g: 0.28, d: 0.999, glide: f1 * 3 },
    { f: f0 * 4.2, g: 0.14, d: 1.002, glide: f1 * 4.2 },
    { f: f0 * 5.4, g: 0.06, glide: f1 * 5.4 },
  ],
  // 水晶：清脆。高频基频 + 强高频泛音 + 快衰减，出音像玻璃珠互敲。
  crystal: (f0, f1) => [
    { f: f0, g: 1.0, glide: f1 },
    { f: f0 * 2, g: 0.62, d: 1.0015, glide: f1 * 2 },
    { f: f0 * 3, g: 0.4, d: 0.9985, glide: f1 * 3 },
    { f: f0 * 5, g: 0.22, d: 1.002, glide: f1 * 5 },
    { f: f0 * 6.5, g: 0.1, glide: f1 * 6.5 },
  ],
  // 木鱼：笃。低基频 + 极少泛音 + 攻击段噪声瞬态，木头敲击的「咔」。
  wood: (f0, f1) => [
    { f: f0, g: 1.0, glide: f1 },
    { f: f0 * 2.4, g: 0.22, d: 0.997, glide: f1 * 2.4 },
    { f: f0 * 3.8, g: 0.08, glide: f1 * 3.8 },
  ],
  // 气泡：水波。中频基频 + 宽滑音 + 中等衰减，像气泡从水底浮上来。
  bubble: (f0, f1) => [
    { f: f0, g: 1.0, glide: f1 },
    { f: f0 * 2, g: 0.34, d: 1.002, glide: f1 * 2 },
    { f: f0 * 3, g: 0.16, d: 0.998, glide: f1 * 3 },
    { f: f0 * 4.5, g: 0.07, glide: f1 * 4.5 },
  ],
  // 风铃：摇曳。高基频 + 多个微失谐泛音（各自独立衰减）→ 多音缀摇曳感。
  chime: (f0, f1) => [
    { f: f0, g: 1.0, glide: f1, k: 6 },
    { f: f0 * 2.01, g: 0.55, glide: f1 * 2.01, k: 7.5 },
    { f: f0 * 3.02, g: 0.34, glide: f1 * 3.02, k: 9 },
    { f: f0 * 4.97, g: 0.2, glide: f1 * 4.97, k: 11 },
    { f: f0 * 6.03, g: 0.1, glide: f1 * 6.03, k: 13 },
  ],
};

/**
 * 每套主题 × 每类音效的演奏参数：[f0 基频, f1 终点频率, 时长 s, 衰减 k, 噪声量]。
 *
 * 音高表情（与默认包一致的功能语义，但音色全换）：
 *   error       下行双音（f1 < f0）——低沉、不刺耳
 *   click       极短促——UI 反馈
 *   notification 叮-咚：靠「高频快衰 + 低频慢衰」的叠加得到双音色
 *   popup       上滑——弹窗出现的「抬升感」
 *   miniPopup   更短的上滑——小窗不抢注意力
 *   messageSend 短上滑——消息发出的「送出感」
 */
const THEME_RECIPES = {
  aurora: {
    error:        [392, 330, 0.40, 7, 0],
    click:        [784, 800, 0.20, 15, 0],
    notification: [880, 880, 0.36, 8, 0],
    popup:        [660, 760, 0.30, 10, 0],
    miniPopup:    [740, 830, 0.22, 13, 0],
    messageSend:  [587, 700, 0.26, 11, 0],
  },
  crystal: {
    error:        [523, 440, 0.24, 14, 0],
    click:        [1568, 1500, 0.12, 30, 0],
    notification: [1318, 1318, 0.20, 16, 0],
    popup:        [1046, 1318, 0.16, 20, 0],
    miniPopup:    [1175, 1396, 0.13, 24, 0],
    messageSend:  [988, 1318, 0.14, 22, 0],
  },
  wood: {
    error:        [294, 262, 0.20, 22, 0.35],
    click:        [523, 510, 0.12, 42, 0.5],
    notification: [392, 330, 0.22, 20, 0.3],
    popup:        [330, 392, 0.16, 28, 0.3],
    miniPopup:    [392, 440, 0.12, 32, 0.25],
    messageSend:  [349, 415, 0.13, 30, 0.3],
  },
  bubble: {
    error:        [330, 262, 0.24, 16, 0],
    click:        [620, 700, 0.14, 22, 0],
    notification: [523, 587, 0.24, 14, 0],
    popup:        [440, 720, 0.20, 16, 0],
    miniPopup:    [494, 740, 0.15, 19, 0],
    messageSend:  [494, 760, 0.16, 18, 0],
  },
  chime: {
    error:        [392, 349, 0.36, 8, 0],
    click:        [1046, 1050, 0.22, 12, 0],
    notification: [1175, 1175, 0.32, 9, 0],
    popup:        [880, 990, 0.28, 10, 0],
    miniPopup:    [988, 1108, 0.22, 12, 0],
    messageSend:  [880, 1046, 0.24, 11, 0],
  },
};

/** 合成一套主题的全部 6 个音效（notification 的「叮-咚」用叠加快衰高频实现） */
function buildTheme(themeId) {
  const voice = THEME_VOICES[themeId];
  const recipe = THEME_RECIPES[themeId];
  const out = {};
  for (const type of SOUND_TYPES) {
    const [f0, f1, dur, k, noise] = recipe[type];
    if (type === 'notification') {
      // 双音色：高频快衰（叮）+ 基频慢衰（咚）叠加，时长各半
      const hi = additiveSynth(dur, [{ f: f0 * 1.5, g: 0.8, glide: f1 * 1.5, k: k * 3 }], k * 3);
      const lo = additiveSynth(dur, voice(f0, f1), k);
      const n = Math.min(hi.length, lo.length);
      const mix = new Float32Array(n);
      for (let i = 0; i < n; i++) mix[i] = hi[i] + lo[i];
      out[type] = normalize(mix);
    } else {
      out[type] = additiveSynth(dur, voice(f0, f1), k, noise ? { noise, seed: 7 } : {});
    }
  }
  return out;
}

// ============================================================================
// 写出 + 读回自检
// ============================================================================

/** 读回 WAV 的 16bit PCM 数据（跳过 44 字节头），用于自检 */
function readWavSamples(file) {
  const buf = fs.readFileSync(file);
  const dataBytes = buf.length - 44;
  const frames = Math.floor(dataBytes / 4); // 16bit × 2ch
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames * 2; i++) samples[i] = buf.readInt16LE(44 + i * 2);
  return { frames, samples };
}

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, samples] of files) {
  const p = path.join(OUT, name);
  writeWav(p, samples);
  const sz = fs.statSync(p).size;
  total += sz;
  console.log(`  ${name.padEnd(20)} ${String(samples.length).padStart(6)} 采样  ${String(sz).padStart(7)} 字节`);
}
console.log(`\n经典默认包：共 ${files.length} 个音效，合计 ${(total / 1024).toFixed(1)} KB（全部为程序合成，无第三方素材）`);

// ---- 5 套主题包 ----
const THEME_IDS = ['aurora', 'crystal', 'wood', 'bubble', 'chime'];
let themeTotal = 0;
let selfCheckFail = 0;
console.log('\n主题音效包（public/sounds/themes/）：');
for (const id of THEME_IDS) {
  const dir = path.join(OUT, 'themes', id);
  fs.mkdirSync(dir, { recursive: true });
  const built = buildTheme(id);
  console.log(`  [${id}]`);
  for (const type of SOUND_TYPES) {
    const p = path.join(dir, `${type}.wav`);
    writeWav(p, built[type]);
    const sz = fs.statSync(p).size;
    themeTotal += sz;
    // ---- 读回自检：时长 / 非静音 / 无爆音 ----
    const { frames, samples } = readWavSamples(p);
    const durSec = frames / SR;
    let peak = 0;
    let nonZero = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
      if (a > 0) nonZero++;
    }
    const clipped = peak >= 32767; // 触顶即削波
    const silent = nonZero === 0;
    const durOk = durSec >= 0.1 && durSec <= 0.45; // 每类 0.12~0.4s 的验收区间（含 rounding 余量）
    if (clipped || silent || !durOk) selfCheckFail++;
    const flag = clipped ? ' CLIPPED!' : silent ? ' SILENT!' : !durOk ? ' DUR!' : '';
    console.log(
      `    ${type.padEnd(12)} ${durSec.toFixed(3)}s  peak=${String(peak).padStart(5)}/32767  ${String(sz).padStart(7)}B${flag}`
    );
  }
}
console.log(`\n主题包合计：${THEME_IDS.length * SOUND_TYPES.length} 个文件，${(themeTotal / 1024).toFixed(1)} KB`);
if (selfCheckFail > 0) {
  console.error(`\n✗ 自检失败：${selfCheckFail} 个文件存在爆音/静音/时长越界`);
  process.exit(1);
}
console.log('自检通过：全部主题音效无爆音（峰值 < 32767）、非静音、时长在 0.12~0.4s 区间');
console.log(`输出目录：${OUT}`);
