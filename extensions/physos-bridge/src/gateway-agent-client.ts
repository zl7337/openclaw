/**
 * v6.0: Gateway Agent Client — WebSocket RPC for AI Agent Invocation
 *
 * 通过 OpenClaw Gateway 的 `agent` method 调用 AI agent 执行任意任务。
 * 用于 adapter-server 的"智能通道"——当 action 没有直接的 tool 映射时，
 * 交给 AI agent 自主选择工具完成。
 *
 * 协议: Gateway Protocol v3
 * - connect → agent (method) → two-phase response (accepted → final)
 * - 每个执行使用独立 sessionKey 避免污染主对话
 * - 使用 lane: "subagent" 避免与 main lane 死锁
 * - 指数退避自动重连
 */

// ────────────────────────────────────────────
// Imports
// ────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign as ed25519Sign, createPrivateKey } from 'node:crypto';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

interface GatewayReqFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

interface GatewayResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

type GatewayFrame = GatewayReqFrame | GatewayResFrame;

export interface AgentExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface GatewayAgentClient {
  connect(): Promise<void>;
  executeViaAgent(params: {
    action: string;
    actionParams?: Record<string, unknown>;
    userIntent?: string;
    traceId: string;
    timeoutMs?: number;
  }): Promise<AgentExecutionResult>;
  /** Inject a message into an existing session transcript (dual-write for fast path) */
  injectToSession(params: {
    sessionKey: string;
    message: string;
    label?: string;
  }): Promise<boolean>;
  close(): void;
  readonly connected: boolean;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 50_000;
const CONNECT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

let _idCounter = 0;
function nextId(): string {
  return `physos-${Date.now()}-${++_idCounter}`;
}

// ── Device identity helpers ──

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface DeviceAuth {
  deviceToken: string;
}

function loadDeviceIdentity(logger: Logger): DeviceIdentity | null {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const idPath = join(home, '.openclaw', 'identity', 'device.json');
    const raw = JSON.parse(readFileSync(idPath, 'utf-8'));
    if (raw.deviceId && raw.publicKeyPem && raw.privateKeyPem) {
      return { deviceId: raw.deviceId, publicKeyPem: raw.publicKeyPem, privateKeyPem: raw.privateKeyPem };
    }
    return null;
  } catch {
    logger.warn('[physos-agent-client] device identity not found');
    return null;
  }
}

function loadDeviceAuth(logger: Logger): DeviceAuth | null {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const authPath = join(home, '.openclaw', 'identity', 'device-auth.json');
    const raw = JSON.parse(readFileSync(authPath, 'utf-8'));
    const token = raw?.tokens?.operator?.token;
    if (typeof token === 'string' && token.length > 0) {
      return { deviceToken: token };
    }
    return null;
  } catch {
    logger.warn('[physos-agent-client] device auth not found');
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(
    ed25519Sign(null, Buffer.from(payload, 'utf-8'), key),
  );
}

export function createGatewayAgentClient(opts: {
  gatewayPort: number;
  gatewayToken: string;
  logger: Logger;
}): GatewayAgentClient {
  const { gatewayPort, gatewayToken, logger } = opts;

  // Load device identity for connect handshake
  const deviceId = loadDeviceIdentity(logger);
  const deviceAuth = loadDeviceAuth(logger);
  if (deviceId) {
    logger.info(`[physos-agent-client] device identity loaded: ${deviceId.deviceId.slice(0, 12)}...`);
  }

  let ws: WebSocket | null = null;
  let _connected = false;
  let _closed = false;
  let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let _reconnectDelay = 1000;

  // Pending single-response RPC correlation (for connect handshake etc.)
  const pending = new Map<
    string,
    {
      resolve: (res: GatewayResFrame) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Two-phase response handlers for `agent` method calls.
  // The `agent` method sends TWO res frames with the same ID:
  //   1st: { ok: true, payload: { status: "accepted", runId } }
  //   2nd: { ok: true, payload: { status: "ok", result } } or error
  const agentWaiters = new Map<
    string,
    {
      onResponse: (res: GatewayResFrame) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Captured challenge nonce from Gateway's connect.challenge event
  let _challengeNonce: string | null = null;
  let _challengeResolve: ((nonce: string) => void) | null = null;

  // ── WebSocket message handler ──

  function onMessage(data: unknown): void {
    let frame: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : String(data);
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (!frame || typeof frame !== 'object' || !('type' in frame)) return;

    // Handle connect.challenge event (arrives before connect handshake)
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      const payload = frame.payload as Record<string, unknown> | undefined;
      const nonce = payload?.nonce;
      if (typeof nonce === 'string') {
        _challengeNonce = nonce;
        if (_challengeResolve) {
          _challengeResolve(nonce);
          _challengeResolve = null;
        }
      }
      return;
    }

    if (frame.type === 'res') {
      const res = frame as unknown as GatewayResFrame;

      // Check agent waiters first (they handle multiple responses per ID)
      const agentWaiter = agentWaiters.get(res.id);
      if (agentWaiter) {
        agentWaiter.onResponse(res);
        return;
      }

      // Standard single-response pending
      const waiter = pending.get(res.id);
      if (waiter) {
        pending.delete(res.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(res);
      }
    }
  }

  // ── Send single-response RPC request and await response ──

  function request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<GatewayResFrame> {
    return new Promise<GatewayResFrame>((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = nextId();
      const frame: GatewayReqFrame = { type: 'req', id, method, params };
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} response`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });
  }

  // ── Internal connect (WebSocket open + handshake) ──

  async function doConnect(): Promise<void> {
    const wsUrl = `ws://127.0.0.1:${gatewayPort}`;

    return new Promise<void>((resolve, reject) => {
      const openTimeout = setTimeout(() => {
        reject(new Error('WebSocket open timeout'));
      }, CONNECT_TIMEOUT_MS);

      const socket = new WebSocket(wsUrl);

      socket.onopen = async () => {
        clearTimeout(openTimeout);
        ws = socket;
        _challengeNonce = null;

        // Wire up message handler FIRST so we capture connect.challenge
        socket.onmessage = (evt) => onMessage(evt.data);
        socket.onclose = () => {
          _connected = false;
          if (!_closed) {
            logger.warn('[physos-agent-client] WebSocket disconnected, will reconnect');
            scheduleReconnect();
          }
        };
        socket.onerror = () => {
          // onclose will handle reconnect
        };

        // Wait for connect.challenge nonce (Gateway sends it right after WS open)
        try {
          const nonce = await new Promise<string>((res, rej) => {
            if (_challengeNonce) { res(_challengeNonce); return; }
            const timer = setTimeout(() => { rej(new Error('connect.challenge timeout')); }, 5000);
            _challengeResolve = (n) => { clearTimeout(timer); res(n); };
          });

          // Build connect params with device identity
          const role = 'operator';
          const scopes = ['operator.admin', 'operator.write'];
          const signedAt = Date.now();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const connectParams: Record<string, any> = {
            minProtocol: 3,
            maxProtocol: 3,
            role,
            client: {
              id: 'gateway-client',
              displayName: 'PhysOS Bridge Agent Client',
              version: '2.0',
              platform: 'node',
              mode: 'backend',
            },
            auth: {
              token: gatewayToken,
              ...(deviceAuth ? { deviceToken: deviceAuth.deviceToken } : {}),
            },
            scopes,
          };

          // Sign nonce with device identity (Ed25519)
          if (deviceId) {
            const signaturePayload = [
              'v3',
              deviceId.deviceId,
              'gateway-client',    // clientId
              'backend',           // clientMode
              role,
              scopes.join(','),
              String(signedAt),
              gatewayToken,        // token (resolveSignatureToken returns connectParams.auth.token)
              nonce,
              'node',              // platform
              '',                  // deviceFamily (not set)
            ].join('|');

            const signature = signDevicePayload(deviceId.privateKeyPem, signaturePayload);

            connectParams.device = {
              id: deviceId.deviceId,
              publicKey: deviceId.publicKeyPem,
              signature,
              signedAt,
              nonce,
            };
            logger.info(`[physos-agent-client] device identity signed, nonce=${nonce.slice(0, 8)}...`);
          }

          const connectRes = await request('connect', connectParams);

          if (!connectRes.ok) {
            reject(new Error(`connect handshake failed: ${connectRes.error?.message ?? 'unknown'}`));
            return;
          }

          _connected = true;
          _reconnectDelay = 1000;
          logger.info('[physos-agent-client] Connected to Gateway WebSocket');
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      socket.onerror = (err) => {
        clearTimeout(openTimeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
    });
  }

  function scheduleReconnect(): void {
    if (_closed || _reconnectTimer) return;
    _reconnectTimer = setTimeout(async () => {
      _reconnectTimer = null;
      if (_closed) return;
      try {
        await doConnect();
      } catch (err) {
        logger.warn(`[physos-agent-client] Reconnect failed: ${(err as Error).message}`);
        _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        scheduleReconnect();
      }
    }, _reconnectDelay);
  }

  // ── Parse the `agent` method final response payload ──

  function parseAgentMethodResult(payload: Record<string, unknown> | undefined): AgentExecutionResult {
    if (!payload) {
      return { success: true, result: { output: '(agent completed)' } };
    }

    const status = payload.status as string;
    if (status === 'error') {
      return {
        success: false,
        error: (payload.summary as string) || 'Agent execution failed',
      };
    }

    // The `result` field is EmbeddedPiRunResult:
    // { payloads: [{ text: "..." }], meta: {...}, ... }
    const result = payload.result as Record<string, unknown> | undefined;
    if (!result) {
      return { success: true, result: { output: '(agent completed)' } };
    }

    // Extract text content from payloads
    const payloads = result.payloads as Array<{ text?: string; isError?: boolean }> | undefined;
    let content = '';
    if (Array.isArray(payloads)) {
      content = payloads
        .map((p) => p.text ?? '')
        .filter(Boolean)
        .join('\n');
    }

    // Try to parse JSON result from agent's response text
    if (content) {
      const jsonMatch = content.match(/\{[\s\S]*"success"\s*:\s*(true|false)[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          return {
            success: parsed.success === true,
            result: parsed,
          };
        } catch { /* fallthrough */ }
      }
    }

    // Check if any payload was marked as error
    if (Array.isArray(payloads) && payloads.some((p) => p.isError)) {
      return {
        success: false,
        error: content || 'Agent reported error',
      };
    }

    // If no structured JSON, treat any completed response as success
    return {
      success: true,
      result: { output: content || '(agent completed)' },
    };
  }

  // ── Public API ──

  return {
    get connected() {
      return _connected;
    },

    async connect(): Promise<void> {
      _closed = false;
      try {
        await doConnect();
      } catch (err) {
        logger.warn(`[physos-agent-client] Initial connect failed: ${(err as Error).message}, will retry`);
        scheduleReconnect();
      }
    },

    async injectToSession(params: {
      sessionKey: string;
      message: string;
      label?: string;
    }): Promise<boolean> {
      if (!_connected || !ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn('[physos-agent-client] injectToSession: not connected');
        return false;
      }
      try {
        const res = await request('chat.inject', params);
        if (res.ok) {
          logger.info(`[physos-agent-client] injectToSession OK → ${params.sessionKey}`);
        } else {
          logger.warn(`[physos-agent-client] injectToSession failed: ${res.error?.message ?? 'unknown'}`);
        }
        return res.ok === true;
      } catch (err) {
        logger.warn(`[physos-agent-client] injectToSession error: ${(err as Error).message}`);
        return false;
      }
    },

    async executeViaAgent(params: {
      action: string;
      actionParams?: Record<string, unknown>;
      userIntent?: string;
      traceId: string;
      timeoutMs?: number;
    }): Promise<AgentExecutionResult> {
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      if (!_connected || !ws || ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Agent client not connected to Gateway' };
      }

      // Use a unique session key per execution to avoid polluting main conversation
      const sessionKey = `physos:exec:${params.traceId}`;
      const idempotencyKey = `physos-${params.traceId}`;

      // Build the structured message for the AI agent
      const hasParams = params.actionParams && Object.keys(params.actionParams).length > 0;
      const paramsJson = hasParams
        ? JSON.stringify(params.actionParams, null, 2)
        : null;

      // Derive a human-readable intent description from the action name
      // e.g. "digital.run_script" → "run script", "digital.browser_open" → "browser open"
      const actionSuffix = params.action.includes('.')
        ? params.action.split('.').slice(1).join('.').replace(/_/g, ' ')
        : params.action.replace(/_/g, ' ');

      // Build the instruction message for the execution agent
      const now = new Date();
      const localTime = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });

      const lines: string[] = [
        `[${localTime.replace(',', '')} GMT+8] [PhysOS Action Request]`,
        `Action: ${params.action}`,
      ];
      if (params.userIntent) {
        lines.push(`User Request: ${params.userIntent}`);
      }
      if (paramsJson) {
        lines.push(`Params: ${paramsJson}`);
      }
      lines.push(`Trace: ${params.traceId}`);
      lines.push('');
      if (params.userIntent) {
        // When we have the user's original intent, prioritize it
        lines.push(
          `Execute the user's request DIRECTLY using tools like exec, browser, write, or message.`,
          `The user wants: "${params.userIntent}"`,
          `Use the action name "${params.action}" as context for what category of task this is.`,
        );
      } else if (hasParams) {
        lines.push('Execute this action DIRECTLY using tools like exec, browser, write, or message.');
      } else {
        lines.push(
          `Execute the "${actionSuffix}" action DIRECTLY using tools like exec, browser, write, or message.`,
          'No specific parameters were provided, so interpret the action name as a general intent and execute it as best you can.',
          `For example: if action is "digital.run_script", run a simple test script; if "digital.browser_open", open a browser.`,
        );
      }
      lines.push(
        '',
        'CRITICAL RULES:',
        '1. You MUST actually call a tool (exec, browser, write, etc.) to perform the action. Do NOT just say you did it — you must show the tool call and its real output.',
        '2. Do NOT use physos_submit, physos_query, or physos_arm tools — this request already came from PhysOS and using those would create an infinite loop.',
        '3. For macOS terminal operations, use the exec tool to run osascript/AppleScript commands. Example: exec osascript -e \'tell application "Terminal" to activate\' -e \'tell application "Terminal" to do script "echo hello"\'',
        '4. After executing, report the ACTUAL tool output as JSON: { "success": true/false, "output": "..." }',
        '5. If a tool call fails or returns an error, report success: false with the actual error message.',
      );

      // Notification-specific hints: guide agent to use the message tool correctly
      if (params.action.startsWith('notification.')) {
        const msgParam = (params.actionParams?.message as string) ?? '';
        lines.push(
          '',
          'NOTIFICATION RULES:',
          '- For ALL notification.* actions (send, broadcast, etc.), use the "message" tool with action "broadcast" and channel "telegram".',
          '- IMPORTANT: Do NOT use action "send" — it requires a specific target and will fail. Always use action "broadcast" which sends to the owner\'s default Telegram DM.',
          '- Tool call example: message { action: "broadcast", text: "<content>", channel: "telegram" }',
          msgParam ? `- The notification content is: "${msgParam}"` : '',
        );
      }

      const message = lines.join('\n');

      const id = nextId();
      const frame: GatewayReqFrame = {
        type: 'req',
        id,
        method: 'agent',
        params: {
          sessionKey,
          message,
          idempotencyKey,
          deliver: false,
          lane: 'subagent',
        },
      };

      logger.info(`[physos-agent-client] invoking agent: action=${params.action} session=${sessionKey} lane=subagent`);

      // Two-phase response handling:
      // 1st res frame: { status: "accepted", runId } — agent run queued
      // 2nd res frame: { status: "ok", result } — agent run completed
      return new Promise<AgentExecutionResult>((resolve) => {
        let gotAccepted = false;

        const overallTimeout = setTimeout(() => {
          agentWaiters.delete(id);
          logger.warn(`[physos-agent-client] agent timeout for ${params.action} (${timeoutMs}ms)`);
          resolve({ success: false, error: `timeout waiting for agent completion (${timeoutMs}ms)` });
        }, timeoutMs);

        agentWaiters.set(id, {
          onResponse: (res: GatewayResFrame) => {
            if (!gotAccepted) {
              // First response: accepted or rejected
              gotAccepted = true;
              if (!res.ok) {
                clearTimeout(overallTimeout);
                agentWaiters.delete(id);
                const errMsg = res.error?.message ?? JSON.stringify(res.error);
                logger.warn(`[physos-agent-client] agent request rejected: ${errMsg}`);
                resolve({ success: false, error: `agent request rejected: ${errMsg}` });
                return;
              }
              const runId = (res.payload?.runId as string) ?? '?';
              logger.info(`[physos-agent-client] agent accepted, runId=${runId}, waiting for completion...`);
              // Keep the agentWaiter registered — wait for the second response
            } else {
              // Second response: final result
              clearTimeout(overallTimeout);
              agentWaiters.delete(id);
              const status = res.payload?.status as string;
              logger.info(`[physos-agent-client] agent completed, status=${status}`);
              if (res.ok && (status === 'ok' || status === 'completed')) {
                resolve(parseAgentMethodResult(res.payload));
              } else {
                resolve({
                  success: false,
                  error: (res.payload?.summary as string) ?? res.error?.message ?? 'agent execution failed',
                });
              }
            }
          },
          timeout: overallTimeout,
        });

        ws!.send(JSON.stringify(frame));
      });
    },

    close(): void {
      _closed = true;
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
      }
      // Clear all pending requests
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout);
      }
      pending.clear();
      // Clear all agent waiters
      for (const waiter of agentWaiters.values()) {
        clearTimeout(waiter.timeout);
      }
      agentWaiters.clear();
      // Close WebSocket
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      _connected = false;
      logger.info('[physos-agent-client] Closed');
    },
  };
}
