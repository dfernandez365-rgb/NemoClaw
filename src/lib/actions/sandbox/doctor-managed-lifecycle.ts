// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import type { SandboxEntry } from "../../state/registry";
import type { DoctorCheck } from "./doctor-report";
import { executeGatewaySupervisorAction, type SandboxCommandResult } from "./process-recovery";

type ManagedLifecycleProbeDeps = {
  requestGatewaySupervisorActionImpl?: typeof executeGatewaySupervisorAction;
};

const MANAGED_LIFECYCLE_AGENTS = new Set(["openclaw", "hermes"]);

// Fixed diagnostics emitted by scripts/gateway-control.sh and
// scripts/managed-gateway-control.py. Never surface unclassified controller
// output: Docker and subprocess failures can contain host paths or environment
// material that does not belong in doctor JSON.
const MANAGED_LIFECYCLE_FAILURE_MARKERS = new Set([
  "PRIVILEGED_CONTROL_UNAVAILABLE",
  "SUPERVISOR_REBUILD_REQUIRED",
  "SUPERVISOR_UNAVAILABLE",
  "SUPERVISOR_NOT_RUNNING",
  "SUPERVISOR_BUSY",
  "SUPERVISOR_INVALID_REQUEST",
  "SUPERVISOR_INVALID_ACTION",
  "SUPERVISOR_INVALID_NONCE",
  "SUPERVISOR_UNSAFE_CONTROL_DIR",
  "SUPERVISOR_SIGNAL_FAILED",
  "SUPERVISOR_INVALID_STATUS",
  "SUPERVISOR_TIMEOUT",
  "SECRET_BOUNDARY_VALIDATOR_MISSING",
  "SECRET_BOUNDARY_REFUSED",
  "GATEWAY_UNSAFE_CONFIG_PATH",
  "GATEWAY_CONFIG_HASH_MISMATCH",
  "HERMES_MCP_CONFIG_DRIFT",
  "GATEWAY_GUARDS_MISSING",
  "GATEWAY_HEALTH_TIMEOUT",
  "GATEWAY_FAILED",
]);

// A probe returns before every mutating controller stage. Restricting this
// allowlist to probe-reachable stages makes an impossible or forged stage
// non-diagnostic instead of accidentally expanding the public output surface.
const MANAGED_LIFECYCLE_PROBE_STAGES = new Set([
  "detect-agent",
  "discover-supervisor",
  "initial-gateway-proof",
  "preflight",
]);

const GATEWAY_PID_LINE = /^GATEWAY_PID=[1-9][0-9]*$/;
const CONTROL_STAGE_PREFIX = "NEMOCLAW_CONTROL_STAGE=";
const PRIVILEGED_CONTROL_PREFIX = "PRIVILEGED_CONTROL_UNAVAILABLE:";

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function trustedFailureMarkers(result: SandboxCommandResult): string[] {
  return [
    ...new Set(
      nonEmptyLines(result.stderr)
        .map((line) => {
          if (MANAGED_LIFECYCLE_FAILURE_MARKERS.has(line)) return line;
          // The host adapter appends a local exception after this fixed
          // prefix. Classify the marker, never the exception text.
          if (line.startsWith(PRIVILEGED_CONTROL_PREFIX)) {
            return "PRIVILEGED_CONTROL_UNAVAILABLE";
          }
          return null;
        })
        .filter((line): line is string => line !== null),
    ),
  ];
}

function trustedControlStage(result: SandboxCommandResult): string | null {
  const stages = [
    ...new Set(
      nonEmptyLines(result.stderr)
        .filter((line) => line.startsWith(CONTROL_STAGE_PREFIX))
        .map((line) => line.slice(CONTROL_STAGE_PREFIX.length))
        .filter((stage) => MANAGED_LIFECYCLE_PROBE_STAGES.has(stage)),
    ),
  ];
  return stages.length === 1 ? stages[0] : null;
}

function hasTrustedGatewayPid(result: SandboxCommandResult): boolean {
  const pidLines = nonEmptyLines(result.stdout).filter((line) => line.startsWith("GATEWAY_PID="));
  return result.status === 0 && pidLines.length === 1 && GATEWAY_PID_LINE.test(pidLines[0] ?? "");
}

function unavailableManagedLifecycleCheck(): DoctorCheck {
  return {
    group: "Sandbox",
    label: "Managed lifecycle",
    status: "warn",
    detail: "managed lifecycle probe transport unavailable",
  };
}

function classifyManagedLifecycleProbe(result: SandboxCommandResult): DoctorCheck {
  const markers = trustedFailureMarkers(result);
  if (hasTrustedGatewayPid(result) && markers.length === 0) {
    return {
      group: "Sandbox",
      label: "Managed lifecycle",
      status: "ok",
      detail: "supervisor and gateway health proved by the managed controller",
    };
  }

  const marker = markers.length === 1 ? markers[0] : null;
  const stage = trustedControlStage(result);
  if (marker === "SUPERVISOR_BUSY" && result.status !== 0) {
    return {
      group: "Sandbox",
      label: "Managed lifecycle",
      status: "warn",
      detail: "managed lifecycle probe is busy; retry after the active controller request",
    };
  }
  if (marker) {
    const stageDetail = marker === "SUPERVISOR_UNAVAILABLE" && stage ? ` (stage: ${stage})` : "";
    return {
      group: "Sandbox",
      label: "Managed lifecycle",
      status: "fail",
      detail: `managed lifecycle probe refused: ${marker}${stageDetail}`,
    };
  }
  return {
    group: "Sandbox",
    label: "Managed lifecycle",
    status: "fail",
    detail:
      result.status === 0
        ? "managed lifecycle probe returned no trusted completion marker"
        : "managed lifecycle probe failed without one trusted diagnostic marker",
  };
}

/** Read-only proof that a registered built-in gateway still honors managed lifecycle control. */
export function collectManagedLifecycleChecks(
  sandboxName: string,
  entry: SandboxEntry | null | undefined,
  deps: ManagedLifecycleProbeDeps = {},
): DoctorCheck[] {
  if (!entry || !MANAGED_LIFECYCLE_AGENTS.has(entry.agent ?? "openclaw")) return [];

  const request = deps.requestGatewaySupervisorActionImpl ?? executeGatewaySupervisorAction;
  let result: SandboxCommandResult | null;
  try {
    result = request(sandboxName, "probe", OPENSHELL_PROBE_TIMEOUT_MS);
  } catch {
    result = null;
  }
  return [result ? classifyManagedLifecycleProbe(result) : unavailableManagedLifecycleCheck()];
}
