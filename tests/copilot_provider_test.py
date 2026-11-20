#!/usr/bin/env python3
"""Exercise pi-config's Copilot provider with an in-process catalog and SSE."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from fusion_compaction_test import Rpc

ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = ROOT / "dot-pi/agent/extensions"
FIXTURE = ROOT / "tests/copilot-provider-fixture.ts"
IDENTITY_FIXTURE = ROOT / "tests/catalog-identity-fixture.ts"
MODEL = "claude-haiku-5.5"
PROVIDER = "github-copilot"


@unittest.skipUnless(shutil.which("pi-bolt"), "pi-bolt is not installed")
class CopilotProviderIntegration(unittest.TestCase):
    @contextmanager
    def start_pi(self, directory, *, offline=False, extensions=(), **variables):
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(directory), COPILOT_GITHUB_TOKEN="billing-fixture", **variables)
        env.pop("PI_OFFLINE", None)
        (directory / "models.json").write_text(json.dumps({"providers": {PROVIDER: {
            "modelOverrides": {MODEL: {"name": "My Haiku", "contextWindow": 1_000_000}},
        }}}))
        args = ["pi-bolt", "--no-extensions", "--no-mcp", "--no-tools", "--no-context-files", "--no-skills",
                "--no-prompt-templates", "--model", f"{PROVIDER}/{MODEL}", "--thinking", "off", "--mode", "rpc",
                "--system-prompt", "Be concise.", "--session-dir", str(directory / "sessions"),
                "--extension", str(FIXTURE), "--extension", str(EXTENSIONS / "copilot.ts"),
                *(argument for extension in extensions for argument in ("--extension", str(extension)))]
        if offline:
            args.append("--offline")
        with subprocess.Popen(args, cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            try:
                yield Rpc(process)
            finally:
                process.terminate()
                process.wait(timeout=10)
                stderr = process.stderr.read().decode(errors="replace")
                self.assertNotIn("Failed to load extension", stderr)

    def call(self, rpc, kind, **fields):
        rpc.send({"id": kind, "type": kind, **fields})
        return rpc.response(kind).get("data")

    def credits(self, row, nano):
        cost = row["usage"]["cost"]
        self.assertEqual(row["usage"]["copilotBilling"], {"totalNanoAiu": nano, "aiCredits": nano / 1e9})
        self.assertTrue(cost["totalFromProvider"])
        self.assertAlmostEqual(cost["total"], nano / 1e11)

    def test_discovers_eligible_models_clamps_selected_model_and_persists_provider_billing(self):
        with tempfile.TemporaryDirectory(prefix="pi-copilot-provider-") as temp:
            directory = Path(temp)
            with self.start_pi(directory) as rpc:
                state = self.call(rpc, "get_state")
                selected = state["model"]
                self.assertEqual((selected["id"], selected["name"]), (MODEL, "My Haiku"))
                self.assertEqual((selected["contextWindow"], selected["maxTokens"]), (100_000, 20_000))
                available = self.call(rpc, "get_available_models")["models"]
                models = {m["id"]: m for m in available if m["provider"] == PROVIDER}
                self.assertEqual(set(models), {MODEL, "discovered-chat", "discovered-responses"})
                self.assertEqual(models["discovered-chat"]["api"], "openai-completions")
                self.assertEqual(models["discovered-chat"]["cost"]["tiers"][0]["input"], 0.5)
                self.assertEqual(models["discovered-responses"]["api"], "openai-responses")
                self.assertEqual(models["discovered-responses"]["contextWindow"], 100_000)
                self.call(rpc, "prompt", message="/long-context")
                self.assertEqual(self.call(rpc, "get_state")["model"]["contextWindow"], 960_000)
                self.call(rpc, "prompt", message="/long-context off")
                self.assertEqual(self.call(rpc, "get_state")["model"]["contextWindow"], 100_000)
                for model in models:
                    self.call(rpc, "set_model", provider=PROVIDER, modelId=model)
                    self.assertEqual(rpc.prompt(f"call-{model}", "OK?"), ["stop"])
                self.call(rpc, "set_model", provider=PROVIDER, modelId=MODEL)
                self.call(rpc, "prompt", message="/billing-concurrency-fixture")
                log = Path(self.call(rpc, "get_state")["sessionFile"])
                rows = [json.loads(line) for line in log.read_text().splitlines()]
                messages = [row.get("message", {}) for row in rows]
                by_model = {row["model"]: row for row in messages if row.get("role") == "assistant"}
                concurrent = next(row["data"] for row in rows if row.get("customType") == "credits-fixture")
                self.assertEqual([u["copilotBilling"]["totalNanoAiu"] for u in concurrent], [111, 222])
                self.credits(by_model[MODEL], 42_500_000)
                self.credits(by_model["discovered-chat"], 0)
                self.credits(by_model["discovered-responses"], 1_230_000_000)

    def test_automatic_long_context_is_still_selected_after_startup(self):
        # A rebuild of Pi's model list re-reads the selected model from the
        # registry, so the catalog's provider registration has to happen before
        # long context picks its clone, not after.
        with tempfile.TemporaryDirectory(prefix="pi-copilot-provider-") as temp:
            with self.start_pi(Path(temp), COPILOT_FIXTURE_NEUTRAL_LONG="1") as rpc:
                selected = self.call(rpc, "get_state")["model"]
                # The clone keeps the registry model's configured output budget; the
                # catalog clamp leaves it alone because its version header is set.
                self.assertEqual((selected["id"], selected["contextWindow"], selected["maxTokens"]),
                                 (MODEL, 960_000, 40_000))
                # Turning it off restores the registry model as this Pi version
                # holds it, including the models.json override, exactly as it did
                # before the three plugins were merged.
                self.call(rpc, "prompt", message="/long-context off")
                self.assertEqual((self.call(rpc, "get_state")["model"]["contextWindow"],
                                  self.call(rpc, "get_state")["model"]["maxTokens"]), (1_000_000, 128_000))

    def test_reload_unwraps_the_catalog_instead_of_stacking_another_layer(self):
        # models.json composes its own provider over the registered one, so the
        # marker has to be read from the registration rather than from what Pi
        # serves, or every /reload nests another layer over the last one.
        with tempfile.TemporaryDirectory(prefix="pi-copilot-provider-") as temp:
            directory = Path(temp)
            report = directory / "identity.jsonl"
            with self.start_pi(directory, offline=True, extensions=[IDENTITY_FIXTURE],
                               COPILOT_IDENTITY_REPORT=str(report)) as rpc:
                self.call(rpc, "prompt", message="/reload-identity-fixture")
                self.assertEqual(self.call(rpc, "get_state")["model"]["id"], MODEL)
            reports = [json.loads(line) for line in report.read_text().splitlines()]
            self.assertEqual(len(reports), 2, reports)
            for entry in reports:
                self.assertTrue(entry["registered"] and entry["marked"], entry)
                self.assertTrue(entry["sameBaseAsFirstStart"], entry)
                self.assertFalse(entry["baseIsTheRegistration"], entry)
            self.assertEqual(reports[0]["models"], reports[1]["models"])

    def test_offline_or_failed_catalog_retains_pi_models(self):
        for offline in (True, False):
            with self.subTest(offline=offline), tempfile.TemporaryDirectory(prefix="pi-copilot-provider-") as temp:
                with self.start_pi(Path(temp), offline=offline, COPILOT_FIXTURE_UNAVAILABLE="1") as rpc:
                    self.assertEqual(self.call(rpc, "get_state")["model"]["id"], MODEL)
                    self.assertEqual(rpc.prompt("still-streams", "OK?"), ["stop"])

    def test_missing_credits_keep_the_estimate(self):
        with tempfile.TemporaryDirectory(prefix="pi-copilot-provider-") as temp:
            with self.start_pi(Path(temp), COPILOT_FIXTURE_CHAT_WITHOUT_AMOUNT="1") as rpc:
                self.assertEqual(rpc.prompt("reports", "OK?"), ["stop"])
                self.call(rpc, "set_model", provider=PROVIDER, modelId="discovered-chat")
                self.assertEqual(rpc.prompt("does-not-report", "OK?"), ["stop"])
                log = Path(self.call(rpc, "get_state")["sessionFile"])
                row = [json.loads(line).get("message", {}) for line in log.read_text().splitlines()][-1]
                self.assertEqual(row["model"], "discovered-chat")
                self.assertNotIn("copilotBilling", row["usage"])
                self.assertFalse(row["usage"]["cost"]["totalFromProvider"])
                self.assertGreater(row["usage"]["cost"]["total"], 0)


if __name__ == "__main__":
    unittest.main()
