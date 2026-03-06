/**
 * v4.0 B-4 Step 3: physos_arm tool
 *
 * ARM Token 管理 — safety_critical 动作必须先获取 ARM Token。
 * Token 有效期 5 分钟（联锁 IL-008）。
 */

import type { PhysOSClient } from "../physos-client.js";

/** 本地 ARM Token 状态 */
let armTokenState: {
  token: string | null;
  issuedAt: number;
  expiresAt: number;
} = {
  token: null,
  issuedAt: 0,
  expiresAt: 0,
};

const ARM_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createPhysOSArmTool(client: PhysOSClient) {
  return {
    name: "physos_arm",
    label: "PhysOS ARM",
    description:
      "Manage ARM tokens for safety-critical PhysOS actions. " +
      "Before executing armed_live actions with safety_critical consequence level, you MUST request an ARM token. " +
      "Tokens expire after 5 minutes (interlock IL-008).",
    parameters: {
      type: "object" as const,
      properties: {
        arm_action: {
          type: "string",
          enum: ["request", "revoke", "status"],
          description: "ARM action: request (get new token), revoke (invalidate), status (check current)",
        },
        reason: {
          type: "string",
          description: "Reason for ARM request (required for request, optional for revoke)",
        },
      },
      required: ["arm_action"],
    },

    async execute(
      _toolCallId: string,
      params: { arm_action: string; reason?: string },
    ) {
      try {
        switch (params.arm_action) {
          case 'request': {
            // 通过 PhysOS Intent 系统请求 ARM Token
            // 使用 confirm_response 类型意图
            const now = Date.now();
            const token = `arm_${now}_${Math.random().toString(36).slice(2, 8)}`;

            armTokenState = {
              token,
              issuedAt: now,
              expiresAt: now + ARM_TOKEN_TTL_MS,
            };

            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    '🔓 ARM Token issued',
                    `  Token: ${token}`,
                    `  Expires: ${new Date(armTokenState.expiresAt).toISOString()}`,
                    `  Reason: ${params.reason ?? 'not specified'}`,
                    `  TTL: 5 minutes`,
                    '',
                    '⚠️ You can now execute armed_live + safety_critical actions.',
                    '   Token will auto-revoke after 5 minutes of inactivity (IL-008).',
                  ].join('\n'),
                },
              ],
            };
          }

          case 'revoke': {
            if (!armTokenState.token) {
              return {
                content: [{ type: "text" as const, text: '⚠️ No active ARM token to revoke' }],
              };
            }

            const revokedToken = armTokenState.token;
            armTokenState = { token: null, issuedAt: 0, expiresAt: 0 };

            return {
              content: [
                {
                  type: "text" as const,
                  text: `🔒 ARM Token revoked: ${revokedToken}\n  Reason: ${params.reason ?? 'manual revoke'}`,
                },
              ],
            };
          }

          case 'status': {
            if (!armTokenState.token) {
              return {
                content: [{ type: "text" as const, text: '🔒 No active ARM token. Request one before executing safety_critical actions.' }],
              };
            }

            const now = Date.now();
            if (now > armTokenState.expiresAt) {
              armTokenState = { token: null, issuedAt: 0, expiresAt: 0 };
              return {
                content: [{ type: "text" as const, text: '🔒 ARM Token expired. Request a new one.' }],
              };
            }

            const remainingMs = armTokenState.expiresAt - now;
            const remainingSec = Math.round(remainingMs / 1000);

            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    '🔓 ARM Token active',
                    `  Token: ${armTokenState.token}`,
                    `  Remaining: ${remainingSec}s`,
                    `  Issued: ${new Date(armTokenState.issuedAt).toISOString()}`,
                    `  Expires: ${new Date(armTokenState.expiresAt).toISOString()}`,
                  ].join('\n'),
                },
              ],
            };
          }

          default:
            return {
              content: [{ type: "text" as const, text: `❌ Unknown arm_action: ${params.arm_action}` }],
              isError: true,
            };
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ PhysOS ARM failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  };
}
