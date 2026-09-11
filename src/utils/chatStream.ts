import { api } from '../ipc';
import type { ModelConfig } from '../types';

// ===== 流式输出「生效来源」工具（主窗 ChatWindow 与小窗 MiniChat 共用）=====
// 优先级：模型独立 streamEnabled（模型编辑器设置）> 全局 enableStreaming（设置页）。

export interface StreamPref {
  on: boolean;
  source: 'model' | 'global'; // model=模型独立设置；global=跟随全局开关
}

// 解析当前聊天的生效流式偏好（含来源）。群聊（getChatModel 返回 null）直接用全局。
// 能力探针判定不支持流式（model.supportsStream === false）时强制视为关闭。
export async function resolveStreamInfo(chatType: string, chatId: string): Promise<StreamPref> {
  try {
    const [settings, model] = await Promise.all([
      api.getSettings(),
      api.getChatModel(chatType, chatId).catch(() => null),
    ]);
    const probeOff = model?.supportsStream === false; // 探针确认不支持流式
    if (model?.streamEnabled !== undefined) return { on: model.streamEnabled && !probeOff, source: 'model' };
    return { on: !!settings?.enableStreaming && !probeOff, source: 'global' };
  } catch {
    return { on: false, source: 'global' };
  }
}

// 解析当前聊天的生效流式偏好。群聊（getChatModel 返回 null）直接用全局。
export async function resolveWantStream(chatType: string, chatId: string): Promise<boolean> {
  return (await resolveStreamInfo(chatType, chatId)).on;
}

// 写入聊天流式开关：写到当前生效来源——
// 模型已独立设置 streamEnabled → 写该模型；否则写全局 enableStreaming（单聊/群聊一致）。
export async function persistStreamToggle(
  chatType: string,
  chatId: string,
  next: boolean
): Promise<void> {
  const settings = await api.getSettings();
  let model: ModelConfig | null = null;
  try {
    model = await api.getChatModel(chatType, chatId);
  } catch {
    model = null;
  }
  if (chatType !== 'group' && model && model.streamEnabled !== undefined) {
    const models = (settings.models || []).map((m) =>
      m.id === model!.id ? { ...m, streamEnabled: next } : m
    );
    await api.saveSettings({ models });
  } else {
    await api.saveSettings({ enableStreaming: next });
  }
}
