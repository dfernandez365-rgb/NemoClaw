#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch pinned Hermes v0.18.0 quiet-chat iteration exhaustion semantics.

Source-of-truth note for this localized Hermes runtime patch:
  - Invalid state: Hermes v0.18.0 returns ``completed=False`` after exhausting
    its iteration budget, but ``hermes chat --quiet`` exits non-zero only when
    ``failed`` is true. The command therefore reports success for incomplete
    tool-driven work (NVIDIA/NemoClaw#7104).
  - Unsafe output: the post-limit path asks the model for one more summary.
    Even with tools omitted, that generated text can describe a new action that
    was never executed after the loop stopped.
  - Values being patched: pinned ``/opt/hermes/cli.py`` marks only its
    ``chat -Q`` run as strict, then derives the process status from the
    authoritative result fields. Pinned ``/opt/hermes/agent/turn_finalizer.py``
    emits a deterministic incomplete result instead of another model response
    only for that marked run. Other quiet Hermes surfaces retain their native
    best-effort summaries.
  - Regression test: ``test/hermes-incomplete-chat-exit-patch.test.ts`` proves
    complete, incomplete, partial, failed, and interrupted exit status;
    deterministic quiet exhaustion; exact source-shape drift detection; and
    patch idempotence. The Dockerfile also parses both patched modules at build
    time.
  - Removal condition: delete this patch when the pinned Hermes runtime
    natively exits non-zero for every non-completed quiet run and does not emit
    speculative post-limit actions.
"""

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass
from pathlib import Path

PINNED_HERMES_SEMVER = "0.18.0"


@dataclass(frozen=True)
class Replacement:
    name: str
    relative_path: Path
    old: str
    new: str


QUIET_EXIT_OLD = '''                        _exit_code = 0
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
                        sys.exit(_exit_code)'''

QUIET_EXIT_NEW = '''                        _exit_code = 1
                        if isinstance(result, dict):
                            if result.get("interrupted"):
                                _exit_code = 130
                            elif (
                                result.get("completed") is True
                                and not result.get("failed")
                                and not result.get("partial")
                            ):
                                _exit_code = 0
                            elif (
                                result.get("failed")
                                and os.environ.get("HERMES_KANBAN_TASK")
                                and result.get("failure_reason") in ("rate_limit", "billing")
                            ):
                                try:
                                    from hermes_cli.kanban_db import (
                                        KANBAN_RATE_LIMIT_EXIT_CODE as _RL_CODE,
                                    )
                                    _exit_code = _RL_CODE
                                except Exception:
                                    _exit_code = 1
                        sys.exit(_exit_code)'''

STRICT_QUIET_CHAT_OLD = '''                        try:
                            result = cli.agent.run_conversation(
                                user_message=effective_query,
                                conversation_history=cli.conversation_history,
                            )'''

STRICT_QUIET_CHAT_NEW = '''                        _nemoclaw_quiet_chat_agent = cli.agent
                        _nemoclaw_quiet_chat_agent._nemoclaw_strict_quiet_chat = True
                        try:
                            result = _nemoclaw_quiet_chat_agent.run_conversation(
                                user_message=effective_query,
                                conversation_history=cli.conversation_history,
                            )'''

QUIET_EXHAUSTION_OLD = '''    if final_response is None and (
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
        final_response = agent._handle_max_iterations(messages, api_call_count)'''

QUIET_EXHAUSTION_NEW = '''    if final_response is None and (
        api_call_count >= agent.max_iterations
        or agent.iteration_budget.remaining <= 0
    ):
        _turn_exit_reason = f"max_iterations_reached({api_call_count}/{agent.max_iterations})"
        if getattr(agent, "_nemoclaw_strict_quiet_chat", False):
            # A non-interactive caller needs a trustworthy terminal state, not
            # one more model-generated claim after execution has stopped.
            final_response = (
                "Incomplete: Hermes exhausted its iteration budget "
                f"({api_call_count}/{agent.max_iterations}) before completing the request. "
                "Verify requested artifacts before retrying."
            )
            messages.append({"role": "assistant", "content": final_response})
        else:
            # Every other Hermes caller retains its best-effort narrative summary.
            agent._emit_status(
                f"⚠️ Iteration budget exhausted ({api_call_count}/{agent.max_iterations}) "
                "— asking model to summarise"
            )
            agent._safe_print(
                f"\\n⚠️  Iteration budget exhausted ({api_call_count}/{agent.max_iterations}) "
                "— requesting summary..."
            )
            final_response = agent._handle_max_iterations(messages, api_call_count)'''

REPLACEMENTS = (
    Replacement(
        "strict quiet-chat sentinel",
        Path("cli.py"),
        STRICT_QUIET_CHAT_OLD,
        STRICT_QUIET_CHAT_NEW,
    ),
    Replacement("quiet chat exit status", Path("cli.py"), QUIET_EXIT_OLD, QUIET_EXIT_NEW),
    Replacement(
        "quiet iteration exhaustion",
        Path("agent/turn_finalizer.py"),
        QUIET_EXHAUSTION_OLD,
        QUIET_EXHAUSTION_NEW,
    ),
)


def _replace_exactly_once(source: str, replacement: Replacement) -> tuple[str, bool]:
    old_count = source.count(replacement.old)
    new_count = source.count(replacement.new)
    if old_count == 0 and new_count == 1:
        return source, False
    if old_count != 1 or new_count != 0:
        raise SystemExit(
            f"ERROR: Hermes {replacement.name} source shape changed; "
            f"expected one unpatched block or one patched block, found "
            f"unpatched={old_count}, patched={new_count}"
        )
    return source.replace(replacement.old, replacement.new, 1), True


def patch_root(root: Path) -> None:
    changed_paths: set[Path] = set()
    sources: dict[Path, str] = {}

    for replacement in REPLACEMENTS:
        path = root / replacement.relative_path
        source = sources.get(path)
        if source is None:
            source = path.read_text(encoding="utf-8")
        source, changed = _replace_exactly_once(source, replacement)
        sources[path] = source
        if changed:
            changed_paths.add(path)

    for path, source in sources.items():
        ast.parse(source, filename=str(path))

    for path, source in sources.items():
        if path in changed_paths:
            path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "root",
        nargs="?",
        default="/opt/hermes",
        help="Hermes source root to patch",
    )
    args = parser.parse_args()
    patch_root(Path(args.root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
