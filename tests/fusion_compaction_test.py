#!/usr/bin/env python3
"""Offline Pi-Bolt regression: Fusion must not pre-compact before routing."""

import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "dot-pi/agent/extensions/copilot-fusion.ts"
HELPER = ROOT / "dot-pi/agent/extensions/shared/copilot-fusion-router.ts"
AUTH_HELPER = ROOT / "dot-pi/agent/extensions/shared/copilot-fusion-auth.ts"
FIXTURE = ROOT / "tests/fusion-compaction-fixture.ts"
SMART = ROOT / "plugins/pi-smart-compaction/index.ts"
# plugins/* are git submodules, and a linked worktree starts with them empty even
# when the main clone has them populated (that is how an agent's gate checkout is
# made). The two smart-compaction scenarios below need that source; the other
# eleven do not. Skip them by name so a bare worktree reports "2 skipped" instead
# of dying on a missing file, and never let the skip pass for coverage.
SMART_MISSING = ("plugins/pi-smart-compaction is an uninitialized submodule "
                 "(run: git submodule update --init)")


class Rpc:
    def __init__(self, process):
        self.process = process
        self.buffer = b""

    def send(self, value):
        self.process.stdin.write(json.dumps(value).encode() + b"\n")
        self.process.stdin.flush()

    def read(self):
        deadline = time.monotonic() + 30
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise TimeoutError("Pi RPC did not respond")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("Pi RPC closed unexpectedly")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def response(self, request_id):
        while True:
            record = self.read()
            if record.get("id") == request_id:
                if not record.get("success"):
                    raise RuntimeError(record.get("error", "RPC request failed"))
                return record

    def prompt(self, request_id, message, allow_retry=False, allow_error=False):
        self.send({"id": request_id, "type": "prompt", "message": message})
        reasons = []
        while True:
            record = self.read()
            if record.get("type") == "message_end" and record.get("message", {}).get("role") == "assistant":
                assistant = record["message"]
                reasons.append(assistant.get("stopReason"))
                if assistant.get("stopReason") == "error" and not allow_retry and not allow_error:
                    raise RuntimeError(assistant.get("errorMessage", "model error"))
            if record.get("type") == "agent_settled":
                if allow_retry and (not reasons or reasons[-1] != "stop"):
                    raise RuntimeError(f"Retry did not complete successfully: {reasons}")
                return reasons


@unittest.skipUnless(shutil.which("pi-bolt"), "pi-bolt is not installed")
class FusionCompactionIntegration(unittest.TestCase):
    def run_scenario(self, with_guard, manual_compact=False, smart=False, old_smart=False, routed_model="large-fixture", overflow=False, prompt_limit=None, stale_overflow=False, last_usage=None, second_turn=False, retry=False):
        with tempfile.TemporaryDirectory(prefix="pi-fusion-compaction-") as temp:
            source = EXTENSION
            if not with_guard:
                # Negative control: prove this fixture really would compact without the guard.
                code = EXTENSION.read_text()
                start = code.index('  pi.on("session_before_compact",')
                end = code.index('  pi.on("session_shutdown",', start)
                code = code[:start] + code[end:]
                code = code.replace('"./shared/copilot-fusion-router"', json.dumps(str(HELPER)))
                code = code.replace('"./shared/copilot-fusion-auth"', json.dumps(str(AUTH_HELPER)))
                source = Path(temp) / "unguarded.ts"
                source.write_text(code)
            env = os.environ.copy()
            env["PI_CODING_AGENT_DIR"] = temp
            (Path(temp) / "auth.json").write_text(json.dumps({"github-copilot": {"type": "api_key", "key": "fake-copilot-token"}}))
            env["FUSION_TEST_SMALL_PREVIOUS"] = "1"
            env["FUSION_TEST_ROUTED_MODEL"] = routed_model
            env["FUSION_TEST_OVERFLOW"] = "1" if overflow else "0"
            env["FUSION_TEST_RETRY"] = "1" if retry else "0"
            env["FUSION_TEST_OLD_OVERFLOW"] = "1" if stale_overflow else "0"
            if last_usage is not None:
                env["FUSION_TEST_LAST_USAGE"] = str(last_usage)
            else:
                env.pop("FUSION_TEST_LAST_USAGE", None)
            if prompt_limit is not None:
                env["FUSION_TEST_PROMPT_LIMIT"] = str(prompt_limit)
            else:
                env.pop("FUSION_TEST_PROMPT_LIMIT", None)
            smart_args = []
            smart_config = Path(temp) / "smart-config.json"
            if smart:
                smart_source = SMART
                if old_smart:
                    code = SMART.read_text().replace(" || isFusionStandard(ctx)", "")
                    code = code.replace('"./config.js"', json.dumps(str(SMART.parent / "config.ts")))
                    code = code.replace('"./decision.js"', json.dumps(str(SMART.parent / "decision.ts")))
                    smart_source = Path(temp) / "old-smart.ts"
                    smart_source.write_text(code)
                smart_config.write_text(json.dumps({"enabled": False}))
                env["PI_SMART_COMPACTION_CONFIG"] = str(smart_config)
                smart_args = ["--extension", str(smart_source)]
            args = ["pi-bolt", "--offline", "--no-extensions", "--no-mcp", "--no-tools",
                    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session",
                    "--extension", str(FIXTURE), *smart_args, "--extension", str(source), "--models",
                    "context-probe/previous,github-copilot/small-fixture,github-copilot/large-fixture,copilot-fusion/standard",
                    "--model", "context-probe/previous", "--system-prompt", "Be concise.", "--mode", "rpc"]
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            logs = []

            def capture_stderr():
                for line in process.stderr:
                    text = line.decode(errors="replace").strip()
                    if "FIXTURE_" in text:
                        logs.append(text)

            thread = threading.Thread(target=capture_stderr, daemon=True)
            thread.start()
            rpc = Rpc(process)
            try:
                rpc.send({"id": "disable", "type": "set_auto_compaction", "enabled": False})
                rpc.response("disable")
                original = "x " * 50_000
                for index in range(3):
                    rpc.prompt(f"initial-{index}", original)
                if stale_overflow:
                    self.assertEqual(rpc.prompt("old-overflow", original, allow_error=True), ["error"])
                rpc.send({"id": "switch", "type": "set_model", "provider": "copilot-fusion", "modelId": "standard"})
                rpc.response("switch")
                rpc.send({"id": "enable", "type": "set_auto_compaction", "enabled": True})
                rpc.response("enable")
                rpc.send({"id": "before", "type": "get_session_stats"})
                before = rpc.response("before")["data"]["contextUsage"]
                self.assertGreater(before["tokens"], before["contextWindow"] * 0.9)
                if smart:
                    smart_config.write_text(json.dumps({"enabled": True, "contextFloorTokens": 1,
                                                        "idleThresholdMs": 1, "notify": False, "status": False}))
                    time.sleep(0.02)  # Simulate an idle resume, not a background-job poll.
                reasons = rpc.prompt("fusion", "Continue without summarizing.", allow_retry=overflow or retry)
                rpc.send({"id": "entries", "type": "get_entries"})
                entries = rpc.response("entries")["data"]["entries"]
                rpc.send({"id": "after", "type": "get_session_stats"})
                after = rpc.response("after")["data"]["contextUsage"]
                user_texts = ["".join(part.get("text", "") for part in entry["message"]["content"])
                              for entry in entries if entry.get("type") == "message"
                              and entry.get("message", {}).get("role") == "user"]
                serialized = json.dumps(entries)
                rpc.send({"id": "available", "type": "get_available_models"})
                available = rpc.response("available")["data"]["models"]
                private_models = [model["id"] for model in available if model.get("provider") == "copilot-fusion"
                                  and model.get("id") != "standard"]
                result = {"compactions": sum(entry.get("type") == "compaction" for entry in entries),
                          "after": after, "originals": user_texts.count(original), "reasons": reasons,
                          "privateModels": private_models, "tokenLeaked": "fixture-token" in serialized,
                          "dispatchPersisted": "dispatch-" in serialized}
                if second_turn:
                    rpc.prompt("second-fusion", "Continue again.")
                    rpc.send({"id": "after-second", "type": "get_entries"})
                    updated = rpc.response("after-second")["data"]["entries"]
                    result["secondCompactions"] = sum(entry.get("type") == "compaction" for entry in updated)
                if manual_compact:
                    rpc.send({"id": "manual", "type": "compact"})
                    rpc.response("manual")
                    rpc.send({"id": "after-manual", "type": "get_entries"})
                    updated = rpc.response("after-manual")["data"]["entries"]
                    result["manualCompactions"] = sum(entry.get("type") == "compaction" for entry in updated)
                return result
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                thread.join(timeout=1)
                process.stdout.close()
                process.stderr.close()
                self.logs = logs

    def test_guard_preserves_context_until_model_is_routed(self):
        result = self.run_scenario(with_guard=True)
        self.assertIn("FIXTURE_COMPACTION:threshold", self.logs)
        self.assertIn("FIXTURE_ROUTE", self.logs)
        self.assertEqual(result["compactions"], 0)
        self.assertEqual(result["originals"], 3)
        self.assertEqual(result["after"]["contextWindow"], 1_000_000)
        self.assertEqual(result["privateModels"], [])
        self.assertFalse(result["tokenLeaked"])
        self.assertFalse(result["dispatchPersisted"])

    def test_old_model_overflow_does_not_compact_before_fusion_routes(self):
        result = self.run_scenario(with_guard=True, stale_overflow=True)
        self.assertIn("FIXTURE_COMPACTION:overflow", self.logs)
        self.assertLess(self.logs.index("FIXTURE_COMPACTION:overflow"), self.logs.index("FIXTURE_ROUTE"))
        self.assertEqual(result["compactions"], 0)
        self.assertEqual(result["reasons"], ["stop"])

    def test_compacts_automatically_after_routing_to_a_smaller_model(self):
        result = self.run_scenario(with_guard=True, routed_model="small-fixture")
        route = self.logs.index("FIXTURE_ROUTE")
        attempts = [index for index, value in enumerate(self.logs) if value == "FIXTURE_COMPACTION:threshold"]
        self.assertTrue(any(index < route for index in attempts), "expected a cancelled pre-route check")
        self.assertTrue(any(index > route for index in attempts), "expected compaction after routing")
        self.assertGreaterEqual(result["compactions"], 1)
        self.assertEqual(result["after"]["contextWindow"], 100_000)

    def test_threshold_compaction_waits_for_the_next_model_selection(self):
        result = self.run_scenario(with_guard=True, last_usage=950_000, second_turn=True)
        self.assertEqual(result["compactions"], 0, "post-response threshold should not discard context")
        self.assertGreaterEqual(result["secondCompactions"], 1, "next selected model needs compaction")
        routes = [index for index, value in enumerate(self.logs) if value == "FIXTURE_ROUTE"]
        self.assertGreaterEqual(len(routes), 2)
        attempts = [index for index, value in enumerate(self.logs) if value == "FIXTURE_COMPACTION:threshold"]
        self.assertTrue(any(index > routes[1] for index in attempts))

    def test_compaction_uses_the_selected_models_prompt_limit(self):
        result = self.run_scenario(with_guard=True, prompt_limit=100_000)
        route = self.logs.index("FIXTURE_ROUTE")
        attempts = [index for index, value in enumerate(self.logs) if value == "FIXTURE_COMPACTION:threshold"]
        self.assertTrue(any(index > route for index in attempts), "expected compaction after the prompt limit was known")
        self.assertGreaterEqual(result["compactions"], 1)
        # The footer reports the physical model's total window, not the input cap.
        self.assertEqual(result["after"]["contextWindow"], 1_000_000)

    def test_overflow_recovery_compacts_after_routing_and_retries(self):
        result = self.run_scenario(with_guard=True, overflow=True)
        self.assertEqual(result["reasons"], ["error", "stop"])
        self.assertIn("FIXTURE_COMPACTION:overflow", self.logs)
        self.assertLess(self.logs.index("FIXTURE_ROUTE"), self.logs.index("FIXTURE_COMPACTION:overflow"))
        self.assertGreaterEqual(result["compactions"], 1)
        self.assertFalse(result["tokenLeaked"])
        self.assertFalse(result["dispatchPersisted"])

    def test_transient_error_retries_without_losing_fusion_session(self):
        result = self.run_scenario(with_guard=True, retry=True)
        self.assertEqual(result["reasons"], ["error", "stop"])
        self.assertEqual(result["compactions"], 0)
        self.assertEqual(self.logs.count("FIXTURE_ROUTE"), 1)
        self.assertFalse(result["tokenLeaked"])
        self.assertFalse(result["dispatchPersisted"])

    def test_manual_compaction_still_works(self):
        result = self.run_scenario(with_guard=True, manual_compact=True)
        self.assertEqual(result["compactions"], 0)
        self.assertEqual(result["manualCompactions"], 1)

    @unittest.skipIf(not SMART.exists(), SMART_MISSING)
    def test_smart_compaction_does_not_pre_compact_fusion(self):
        result = self.run_scenario(with_guard=True, smart=True)
        self.assertNotIn("FIXTURE_COMPACTION:manual", self.logs)
        self.assertEqual(result["compactions"], 0)
        self.assertEqual(result["originals"], 3)

    @unittest.skipIf(not SMART.exists(), SMART_MISSING)
    def test_unpatched_smart_compaction_would_pre_compact(self):
        result = self.run_scenario(with_guard=True, smart=True, old_smart=True)
        self.assertIn("FIXTURE_COMPACTION:manual", self.logs)
        self.assertGreaterEqual(result["compactions"], 1)

    def test_tool_continuations_compact_after_routing_and_keep_the_same_session(self):
        with tempfile.TemporaryDirectory(prefix="pi-fusion-tools-") as temp:
            env = os.environ.copy()
            env.update({"PI_CODING_AGENT_DIR": temp, "FUSION_TEST_TOOL_LOOP": "1", "FUSION_TEST_ROUTED_MODEL": "small-fixture"})
            (Path(temp) / "auth.json").write_text(json.dumps({"github-copilot": {"type": "api_key", "key": "fake-copilot-token"}}))
            args = ["pi-bolt", "--offline", "--no-extensions", "--no-mcp", "--tools", "fusion_fixture_tool",
                    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session",
                    "--extension", str(FIXTURE), "--extension", str(EXTENSION), "--models",
                    "github-copilot/small-fixture,copilot-fusion/standard", "--model", "copilot-fusion/standard",
                    "--system-prompt", "Use the fixture tool.", "--mode", "rpc"]
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            logs = []
            def capture_stderr():
                for line in process.stderr:
                    text = line.decode(errors="replace").strip()
                    if "FIXTURE_" in text:
                        logs.append(text)
            thread = threading.Thread(target=capture_stderr, daemon=True)
            thread.start()
            rpc = Rpc(process)
            try:
                reasons = rpc.prompt("tool-loop", "Use the fixture tool.")
                rpc.send({"id": "entries", "type": "get_entries"})
                entries = rpc.response("entries")["data"]["entries"]
                self.assertEqual(reasons, ["toolUse", "toolUse", "toolUse", "stop"])
                self.assertGreaterEqual(sum(entry.get("type") == "compaction" for entry in entries), 1)
                serialized = json.dumps(entries)
                self.assertNotIn("fixture-token", serialized)
                self.assertNotIn("dispatch-", serialized)
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                thread.join(timeout=1)
                process.stdout.close()
                process.stderr.close()
            self.assertEqual(logs.count("FIXTURE_ROUTE"), 1, f"unexpected re-routing: {logs}")
            self.assertIn("FIXTURE_COMPACTION:threshold", logs)
            self.assertLess(logs.index("FIXTURE_ROUTE"), logs.index("FIXTURE_COMPACTION:threshold"))

    def test_resume_restores_fusion_without_persisting_dispatch_tokens(self):
        with tempfile.TemporaryDirectory(prefix="pi-fusion-resume-") as temp:
            env = os.environ.copy()
            config = Path(temp) / "config"
            config.mkdir()
            env["PI_CODING_AGENT_DIR"] = str(config)
            (config / "auth.json").write_text(json.dumps({"github-copilot": {"type": "api_key", "key": "fake-copilot-token"}}))
            session = str(Path(temp) / "session.jsonl")
            args = ["pi-bolt", "--offline", "--no-extensions", "--no-mcp", "--no-tools",
                    "--no-context-files", "--no-skills", "--no-prompt-templates", "--session", session,
                    "--extension", str(FIXTURE), "--extension", str(EXTENSION), "--models",
                    "context-probe/previous,github-copilot/small-fixture,github-copilot/large-fixture,copilot-fusion/standard",
                    "--system-prompt", "Be concise.", "--mode", "rpc"]

            def run(extra, resume):
                process = subprocess.Popen(args + extra, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, env=env)
                rpc = Rpc(process)
                try:
                    if not resume:
                        rpc.prompt("initial", "Start a session.")
                        rpc.send({"id": "switch", "type": "set_model", "provider": "copilot-fusion", "modelId": "standard"})
                        rpc.response("switch")
                    else:
                        rpc.send({"id": "state", "type": "get_state"})
                        state = rpc.response("state")["data"]
                        selected = state["model"]
                        self.assertEqual(state.get("sessionFile"), session, f"unexpected session state: {state}")
                        rpc.send({"id": "available", "type": "get_available_models"})
                        available = rpc.response("available")["data"]["models"]
                        names = [(model.get("provider"), model.get("id")) for model in available]
                        self.assertTrue(Path(session).exists(), f"session vanished, directory={list(Path(temp).iterdir())}")
                        raw = [json.loads(line) for line in Path(session).read_text().splitlines() if line.strip()]
                        tail = [(entry.get("type"), entry.get("provider"), entry.get("modelId"), entry.get("message", {}).get("provider"), entry.get("message", {}).get("model")) for entry in raw[-8:]]
                        self.assertEqual((selected["provider"], selected["id"]), ("copilot-fusion", "standard"), f"available={names}, tail={tail}")
                    rpc.prompt("fusion", "Continue.")
                    rpc.send({"id": "entries", "type": "get_entries"})
                    entries = rpc.response("entries")["data"]["entries"]
                    serialized = json.dumps(entries)
                    self.assertTrue(any(entry.get("type") == "model_change" and entry.get("provider") == "copilot-fusion" and entry.get("modelId") == "standard" for entry in entries), "Fusion selection was not recorded")
                    self.assertNotIn("fixture-token", serialized)
                    self.assertNotIn("dispatch-", serialized)
                    self.assertIn('"copilot-fusion"', Path(session).read_text())
                    if resume:
                        rpc.send({"id": "clone", "type": "clone"})
                        self.assertFalse(rpc.response("clone")["data"]["cancelled"])
                        rpc.send({"id": "cloned-state", "type": "get_state"})
                        cloned = rpc.response("cloned-state")["data"]["model"]
                        self.assertEqual((cloned["provider"], cloned["id"]), ("copilot-fusion", "standard"))
                        rpc.prompt("cloned-fusion", "Continue on the cloned branch.")
                finally:
                    try:
                        process.stdin.close()
                    except BrokenPipeError:
                        pass
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    process.stdout.close()

            run(["--model", "context-probe/previous"], resume=False)
            persisted = [json.loads(line) for line in Path(session).read_text().splitlines() if line.strip()]
            changes = [(entry.get("provider"), entry.get("modelId")) for entry in persisted if entry.get("type") == "model_change"]
            self.assertEqual(changes[-1], ("copilot-fusion", "standard"), f"persisted selection sequence: {changes}")
            run([], resume=True)

    def test_control_would_compact_before_the_normal_request(self):
        result = self.run_scenario(with_guard=False)
        self.assertIn("FIXTURE_COMPACTION:threshold", self.logs)
        self.assertLess(self.logs.index("FIXTURE_COMPACTION:threshold"), self.logs.index("FIXTURE_ROUTE"))
        self.assertGreaterEqual(result["compactions"], 1)


if __name__ == "__main__":
    unittest.main()
