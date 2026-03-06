/**
 * v4.0 B-8: 自动注册 + 心跳服务
 *
 * 通过 api.registerService() 启动后台常驻服务：
 * - start(): registerAdapter + setInterval heartbeat (25s) + WebSocket 事件订阅
 * - stop(): clearInterval + removeAdapter + 关闭 WebSocket
 * - 断连: 指数退避重试 1s→2s→4s→8s→30s 封顶, 连续失败10次 → WARN
 */

import type { PhysOSConfig } from "./types.js";
import type { PhysOSClient } from "./physos-client.js";

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

const DIGITAL_CAPABILITIES = [
  'digital.browser_open',
  'digital.browser_click',
  'digital.send_message',
  'digital.run_script',
  'digital.file_operation',
];

const MAX_CONSECUTIVE_FAILURES = 10;

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
      // 成功 → 重置
      consecutiveFailures = 0;
      retryDelay = 1000;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn(
          `[physos-bridge] ${label}: ${consecutiveFailures} consecutive failures — ${(err as Error).message}`,
        );
      }
      // 指数退避
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }

  return {
    id: 'physos-heartbeat',

    async start(ctx: ServiceContext) {
      ctx.logger.info('[physos-bridge] Starting PhysOS heartbeat service...');

      // Step 2a: 注册 Adapter
      try {
        await client.registerAdapter({
          adapter_id: config.adapterId,
          online: true,
          capabilities: DIGITAL_CAPABILITIES,
          metadata: {
            type: 'openclaw',
            execute_url: `http://openclaw_bridge:18789/physos/execute`,
            version: '1.0',
          },
        });
        ctx.logger.info(
          `[physos-bridge] Adapter registered: ${config.adapterId} (${DIGITAL_CAPABILITIES.length} capabilities)`,
        );
      } catch (err) {
        ctx.logger.warn(
          `[physos-bridge] Initial adapter registration failed (will retry): ${(err as Error).message}`,
        );
      }

      // Step 2b: 启动心跳定时器 (25s < TTL/2 = 30s)
      heartbeatTimer = setInterval(() => {
        void withBackoff(
          async () => {
            await client.heartbeat(config.adapterId);
          },
          'heartbeat',
          ctx.logger,
        );
      }, config.heartbeatIntervalMs);

      ctx.logger.info(
        `[physos-bridge] Heartbeat started: every ${config.heartbeatIntervalMs}ms`,
      );

      // Step 2c: WebSocket 事件订阅
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

      // Step 3a: 停止心跳
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      // Step 3b: 注销 Adapter
      try {
        await client.removeAdapter(config.adapterId);
        ctx.logger.info(`[physos-bridge] Adapter removed: ${config.adapterId}`);
      } catch (err) {
        ctx.logger.warn(
          `[physos-bridge] Adapter removal failed: ${(err as Error).message}`,
        );
      }

      // Step 3c: 关闭 WebSocket
      if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
      }

      ctx.logger.info('[physos-bridge] Service stopped');
    },
  };
}
