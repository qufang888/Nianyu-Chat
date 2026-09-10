// MCP（Model Context Protocol）客户端管理器（v2.3.17 新增独立模块）
// 职责：管理 MCP 服务器连接（stdio 传输）、汇总工具列表（OpenAI function calling 格式）、
//      执行工具调用。只读 MCP、不改现有聊天表结构；工具仅注入 supportsTools 模型的非流式请求。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AppSettings } from '../src/types';

export interface McpServerConfig {
  command: string; // 可执行命令（如 npx / node / uvx）
  args?: string[]; // 命令参数
  env?: Record<string, string>; // 额外环境变量
  enabled?: boolean; // 是否启用（默认 true）
}
export interface McpToolInfo {
  server: string; // 服务器 key
  name: string; // 工具原名
  fullName: string; // OpenAI function 名：mcp__<server>__<tool>
  description?: string;
  inputSchema: unknown; // JSON Schema
}
interface McpConn {
  client: Client;
  transport: StdioClientTransport;
  configJson: string; // 连接时的配置指纹（配置变更后强制重连）
  status: 'connected' | 'error';
  error?: string;
  tools: McpToolInfo[];
}

const conns = new Map<string, McpConn>();
const CONNECT_TIMEOUT_MS = 15_000; // 连接超时
const CALL_TIMEOUT_MS = 60_000; // 工具调用超时
const MAX_SERVERS = 10; // 服务器数量上限

export function getMcpServers(s: AppSettings): Record<string, McpServerConfig> {
  return (s as any).mcpServers || {};
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function ensureConnected(key: string, cfg: McpServerConfig): Promise<McpConn> {
  const configJson = JSON.stringify(cfg);
  const existing = conns.get(key);
  if (existing && existing.status === 'connected' && existing.configJson === configJson) return existing;
  // 配置变更或连接失效：先断开旧连接
  if (existing) {
    try {
      await existing.transport.close?.();
    } catch {
      /* ignore */
    }
    conns.delete(key);
  }
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args || [],
    env: { ...(process.env as Record<string, string>), ...(cfg.env || {}) } as Record<string, string>,
  });
  const client = new Client({ name: 'nianyu-client', version: '1.0.0' });
  const conn: McpConn = { client, transport, configJson, status: 'error', tools: [] };
  conns.set(key, conn);
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP 连接超时（${key}）`);
  const toolsRes = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP 工具列表获取失败（${key}）`);
  conn.tools = (toolsRes.tools || []).map((t: any) => ({
    server: key,
    name: t.name,
    fullName: `mcp__${sanitizeKey(key)}__${sanitizeKey(t.name)}`,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  conn.status = 'connected';
  conn.error = undefined;
  return conn;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

// 汇总所有已启用服务器的工具（OpenAI tools 格式；单个服务器连接失败不阻塞其它）
export async function collectMcpTools(s: AppSettings): Promise<McpToolInfo[]> {
  const servers = getMcpServers(s);
  const out: McpToolInfo[] = [];
  for (const [key, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    try {
      const conn = await ensureConnected(key, cfg);
      out.push(...conn.tools);
    } catch (e: any) {
      const conn = conns.get(key);
      if (conn) {
        conn.status = 'error';
        conn.error = e?.message || String(e);
      }
    }
  }
  return out;
}

// 按 fullName 执行工具调用，返回拼接文本（供 tool 消息使用）
export async function callMcpToolByFullName(s: AppSettings, fullName: string, argsJson: string): Promise<string> {
  const servers = getMcpServers(s);
  for (const [key, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    const conn = conns.get(key);
    const tool = conn?.tools.find((t) => t.fullName === fullName);
    if (!tool) continue;
    let args: any = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return `参数解析失败：非合法 JSON`;
    }
    const callRes = (await withTimeout(conn!.client.callTool({ name: tool.name, arguments: args }), CALL_TIMEOUT_MS, `工具调用超时（${fullName}）`)) as any;
    const parts: any[] = Array.isArray(callRes?.content) ? callRes.content : [];
    const text = parts
      .map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
      .filter(Boolean)
      .join('\n');
    if (callRes?.isError) return `工具返回错误：${text || 'unknown'}`;
    return text || '（工具执行完成，无文本输出）';
  }
  throw new Error(`未找到 MCP 工具：${fullName}`);
}

// 设置页状态查询
export async function mcpStatus(s: AppSettings): Promise<
  { key: string; command: string; enabled: boolean; status: string; error?: string; tools: { name: string; description?: string }[] }[]
> {
  const servers = getMcpServers(s);
  const out: any[] = [];
  for (const [key, cfg] of Object.entries(servers)) {
    let conn = conns.get(key);
    if (cfg.enabled !== false) {
      try {
        conn = await ensureConnected(key, cfg);
      } catch (e: any) {
        conn = conn || ({ status: 'error', tools: [] } as any);
        (conn as any).status = 'error';
        (conn as any).error = e?.message || String(e);
      }
    }
    out.push({
      key,
      command: `${cfg.command} ${(cfg.args || []).join(' ')}`.trim(),
      enabled: cfg.enabled !== false,
      status: cfg.enabled === false ? 'disabled' : conn?.status || 'idle',
      error: conn?.error,
      tools: (conn?.tools || []).map((t) => ({ name: t.name, description: t.description })),
    });
  }
  return out;
}

export function disconnectAll(): void {
  for (const [key, conn] of conns) {
    try {
      void conn.transport.close?.();
    } catch {
      /* ignore */
    }
    conns.delete(key);
  }
}
export const MCP_MAX_SERVERS = MAX_SERVERS;
