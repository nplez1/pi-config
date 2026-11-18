#!/usr/bin/env python3
"""Exercise the normally discovered /long-context command on real Pi-Bolt transports."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from contextlib import contextmanager

from fusion_compaction_test import Rpc

ROOT = Path(__file__).resolve().parents[1]
VERSION = "2026-08-01"
MODELS = {
    "fixture-messages": ("anthropic-messages", "/v1/messages"),
    "fixture-completions": ("openai-completions", "/chat/completions"),
    "fixture-responses": ("openai-responses", "/responses"),
    "fixture-no-tier": ("openai-responses", "/responses"),
}


@unittest.skipUnless(shutil.which("pi-bolt"), "pi-bolt is not installed")
class CopilotLongContextIntegration(unittest.TestCase):
    @contextmanager
    def start_pi(self):
        with tempfile.TemporaryDirectory(prefix="pi-long-context-") as temp:
            agent_dir = Path(temp)
            extensions = agent_dir / "extensions"
            extensions.mkdir()
            source = ROOT / "dot-pi/agent/extensions"
            shutil.copyfile(source / "copilot-long-context.ts", extensions / "copilot-long-context.ts")
            (extensions / "shared").mkdir()
            shutil.copyfile(source / "shared/copilot-long-context.ts", extensions / "shared/copilot-long-context.ts")
            model_file = agent_dir / "models.json"
            def model(id, api):
                return {"id": id, "api": api, "contextWindow": 200_000, "maxTokens": 128_000,
                        "reasoning": True, "headers": {"X-Test-Extra": "kept"}}

            models_json = json.dumps({"providers": {
                "github-copilot": {"models": [model(id, api) for id, (api, _) in MODELS.items()]},
                "outside": {"baseUrl": "https://example.invalid", "apiKey": "fake", "models": [model("outside", "openai-responses")]},
            }})
            model_file.write_text(models_json)
            env = dict(os.environ, PI_CODING_AGENT_DIR=temp, COPILOT_GITHUB_TOKEN="local-wire-check")
            args = ["pi-bolt", "--offline", "--no-mcp", "--no-session", "--no-tools", "--no-skills",
                    "--no-context-files", "--no-prompt-templates", "--mode", "rpc",
                    "--extension", str(ROOT / "tests/copilot-long-context-fixture.ts"),
                    "--model", "github-copilot/fixture-messages"]
            with subprocess.Popen(args, cwd=temp, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
                logs = []
                reader = threading.Thread(target=lambda: logs.extend(line.decode(errors="replace").strip() for line in process.stderr), daemon=True)
                reader.start()
                try:
                    yield Rpc(process), logs
                    self.assertEqual(model_file.read_text(), models_json)
                    self.assertFalse((agent_dir / "settings.json").exists())
                finally:
                    process.terminate()
                    process.wait(timeout=10)
                    reader.join(timeout=10)

    def call(self, rpc, kind, **fields):
        rpc.send({"id": kind, "type": kind, **fields})
        return rpc.response(kind).get("data")

    def command(self, rpc, args=""):
        self.assertEqual(self.call(rpc, "prompt", message=f"/long-context {args}")["disposition"], "handled")

    def test_selected_model_changes_immediately_and_only_for_its_current_selection(self):
        with self.start_pi() as (rpc, logs):
            self.call(rpc, "set_model", provider="outside", modelId="outside")
            self.command(rpc)
            self.assertEqual(self.call(rpc, "get_state")["model"]["provider"], "outside")
            self.call(rpc, "set_model", provider="github-copilot", modelId="fixture-no-tier")
            self.command(rpc)
            self.assertEqual(self.call(rpc, "get_state")["model"]["contextWindow"], 200_000)
            expected = [{"path": "/models", "version": VERSION}]

            for id, (_, path) in MODELS.items():
                if id == "fixture-no-tier":
                    continue
                with self.subTest(model=id):
                    self.call(rpc, "set_model", provider="github-copilot", modelId=id)
                    self.call(rpc, "set_thinking_level", level="off")
                    old = self.call(rpc, "get_state")["model"]
                    self.command(rpc)
                    self.command(rpc, "on")  # Idempotent: no second catalog request.
                    state = self.call(rpc, "get_state")
                    self.assertEqual(state["model"]["id"], id)
                    self.assertEqual(state["model"]["provider"], "github-copilot")
                    self.assertEqual(state["model"]["maxTokens"], 64_000)
                    self.assertEqual(state["thinkingLevel"], "off")
                    self.assertEqual(self.call(rpc, "get_session_stats")["contextUsage"]["contextWindow"], 936_000)
                    self.assertEqual(rpc.prompt("enabled-inference", "wire test", allow_error=True), ["error"])
                    expected.extend([{"path": "/models", "version": VERSION},
                                     {"path": path, "version": VERSION, "model": id, "extra": "kept"}])
                    self.command(rpc, "off")
                    self.assertEqual(self.call(rpc, "get_state")["model"], old)
                    self.assertEqual(rpc.prompt("restored-inference", "wire test", allow_error=True), ["error"])
                    expected.append({"path": path, "version": None, "model": id, "extra": "kept"})

            self.command(rpc)
            expected.append({"path": "/models", "version": VERSION})
            self.call(rpc, "set_model", provider="outside", modelId="outside")
            self.call(rpc, "set_model", provider="github-copilot", modelId="fixture-responses")
            self.assertEqual(self.call(rpc, "get_state")["model"]["contextWindow"], 200_000)
            self.command(rpc)
            expected.append({"path": "/models", "version": VERSION})
            self.assertEqual(self.call(rpc, "get_state")["model"]["contextWindow"], 936_000)
            self.assertEqual(self.call(rpc, "prompt", message="/reload-context-fixture")["disposition"], "handled")
            self.assertEqual(self.call(rpc, "get_state")["model"]["contextWindow"], 200_000)
        captured = [json.loads(line.split(":", 1)[1]) for line in logs if line.startswith("COPILOT_CAPTURE:")]
        self.assertEqual(captured, expected, logs)


if __name__ == "__main__":
    unittest.main()
