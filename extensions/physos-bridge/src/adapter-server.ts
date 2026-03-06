/**
 * v4.0 B-3: Adapter 执行回调端点
 *
 * 在 OpenClaw Gateway HTTP 服务器上注册 /physos/execute 端点。
 * physos-core 的 HttpAdapterExecutor 签发 Permit 后回调此端点。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PhysOSConfig,
  AdapterActionRequest,
  AdapterActionResult,
  AdapterExecutionMeta,
} from "./types.js";

/** Action → OpenClaw Tool 映射表 */
const ACTION_TOOL_MAP: Record<string, { tool: string; paramMap: (params?: Record<string, unknown>) => Record<string, unknown> }> = {
  'digital.browser_open': {
    tool: 'browserNavigate',
    paramMap: (p) => ({ url: p?.url ?? '' }),
  },
  'digital.browser_click': {
    tool: 'browserAct',
    paramMap: (p) => ({ action: p?.selector ?? '' }),
  },
  'digital.send_message': {
    tool: 'message_send',
    paramMap: (p) => ({ recipient: p?.to ?? '', message: p?.body ?? '' }),
  },
  'digital.run_script': {
    tool: 'exec',
    paramMap: (p) => ({ command: p?.script ?? '' }),
  },
  'digital.file_operation': {
    tool: 'write_file',
    paramMap: (p) => ({ file_path: p?.path ?? '', content: p?.content ?? '' }),
  },
};

const EXECUTION_TIMEOUT_MS = 30_000;

/**
 * 创建 /physos/execute HTTP 路由
 */
export function createAdapterServer(
  api: OpenClawPluginApi,
  config: PhysOSConfig,
): { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } {
  return {
    path: '/physos/execute',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const startTime = Date.now();

      // 读取请求体
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      let request: AdapterActionRequest;
      try {
        request = JSON.parse(body) as AdapterActionRequest;
      } catch {
        sendJson(res, 400, {
          ok: false,
          code: 'INVALID_REQUEST',
          action: 'unknown',
          reason: 'Invalid JSON request body',
        });
        return;
      }

      const { action, params, trace_id, target_id } = request;

      // 查找映射
      const mapping = ACTION_TOOL_MAP[action];
      if (!mapping) {
        const result: AdapterActionResult = {
          ok: false,
          code: 'UNKNOWN_ACTION',
          action,
          reason: `unmapped action: ${action}`,
        };
        sendJson(res, 200, result);
        return;
      }

      // 执行 OpenClaw tool（带超时）
      try {
        const toolParams = mapping.paramMap(params);
        const execPromise = executeTool(api, mapping.tool, toolParams);
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

        const result: AdapterActionResult = {
          ok: true,
          code: 'executed',
          action,
          state: typeof toolResult === 'object' ? (toolResult as Record<string, unknown>) : { output: toolResult },
          meta,
        };

        sendJson(res, 200, result);
      } catch (err) {
        const error = err as Error;
        if (error.message === 'TIMEOUT') {
          const result: AdapterActionResult = {
            ok: false,
            code: 'TIMEOUT',
            action,
            reason: 'execution timeout',
          };
          sendJson(res, 200, result);
        } else {
          const result: AdapterActionResult = {
            ok: false,
            code: 'EXECUTION_ERROR',
            action,
            reason: error.message,
          };
          sendJson(res, 200, result);
        }
      }
    },
  };
}

/**
 * 通过 OpenClaw runtime 执行工具
 */
async function executeTool(
  api: OpenClawPluginApi,
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  // 使用 OpenClaw runtime 的工具调用接口
  // runtime.tools 提供对已注册工具的访问
  const tools = api.runtime.tools;
  if (!tools) {
    throw new Error(`OpenClaw runtime tools not available`);
  }

  // 查找工具
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool '${toolName}' not found in OpenClaw runtime`);
  }

  // 执行工具
  const result = await tool.execute(`physos-exec-${Date.now()}`, params);
  return result;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
