/**
 * v4.0 B-4 Step 1: physos_submit tool
 *
 * 提交 Intent 到 PhysOS Gate Pipeline。
 * source 固定为 src_openclaw_001, ai_tier=1。
 * 默认 plan_only，不自动执行。
 */

import type { PhysOSClient } from "../physos-client.js";
import type { IntentEnvelope, IntentSubmitResponse } from "../types.js";
import { getActiveArmToken } from "./physos-arm.js";

export function createPhysOSSubmitTool(client: PhysOSClient) {
  return {
    name: "physos_submit",
    label: "PhysOS Submit",
    description:
      "Submit an action intent to PhysOS cyber-physical governance pipeline. " +
      "The intent goes through 5 gates (validation → capability → policy → HITL → execution). " +
      "Default mode is plan_only (dry-run). Use armed_live for real execution (requires ARM token for safety_critical actions). " +
      "IMPORTANT: Always include a 'description' with the user's original request in natural language, " +
      "so the executor knows exactly what to do.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description: "Action name, e.g. 'light.on', 'thermostat.set_temperature', 'drone.takeoff'",
        },
        description: {
          type: "string",
          description: "Human-readable description of what the user wants done. ALWAYS include this — it tells the executor exactly what to do. E.g. 'Open Terminal and type 你好', 'Search Google for weather in Beijing'",
        },
        target_id: {
          type: "string",
          description: "Target device/entity ID",
        },
        target_scope: {
          type: "string",
          description: "Target scope, e.g. 'device', 'zone', 'system'",
          default: "device",
        },
        params: {
          type: "object",
          description:
            "Action parameters (structured data for the executor). " +
            "IMPORTANT for digital.* actions: " +
            "For digital.open_terminal_and_type, MUST include { command: 'the shell command to run' }. " +
            "For digital.run_script, MUST include { command: 'the script/command to execute' }. " +
            "For digital.browser_open, include { url: 'https://...' }. " +
            "Examples: { command: 'open -a \"Google Chrome\" \"https://google.com\"' }, { brightness: 80 }",
        },
        domain: {
          type: "string",
          description: "Action domain, e.g. 'comfort', 'security', 'task'",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "emergency"],
          description: "Intent priority (default: normal)",
          default: "normal",
        },
        consequence_level: {
          type: "string",
          enum: ["reversible", "irreversible", "safety_critical"],
          description: "Consequence level of the action",
        },
        execution_mode: {
          type: "string",
          enum: ["plan_only", "armed_live"],
          description: "Execution mode (default: plan_only = dry-run)",
          default: "plan_only",
        },
      },
      required: ["action"],
    },

    async execute(
      _toolCallId: string,
      params: {
        action: string;
        description?: string;
        target_id?: string;
        target_scope?: string;
        params?: Record<string, unknown>;
        domain?: string;
        priority?: string;
        consequence_level?: string;
        execution_mode?: string;
      },
    ) {
      // armed_live 模式下自动注入 ARM Token
      const executionMode = (params.execution_mode as IntentEnvelope['execution_mode']) ?? 'plan_only';
      let metadata: Record<string, unknown> | undefined;
      if (executionMode === 'armed_live') {
        const armToken = getActiveArmToken();
        if (armToken) {
          metadata = { arm_token: armToken };
        }
      }
      // 传递用户意图描述，让执行 agent 知道具体要做什么
      if (params.description) {
        metadata = { ...metadata, user_intent: params.description };
      }

      const envelope: IntentEnvelope = {
        source: {
          source_id: 'src_openclaw_001',
          source_type: 'ai',
          ai_tier: 1,
        },
        type: 'action',
        action: params.action,
        domain: params.domain,
        target: {
          scope: params.target_scope ?? 'device',
          id: params.target_id ?? 'openclaw_adapter',
          adapter_id: 'openclaw_adapter',
        },
        params: params.params,
        priority: (params.priority as IntentEnvelope['priority']) ?? 'normal',
        consequence_level: params.consequence_level as IntentEnvelope['consequence_level'],
        execution_mode: executionMode,
        metadata,
      };

      try {
        const response = await client.postIntent(envelope);
        return {
          content: [
            {
              type: "text" as const,
              text: formatSubmitResponse(response, params.action),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ PhysOS Submit failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

function formatSubmitResponse(response: IntentSubmitResponse, action: string): string {
  if (response.status === 'accepted') {
    return [
      `✅ Intent accepted`,
      `  Action: ${action}`,
      `  Intent ID: ${response.intent_id}`,
      `  Trace ID: ${response.trace_id}`,
    ].join('\n');
  }
  return [
    `⛔ Intent rejected`,
    `  Action: ${action}`,
    `  Reason: ${response.reason ?? 'unknown'}`,
    `  Intent ID: ${response.intent_id}`,
  ].join('\n');
}
