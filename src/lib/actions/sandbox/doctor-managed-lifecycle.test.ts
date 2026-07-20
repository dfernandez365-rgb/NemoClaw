// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../../state/registry";
import { collectManagedLifecycleChecks } from "./doctor-managed-lifecycle";
import type { SandboxCommandResult } from "./process-recovery";

function sandbox(agent: string | null = "hermes"): SandboxEntry {
  return { name: "alpha", agent };
}

function commandResult(status: number, stdout = "", stderr = ""): SandboxCommandResult {
  return { status, stdout, stderr };
}

describe("doctor managed lifecycle checks", () => {
  it.each([
    "openclaw",
    "hermes",
  ])("uses only the bounded read-only controller probe for registered %s sandboxes (#7142)", (agent) => {
    const request = vi.fn(() =>
      commandResult(0, "v1 nonce complete already-running 41 42\nGATEWAY_PID=42"),
    );

    const checks = collectManagedLifecycleChecks("alpha", sandbox(agent), {
      requestGatewaySupervisorActionImpl: request,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("alpha", "probe", 15_000);
    expect(checks).toEqual([
      {
        group: "Sandbox",
        label: "Managed lifecycle",
        status: "ok",
        detail: "supervisor and gateway health proved by the managed controller",
      },
    ]);
  });

  it("preserves the legacy missing-agent default as managed OpenClaw (#7142)", () => {
    const request = vi.fn(() => commandResult(0, "GATEWAY_PID=42"));

    collectManagedLifecycleChecks("alpha", sandbox(null), {
      requestGatewaySupervisorActionImpl: request,
    });

    expect(request).toHaveBeenCalledWith("alpha", "probe", 15_000);
  });

  it("skips unregistered and non-managed agents", () => {
    const request = vi.fn(() => commandResult(0, "GATEWAY_PID=42"));

    expect(
      collectManagedLifecycleChecks("alpha", null, {
        requestGatewaySupervisorActionImpl: request,
      }),
    ).toEqual([]);
    expect(
      collectManagedLifecycleChecks("alpha", sandbox("langchain-deepagents-code"), {
        requestGatewaySupervisorActionImpl: request,
      }),
    ).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "null",
    "throw",
  ])("warns without leaking diagnostics when the probe transport is unavailable (%s)", (failureMode) => {
    const request = vi.fn(() => {
      if (failureMode === "throw") throw new Error("Bearer transport-secret");
      return null;
    });

    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: request,
    });

    expect(checks).toEqual([
      {
        group: "Sandbox",
        label: "Managed lifecycle",
        status: "warn",
        detail: "managed lifecycle probe transport unavailable",
      },
    ]);
    expect(JSON.stringify(checks)).not.toContain("transport-secret");
  });

  it.each([
    "PRIVILEGED_CONTROL_UNAVAILABLE",
    "SUPERVISOR_NOT_RUNNING",
    "SUPERVISOR_REBUILD_REQUIRED",
    "SECRET_BOUNDARY_REFUSED",
    "GATEWAY_UNSAFE_CONFIG_PATH",
    "GATEWAY_CONFIG_HASH_MISMATCH",
    "HERMES_MCP_CONFIG_DRIFT",
  ])("fails on the fixed lifecycle or security refusal %s", (marker) => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () => commandResult(1, "", marker),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: `managed lifecycle probe refused: ${marker}`,
      }),
    ]);
  });

  it("classifies the privileged-control prefix without surfacing its appended exception", () => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(
          1,
          "",
          "PRIVILEGED_CONTROL_UNAVAILABLE: container NVIDIA_API_KEY=secret is unavailable",
        ),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe refused: PRIVILEGED_CONTROL_UNAVAILABLE",
      }),
    ]);
    expect(JSON.stringify(checks)).not.toContain("NVIDIA_API_KEY");
  });

  it("reports only an allowlisted marker and probe stage from hostile output (#7142)", () => {
    const secret = "NVIDIA_API_KEY=do-not-print-this";
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(
          1,
          `Authorization: Bearer stdout-secret`,
          `${secret}\nSUPERVISOR_UNAVAILABLE\nNEMOCLAW_CONTROL_STAGE=preflight\n/path/${secret}`,
        ),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe refused: SUPERVISOR_UNAVAILABLE (stage: preflight)",
      }),
    ]);
    const rendered = JSON.stringify(checks);
    expect(rendered).not.toContain("do-not-print-this");
    expect(rendered).not.toContain("stdout-secret");
    expect(rendered).not.toContain("/path/");
  });

  it("does not surface unrecognized or ambiguous diagnostics", () => {
    const secret = "token=untrusted-secret";
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(
          1,
          "",
          `${secret}\nSUPERVISOR_UNAVAILABLE\nSECRET_BOUNDARY_REFUSED\nNEMOCLAW_CONTROL_STAGE=${secret}`,
        ),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe failed without one trusted diagnostic marker",
      }),
    ]);
    expect(JSON.stringify(checks)).not.toContain("untrusted-secret");
  });

  it("treats exact controller contention as an inconclusive warning", () => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () => commandResult(1, "", "SUPERVISOR_BUSY"),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "warn",
        detail: "managed lifecycle probe is busy; retry after the active controller request",
      }),
    ]);
  });

  it("fails a contradictory successful result that also reports controller contention", () => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(0, "GATEWAY_PID=42", "SUPERVISOR_BUSY"),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe refused: SUPERVISOR_BUSY",
      }),
    ]);
  });

  it("fails closed when success lacks one exact GATEWAY_PID marker", () => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(0, "GATEWAY_PID=42\nGATEWAY_PID=43", "NVIDIA_API_KEY=secret"),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe returned no trusted completion marker",
      }),
    ]);
    expect(JSON.stringify(checks)).not.toContain("NVIDIA_API_KEY");
  });

  it("rejects an extra malformed GATEWAY_PID marker", () => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(0, "GATEWAY_PID=42\nGATEWAY_PID=not-a-pid"),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe returned no trusted completion marker",
      }),
    ]);
  });

  it("does not accept a failure marker alongside a successful PID proof", () => {
    const checks = collectManagedLifecycleChecks("alpha", sandbox(), {
      requestGatewaySupervisorActionImpl: () =>
        commandResult(0, "GATEWAY_PID=42", "SECRET_BOUNDARY_REFUSED"),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "managed lifecycle probe refused: SECRET_BOUNDARY_REFUSED",
      }),
    ]);
  });
});
