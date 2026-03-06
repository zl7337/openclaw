---
name: physos-controller
description: Control PhysOS cyber-physical devices through governance pipeline
---

# PhysOS Controller

You have access to a **PhysOS cyber-physical governance system** that controls real-world devices (lights, locks, thermostats, robots, drones, etc.) through a safety-first 5-Gate Pipeline.

## 5-Gate Pipeline

Every action goes through 5 governance gates:
1. **Intent Validation** — schema check, source authentication
2. **Capability Check** — adapter online, capability available
3. **Policy Evaluation** — 6-layer governance (Identity → Action → Param → Context → Conflict → Explain)
4. **HITL Confirmation** — human-in-the-loop for irreversible/safety_critical actions
5. **Execution Readiness** — final pre-flight check before execution

## Available Tools

### physos_submit
Submit an action intent. Default mode is `plan_only` (dry-run). Use `armed_live` for real execution.

### physos_query
Query system status: `health`, `adapters`, `trace`, `intent`, `constitution`.

### physos_arm
Manage ARM tokens. **Required before executing `armed_live` + `safety_critical` actions.** Tokens expire after 5 minutes.

## Action Quick Reference (Constitution v1.3 — 40 actions)

### Comfort Domain
| Action | Consequence | Notes |
|--------|-------------|-------|
| light.on | reversible | brightness 0-100%, color_temp 2700-6500K |
| light.off | reversible | |
| light.dim | reversible | brightness 0-100%, transition_ms 0-10000 |
| thermostat.set_temperature | reversible | 10-35°C |
| fan.on | reversible | |
| fan.off | reversible | |
| fan.set_speed | reversible | speed 1-5 |
| curtain.open | reversible | position 0-100% |
| curtain.close | reversible | |
| speaker.set_volume | reversible | |
| ac.set_mode | reversible | |
| humidifier.set_level | reversible | |

### Security Domain
| Action | Consequence | Notes |
|--------|-------------|-------|
| lock.lock | irreversible | |
| lock.unlock | **safety_critical** | ⚠️ Requires HITL + ARM |
| alarm.arm | reversible | |
| alarm.disarm | irreversible | |

### Health Domain
| Action | Consequence | Notes |
|--------|-------------|-------|
| air_purifier.on | reversible | |

### Task Domain
| Action | Consequence | Notes |
|--------|-------------|-------|
| robot.move | irreversible | speed 0-2 m/s, duration 100-60000ms |
| robot.dock | reversible | |
| arm.move_joint | **safety_critical** | ⚠️ Requires HITL + ARM. joint 0-6, angle ±180° |
| vacuum.start | reversible | |
| vacuum.dock | reversible | |

### Mode Domain
| Action | Consequence | Notes |
|--------|-------------|-------|
| system.set_mode | reversible | mode: home/away/sleep/vacation |

### System Domain
| Action | Consequence | Notes |
|--------|-------------|-------|
| system.estop_activate | **safety_critical** | ⚠️ Emergency stop — locks ALL actions |
| system.estop_deactivate | **safety_critical** | ⚠️ Requires HITL + ARM to release |

### Drone Domain (v1.3)
| Action | Consequence | Notes |
|--------|-------------|-------|
| drone.takeoff | **safety_critical** | ⚠️ Weather interlock IL-006, battery check IL-007 |
| drone.land | irreversible | |
| drone.navigate_to | irreversible | altitude 1-120m, speed 0-15 m/s |
| drone.return_home | reversible | |

### Digital Domain (v1.3)
| Action | Consequence | Notes |
|--------|-------------|-------|
| digital.browser_open | reversible | url parameter |
| digital.browser_click | reversible | selector parameter |
| digital.send_message | irreversible | to, body parameters |
| digital.run_script | **safety_critical** | ⚠️ Double HITL: PhysOS gate + OpenClaw exec-approval |
| digital.file_operation | irreversible | path, content parameters |

### Dock Domain (v1.3)
| Action | Consequence | Notes |
|--------|-------------|-------|
| dock.charge_start | reversible | |
| dock.charge_stop | reversible | |
| dock.swap_battery | irreversible | |
| dock.health_check | reversible | |
| dock.assign_device | reversible | |

## Usage Rules

1. **Always query first**: Use `physos_query` with `query_type: "adapters"` to verify target device is online before submitting actions.
2. **Start with plan_only**: Default `execution_mode` is `plan_only`. Only use `armed_live` when user explicitly confirms execution.
3. **ARM before safety_critical**: For `safety_critical` actions, call `physos_arm` with `arm_action: "request"` first.
4. **Read denial reasons**: If a submit is rejected, the denial includes `reason_code`, `reason_human`, and `suggestions`. Follow the suggestions.
5. **Never bypass gates**: Do not attempt to work around denied actions. The 5-gate pipeline exists for safety.
6. **Respect interlocks**: Gas leak → no ignition. E-Stop → only deactivate. Driving → no dashboard. These are non-overridable.
7. **digital.run_script warning**: This action triggers dual HITL confirmation (PhysOS governance + OpenClaw exec-approval-manager). Expect two confirmation prompts.
