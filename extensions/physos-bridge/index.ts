/**
 * v4.0 B-1: PhysOS Bridge Extension Entry Point
 *
 * OpenClaw ↔ PhysOS 双向桥接插件
 * - B-3: registerHttpRoute(/physos/execute) — Adapter 执行回调
 * - B-4: registerTool × 3 — physos_submit, physos_query, physos_arm
 * - B-8: registerService — 心跳 + 适配器注册生命周期
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhysOSConfig } from "./src/types.js";
import { DEFAULT_PHYSOS_CONFIG } from "./src/types.js";
import { PhysOSClient } from "./src/physos-client.js";
import { createAdapterServer } from "./src/adapter-server.js";
import { createPhysOSSubmitTool } from "./src/tools/physos-submit.js";
import { createPhysOSQueryTool } from "./src/tools/physos-query.js";
import { createPhysOSArmTool } from "./src/tools/physos-arm.js";
import { createPhysOSRuleAdvisorTool } from "./src/tools/physos-rule-advisor.js";
import { createPhysOSService, getAgentClient } from "./src/service.js";

const plugin = {
  id: "physos-bridge",
  name: "PhysOS Bridge",
  description: "Bridge between OpenClaw AI assistant and PhysOS cyber-physical governance system",

  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig ?? {}) as Partial<PhysOSConfig>;
    const config: PhysOSConfig = {
      physosUrl: rawConfig.physosUrl ?? DEFAULT_PHYSOS_CONFIG.physosUrl!,
      physosWsUrl: rawConfig.physosWsUrl ?? DEFAULT_PHYSOS_CONFIG.physosWsUrl!,
      sourceApiKey: rawConfig.sourceApiKey ?? process.env.PHYSOS_SOURCE_API_KEY ?? '',
      adminToken: rawConfig.adminToken ?? process.env.PHYSOS_ADMIN_TOKEN ?? '',
      adapterId: rawConfig.adapterId ?? DEFAULT_PHYSOS_CONFIG.adapterId!,
      heartbeatIntervalMs: rawConfig.heartbeatIntervalMs ?? DEFAULT_PHYSOS_CONFIG.heartbeatIntervalMs!,
    };

    // 将 Gateway 配置注入环境变量，供 adapter-server 的 executeTool 和 agent-client 使用
    try {
      // 优先从 plugin API 获取 config（Gateway 已解析好的），fallback 到文件读取
      const gwConfig = (api as any).config?.gateway ?? (api as any).config?.get?.('gateway');
      let gwToken = gwConfig?.auth?.token;
      let gwPort = gwConfig?.port;
      if (!gwToken) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const cfgPath = join(home, '.openclaw', 'openclaw.json');
        const fullCfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        gwToken = fullCfg.gateway?.auth?.token;
        gwPort = gwPort || fullCfg.gateway?.port;
      }
      if (gwPort) {
        process.env.OPENCLAW_GATEWAY_PORT = String(gwPort);
      }
      if (gwToken) {
        process.env.OPENCLAW_GATEWAY_TOKEN = gwToken;
      }
    } catch { /* 静默失败，executeTool 会用默认值 */ }

    // v5.0: 增大超时至 65s — postIntent() 现在会阻塞等待完整执行（含 AI agent 处理 30-50s）
    const client = new PhysOSClient(config, { timeoutMs: 65_000 });

    // B-8: 注册服务（心跳 + 适配器注册/注销）
    api.registerService(createPhysOSService(config, client));

    // B-3: 注册 Adapter 执行回调端点（v5.0: 传入 agentClient getter 支持双轨执行）
    api.registerHttpRoute(createAdapterServer(api, config, getAgentClient));

    // B-4: 注册 3 个 PhysOS 工具
    api.registerTool(createPhysOSSubmitTool(client));
    api.registerTool(createPhysOSQueryTool(client));
    api.registerTool(createPhysOSArmTool(client));

    // C-ext-4: 注册规则建议工具
    api.registerTool(createPhysOSRuleAdvisorTool());
  },
};

export default plugin;
