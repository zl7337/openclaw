/**
 * v4.0 B-2: PhysOS REST/WS 客户端库
 *
 * 封装 physos-core 全部 HTTP/WS 端点为类型安全的客户端。
 * 9 个 REST 方法 + WebSocket 事件订阅。
 */

import type {
  PhysOSConfig,
  IntentEnvelope,
  IntentSubmitResponse,
  AdapterRegisterInput,
} from "./types.js";

// ────────────────────────────────────────────
// Error Classes
// ────────────────────────────────────────────

export class PhysOSApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`PhysOS API error: HTTP ${status}`);
    this.name = 'PhysOSApiError';
  }
}

export class PhysOSConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(`PhysOS connection error: ${message}`);
    this.name = 'PhysOSConnectionError';
  }
}

export class PhysOSTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly url: string,
  ) {
    super(`PhysOS timeout after ${timeoutMs}ms: ${url}`);
    this.name = 'PhysOSTimeoutError';
  }
}

// ────────────────────────────────────────────
// PhysOS Client
// ────────────────────────────────────────────

export class PhysOSClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly sourceApiKey: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;

  constructor(config: PhysOSConfig, options?: { timeoutMs?: number }) {
    this.baseUrl = config.physosUrl.replace(/\/$/, '');
    this.wsUrl = config.physosWsUrl.replace(/\/$/, '');
    this.sourceApiKey = config.sourceApiKey;
    this.adminToken = config.adminToken;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  // ── REST Methods (9) ──────────────────────

  /** POST /intent — 提交 intent */
  async postIntent(envelope: IntentEnvelope): Promise<IntentSubmitResponse> {
    return this.request<IntentSubmitResponse>('POST', '/intent', envelope, {
      'x-api-key': this.sourceApiKey,
    });
  }

  /** POST /utterance — 提交自然语言 */
  async postUtterance(
    text: string,
    source: { source_id: string; source_type: string },
  ): Promise<unknown> {
    return this.request('POST', '/utterance', { text, source }, {
      'x-api-key': this.sourceApiKey,
    });
  }

  /** POST /adapters/register — 注册适配器 */
  async registerAdapter(input: AdapterRegisterInput): Promise<unknown> {
    return this.request('POST', '/adapters/register', input, {
      'x-api-key': this.sourceApiKey,
      'x-control-plane-admin-token': this.adminToken,
    });
  }

  /** POST /adapters/:id/heartbeat — 心跳 */
  async heartbeat(adapterId: string): Promise<unknown> {
    return this.request('POST', `/adapters/${encodeURIComponent(adapterId)}/heartbeat`, undefined, {
      'x-api-key': this.sourceApiKey,
      'x-control-plane-admin-token': this.adminToken,
    });
  }

  /** DELETE /adapters/:id — 移除适配器 */
  async removeAdapter(adapterId: string): Promise<unknown> {
    return this.request('DELETE', `/adapters/${encodeURIComponent(adapterId)}`, undefined, {
      'x-api-key': this.sourceApiKey,
      'x-control-plane-admin-token': this.adminToken,
    });
  }

  /** GET /healthz — 健康检查 */
  async getHealth(): Promise<unknown> {
    return this.request('GET', '/healthz');
  }

  /** GET /adapters/snapshot — 适配器快照 */
  async getAdapterSnapshot(): Promise<unknown> {
    return this.request('GET', '/adapters/snapshot', undefined, {
      'x-api-key': this.sourceApiKey,
      'x-control-plane-admin-token': this.adminToken,
    });
  }

  /** GET /trace/:traceId — 获取 trace */
  async getTrace(traceId: string): Promise<unknown> {
    return this.request('GET', `/trace/${encodeURIComponent(traceId)}`, undefined, {
      'x-api-key': this.sourceApiKey,
    });
  }

  /** GET /intent/:intentId — 获取 intent */
  async getIntent(intentId: string): Promise<unknown> {
    return this.request('GET', `/intent/${encodeURIComponent(intentId)}`, undefined, {
      'x-api-key': this.sourceApiKey,
    });
  }

  // ── WebSocket ──────────────────────────────

  /**
   * 连接 WebSocket 事件流
   * 指数退避重连: 1s → 2s → 4s → 8s → 30s 封顶
   */
  connectEvents(onEvent: (event: unknown) => void): { close: () => void } {
    let ws: WebSocket | null = null;
    let retryDelay = 1000;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;

      try {
        ws = new WebSocket(`${this.wsUrl}/ws/events`);

        ws.onopen = () => {
          retryDelay = 1000; // 重连成功后重置
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(String(msg.data));
            onEvent(data);
          } catch {
            // 忽略非 JSON 消息
          }
        };

        ws.onclose = () => {
          if (!closed) {
            retryTimer = setTimeout(() => {
              retryDelay = Math.min(retryDelay * 2, 30_000);
              connect();
            }, retryDelay);
          }
        };

        ws.onerror = () => {
          // onclose 会自动触发重连
        };
      } catch {
        if (!closed) {
          retryTimer = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, 30_000);
            connect();
          }, retryDelay);
        }
      }
    };

    connect();

    return {
      close() {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        if (ws) {
          try { ws.close(); } catch { /* ignore */ }
        }
      },
    };
  }

  // ── Internal ───────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...extraHeaders,
      };

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new PhysOSTimeoutError(this.timeoutMs, url);
        }
        throw new PhysOSConnectionError(
          (err as Error).message,
          err as Error,
        );
      }

      if (!response.ok) {
        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text().catch(() => '');
        }
        throw new PhysOSApiError(response.status, responseBody);
      }

      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
