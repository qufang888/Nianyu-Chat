// 录音格式兼容层：把 MediaRecorder 产出的 webm/opus 转成 16-bit PCM WAV（16kHz 单声道）。
// 根因：多数 OpenAI 兼容 ASR 服务端只接受 wav/mp3/m4a/flac，直接上传 webm/opus 会被拒（HTTP 400）。
// WAV/PCM 是兼容性最好的容器，几乎被所有 transcription 端点接受，故默认走 WAV。

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// 将单声道 Float32 采样编码为 16-bit PCM WAV Blob
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // 位深
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

// 把任意可解码的音频 Blob 重采样到 16kHz 单声道并封装为 WAV。
// 解码/重采样失败（如运行环境不支持某编码）时回退为原 Blob，交由上层按原格式发送。
export async function blobToWav(blob: Blob): Promise<Blob> {
  try {
    const AC: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return blob;
    const arrayBuf = await blob.arrayBuffer();
    const decodeCtx = new AC();
    let decoded: AudioBuffer;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuf);
    } finally {
      decodeCtx.close().catch(() => {});
    }
    const targetRate = 16000;
    if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
      return encodeWav(decoded.getChannelData(0), targetRate);
    }
    // 离线渲染到目标采样率（Chromium 内部完成高质量重采样）
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, frames, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), targetRate);
  } catch (e) {
    console.warn('[audio] WAV 转换失败，回退原格式', e);
    return blob;
  }
}

// 依据目标格式推导上传用的扩展名与 Content-Type（与 ai.ts 中的映射保持一致）
export function formatToExt(format: string): { ext: string; mime: string } {
  switch (format) {
    case 'mp3':
      return { ext: 'audio.mp3', mime: 'audio/mpeg' };
    case 'm4a':
      return { ext: 'audio.m4a', mime: 'audio/mp4' };
    case 'flac':
      return { ext: 'audio.flac', mime: 'audio/flac' };
    case 'webm':
      return { ext: 'audio.webm', mime: 'audio/webm' };
    case 'wav':
    default:
      return { ext: 'audio.wav', mime: 'audio/wav' };
  }
}
