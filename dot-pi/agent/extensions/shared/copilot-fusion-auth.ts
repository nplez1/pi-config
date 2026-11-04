import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Side-effect-free startup check; request authentication remains Pi's responsibility. */
export async function hasCopilotConfiguration(
  agentDir: string,
  env: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  const auth = await jsonFile(join(agentDir, "auth.json"));
  const credential = auth?.["github-copilot"];
  if (credential && typeof credential === "object") {
    const entry = credential as Record<string, unknown>;
    if (entry.type === "oauth" && typeof entry.refresh === "string" && entry.refresh.length > 0) return true;
    if (entry.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0) return true;
  }
  if (await env("COPILOT_GITHUB_TOKEN")) return true;

  const models = await jsonFile(join(agentDir, "models.json"));
  const providers = models?.providers;
  const copilot = providers && typeof providers === "object"
    ? (providers as Record<string, unknown>)["github-copilot"] : undefined;
  const apiKey = copilot && typeof copilot === "object" ? (copilot as Record<string, unknown>).apiKey : undefined;
  if (typeof apiKey !== "string" || !apiKey) return false;
  // Pi treats configured commands as present without executing them at startup.
  if (apiKey.startsWith("!")) return true;
  const refs = apiKey.matchAll(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g);
  for (const match of refs) {
    const name = match[1] ?? match[2];
    if (name && !await env(name)) return false;
  }
  return true;
}
