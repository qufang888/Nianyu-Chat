/**
 * 生成念语内置音效（v2.3.97）—— **程序合成，零第三方版权风险**
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
 * 用法：node scripts/gen-builtin-sounds.mjs
 * 输出：public/sounds/*.wav
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'public', 'sounds');
const SR = 44100; // 采样率

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

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, samples] of files) {
  const p = path.join(OUT, name);
  writeWav(p, samples);
  const sz = fs.statSync(p).size;
  total += sz;
  console.log(`  ${name.padEnd(20)} ${String(samples.length).padStart(6)} 采样  ${String(sz).padStart(7)} 字节`);
}
console.log(`\n共 ${files.length} 个音效，合计 ${(total / 1024).toFixed(1)} KB（全部为程序合成，无第三方素材）`);
console.log(`输出目录：${OUT}`);
