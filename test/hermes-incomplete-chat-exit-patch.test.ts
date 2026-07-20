// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for NVIDIA/NemoClaw#7104. Hermes v0.18.0 already marks
// iteration exhaustion as `completed=false`; this compatibility patch makes
// the quiet CLI honor that state and prevents a post-limit model response from
// proposing work that can no longer execute.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-incomplete-chat-exit.py");

function python3Available(): boolean {
  try {
    return spawnSync("python3", ["--version"], { timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

const canRun = process.platform === "linux" && python3Available();
assert(
  !process.env.CI || canRun,
  "Hermes source patch tests require Linux + python3; CI did not provide both",
);

const PINNED_QUIET_EXIT = `                        _exit_code = 0
                        if isinstance(result, dict) and result.get("failed"):
                            _exit_code = 1
                            if os.environ.get("HERMES_KANBAN_TASK") and result.get(
                                "failure_reason"
                            ) in ("rate_limit", "billing"):
                                try:
                                    from hermes_cli.kanban_db import (
                                        KANBAN_RATE_LIMIT_EXIT_CODE as _RL_CODE,
                                    )
                                    _exit_code = _RL_CODE
                                except Exception:
                                    _exit_code = 1
                        sys.exit(_exit_code)`;

const PINNED_STRICT_QUIET_CHAT = `                        try:
                            result = cli.agent.run_conversation(
                                user_message=effective_query,
                                conversation_history=cli.conversation_history,
                            )`;

const PINNED_QUIET_EXHAUSTION = `    if final_response is None and (
        api_call_count >= agent.max_iterations
        or agent.iteration_budget.remaining <= 0
    ):
        # Budget exhausted — ask the model for a summary via one extra
        # API call with tools stripped.  _handle_max_iterations injects a
        # user message and makes a single toolless request.
        _turn_exit_reason = f"max_iterations_reached({api_call_count}/{agent.max_iterations})"
        agent._emit_status(
            f"⚠️ Iteration budget exhausted ({api_call_count}/{agent.max_iterations}) "
            "— asking model to summarise"
        )
        if not agent.quiet_mode:
            agent._safe_print(
                f"\\n⚠️  Iteration budget exhausted ({api_call_count}/{agent.max_iterations}) "
                "— requesting summary..."
            )
        final_response = agent._handle_max_iterations(messages, api_call_count)`;

function writePinnedFixture(root: string): { cli: string; finalizer: string } {
  const cli = path.join(root, "cli.py");
  const finalizer = path.join(root, "agent", "turn_finalizer.py");
  fs.mkdirSync(path.dirname(finalizer), { recursive: true });
  fs.mkdirSync(path.join(root, "hermes_cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "hermes_cli", "__init__.py"), "");
  fs.writeFileSync(
    path.join(root, "hermes_cli", "kanban_db.py"),
    "KANBAN_RATE_LIMIT_EXIT_CODE = 75\n",
  );
  fs.writeFileSync(
    cli,
    [
      "import json",
      "import os",
      "import sys",
      "",
      "def strict_quiet_run(cli, effective_query):",
      PINNED_STRICT_QUIET_CHAT,
      "                        except KeyboardInterrupt:",
      "                            raise",
      "                        return result",
      "",
      "def quiet_exit(result):",
      PINNED_QUIET_EXIT,
      "",
      'if __name__ == "__main__":',
      '    if sys.argv[1] == "__sentinel__":',
      "        class FakeAgent:",
      "            def run_conversation(self, **_kwargs):",
      '                return {"sentinel": self._nemoclaw_strict_quiet_chat}',
      "",
      "        class FakeCli:",
      "            agent = FakeAgent()",
      "            conversation_history = []",
      "",
      '        print(json.dumps(strict_quiet_run(FakeCli(), "query")))',
      "    else:",
      "        quiet_exit(json.loads(sys.argv[1]))",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    finalizer,
    [
      "import json",
      "import sys",
      "",
      "def finalize(agent, final_response, api_call_count, messages):",
      PINNED_QUIET_EXHAUSTION,
      "    return final_response",
      "",
      "class Budget:",
      "    remaining = 0",
      "",
      "class Agent:",
      "    max_iterations = 15",
      "    iteration_budget = Budget()",
      "",
      "    def __init__(self, mode):",
      '        self.quiet_mode = mode != "interactive"',
      '        if mode == "strict":',
      "            self._nemoclaw_strict_quiet_chat = True",
      "        self.summary_calls = 0",
      "",
      "    def _emit_status(self, _message):",
      "        pass",
      "",
      "    def _safe_print(self, _message):",
      "        pass",
      "",
      "    def _handle_max_iterations(self, _messages, _api_call_count):",
      "        self.summary_calls += 1",
      '        return "MODEL_SUMMARY <tool_call>never_run()</tool_call>"',
      "",
      'if __name__ == "__main__":',
      "    agent = Agent(sys.argv[1])",
      "    messages = []",
      "    response = finalize(agent, None, 15, messages)",
      "    print(json.dumps({",
      '        "response": response,',
      '        "summary_calls": agent.summary_calls,',
      '        "messages": messages,',
      "    }))",
      "",
    ].join("\n"),
  );
  return { cli, finalizer };
}

function runPatcher(root: string) {
  return spawnSync("python3", ["-I", PATCHER, root], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function runQuietExit(
  cli: string,
  result: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  return spawnSync("python3", [cli, JSON.stringify(result)], {
    encoding: "utf-8",
    timeout: 5_000,
    env: { ...process.env, ...env },
  });
}

describe.skipIf(!canRun)("Hermes incomplete quiet-chat compatibility patch", () => {
  it("maps complete, incomplete, failed, partial, interrupted, and rate-limited results to trustworthy process status (#7104)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-incomplete-exit-"));
    try {
      const fixture = writePinnedFixture(tmp);
      const first = runPatcher(tmp);
      expect(first.status, first.stderr).toBe(0);

      expect(
        runQuietExit(fixture.cli, { completed: true, failed: false, partial: false }).status,
      ).toBe(0);
      expect(
        runQuietExit(fixture.cli, { completed: false, failed: false, partial: false }).status,
      ).toBe(1);
      expect(runQuietExit(fixture.cli, { completed: false, partial: true }).status).toBe(1);
      expect(runQuietExit(fixture.cli, { completed: false, failed: true }).status).toBe(1);
      expect(runQuietExit(fixture.cli, { completed: false, interrupted: true }).status).toBe(130);
      expect(runQuietExit(fixture.cli, {}).status).toBe(1);
      expect(
        runQuietExit(
          fixture.cli,
          { completed: false, failed: true, failure_reason: "rate_limit" },
          { HERMES_KANBAN_TASK: "task-7104" },
        ).status,
      ).toBe(75);
      expect(
        runQuietExit(fixture.cli, { completed: true, failed: true, partial: false }).status,
      ).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("limits deterministic no-summary output to chat-Q while preserving other quiet callers (#7104)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-incomplete-output-"));
    try {
      const fixture = writePinnedFixture(tmp);
      const patched = runPatcher(tmp);
      expect(patched.status, patched.stderr).toBe(0);

      const sentinel = spawnSync("python3", ["-I", fixture.cli, "__sentinel__"], {
        encoding: "utf-8",
        timeout: 5_000,
      });
      expect(sentinel.status, sentinel.stderr).toBe(0);
      expect(JSON.parse(sentinel.stdout)).toEqual({ sentinel: true });

      const quiet = spawnSync("python3", ["-I", fixture.finalizer, "strict"], {
        encoding: "utf-8",
        timeout: 5_000,
      });
      expect(quiet.status, quiet.stderr).toBe(0);
      const quietResult = JSON.parse(quiet.stdout);
      expect(quietResult.response).toContain("Incomplete: Hermes exhausted its iteration budget");
      expect(quietResult.response).not.toContain("MODEL_SUMMARY");
      expect(quietResult.response).not.toContain("tool_call");
      expect(quietResult.summary_calls).toBe(0);
      expect(quietResult.messages).toEqual([{ role: "assistant", content: quietResult.response }]);

      const genericQuiet = spawnSync("python3", ["-I", fixture.finalizer, "quiet"], {
        encoding: "utf-8",
        timeout: 5_000,
      });
      expect(genericQuiet.status, genericQuiet.stderr).toBe(0);
      const genericQuietResult = JSON.parse(genericQuiet.stdout);
      expect(genericQuietResult.response).toContain("MODEL_SUMMARY");
      expect(genericQuietResult.summary_calls).toBe(1);

      const interactive = spawnSync("python3", ["-I", fixture.finalizer, "interactive"], {
        encoding: "utf-8",
        timeout: 5_000,
      });
      expect(interactive.status, interactive.stderr).toBe(0);
      const interactiveResult = JSON.parse(interactive.stdout);
      expect(interactiveResult.response).toContain("MODEL_SUMMARY");
      expect(interactiveResult.summary_calls).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is byte-idempotent after patching the pinned source shape (#7104)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-patch-idempotent-"));
    try {
      const fixture = writePinnedFixture(tmp);
      expect(runPatcher(tmp).status).toBe(0);
      const once = [fs.readFileSync(fixture.cli), fs.readFileSync(fixture.finalizer)];
      const twice = runPatcher(tmp);
      expect(twice.status, twice.stderr).toBe(0);
      expect(fs.readFileSync(fixture.cli)).toEqual(once[0]);
      expect(fs.readFileSync(fixture.finalizer)).toEqual(once[1]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails atomically when either pinned source shape drifts (#7104)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-patch-drift-"));
    try {
      const fixture = writePinnedFixture(tmp);
      const pristineCli = fs.readFileSync(fixture.cli);
      const driftedFinalizer = fs
        .readFileSync(fixture.finalizer, "utf-8")
        .replace("# Budget exhausted — ask", "# Budget was exhausted — ask");
      fs.writeFileSync(fixture.finalizer, driftedFinalizer);

      const run = runPatcher(tmp);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("quiet iteration exhaustion source shape changed");
      expect(fs.readFileSync(fixture.cli)).toEqual(pristineCli);
      expect(fs.readFileSync(fixture.finalizer, "utf-8")).toBe(driftedFinalizer);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
