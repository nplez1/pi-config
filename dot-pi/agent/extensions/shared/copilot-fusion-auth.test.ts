import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCopilotConfiguration } from "./copilot-fusion-auth";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fusion-auth-test-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const env = (values: Record<string, string> = {}) => async (name: string) => values[name];

test("Fusion is unavailable without Copilot configuration", async () => withDir(async (dir) => {
  expect(await hasCopilotConfiguration(dir, env())).toBe(false);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fake" } }));
  expect(await hasCopilotConfiguration(dir, env())).toBe(false);
}));

test("Copilot OAuth and stored API-key configurations enable Fusion", async () => withDir(async (dir) => {
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", refresh: "fake" } }));
  expect(await hasCopilotConfiguration(dir, env())).toBe(true);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "github-copilot": { type: "api_key", key: "fake" } }));
  expect(await hasCopilotConfiguration(dir, env())).toBe(true);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", refresh: "" } }));
  expect(await hasCopilotConfiguration(dir, env())).toBe(false);
}));

test("Copilot environment token enables Fusion", async () => withDir(async (dir) => {
  expect(await hasCopilotConfiguration(dir, env({ COPILOT_GITHUB_TOKEN: "fake" }))).toBe(true);
}));

test("configured model API keys respect environment references without running commands", async () => withDir(async (dir) => {
  const config = async (apiKey: string) => writeFile(join(dir, "models.json"), JSON.stringify({ providers: { "github-copilot": { apiKey } } }));
  await config("$MY_COPILOT_TOKEN");
  expect(await hasCopilotConfiguration(dir, env())).toBe(false);
  expect(await hasCopilotConfiguration(dir, env({ MY_COPILOT_TOKEN: "fake" }))).toBe(true);
  await config("prefix-${MY_COPILOT_TOKEN}-$SECOND");
  expect(await hasCopilotConfiguration(dir, env({ MY_COPILOT_TOKEN: "fake" }))).toBe(false);
  expect(await hasCopilotConfiguration(dir, env({ MY_COPILOT_TOKEN: "fake", SECOND: "fake" }))).toBe(true);
  await config(`!touch ${join(dir, "must-not-run")}`);
  expect(await hasCopilotConfiguration(dir, env())).toBe(true);
  await expect(access(join(dir, "must-not-run"))).rejects.toBeDefined();
  await config("fake-literal-key");
  expect(await hasCopilotConfiguration(dir, env())).toBe(true);
}));
