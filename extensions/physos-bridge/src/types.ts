/**
 * v4.0 B-1 Step 5: PhysOS Bridge Types
 *
 * 跨仓库无法 import physos-core 的类型 — 在此重新声明，
 * 保持字段签名与 physos-core 完全一致。
 */

// ────────────────────────────────────────────
// Config (from openclaw.plugin.json configSchema)
// ────────────────────────────────────────────

export interface PhysOSConfig {
  physosUrl: string;
  physosWsUrl: string;
  sourceApiKey: string;
  adminToken: string;
  adapterId: string;
  heartbeatIntervalMs: number;
}

export const DEFAULT_PHYSOS_CONFIG: Partial<PhysOSConfig> = {
  physosUrl: 'http://127.0.0.1:3800',
  physosWsUrl: 'ws://127.0.0.1:3800',
  adapterId: 'openclaw_adapter',
  heartbeatIntervalMs: 25000,
};

// ────────────────────────────────────────────
// Intent Envelope (对齐 interfaces/intent.v1.schema.json)
// ────────────────────────────────────────────

export type IntentType = 'action' | 'goal' | 'query' | 'confirm_response';
export type SourceType = 'human' | 'ai' | 'system' | 'sensor' | 'voice' | 'api' | 'mqtt';
export type Priority = 'low' | 'normal' | 'high' | 'emergency';
export type ConsequenceLevel = 'reversible' | 'irreversible' | 'safety_critical';
export type ExecutionMode = 'plan_only' | 'armed_live';

export interface IntentSource {
  source_id: string;
  source_type: SourceType;
  ai_tier?: number;
  role?: string;
  session_id?: string;
}

export interface IntentTarget {
  scope: string;
  id: string;
  adapter_id?: string;
}

export interface IntentConstraints {
  max_duration_ms?: number;
  time_window?: { start: string; end: string };
  preconditions?: string[];
  odd_profile?: string;
  hitl_required?: boolean;
}

export interface ConfirmRef {
  original_intent_id: string;
  confirm_token: string;
  decision: 'accept' | 'reject';
}

export interface IntentEnvelope {
  intent_id?: string;
  version?: string;
  trace_id?: string;
  source: IntentSource;
  type: IntentType;
  domain?: string;
  action?: string;
  goal?: string;
  target?: IntentTarget;
  params?: Record<string, unknown>;
  priority: Priority;
  consequence_level?: ConsequenceLevel;
  execution_mode: ExecutionMode;
  constraints?: IntentConstraints;
  confirm_ref?: ConfirmRef;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

// ────────────────────────────────────────────
// Adapter Types (对齐 physos-core adapters/types.ts)
// ────────────────────────────────────────────

export interface AdapterActionRequest {
  action: string;
  params?: Record<string, unknown>;
  trace_id?: string;
  target_id?: string;
}

export interface AdapterExecutionMeta {
  adapter_id: string;
  execution_path: 'adapter';
  timestamp: string;
  latency_ms?: number;
}

export interface AdapterActionResult {
  ok: boolean;
  code: string;
  action: string;
  reason?: string;
  state?: Record<string, unknown>;
  meta?: AdapterExecutionMeta;
}

export interface AdapterHealthResult {
  status: 'online' | 'offline' | 'degraded';
  reason?: string;
  checked_at: string;
}

// ────────────────────────────────────────────
// Intent Submit Response (from physos-core)
// ────────────────────────────────────────────

export interface IntentSubmitResponse {
  intent_id: string;
  trace_id: string;
  status: 'accepted' | 'rejected';
  reason?: string;
  timestamp: string;
}

// ────────────────────────────────────────────
// Gate Pipeline Result
// ────────────────────────────────────────────

export interface RuntimeGateResult {
  gate_name: string;
  result: 'pass' | 'deny' | 'pass_with_conditions';
  reason?: string;
  details?: Record<string, unknown>;
}

// ────────────────────────────────────────────
// Adapter Register Input
// ────────────────────────────────────────────

export interface AdapterRegisterInput {
  adapter_id: string;
  online?: boolean;
  capabilities: string[];
  metadata?: Record<string, unknown>;
}
