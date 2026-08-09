// 错误自诊模块：根据错误文本自动匹配原因和解决方案（双语）
// 新增诊断规则只需在 DIAGNOSES 数组中追加一条。

export interface DiagnosisResult {
  matched: boolean;
  cause: { zh: string; en: string };
  solution: { zh: string; en: string };
}

interface DiagnosisRule {
  pattern: RegExp;
  cause: { zh: string; en: string };
  solution: { zh: string; en: string };
  priority: number; // 数字越大优先级越高
}

const DIAGNOSES: DiagnosisRule[] = [
  // ===== 网络连接 / API 无法访问 =====
  {
    priority: 10,
    pattern: /(fetch\s+failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|net::ERR_|aborted)/i,
    cause: {
      zh: '无法连接到 AI API 服务器。网络不通、Base URL 填错或服务器宕机。',
      en: 'Cannot connect to the AI API server. Network issue, wrong Base URL, or server outage.',
    },
    solution: {
      zh: '检查网络连接；在设置→模型管理中核对 Base URL 是否正确（不要忘记 https:// 前缀）；检查是否需要配置代理。',
      en: 'Check your network connection; verify the Base URL in Settings → Model Manager (don\'t forget https://); check proxy settings if applicable.',
    },
  },
  // ===== 超时 =====
  {
    priority: 9,
    pattern: /(timeout|timed\s*out|请求超时)/i,
    cause: {
      zh: 'AI API 响应超时。可能是服务器负载过高或网络延迟较大。',
      en: 'AI API response timed out. Server may be overloaded or network latency is high.',
    },
    solution: {
      zh: '检查网络稳定性；如果使用免费/公共 API，其速度通常较慢，可考虑更换模型或提供商；可在模型配置中适当增大超时设置。',
      en: 'Check your network stability; free/public APIs are typically slower — consider switching models or providers.',
    },
  },
  // ===== 认证错误 =====
  {
    priority: 10,
    pattern: /(401|403|unauthorized|invalid\s+API\s*key|authentication\s+fail|auth\s+error|Incorrect\s+API\s+key)/i,
    cause: {
      zh: 'API Key 无效、已过期或权限不足。',
      en: 'Invalid, expired, or insufficient API key permissions.',
    },
    solution: {
      zh: '在设置→模型管理中选择对应的模型，检查 API Key 是否正确（注意不要有多余空格）；如果确认正确但仍报错，请到 API 提供商的管理后台检查 Key 状态和余额。',
      en: 'In Settings → Model Manager, check the API Key for the model (watch for extra spaces); if correct, verify the key\'s status and balance on the provider\'s dashboard.',
    },
  },
  // ===== 模型不存在 / 404 =====
  {
    priority: 9,
    pattern: /(404|model\s+not\s+found|does\s+not\s+exist|not\s+found|模型不存在)/i,
    cause: {
      zh: '指定的模型 ID 不存在或当前 API Key 无权访问该模型。',
      en: 'The specified model ID does not exist or your API key doesn\'t have access to it.',
    },
    solution: {
      zh: '在模型配置中核对模型 ID（如 gpt-4o、deepseek-chat 等）；使用「获取模型列表」按钮查看可用的模型；部分模型需要单独申请权限。',
      en: 'Verify the model ID in model settings (e.g., gpt-4o, deepseek-chat); use the "Fetch model list" button to see available models; some models require separate access approval.',
    },
  },
  // ===== 速率限制 =====
  {
    priority: 8,
    pattern: /(429|rate\s+limit|too\s+many\s+requests|请求过于频繁)/i,
    cause: {
      zh: '短期内请求量过大，触发了 API 提供商的速率限制。',
      en: 'Too many requests in a short period — hit the API provider\'s rate limit.',
    },
    solution: {
      zh: '稍等片刻后重试；在设置→群聊流式中降低并行度；如果频繁触发，可考虑更换更高额度的 API 套餐。',
      en: 'Wait a moment and retry; reduce parallel requests in Settings → Group Stream; consider upgrading your API plan if this happens frequently.',
    },
  },
  // ===== 上下文长度超限 =====
  {
    priority: 8,
    pattern: /(context\s+length|max\s+tokens|too\s+many\s+tokens|token\s+limit|maximum\s+context|上下文|token\s+exceed)/i,
    cause: {
      zh: '对话历史过长，超出了模型的上下文窗口限制。',
      en: 'Conversation history exceeds the model\'s context window limit.',
    },
    solution: {
      zh: '在模型配置中降低最大上下文长度；或开始一个新的对话；或换用上下文窗口更大的模型（如 gpt-4o-128k、deepseek-v3）。',
      en: 'Reduce the max context length in model settings; start a new conversation; or switch to a model with a larger context window (e.g., gpt-4o-128k, deepseek-v3).',
    },
  },
  // ===== 余额不足 / 配额耗尽 =====
  {
    priority: 9,
    pattern: /(insufficient.*(quota|balance|funds)|quota\s+exhausted|exceeded.*(quota|usage)|billing|insufficient_quota)/i,
    cause: {
      zh: 'API 账户余额不足或当月配额已用完。',
      en: 'API account balance is insufficient or monthly quota exhausted.',
    },
    solution: {
      zh: '登录 API 提供商的控制台充值或升级套餐；检查是否有免费额度可用。',
      en: 'Top up your account on the API provider\'s dashboard or upgrade your plan; check if free credits are available.',
    },
  },
  // ===== 流式中断 / 连接断开 =====
  {
    priority: 7,
    pattern: /(stream|chunk|socket|connection\s+reset|read\s+EOF|premature\s+close)/i,
    cause: {
      zh: '流式连接意外中断。网络不稳定或服务器端异常。',
      en: 'Stream connection interrupted unexpectedly. Unstable network or server-side issue.',
    },
    solution: {
      zh: '检查网络稳定性；尝试重新发送消息；如果持续出现，可临时关闭设置中的流式输出开关。',
      en: 'Check network stability; try resending the message; if it persists, temporarily disable streaming in Settings.',
    },
  },
  // ===== 语音转写 / TTS 失败 =====
  {
    priority: 7,
    pattern: /(transcribe|whisper|speech|audio|tts|语音|转写|合成)/i,
    cause: {
      zh: '语音识别（ASR）或语音合成（TTS）失败。模型配置语音相关字段可能不完整。',
      en: 'Speech recognition (ASR) or text-to-speech (TTS) failed. Voice-related model config may be incomplete.',
    },
    solution: {
      zh: '在设置→语音中确认已正确配置 ASR 与 TTS 专用 API（Base URL 与 API Key，分别调用 /audio/transcriptions 与 /audio/speech 端点）；检查 API 提供商是否支持语音功能。',
      en: 'In Settings → Voice, verify ASR and TTS dedicated APIs are configured correctly (Base URL and API Key, calling /audio/transcriptions and /audio/speech endpoints respectively); check if the provider supports voice features.',
    },
  },
  // ===== 图片处理失败 =====
  {
    priority: 6,
    pattern: /(图片|image|save\s+image|复制图片)/i,
    cause: {
      zh: '图片保存或处理失败。磁盘空间不足或文件路径异常。',
      en: 'Image save or processing failed. Insufficient disk space or abnormal file path.',
    },
    solution: {
      zh: '检查磁盘剩余空间；尝试选择较小尺寸的图片；重启应用后重试。',
      en: 'Check available disk space; try a smaller image; restart the app and retry.',
    },
  },
  // ===== 文件读写失败 =====
  {
    priority: 6,
    pattern: /(读取.*失败|保存.*失败|read\s+file|write\s+file|file\s+not\s+found|ENOENT|EACCES|EPERM)/i,
    cause: {
      zh: '文件系统操作失败。权限不足、文件被占用或路径异常。',
      en: 'File system operation failed. Insufficient permissions, file in use, or invalid path.',
    },
    solution: {
      zh: '检查文件权限和所在目录是否可写；确保文件未被其他程序锁定；重启应用后重试。',
      en: 'Check file permissions and that the target directory is writable; ensure the file isn\'t locked by another program; restart the app and retry.',
    },
  },
  // ===== 备份 / 还原失败 =====
  {
    priority: 6,
    pattern: /(backup|restore|zip|备份|还原)/i,
    cause: {
      zh: '备份创建或还原操作失败。磁盘空间不足或数据文件损坏。',
      en: 'Backup creation or restore operation failed. Insufficient disk space or corrupted data file.',
    },
    solution: {
      zh: '检查磁盘剩余空间；检查目标目录是否可写；如果还原失败，应用会保留旧数据，可重试或手动从备份目录恢复。',
      en: 'Check available disk space; verify the target directory is writable; if restore fails, old data is preserved — retry or manually restore from the backup directory.',
    },
  },
  // ===== 模型配置失效 =====
  {
    priority: 7,
    pattern: /(绑定模型已失效|model\s+config\s+not\s+found|未配置|未找到.*模型|未设置.*默认模型|no.*model.*config)/i,
    cause: {
      zh: '角色绑定的模型配置已被删除或失效，或没有配置默认模型。',
      en: 'The model bound to the character has been deleted or no default model is configured.',
    },
    solution: {
      zh: '在通讯录中编辑角色，重新选择一个有效的模型；或在设置中指定默认模型。',
      en: 'Edit the character in Contacts, re-select a valid model; or set a default model in Settings.',
    },
  },
  // ===== 随机事件失败 =====
  {
    priority: 5,
    pattern: /(随机事件|random\s+event|RANDOM_EVENT_BUSY)/i,
    cause: {
      zh: '随机事件生成失败。可能原因是未配置默认模型、或正在生成其他事件。',
      en: 'Random event generation failed. No default model configured, or another event is already being generated.',
    },
    solution: {
      zh: '请确保已在设置中配置默认模型；一个聊天同时只能生成一个事件，请等待当前事件完成再试。',
      en: 'Ensure a default model is configured in Settings; only one event can be generated per chat at a time — wait for the current one to finish.',
    },
  },
  // ===== 角色操作失败 =====
  {
    priority: 5,
    pattern: /(角色不存在|role\s+not\s+found|未找到.*角色)/i,
    cause: {
      zh: '引用的角色不存在。可能角色已被删除但聊天记录仍在引用。',
      en: 'The referenced character does not exist. It may have been deleted while conversations still reference it.',
    },
    solution: {
      zh: '刷新角色列表；如果确认角色已删除，可以删除对应的聊天记录重新开始对话。',
      en: 'Refresh the character list; if the character has been deleted, you can delete the old conversation and start a new one.',
    },
  },
  // ===== 内存提炼失败（静默，给兜底信息） =====
  {
    priority: 4,
    pattern: /(记忆|memory.*extract|memories)/i,
    cause: {
      zh: 'AI 自动提炼记忆失败。通常由于模型返回格式异常。',
      en: 'AI auto memory extraction failed. Usually due to an unexpected response format from the model.',
    },
    solution: {
      zh: '稍后重试；可在资源库→记忆中手动添加需要记住的内容。',
      en: 'Retry later; you can manually add important content in Library → Memory.',
    },
  },
  // ===== 未知类型错误（兜底） =====
  {
    priority: 1,
    pattern: /./s, // 匹配任何内容
    cause: {
      zh: '发生了预期之外的错误。',
      en: 'An unexpected error occurred.',
    },
    solution: {
      zh: '尝试重启应用；如果问题持续，请在设置中导出备份后重新安装，或将日志提供给开发者排查。',
      en: 'Try restarting the app; if the issue persists, export a backup in Settings, reinstall, or provide logs to the developer.',
    },
  },
];

export function diagnoseError(error: Error | string): DiagnosisResult {
  const message = typeof error === 'string' ? error : error.message || String(error);

  // 按优先级从高到低排序，取第一个匹配非兜底结果
  const sorted = [...DIAGNOSES].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    if (rule.pattern.test(message)) {
      return {
        matched: rule.priority > 1, // 只有兜底规则 priority===1
        cause: rule.cause,
        solution: rule.solution,
      };
    }
  }

  // fallback (shouldn't reach with the catch-all pattern)
  return {
    matched: false,
    cause: {
      zh: '发生了预期之外的错误。',
      en: 'An unexpected error occurred.',
    },
    solution: {
      zh: '尝试重启应用；如果问题持续，请导出备份后重新安装。',
      en: 'Try restarting the app; if the issue persists, export a backup and reinstall.',
    },
  };
}

export function getDiagnosisText(
  diagnosis: DiagnosisResult,
  lang: 'zh' | 'en'
): string {
  return `${diagnosis.cause[lang]}\n\n${diagnosis.solution[lang]}`;
}
