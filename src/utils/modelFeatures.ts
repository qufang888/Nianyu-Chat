// 模型能力探测（纯函数，主进程与渲染进程均可安全引用，无 node 依赖）

// 自动探测模型是否支持深度思考：按名称/ID 关键字判定（覆盖主流推理模型）
export function modelSupportsDeepThink(modelId: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return /(o1|o3|o4|o4-mini|o1-mini|deepseek-reasoner|deepseek-r1|qwq|qwen.*thinking|reasoner|claude-3-7|claude-3-7-sonnet|grok-4|grok-3|glm-z1|r1|thinking)/.test(id);
}
