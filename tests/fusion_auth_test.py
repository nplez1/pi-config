#!/usr/bin/env python3
"""Offline Pi-Bolt availability checks for the Fusion model."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "dot-pi/agent/extensions/copilot-fusion.ts"


@unittest.skipUnless(shutil.which("pi-bolt"), "pi-bolt is not installed")
class FusionAuthIntegration(unittest.TestCase):
    def list_models(self, directory, token=None):
        env = os.environ.copy()
        for name in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
            env.pop(name, None)
        env["PI_CODING_AGENT_DIR"] = directory
        if token:
            env["COPILOT_GITHUB_TOKEN"] = token
        result = subprocess.run(["pi-bolt", "--offline", "--no-extensions", "--no-mcp",
                                 "--extension", str(EXTENSION), "--list-models", "copilot-fusion"],
                                env=env, capture_output=True, text=True, timeout=30, check=True)
        return result.stdout

    def test_only_copilot_configuration_enables_fusion(self):
        with tempfile.TemporaryDirectory(prefix="pi-fusion-auth-") as temp:
            path = Path(temp) / "auth.json"
            self.assertNotRegex(self.list_models(temp), r"(?m)^copilot-fusion\s+standard\b")
            path.write_text(json.dumps({"anthropic": {"type": "api_key", "key": "fake"}}))
            self.assertNotRegex(self.list_models(temp), r"(?m)^copilot-fusion\s+standard\b")
            path.write_text(json.dumps({"github-copilot": {"type": "api_key", "key": "fake"}}))
            self.assertRegex(self.list_models(temp), r"(?m)^copilot-fusion\s+standard\b")
            path.unlink()
            self.assertRegex(self.list_models(temp, token="fake"), r"(?m)^copilot-fusion\s+standard\b")
            self.assertNotRegex(self.list_models(temp), r"(?m)^copilot-fusion\s+standard\b")


if __name__ == "__main__":
    unittest.main()
