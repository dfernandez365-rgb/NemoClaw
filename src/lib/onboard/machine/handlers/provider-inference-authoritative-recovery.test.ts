// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { rebuildProviderFlowOptions } from "../../authoritative-rebuild-target";
import { mintProviderRecoveryReceipt } from "../../rebuild-route-handoff";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./provider-inference";
import {
  type Agent,
  baseOptions,
  baseSelection,
  createDeps,
  type Gpu,
  type Host,
} from "./provider-inference.test-support";

describe("authoritative provider inference recovery", () => {
  it("recovers an onboard-provenanced compatible route for active messaging without a host key (#7256)", async () => {
    const sandboxName = "my-assistant";
    const gatewayName = "nemoclaw";
    const provider = "compatible-endpoint";
    const model = "mock/channels-rebuild";
    const endpointUrl = "https://compatible.example.test/v1";
    const preferredInferenceApi = "openai-completions";
    const session = createSession({
      sandboxName,
      provider,
      model,
      endpointUrl,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi,
    });
    const route = {
      provider,
      model,
      endpointUrl,
      endpointSource: "onboard" as const,
      preferredInferenceApi,
      source: "registry" as const,
    };
    const receipt = mintProviderRecoveryReceipt(
      { sandboxName, gatewayName, provider, model, route },
      { nonce: "nonce-onboard-compatible", expiresAtMs: Number.MAX_SAFE_INTEGER },
    );
    const recovery = rebuildProviderFlowOptions(
      {
        authoritativeResumeConfig: true,
        resume: true,
        recreateSandbox: true,
        onboardLockAlreadyHeld: true,
        targetGatewayName: gatewayName,
        targetGatewayPort: 8080,
        endpointSource: "onboard",
        providerRecoveryReceipt: receipt,
      },
      {
        sandboxName,
        provider,
        model,
        endpointUrl,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi,
        session,
      },
    );
    const setupNim = vi.fn(async (_gpu, _sandbox, _agent, recoverProvider: boolean) =>
      recoverProvider
        ? {
            ...baseSelection,
            model,
            provider,
            endpointUrl,
            endpointSource: "onboard" as const,
            credentialEnv: "COMPATIBLE_API_KEY",
            preferredInferenceApi,
            recoveredFromSandbox: true,
            skipHostInferenceSmoke: true,
            reuseGatewayCredentialWithoutLocalKey: true,
          }
        : {
            ...baseSelection,
            model: "nvidia/build-default",
            provider: "nvidia-prod",
            credentialEnv: "NVIDIA_INFERENCE_API_KEY",
          },
    );
    let recoveryAuthorization: (() => boolean) | undefined;
    const setupInference = vi.fn<
      ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"]["setupInference"]
    >(async (...args) => {
      recoveryAuthorization = args[7]?.isRecordedProviderRecoveryAuthorized;
      return { ok: true };
    });
    const { deps, calls } = createDeps({
      setupNim,
      setupInference,
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });
    calls.complete.mockResolvedValue(session);
    const options = baseOptions(deps, session);

    const result = await handleProviderInferenceState({
      ...options,
      resume: true,
      authoritativeResumeConfig: recovery.authoritativeResumeConfig,
      providerRecoveryReceipt: recovery.providerRecoveryReceipt,
      providerRecoveryReceiptLedger: recovery.providerRecoveryReceiptLedger,
      sandboxName,
      selectedMessagingChannels: ["telegram"],
      initial: {
        ...options.initial,
        provider,
        model,
        endpointUrl,
        endpointSource: "onboard",
        onboardEndpointUrl: endpointUrl,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi,
      },
    });

    expect(setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      sandboxName,
      null,
      true,
      gatewayName,
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
    expect(result).toMatchObject({
      provider,
      model,
      endpointUrl,
      endpointSource: "onboard",
    });
    expect(setupInference).toHaveBeenCalledWith(
      sandboxName,
      model,
      provider,
      endpointUrl,
      "COMPATIBLE_API_KEY",
      null,
      [],
      expect.objectContaining({
        endpointSource: "onboard",
        onboardEndpointUrl: endpointUrl,
        skipHostInferenceSmoke: true,
        reuseGatewayCredentialWithoutLocalKey: true,
        isRecordedProviderRecoveryAuthorized: expect.any(Function),
      }),
    );
    expect(recoveryAuthorization?.()).toBe(true);
    expect(
      setupInference.mock.calls.some(
        ([, , selectedProvider]) => selectedProvider === "nvidia-prod",
      ),
    ).toBe(false);
  });
});
