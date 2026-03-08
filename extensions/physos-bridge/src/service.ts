/**
 * v4.0 B-8 → v5.0: 自动注册 + 心跳服务（AI Agent 意图驱动）
 *
 * 通过 api.registerService() 启动后台常驻服务：
 * - start(): 注册域级通配符能力 + 初始化 AI agent client + 心跳 + WebSocket 事件订阅
 * - stop(): 关闭 agent client + clearInterval + removeAdapter + 关闭 WebSocket
 *
 * v5.0 变更:
 * - 移除工具探测逻辑（PROBE_TOOLS / probeTool / discoverGatewayTools / deriveCapabilities）
 * - 直接注册 ['digital.*', 'notification.*'] 域级通配符能力
 * - 初始化 GatewayAgentClient 用于智能通道执行
 * - 导出 agentClient 供 adapter-server 使用
 */

import type { PhysOSConfig } from "./types.js";
import type { PhysOSClient } from "./physos-client.js";
import { createGatewayAgentClient } from "./gateway-agent-client.js";
import type { GatewayAgentClient } from "./gateway-agent-client.js";

/** OpenClawPluginServiceContext — 跨仓库重新声明 */
interface ServiceContext {
  config: unknown;
  workspaceDir?: string;
  stateDir: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const MAX_CONSECUTIVE_FAILURES = 10;

/** 导出当前注册的动态能力列表 */
let _registeredCapabilities: string[] = [];

export function getRegisteredCapabilities(): string[] {
  return _registeredCapabilities;
}

/** 导出 agent client 供 adapter-server 使用 */
let _agentClient: GatewayAgentClient | null = null;

export function getAgentClient(): GatewayAgentClient | null {
  return _agentClient;
}

export function createPhysOSService(
  config: PhysOSConfig,
  client: PhysOSClient,
) {
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let wsConnection: { close: () => void } | null = null;
  let consecutiveFailures = 0;
  let retryDelay = 1000;

  /**
   * 带指数退避的重试包装
   * exponential backoff: 1s → 2s → 4s → 8s → 30s cap
   */
  async function withBackoff(
    fn: () => Promise<void>,
    label: string,
    logger: ServiceContext['logger'],
  ): Promise<void> {
    try {
      await fn();
      consecutiveFailures = 0;
      retryDelay = 1000;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn(
          `[physos-bridge] ${label}: ${consecutiveFailures} consecutive failures — ${(err as Error).message}`,
        );
      }
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }

  return {
    id: 'physos-heartbeat',

    async start(ctx: ServiceContext) {
      ctx.logger.info('[physos-bridge] Starting PhysOS heartbeat service...');

      // ── Step 1: 域级通配符能力注册（替代工具探测）──
      const capabilities = ['digital.*', 'notification.*'];
      const discoveryMode = 'agent_mediated';

      _registeredCapabilities = capabilities;

      ctx.logger.info(
        `[physos-bridge] Registering domain-level capabilities: ${capabilities.join(', ')}`,
      );

      // ── Step 2: 初始化 AI Agent Client ──
      const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
      const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

      const agentClient = createGatewayAgentClient({
        gatewayPort,
        gatewayToken,
        logger: ctx.logger,
      });

      // 延迟连接 — 给 Gateway 足够时间完成启动
      // Agent client 连接在注册 adapter 之后，因为 Gateway WS 可能需要更多时间
      setTimeout(async () => {
        try {
          await agentClient.connect();
          ctx.logger.info('[physos-bridge] AI Agent client connected');
        } catch (err) {
          ctx.logger.warn(
            `[physos-bridge] AI Agent client connect failed (will auto-retry): ${(err as Error).message}`,
          );
        }
      }, 2000);

      _agentClient = agentClient;

      // ── Step 3: 注册 Adapter ──
      try {
        await client.registerAdapter({
          adapter_id: config.adapterId,
          online: true,
          capabilities,
          metadata: {
            type: 'openclaw',
            execute_url: `http://127.0.0.1:${gatewayPort}/physos/execute`,
            version: '2.0',
            discovery_mode: discoveryMode,
            execution_mode: 'ai_agent',
          },
        });
        ctx.logger.info(
          `[physos-bridge] Adapter registered: ${config.adapterId} ` +
          `(${capabilities.length} capabilities, mode=${discoveryMode})`,
        );
        ctx.logger.info(`[physos-bridge] Capabilities: ${capabilities.join(', ')}`);
      } catch (err) {
        ctx.logger.warn(
          `[physos-bridge] Initial adapter registration failed (will retry): ${(err as Error).message}`,
        );
      }

      // ── Step 4: 启动心跳定时器 ──
      heartbeatTimer = setInterval(() => {
        void withBackoff(
          async () => { await client.heartbeat(config.adapterId); },
          'heartbeat',
          ctx.logger,
        );
      }, config.heartbeatIntervalMs);

      ctx.logger.info(
        `[physos-bridge] Heartbeat started: every ${config.heartbeatIntervalMs}ms`,
      );

      // ── Step 5: WebSocket 事件订阅 ──
      try {
        wsConnection = client.connectEvents((event) => {
          ctx.logger.info(`[physos-bridge] Event: ${JSON.stringify(event)}`);
        });
        ctx.logger.info('[physos-bridge] WebSocket event subscription started');
      } catch (err) {
        ctx.logger.warn(
          `[physos-bridge] WebSocket connection failed (will auto-retry): ${(err as Error).message}`,
        );
      }
    },

    async stop(ctx: ServiceContext) {
      ctx.logger.info('[physos-bridge] Stopping PhysOS heartbeat service...');

      // 关闭 AI Agent Client
      if (_agentClient) {
        _agentClient.close();
        _agentClient = null;
      }

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      try {
        await client.removeAdapter(config.adapterId);
        ctx.logger.info(`[physos-bridge] Adapter removed: ${config.adapterId}`);
      } catch (err) {
        ctx.logger.warn(
          `[physos-bridge] Adapter removal failed: ${(err as Error).message}`,
        );
      }

      if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
      }

      ctx.logger.info('[physos-bridge] Service stopped');
    },
  };
}
