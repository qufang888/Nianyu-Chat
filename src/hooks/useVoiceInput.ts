import { useCallback, useRef, useState } from 'react';
import { api } from '../ipc';

// 语音转文字：录音结束后识别，识别文本通过 onResult 回传（由调用方决定是否发送）。
// 不自动发送，仅把文本送入输入框，符合「识别文本进入输入框等手动发送」的约定。
export function useVoiceInput(onResult: (text: string) => void, onError?: (msg: string) => void) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        try {
          const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
          const buf = await blob.arrayBuffer();
          const text = await api.transcribeAudio(new Uint8Array(buf));
          if (text && text.trim()) onResult(text.trim());
          else onError?.('识别结果为空');
        } catch (err) {
          console.error('[voice] transcribe failed', err);
          onError?.(err instanceof Error ? err.message : String(err));
        }
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
    } catch (err) {
      setRecording(false);
      console.error('[voice] mic error', err);
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }, [onResult, onError]);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { recording, toggle };
}
