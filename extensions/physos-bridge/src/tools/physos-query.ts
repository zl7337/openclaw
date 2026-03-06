/**
 * v4.0 B-4 Step 2: physos_query tool
 *
 * 查询 PhysOS 系统状态：health, adapters, trace, intent, constitution。
 */

import type { PhysOSClient } from "../physos-client.js";

export function createPhysOSQueryTool(client: PhysOSClient) {
  return {
    name: "physos_query",
    label: "PhysOS Query",
    description:
      "Query PhysOS system status. Supports: health (system health), adapters (registered adapters), " +
      "trace (execution trace by ID), intent (intent details by ID), constitution (action whitelist).",
    parameters: {
      type: "object" as const,
      properties: {
        query_type: {
          type: "string",
          enum: ["health", "adapters", "trace", "intent", "constitution"],
          description: "Type of query to perform",
        },
        id: {
          type: "string",
          description: "Required for trace/intent queries — the trace_id or intent_id to look up",
        },
      },
      required: ["query_type"],
    },

    async execute(
      _toolCallId: string,
      params: { query_type: string; id?: string },
    ) {
      try {
        let result: unknown;
        let label: string;

        switch (params.query_type) {
          case 'health':
            result = await client.getHealth();
            label = 'System Health';
            break;

          case 'adapters':
            result = await client.getAdapterSnapshot();
            label = 'Adapter Snapshot';
            break;

          case 'trace':
            if (!params.id) {
              return {
                content: [{ type: "text" as const, text: '❌ trace query requires an id parameter' }],
                isError: true,
              };
            }
            result = await client.getTrace(params.id);
            label = `Trace ${params.id}`;
            break;

          case 'intent':
            if (!params.id) {
              return {
                content: [{ type: "text" as const, text: '❌ intent query requires an id parameter' }],
                isError: true,
              };
            }
            result = await client.getIntent(params.id);
            label = `Intent ${params.id}`;
            break;

          case 'constitution':
            label = 'Constitution';
            result = {
              note: 'Constitution is loaded from local cache. Use PhysOS admin API for full details.',
              version: '1.3',
              total_actions: 40,
            };
            break;

          default:
            return {
              content: [{ type: "text" as const, text: `❌ Unknown query_type: ${params.query_type}` }],
              isError: true,
            };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `📊 ${label}:\n${JSON.stringify(result, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ PhysOS Query failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
