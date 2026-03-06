/**
 * v4.0 C-ext-4: physos-rule-advisor tool
 *
 * 根据 Customer Manifest 自动生成 Overlay 草案。
 * 工作流:
 *   1. 设备→动作映射（读 action_capability_map）
 *   2. 场景→联锁规则推导
 *   3. 风险偏好→param_clamp 调整（conservative 收紧20%, balanced 默认, aggressive 不放松）
 *   4. ODD Profile 建议（residential/industrial/vehicle 差异化）
 *   5. 输出 4 个 overlay 草案 + reasoning
 */

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

interface CustomerManifest {
  customer_id: string;
  customer_name: string;
  delivery_tier: string;
  environment: string;
  template_base?: string;
  devices?: Array<{ device_type: string; count: number; location: string; tags?: string[] }>;
  scenes?: Array<{ scene_name: string; description: string; devices_involved: string[]; priority?: string }>;
  risk_preference?: string;
  safety_concerns?: string[];
  custom_constraints?: string[];
}

interface OverlayDraft {
  constitution_overlay: Record<string, unknown>;
  interlock_overlay: Record<string, unknown>;
  param_clamp_overlay: Record<string, unknown>;
  odd_profile_overlay: Record<string, unknown>;
  reasoning: ReasoningEntry[];
}

interface ReasoningEntry {
  dimension: string;
  rule: string;
  reasoning: string;
}

// ────────────────────────────────────────────
// Device → Action Mapping
// ────────────────────────────────────────────

const DEVICE_ACTION_MAP: Record<string, string[]> = {
  smart_light: ['light.on', 'light.off', 'light.dim'],
  smart_lock: ['lock.lock', 'lock.unlock'],
  thermostat: ['thermostat.set_temperature'],
  fan: ['fan.on', 'fan.off', 'fan.set_speed'],
  curtain_motor: ['curtain.open', 'curtain.close'],
  speaker: ['speaker.set_volume'],
  robot_vacuum: ['vacuum.start', 'vacuum.dock'],
  robotic_arm: ['arm.move_joint'],
  drone: ['drone.takeoff', 'drone.land', 'drone.navigate_to', 'drone.return_home'],
  robot: ['robot.move', 'robot.dock'],
  alarm: ['alarm.arm', 'alarm.disarm'],
  air_purifier: ['air_purifier.on'],
  charging_dock: ['dock.charge_start', 'dock.charge_stop', 'dock.swap_battery', 'dock.health_check', 'dock.assign_device'],
  ac: ['ac.set_mode'],
  humidifier: ['humidifier.set_level'],
};

// ────────────────────────────────────────────
// Scene → Interlock Inference
// ────────────────────────────────────────────

const SAFETY_CONCERN_INTERLOCKS: Array<{ pattern: RegExp; interlock: { id: string; name: string; reasoning: string } }> = [
  {
    pattern: /children|儿童|小孩/i,
    interlock: {
      id: 'IL-C-children',
      name: 'children_safety_locks',
      reasoning: 'Customer has children — lock.unlock requires double confirmation',
    },
  },
  {
    pattern: /gas|燃气|天然气/i,
    interlock: {
      id: 'IL-C-gas',
      name: 'gas_leak_enhanced',
      reasoning: 'Gas appliance present — enhanced gas leak monitoring recommended',
    },
  },
  {
    pattern: /elderly|老人|老年/i,
    interlock: {
      id: 'IL-C-elderly',
      name: 'elderly_safety',
      reasoning: 'Elderly residents — additional fall detection and emergency interlocks',
    },
  },
  {
    pattern: /pet|宠物|猫|狗/i,
    interlock: {
      id: 'IL-C-pet',
      name: 'pet_safety',
      reasoning: 'Pets present — robot vacuum scheduling and door lock constraints',
    },
  },
];

// ────────────────────────────────────────────
// Risk Preference → Param Adjustment
// ────────────────────────────────────────────

function adjustParamForRisk(
  baseMax: number,
  baseMin: number,
  preference: string,
): { max: number; min: number; reasoning: string } {
  switch (preference) {
    case 'conservative':
      // 收紧 20%: max 降低 20%, min 提高 20%
      return {
        max: Math.round(baseMax * 0.8),
        min: Math.round(baseMin * 1.2),
        reasoning: 'Conservative risk preference — param bounds tightened by 20%',
      };
    case 'aggressive':
      // 不放松 — 保持原值
      return {
        max: baseMax,
        min: baseMin,
        reasoning: 'Aggressive risk preference — param bounds kept at base (cannot loosen)',
      };
    default: // balanced
      return {
        max: baseMax,
        min: baseMin,
        reasoning: 'Balanced risk preference — using base param bounds',
      };
  }
}

// ────────────────────────────────────────────
// Environment → ODD Profile Suggestion
// ────────────────────────────────────────────

function suggestOddProfiles(environment: string): { profiles: Record<string, unknown>; reasoning: string } {
  switch (environment) {
    case 'residential':
      return {
        profiles: {},
        reasoning: 'Residential: using default ODD profiles (normal/away/emergency/degraded)',
      };
    case 'industrial':
      return {
        profiles: {
          maintenance: {
            name: 'Maintenance',
            description: 'Scheduled maintenance mode — restricted operations',
            allowed_domains: ['monitoring', 'safety', 'automation'],
            allowed_consequence_levels: ['reversible'],
            arm_allowed: false,
          },
        },
        reasoning: 'Industrial: added maintenance ODD profile for scheduled downtime',
      };
    case 'vehicle':
      return {
        profiles: {
          driving: {
            name: 'Driving',
            description: 'Vehicle in motion — restricted to essential operations',
            allowed_domains: ['monitoring', 'safety'],
            allowed_consequence_levels: ['reversible'],
            arm_allowed: false,
          },
          parked: {
            name: 'Parked',
            description: 'Vehicle parked — full comfort operations available',
            allowed_domains: ['comfort', 'entertainment', 'monitoring', 'automation'],
            allowed_consequence_levels: ['reversible', 'irreversible'],
            arm_allowed: true,
          },
        },
        reasoning: 'Vehicle: added driving/parked ODD profiles for motion-based context',
      };
    default:
      return {
        profiles: {},
        reasoning: `${environment}: using default ODD profiles`,
      };
  }
}

// ────────────────────────────────────────────
// Main Generator
// ────────────────────────────────────────────

function generateOverlayDraft(manifest: CustomerManifest): OverlayDraft {
  const reasoning: ReasoningEntry[] = [];

  // Step 1: Device → Action mapping
  const customerActions: string[] = [];
  for (const device of manifest.devices ?? []) {
    const actions = DEVICE_ACTION_MAP[device.device_type] ?? [];
    for (const action of actions) {
      if (!customerActions.includes(action)) {
        customerActions.push(action);
      }
    }
  }
  reasoning.push({
    dimension: 'actions',
    rule: 'device_action_mapping',
    reasoning: `Mapped ${manifest.devices?.length ?? 0} device types to ${customerActions.length} actions`,
  });

  // Step 2: Scene → Interlock inference
  const additionalInterlocks: Array<{ id: string; name: string; reasoning: string }> = [];
  for (const concern of manifest.safety_concerns ?? []) {
    for (const pattern of SAFETY_CONCERN_INTERLOCKS) {
      if (pattern.pattern.test(concern)) {
        additionalInterlocks.push(pattern.interlock);
        reasoning.push({
          dimension: 'interlocks',
          rule: pattern.interlock.id,
          reasoning: pattern.interlock.reasoning,
        });
      }
    }
  }

  // Step 3: Risk preference → param clamp
  const riskPref = manifest.risk_preference ?? 'balanced';
  const paramOverrides: Record<string, unknown[]> = {};

  if (customerActions.includes('thermostat.set_temperature')) {
    const adj = adjustParamForRisk(35, 10, riskPref);
    paramOverrides['thermostat.set_temperature'] = [
      { name: 'temperature', max: adj.max, min: adj.min },
    ];
    reasoning.push({
      dimension: 'param_clamp',
      rule: 'thermostat.set_temperature',
      reasoning: adj.reasoning,
    });
  }

  if (customerActions.includes('light.on')) {
    const adj = adjustParamForRisk(100, 0, riskPref);
    paramOverrides['light.on'] = [
      { name: 'brightness', max: adj.max, min: adj.min },
    ];
    reasoning.push({
      dimension: 'param_clamp',
      rule: 'light.on.brightness',
      reasoning: adj.reasoning,
    });
  }

  // Step 4: ODD Profile suggestion
  const oddSuggestion = suggestOddProfiles(manifest.environment);
  reasoning.push({
    dimension: 'odd_profile',
    rule: 'environment_profiles',
    reasoning: oddSuggestion.reasoning,
  });

  // Step 5: Build overlay drafts
  return {
    constitution_overlay: {
      version: '1.0',
      customer_id: manifest.customer_id,
      overlay_type: 'constitution',
      relevant_actions: customerActions,
      param_overrides: Object.entries(paramOverrides).map(([action, params]) => ({
        action,
        params,
      })),
    },
    interlock_overlay: {
      version: '1.0',
      customer_id: manifest.customer_id,
      overlay_type: 'interlock',
      additional_rules: additionalInterlocks.map((il) => ({
        id: il.id,
        name: il.name,
        description: il.reasoning,
        severity: 'safety_critical',
        override: 'never',
        effect: 'constrains',
        evidence_message: il.reasoning,
      })),
    },
    param_clamp_overlay: {
      version: '1.0',
      customer_id: manifest.customer_id,
      overlay_type: 'param_clamp',
      overrides: paramOverrides,
    },
    odd_profile_overlay: {
      version: '1.0',
      customer_id: manifest.customer_id,
      overlay_type: 'odd_profile',
      overrides: oddSuggestion.profiles,
    },
    reasoning,
  };
}

// ────────────────────────────────────────────
// Tool Export
// ────────────────────────────────────────────

export function createPhysOSRuleAdvisorTool() {
  return {
    name: "physos_rule_advisor",
    label: "PhysOS Rule Advisor",
    description:
      "Generate PhysOS overlay drafts from a customer manifest. " +
      "Analyzes devices, scenes, risk preferences, and safety concerns to produce " +
      "4 overlay files (constitution, interlock, param_clamp, ODD profile) with reasoning.",
    parameters: {
      type: "object" as const,
      properties: {
        manifest: {
          type: "object",
          description: "Customer manifest object with customer_id, devices, scenes, risk_preference, safety_concerns",
        },
      },
      required: ["manifest"],
    },

    async execute(
      _toolCallId: string,
      params: { manifest: CustomerManifest },
    ) {
      try {
        const draft = generateOverlayDraft(params.manifest);

        const summary = [
          `📋 Overlay Draft for ${params.manifest.customer_id}`,
          `  Environment: ${params.manifest.environment}`,
          `  Risk: ${params.manifest.risk_preference ?? 'balanced'}`,
          `  Devices: ${params.manifest.devices?.length ?? 0} types`,
          `  Generated interlocks: ${(draft.interlock_overlay as { additional_rules?: unknown[] }).additional_rules?.length ?? 0}`,
          `  Reasoning entries: ${draft.reasoning.length}`,
          '',
          '📝 Reasoning:',
          ...draft.reasoning.map((r) => `  [${r.dimension}] ${r.rule}: ${r.reasoning}`),
          '',
          '📦 Overlay Drafts (JSON):',
          JSON.stringify(draft, null, 2),
        ].join('\n');

        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ Rule Advisor failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  };
}
