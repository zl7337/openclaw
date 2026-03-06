/**
 * v4.0 B-1: PhysOS Bridge Extension Entry Point
 *
 * OpenClaw ↔ PhysOS 双向桥接插件
 * - B-3: registerHttpRoute(/physos/execute) — Adapter 执行回调
 * - B-4: registerTool × 3 — physos_submit, physos_query, physos_arm
 * - B-8: registerService — 心跳 + 适配器注册生命周期
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PhysOSConfig } from "./src/types.js";
import { DEFAULT_PHYSOS_CONFIG } from "./src/types.js";
import { PhysOSClient } from "./src/physos-client.js";
import { createAdapterServer } from "./src/adapter-server.js";
import { createPhysOSSubmitTool } from "./src/tools/physos-submit.js";
import { createPhysOSQueryTool } from "./src/tools/physos-query.js";
import { createPhysOSArmTool } from "./src/tools/physos-arm.js";
import { createPhysOSRuleAdvisorTool } from "./src/tools/physos-rule-advisor.js";
import { createPhysOSService } from "./src/service.js";

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

    const client = new PhysOSClient(config);

    // B-8: 注册服务（心跳 + 适配器注册/注销）
    api.registerService(createPhysOSService(config, client));

    // B-3: 注册 Adapter 执行回调端点
    api.registerHttpRoute(createAdapterServer(api, config));

    // B-4: 注册 3 个 PhysOS 工具
    api.registerTool(createPhysOSSubmitTool(client));
    api.registerTool(createPhysOSQueryTool(client));
    api.registerTool(createPhysOSArmTool(client));

    // C-ext-4: 注册规则建议工具
    api.registerTool(createPhysOSRuleAdvisorTool());
  },
};

export default plugin;
