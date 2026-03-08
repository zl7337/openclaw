/**
 * v4.0 B-3 → v5.0 → v6.0: Adapter 执行回调端点（三轨执行）
 *
 * 在 OpenClaw Gateway HTTP 服务器上注册 /physos/execute 端点。
 * physos-core 的 HttpAdapterExecutor 签发 Permit 后回调此端点。
 *
 * v6.0 三轨执行:
 * - 直接通道: 确定性 macOS 操作 (terminal, script) → 直接 execSync
 * - 快速通道: 已知可用 tool (browser, message) → 直接 /tools/invoke
 * - 智能通道: 所有其他动作 → AI agent 自主选择工具执行
 *
 * 逻辑流程:
 *   收到 PhysOS action
 *     → tryDirectExec() 尝试直接执行
 *     → 如果成功 → 返回结果
 *     → resolveActionToTool() 尝试映射
 *     → 如果映射到已知可用 tool → 走 executeTool() 快速路径
 *     → 否则 → 走 agentClient.executeViaAgent() 智能路径
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PhysOSConfig,
  AdapterActionRequest,
  AdapterActionResult,
  AdapterExecutionMeta,
} from "./types.js";
import type { GatewayAgentClient } from "./gateway-agent-client.js";

// ────────────────────────────────────────────
// 快速通道: 已知可用 tool 列表
// ────────────────────────────────────────────

/**
 * 这些 tool 已通过之前的探测验证可用于 /tools/invoke 快速路径。
 * 其他 tool (exec, write 等) 在 plugin API 层不可用，
 * 必须通过 AI agent 智能通道执行。
 */
const FAST_PATH_TOOLS = new Set(['browser', 'message']);

// ────────────────────────────────────────────
// 通用 Action → Tool 解析器
// ────────────────────────────────────────────

interface ToolMapping {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 将 PhysOS action 解析为 OpenClaw tool 调用。
 *
 * 规则：
 * 1. 已知 digital.* 动作 → 精确映射
 * 2. 通知动作 → message tool
 * 3. 其他动作 → 返回 null（交给智能通道）
 */
function resolveActionToTool(
  action: string,
  params?: Record<string, unknown>,
): ToolMapping | null {
  // ── 精确映射区（高频 digital 动作）──
  switch (action) {
    case 'digital.browser_open':
      return { tool: 'browser', args: { action: 'navigate', url: params?.url || 'about:blank' } };
    case 'digital.browser_click':
      return { tool: 'browser', args: { action: 'click', selector: params?.selector ?? '' } };
    case 'digital.send_message':
      return { tool: 'message', args: { action: 'send', to: params?.to ?? '', text: params?.body ?? params?.text ?? '' } };
    case 'notification.send':
      return { tool: 'message', args: { action: 'notify', to: params?.to ?? 'user', text: params?.message ?? params?.body ?? '' } };
  }

  // ── 域前缀解析区 ──
  const [domain] = action.split('.', 2);

  // digital 域未精确匹配的动作 → 不尝试 tool 映射，交给 AI agent
  if (domain === 'digital' || domain === 'notification') {
    return null;
  }

  // 物理域动作 → 交给 AI agent
  return null;
}

// ────────────────────────────────────────────
// 直接通道: 确定性 macOS 系统操作
// ────────────────────────────────────────────

/**
 * 对于确定性的 macOS 操作，直接调用系统命令（osascript/execSync），
 * 不依赖 AI agent 的不稳定行为。
 *
 * 返回 null 表示此 action 不在直接通道处理范围。
 */
function tryDirectExec(
  action: string,
  params?: Record<string, unknown>,
  userIntent?: string,
  logger?: { info: (msg: string) => void },
): { success: boolean; output: string } | null {
  switch (action) {
    case 'digital.open_terminal_and_type': {
      // 提取要执行的命令/文本
      // 优先级: params.command > params.text > 中文引号内容 > 关键词后内容（兼容兜底）
      let text = String(params?.command ?? params?.text ?? params?.content ?? '');
      if (!text && userIntent) {
        // 兼容兜底: 从 userIntent 自然语言中解析
        // 1. 优先匹配中文引号（用户明确指定的内容，如 "你好"）
        const cnMatch = userIntent.match(/[\u201c\u300c\u300e](.+?)[\u201d\u300d\u300f]/);
        if (cnMatch) {
          text = cnMatch[1];
        } else {
          // 2. 匹配 "命令：xxx" / "执行命令 xxx" / "输入 xxx" 等关键词后的完整内容
          const cmdMatch = userIntent.match(/(?:执行命令|输入并执行命令|输入并执行|命令|输入|执行)[：:\s]\s*(.+)$/);
          if (cmdMatch) {
            text = cmdMatch[1].trim();
          }
        }
      }

      // 参数校验: 没有命令内容时返回明确错误，不静默退化
      if (!text) {
        logger?.info(`[direct-exec] ${action}: REJECTED — no command found in params or userIntent`);
        return {
          success: false,
          output: 'No command/text provided. Set params.command in the intent, e.g. { command: "echo hello" }',
        };
      }

      try {
        // 转义 AppleScript 中的特殊字符
        const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const cmd = `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${escaped}"'`;

        logger?.info(`[direct-exec] ${action}: ${cmd}`);
        const result = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
        return { success: true, output: result.trim() || 'Terminal opened and command executed' };
      } catch (e) {
        return { success: false, output: (e as Error).message };
      }
    }

    case 'digital.run_script': {
      const script = String(params?.script ?? params?.command ?? '');
      if (!script) return { success: false, output: 'No script/command provided in params' };

      try {
        logger?.info(`[direct-exec] ${action}: ${script.slice(0, 120)}`);
        const result = execSync(script, { encoding: 'utf-8', timeout: 30000 });
        return { success: true, output: result.trim() };
      } catch (e) {
        const err = e as { stderr?: string; message: string };
        return { success: false, output: err.stderr || err.message };
      }
    }

    default:
      return null;
  }
}

// ────────────────────────────────────────────
// Execution
// ────────────────────────────────────────────

// 60s — AI agent 意图驱动执行需要更多时间（LLM推理 + 工具调用）
const EXECUTION_TIMEOUT_MS = 55_000;

/**
 * 创建 /physos/execute HTTP 路由（双轨执行版）
 *
 * @param getAgentClient — 获取 AI agent WebSocket 客户端的延迟函数
 *   因为 agent client 在 service.start() 中异步初始化，
 *   register() 时还不可用，所以使用 getter 模式。
 */
export function createAdapterServer(
  api: OpenClawPluginApi,
  config: PhysOSConfig,
  getAgentClient?: () => GatewayAgentClient | null,
): { path: string; auth: 'gateway' | 'plugin'; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } {
  return {
    path: '/physos/execute',
    auth: 'plugin',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const startTime = Date.now();
      const agentClient = getAgentClient?.() ?? null;

      // 读取请求体
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      let request: AdapterActionRequest;
      let userIntent: string | undefined;
      try {
        const raw = JSON.parse(body) as Record<string, unknown>;

        // 兼容两种请求格式:
        //  1) 直接格式: { action, params, trace_id, target_id }
        //  2) 路由器格式: { adapter_id, action_intent: { action, params, target, metadata, ... }, permit }
        if (raw.action_intent && typeof raw.action_intent === 'object') {
          const ai = raw.action_intent as Record<string, unknown>;
          request = {
            action: String(ai.action ?? ''),
            params: (ai.params as Record<string, unknown>) ?? undefined,
            trace_id: String(ai.trace_id ?? raw.trace_id ?? ''),
            target_id: typeof (ai.target as Record<string, unknown>)?.id === 'string'
              ? (ai.target as Record<string, unknown>).id as string
              : undefined,
          };
          // 从 metadata.user_intent 提取用户原始意图描述
          const metadata = ai.metadata as Record<string, unknown> | undefined;
          if (metadata?.user_intent && typeof metadata.user_intent === 'string') {
            userIntent = metadata.user_intent;
          }
        } else {
          request = raw as unknown as AdapterActionRequest;
        }
      } catch {
        sendJson(res, 400, {
          ok: false,
          code: 'INVALID_REQUEST',
          action: 'unknown',
          reason: 'Invalid JSON request body',
        });
        return;
      }

      const { action, params, trace_id } = request;

      // ── 三轨路由决策 ──

      // ▸ 直接通道: 确定性 macOS 操作 (terminal, script 等)
      const directResult = tryDirectExec(action, params, userIntent, {
        info: (msg: string) => api.log?.info?.(`[physos-adapter] ${msg}`) ?? console.log(msg),
      });
      if (directResult !== null) {
        const meta: AdapterExecutionMeta = {
          adapter_id: config.adapterId,
          execution_path: 'adapter',
          timestamp: new Date().toISOString(),
          latency_ms: Date.now() - startTime,
        };
        sendJson(res, 200, {
          ok: directResult.success,
          success: directResult.success,
          code: directResult.success ? 'executed' : 'EXECUTION_ERROR',
          action,
          execution_channel: 'direct_exec',
          state: { output: directResult.output },
          meta,
        });
        return;
      }

      // ▸ 快速通道 / 智能通道
      const mapping = resolveActionToTool(action, params);
      const useFastPath = mapping !== null && FAST_PATH_TOOLS.has(mapping.tool);

      if (useFastPath && mapping) {
        // ════════════════════════════════════════
        // 快速通道: 直接调用已知可用 tool
        // ════════════════════════════════════════
        try {
          const execPromise = executeTool(api, mapping.tool, mapping.args);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), EXECUTION_TIMEOUT_MS),
          );

          const toolResult = await Promise.race([execPromise, timeoutPromise]);

          const meta: AdapterExecutionMeta = {
            adapter_id: config.adapterId,
            execution_path: 'adapter',
            timestamp: new Date().toISOString(),
            latency_ms: Date.now() - startTime,
          };

          sendJson(res, 200, {
            ok: true,
            success: true,
            code: 'executed',
            action,
            execution_channel: 'fast_path',
            tool_used: mapping.tool,
            state: typeof toolResult === 'object' ? (toolResult as Record<string, unknown>) : { output: toolResult },
            meta,
          });
        } catch (err) {
          const error = err as Error;
          // 快速通道失败 → 尝试降级到智能通道
          if (agentClient?.connected) {
            await executeViaSmartPath(res, agentClient, action, params, trace_id, config, startTime, `fast_path_fallback(${error.message})`, userIntent);
          } else {
            sendJson(res, 200, {
              ok: false,
              success: false,
              code: error.message === 'TIMEOUT' ? 'TIMEOUT' : 'EXECUTION_ERROR',
              action,
              execution_channel: 'fast_path',
              reason: error.message,
            });
          }
        }
      } else if (agentClient?.connected) {
        // ════════════════════════════════════════
        // 智能通道: AI agent 自主执行
        // ════════════════════════════════════════
        await executeViaSmartPath(res, agentClient, action, params, trace_id, config, startTime, 'smart_path', userIntent);
      } else {
        // ════════════════════════════════════════
        // 降级: 既无快速通道映射，agent 也不可用
        // ════════════════════════════════════════
        sendJson(res, 200, {
          ok: false,
          success: false,
          code: 'NO_EXECUTION_PATH',
          action,
          reason: `No fast-path tool mapping for '${action}' and AI agent client is not connected`,
        });
      }
    },
  };
}

/**
 * 智能通道执行: 通过 AI agent WebSocket 执行任意动作
 */
async function executeViaSmartPath(
  res: ServerResponse,
  agentClient: GatewayAgentClient,
  action: string,
  params: Record<string, unknown> | undefined,
  traceId: string | undefined,
  config: PhysOSConfig,
  startTime: number,
  channel: string,
  userIntent?: string,
): Promise<void> {
  try {
    const agentResult = await agentClient.executeViaAgent({
      action,
      actionParams: params,
      userIntent,
      traceId: traceId || `auto-${Date.now()}`,
      timeoutMs: EXECUTION_TIMEOUT_MS,
    });

    const meta: AdapterExecutionMeta = {
      adapter_id: config.adapterId,
      execution_path: 'adapter',
      timestamp: new Date().toISOString(),
      latency_ms: Date.now() - startTime,
    };

    sendJson(res, 200, {
      ok: agentResult.success,
      success: agentResult.success,
      code: agentResult.success ? 'executed' : 'AGENT_ERROR',
      action,
      execution_channel: channel,
      state: typeof agentResult.result === 'object'
        ? (agentResult.result as Record<string, unknown>)
        : { output: agentResult.result },
      reason: agentResult.error,
      meta,
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      success: false,
      code: 'AGENT_ERROR',
      action,
      execution_channel: channel,
      reason: (err as Error).message,
    });
  }
}

/**
 * 通过 OpenClaw Gateway HTTP /tools/invoke 端点执行工具。
 * 插件不能直接访问工具注册表，必须走 Gateway 的 HTTP 接口，
 * 这样工具策略和安全过滤才会正确生效。
 */
async function executeTool(
  _api: OpenClawPluginApi,
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (gatewayToken) {
    headers['Authorization'] = `Bearer ${gatewayToken}`;
  }

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tool: toolName,
      args: params,
    }),
  });

  if (!response.ok) {
    let errMsg: string;
    try {
      const errBody = await response.json() as Record<string, unknown>;
      errMsg = String((errBody.error as Record<string, unknown>)?.message ?? response.statusText);
    } catch {
      errMsg = response.statusText;
    }
    throw new Error(`Tool '${toolName}' execution failed: ${errMsg}`);
  }

  const result = await response.json() as { ok: boolean; result?: unknown; error?: { message?: string } };
  if (!result.ok) {
    throw new Error(`Tool '${toolName}' failed: ${result.error?.message ?? 'unknown error'}`);
  }

  return result.result;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
